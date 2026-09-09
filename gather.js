/* Magnet — window gathering logic.
 *
 * Kept free of any UI so that the panel button, the keyboard shortcuts and the
 * menu all drive the exact same code path.
 */

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Snapshots of the most recent gather, newest gather replaces the previous one.
// Each entry records where a window was before it was moved so undo can put it
// back on the right monitor, at the right size.
let lastGather = [];

export function hasUndo() {
    return lastGather.length > 0;
}

export function clearUndo() {
    lastGather = [];
}

/* Which monitor did this click land on?
 *
 * When Multi Monitor Bar mirrors our indicator onto a secondary panel it
 * re-emits the *original* Clutter event at us, so the coordinates still point
 * at the screen that was actually clicked. Keyboard shortcuts have no event, so
 * they fall back to wherever the pointer is.
 */
export function resolveTargetMonitor(event = null) {
    let x = null;
    let y = null;

    if (event) {
        try {
            [x, y] = event.get_coords();
        } catch (_e) {
            x = null;
        }
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        try {
            [x, y] = global.get_pointer();
        } catch (_e) {
            return global.display.get_current_monitor();
        }
    }

    const monitors = Main.layoutManager.monitors;
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
            return i;
    }

    return global.display.get_current_monitor();
}

/* Windows we are willing to move.
 *
 * The skip_taskbar test is what keeps the desktop-icon windows (ding creates
 * one per monitor), docks and notification banners out of the sweep, and
 * allows_move() covers dialogs that Mutter has attached to a parent.
 */
function isGatherable(window, includeDialogs) {
    try {
        const type = window.get_window_type();
        const wanted = type === Meta.WindowType.NORMAL ||
            (includeDialogs &&
                (type === Meta.WindowType.DIALOG ||
                 type === Meta.WindowType.MODAL_DIALOG));

        if (!wanted)
            return false;
        if (window.is_skip_taskbar())
            return false;
        if (!window.allows_move())
            return false;

        return true;
    } catch (_e) {
        return false;
    }
}

function collectWindows(settings) {
    const wm = global.workspace_manager;
    const includeDialogs = settings ? settings.get_boolean('include-dialogs') : true;
    const currentOnly = settings
        ? settings.get_string('scope') === 'current-workspace'
        : false;

    const workspaces = [];
    if (currentOnly) {
        workspaces.push(wm.get_active_workspace());
    } else {
        for (let i = 0; i < wm.n_workspaces; i++)
            workspaces.push(wm.get_workspace_by_index(i));
    }

    const seen = new Set();
    const windows = [];

    for (const workspace of workspaces) {
        if (!workspace)
            continue;

        // A window that is on all workspaces is listed by every workspace.
        for (const window of workspace.list_windows()) {
            if (seen.has(window))
                continue;
            seen.add(window);

            if (isGatherable(window, includeDialogs))
                windows.push(window);
        }
    }

    return windows;
}

/* Pull every gatherable window onto `monitorIndex`.
 *
 * move_to_monitor() is the same call GNOME's own Shift+Super+Arrow binding
 * uses: it rescales the frame proportionally between the two work areas and
 * carries maximized and fullscreen state across, which matters here because the
 * laptop panel and the external display have very different logical sizes.
 * A window's workspace is untouched.
 *
 * Returns the number of windows moved.
 */
export function gatherTo(monitorIndex, settings) {
    const display = global.display;

    if (display.get_n_monitors() < 2)
        return 0;
    if (!Number.isInteger(monitorIndex) ||
        monitorIndex < 0 ||
        monitorIndex >= display.get_n_monitors())
        return 0;

    const previousFocus = display.focus_window;
    const snapshots = [];

    for (const window of collectWindows(settings)) {
        let from;
        try {
            from = window.get_monitor();
        } catch (_e) {
            continue;
        }

        if (from === monitorIndex)
            continue;

        let rect = null;
        let maximizeFlags = 0;
        let wasFullscreen = false;
        try {
            rect = window.get_frame_rect();
            maximizeFlags = window.get_maximize_flags();
            wasFullscreen = window.is_fullscreen();
        } catch (_e) {
            rect = null;
        }

        try {
            window.move_to_monitor(monitorIndex);
        } catch (e) {
            console.error(`Magnet: could not move window: ${e}`);
            continue;
        }

        snapshots.push({
            window,
            monitor: from,
            hadRect: rect !== null,
            x: rect ? rect.x : 0,
            y: rect ? rect.y : 0,
            width: rect ? rect.width : 0,
            height: rect ? rect.height : 0,
            maximizeFlags,
            wasFullscreen,
        });
    }

    lastGather = snapshots;

    // Moving windows around can shift focus. Put it back, using focus() rather
    // than activate() so we never yank the user to a different workspace.
    if (previousFocus && snapshots.length > 0) {
        try {
            if (previousFocus.get_compositor_private())
                previousFocus.focus(global.get_current_time());
        } catch (_e) {
            // The window went away mid-gather; nothing to restore focus to.
        }
    }

    return snapshots.length;
}

/* Send everything back where it came from. Windows closed since the gather are
 * skipped. Size is only restored for windows that were neither maximized nor
 * fullscreen — for those two, move_to_monitor already reapplies the state.
 */
export function undoLastGather() {
    if (lastGather.length === 0)
        return 0;

    const snapshots = lastGather;
    lastGather = [];

    let restored = 0;

    for (let i = snapshots.length - 1; i >= 0; i--) {
        const snapshot = snapshots[i];
        const window = snapshot.window;

        try {
            if (!window || !window.get_compositor_private())
                continue;

            window.move_to_monitor(snapshot.monitor);

            if (snapshot.hadRect &&
                !snapshot.wasFullscreen &&
                snapshot.maximizeFlags === 0) {
                window.move_resize_frame(false,
                    snapshot.x, snapshot.y, snapshot.width, snapshot.height);
            }

            restored++;
        } catch (e) {
            console.error(`Magnet: could not restore window: ${e}`);
        }
    }

    return restored;
}
