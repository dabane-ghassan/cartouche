// Names shared by the shell side, the preferences and the command.
// No imports here: this file is loaded both inside GNOME Shell and in the preferences process.

export const UUID = 'cartouche@dabane-ghassan.github.io';
export const SCHEMA = 'org.gnome.shell.extensions.cartouche';

// The shell side, on the org.gnome.Shell connection.
export const SHELL_PATH = '/io/github/dabane_ghassan/Cartouche';
export const SHELL_IFACE = 'io.github.dabane_ghassan.Cartouche';

export const SHELL_XML = `
<node>
  <interface name="${SHELL_IFACE}">
    <method name="Expand"/>
    <method name="Collapse"/>
    <method name="Toggle"/>
    <method name="Dismiss"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
  </interface>
</node>`;

export const REPO = 'https://github.com/dabane-ghassan/cartouche';
export const SITE = 'https://dabane-ghassan.github.io/cartouche/';
