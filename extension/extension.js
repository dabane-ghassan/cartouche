// Cartouche: a Dynamic Island for GNOME.
// https://github.com/dabane-ghassan/cartouche
//
// The clock in the middle of the top bar becomes a black pill that comes alive: what is playing,
// volume and brightness, notifications, charging, headphones, Do Not Disturb, and a glance at
// your day. Rest the pointer on it to open it up.
//
// It also runs on the lock screen (session mode "unlock-dialog"), where it only shows what is
// playing and the volume and brightness levels: no notifications, no calendar, no shortcut.

import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SHELL_PATH, SHELL_XML} from './lib/common.js';
import {Controller} from './lib/controller.js';

export default class CartoucheExtension extends Extension {
    enable() {
        this.controller = new Controller(this);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(SHELL_XML, this);
        this._dbus.export(Gio.DBus.session, SHELL_PATH);
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this.controller?.destroy();
        this.controller = null;
    }

    // ------------------------------------------------------------- D-Bus, for the command and the tests

    Expand() {
        this.controller?.expand();
    }

    Collapse() {
        this.controller?.collapse();
    }

    Toggle() {
        this.controller?.toggle();
    }

    Dismiss() {
        this.controller?.dismiss();
    }

    PlayPause() {
        this.controller?.media.active?.playPause();
    }

    Next() {
        this.controller?.media.active?.next();
    }

    Previous() {
        this.controller?.media.active?.previous();
    }

    GetState() {
        return JSON.stringify({
            version: this.metadata['version-name'],
            ...this.controller?.state() ?? {},
        });
    }
}
