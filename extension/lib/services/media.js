// What is playing: every MPRIS player on the session bus, and which one the island follows.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const ROOT = 'org.mpris.MediaPlayer2';
const OBJECT_PATH = /^\/([A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*)?$/;
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

function cancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function newProxy(name, iface, flags, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, flags, null, name, OBJECT, iface, cancellable,
            (_o, res) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function now() {
    return GLib.get_monotonic_time();
}

export class Player extends EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.ready = false;
        this.lastPlayed = 0;
        this.pausedAt = 0;
        this._meta = {};
        this._status = 'Stopped';
        this._pos = 0;
        this._posAt = now();
        this._cancellable = new Gio.Cancellable();
        this._init().catch(e => {
            if (!cancelled(e))
                console.debug(`Cartouche: cannot follow ${busName}: ${e.message}`);
        });
    }

    async _init() {
        this._proxy = await newProxy(this.busName, PLAYER,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, this._cancellable);
        this._root = await newProxy(this.busName, ROOT, Gio.DBusProxyFlags.NONE, this._cancellable);
        this._proxy.connectObject(
            'g-properties-changed', (_p, changed) => this._changed(changed.deepUnpack()),
            'g-signal', (_p, _sender, signal, params) => {
                if (signal === 'Seeked') {
                    this._setPos(Number(params.deepUnpack()[0]));
                    this.emit('changed');
                }
            }, this);
        this._meta = this._get('Metadata') ?? {};
        this._status = this._get('PlaybackStatus') ?? 'Stopped';
        if (this._status === 'Playing')
            this.lastPlayed = now();
        else if (this._status === 'Paused')
            this.pausedAt = now();
        this.ready = true;
        this.refreshPosition();
        this.emit('changed');
    }

    _get(name, proxy = this._proxy) {
        const value = proxy?.get_cached_property(name);
        if (!value)
            return undefined;
        try {
            return value.recursiveUnpack();
        } catch (_e) {
            return undefined;
        }
    }

    _key() {
        return `${this.trackId}\n${this.title}\n${this.artist}\n${this.artUrl}`;
    }

    _changed(changed) {
        let trackChanged = false;
        if ('Metadata' in changed) {
            const before = this._key();
            this._meta = this._get('Metadata') ?? {};
            if (this._key() !== before) {
                trackChanged = true;
                this._setPos(0);
            }
        }
        if ('PlaybackStatus' in changed) {
            const pos = this.position;        // where it was, at the old speed
            this._status = this._get('PlaybackStatus') ?? 'Stopped';
            this._setPos(pos);
            if (this._status === 'Playing')
                this.lastPlayed = now();
            else if (this._status === 'Paused')
                this.pausedAt = now();
        }
        if ('Rate' in changed)
            this._setPos(this.position);
        if (trackChanged || 'PlaybackStatus' in changed)
            this.refreshPosition();
        this.emit('changed');
        if (trackChanged)
            this.emit('track-changed');
    }

    _setPos(us) {
        this._pos = Number.isFinite(us) ? Math.max(0, us) : 0;
        this._posAt = now();
    }

    get status() {
        return this._status;
    }

    get playing() {
        return this._status === 'Playing';
    }

    get title() {
        return String(this._meta['xesam:title'] ?? '').trim();
    }

    get artist() {
        const a = this._meta['xesam:artist'] ?? this._meta['xesam:albumArtist'] ?? [];
        return (Array.isArray(a) ? a : [a]).filter(Boolean).join(', ').trim();
    }

    get album() {
        return String(this._meta['xesam:album'] ?? '').trim();
    }

    get artUrl() {
        return String(this._meta['mpris:artUrl'] ?? '').trim();
    }

    get trackId() {
        return String(this._meta['mpris:trackid'] ?? '');
    }

    /** Length of the track in microseconds, 0 when unknown (a stream). */
    get length() {
        const len = Number(this._meta['mpris:length'] ?? 0);
        return Number.isFinite(len) && len > 0 ? len : 0;
    }

    get rate() {
        const rate = Number(this._get('Rate') ?? 1);
        return Number.isFinite(rate) && rate > 0 ? rate : 1;
    }

    /** Where the track is now, in microseconds, counting on from the last report. */
    get position() {
        let pos = this._pos;
        if (this._status === 'Playing')
            pos += (now() - this._posAt) * this.rate;
        if (this.length)
            pos = Math.min(pos, this.length);
        return Math.max(0, pos);
    }

    get hasTrack() {
        return !!(this.title || this.artUrl);
    }

    get canNext() {
        return this._get('CanGoNext') ?? false;
    }

    get canPrevious() {
        return this._get('CanGoPrevious') ?? false;
    }

    get canPlayPause() {
        return (this._get('CanPause') ?? true) || (this._get('CanPlay') ?? true);
    }

    get canSeek() {
        return (this._get('CanSeek') ?? false) && this.length > 0;
    }

    get identity() {
        return String(this._get('Identity', this._root) ?? '');
    }

    get desktopEntry() {
        return String(this._get('DesktopEntry', this._root) ?? '');
    }

    get canRaise() {
        return this._get('CanRaise', this._root) ?? false;
    }

    _call(method, params = null) {
        this._proxy?.call(method, params, Gio.DBusCallFlags.NONE, 3000, this._cancellable, (p, res) => {
            try {
                p.call_finish(res);
            } catch (e) {
                if (!cancelled(e))
                    console.debug(`Cartouche: ${this.busName}.${method}: ${e.message}`);
            }
        });
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    /** Jump to a point in the track, in microseconds. */
    seekTo(us) {
        if (!this.canSeek)
            return;
        const target = Math.round(Math.min(Math.max(0, us), this.length));
        const id = this.trackId;
        if (id && id !== NO_TRACK && OBJECT_PATH.test(id))
            this._call('SetPosition', new GLib.Variant('(ox)', [id, target]));
        else
            this._call('Seek', new GLib.Variant('(x)', [Math.round(target - this.position)]));
        this._setPos(target);
        this.emit('changed');
    }

    raise() {
        if (this.canRaise) {
            this._root.call('Raise', null, Gio.DBusCallFlags.NONE, 3000, this._cancellable, (p, res) => {
                try {
                    p.call_finish(res);
                } catch (_e) {
                    // the player went away
                }
            });
        }
    }

    /** Ask the player where it is: not every player reports seeking. */
    refreshPosition() {
        this._proxy?.call('org.freedesktop.DBus.Properties.Get', new GLib.Variant('(ss)', [PLAYER, 'Position']),
            Gio.DBusCallFlags.NONE, 2000, this._cancellable, (p, res) => {
                try {
                    const [value] = p.call_finish(res).deepUnpack();
                    const us = Number(value.unpack());
                    // Some players answer 0 for a stream, or while they load: keep counting then.
                    if (Number.isFinite(us) && (us > 0 || !this.playing)) {
                        this._setPos(us);
                        this.emit('position');
                    }
                } catch (_e) {
                    // Position is optional
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this._root = null;
        this.ready = false;
    }
}

/** Every player, and the one worth showing (`active`). Emits 'changed' and 'track-changed'. */
export class Media extends EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this.active = null;
        this._cancellable = new Gio.Cancellable();
        this._bus = Gio.DBus.session;
        this._sub = this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable, (c, res) => {
                try {
                    const [names] = c.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    if (!cancelled(e))
                        logError(e, 'Cartouche: cannot list media players');
                }
            });
    }

    get players() {
        return [...this._players.values()].filter(p => p.ready && p.hasTrack);
    }

    _add(name) {
        if (this._players.has(name))
            return;
        const player = new Player(name);
        player.connect('changed', () => this._sync());
        player.connect('position', () => this.emit('position', player));
        player.connect('track-changed', () => {
            this._sync();
            if (player === this.active && player.playing)
                this.emit('track-changed', player);
        });
        this._players.set(name, player);
    }

    _remove(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        player.destroy();
        this._sync();
    }

    _pick() {
        const ready = this.players;
        const byRecent = (a, b) => Math.max(b.lastPlayed, b.pausedAt) - Math.max(a.lastPlayed, a.pausedAt);
        const playing = ready.filter(p => p.playing).sort((a, b) => b.lastPlayed - a.lastPlayed);
        if (playing.length)
            return playing[0];
        if (this.active && ready.includes(this.active) && this.active.status === 'Paused')
            return this.active;
        return ready.filter(p => p.status === 'Paused').sort(byRecent)[0] ?? null;
    }

    _sync() {
        this.active = this._pick();
        this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();
        if (this._sub)
            this._bus.signal_unsubscribe(this._sub);
        this._sub = 0;
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
        this.active = null;
    }
}
