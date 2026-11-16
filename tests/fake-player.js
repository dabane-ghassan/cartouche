#!/usr/bin/env -S gjs -m
// A pretend music player for the tests: speaks MPRIS on the session bus as
// org.mpris.MediaPlayer2.cartouchetest and logs every call it gets to the file named on the
// command line. Usage: gjs -m fake-player.js <log> <cover1.png> <cover2.png>

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [logPath, cover1, cover2] = ARGV;
const loop = new GLib.MainLoop(null, false);

const PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/><method name="Previous"/><method name="Pause"/><method name="PlayPause"/>
    <method name="Stop"/><method name="Play"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <method name="SetPosition"><arg direction="in" type="o" name="TrackId"/><arg direction="in" type="x" name="Position"/></method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const ROOT_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/><method name="Quit"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const TRACKS = [
    {id: '/test/track/1', title: 'Nile at Night', artist: 'The Scribes', album: 'Papyrus', art: cover1, length: 214e6},
    {id: '/test/track/2', title: 'Valley of the Kings', artist: 'Hatshepsut Quartet', album: 'Obelisk', art: cover2, length: 187e6},
    {id: '/test/track/3', title: 'Rosetta', artist: 'Champollion', album: 'Decoded', art: cover1, length: 241e6},
];

function log(line) {
    const stream = Gio.File.new_for_path(logPath).append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(`${line}\n`), null);
    stream.close(null);
}

let index = 0;
let status = 'Playing';
let position = 0;

class Player {
    get PlaybackStatus() { return status; }
    get Rate() { return 1.0; }
    get Position() { return position; }
    get CanGoNext() { return true; }
    get CanGoPrevious() { return true; }
    get CanPlay() { return true; }
    get CanPause() { return true; }
    get CanSeek() { return true; }
    get CanControl() { return true; }
    get Metadata() {
        const t = TRACKS[index];
        return {
            'mpris:trackid': new GLib.Variant('o', t.id),
            'mpris:length': new GLib.Variant('x', t.length),
            'mpris:artUrl': new GLib.Variant('s', Gio.File.new_for_path(t.art).get_uri()),
            'xesam:title': new GLib.Variant('s', t.title),
            'xesam:artist': new GLib.Variant('as', [t.artist]),
            'xesam:album': new GLib.Variant('s', t.album),
        };
    }

    _changed(...names) {
        for (const name of names) {
            const value = {
                PlaybackStatus: () => new GLib.Variant('s', status),
                Metadata: () => new GLib.Variant('a{sv}', this.Metadata),
            }[name]();
            playerObj.emit_property_changed(name, value);
        }
        playerObj.flush();
    }

    Next() { log('Next'); index = (index + 1) % TRACKS.length; position = 0; this._changed('Metadata'); }
    Previous() { log('Previous'); index = (index + TRACKS.length - 1) % TRACKS.length; position = 0; this._changed('Metadata'); }
    PlayPause() { log('PlayPause'); status = status === 'Playing' ? 'Paused' : 'Playing'; this._changed('PlaybackStatus'); }
    Play() { log('Play'); status = 'Playing'; this._changed('PlaybackStatus'); }
    Pause() { log('Pause'); status = 'Paused'; this._changed('PlaybackStatus'); }
    Stop() { log('Stop'); status = 'Stopped'; this._changed('PlaybackStatus'); }
    Seek(offset) { log(`Seek ${offset}`); position += offset; }
    SetPosition(id, pos) { log(`SetPosition ${id} ${pos}`); position = pos; playerObj.emit_signal('Seeked', new GLib.Variant('(x)', [pos])); }
}

class Root {
    get CanRaise() { return true; }
    get CanQuit() { return true; }
    get Identity() { return 'Test Player'; }
    get DesktopEntry() { return ''; }
    Raise() { log('Raise'); }
    Quit() { log('Quit'); loop.quit(); }
}

const playerObj = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, new Player());
const rootObj = Gio.DBusExportedObject.wrapJSObject(ROOT_XML, new Root());

Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.cartouchetest', Gio.BusNameOwnerFlags.NONE,
    connection => {
        playerObj.export(connection, '/org/mpris/MediaPlayer2');
        rootObj.export(connection, '/org/mpris/MediaPlayer2');
    },
    () => log('ready'),
    () => loop.quit());

loop.run();
System.exit(0);
