/* Magnet — pull every open window onto the screen you clicked.
 *
 * Wayland forbids one process from moving another's windows, so this has to
 * live inside gnome-shell as an extension rather than as a standalone tray app.
 *
 * The button is added once, to Main.panel. Multi Monitor Bar mirrors every
 * panel indicator onto the secondary panels automatically, and when one of
 * those mirrors is clicked it re-emits the original Clutter event at us — which
 * still carries the coordinates of the real click. That is how a click on
 * screen 2 is distinguished from a click on screen 1.
 *
 * Three consequences of how that mirroring works shape the code below:
 *
 *  - The mirror only forwards a click if it finds no menu on us. It checks
 *    `sourceIndicator.menu` first and opens that instead. So our popup
 *    deliberately lives on `_magnetMenu`, a name the mirror does not probe,
 *    leaving left-click on the gather path.
 *  - `dontCreateMenu` is not enough on its own: the shell then assigns a
 *    PopupDummyMenu, which is truthy, so the mirror would still hijack the
 *    click and open a menu that does nothing. `this.menu` is nulled explicitly.
 *  - On GNOME 50 a PanelMenu.Button that owns a menu gets a Clutter.ClickGesture
 *    that swallows button presses before any handler sees them. Constructing
 *    with dontCreateMenu avoids it — the same pattern ubuntu-appindicators uses
 *    for legacy tray icons on this shell version.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    clearUndo,
    gatherTo,
    hasUndo,
    resolveTargetMonitor,
    undoLastGather,
} from './gather.js';

const GATHER_SHORTCUT = 'gather-shortcut';
const UNDO_SHORTCUT = 'undo-shortcut';

const MagnetIndicator = GObject.registerClass(
class MagnetIndicator extends PanelMenu.Button {
    _init(extension) {
        // Third argument is dontCreateMenu, which stops GNOME 50 installing a
        // ClickGesture that would eat the button press before we see it.
        super._init(0.0, 'Magnet', true);

        // dontCreateMenu does not leave `menu` unset, though — the shell
        // assigns a PopupDummyMenu, which is truthy, and Multi Monitor Bar's
        // mirror tests `if (sourceIndicator.menu)` before it will forward a
        // click. Left as-is, every click on a secondary panel would open a
        // do-nothing dummy menu instead of gathering. Null it so clicks are
        // forwarded to us. vfunc_key_press_event is overridden below because
        // the inherited one toggles this.menu.
        this.menu = null;

        this._extension = extension;
        this._settings = extension.getSettings();

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/hicolor/scalable/actions/magnet-symbolic.svg`),
            style_class: 'system-status-icon',
        }));

        this._buildMenu();

        this.connect('button-press-event',
            (_actor, event) => this._onButtonPress(event));
        this.connect('destroy', () => this._onDestroy());
    }

    _buildMenu() {
        // Not `this.menu` — see the note at the top of the file.
        const menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('panel-menu');
        Main.uiGroup.add_child(menu.actor);
        menu.close();
        Main.panel.menuManager.addMenu(menu);

        this._undoItem = new PopupMenu.PopupImageMenuItem(
            'Undo last gather', 'edit-undo-symbolic');
        this._undoItem.connect('activate', () => {
            menu.close();
            undoLastGather();
        });
        menu.addMenuItem(this._undoItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => {
            menu.close();
            this._extension.openPreferences();
        });
        menu.addMenuItem(prefsItem);

        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._undoItem.setSensitive(hasUndo());
        });

        this._magnetMenu = menu;
    }

    /* Exists only so that reading `.vfunc_button_press_event` on this object
     * does not throw.
     *
     * Clutter dropped the per-event-type vfuncs in its gesture refactor, so
     * GJS raises "Virtual function not implemented: Class StWidget doesn't
     * implement button_press_event" when anything reads that property off a
     * class which does not define one in JS. Multi Monitor Bar's mirror does
     * exactly that, in the one branch that would otherwise forward the click
     * to us (mirroredIndicatorButton.js:2068):
     *
     *     if (this._sourceIndicator.vfunc_button_press_event || ...)
     *
     * The exception escaped before the forward happened, which left the button
     * completely dead on every secondary panel — no gather, and no menu on
     * right-click either. Defining this method puts a plain function on the
     * prototype, so the lookup succeeds and the forward proceeds.
     *
     * The forward arrives as an emission of the button-press-event *signal*,
     * which the handler connected in _init picks up, so this deliberately does
     * nothing itself. Returning PROPAGATE also keeps it harmless in the event
     * that Clutter ever wires it up as a real class closure again.
     */
    vfunc_button_press_event(_event) {
        return Clutter.EVENT_PROPAGATE;
    }

    // Replaces PanelMenu.Button's implementation, which would dereference the
    // menu we just nulled. Doubles as keyboard access to the button itself.
    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return ||
            symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_space) {
            gatherTo(resolveTargetMonitor(null), this._settings);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onButtonPress(event) {
        let button;
        try {
            button = event.get_button();
        } catch (_e) {
            button = Clutter.BUTTON_PRIMARY;
        }

        if (button === Clutter.BUTTON_SECONDARY) {
            this._openMenuNear(event);
            return Clutter.EVENT_STOP;
        }

        gatherTo(resolveTargetMonitor(event), this._settings);
        return Clutter.EVENT_STOP;
    }

    /* Return an invisible actor occupying the given rectangle, for the popup to
     * be anchored to.
     *
     * Preference goes to the shell's own dummyCursor, which exists precisely so
     * that a menu can be pointed at arbitrary coordinates, and is therefore
     * known to survive whatever layout uiGroup applies to its children. The
     * fallback widget asks for a fixed size at START alignment so that uiGroup
     * does not stretch it — a stretched anchor would drop the menu far below
     * the panel.
     */
    _anchorActorFor(x, y, width, height) {
        const layoutManager = Main.layoutManager;
        if (typeof layoutManager.setDummyCursorGeometry === 'function' &&
            layoutManager.dummyCursor) {
            layoutManager.setDummyCursorGeometry(x, y, width, height);
            return layoutManager.dummyCursor;
        }

        if (!this._anchor) {
            this._anchor = new St.Widget({
                opacity: 0,
                reactive: false,
                x_expand: false,
                y_expand: false,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });
            Main.uiGroup.add_child(this._anchor);
        }

        this._anchor.set_position(x, y);
        this._anchor.set_size(width, height);
        return this._anchor;
    }

    /* Open the popup on the screen that was clicked rather than always on the
     * primary one.
     *
     * Anchoring goes by the click's coordinates, not by event.get_source():
     * the coordinates are known to survive Multi Monitor Bar's re-emission,
     * because gathering already resolves the correct monitor from them.
     */
    _openMenuNear(event) {
        const menu = this._magnetMenu;
        if (!menu)
            return;

        let coords = null;
        try {
            coords = event ? event.get_coords() : null;
        } catch (_e) {
            coords = null;
        }

        if (coords) {
            const [x] = coords;
            const monitor =
                Main.layoutManager.monitors[resolveTargetMonitor(event)];

            if (monitor) {
                this._anchorMenuTo(this._anchorActorFor(
                    Math.round(x), monitor.y, 1, Main.panel.height));
            }
        } else {
            // No event to place it by (keyboard); fall back to the button.
            this._anchorMenuTo(this);
        }

        menu.toggle();
    }

    /* Setting menu.sourceActor alone is not enough: the BoxPointer holds its
     * own reference and caches the allocation it last positioned against, so
     * without these it keeps pointing at wherever the menu was last opened —
     * which is what made a right-click on a secondary panel open the menu back
     * on the primary screen. Multi Monitor Bar's own keepAnchoredToProxy does
     * the same three assignments.
     */
    _anchorMenuTo(actor) {
        const menu = this._magnetMenu;
        menu.sourceActor = actor;

        for (const target of [menu.box, menu._boxPointer]) {
            if (!target)
                continue;
            target._sourceActor = actor;
            target._sourceAllocation = null;
        }
    }

    _onDestroy() {
        if (this._magnetMenu) {
            Main.panel.menuManager.removeMenu(this._magnetMenu);
            this._magnetMenu.destroy();
            this._magnetMenu = null;
        }
        this._undoItem = null;

        this._anchor?.destroy();
        this._anchor = null;
        this._settings = null;
        this._extension = null;
    }
});

export default class MagnetExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._indicator = new MagnetIndicator(this);
        Main.panel.addToStatusArea('magnet', this._indicator, 0, 'right');

        Main.wm.addKeybinding(
            GATHER_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => gatherTo(resolveTargetMonitor(null), this._settings));

        Main.wm.addKeybinding(
            UNDO_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => undoLastGather());
    }

    disable() {
        Main.wm.removeKeybinding(GATHER_SHORTCUT);
        Main.wm.removeKeybinding(UNDO_SHORTCUT);

        this._indicator?.destroy();
        this._indicator = null;

        // Snapshots hold references to Meta.Window objects; the shell disables
        // extensions on screen lock, so do not keep them alive across that.
        clearUndo();

        this._settings = null;
    }
}
