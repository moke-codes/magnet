#!/usr/bin/env bash
# Exercise prefs.js against the real ExtensionPreferences base class, without
# opening the dialog.
#
# Preferences run in a separate process from gnome-shell, with the shell's JS
# exposed under a *different* resource prefix. Stubbing that import out means a
# wrong path sails through unnoticed and only fails when the dialog is opened,
# so this registers the same gresource the real prefs process uses and imports
# the genuine module.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/run.js" <<JS
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';

Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();

const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
print('real ExtensionPreferences imported');

const MagnetPreferences = (await import('file://${SRC}/prefs.js')).default;
if (!(MagnetPreferences.prototype instanceof ExtensionPreferences))
    throw new Error('prefs.js default export does not subclass ExtensionPreferences');
print('prefs.js imported and subclasses ExtensionPreferences');

Adw.init();
const dir = Gio.File.new_for_path('${SRC}');
const metadata = JSON.parse(new TextDecoder().decode(
    dir.get_child('metadata.json').load_contents(null)[1]));

const prefs = new MagnetPreferences({...metadata, dir, path: dir.get_path()});
const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);
print('fillPreferencesWindow built the page (settings schema resolved)');
window.destroy();
JS

GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0:/usr/lib/gnome-shell \
LD_LIBRARY_PATH=/usr/lib/gnome-shell \
    gjs -m "$WORK/run.js"

echo "prefs OK"
