// SPDX-FileCopyrightText: 2026 moke
// SPDX-License-Identifier: GPL-2.0-or-later

/* Magnet preferences. */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// A shortcut has to include at least one of these, otherwise typing a plain
// letter anywhere would trigger a gather.
const REQUIRED_MODIFIERS =
    Gdk.ModifierType.CONTROL_MASK |
    Gdk.ModifierType.ALT_MASK |
    Gdk.ModifierType.SUPER_MASK;

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, subtitle) {
        super._init({title, subtitle, activatable: true});

        this._settings = settings;
        this._key = key;

        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._shortcutLabel);

        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Clear shortcut',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        clearButton.connect('clicked', () => this._save(''));
        this.add_suffix(clearButton);

        this._changedId = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this.connect('activated', () => this._capture());

        this._sync();
    }

    _sync() {
        const [accel] = this._settings.get_strv(this._key);
        this._shortcutLabel.set_accelerator(accel ?? '');
    }

    _save(accel) {
        this._settings.set_strv(this._key, accel ? [accel] : []);
    }

    _capture() {
        const dialog = new Adw.Dialog({
            title: 'Set shortcut',
            content_width: 380,
            content_height: 180,
        });

        const status = new Adw.StatusPage({
            title: 'Press a key combination',
            description:
                'Must include Ctrl, Alt or Super.\n' +
                'Backspace clears the shortcut, Escape cancels.',
        });
        dialog.set_child(status);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() &
                ~Gdk.ModifierType.LOCK_MASK;

            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                this._save('');
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            // Keep waiting while only modifiers are held, or if the
            // combination is not usable as an accelerator.
            if ((mask & REQUIRED_MODIFIERS) === 0)
                return Gdk.EVENT_STOP;
            if (!Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            this._save(
                Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        dialog.present(this.get_root());
    }
});

export default class MagnetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Magnet',
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        const behaviour = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description:
                'Clicking the panel icon pulls windows onto the screen the ' +
                'click happened on. Windows always keep the workspace they ' +
                'are on — only their monitor changes.',
        });
        page.add(behaviour);

        const scopeRow = new Adw.ComboRow({
            title: 'Windows to gather',
            subtitle: 'Which windows a single click sweeps up',
            model: Gtk.StringList.new([
                'All workspaces',
                'Current workspace only',
            ]),
        });
        const scopeValues = ['all-workspaces', 'current-workspace'];
        scopeRow.selected = Math.max(0,
            scopeValues.indexOf(settings.get_string('scope')));
        scopeRow.connect('notify::selected', () => {
            settings.set_string('scope', scopeValues[scopeRow.selected]);
        });
        behaviour.add(scopeRow);

        const dialogsRow = new Adw.SwitchRow({
            title: 'Include dialog windows',
            subtitle: 'When off, only ordinary application windows are moved',
        });
        settings.bind('include-dialogs', dialogsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(dialogsRow);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description:
                'These act on the screen the mouse pointer is currently on.',
        });
        page.add(shortcuts);

        shortcuts.add(new ShortcutRow(settings, 'gather-shortcut',
            'Gather windows', 'Pull every window to the pointer’s screen'));
        shortcuts.add(new ShortcutRow(settings, 'undo-shortcut',
            'Undo last gather', 'Send windows back where they came from'));
    }
}
