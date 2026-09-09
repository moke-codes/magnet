# Magnet

Click the panel icon and every open window is pulled onto the screen you
clicked on. Click the icon on your laptop panel, windows come to the laptop;
click it on the external monitor's panel, they go there instead.

Windows keep the workspace they are on — only their monitor changes.

## Why this is a GNOME Shell extension and not a tray app

Under Wayland, no process may move another application's windows. The usual
tools (`wmctrl`, `xdotool`) only ever worked because X11 let any client
reposition any window, and that hole is closed. The only code allowed to move
windows is code running inside the compositor, which on GNOME means an
extension. Being an extension also means it starts with the session, with no
autostart entry to maintain.

## How the per-screen click works

The button is added once, to `Main.panel`. The
[Multi Monitor Bar](https://github.com/FrederykAbryan/multi-monitors-bar_fapv2)
extension — the thing that puts a top bar on every screen — mirrors every panel
indicator onto the secondary panels automatically, and when you click one of
those mirrors it re-emits the original Clutter event at the real indicator. That
event still carries the coordinates of the actual click, which is how a click on
screen 2 is told apart from a click on screen 1.

Two details of that mirroring are load-bearing, and both are commented in
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

If Multi Monitor Bar is ever removed, the icon only appears on the primary
panel and clicking it always gathers to the primary screen. The keyboard
shortcut keeps working correctly in that case, because it uses the pointer's
position rather than the click's.

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
state across, which matters when the screens differ as much as a 1536×960
laptop panel and a 2560×1440 external display.

## Preferences

- **Windows to gather** — all workspaces (default) or only the current one.
- **Include dialog windows** — on by default.
- **Keyboard shortcuts** — rebindable; must include Ctrl, Alt or Super.

## Install

```bash
./install.sh
```

This symlinks the checkout into `~/.local/share/gnome-shell/extensions/magnet@moke`,
compiles the schema and enables the extension, so later edits here are live.

Because this is a Wayland session, gnome-shell cannot be restarted in place. If
the extension does not come up `ACTIVE`, log out and back in once.

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

Changes to `extension.js` or `gather.js` need a full log out and back in:
gnome-shell caches extension ES modules by URL, so disabling and re-enabling
re-runs `enable()` on the code already in memory, and Wayland has no in-place
shell restart.

| File | Contains |
| --- | --- |
| `extension.js` | the indicator, click routing, menu anchoring, keybindings |
| `gather.js` | window selection, the move itself, undo snapshots — no UI |
| `prefs.js` | preferences window |

## Requirements

GNOME Shell 50 (developed against Ubuntu 26.04, Mutter 18). Multi Monitor Bar
is optional but needed for the per-screen click; see above.
