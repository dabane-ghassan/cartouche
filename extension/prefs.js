// Cartouche settings, in GNOME's Extensions app (or `cartouche settings`).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const REPO = 'https://github.com/dabane-ghassan/cartouche';
const SITE = 'https://dabane-ghassan.github.io/cartouche/';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A drop-down for a string key with fixed choices: [[value, label], ...]. */
function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(c => c[1]))});
    const sync = () => {
        const index = choices.findIndex(c => c[0] === settings.get_string(key));
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    sync();
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice && settings.get_string(key) !== choice[0])
            settings.set_string(key, choice[0]);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function group(title, description, rows) {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    return g;
}

function page(title, icon, groups) {
    const p = new Adw.PreferencesPage({title, icon_name: icon});
    groups.forEach(g => p.add(g));
    return p;
}

function accelLabel(accel) {
    if (!accel)
        return 'Disabled';
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok && key ? Gtk.accelerator_get_label(key, mods) : accel;
}

/** A row showing a shortcut; activating it asks for a new one. */
function shortcutRow(window, settings, key, title) {
    const row = new Adw.ActionRow({title, activatable: true});
    const value = new Gtk.Label({css_classes: ['dim-label'], valign: Gtk.Align.CENTER});
    row.add_suffix(value);
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER}));
    const sync = () => {
        value.label = accelLabel(settings.get_strv(key)[0] ?? '');
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    row.connect('activated', () => {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title,
            default_width: 400,
            default_height: 220,
            resizable: false,
        });
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: 'Press a shortcut',
            description: 'Esc to cancel, Backspace to turn the shortcut off',
        });
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(new Adw.HeaderBar({show_title: false}));
        box.append(status);
        dialog.set_content(box);
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            const lower = Gdk.keyval_to_lower(keyval);
            if (!mods && lower === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && lower === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mods && Gtk.accelerator_valid(lower, mods)) {
                settings.set_strv(key, [Gtk.accelerator_name(lower, mods)]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present();
    });
    return row;
}

function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'web-browser-symbolic', valign: Gtk.Align.CENTER}));
    row.connect('activated', () => {
        if (Gtk.UriLauncher)
            new Gtk.UriLauncher({uri}).launch(row.get_root(), null, (launcher, res) => {
                try {
                    launcher.launch_finish(res);
                } catch (_e) {
                    // no browser
                }
            });
        else
            Gtk.show_uri(row.get_root(), uri, Gdk.CURRENT_TIME);
    });
    return row;
}

function infoRow(title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    row.subtitle_lines = 2;
    return row;
}

/** Ask GNOME for a notification, so it lands in the island. */
function sendTestNotification() {
    Gio.DBus.session.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications', 'Notify',
        new GLib.Variant('(susssasa{sv}i)', [
            'Cartouche', 0, 'preferences-system-notifications-symbolic',
            'Hello from the island',
            'This is how a notification looks in Cartouche. Swipe up to put it away, or click to open.',
            [], {}, -1,
        ]),
        null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                console.warn(`Cartouche: cannot send a test notification: ${e.message}`);
            }
        });
}

