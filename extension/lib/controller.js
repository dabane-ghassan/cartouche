// Decides what the island shows and when: the clock at rest, a moment (a "peek") when something
// happens, the dashboard when you reach for it. Owns the services and the views.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotificationDestroyedReason, Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {activateNotification, chromeParams, notificationActions, notificationAppName, notificationBody, notificationIcon, notificationTitle} from './compat.js';
import {Island} from './island.js';
import {ArtCache} from './services/art.js';
import {Media} from './services/media.js';
import {NotificationRouter, OsdRouter} from './services/routers.js';
import {Bluetooth, Focus, Power} from './services/system.js';
import {CompactView} from './views/compact.js';
import {DashboardView} from './views/dashboard.js';
import {ActivityView, HudView, NotificationView} from './views/peeks.js';

const GREEN = '#30d158';
const RED = '#ff453a';
const BLUE = '#0a84ff';
const PURPLE = '#5e5ce6';
const GREY = '#636366';

const PAUSED_LINGER_US = 120 * 1e6;     // paused music stays in the pill this long
const HUD_MS = 1600;
const ACTIVITY_MS = 3000;
const RESUME_MS = 1800;                 // what is left of a moment after the pointer leaves it
const QUEUE_MAX = 12;

export class Controller {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._mode = 'compact';         // compact | peek | expanded
        this._current = null;           // the peek on screen
        this._queue = [];
        this._timers = new Map();
        this._watched = new Map();      // notification -> handler ids
        this._scroll = [0, 0];
        this._lastGesture = 0;
        this._locked = Main.sessionMode.isLocked;
        this._destroyed = false;

        this.media = new Media();
        this.art = new ArtCache();
        this.power = new Power(this._settings);
        this.bluetooth = new Bluetooth();
        this.focus = new Focus();
        this._clock = new GnomeDesktop.WallClock();

        this.compact = new CompactView();
        this.dashboard = new DashboardView({
            onFocus: () => this.focus.toggle(),
            onNotifications: () => this.openGnomeCalendar(),
            onSettings: () => {
                this.collapse();
                this._ext.openPreferences();
            },
            onRaise: () => this.collapse(),
        });

        this._stage = new St.Widget({name: 'cartoucheStage', reactive: false, layout_manager: new Clutter.BinLayout()});
        this.island = new Island();
        this.island.keep(this.compact.actor);
        this.island.keep(this.dashboard.actor);
        this._stage.add_child(this.island);
        Main.layoutManager.addChrome(this._stage, chromeParams({trackFullscreen: true}, false));
        Main.layoutManager.trackChrome(this.island, chromeParams({trackFullscreen: false}, true));

        this._hideGnomeClock();
        this._place();
        this._applyAppearance();
        this._refreshCompact();
        this.island.setView(this.compact.actor, false);
        this._syncVisibility();

