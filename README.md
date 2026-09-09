# Magnet

**A GNOME Shell extension that gathers all your windows onto one screen.**

Click the magnet icon in the top bar and every open window is pulled onto the
screen you clicked on. Click it on your laptop's panel and the windows come to
the laptop; click it on an external monitor's panel and they go there instead.

Windows keep the workspace they are on — only their monitor changes.

Anyone is welcome to use it, file issues, or send patches. It is written for
multi-monitor setups where the top bar is shown on every screen, which is what
makes "click it *here*" meaningful.

## Requirements

- **GNOME Shell 50** on Wayland or X11. Developed and tested against Ubuntu
  26.04 (Mutter 18).
- **A top bar on every monitor**, for the per-screen click to be useful. GNOME
  only draws its panel on the primary monitor, so this needs
  [Multi Monitor Bar](https://github.com/FrederykAbryan/multi-monitors-bar_fapv2)
  or something equivalent.

Without a multi-monitor panel extension, Magnet still works — the icon just
appears only on the primary panel, so clicking it always gathers there. The
keyboard shortcut is unaffected, because it targets the screen under the mouse
pointer rather than the screen that was clicked.

## Install

```bash
git clone https://github.com/moke-codes/magnet.git
cd magnet
./install.sh
```

This symlinks the checkout into
`~/.local/share/gnome-shell/extensions/magnet@moke`, compiles the settings
schema and enables the extension. Because it is a symlink, later edits to the
checkout are picked up rather than needing a reinstall.

GNOME does not hot-load a newly added extension. On X11 press
<kbd>Alt</kbd>+<kbd>F2</kbd> and run `r`; on Wayland the shell cannot be
restarted in place, so log out and back in once. If it still does not come up
`ACTIVE`, check `gnome-extensions info magnet@moke`.

## Usage

| Action | How |
| --- | --- |
| Gather windows to a screen | Left-click the magnet icon on that screen's panel |
| Gather to the pointer's screen | <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> |
| Undo the last gather | Right-click the icon → *Undo last gather*, or <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> |
| Settings | Right-click the icon → *Preferences* |

Undo restores each window's original monitor, and its size and position for
windows that were neither maximized nor fullscreen. Only the most recent gather
is undoable, and windows closed in the meantime are skipped.

## Preferences

- **Windows to gather** — all workspaces (default) or only the current one.
- **Include dialog windows** — on by default.
- **Keyboard shortcuts** — rebindable; must include Ctrl, Alt or Super.

## What gets moved

Ordinary application windows on every workspace, plus dialogs unless you turn
those off in preferences. Deliberately left alone:

- anything marked skip-taskbar — desktop icons (the `ding` extension creates one
  window per monitor), docks, notification banners
- windows Mutter reports as unmovable, which covers dialogs attached to a parent
- windows already on the target screen

Moving uses `Meta.Window.move_to_monitor()`, the same call behind GNOME's own
<kbd>Shift</kbd>+<kbd>Super</kbd>+<kbd>Arrow</kbd>. It rescales a window
proportionally between the two work areas and carries maximized and fullscreen
state across, which matters when the screens differ a lot in resolution or
scaling.

## Why an extension rather than a tray app

Under Wayland, no process may move another application's windows. The usual
tools (`wmctrl`, `xdotool`) only ever worked because X11 let any client
reposition any window, and that hole is closed. The only code allowed to move
windows is code running inside the compositor, which on GNOME means an
extension. Being an extension also means it starts with the session, with no
autostart entry to maintain.

## How the per-screen click works

The button is added once, to `Main.panel`. Multi Monitor Bar mirrors every panel
indicator onto the secondary panels automatically, and when you click one of
those mirrors it re-emits the original Clutter event at the real indicator. That
event still carries the coordinates of the actual click, which is how a click on
screen 2 is told apart from a click on screen 1.

Several details of that arrangement are load-bearing, and all are commented in
`extension.js`:

- The mirror only forwards a click if it finds no menu on the real indicator —
  it checks `sourceIndicator.menu` **first** and opens that instead. So the
  popup deliberately lives on `_magnetMenu`, a property name the mirror does not
  look for, which keeps left-click on the gather path.
- Passing `dontCreateMenu` is not sufficient by itself: the shell then assigns a
  `PopupDummyMenu`, which is still truthy, so the mirror would hijack the click
  and open a menu that does nothing. `this.menu` is therefore nulled explicitly,
  and `vfunc_key_press_event` is overridden because the inherited one would
  dereference it.
- On GNOME 50, a `PanelMenu.Button` that owns a menu gets a `Clutter.ClickGesture`
  that swallows button presses before any handler sees them. The button is
  constructed with `dontCreateMenu` to avoid that — the same pattern
  `ubuntu-appindicators` uses for legacy tray icons on this shell version.
- Multi Monitor Bar has a bug on GNOME 50 that breaks that forwarding branch
  outright. Clutter dropped the per-event-type vfuncs in its gesture refactor,
  so GJS throws `Virtual function not implemented: Class StWidget doesn't
  implement button_press_event` when anything reads `.vfunc_button_press_event`
  off a class that does not define one in JS — and the mirror reads exactly that
  in its forwarding test (`mirroredIndicatorButton.js:2068`). The exception
  escaped before the click was forwarded, leaving the button completely inert on
  secondary panels. Magnet defines a no-op `vfunc_button_press_event` purely so
  that property lookup finds a plain function and never reaches GJS's vfunc
  resolver. The click then arrives as a normal `button-press-event` signal
  emission, which is what the real handler listens for.
- Opening the right-click menu on the screen that was clicked needs more than
  setting `menu.sourceActor`. The `BoxPointer` holds its own `_sourceActor` and
  caches the allocation it last positioned against, so setting only the menu's
  property left the popup anchored to the primary-panel button. Magnet anchors
  by the click's *coordinates* — proven to survive the re-emission, since the
  gather resolves the right monitor from them — pointing the menu at the shell's
  `dummyCursor` placed under the panel at the click position.

## Development

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

is the only console you get — every JS exception in `enable()` or in a click
handler shows up there.

Preferences run in a **separate process** from gnome-shell, and the shell's JS
is exposed there under a different resource prefix
(`resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`, not the
`resource:///org/gnome/shell/...` paths `extension.js` uses). Check that side
without clicking through the dialog:

```bash
./test-prefs.sh
```

It registers the same gresource the real prefs process does and imports the
genuine `ExtensionPreferences`, so a wrong import path or an unresolvable
settings schema fails there rather than at the dialog.

Changes to `extension.js` or `gather.js` need a shell restart: gnome-shell
caches extension ES modules by URL, so disabling and re-enabling merely re-runs
`enable()` on the code already in memory.

| File | Contains |
| --- | --- |
| `extension.js` | the indicator, click routing, menu anchoring, keybindings |
| `gather.js` | window selection, the move itself, undo snapshots — no UI |
| `prefs.js` | preferences window |
