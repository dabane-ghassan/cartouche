#!/usr/bin/env python3
"""End-to-end tests for Cartouche, in a real (headless) GNOME Shell.

Starts a private session bus and `gnome-shell --headless`, loads the extension from this
checkout, and drives it with a virtual mouse, GNOME's own OSD and notification paths, and a
pretend music player (fake-player.js) on the session bus. Screenshots land in tests/out/.

    python3 tests/run.py            # or: make test
    python3 tests/run.py --keep     # keep the temporary home folder, for poking around

Needs gnome-shell, gjs, libadwaita and rsvg-convert. In a container you also need a system
D-Bus (`dbus-daemon --system --fork`) and no stale /run/systemd/seats directory.
"""
import ast
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from rig import Rig  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
UUID = "cartouche@dabane-ghassan.github.io"
OUT = TESTS / "out"
SHELL = ("org.gnome.Shell", "/io/github/dabane_ghassan/Cartouche")
IFACE = "io.github.dabane_ghassan.Cartouche"
EXT = f"Main.extensionManager.lookup('{UUID}')"
C = f"{EXT}.stateObj.controller"


class Results:
    def __init__(self):
        self.failed = []
        self.count = 0

    def check(self, name, ok, detail=""):
        self.count += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if detail and not ok else ""))
        if not ok:
            self.failed.append(name)


class Cartouche:
    def __init__(self, rig):
        self.rig = rig
        self.player_log = rig.tmp / "player.log"

    def call(self, method):
        return self.rig.gdbus(*SHELL, f"{IFACE}.{method}")

    def state(self):
        out = self.call("GetState")
        return json.loads(ast.literal_eval(out)[0])

    def wait(self, predicate, timeout=5.0, step=0.1):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if predicate():
                    return True
            except Exception:  # noqa: BLE001 - the shell may be busy
                pass
            time.sleep(step)
        return False

    def mode(self):
        return self.state()["mode"]

    def peek(self):
        p = self.state()["peek"]
        return p["kind"] if p else None

    def geometry(self):
        return self.rig.js(f"""(() => {{ const i = {C}.island; const [x, y] = i.get_transformed_position();
            return {{x, y, w: i.width, h: i.height, panel: Main.panel.height, visible: i.visible && i.get_parent().visible}}; }})()""")

    def shot(self, name):
        time.sleep(0.45)        # let the morph and the fades finish
        return self.rig.shot(OUT / f"{name}.png")

    def rest(self, wait=1.0):
        self.rig.t("move(640, 14)", 0.05)
        self.rig.t("move(641, 14)", wait)

    def leave(self, wait=0.9):
        self.rig.t("move(640, 600)", wait)

    def settle(self):
        """Back to the pill, with nothing waiting."""
        self.leave(0.2)
        self.rig.js(f"{C}._queue = []; {C}.collapse(false); if ({C}._current) {C}._endPeek(); 1")
        self.wait(lambda: self.mode() == "compact", 3)

    def osd(self, icon, level, max_level=1, label="null"):
        # 45 to 48 take the monitor first; 49 and later have showAll()
        lvl = "null" if level is None else level
        self.rig.js(f"""(() => {{ const icon = new imports.gi.Gio.ThemedIcon({{name: '{icon}'}});
            const m = Main.osdWindowManager;
            if (m.showAll) m.showAll(icon, {label}, {lvl}, {max_level}); else m.show(-1, icon, {label}, {lvl}, {max_level}); return 1; }})()""")

    def notify(self, app, summary, body, icon="mail-unread-symbolic", urgency=1, actions=None):
        actions = actions or []
        acts = "[" + ", ".join(f"'{a}'" for a in actions) + "]"
        hints = "{'urgency': <byte %d>}" % urgency
        out = subprocess.run(["gdbus", "call", "--session", "-d", "org.freedesktop.Notifications",
                              "-o", "/org/freedesktop/Notifications", "-m", "org.freedesktop.Notifications.Notify",
                              "--", app, "0", icon, summary, body, acts, hints, "-1"],
                             env=self.rig.env, capture_output=True, text=True).stdout
        return int(out.strip().strip("(),").split()[-1])

    def gnome_banner(self):
        return self.rig.js("!!Main.messageTray._banner")

    def gnome_osd_visible(self):
        return self.rig.js("Main.osdWindowManager._osdWindows.some(w => w && w.visible && w.opacity > 0)")

    def tray_count(self):
        return self.rig.js("Main.messageTray.getSources().reduce((n, s) => n + s.notifications.length, 0)")

    def start_player(self):
        self.player_log.write_text("")
        self.rig.spawn(["gjs", "-m", str(TESTS / "fake-player.js"), str(self.player_log),
                        str(TESTS / "cover1.png"), str(TESTS / "cover2.png")])
        self.wait(lambda: "ready" in self.player_log.read_text(), 10)

    def player_calls(self):
        return [line for line in self.player_log.read_text().split("\n") if line and line != "ready"]


