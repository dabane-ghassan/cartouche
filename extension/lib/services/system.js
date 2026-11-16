// The system moments the island announces: charging and low battery (UPower), headphones and
// other Bluetooth devices connecting (BlueZ), and Do Not Disturb.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const UP_CHARGING = 1;
const UP_DISCHARGING = 2;
const UP_FULL = 4;
const UP_PENDING_CHARGE = 5;
const UP_BATTERY = 2;

function systemBus() {
    try {
        return Gio.DBus.system;
    } catch (_e) {
        return null;    // no system bus (a container, say)
    }
}

function pluggedIn(state) {
    return state === UP_CHARGING || state === UP_FULL || state === UP_PENDING_CHARGE;
}

export function batteryIcon(percent, state) {
    if (state === UP_FULL)
        return 'battery-level-100-charged-symbolic';
    const level = Math.min(100, Math.max(0, Math.round(percent / 10) * 10));
    return `battery-level-${level}${pluggedIn(state) ? '-charging' : ''}-symbolic`;
}

/**
 * The laptop battery. `info` is {percent, state, icon, charging} or null without a battery.
 * Emits 'changed', and 'event' with 'plugged', 'full', 'low' or 'critical'.
 */
export class Power extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.info = null;
        this._warned = new Set();
        this._cancellable = new Gio.Cancellable();
        if (!systemBus())
            return;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device', this._cancellable,
            (_o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (_e) {
                    return;
                }
                this._proxy.connectObject('g-properties-changed', () => this._read(true), this);
                this._read(false);
            });
    }

    _get(name) {
        return this._proxy?.get_cached_property(name)?.unpack();
    }

    _read(announce) {
        if (!this._get('IsPresent') || this._get('Type') !== UP_BATTERY) {
            this.info = null;
            this.emit('changed');
            return;
        }
        const percent = Math.round(this._get('Percentage') ?? 0);
        const state = this._get('State') ?? 0;
        this._apply(percent, state, this._get('IconName') || batteryIcon(percent, state), announce);
    }

    _apply(percent, state, icon, announce) {
        const before = this.info;
        this.info = {percent, state, icon, charging: pluggedIn(state), full: state === UP_FULL};
        this.emit('changed');
        if (pluggedIn(state))
            this._warned.clear();
        if (!announce || !before)
            return;
        if (!pluggedIn(before.state) && pluggedIn(state))
            this.emit('event', state === UP_FULL ? 'full' : 'plugged');
        else if (before.state !== UP_FULL && state === UP_FULL)
            this.emit('event', 'full');
        if (state === UP_DISCHARGING) {
            const low = this._settings.get_int('low-battery');
            for (const [level, kind] of [[5, 'critical'], [10, 'low'], [low, 'low']]) {
                if (before.percent > level && percent <= level && !this._warned.has(level)) {
                    this._warned.add(level);
                    this.emit('event', kind);
                    break;
                }
            }
        }
    }

    /** For the tests, and for trying the alerts out from the preferences. */
    simulate(percent, state) {
        this._apply(percent, state, batteryIcon(percent, state), true);
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
    }
}

const DEVICE_ICONS = {
    'audio-headphones': 'audio-headphones-symbolic',
    'audio-headset': 'audio-headset-symbolic',
    'audio-card': 'audio-speakers-symbolic',
    'audio-speakers': 'audio-speakers-symbolic',
    'input-mouse': 'input-mouse-symbolic',
    'input-keyboard': 'input-keyboard-symbolic',
    'input-gaming': 'input-gaming-symbolic',
    'input-tablet': 'input-tablet-symbolic',
    'phone': 'phone-symbolic',
    'computer': 'computer-symbolic',
    'video-display': 'video-display-symbolic',
    'camera-video': 'camera-video-symbolic',
    'printer': 'printer-symbolic',
};

/**
 * Bluetooth devices connecting and disconnecting.
 * Emits 'event' with {path, name, icon, connected, battery} and 'battery' with (path, percent).
 */
export class Bluetooth extends EventEmitter {
    constructor() {
        super();
        this._bus = systemBus();
        this._cancellable = new Gio.Cancellable();
        if (!this._bus)
            return;
        this._sub = this._bus.signal_subscribe('org.bluez', 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', null, null, Gio.DBusSignalFlags.NONE,
            (_c, _sender, path, _iface, _signal, params) => {
                const [iface, changed] = params.deepUnpack();
                if (iface === 'org.bluez.Device1' && 'Connected' in changed)
                    this._announce(path, changed.Connected.unpack());
                else if (iface === 'org.bluez.Battery1' && 'Percentage' in changed)
                    this.emit('battery', path, changed.Percentage.unpack());
            });
    }

    _getAll(path, iface) {
        return new Promise(resolve => {
            this._bus.call('org.bluez', path, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', [iface]), new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE,
                2000, this._cancellable, (c, res) => {
                    try {
                        resolve(c.call_finish(res).recursiveUnpack()[0]);
                    } catch (_e) {
                        resolve(null);
                    }
                });
        });
    }

    async _announce(path, connected) {
        const device = await this._getAll(path, 'org.bluez.Device1');
        if (this._cancellable.is_cancelled())
            return;
        const battery = connected ? await this._getAll(path, 'org.bluez.Battery1') : null;
        if (this._cancellable.is_cancelled())
            return;
        this.emit('event', {
            path,
            name: device?.Alias || device?.Name || 'Bluetooth device',
            icon: DEVICE_ICONS[device?.Icon] ?? 'bluetooth-active-symbolic',
            connected,
            battery: battery?.Percentage ?? null,
        });
    }

    /** For the tests. */
    simulate(name, icon, connected, battery = null) {
        this.emit('event', {path: `/test/${name}`, name, icon: DEVICE_ICONS[icon] ?? 'bluetooth-active-symbolic', connected, battery});
    }

    destroy() {
        this._cancellable.cancel();
        if (this._sub)
            this._bus.signal_unsubscribe(this._sub);
        this._sub = 0;
    }
}

/** Do Not Disturb, which GNOME keeps as "show banners". Emits 'changed' with the new state. */
export class Focus extends EventEmitter {
    constructor() {
        super();
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settings.connectObject('changed::show-banners', () => this.emit('changed', this.enabled), this);
    }

    get enabled() {
        return !this._settings.get_boolean('show-banners');
    }

    toggle() {
        this._settings.set_boolean('show-banners', this.enabled);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
    }
}
