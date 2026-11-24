# Tests

`python3 tests/run.py` (or `make test`) starts a private, headless GNOME Shell and loads the
extension from this checkout. It then drives the island the way you would: a virtual mouse
rests on it, clicks, right-clicks, middle-clicks and swipes; GNOME's own OSD manager is asked to
show volume, brightness and keyboard levels; real notifications go through
`org.freedesktop.Notifications`; and a pretend music player (`fake-player.js`) speaks MPRIS on
the session bus, with two album covers. Screenshots are saved to `tests/out/`.

It checks, among other things, that GNOME's clock, OSD and banners are hidden while Cartouche
runs and come back exactly as they were when it is turned off; that notifications still land in
GNOME's list; that the lock screen gets music and levels but never notifications; that the
settings window opens; and that GNOME Shell's log stays free of warnings.

You need `gnome-shell`, `gjs`, libadwaita and `rsvg-convert`. Nothing touches your own session
or settings: the run uses a temporary home folder and its own D-Bus. `make lint` runs the quick
static checks (JavaScript syntax, the settings schema, the shell scripts).

In a container there is usually no system bus and no login manager. Start one bus with
`dbus-daemon --system --fork`, and if GNOME Shell exits complaining about the login manager,
move an empty `/run/systemd/seats` out of the way. The headless shell has no screen shield, so
the lock screen is entered by switching to its session mode (`unlock-dialog`), which is what
locking does as far as extensions and the top bar are concerned.

`tests/boot.py` replays the orders a session start can bring: the top bar hidden or sliding
in at login, the scale flipping, the bar changing while the island is open, hidden or behind a
fullscreen window. After each, the pill must fit the bar and its contents.

The headless shell cannot show sound, fullscreen windows or the exact pacing of animations (it
draws frames as fast as it can).