        this._connect();
        this._osd = new OsdRouter(kind => this._wantsHud(kind), osd => this._showHud(osd));
        this._notifications = new NotificationRouter(n => this._wantsNotification(n), n => this._showNotification(n));
        if (!this._locked)
            this._bindKeys(true);
    }

    // ------------------------------------------------------------------ wiring

    _connect() {
        const island = this.island;
        island.connect('notify::hover', () => this._onHover());
        island.connect('button-release-event', (_a, event) => this._onClick(event.get_button()));
        island.connect('touch-event', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_END)
                return this._onClick(Clutter.BUTTON_PRIMARY);
            return Clutter.EVENT_STOP;
        });
        island.connect('scroll-event', (_a, event) => this._onScroll(event));

        this._clock.connectObject('notify::clock', () => this._onClock(), this);
        this.media.connectObject(
            'changed', () => this._onMedia(),
            'position', () => this._mode === 'expanded' && this.dashboard.media.tick(),
            'track-changed', (_m, player) => this._onTrack(player), this);
        this.power.connectObject(
            'changed', () => this._mode === 'expanded' && this._refreshDashboard(),
            'event', (_p, kind) => this._onBattery(kind), this);
        this.bluetooth.connectObject(
            'event', (_b, device) => this._onBluetooth(device),
            'battery', (_b, path, percent) => this._onBluetoothBattery(path, percent), this);
        this.focus.connectObject('changed', (_f, on) => this._onFocus(on), this);

        this._settings.connectObject('changed', (_s, key) => this._onSetting(key), this);
        // Another screen, another scale: place again once the top bar has its new size.
        Main.layoutManager.connectObject('monitors-changed', () => this._queuePlace(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._queuePlace(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._queuePlace(),
            'changed', () => this._queuePlace(), this);
        Main.sessionMode.connectObject('updated', () => this._onSession(), this);
        Main.overview.connectObject('showing', () => this.collapse(), this);
        global.display.connectObject(
            'notify::focus-window', () => {
                if (this._mode === 'expanded' && !this.island.hover)
                    this.collapse();
            },
            'in-fullscreen-changed', () => this._syncVisibility(), this);

        // GNOME's own menus from the top bar: the island makes way for them.
        for (const name of ['dateMenu', 'quickSettings']) {
            const menu = Main.panel.statusArea[name]?.menu;
            menu?.connectObject?.('open-state-changed', (_m, open) => {
                if (open) {
                    this._clearTimer('hover');
                    this.collapse();
                }
            }, this);
        }
        const dot = this._dateMenu?._indicator;
        dot?.connectObject?.('notify::visible', () => this._refreshCompact(), this);

        // Icons coming and going (or changing width) on either side of the top bar.
        for (const box of [Main.panel._leftBox, Main.panel._rightBox])
            box?.connectObject?.('notify::allocation', () => this._queueFit(), this);
        this._dateMenu?.connectObject?.('notify::allocation', () => this._queueFit(), this);
    }

    _bindKeys(on) {
        if (on && !this._keysBound) {
            Main.wm.addKeybinding('toggle-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
            this._keysBound = true;
        } else if (!on && this._keysBound) {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._keysBound = false;
        }
    }

    /**
     * The clock moves into the island. GNOME's clock button stays where it was, invisible, and
     * is sized to the pill: the top bar lays out its icons around it exactly as around the clock,
     * so the island never sits on them. Its menu and Super+V keep working.
     */
    _hideGnomeClock() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;
        this._dateMenu = dateMenu;
        const box = dateMenu._clockDisplay?.get_parent();
        if (box && box !== dateMenu)
            this._clockBox = box;
        dateMenu.opacity = 0;
    }

    _restoreGnomeClock() {
        if (this._clockBox)
            this._clockBox.width = -1;
        this._clockBox = null;
        this._slotWidth = 0;
        if (this._dateMenu)
            this._dateMenu.opacity = 255;
        this._dateMenu = null;
    }

    /** Make the clock's slot in the top bar as wide as the pill. */
    _reserve(width) {
        if (!this._clockBox || width === this._slotWidth)
            return;
        this._slotWidth = width;
        this._clockBox.width = width;
    }

    /**
     * Room for the pill in the middle of the top bar without pushing out an icon: GNOME gives
     * each side the same width, so the fuller side decides.
     */
    _room() {
        const panel = Main.panel;
        const left = panel._leftBox, right = panel._rightBox;
        if (!left || !right || !this._dateMenu || !this._clockBox)
            return Infinity;
        const [, leftWidth] = left.get_preferred_width(-1);
        const [, rightWidth] = right.get_preferred_width(-1);
        const padding = this._dateMenu.get_preferred_width(-1)[1] - this._clockBox.get_preferred_width(-1)[1];
        return panel.width - 2 * Math.max(leftWidth, rightWidth) - Math.max(0, padding);
    }

    /** The island sits over the clock's slot, which GNOME centres on the work area. */
    _placeX() {
        const monitor = Main.layoutManager.primaryMonitor;
        const slot = this._dateMenu;
        let offset = 0;
        if (monitor && slot?.mapped && !this._locked) {
            const [x] = slot.get_transformed_position();
            offset = Math.round(x + slot.width / 2 - (monitor.x + monitor.width / 2));
        }
        this.island.setOffset(offset);
    }

    _queueFit() {
        if (this._fitIdle)
            return;
        this._fitIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._fitIdle = 0;
            this._refreshCompact();
            this._placeX();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Wait for the top bar to settle at its new size (another screen, another scale) first. */
    _queuePlace() {
        if (this._placeIdle)
            return;
        this._placeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeIdle = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place() {
        if (this._destroyed)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this._stage.set_position(monitor.x, monitor.y);
        this._stage.set_size(monitor.width, monitor.height);
        let panelHeight = Main.panel.height;
        const [, panelY] = Main.layoutManager.panelBox.get_transformed_position();
        const panelOnTop = Main.layoutManager.panelBox.visible && panelHeight >= 16 &&
            Math.abs(panelY - monitor.y) < 2;
        if (!panelOnTop)
            panelHeight = 32 * scale;
        // Always inside the bar: a small gap above and below, whatever the bar's height and scale.
        const gap = Math.min(3 * scale, panelHeight * 0.12);
        this._compactHeight = Math.round((panelHeight - 2 * gap) / scale * 100) / 100;
        this.island.setGeometry(scale, gap / scale);
        this.compact.setHeight(this._compactHeight);
        this.island.refit(false);
        this._queueFit();
    }

    _applyAppearance() {
        this.island.setAppearance(this._settings.get_string('appearance'));
    }

    _onSetting(key) {
        if (key === 'appearance')
            this._applyAppearance();
        if (key === 'lock-screen' && this._locked && !this._settings.get_boolean('lock-screen'))
            this._dropAll();
        this._refreshCompact();
        if (this._mode === 'expanded')
            this._refreshDashboard();
        this._syncVisibility();
    }

    _onSession() {
        const locked = Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;
        this._bindKeys(!locked);
        if (locked) {
            this.collapse(false);
            this._dropAll(req => req.kind === 'notification' || !this._settings.get_boolean('lock-screen'));
        }
        this._refreshCompact();
        this._syncVisibility();
        this._queueFit();
    }

    // ------------------------------------------------------------------ what can show

    _lockAllowed() {
        return this._settings.get_boolean('lock-screen');
    }

    _onScreen() {
        return this._stage.visible && !Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    canPeek(kind) {
        if (this._destroyed || !this._onScreen())
            return false;
        if (this._locked)
            return this._lockAllowed() && kind !== 'notification';
        return true;
    }

    _wantsHud(kind) {
        const keys = {volume: 'hud-volume', brightness: 'hud-brightness', keyboard: 'hud-keyboard', microphone: 'hud-microphone', other: 'hud-other'};
        return this._settings.get_boolean(keys[kind] ?? 'hud-other') && this.canPeek('hud');
    }

    _wantsNotification(_n) {
        return this._settings.get_boolean('notifications') && this.canPeek('notification');
    }

    /** The player the pill shows: playing, or paused a short while ago. */
    _compactPlayer() {
        if (!this._settings.get_boolean('media'))
            return null;
        const player = this.media.active;
        if (!player)
            return null;
        if (player.playing)
            return player;
        if (player.status === 'Paused' && GLib.get_monotonic_time() - player.pausedAt < PAUSED_LINGER_US)
            return player;
        return null;
    }

    _syncVisibility() {
        let visible = true;
        if (this._locked) {
            visible = this._lockAllowed() &&
                (this._mode !== 'compact' || !!this._compactPlayer());
        }
        this.island.visible = visible;
    }

    // ------------------------------------------------------------------ the pill

    _onClock() {
        this._refreshCompact();
        if (this._mode === 'expanded')
            this.dashboard.calendar.refresh();
    }

    _artFor(player) {
        const url = player?.artUrl;
        if (!url)
            return null;
        const known = this.art.peek(url);
        if (known)
            return known;
        this.art.fetch(url).then(art => {
            if (art && !this._destroyed)
                this._onArt();
        });
        return null;
    }

    _onArt() {
        this._refreshCompact();
        if (this._mode === 'expanded')
            this._refreshDashboard();
        if (this._current?.kind === 'track')
            this._reapply();
    }

    _refreshCompact() {
        if (this._destroyed)
            return;
        const player = this._compactPlayer();
        const style = this._settings.get_string('media-compact');
        const showMedia = player && (style !== 'clock' || this._locked);
        let text = this._clock.clock;
        let title = false;
        if (showMedia && (style === 'title' || this._locked)) {
            text = player.title || player.identity || text;
            title = true;
        }
        const art = showMedia ? this._artFor(player) : null;
        const dot = !this._locked && !!this._dateMenu?._indicator?.visible;
        const media = showMedia ? {uri: art?.uri ?? null, accent: this._accent(art), playing: player.playing} : null;
        // On a crowded top bar, give up the bars, then the artwork, before covering an icon.
        const room = this._locked ? Infinity : this._room();
        const fits = () => this.compact.actor.get_preferred_width(-1)[1] <= room;
        const clock = this._clock.clock;
        this.compact.update({text, title, dot, media, bars: true});
        if (media && !fits()) {
            this.compact.update({text, title, dot, media, bars: false});
            if (!fits())
                this.compact.update({text: clock, title: false, dot, media: null});
        }
        this._reserve(this._locked ? 0 : this.compact.actor.get_preferred_width(-1)[1]);
        this._clearTimer('linger');
        if (player && !player.playing) {
            const left = PAUSED_LINGER_US - (GLib.get_monotonic_time() - player.pausedAt);
            if (left > 0)
                this._setTimer('linger', Math.ceil(left / 1000) + 50, () => this._refreshCompact());
        }
        if (this._mode === 'compact')
            this.island.refit();
        this._syncVisibility();
    }

    _accent(art) {
        if (this._settings.get_string('visualizer-color') === 'white')
            return null;
        return art?.accent ?? null;
    }

    // ------------------------------------------------------------------ opening up

    get mode() {
        return this._mode;
    }

    toggle() {
        if (this._mode === 'expanded')
            this.collapse();
        else
            this.expand();
    }

    expand() {
        if (this._mode === 'expanded' || this._destroyed)
            return;
        if (!this._onScreen())
            return;
        if (this._locked && !(this._lockAllowed() && this.media.active)) {
            this.island.shake();
            return;
        }
        this._clearTimer('hover');
        this._clearTimer('collapse');
        Main.panel.menuManager.activeMenu?.close();
        if (this._current) {
            const current = this._current;
            if (current.kind !== 'hud' && current.kind !== 'track')
                this._queue.unshift(current);      // first, so it is still known to be waiting
            this._endPeek(false);
        }
        this._mode = 'expanded';
        this.dashboard.calendar.watch(!this._locked && this._settings.get_boolean('calendar'));
        this._refreshDashboard();
        this.island.setView(this.dashboard.actor);
        this._syncVisibility();
        let tick = 0;
        this._setTimer('tick', 1000, () => {
            this.dashboard.media.tick();
            if (++tick % 4 === 0)
                this.media.active?.refreshPosition();
            return GLib.SOURCE_CONTINUE;
        }, true);
        this.media.active?.refreshPosition();
    }

    collapse(animate = true) {
        if (this._mode !== 'expanded')
            return;
        this._clearTimer('tick');
        this._clearTimer('collapse');
        this.dashboard.calendar.watch(false);
        this._mode = 'compact';
        this._refreshCompact();
        this.island.setView(this.compact.actor, animate);
        this._syncVisibility();
        if (this._queue.length)
            this._setTimer('next', 350, () => this._mode === 'compact' && this._next());
    }

    _refreshDashboard() {
        const player = this._settings.get_boolean('media') ? this.media.active : null;
        const calendar = !this._locked && this._settings.get_boolean('calendar');
        this.dashboard.layout({player, calendar, footer: !this._locked});
        if (player)
            this.dashboard.media.update(player, this._artFor(player) ?? {uri: null, accent: null});
        if (calendar)
            this.dashboard.calendar.refresh();
        this.dashboard.footer.update({
            battery: this.power.info,
            focus: this.focus.enabled,
            unread: !!this._dateMenu?._indicator?.visible,
            clock: this._clock.clock,
        });
        if (this._mode === 'expanded')
            this.island.refit();
    }

    openGnomeCalendar() {
        this.collapse();
        if (!this._locked)
            Main.panel.toggleCalendar();
    }

    // ------------------------------------------------------------------ moments

    /**
     * req: {kind, key, make() -> view, apply(view), duration, sticky, valid(), activate(), close()}
     * The same key shows again in place (volume going up and up), with its time restarted.
     */
    _peek(req) {
        if (!this.canPeek(req.kind))
            return false;
        if (this._mode === 'expanded') {
            if (req.kind !== 'hud') {
                this._enqueue(req);
                return true;
            }
            this.collapse();
        }
        const current = this._current;
        if (current) {
            if (current.key === req.key) {
                Object.assign(current, req, {view: current.view});
                current.apply(current.view);
                this.island.refit();
                this._arm();
                return true;
            }
            if (req.kind === 'hud') {
                if (current.kind !== 'hud')
                    this._queue.unshift(current);  // first, so it is still known to be waiting
                this._endPeek(false);
                this._show(req);
                return true;
            }
            this._enqueue(req);
            return true;
        }
        this._show(req);
        return true;
    }

    _enqueue(req) {
        const same = this._queue.findIndex(r => r.key === req.key);
        if (same >= 0)
            this._queue[same] = req;
        else
            this._queue.push(req);
        while (this._queue.length > QUEUE_MAX) {
            const dropped = this._queue.shift();
            dropped.dropped?.();
        }
    }

    _show(req) {
        this._clearTimer('next');
        req.view = req.make();
        req.apply(req.view);
        this._current = req;
        this._mode = 'peek';
        this.island.setView(req.view.actor);
        this._syncVisibility();
        this._arm();
    }

    _arm(ms = null) {
        this._clearTimer('peek');
        const current = this._current;
        if (!current || current.sticky || this.island.hover)
            return;
        this._setTimer('peek', ms ?? current.duration, () => this._endPeek());
    }

    _reapply() {
        if (!this._current)
            return;
        this._current.apply(this._current.view);
        this.island.refit();
    }

    /** End the moment on screen; then the next one, or back to the pill. */
    _endPeek(next = true) {
        this._clearTimer('peek');
        const current = this._current;
        this._current = null;
        if (current)
            current.ended?.();
        if (!next)
            return;
        this._next();
    }

    _next() {
        while (this._queue.length) {
            const req = this._queue.shift();
            if (req.valid && !req.valid()) {
                req.dropped?.();
                continue;
            }
            if (!this.canPeek(req.kind)) {
                req.dropped?.();
                continue;
            }
            this._show(req);
            return;
        }
        this._mode = 'compact';
        this._refreshCompact();
        this.island.setView(this.compact.actor);
        this._syncVisibility();
    }

    _dropAll(which = () => true) {
        const keep = [];
        for (const req of this._queue) {
            if (which(req))
                req.dropped?.();
            else
                keep.push(req);
        }
        this._queue = keep;
        if (this._current && which(this._current)) {
            const current = this._current;
            this._endPeek(false);
            current.dropped?.();
            this._next();
        }
    }

    /** Close the moment on screen (a swipe up); the notification stays in GNOME's list. */
    dismiss() {
        if (this._mode === 'peek')
            this._endPeek();
        else if (this._mode === 'expanded')
            this.collapse();
    }

    // ------------------------------------------------------------------ HUD

    _showHud(osd) {
        const style = this._settings.get_string('hud-style');
        const percent = this._settings.get_boolean('hud-percent');
        const height = this._compactHeight + 8;
        this._peek({
            kind: 'hud',
            key: `hud:${style}:${percent}`,
            make: () => new HudView(style, percent, height),
            apply: view => view.update(osd),
            duration: HUD_MS,
        });
    }

    // ------------------------------------------------------------------ notifications

    _showNotification(notification) {
        const watch = this._watch(notification);
        const time = this._settings.get_int('notification-time') * 1000;
        const info = () => ({
            icon: notificationIcon(notification),
            app: notificationAppName(notification),
            title: notificationTitle(notification),
            body: notificationBody(notification),
            actions: notificationActions(notification),
        });
        const shown = this._peek({
            kind: 'notification',
            key: notification,
            make: () => new NotificationView(notification, {
                ...info(),
                onClose: () => notification.destroy(NotificationDestroyedReason.DISMISSED),
            }),
            apply: view => view.update(info()),
            duration: time,
            sticky: notification.urgency === Urgency.CRITICAL,
            valid: () => !watch.gone,
            activate: () => {
                this._endPeek();
                activateNotification(notification);
            },
            close: () => notification.destroy(NotificationDestroyedReason.DISMISSED),
            ended: () => this._unwatchLater(notification),
            dropped: () => this._unwatch(notification),
        });
        if (!shown)
            this._unwatch(notification);
    }

    _watch(notification) {
        let watch = this._watched.get(notification);
        if (watch)
            return watch;
        watch = {gone: false, ids: []};
        watch.ids.push(notification.connect('destroy', () => {
            watch.gone = true;
            if (this._current?.key === notification)
                this._endPeek();
            this._queue = this._queue.filter(r => r.key !== notification);
            this._unwatch(notification);
        }));
        // Updated in place: properties in 46 and later, an 'updated' signal in 45.
        for (const signal of ['notify::title', 'notify::body', 'updated']) {
            try {
                watch.ids.push(notification.connect(signal, () => {
                    if (this._current?.key === notification)
                        this._reapply();
                }));
            } catch (_e) {
                // this version does not have that signal
            }
        }
        this._watched.set(notification, watch);
        return watch;
    }

    /** Stop listening once the notification is neither on screen nor waiting. */
    _unwatchLater(notification) {
        if (this._current?.key === notification || this._queue.some(r => r.key === notification))
            return;
        this._unwatch(notification);
    }

    _unwatch(notification) {
        const watch = this._watched.get(notification);
        if (!watch)
            return;
        this._watched.delete(notification);
        for (const id of watch.ids) {
            try {
                notification.disconnect(id);
            } catch (_e) {
                // already gone
            }
        }
    }

    // ------------------------------------------------------------------ announcements

    _activity(kind, key, info, duration = ACTIVITY_MS, extra = {}) {
        const height = this._compactHeight + 22;
        return this._peek({
            kind,
            key,
            make: () => new ActivityView(height),
            apply: view => view.update(typeof info === 'function' ? info() : info),
            duration,
            ...extra,
        });
    }

    _onMedia() {
        this._refreshCompact();
        if (this._mode === 'expanded')
            this._refreshDashboard();
        else if (this._current?.kind === 'track')
            this._reapply();
    }

    _trackInfo(player) {
        const art = this._artFor(player);
        return {
            lead: {art: art?.uri ?? null},
            title: player.title || 'Now playing',
            subtitle: player.artist || player.identity,
            trail: {bars: this._accent(art) ?? 'rgba(255, 255, 255, 0.85)'},
        };
    }

    _onTrack(player) {
        if (!this._settings.get_boolean('media') || !this._settings.get_boolean('track-peek'))
            return;
        if (this._mode === 'expanded' || this._current?.kind === 'notification')
            return;
        this._activity('track', 'track', () => this._trackInfo(player), 2800, {
            valid: () => player === this.media.active,
            activate: () => this.expand(),
        });
    }

    _onBattery(kind) {
        if (!this._settings.get_boolean('battery'))
            return;
        const info = this.power.info;
        if (!info)
            return;
        const pct = `${info.percent}%`;
        const shapes = {
            plugged: {lead: {icon: info.icon, tint: GREEN}, title: 'Charging', trail: {text: pct, color: GREEN}},
            full: {lead: {icon: 'battery-level-100-charged-symbolic', tint: GREEN}, title: 'Fully charged', trail: {text: pct, color: GREEN}},
            low: {lead: {icon: info.icon, tint: RED}, title: 'Low battery', subtitle: 'Plug in soon', trail: {text: pct, color: RED}},
            critical: {lead: {icon: 'battery-caution-symbolic', tint: RED}, title: 'Battery almost empty', subtitle: 'Plug in now', trail: {text: pct, color: RED}},
        };
        if (shapes[kind])
            this._activity('battery', 'battery', shapes[kind], kind === 'critical' ? 6000 : ACTIVITY_MS);
    }

    _onBluetooth(device) {
        if (!this._settings.get_boolean('bluetooth'))
            return;
        this._btDevice = device;
        this._activity('bluetooth', `bt:${device.path}`, () => this._btInfo(device));
    }

    _btInfo(device) {
        return {
            lead: {icon: device.icon, tint: device.connected ? BLUE : GREY},
            title: device.name,
            subtitle: device.connected ? 'Connected' : 'Disconnected',
            trail: device.connected && device.battery !== null ? {text: `${device.battery}%`} : null,
        };
    }

    _onBluetoothBattery(path, percent) {
        const device = this._btDevice;
        if (!device || device.path !== path)
            return;
        device.battery = percent;
        if (this._current?.key === `bt:${path}`)
            this._reapply();
    }

    _onFocus(on) {
        if (this._mode === 'expanded')
            this._refreshDashboard();
        if (!this._settings.get_boolean('focus'))
            return;
        this._activity('focus', 'focus', {
            lead: {icon: on ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic', tint: on ? PURPLE : GREY},
            title: 'Do Not Disturb',
            trail: {text: on ? 'On' : 'Off', color: on ? '#a5a4ff' : null},
        }, 2200);
    }

    // ------------------------------------------------------------------ pointer

    _onHover() {
        const hover = this.island.hover;
        if (hover) {
            this._clearTimer('collapse');
            if (this._mode === 'peek') {
                this._clearTimer('peek');
            } else if (this._mode === 'compact' && this._settings.get_boolean('expand-on-hover') &&
                       !Main.panel.menuManager.activeMenu && (!this._locked || this.media.active)) {
                this._setTimer('hover', Math.max(0, this._settings.get_int('hover-delay')), () => {
                    if (this.island.hover && this._mode === 'compact' && !Main.panel.menuManager.activeMenu)
                        this.expand();
                });
            }
        } else {
            this._clearTimer('hover');
            if (this._mode === 'peek' && this._current)
                this._arm(Math.min(this._current.duration, RESUME_MS));
            else if (this._mode === 'expanded')
                this._setTimer('collapse', this._settings.get_boolean('expand-on-hover') ? 280 : 650, () => this.collapse());
        }
    }

    _onClick(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this.openGnomeCalendar();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            if (this._mode === 'peek' && this._current?.close)
                this._current.close();
            else
                this.dismiss();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._mode === 'compact')
            this.expand();
        else if (this._mode === 'peek')
            (this._current?.activate ?? (() => this.expand()))();
        return Clutter.EVENT_STOP;
    }

    /** Swipe up to put away, down to open; sideways to change the song. */
    _onScroll(event) {
        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            this._scroll[0] += dx;
            this._scroll[1] += dy;
            this._setTimer('scroll', 260, () => {
                this._scroll = [0, 0];
            });
            const [ax, ay] = this._scroll;
            if (Math.abs(ay) >= 1.5 && Math.abs(ay) > Math.abs(ax))
                direction = ay > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
            else if (Math.abs(ax) >= 1.5)
                direction = ax > 0 ? Clutter.ScrollDirection.RIGHT : Clutter.ScrollDirection.LEFT;
            else
                return Clutter.EVENT_STOP;
            this._scroll = [0, 0];
        }
        const now = GLib.get_monotonic_time();
        if (now - this._lastGesture < 400 * 1000)
            return Clutter.EVENT_STOP;
        this._lastGesture = now;
        switch (direction) {
        case Clutter.ScrollDirection.UP:
            this.dismiss();
            break;
        case Clutter.ScrollDirection.DOWN:
            if (this._mode !== 'expanded')
                this.expand();
            break;
        case Clutter.ScrollDirection.RIGHT:
            this.media.active?.next();
            break;
        case Clutter.ScrollDirection.LEFT:
            this.media.active?.previous();
            break;
        }
        return Clutter.EVENT_STOP;
    }

    // ------------------------------------------------------------------ timers

    _setTimer(name, ms, callback, repeat = false) {
        this._clearTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            // The callback may set a timer of the same name: only forget this one.
            const forget = () => {
                if (this._timers.get(name) === id)
                    this._timers.delete(name);
            };
            if (!repeat) {
                forget();
                callback();
                return GLib.SOURCE_REMOVE;
            }
            if (callback() === GLib.SOURCE_CONTINUE)
                return GLib.SOURCE_CONTINUE;
            forget();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(name, id);
    }

    _clearTimer(name) {
        const id = this._timers.get(name);
        if (id)
            GLib.source_remove(id);
        this._timers.delete(name);
    }

    // ------------------------------------------------------------------ for D-Bus and the tests

    state() {
        const player = this.media.active;
        const [w, h] = this.island.target;
        return {
            mode: this._mode,
            peek: this._current ? {kind: this._current.kind, key: typeof this._current.key === 'string' ? this._current.key : 'notification'} : null,
            queue: this._queue.map(r => r.kind),
            locked: this._locked,
            visible: this.island.visible && this._stage.visible,
            size: [w, h],
            compact: this.compact._label.text,
            player: player ? {title: player.title, artist: player.artist, status: player.status, name: player.busName} : null,
            battery: this.power.info,
            focus: this.focus.enabled,
        };
    }

    destroy() {
        this._destroyed = true;
        this._bindKeys(false);
        this._osd?.destroy();
        this._notifications?.destroy();
        for (const name of [...this._timers.keys()])
            this._clearTimer(name);
        for (const notification of [...this._watched.keys()])
            this._unwatch(notification);
        this._queue = [];
        this._current = null;

        this._clock.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        if (this._placeIdle)
            GLib.source_remove(this._placeIdle);
        this._placeIdle = 0;
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        for (const name of ['dateMenu', 'quickSettings'])
            Main.panel.statusArea[name]?.menu?.disconnectObject?.(this);
        this._dateMenu?._indicator?.disconnectObject?.(this);
        for (const box of [Main.panel._leftBox, Main.panel._rightBox])
            box?.disconnectObject?.(this);
        this._dateMenu?.disconnectObject?.(this);
        if (this._fitIdle)
            GLib.source_remove(this._fitIdle);
        this._fitIdle = 0;

        this.dashboard.calendar.watch(false);
        // The views first: the dashboard may never have been shown, so be in no parent yet.
        this.dashboard.actor.destroy();
        this.compact.actor.destroy();
        for (const service of [this.media, this.power, this.bluetooth, this.focus]) {
            service.disconnectObject(this);
            service.destroy();
        }
        this.art.destroy();

        Main.layoutManager.untrackChrome(this.island);
        Main.layoutManager.removeChrome(this._stage);
        this._stage.destroy();
        this._stage = null;
        this.island = null;
        this._restoreGnomeClock();
        this._clock = null;
        this._settings = null;
    }
}
