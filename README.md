# Active Window Border

A small GNOME Shell extension that outlines the focused window in your **system accent colour**, so you can always see which window you're working in.

Unlike the focus hints in Tiling Assistant or Tiling Shell, it also works on **tiled, maximized and fullscreen windows**. Windows tiled by Tiling Assistant are detected automatically.

## How it looks

- **Free-floating windows:** a 3px outline just outside the window, with rounded corners that match libadwaita windows (15px radius).
- **Tiled (half/quarter screen), maximized or fullscreen windows:** these have square corners, so the outline is a square box drawn just inside the window's edges. It never leaves the window's own area, so it won't show up on a neighbouring monitor.
- **Free windows touching a monitor edge:** drawn just inside the window with rounded corners, so the outline doesn't spill onto the next monitor.
- **Fullscreen windows:** while a fullscreen window is open, GNOME normally sends it straight to the screen (direct scanout), and while it does, the outline can stop being drawn, even on another monitor. While the outline is visible, the extension turns that off, the same way GNOME does for its own popups. This can cost a little performance in fullscreen games and videos.
- **Alt+Tab / Super+Tab:** while the switcher is open, the outline moves to the selected window and is drawn above all other windows, so you can see where it is even if it's covered.
- **Animations:** when a window opens, is unminimized, or is maximized/tiled (e.g. Super+arrows), the outline follows the animation (default), or optionally waits for it to finish before appearing. Choose in the extension's preferences.
- **Colour:** follows the accent colour in *Settings → Appearance* automatically (via `-st-accent-color`).

## Requirements

GNOME Shell 50 (tested on Ubuntu 26.04, Wayland).

## Install

```bash
git clone https://github.com/temponi8/active-window-border.git \
  ~/.local/share/gnome-shell/extensions/active-window-border@temponi8.github.io
```

Compile the settings schema:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/active-window-border@temponi8.github.io/schemas
```

Log out and back in (Wayland only loads new extensions at login), then:

```bash
gnome-extensions enable active-window-border@temponi8.github.io
```

If you use Tiling Assistant's focus hint, turn it off to avoid a double outline:

```bash
gsettings set org.gnome.shell.extensions.tiling-assistant focus-hint 0
```

## Preferences

Open with `gnome-extensions prefs active-window-border@temponi8.github.io` (or from the Extensions app):

- **During window animations:** *Follow the animation* (default) or *Wait until it finishes*.

For troubleshooting, turn on debug logging and watch the journal:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/active-window-border@temponi8.github.io/schemas \
  set org.gnome.shell.extensions.active-window-border debug true
journalctl --user -f -g active-window-border
```

## Customize

- **Thickness:** change `BORDER` in `extension.js` *and* the `3px` in `stylesheet.css`.
- **Corner roundness:** in `stylesheet.css`, set the main `border-radius` to *window corner radius + border width*, and `.inset-round` to the window corner radius.

CSS changes apply after disabling and re-enabling the extension (wait a few seconds between the two). JavaScript changes need a log out and back in.

## License

GPL-2.0-or-later