export default class CartouchePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.search_enabled = true;

        window.add(page('Island', 'preferences-system-symbolic', [
            group('Opening', 'The island opens into a small dashboard: the player, your week and next events, and a few switches.', [
                switchRow(settings, 'expand-on-hover', 'Open on hover', 'Otherwise, click the island to open it'),
                spinRow(settings, 'hover-delay', 'Hover delay', 'Milliseconds the pointer rests first', 0, 2000, 20),
                shortcutRow(window, settings, 'toggle-shortcut', 'Shortcut to open or close'),
            ]),
            group('Look', null, [
                comboRow(settings, 'appearance', 'Colour', 'Black blends into the top bar like a notch', [
                    ['black', 'Black'],
                    ['graphite', 'Graphite'],
                ]),
            ]),
            group('Lock Screen', null, [
                switchRow(settings, 'lock-screen', 'Show on the lock screen',
                    'What is playing, and volume and brightness. Never notifications or your calendar.'),
            ]),
        ]));

        const testButton = new Gtk.Button({label: 'Try It', valign: Gtk.Align.CENTER});
        testButton.connect('clicked', () => sendTestNotification());
        const notificationsRow = switchRow(settings, 'notifications', 'Notifications in the island', 'Instead of banners. They still go to the list under the clock.');

        window.add(page('Activities', 'media-playback-start-symbolic', [
            group('Now Playing', 'Any player that speaks MPRIS: Spotify, browsers, Rhythmbox, Lollypop, mpv…', [
                switchRow(settings, 'media', 'Show what is playing'),
                comboRow(settings, 'media-compact', 'In the pill', null, [
                    ['artwork', 'Artwork and bars around the clock'],
                    ['title', 'Artwork and the song title'],
                    ['clock', 'Just the clock'],
                ]),
                switchRow(settings, 'track-peek', 'Show each new song for a moment'),
                comboRow(settings, 'visualizer-color', 'Colour of the bars', null, [
                    ['artwork', 'From the album art'],
                    ['white', 'White'],
                ]),
            ]),
            (() => {
                const g = group('Notifications', null, [notificationsRow]);
                g.set_header_suffix(testButton);
                g.add(spinRow(settings, 'notification-time', 'Time on screen', 'Seconds; urgent ones stay until you close them', 2, 30, 1));
                return g;
            })(),
            group('System', null, [
                switchRow(settings, 'battery', 'Charging and battery', 'When you plug in, when it is full, when it runs low'),
                spinRow(settings, 'low-battery', 'Low battery warning', 'Percent; also at 10% and 5%', 5, 50, 1),
                switchRow(settings, 'bluetooth', 'Headphones and Bluetooth devices', 'When they connect, with their battery'),
                switchRow(settings, 'focus', 'Do Not Disturb', 'When it goes on or off'),
            ]),
            group('Glance', null, [
                switchRow(settings, 'calendar', 'Week and next events', 'From GNOME\'s calendar (Evolution, GNOME Online Accounts)'),
            ]),
        ]));

        window.add(page('HUD', 'audio-volume-high-symbolic', [
            group('Show in the Island', 'Instead of GNOME\'s pop-up in the middle of the screen.', [
                switchRow(settings, 'hud-volume', 'Volume'),
                switchRow(settings, 'hud-brightness', 'Screen brightness'),
                switchRow(settings, 'hud-keyboard', 'Keyboard backlight'),
                switchRow(settings, 'hud-microphone', 'Microphone'),
                switchRow(settings, 'hud-other', 'Everything else', 'Airplane mode, touchpad, and the like'),
            ]),
            group('Look', null, [
                comboRow(settings, 'hud-style', 'Level', null, [
                    ['bar', 'Smooth bar'],
                    ['segments', 'Sixteen segments'],
                ]),
                switchRow(settings, 'hud-percent', 'Show the percentage'),
            ]),
        ]));

        window.add(page('About', 'help-about-symbolic', [
            (() => {
                const g = new Adw.PreferencesGroup();
                const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12, margin_bottom: 6});
                const logo = Gtk.Image.new_from_file(GLib.build_filenamev([this.path, 'assets', 'icons', 'cartouche.svg']));
                logo.pixel_size = 96;
                box.append(logo);
                box.append(new Gtk.Label({label: 'Cartouche', css_classes: ['title-1']}));
                box.append(new Gtk.Label({label: `Version ${this.metadata['version-name']}`, css_classes: ['dim-label']}));
                box.append(new Gtk.Label({
                    label: 'A Dynamic Island for GNOME.',
                    css_classes: ['dim-label'],
                    wrap: true,
                    justify: Gtk.Justification.CENTER,
                }));
                g.add(box);
                return g;
            })(),
            group('How to Use It', null, [
                infoRow('Rest the pointer on it', 'It opens: the player, your week, battery and switches'),
                infoRow('Click', 'Opens it; on a notification, opens the app'),
                infoRow('Swipe up, or middle-click', 'Puts away what it shows; middle-click closes a notification'),
                infoRow('Swipe down', 'Opens it'),
                infoRow('Swipe sideways', 'Next or previous song'),
                infoRow('Right-click', 'GNOME\'s notification list and calendar (Super+V works too)'),
            ]),
            group('Links', null, [
                linkRow('Website', SITE, SITE),
                linkRow('Source code and issues', REPO, REPO),
                infoRow('Update', 'Run “cartouche update” in a terminal, then log out and back in.'),
            ]),
        ]));
    }
}
