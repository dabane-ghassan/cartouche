// The few places where GNOME Shell 45 to 51 differ, in one file.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

export const SHELL_MAJOR = Number.parseInt(PACKAGE_VERSION, 10) || 0;

// GNOME 50 dropped input regions (it is Wayland only, and picking decides), and with them the
// affectsInputRegion parameter, which it now rejects. Earlier versions need it.
export const HAS_INPUT_REGIONS = SHELL_MAJOR < 50;

export function chromeParams(params, inputRegion) {
    return HAS_INPUT_REGIONS ? {...params, affectsInputRegion: inputRegion} : {...params};
}

// St.BoxLayout gained `orientation` in 48 and lost `vertical` in 51.
let _hasOrientation = null;
export function vbox(params = {}) {
    if (_hasOrientation === null) {
        try {
            new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL}).destroy();
            _hasOrientation = true;
        } catch (_e) {
            _hasOrientation = false;
        }
    }
    return _hasOrientation
        ? new St.BoxLayout({...params, orientation: Clutter.Orientation.VERTICAL})
        : new St.BoxLayout({...params, vertical: true});
}

// Notifications are plain objects in 45 and GObjects with properties from 46.

export function notificationTitle(n) {
    return oneLine(n?.title ?? '');
}

export function notificationBody(n) {
    const text = n?.body ?? n?.bannerBodyText ?? '';
    const markup = n?.useBodyMarkup ?? n?.bannerBodyMarkup ?? false;
    return oneLine(markup ? stripMarkup(text) : text);
}

export function notificationIcon(n) {
    try {
        return n?.gicon ?? n?.source?.icon ?? n?.source?.getIcon?.() ?? null;
    } catch (_e) {
        return null;
    }
}

export function notificationAppName(n) {
    return n?.source?.title ?? '';
}

/** The notification's buttons, as {label, run}. Running one does what GNOME's banner does. */
export function notificationActions(n) {
    const actions = n?.actions ?? [];
    return actions.map(action => ({
        label: action.label,
        run: () => {
            if (typeof action.activate === 'function') {
                action.activate();      // 46+: the action destroys a non-resident notification
            } else {
                action.callback?.();
                if (!n.resident)
                    n.destroy();
            }
        },
    }));
}

/**
 * Activate a notification as clicking its banner does. GNOME 45 and 46 destroy a non-resident
 * notification twice when its source closes it from the 'activated' handler (which the
 * notification daemon does); later versions guard against that. Holding it resident for the
 * moment and closing it afterwards ends the same way on every version, without the warning.
 */
export function activateNotification(n) {
    const wasResident = !!n.resident;
    let destroyed = false;
    const id = n.connect('destroy', () => {
        destroyed = true;
    });
    n.resident = true;
    try {
        n.activate();
    } finally {
        if (!destroyed) {
            n.disconnect(id);
            n.resident = wasResident;
            if (!wasResident)
                n.destroy();
        }
    }
}

function stripMarkup(text) {
    try {
        const [ok, , plain] = Pango.parse_markup(text, -1, '');
        if (ok)
            return plain;
    } catch (_e) {
        // not valid markup
    }
    return text.replace(/<[^>]*>/g, '');
}

function oneLine(text) {
    return String(text).replace(/\s+/g, ' ').trim();
}
