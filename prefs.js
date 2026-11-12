import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = [
    ['follow', 'Follow the animation'],
    ['wait', 'Wait until it finishes'],
];

export default class ActiveWindowBorderPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Animations',
            description: 'What the outline does while a window opens, is ' +
                'unminimized, or is maximized/tiled (e.g. Super+arrows).',
        });

        const row = new Adw.ComboRow({
            title: 'During window animations',
            model: Gtk.StringList.new(MODES.map(([, label]) => label)),
        });
        const sync = () => {
            const idx = MODES.findIndex(([id]) => id === settings.get_string('animation-mode'));
            row.selected = Math.max(idx, 0);
        };
        sync();
        row.connect('notify::selected', () => {
            settings.set_string('animation-mode', MODES[row.selected][0]);
        });
        settings.connect('changed::animation-mode', sync);

        group.add(row);
        page.add(group);
        window.add(page);
    }
}
