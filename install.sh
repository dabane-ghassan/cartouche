#!/bin/sh
# Installs Cartouche for the current user. No root needed.
#
#   curl -fsSL https://dabane-ghassan.github.io/cartouche/install.sh | sh
#
# Works on any distro with the GNOME desktop (45 or later): it only uses sh, curl (or wget) and tar.
#   sh install.sh             install from this folder instead (a checkout or an unpacked release)
#   sh install.sh --remove    uninstall (your settings are kept)
set -eu

UUID="cartouche@dabane-ghassan.github.io"
APP="io.github.dabane_ghassan.Cartouche"
RELEASE="https://github.com/dabane-ghassan/cartouche/releases/latest/download/cartouche.tar.gz"
SOURCE="https://github.com/dabane-ghassan/cartouche/archive/refs/heads/main.tar.gz"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT="$DATA/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--remove" ]; then
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    rm -rf "$EXT" "$BIN/cartouche" "$DATA/applications/$APP.desktop" \
        "$DATA/icons/hicolor/scalable/apps/$APP.svg"
    rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/cartouche"
    say "Cartouche removed; the clock is back. Your settings are kept. Log out and back in to finish."
    exit 0
fi

command -v gnome-shell >/dev/null 2>&1 || { say "Cartouche needs the GNOME desktop (GNOME Shell 45 or later)."; exit 1; }

MAJOR="$(gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p')"
if [ -n "$MAJOR" ] && [ "$MAJOR" -lt 45 ]; then
    say "Cartouche needs GNOME Shell 45 or later; this is GNOME Shell $MAJOR."
    exit 1
fi

# Find the files: next to this script, or download the latest release.
SRC=""
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/extension/metadata.json" ]; then
    SRC="$HERE"
else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    say "Downloading Cartouche..."
    fetch() {
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$1" -o "$2" 2>/dev/null
        else
            wget -q "$1" -O "$2"
        fi
    }
    # the latest release, or the current source when there is no release yet
    if fetch "$RELEASE" "$TMP/cartouche.tar.gz"; then
        tar -xzf "$TMP/cartouche.tar.gz" -C "$TMP"
    elif fetch "$SOURCE" "$TMP/source.tar.gz"; then
        tar -xzf "$TMP/source.tar.gz" -C "$TMP"
        mv "$TMP/cartouche-main" "$TMP/cartouche"
    else
        say "Could not download Cartouche. Check your connection and try again."
        exit 1
    fi
    SRC="$TMP/cartouche"
fi

WAS=""
[ -f "$EXT/metadata.json" ] && WAS="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$EXT/metadata.json")"
NOW="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$SRC/extension/metadata.json")"
mkdir -p "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
rm -rf "$EXT"
mkdir -p "$EXT"
cp -R "$SRC/extension/." "$EXT/"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$EXT/schemas"
fi
install -m 755 "$SRC/bin/cartouche" "$BIN/cartouche"
sed "s|^Exec=cartouche|Exec=$BIN/cartouche|" "$SRC/packaging/$APP.desktop" > "$DATA/applications/$APP.desktop"
cp "$SRC/extension/assets/icons/cartouche.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" >/dev/null 2>&1 || true

gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

say ""
if [ -n "$WAS" ] && [ "$WAS" != "$NOW" ]; then
    say "Cartouche updated from $WAS to $NOW."
elif [ -n "$WAS" ]; then
    say "Cartouche $NOW reinstalled."
else
    say "Cartouche $NOW is installed."
fi
if gdbus call --session --dest org.gnome.Shell --object-path /io/github/dabane_ghassan/Cartouche \
        --method io.github.dabane_ghassan.Cartouche.GetState >/dev/null 2>&1; then
    say "Log out and back in to load the new version."
else
    say "Log out and back in once so GNOME loads it."
fi
say "Then the clock in the top bar is the island: rest the pointer on it, or press Ctrl+Alt+I."
case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "(The 'cartouche' command is in $BIN, which is not on your PATH yet.)" ;;
esac