def covers():
    for name in ("cover1", "cover2"):
        subprocess.run(["rsvg-convert", "-w", "300", "-h", "300", str(TESTS / f"{name}.svg"),
                        "-o", str(TESTS / f"{name}.png")], check=True)


def run(rig, r):
    c = Cartouche(rig)

    print("in place of the clock")
    r.check("the extension is enabled", rig.js(f"{EXT}.state") == 1)
    st = c.state()
    r.check("it answers on D-Bus, at rest", st["mode"] == "compact" and st["visible"], st)
    r.check("GNOME's clock is hidden", rig.js("Main.panel.statusArea.dateMenu.opacity === 0"))
    r.check("its place in the top bar is as wide as the pill", rig.js(f"Main.panel.statusArea.dateMenu._clockDisplay.get_parent().width === {C}.compact.actor.get_preferred_width(-1)[1]"))
    r.check("GNOME's date button is still there for its menu and Super+V",
            rig.js("Main.panel.statusArea.dateMenu.mapped && Main.panel.statusArea.dateMenu.reactive"))
    r.check("the pill shows GNOME's clock text", st["compact"] == rig.js("Main.panel.statusArea.dateMenu._clock.clock"), st["compact"])
    g = c.geometry()
    r.check("it sits in the top bar, centred", g["y"] >= 0 and g["y"] + g["h"] <= g["panel"] and abs(g["x"] + g["w"] / 2 - 640) <= 1, g)
    r.check("it is a pill a little shorter than the bar", g["panel"] - 10 <= g["h"] < g["panel"], g)
    c.shot("01-compact")

    print("another screen, another scale")
    for scale in (2, 1, 2, 1):
        rig.js(f"imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = {scale}; 1")
        time.sleep(1.2)
        g = c.geometry()
        nat = rig.js(f"{C}.compact.actor.get_preferred_size().slice(2)")
        r.check(f"at scale {scale}, the pill fits inside the top bar", g["y"] >= 0 and g["y"] + g["h"] <= g["panel"], g)
        r.check(f"  and fits its contents", [round(g["w"]), round(g["h"])] == [round(nat[0]), round(nat[1])], (g, nat))
        r.check(f"  and its place in the top bar follows", rig.js(f"Main.panel.statusArea.dateMenu._clockDisplay.get_parent().width === {C}.compact.actor.get_preferred_width(-1)[1]"))

    print("logging in")
    # A taller top bar than the usual 32px, so a guessed size would show.
    rig.js("Main.panel.style = 'height: 44px;'; 1")
    time.sleep(0.8)
    expected = rig.js(f"{C}.island.height")
    # At login GNOME enables extensions while the top bar is still above the screen, then
    # slides it down: do the same.
    rig.js(f"Main.extensionManager.disableExtension('{UUID}'); Main.layoutManager.panelBox.translation_y = -Main.layoutManager.panelBox.height; 1")
    time.sleep(0.5)
    rig.js(f"Main.extensionManager.enableExtension('{UUID}'); 1")
    time.sleep(0.5)
    rig.js("Main.layoutManager.panelBox.ease({translation_y: 0, duration: 250, onComplete: () => Main.layoutManager.emit('startup-complete')}); 1")
    time.sleep(1.2)
    g = c.geometry()
    r.check("enabled while the top bar slides in at login, the pill still fits the bar", g["y"] >= 0 and g["y"] + g["h"] <= g["panel"] and g["h"] == expected, (g, expected))
    rig.js("Main.panel.style = null; 1")
    time.sleep(0.8)
    g = c.geometry()
    r.check("and follows the bar when it changes height", g["panel"] == 32 and g["h"] == 26, g)

    print("a size gone stale")
    good = c.geometry()
    # As if the session changed screens without GNOME telling us: wrong pill height, wrong
    # outline, a stale record of the top bar. The next clock tick has to put it right.
    rig.js(f"{C}.compact.setHeight(54); {C}._placed = {{...{C}._placed, compactHeight: 54}}; {C}._compactHeight = 54; {C}.island.set_size(420, 60); 1")
    time.sleep(0.3)
    rig.js(f"{C}._onClock(); 1")
    time.sleep(0.8)
    g = c.geometry()
    r.check("the next clock tick puts the pill back to the top bar's size", (g["y"], g["h"], g["w"]) == (good["y"], good["h"], good["w"]), (g, good))
    rig.js(f"{C}.island.set_size(420, 60); 1")
    rig.js(f"{C}._onClock(); 1")
    time.sleep(0.5)
    g = c.geometry()
    r.check("and the outline back to the pill's", (g["h"], g["w"]) == (good["h"], good["w"]), (g, good))
    st = c.state()
    r.check("cartouche state reports the sizes, for bug reports", st["geometry"]["pill"] == good["h"] and st["geometry"]["panel"][1] == good["panel"], st.get("geometry"))

    print("opening up")
    c.rest(1.2)
    r.check("resting the pointer on it opens it", c.mode() == "expanded")
    g2 = c.geometry()
    r.check("it grows down from the top bar, still centred", g2["h"] > 120 and g2["w"] > 240 and g2["y"] == g["y"] and abs(g2["x"] + g2["w"] / 2 - 640) <= 1, g2)
    r.check("the calendar shows today", rig.js(f"{C}.dashboard.calendar._date.text") == rig.js("imports.gi.GLib.DateTime.new_now_local().format('%-d %B')"))
    r.check("without music, it says nothing is playing or shows the calendar alone",
            not rig.js(f"{C}.dashboard.media.actor.visible"))
    c.shot("02-expanded")
    c.leave()
    r.check("moving away closes it", c.mode() == "compact")
    r.check("and it is the pill again", c.wait(lambda: abs(c.geometry()["h"] - g["h"]) < 1, 2), c.geometry())

    rig.js(f"{C}._settings.set_boolean('expand-on-hover', false); 1")
    c.rest(0.8)
    r.check("with hover turned off, resting does nothing", c.mode() == "compact")
    rig.t("click()", 0.6)
    r.check("and a click opens it", c.mode() == "expanded")
    c.leave(1.0)
    r.check("moving away closes it again", c.mode() == "compact")
    rig.js(f"{C}._settings.set_boolean('expand-on-hover', true); 1")

    c.call("Toggle")
    r.check("the shortcut action opens it", c.wait(lambda: c.mode() == "expanded", 2))
    c.call("Toggle")
    r.check("and closes it", c.wait(lambda: c.mode() == "compact", 2))
    r.check("the shortcut is bound", rig.js("!!Main.wm._allowedKeybindings['toggle-shortcut']"))

    print("swipes")
    c.rest(0.05)
    rig.js(f"{C}._settings.set_int('hover-delay', 2000); 1")
    c.rest(0.1)
    rig.t("wheel(imports.gi.Clutter.ScrollDirection.DOWN)", 0.6)
    r.check("swiping down opens it", c.mode() == "expanded")
    time.sleep(0.45)
    rig.t("wheel(imports.gi.Clutter.ScrollDirection.UP)", 0.6)
    r.check("swiping up closes it", c.mode() == "compact")
    rig.js(f"{C}._settings.reset('hover-delay'); 1")
    c.leave(0.3)

    print("right-click")
    c.rest(0.05)
    rig.t("click(3)", 0.6)
    r.check("right-click opens GNOME's notification list and calendar", rig.js("Main.panel.statusArea.dateMenu.menu.isOpen"))
    r.check("and the island stays closed", c.mode() == "compact")
    rig.js("Main.panel.statusArea.dateMenu.menu.close(); 1")
    c.leave(0.4)
    rig.js("Main.panel.toggleCalendar(); 1")
    time.sleep(0.4)
    r.check("Super+V (toggleCalendar) still opens GNOME's menu", rig.js("Main.panel.statusArea.dateMenu.menu.isOpen"))
    rig.js("Main.panel.closeCalendar(); 1")
    time.sleep(0.3)

    print("volume and brightness")
    c.settle()
    c.osd("audio-volume-medium-symbolic", 0.42)
    r.check("a volume change shows in the island", c.wait(lambda: c.peek() == "hud", 2))
    r.check("GNOME's own OSD stays hidden", not c.gnome_osd_visible())
    r.check("with the level", rig.js(f"{C}._current.view._percent.text") == "42%")
    c.shot("03-hud")
    c.osd("audio-volume-high-symbolic", 0.8)
    time.sleep(0.3)
    r.check("the next change updates it in place", c.peek() == "hud" and rig.js(f"{C}._current.view._percent.text") == "80%")
    c.osd("display-brightness-symbolic", 0.3)
    time.sleep(0.3)
    r.check("brightness too", rig.js(f"{C}._current.view.kind") == "brightness")
    c.osd("audio-volume-high-symbolic", 1.25, 1.5)
    time.sleep(0.3)
    r.check("over 100% volume reads as such", rig.js(f"{C}._current.view._percent.text") == "125%")
    r.check("and it goes away by itself", c.wait(lambda: c.mode() == "compact", 3.5))
    rig.js(f"{C}._settings.set_boolean('hud-volume', false); 1")
    c.osd("audio-volume-medium-symbolic", 0.5)
    time.sleep(0.4)
    r.check("with volume turned off, GNOME shows its own OSD", c.peek() is None and c.gnome_osd_visible())
    rig.js(f"{C}._settings.reset('hud-volume'); Main.osdWindowManager.hideAll(); 1")
    rig.js(f"{C}._settings.set_string('hud-style', 'segments'); 1")
    c.osd("keyboard-brightness-symbolic", 0.5)
    time.sleep(0.5)
    r.check("the segmented look", rig.js(f"{C}._current.view._level._segments.filter(s => s.has_style_pseudo_class('lit')).length") == 8)
    c.shot("04-hud-segments")
    rig.js(f"{C}._settings.reset('hud-style'); 1")
    c.osd("airplane-mode-symbolic", None, 1, "'Airplane Mode On'")
    time.sleep(0.4)
    r.check("other pop-ups show their text", rig.js(f"{C}._current.view._text.text") == "Airplane Mode On")
    c.settle()

    print("Do Not Disturb")
    subprocess.run(["gsettings", "set", "org.gnome.desktop.notifications", "show-banners", "true"], env=rig.env, check=True)
    r.check("turning it off is announced", c.wait(lambda: c.peek() == "focus", 2))
    c.shot("05-focus")
    c.settle()

    print("notifications")
    before = c.tray_count()
    nid = c.notify("Mail", "Ghassan", "Lunch tomorrow at the lab? I found a place near the Vieux-Port.")
    r.check("a notification shows in the island", c.wait(lambda: c.peek() == "notification", 3))
    r.check("GNOME's banner does not", not c.gnome_banner())
    r.check("it is still kept in GNOME's list", c.tray_count() == before + 1)
    r.check("it shows the title and the text",
            rig.js(f"{C}._current.view._title.text") == "Ghassan" and "Vieux-Port" in rig.js(f"{C}._current.view._body.text"))
    c.shot("06-notification")
    c.rest(0.2)
    time.sleep(5.5)
    r.check("it stays while the pointer is on it", c.peek() == "notification")
    c.leave(0.2)
    r.check("and goes away after", c.wait(lambda: c.mode() == "compact", 4))
    r.check("leaving it in the list", c.tray_count() == before + 1)

    nid = c.notify("Chat", "Léa", "Are you coming?")
    c.wait(lambda: c.peek() == "notification", 3)
    c.rest(0.1)
    rig.t("click(2)", 0.6)
    r.check("middle-click closes it for good", c.mode() == "compact" and c.tray_count() == before + 1)
    c.leave(0.2)

    c.notify("Chat", "Léa", "Are you coming?")
    c.wait(lambda: c.peek() == "notification", 3)
    c.rest(0.1)
    rig.t("wheel(imports.gi.Clutter.ScrollDirection.UP)", 0.5)
    r.check("swiping up puts it away", c.mode() == "compact")
    r.check("but keeps it in the list", c.tray_count() == before + 2)
    c.leave(0.2)

    c.notify("Chat", "Léa", "Click me")
    c.wait(lambda: c.peek() == "notification", 3)
    c.rest(0.1)
    rig.t("click()", 0.6)
    r.check("clicking it activates it (and GNOME removes it)", c.mode() == "compact" and c.tray_count() == before + 2)
    c.leave(0.2)

    c.notify("Calls", "Incoming call", "Mum", actions=["answer", "Answer", "decline", "Decline"])
    c.wait(lambda: c.peek() == "notification", 3)
    r.check("its buttons are there", rig.js(f"{C}._current.view.actor.get_last_child().get_n_children()") == 2)
    c.shot("07-notification-actions")
    c.settle()

    c.notify("Disk", "Disk almost full", "Only 1 GB left", urgency=2)
    c.wait(lambda: c.peek() == "notification", 3)
    time.sleep(6.5)
    r.check("an urgent notification stays until closed", c.peek() == "notification")
    c.settle()

    c.notify("Mail", "One", "first")
    c.notify("Mail", "Two", "second")
    r.check("two at once: the first shows", c.wait(lambda: c.peek() == "notification", 3) and rig.js(f"{C}._current.view._title.text") == "One")
    c.osd("audio-volume-medium-symbolic", 0.3)
    time.sleep(0.3)
    r.check("a volume change goes first", c.peek() == "hud")
    r.check("then the notification comes back", c.wait(lambda: c.peek() == "notification" and rig.js(f"{C}._current.view._title.text") == "One", 4))
    c.call("Dismiss")
    r.check("then the second one", c.wait(lambda: c.peek() == "notification" and rig.js(f"{C}._current.view._title.text") == "Two", 3))
    c.settle()

    c.call("Expand")
    c.wait(lambda: c.mode() == "expanded", 2)
    c.notify("Mail", "While open", "waits")
    time.sleep(0.6)
    r.check("while it is open, a notification waits", c.mode() == "expanded" and c.state()["queue"] == ["notification"])
    c.call("Collapse")
    r.check("and shows once it closes", c.wait(lambda: c.peek() == "notification", 3))
    c.settle()

    rig.js(f"{C}._settings.set_boolean('notifications', false); 1")
    c.notify("Mail", "Banner", "GNOME's turn")
    time.sleep(0.8)
    r.check("with notifications turned off, GNOME shows its banner", c.peek() is None and c.gnome_banner())
    rig.js(f"{C}._settings.reset('notifications'); 1")
    rig.js("Main.messageTray._hideNotification?.(false); Main.messageTray._notificationExpired = true; Main.messageTray._updateState(); 1")
    c.wait(lambda: not c.gnome_banner(), 6)

    print("now playing")
    c.settle()
    w0 = c.geometry()["w"]
    c.start_player()
    r.check("a player is found", c.wait(lambda: c.state()["player"] is not None, 6), c.state())
    r.check("its artwork arrives", c.wait(lambda: rig.js(f"{C}.compact._art._uri") is not None, 6))
    r.check("the pill widens for the artwork and bars", c.wait(lambda: c.geometry()["w"] > w0 + 20, 3), (w0, c.geometry()))
    r.check("the bars take the colour of the art", (rig.js(f"{C}.compact._bars._color") or "").startswith("rgb("))
    c.shot("08-media-compact")
    c.rest(1.3)
    r.check("opened, it shows the player", c.mode() == "expanded" and rig.js(f"{C}.dashboard.media.actor.visible"))
    r.check("with the title", rig.js(f"{C}.dashboard.media._title.text") == "Nile at Night")
    c.shot("09-media-expanded")
    rig.js(f"{C}.dashboard.media._next.emit('clicked', 1); 1")
    r.check("next goes to the player", c.wait(lambda: "Next" in c.player_calls(), 3))
    r.check("and the new title shows", c.wait(lambda: rig.js(f"{C}.dashboard.media._title.text") == "Valley of the Kings", 3))
    rig.js(f"{C}.dashboard.media._player.seekTo(60e6); 1")
    r.check("seeking sends the position", c.wait(lambda: any(x.startswith("SetPosition /test/track/2 60000000") for x in c.player_calls()), 3))
    rig.js(f"{C}.dashboard.media._play.emit('clicked', 1); 1")
    r.check("play/pause goes to the player", c.wait(lambda: "PlayPause" in c.player_calls() and c.state()["player"]["status"] == "Paused", 3))
    c.leave(0.8)
    r.check("paused music stays in the pill for a while", rig.js(f"{C}.compact._art.visible"))
    c.call("PlayPause")
    c.wait(lambda: c.state()["player"]["status"] == "Playing", 3)
    c.call("Next")
    r.check("a new song is shown for a moment", c.wait(lambda: c.peek() == "track", 3))
    c.wait(lambda: rig.js(f"{C}._current?.view?._art?._uri") is not None, 3)
    c.shot("10-track")
    print("music never leaves the top bar")
    c.settle()
    for scale, style in [(1, None), (1, "height: 44px;"), (2, None), (1, "height: 24px;")]:
        rig.js(f"imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = {scale}; Main.panel.style = {repr(style) if style else 'null'}; 1")
        time.sleep(1.2)
        # Sample every frame from inside the shell while the song changes and the volume moves.
        rig.js(f"""global._worst = 0; global._watch = global.stage.connect('after-paint', () => {{
            const i = {C}.island; if (!i || !i.visible) return; const [, y] = i.get_transformed_position();
            if ({C}.mode !== 'expanded' && {C}._current?.kind !== 'notification')
                global._worst = Math.max(global._worst, y + i.height - Main.panel.height); }}); 1""")
        c.call("Next")
        time.sleep(1.0)
        c.osd("audio-volume-medium-symbolic", 0.6)
        time.sleep(1.0)
        c.call("PlayPause"); time.sleep(0.4); c.call("PlayPause")
        time.sleep(3.0)
        worst = rig.js("global.stage.disconnect(global._watch); global._worst")
        r.check(f"at scale {scale}{', ' + style if style else ''}: the pill, the new song and the volume stay inside the bar", worst <= 0.01, worst)
    rig.js("imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; Main.panel.style = null; 1")
    time.sleep(1.0)
    c.settle()
    rig.t("move(641, 14)", 0.05)
    rig.js(f"{C}._settings.set_int('hover-delay', 2000); 1")
    calls = len(c.player_calls())
    rig.js(f"{C}._onScroll({{get_scroll_direction: () => imports.gi.Clutter.ScrollDirection.RIGHT}}); 1")
    r.check("swiping sideways skips the song", c.wait(lambda: len(c.player_calls()) > calls and c.player_calls()[-1] == "Next", 3))
    rig.js(f"{C}._settings.reset('hover-delay'); 1")
    c.settle()
    rig.js(f"{C}._settings.set_string('media-compact', 'title'); 1")
    time.sleep(0.6)
    r.check("the pill can show the title instead of the clock", c.state()["compact"] == c.state()["player"]["title"])
    c.shot("11-media-title")
    rig.js(f"{C}._settings.set_string('media-compact', 'clock'); 1")
    time.sleep(0.6)
    r.check("or just the clock", not rig.js(f"{C}.compact._art.visible"))
    rig.js(f"{C}._settings.reset('media-compact'); 1")

    print("a crowded top bar")
    c.settle()
    rig.js("global._crowd = new imports.gi.St.Widget({width: 10, height: 10}); Main.panel._rightBox.insert_child_at_index(global._crowd, 0); 1")
    def overlap():
        return rig.js(f"""(() => {{ const i = {C}.island; const [ix] = i.get_transformed_position(); const x1 = ix, x2 = ix + i.width;
            const [rx] = Main.panel._rightBox.get_transformed_position(); const [lx] = Main.panel._leftBox.get_transformed_position();
            return {{x1, x2, right: rx, left: lx + Main.panel._leftBox.width, art: {C}.compact._art.visible, bars: {C}.compact._bars.visible}}; }})()""")
    # Widths of the pill with and without its bars, and the room each crowd leaves it.
    full = rig.js(f"{C}.compact.actor.get_preferred_width(-1)[1]")
    bars_w = rig.js(f"{C}.compact._bars.get_preferred_width(-1)[1] + {C}.compact.actor.get_theme_node().get_length('spacing')")
    room0 = rig.js(f"{C}._room() + 2 * global._crowd.width")
    def crowd_for(room):
        return int((room0 - room) / 2)
    for width, art, bars in [(crowd_for(full + 40), True, True), (crowd_for(full - bars_w / 2), True, False), (crowd_for(60), False, False)]:
        rig.js(f"global._crowd.width = {width}; 1")
        time.sleep(1.2)
        o = overlap()
        r.check(f"with {width}px more icons, the pill never covers them", o["x2"] <= o["right"] + 1 and o["x1"] >= o["left"] - 1, o)
        r.check(f"  and keeps {'the artwork' if art else 'just the clock'}{' and bars' if bars else ''}", o["art"] == art and o["bars"] == bars, o)
    rig.js("global._crowd.destroy(); 1")
    time.sleep(1.0)
    o = overlap()
    r.check("with room again, the artwork and bars come back", o["art"] and o["bars"], o)

    print("battery, headphones")
    c.settle()
    rig.js(f"{C}.power.simulate(54, 2); {C}.power.simulate(55, 1); 1")
    r.check("plugging in is announced", c.wait(lambda: c.peek() == "battery", 2))
    c.shot("12-charging")
    c.settle()
    rig.js(f"{C}.power.simulate(21, 2); {C}.power.simulate(20, 2); 1")
    r.check("a low battery is announced", c.wait(lambda: c.peek() == "battery", 2))
    c.shot("13-low-battery")
    c.settle()
    rig.js(f"{C}.power.simulate(19, 2); 1")
    time.sleep(0.4)
    r.check("only once", c.peek() is None)
    rig.js(f"{C}.bluetooth.simulate('AirPods Pro', 'audio-headphones', true, 87); 1")
    r.check("headphones connecting are announced", c.wait(lambda: c.peek() == "bluetooth", 2))
    r.check("with their battery", rig.js(f"{C}._current.view._trailText.text") == "87%")
    c.shot("14-headphones")
    c.settle()

    print("appearance")
    rig.js(f"{C}._settings.set_string('appearance', 'graphite'); 1")
    c.call("Expand")
    time.sleep(0.8)
    r.check("graphite", rig.js(f"{C}.island.has_style_class_name('cartouche-graphite')"))
    c.shot("15-graphite")
    c.call("Collapse")
    rig.js(f"{C}._settings.reset('appearance'); 1")

    print("lock screen")
    c.settle()
    # The headless shell has no screen shield (no login manager): switch to the lock screen's
    # session mode directly, which is what locking does for extensions and the top bar.
    rig.js("Main.sessionMode.pushMode('unlock-dialog'); 1")
    locked = c.wait(lambda: c.state()["locked"], 6)
    r.check("the screen locks", locked)
    if locked:
        time.sleep(1.0)
        r.check("the extension stays on (it declares unlock-dialog)", rig.js(f"{EXT}.state") == 1)
        r.check("the island stays for what is playing", c.state()["visible"])
        r.check("showing the song title, not the clock", c.state()["compact"] == c.state()["player"]["title"])
        r.check("the shortcut is unbound while locked", not rig.js(f"{C}._keysBound"))
        c.notify("Mail", "Secret", "not on the lock screen")
        time.sleep(0.8)
        r.check("no notification on the lock screen", c.peek() != "notification")
        c.osd("audio-volume-medium-symbolic", 0.6)
        r.check("volume changes still show", c.wait(lambda: c.peek() == "hud", 2))
        c.shot("16-lock-screen")
        c.wait(lambda: c.mode() == "compact", 3)
        c.call("PlayPause")
        c.wait(lambda: c.state()["player"]["status"] == "Paused", 3)
        rig.js(f"{C}.media.active.pausedAt = 1; {C}._refreshCompact(); 1")
        time.sleep(0.3)
        r.check("with nothing playing, it hides on the lock screen", not c.state()["visible"])
        rig.js("Main.sessionMode.popMode('unlock-dialog'); 1")
        r.check("unlocked", c.wait(lambda: not c.state()["locked"], 6))
        time.sleep(0.6)
        r.check("the island is back with the clock", c.state()["visible"] and c.state()["compact"] == rig.js("Main.panel.statusArea.dateMenu._clock.clock"))
        r.check("the shortcut is bound again", rig.js(f"{C}._keysBound"))
        r.check("the notification that came while locked waits in GNOME's list", rig.js(
            "Main.messageTray.getSources().some(s => s.notifications.some(n => n.title === 'Secret'))"))

    print("off and on again")
    c.settle()
    rig.js(f"Main.extensionManager.disableExtension('{UUID}'); 1")
    time.sleep(0.8)
    r.check("disabled, GNOME's clock is back", rig.js("!Main.panel.statusArea.dateMenu._clockDisplay.get_parent().natural_width_set && Main.panel.statusArea.dateMenu.opacity === 255"))
    r.check("GNOME's OSD is GNOME's again", rig.js("!Object.prototype.hasOwnProperty.call(Main.osdWindowManager, '_showOsdWindow')"))
    r.check("GNOME's banners too", rig.js("!Object.prototype.hasOwnProperty.call(Main.messageTray, '_showNotification')"))
    r.check("nothing of the island is left", rig.js("!Main.layoutManager.uiGroup.get_children().some(a => a.name === 'cartoucheStage')"))
    r.check("the shortcut is released", rig.js("!Main.wm._allowedKeybindings['toggle-shortcut']"))
    c.shot("17-disabled")
    rig.js(f"Main.extensionManager.enableExtension('{UUID}'); 1")
    time.sleep(1.0)
    r.check("enabled again, it works", c.state()["mode"] == "compact" and rig.js("Main.panel.statusArea.dateMenu.opacity === 0"))
    c.osd("audio-volume-medium-symbolic", 0.5)
    r.check("and catches the OSD again", c.wait(lambda: c.peek() == "hud", 2))
    c.settle()

    print("the command")
    cli = lambda *a: subprocess.run(["sh", str(ROOT / "bin/cartouche"), *a], env=rig.env, capture_output=True, text=True)
    out = cli("state")
    r.check("cartouche state prints the state as JSON", out.returncode == 0 and json.loads(out.stdout)["mode"] == "compact", out.stdout + out.stderr)
    cli("open")
    r.check("cartouche open", c.wait(lambda: c.mode() == "expanded", 2))
    cli("close")
    r.check("cartouche close", c.wait(lambda: c.mode() == "compact", 2))
    calls = len(c.player_calls())
    cli("next")
    r.check("cartouche next", c.wait(lambda: len(c.player_calls()) > calls and c.player_calls()[-1] == "Next", 3))
    c.settle()

    print("settings window")
    rig.spawn(["gnome-extensions", "prefs", UUID], log=rig.tmp / "prefs.log")
    opened = c.wait(lambda: rig.js("global.display.list_all_windows().some(w => (w.get_title() || '').includes('Cartouche'))"), 15)
    r.check("the settings open", opened, (rig.tmp / "prefs.log").read_text()[-800:])
    time.sleep(1.5)
    c.shot("18-settings")

    print("errors")
    errors = [line for line in rig.shell_log().split("\n")
              if ("JS ERROR" in line or "JS WARNING" in line or "Cartouche" in line or "cartouche" in line)
              and "fake-player" not in line]
    r.check("no errors or warnings in GNOME Shell's log", not errors, "\n".join(errors[-20:]))
    prefs_errors = [line for line in (rig.tmp / "prefs.log").read_text().split("\n") if "rror" in line or "WARNING" in line or "CRITICAL" in line]
    r.check("none from the settings window", not prefs_errors, "\n".join(prefs_errors[-20:]))


def main():
    keep = "--keep" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    covers()
    rig = Rig(UUID, ROOT / "extension")
    r = Results()
    try:
        rig.start()
        time.sleep(1.0)
        run(rig, r)
    finally:
        rig.stop(keep_tmp=keep)
        if keep:
            print(f"kept {rig.tmp}")
    print(f"\n{r.count - len(r.failed)}/{r.count} passed")
    if r.failed:
        print("failed:\n  " + "\n  ".join(r.failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
