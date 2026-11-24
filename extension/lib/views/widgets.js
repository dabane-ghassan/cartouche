// Small pieces the island's views are made of.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

/** A rounded square of album art, with a note icon until the picture arrives. */
export const Artwork = GObject.registerClass({
    GTypeName: 'CartoucheArtwork',
}, class Artwork extends St.Bin {
    _init(styleClass) {
        super._init({
            style_class: `cartouche-art ${styleClass}`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._placeholder = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'cartouche-art-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._placeholder);
        this._uri = null;
        this._size = 0;
    }

    /** Size in logical pixels; 0 leaves it to the stylesheet. */
    setSize(size) {
        if (size === this._size)
            return;
        this._size = size;
        this._restyle();
    }

    setArt(uri) {
        if (uri === this._uri)
            return;
        this._uri = uri;
        this._placeholder.visible = !uri;
        this._restyle();
    }

    _restyle() {
        let style = '';
        if (this._size)
            style += `width: ${this._size}px; height: ${this._size}px;`;
        // St draws a background image inside the rounded corners, as GNOME does for avatars.
        if (this._uri)
            style += `background-image: url("${this._uri}"); background-size: cover;`;
        this.style = style || null;
    }
});

/** The little bouncing bars that say "this is playing". */
export const Bars = GObject.registerClass({
    GTypeName: 'CartoucheBars',
}, class Bars extends St.BoxLayout {
    _init(styleClass = '') {
        super._init({
            style_class: `cartouche-bars ${styleClass}`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._bars = [];
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({style_class: 'cartouche-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = 0.3;
            this.add_child(bar);
            this._bars.push(bar);
        }
        this._timer = 0;
        this._playing = false;
        this._color = null;
        this._height = 0;
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._stop());
    }

    setColor(css) {
        if (css === this._color)
            return;
        this._color = css;
        this._restyle();
    }

    /** Height in logical pixels; 0 leaves it to the stylesheet. */
    setHeight(height) {
        if (height === this._height)
            return;
        this._height = height;
        this.style = height ? `height: ${height}px;` : null;
        this._restyle();
    }

    _restyle() {
        let style = '';
        if (this._height)
            style += `height: ${this._height}px;`;
        if (this._color)
            style += `background-color: ${this._color};`;
        for (const bar of this._bars)
            bar.style = style || null;
    }

    setPlaying(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        if (this._playing && this.mapped && St.Settings.get().enable_animations)
            this._start();
        else
            this._stop(true);
    }

    _start() {
        if (this._timer)
            return;
        this._step();
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, 170, () => {
            this._step();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _step() {
        this._bars.forEach((bar, i) => {
            const centre = i === 1 || i === 2 ? 0.25 : 0;
            bar.ease({
                scale_y: Math.min(1, 0.22 + centre + Math.random() * 0.75),
                duration: 170,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        });
    }

    _stop(rest = false) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (rest) {
            for (const bar of this._bars) {
                bar.remove_all_transitions();
                bar.ease({scale_y: 0.3, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        }
    }
});

/** A level, as a bar or as a row of segments (the classic HUD look). */
export const Level = GObject.registerClass({
    GTypeName: 'CartoucheLevel',
}, class Level extends St.Widget {
    _init(style = 'bar') {
        super._init({
            style_class: `cartouche-level cartouche-level-${style}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._style = style;
        this._value = 0;
        this._overdrive = false;
        if (style === 'segments') {
            this._box = new St.BoxLayout({style_class: 'cartouche-segments', x_expand: true});
            this._segments = [];
            for (let i = 0; i < 16; i++) {
                const seg = new St.Widget({style_class: 'cartouche-segment', x_expand: true});
                this._box.add_child(seg);
                this._segments.push(seg);
            }
            this.add_child(this._box);
        } else {
            // The fill spans the bar and is scaled, so a change never needs a new layout.
            this._fill = new St.Widget({style_class: 'cartouche-level-fill', x_expand: true, y_expand: true});
            this._fill.set_pivot_point(0, 0.5);
            this._fill.scale_x = 0;
            this.add_child(this._fill);
        }
    }

    setValue(fraction, overdrive = false, animate = true) {
        this._value = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
        this._overdrive = overdrive;
        if (this._segments) {
            const lit = Math.round(this._value * this._segments.length);
            this._segments.forEach((seg, i) => {
                if (i < lit)
                    seg.add_style_pseudo_class('lit');
                else
                    seg.remove_style_pseudo_class('lit');
            });
        } else {
            if (overdrive)
                this._fill.add_style_pseudo_class('overdrive');
            else
                this._fill.remove_style_pseudo_class('overdrive');
            this._layoutFill(animate);
        }
    }

    _layoutFill(animate) {
        if (!animate || !this.mapped || !St.Settings.get().enable_animations) {
            this._fill.remove_transition('scale-x');
            this._fill.scale_x = this._value;
            return;
        }
        this._fill.ease({scale_x: this._value, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});

/** The track position: elapsed, a bar you can click or drag to seek, remaining. */
export const Progress = GObject.registerClass({
    GTypeName: 'CartoucheProgress',
}, class Progress extends St.BoxLayout {
    _init(onSeek) {
        super._init({style_class: 'cartouche-progress', x_expand: true});
        this._onSeek = onSeek;
        this._elapsed = new St.Label({style_class: 'cartouche-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'cartouche-time', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({
            style_class: 'cartouche-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({style_class: 'cartouche-track-fill', x_expand: true, y_expand: true});
        this._fill.set_pivot_point(0, 0.5);
        this._fill.scale_x = 0;
        this._track.add_child(this._fill);
        this.add_child(this._elapsed);
        this.add_child(this._track);
        this.add_child(this._remaining);
        this._fraction = 0;
        this._dragging = false;
        this._track.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this._seekable)
                return Clutter.EVENT_PROPAGATE;
            this._dragging = true;
            this._seekTo(event, false);
            return Clutter.EVENT_STOP;
        });
        this._track.connect('motion-event', (_a, event) => {
            if (this._dragging)
                this._seekTo(event, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this._track.connect('button-release-event', (_a, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            this._dragging = false;
            this._seekTo(event, true);
            return Clutter.EVENT_STOP;
        });
        this._track.connect('leave-event', () => {
            this._dragging = false;
        });
    }

    _seekTo(event, commit) {
        const [x] = event.get_coords();
        const [tx] = this._track.get_transformed_position();
        const fraction = Math.min(1, Math.max(0, (x - tx) / Math.max(1, this._track.width)));
        this._fraction = fraction;
        this._layoutFill();
        if (commit)
            this._onSeek(fraction);
    }

    /** Position and length in microseconds; a length of 0 is a live stream. */
    update(position, length, seekable) {
        this._seekable = seekable && length > 0;
        if (this._seekable)
            this._track.add_style_pseudo_class('seekable');
        else
            this._track.remove_style_pseudo_class('seekable');
        this._elapsed.text = formatTime(position);
        this._remaining.text = length > 0 ? `-${formatTime(Math.max(0, length - position))}` : 'Live';
        if (!this._dragging) {
            this._fraction = length > 0 ? Math.min(1, position / length) : 0;
            this._layoutFill();
        }
    }

    _layoutFill() {
        this._fill.scale_x = this._fraction;
    }
});

export function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function iconButton(iconName, styleClass, onClick, accessibleName = '') {
    const button = new St.Button({
        style_class: `cartouche-button ${styleClass}`,
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}
