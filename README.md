# Active Window Border

A small GNOME Shell extension that outlines the focused window in your **system accent colour**, so you can always see which window you're working in.

Unlike the focus hints in Tiling Assistant or Tiling Shell, it also works on **maximized and fullscreen windows**.

## How it looks

- **Normal windows:** a 3px outline just outside the window, with rounded corners that match libadwaita windows (15px radius).
- **Maximized / fullscreen windows:** the screen edges leave no room outside the window, so the outline is drawn just inside its edges, with square corners.
- **Colour:** follows the accent colour in *Settings → Appearance* automatically (via `-st-accent-color`).

## Requirements

GNOME Shell 50 (tested on Ubuntu 26.04, Wayland).

## Install

```bash
git clone https://github.com/temponi8/active-window-border.git \
  ~/.local/share/gnome-shell/extensions/active-window-border@local
```

Log out and back in (Wayland only loads new extensions at login), then:

```bash
gnome-extensions enable active-window-border@local
```

If you use Tiling Assistant's focus hint, turn it off to avoid a double outline:

```bash
gsettings set org.gnome.shell.extensions.tiling-assistant focus-hint 0
```

## Customize

- **Thickness:** change `BORDER` in `extension.js` *and* the `3px` in `stylesheet.css`.
- **Corner roundness:** in `stylesheet.css`, set `border-radius` to *window corner radius + border width*.

CSS changes apply after disabling and re-enabling the extension (wait a few seconds between the two). JavaScript changes need a log out and back in.

## License

GPL-2.0-or-later
