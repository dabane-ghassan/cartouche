// The island at rest, in the top bar: the clock, and what is playing around it.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Artwork, Bars} from './widgets.js';

export class CompactView {
    constructor() {
        this.actor = new St.BoxLayout({style_class: 'cartouche-compact'});
        this._art = new Artwork('cartouche-art-compact');
        this._dot = new St.Widget({style_class: 'cartouche-dot', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._label = new St.Label({style_class: 'cartouche-clock', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._bars = new Bars('cartouche-bars-compact');
        this.actor.add_child(this._art);
        this.actor.add_child(this._dot);
        this.actor.add_child(this._label);
        this.actor.add_child(this._bars);
        this._height = 0;
    }

    /** Height in logical pixels, from the top bar. */
    setHeight(height) {
        if (height === this._height)
            return;
        this._height = height;
        this.actor.style = `height: ${height}px;`;
        // Everything inside stays inside: artwork and bars are sized from the pill.
        this._art.setSize(Math.max(8, Math.round(height - 8)));
        this._bars.setHeight(Math.max(6, Math.min(14, Math.round(height - 10))));
    }

    /**
     * text: the clock, or the title
     * dot: unread notifications
     * media: null, or {uri, accent, playing}
     * title: whether the text is a track title (it gets a width limit)
     * bars: whether the bars fit (false on a crowded top bar)
     */
    update({text, dot, media, title, bars = true, wide = false}) {
        this._label.text = text;
        const withMedia = !!media;
        this._art.visible = withMedia;
        this._bars.visible = withMedia && bars;
        this._dot.visible = !!dot && !withMedia;
        if (withMedia) {
            this._art.setArt(media.uri);
            this._bars.setColor(media.accent);
            this._bars.setPlaying(media.playing);
            this.actor.add_style_pseudo_class('media');
        } else {
            this._bars.setPlaying(false);
            this.actor.remove_style_pseudo_class('media');
        }
        if (title)
            this._label.add_style_class_name('cartouche-compact-title');
        else
            this._label.remove_style_class_name('cartouche-compact-title');
        if (wide)
            this._label.add_style_class_name('cartouche-compact-wide');
        else
            this._label.remove_style_class_name('cartouche-compact-wide');
    }
}
