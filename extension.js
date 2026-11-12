import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const BORDER = 3; // keep in sync with stylesheet.css

// Poll interval while a window animation runs, and the longest we'll wait.
const ANIMATION_POLL_MS = 30;
const ANIMATION_MAX_WAIT_US = 1000 * 1000;

const ALLOWED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export default class ActiveWindowBorder extends Extension {
    enable() {
        this._window = null;
        this._laterId = 0;
        this._previewing = false;
        this._animPollId = 0;
        this._animWaitStart = 0;

        this._border = new St.Widget({
            style_class: 'active-window-border',
            reactive: false,
        });
        this._border.hide();
        global.window_group.add_child(this._border);

        global.display.connectObject(
            'notify::focus-window', () => this._onFocusChanged(),
            'restacked', () => this._queueUpdate(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onFocusChanged(),
            this);
        // Window animations (open, unminimize, maximize/tile): re-check so the
        // outline waits for them to finish.
        global.window_manager.connectObject(
            'map', () => this._queueUpdate(),
            'unminimize', () => this._queueUpdate(),
            'size-change', () => this._queueUpdate(),
            'size-changed', () => this._queueUpdate(),
            this);

        // Follow the selection in the Alt+Tab / Super+Tab switchers.
        const ext = this;
        this._injections = new InjectionManager();
        for (const klass of [AltTab.WindowSwitcherPopup, AltTab.AppSwitcherPopup]) {
            this._injections.overrideMethod(klass.prototype, '_select',
                original => function (...args) {
                    original.apply(this, args);
                    ext._onSwitcherSelect(this);
                });
        }

        this._track(global.display.focus_window);
    }

    disable() {
        this._injections.clear();
        this._injections = null;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        if (this._animPollId) {
            GLib.source_remove(this._animPollId);
            this._animPollId = 0;
        }
        this._untrack();
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        this._border.destroy();
        this._border = null;
    }

    _onFocusChanged() {
        // While the switcher is open the outline follows its selection.
        if (!this._previewing)
            this._track(global.display.focus_window);
    }

    _onSwitcherSelect(popup) {
        if (!this._border)
            return;

        let win = null;
        try {
            const item = popup._items[popup._selectedIndex];
            if (popup instanceof AltTab.WindowSwitcherPopup)
                win = item?.window ?? null;
            else
                win = item?.cachedWindows[Math.max(popup._currentWindow, 0)] ?? null;
        } catch (e) {
            console.warn(`active-window-border: ${e}`);
        }

        if (!popup._activeWindowBorderHooked) {
            popup._activeWindowBorderHooked = true;
            popup.connect('destroy', () => {
                if (!this._border)
                    return;
                this._previewing = false;
                this._track(global.display.focus_window);
            });
        }

        this._previewing = true;
        this._track(win);
    }

    _untrack() {
        this._window?.disconnectObject(this);
        this._window = null;
    }

    _track(win) {
        this._untrack();
        this._animWaitStart = 0;

        if (win && ALLOWED_TYPES.includes(win.get_window_type())) {
            this._window = win;
            win.connectObject(
                'position-changed', () => this._queueUpdate(),
                'size-changed', () => this._queueUpdate(),
                'notify::fullscreen', () => this._queueUpdate(),
                'notify::maximized-horizontally', () => this._queueUpdate(),
                'notify::maximized-vertically', () => this._queueUpdate(),
                'notify::minimized', () => this._queueUpdate(),
                'unmanaging', () => {
                    this._untrack();
                    this._queueUpdate();
                },
                this);
        }
        this._queueUpdate();
    }

    _queueUpdate() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterId = 0;
                this._update();
                return GLib.SOURCE_REMOVE;
            });
    }

    _isAnimating(actor) {
        // GNOME Shell's window animations (Tiling Assistant reuses the
        // size-change one for Super+arrow tiling).
        const wm = Main.wm;
        return !!actor.__animationInfo ||
            !!wm._mapping?.has(actor) ||
            !!wm._unminimizing?.has(actor) ||
            !!wm._resizing?.has(actor) ||
            !!wm._resizePending?.has(actor);
    }

    _animationWaitExpired() {
        const now = GLib.get_monotonic_time();
        if (!this._animWaitStart)
            this._animWaitStart = now;
        return now - this._animWaitStart > ANIMATION_MAX_WAIT_US;
    }

    _pollAnimation() {
        if (this._animPollId)
            return;
        this._animPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            ANIMATION_POLL_MS, () => {
                this._animPollId = 0;
                this._queueUpdate();
                return GLib.SOURCE_REMOVE;
            });
    }

    _update() {
        const win = this._window;
        const actor = win?.get_compositor_private();

        if (!win || !actor || win.minimized || !actor.visible ||
            actor.get_parent() !== global.window_group) {
            this._border.hide();
            return;
        }

        if (this._isAnimating(actor) && !this._animationWaitExpired()) {
            this._border.hide();
            this._pollAnimation();
            return;
        }
        this._animWaitStart = 0;

        const rect = win.get_frame_rect();

        // Square corners: fullscreen, (half-)maximized, or tiled by
        // Tiling Assistant (which sets `isTiled` on the window).
        const square = win.is_fullscreen() ||
            win.maximizedHorizontally || win.maximizedVertically ||
            win.isTiled === true;

        // Would an outline drawn outside the window cross its monitor's edge
        // (and show up on a neighbouring monitor)?
        const mon = global.display.get_monitor_geometry(win.get_monitor());
        const nearEdge =
            rect.x - BORDER < mon.x ||
            rect.y - BORDER < mon.y ||
            rect.x + rect.width + BORDER > mon.x + mon.width ||
            rect.y + rect.height + BORDER > mon.y + mon.height;

        this._border.remove_style_class_name('inset-square');
        this._border.remove_style_class_name('inset-round');

        const inset = square || nearEdge;
        if (inset) {
            this._border.add_style_class_name(square ? 'inset-square' : 'inset-round');
            this._border.set_position(rect.x, rect.y);
            this._border.set_size(rect.width, rect.height);
        } else {
            this._border.set_position(rect.x - BORDER, rect.y - BORDER);
            this._border.set_size(rect.width + 2 * BORDER, rect.height + 2 * BORDER);
        }

        if (this._previewing) {
            // Switcher open: show the outline above every window, so the
            // selected window can be found even when it's covered.
            global.window_group.set_child_above_sibling(this._border, null);
        } else if (inset) {
            global.window_group.set_child_above_sibling(this._border, actor);
        } else {
            global.window_group.set_child_below_sibling(this._border, actor);
        }
        this._border.show();
    }
}
