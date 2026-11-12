import Gio from 'gi://Gio';
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
// Longest a size change may stay 'pending' (frozen) before we ignore it.
const PENDING_MAX_US = 400 * 1000;

// Wait this long after the last accent colour change before notifying, so
// clicking through several colours gives a single notification.
const ACCENT_NOTIFY_DELAY_MS = 1500;

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
        this._pendingSince = 0;
        this._actor = null;

        this._settings = this.getSettings();
        this._animationMode = this._settings.get_string('animation-mode');
        this._debug = this._settings.get_boolean('debug');
        this._settings.connectObject('changed::animation-mode', () => {
            this._animationMode = this._settings.get_string('animation-mode');
            this._queueUpdate();
        }, 'changed::debug', () => {
            this._debug = this._settings.get_boolean('debug');
        }, this);

        // After the accent colour changes, the outline can stop showing
        // until the next login, so tell the user.
        this._accentNotifyId = 0;
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettings.connectObject('changed::accent-color',
            () => this._onAccentChanged(), this);

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
        this._settings.disconnectObject(this);
        this._settings = null;
        this._interfaceSettings.disconnectObject(this);
        this._interfaceSettings = null;
        if (this._accentNotifyId) {
            GLib.source_remove(this._accentNotifyId);
            this._accentNotifyId = 0;
        }
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

    _log(msg) {
        if (this._debug)
            console.log(`[active-window-border] ${msg}`);
    }

    _describe(win) {
        if (!win)
            return 'null';
        return `"${win.get_title()}" (${win.get_wm_class()}, mon ${win.get_monitor()})`;
    }

    _onAccentChanged() {
        this._log('accent colour changed');
        if (this._accentNotifyId)
            GLib.source_remove(this._accentNotifyId);
        this._accentNotifyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            ACCENT_NOTIFY_DELAY_MS, () => {
                this._accentNotifyId = 0;
                Main.notify('Active Window Border',
                    'Accent colour changed. Log out and back in so the ' +
                    'window outline keeps showing correctly.');
                return GLib.SOURCE_REMOVE;
            });
    }

    _onFocusChanged() {
        this._log(`focus -> ${this._describe(global.display.focus_window)}` +
            `${this._previewing ? ' [ignored: switcher open]' : ''}`);
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
        this._actor?.disconnectObject(this);
        this._actor = null;
    }

    _track(win) {
        this._log(`track ${this._describe(win)}`);
        this._untrack();
        this._animWaitStart = 0;
        this._pendingSince = 0;

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

            // Animations change these on every frame; used by 'follow' mode.
            this._actor = win.get_compositor_private();
            this._actor?.connectObject(
                'notify::scale-x', () => this._onActorAnimated(),
                'notify::scale-y', () => this._onActorAnimated(),
                'notify::translation-x', () => this._onActorAnimated(),
                'notify::translation-y', () => this._onActorAnimated(),
                'notify::opacity', () => this._onActorAnimated(),
                'destroy', () => {
                    this._actor = null;
                },
                this);
        }
        this._queueUpdate();
    }

    _onActorAnimated() {
        if (this._animationMode === 'follow')
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

    _animatedFrame(win, actor, frame) {
        // Before a size change starts, the actor is frozen showing its old
        // size: draw around the old frame. Tiling Assistant sometimes starts
        // a size change that never completes ("Error in size change
        // accounting"); don't stay on the old frame for longer than a
        // normal animation would take.
        const info = actor.__animationInfo;
        if (info && Main.wm._resizePending?.has(actor)) {
            const now = GLib.get_monotonic_time();
            if (!this._pendingSince)
                this._pendingSince = now;
            if (now - this._pendingSince < PENDING_MAX_US) {
                const r = info.oldRect;
                return {x: r.x, y: r.y, width: r.width, height: r.height};
            }
            return {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
        }
        this._pendingSince = 0;

        // The actor sits at the window's buffer rect and is drawn with
        //   origin + translation + pivot + (point - pivot) * scale.
        // Use Mutter's buffer rect (always consistent with the frame rect)
        // rather than the actor's own position, which can lag a frame
        // behind when a size-change animation starts.
        const buf = win.get_buffer_rect();
        const pivot = actor.pivot_point;
        const pivotX = pivot.x * buf.width;
        const pivotY = pivot.y * buf.height;
        const mapX = x => buf.x + actor.translation_x + pivotX +
            (x - buf.x - pivotX) * actor.scale_x;
        const mapY = y => buf.y + actor.translation_y + pivotY +
            (y - buf.y - pivotY) * actor.scale_y;

        const x1 = mapX(frame.x), x2 = mapX(frame.x + frame.width);
        const y1 = mapY(frame.y), y2 = mapY(frame.y + frame.height);

        return {
            x: Math.round(Math.min(x1, x2)),
            y: Math.round(Math.min(y1, y2)),
            width: Math.round(Math.abs(x2 - x1)),
            height: Math.round(Math.abs(y2 - y1)),
        };
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
            this._log(`hide ${this._describe(win)}: actor=${!!actor} ` +
                `minimized=${win?.minimized} visible=${actor?.visible} ` +
                `parentIsWindowGroup=${actor?.get_parent() === global.window_group}`);
            this._border.hide();
            return;
        }

        const animating = this._isAnimating(actor);
        const follow = animating && this._animationMode === 'follow';

        if (animating && !follow && !this._animationWaitExpired()) {
            this._log(`hide ${this._describe(win)}: waiting for animation`);
            this._border.hide();
            this._pollAnimation();
            return;
        }
        // Only restart the wait timer once the window really stops animating,
        // so an animation that never completes can't keep hiding the outline
        // (or keep us polling forever).
        if (!animating)
            this._animWaitStart = 0;

        // Keep re-checking while following, so the outline settles on the
        // final frame even if the last animation step sends no notification.
        if (follow && !this._animationWaitExpired())
            this._pollAnimation();

        const frame = win.get_frame_rect();
        // Where the window is drawn right now: its final frame, or (while
        // following an animation) that frame mapped through the animation.
        const rect = follow
            ? this._animatedFrame(win, actor, frame)
            : {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
        this._border.opacity = follow ? actor.opacity : 255;

        // Square corners: fullscreen, (half-)maximized, or tiled by
        // Tiling Assistant (which sets `isTiled` on the window).
        const square = win.is_fullscreen() ||
            win.maximizedHorizontally || win.maximizedVertically ||
            win.isTiled === true;

        // Would an outline drawn outside the window cross its monitor's edge
        // (and show up on a neighbouring monitor)? Decided on the final frame.
        const mon = global.display.get_monitor_geometry(win.get_monitor());
        const nearEdge =
            frame.x - BORDER < mon.x ||
            frame.y - BORDER < mon.y ||
            frame.x + frame.width + BORDER > mon.x + mon.width ||
            frame.y + frame.height + BORDER > mon.y + mon.height;

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

        if (this._debug) {
            const kids = global.window_group.get_children();
            this._log(`show ${this._describe(win)}: ` +
                `${inset ? (square ? 'inset-square' : 'inset-round') : 'outside'} ` +
                `rect=${rect.x},${rect.y} ${rect.width}x${rect.height} ` +
                `animating=${animating} follow=${follow} opacity=${this._border.opacity} ` +
                `preview=${this._previewing} borderIdx=${kids.indexOf(this._border)} ` +
                `actorIdx=${kids.indexOf(actor)}/${kids.length}`);
        }
    }
}
