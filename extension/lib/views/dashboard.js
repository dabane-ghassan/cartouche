// The island opened up: the player, a glance at your day, and a row of quick switches.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {vbox} from '../compat.js';
import {Artwork, Bars, Progress, iconButton} from './widgets.js';

const DAY_MS = 24 * 3600 * 1000;

function label(styleClass, params = {}) {
    const l = new St.Label({style_class: styleClass, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function glibDate(date) {
    return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
}

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

export class MediaPanel {
    constructor() {
        this.actor = vbox({style_class: 'cartouche-media', y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({style_class: 'cartouche-media-top'});
        this._art = new Artwork('cartouche-art-large');
        this._artButton = new St.Button({style_class: 'cartouche-art-button', child: this._art, can_focus: true, accessible_name: 'Show the player'});
        this._artButton.connect('clicked', () => this._raise());
        const info = vbox({style_class: 'cartouche-media-info', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('cartouche-title');
        this._artist = label('cartouche-subtitle');
        this._app = new St.BoxLayout({style_class: 'cartouche-media-app'});
        this._appIcon = new St.Icon({style_class: 'cartouche-media-app-icon', y_align: Clutter.ActorAlign.CENTER});
        this._appName = label('cartouche-caption', {y_align: Clutter.ActorAlign.CENTER});
        this._bars = new Bars('cartouche-bars-media');
        this._app.add_child(this._appIcon);
        this._app.add_child(this._appName);
        this._app.add_child(new St.Widget({x_expand: true}));
        this._app.add_child(this._bars);
        info.add_child(this._title);
        info.add_child(this._artist);
        info.add_child(this._app);
        top.add_child(this._artButton);
        top.add_child(info);

        this._progress = new Progress(fraction => {
            if (this._player)
                this._player.seekTo(fraction * this._player.length);
        });

        const controls = new St.BoxLayout({style_class: 'cartouche-controls', x_align: Clutter.ActorAlign.CENTER});
        this._prev = iconButton('media-skip-backward-symbolic', 'cartouche-control', () => this._player?.previous(), 'Previous');
        this._play = iconButton('media-playback-start-symbolic', 'cartouche-control cartouche-control-main', () => this._player?.playPause(), 'Play or pause');
        this._next = iconButton('media-skip-forward-symbolic', 'cartouche-control', () => this._player?.next(), 'Next');
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);

        this.actor.add_child(top);
        this.actor.add_child(this._progress);
        this.actor.add_child(controls);
        this._player = null;
    }

    _raise() {
        const player = this._player;
        if (!player)
            return;
        const app = this._findApp(player);
        if (player.canRaise)
            player.raise();
        else
            app?.activate();
        this.onRaise?.();
    }

    _findApp(player) {
        const entry = player.desktopEntry;
        if (!entry)
            return null;
        const apps = Shell.AppSystem.get_default();
        return apps.lookup_app(`${entry}.desktop`) ?? apps.lookup_desktop_wmclass?.(entry) ?? null;
    }

    update(player, art) {
        this._player = player;
        if (!player)
            return;
        this._title.text = player.title || 'Unknown title';
        this._artist.text = [player.artist, player.album].filter(Boolean).join(' — ') || player.identity;
        this._artist.visible = !!this._artist.text;
        const app = this._findApp(player);
        this._appIcon.gicon = app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        this._appName.text = app?.get_name() ?? player.identity;
        this._art.setArt(art?.uri ?? null);
        this._bars.setColor(art?.accent ?? null);
        this._bars.setPlaying(player.playing);
        this._play.child.icon_name = player.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = player.canPrevious;
        this._next.reactive = player.canNext;
        this._prev.opacity = player.canPrevious ? 255 : 90;
        this._next.opacity = player.canNext ? 255 : 90;
        this.tick();
    }

    tick() {
        const player = this._player;
        if (player)
            this._progress.update(player.position, player.length, player.canSeek);
    }
}

export class CalendarPanel {
    constructor() {
        this.actor = vbox({style_class: 'cartouche-calendar', y_align: Clutter.ActorAlign.START});
        this._weekday = label('cartouche-caption cartouche-weekday');
        this._date = label('cartouche-title cartouche-date');
        this._week = new St.BoxLayout({style_class: 'cartouche-week'});
        this._events = vbox({style_class: 'cartouche-events'});
        this.actor.add_child(this._weekday);
        this.actor.add_child(this._date);
        this.actor.add_child(this._week);
        this.actor.add_child(this._events);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._source = null;
        this.actor.connect('destroy', () => this._unwatch());
    }

    /** Follow GNOME's own calendar events while the dashboard is open. */
    watch(on) {
        this._unwatch();
        if (!on)
            return;
        const source = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (source && typeof source.getEvents === 'function') {
            this._source = source;
            this._sourceId = source.connect('changed', () => this.refresh());
        }
    }

    _unwatch() {
        if (this._source && this._sourceId)
            this._source.disconnect(this._sourceId);
        this._source = null;
        this._sourceId = 0;
    }

    refresh() {
        const now = new Date();
        const today = startOfDay(now);
        const nowG = glibDate(now);
        this._weekday.text = nowG.format('%A');
        this._date.text = nowG.format('%-d %B');

        this._week.destroy_all_children();
        const weekStart = Shell.util_get_week_start();
        const offset = (today.getDay() - weekStart + 7) % 7;
        for (let i = 0; i < 7; i++) {
            const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset + i);
            const g = glibDate(day);
            const column = vbox({style_class: 'cartouche-day', x_expand: true});
            const letter = new St.Label({style_class: 'cartouche-day-letter', text: g.format('%a').charAt(0).toUpperCase(), x_align: Clutter.ActorAlign.CENTER});
            const number = new St.Label({style_class: 'cartouche-day-number', text: String(day.getDate()), x_align: Clutter.ActorAlign.CENTER});
            column.add_child(letter);
            column.add_child(number);
            if (day.getTime() === today.getTime())
                column.add_style_pseudo_class('today');
            if (this._source?.hasEvents?.(day))
                column.add_style_pseudo_class('busy');
            this._week.add_child(column);
        }

        this._events.destroy_all_children();
        const upcoming = this._upcoming(now, today);
        if (!upcoming.length) {
            this._events.add_child(label('cartouche-caption cartouche-no-events', {
                text: this._source?.hasCalendars ? 'Nothing else today' : 'No events',
            }));
            return;
        }
        for (const event of upcoming.slice(0, 3)) {
            const row = new St.BoxLayout({style_class: 'cartouche-event'});
            row.add_child(new St.Widget({style_class: 'cartouche-event-dot', y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(label('cartouche-event-time', {text: this._when(event, now, today), y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(label('cartouche-event-title', {text: event.summary || 'Untitled', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            this._events.add_child(row);
        }
    }

    _upcoming(now, today) {
        const source = this._source;
        if (!source)
            return [];
        let events = [];
        try {
            events = source.getEvents(today, new Date(today.getTime() + 2 * DAY_MS));
        } catch (_e) {
            return [];
        }
        return events.filter(e => e.end > now).sort((a, b) => a.date - b.date);
    }

    _when(event, now, today) {
        const allDay = event.date.getHours() === 0 && event.date.getMinutes() === 0 &&
            event.end - event.date >= DAY_MS - 3600 * 1000 && (event.end - event.date) % DAY_MS <= 3600 * 1000;
        const tomorrow = event.date >= new Date(today.getTime() + DAY_MS);
        if (allDay)
            return tomorrow ? 'Tomorrow' : 'All day';
        if (event.date <= now)
            return 'Now';
        const format = this._interface.get_string('clock-format') === '12h' ? '%-l:%M %p' : '%H:%M';
        const time = glibDate(event.date).format(format);
        return tomorrow ? `Tmrw ${time}` : time;
    }
}

export class Footer {
    constructor({onFocus, onNotifications, onSettings}) {
        this.actor = new St.BoxLayout({style_class: 'cartouche-footer', x_expand: true});
        this._battery = new St.BoxLayout({style_class: 'cartouche-battery', y_align: Clutter.ActorAlign.CENTER});
        this._batteryIcon = new St.Icon({style_class: 'cartouche-footer-icon', y_align: Clutter.ActorAlign.CENTER});
        this._batteryLabel = new St.Label({style_class: 'cartouche-caption', y_align: Clutter.ActorAlign.CENTER});
        this._battery.add_child(this._batteryIcon);
        this._battery.add_child(this._batteryLabel);
        this._clock = label('cartouche-caption cartouche-footer-clock', {y_align: Clutter.ActorAlign.CENTER});
        this._focus = iconButton('notifications-disabled-symbolic', 'cartouche-chip', onFocus, 'Do Not Disturb');
        this._list = iconButton('preferences-system-notifications-symbolic', 'cartouche-chip', onNotifications, 'Notifications and calendar');
        this._gear = iconButton('emblem-system-symbolic', 'cartouche-chip', onSettings, 'Cartouche settings');
        this.actor.add_child(this._battery);
        this.actor.add_child(this._clock);
        this.actor.add_child(new St.Widget({x_expand: true}));
        this.actor.add_child(this._focus);
        this.actor.add_child(this._list);
        this.actor.add_child(this._gear);
    }

    update({battery, focus, unread, clock}) {
        this._battery.visible = !!battery;
        if (battery) {
            this._batteryIcon.icon_name = battery.icon;
            this._batteryLabel.text = `${battery.percent}%`;
        }
        this._clock.text = clock ?? '';
        this._clock.visible = !battery && !!clock;
        if (focus)
            this._focus.add_style_pseudo_class('checked');
        else
            this._focus.remove_style_pseudo_class('checked');
        this._focus.accessible_name = focus ? 'Turn off Do Not Disturb' : 'Turn on Do Not Disturb';
        if (unread)
            this._list.add_style_pseudo_class('unread');
        else
            this._list.remove_style_pseudo_class('unread');
    }
}

/** The whole opened island: [player | calendar] over the footer. */
export class DashboardView {
    constructor(handlers) {
        this.actor = vbox({style_class: 'cartouche-dashboard'});
        this._row = new St.BoxLayout({style_class: 'cartouche-dashboard-row'});
        this.media = new MediaPanel();
        this.media.onRaise = handlers.onRaise;
        this._divider = new St.Widget({style_class: 'cartouche-divider'});
        this.calendar = new CalendarPanel();
        this._empty = vbox({style_class: 'cartouche-empty', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'cartouche-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(new St.Label({text: 'Nothing playing', style_class: 'cartouche-caption', x_align: Clutter.ActorAlign.CENTER}));
        this.footer = new Footer(handlers);
        this._row.add_child(this.media.actor);
        this._row.add_child(this._empty);
        this._row.add_child(this._divider);
        this._row.add_child(this.calendar.actor);
        this.actor.add_child(this._row);
        this.actor.add_child(this.footer.actor);
    }

    /** Which parts show: the player (or "nothing playing"), the calendar, the footer. */
    layout({player, calendar, footer}) {
        this.media.actor.visible = !!player;
        this._empty.visible = !player && !calendar;
        this.calendar.actor.visible = calendar;
        this._divider.visible = calendar && (!!player || this._empty.visible);
        this.footer.actor.visible = footer;
    }
}
