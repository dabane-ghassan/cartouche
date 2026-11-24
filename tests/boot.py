#!/usr/bin/env python3
"""Boot-order tests: the top bar, the scale and the screen changing in the orders a session
start can bring (bar hidden or sliding in at login, scale flipping, changes while the island is
open, hidden or behind a fullscreen window). After each, the pill must fit the bar and its
contents. Run with: python3 tests/boot.py (make test runs it too).
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from rig import Rig  # noqa: E402
import run as R  # noqa: E402

failed = []
r = Rig(R.UUID, R.ROOT / "extension")
C = R.C; U = R.UUID
def check(name):
    time.sleep(1.5)
    g = r.js(f"""(() => {{ const c = {C}; const i = c.island; const v = c.compact.actor; const [x, y] = i.get_transformed_position();
      const [, nw] = v.get_preferred_width(-1); const [, nh] = v.get_preferred_height(nw);
      return {{mode: c.mode, panel: Main.panel.height, y, h: i.height, w: i.width, nat: [nw, nh], ch: c._compactHeight, scale: imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor}}; }})()""")
    ok = g["y"] >= 0 and g["y"] + g["h"] <= g["panel"] and abs(g["h"] - (g["panel"] - 2 * min(3 * g["scale"], g["panel"] * .12))) <= 1.01 and (g["mode"] != "compact" or [round(g["w"]), round(g["h"])] == [round(g["nat"][0]), round(g["nat"][1])])
    print(("  ok  " if ok else "  FAIL"), name, "" if ok else g)
    if not ok:
        failed.append(name)
def reset():
    r.js("imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; Main.panel.style = null; Main.layoutManager.panelBox.show(); Main.layoutManager.panelBox.translation_y = 0; 1")
    time.sleep(1)
def reenable(pre, post):
    r.js(f"Main.extensionManager.disableExtension('{U}'); {pre}; 1"); time.sleep(0.4)
    r.js(f"Main.extensionManager.enableExtension('{U}'); 1"); time.sleep(0.4)
    r.js(f"{post}; 1")
try:
    r.start(); time.sleep(1)
    check("baseline")
    reenable("Main.layoutManager.panelBox.hide()", "Main.panel.style = 'height: 44px;'; Main.layoutManager.panelBox.show()"); check("A: bar hidden at enable, shown later taller"); reset()
    reenable("Main.layoutManager.panelBox.translation_y = -32", "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2; Main.layoutManager.panelBox.ease({translation_y: 0, duration: 250, onComplete: () => Main.layoutManager.emit('startup-complete')})"); check("B: scale change during login slide"); reset()
    reenable("imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2; Main.panel.style = 'height: 60px;'", "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; Main.panel.style = null"); check("C: enabled at big scale, back to 1 right after"); reset()
    r.js(f"{C}.expand(); 1"); time.sleep(0.6); r.js("Main.panel.style = 'height: 44px;'; 1"); time.sleep(0.6); r.js(f"{C}.collapse(); 1"); check("D: bar changes while expanded"); reset()
    r.js(f"{C}.island.hide(); 1"); r.js("Main.panel.style = 'height: 44px;'; 1"); time.sleep(0.8); r.js(f"{C}.island.show(); 1"); check("E: bar changes while island hidden"); reset()
    r.js(f"{C}._stage.hide(); 1"); r.js("Main.panel.style = 'height: 44px;'; imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2"); time.sleep(0.8); r.js(f"{C}._stage.show(); 1"); check("F: changes while stage hidden (fullscreen)"); reset()
    r.js("Main.panel.style = 'height: 44px;'; imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2; Main.panel.style = null; imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; 1"); check("G: rapid flip-flop in one go")
    r.js("Main.layoutManager.panelBox.translation_y = -32; Main.layoutManager.emit('monitors-changed'); 1"); time.sleep(0.3); r.js("Main.panel.style = 'height: 44px;'; 1"); time.sleep(0.3); r.js("Main.layoutManager.panelBox.translation_y = 0; 1"); check("H: monitors-changed mid-slide, no startup-complete"); reset()
finally:
    r.stop()
print(f"\n{9 - len(failed)}/9 passed")
sys.exit(1 if failed else 0)
