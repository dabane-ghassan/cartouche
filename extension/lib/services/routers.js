// Where GNOME's own pop-ups go instead: the volume and brightness OSD, and notification banners.
// Both are taken over by replacing one method on GNOME's object (not its class), and handed back
// on disable. Whatever the island cannot show right now (say, over a fullscreen video) still
// goes to GNOME as usual.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function hudKind(icon) {
    let name = '';
    try {
        name = icon?.to_string?.() ?? '';
    } catch (_e) {
        name = '';
    }
    if (/microphone/.test(name))
        return 'microphone';
    if (/keyboard-brightness/.test(name))
        return 'keyboard';
    if (/display-brightness|brightness/.test(name))
        return 'brightness';
    if (/audio-volume|audio-speakers|audio-headphones|audio-headset/.test(name))
        return 'volume';
    return 'other';
}

/**
 * Takes over OsdWindowManager._showOsdWindow, which every version from 45 to 51 calls once per
 * monitor for every OSD (volume, brightness, keyboard backlight, microphone, and the rest).
 */
export class OsdRouter {
    constructor(wants, show) {
        this._wants = wants;        // (kind) => bool
        this._show = show;          // ({kind, icon, label, level, maxLevel}) => void
        this._pending = new Map();
        this._idle = 0;
        this._manager = Main.osdWindowManager;
        const original = this._manager._showOsdWindow;
        if (typeof original !== 'function')
            return;
        const router = this;
        this._patch = function (monitorIndex, icon, label, level, maxLevel) {
            const kind = hudKind(icon);
            if (!router._wants(kind))
                return original.call(this, monitorIndex, icon, label, level, maxLevel);
            router._collect(monitorIndex, {kind, icon, label, level, maxLevel});
            return undefined;
        };
        this._manager._showOsdWindow = this._patch;
    }

    _collect(monitorIndex, osd) {
        this._pending.set(monitorIndex, osd);
        if (this._idle)
            return;
        // One OSD arrives as one call per monitor in a row: show it once, for the primary monitor.
        this._idle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._idle = 0;
            const pending = this._pending;
            this._pending = new Map();
            const osd = pending.get(Main.layoutManager.primaryIndex) ?? pending.values().next().value;
            if (osd)
                this._show(osd);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        if (this._patch && this._manager._showOsdWindow === this._patch)
            delete this._manager._showOsdWindow;
        this._patch = null;
    }
}

/**
 * Takes over MessageTray._showNotification, the moment GNOME would slide a banner down. The
 * notification still goes to the list under the clock, exactly as when a banner was shown.
 */
export class NotificationRouter {
    constructor(wants, show) {
        this._wants = wants;        // (notification) => bool
        this._show = show;          // (notification) => void
        this._idle = 0;
        this._tray = Main.messageTray;
        const original = this._tray._showNotification;
        if (typeof original !== 'function' || !Array.isArray(this._tray._notificationQueue))
            return;
        const router = this;
        this._patch = function () {
            const next = this._notificationQueue[0];
            if (!next || !router._wants(next))
                return original.call(this);
            this._notificationQueue.shift();
            this.emit('queue-changed');
            next.acknowledged = true;
            try {
                next.playSound();
            } catch (_e) {
                // no sound
            }
            router._show(next);
            if (this._notificationQueue.length)
                router._again();
            return undefined;
        };
        this._tray._showNotification = this._patch;
    }

    /** GNOME takes one banner at a time; ask it to look at the queue again. */
    _again() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idle = 0;
            try {
                this._tray._updateState();
            } catch (e) {
                logError(e, 'Cartouche: message tray');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        if (this._patch && this._tray._showNotification === this._patch)
            delete this._tray._showNotification;
        this._patch = null;
    }
}
