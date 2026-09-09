#!/usr/bin/env bash
# Install Magnet by symlinking this checkout into the GNOME Shell extensions
# directory, so edits here take effect without reinstalling.
set -euo pipefail

UUID="magnet@moke"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

# Use the system glib-compile-schemas explicitly: a Homebrew copy shadows it in
# PATH, and the compiled schema needs to match the GLib gnome-shell links to.
COMPILE_SCHEMAS="/usr/bin/glib-compile-schemas"
[ -x "$COMPILE_SCHEMAS" ] || COMPILE_SCHEMAS="$(command -v glib-compile-schemas)"

echo "Compiling schemas..."
"$COMPILE_SCHEMAS" "${SRC}/schemas/"

mkdir -p "$(dirname "$DEST")"

if [ -L "$DEST" ]; then
    echo "Replacing existing symlink at ${DEST}"
    rm "$DEST"
elif [ -e "$DEST" ]; then
    echo "Error: ${DEST} exists and is not a symlink." >&2
    echo "Move or remove it yourself, then re-run this script." >&2
    exit 1
fi

ln -s "$SRC" "$DEST"
echo "Linked ${DEST} -> ${SRC}"

echo "Enabling ${UUID}..."
gnome-extensions enable "$UUID" || true

echo
gnome-extensions info "$UUID" || true

cat <<'NOTE'

If the state above is not ACTIVE (ERROR, INACTIVE or OUT OF DATE), log out and
back in once. This is a Wayland session, so gnome-shell cannot be restarted in
place the way Alt+F2 r does on X11.

Watch for problems with:
    journalctl -f -o cat /usr/bin/gnome-shell
NOTE
