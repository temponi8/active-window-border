import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BORDER = 3; // keep in sync with stylesheet.css

const ALLOWED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export default class ActiveWindowBorder extends Extension {
    enable() {
        this._window = null;
        this._laterId = 0;

        this._border = new St.Widget({
            style_class: 'active-window-border',
            reactive: false,
        });
        this._border.hide();
        global.window_group.add_child(this._border);

        global.display.connectObject(
            'notify::focus-window', () => this._track(),
            'restacked', () => this._queueUpdate(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._track(),
            this);

        this._track();
    }

    disable() {
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._untrack();
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        this._border.destroy();
        this._border = null;
    }

    _untrack() {
        this._window?.disconnectObject(this);
        this._window = null;
    }

    _track() {
        this._untrack();

        const win = global.display.focus_window;
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

    _update() {
        const win = this._window;
        const actor = win?.get_compositor_private();

        if (!win || !actor || win.minimized || !actor.visible ||
            actor.get_parent() !== global.window_group) {
            this._border.hide();
            return;
        }

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

        if (square || nearEdge) {
            this._border.add_style_class_name(square ? 'inset-square' : 'inset-round');
            this._border.set_position(rect.x, rect.y);
            this._border.set_size(rect.width, rect.height);
            global.window_group.set_child_above_sibling(this._border, actor);
        } else {
            this._border.set_position(rect.x - BORDER, rect.y - BORDER);
            this._border.set_size(rect.width + 2 * BORDER, rect.height + 2 * BORDER);
            global.window_group.set_child_below_sibling(this._border, actor);
        }
        this._border.show();
    }
}
