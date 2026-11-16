// The island itself: one black shape that morphs between whatever it is showing. It knows
// nothing about music or notifications; it is handed a view, and grows or shrinks to fit it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * Lays every view out at its own natural size, centred at the top, whatever the island's size
 * is at the moment: as the island grows, it uncovers the view instead of squeezing it.
 */
const IslandLayout = GObject.registerClass({
    GTypeName: 'CartoucheIslandLayout',
}, class IslandLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, natW] = child.get_preferred_width(-1);
            const [, natH] = child.get_preferred_height(natW);
            const x = Math.round(box.x1 + (width - natW) / 2);
            child.allocate(Clutter.ActorBox.new(x, box.y1, x + natW, box.y1 + natH));
        }
    }
});

const GROW_MS = 460;
const SHRINK_MS = 340;
const FADE_OUT_MS = 110;
const FADE_IN_MS = 220;
const MAX_RADIUS = 26;

function animations() {
    return St.Settings.get().enable_animations;
}

export const Island = GObject.registerClass({
    GTypeName: 'CartoucheIsland',
}, class Island extends St.Widget {
    _init() {
        super._init({
            style_class: 'cartouche-island',
            reactive: true,
            track_hover: true,
            can_focus: false,
            clip_to_allocation: true,
            accessible_name: 'Cartouche',
            layout_manager: new IslandLayout(),
            // In the stage's BinLayout, alignment only counts for children that expand.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._top = 0;
        this._offset = 0;
        this._view = null;
        this._persistent = new Set();
        this._target = [0, 0];
        this._appearance = '';
        this._scale = 1;
        this.connect('notify::height', () => this._restyle());
    }

    get view() {
        return this._view;
    }

    get target() {
        return this._target;
    }

    /** Scale factor, and the gap above the island, in logical pixels. */
    setGeometry(scale, top) {
        this._scale = scale || 1;
        this._top = top;
        this._restyle();
    }

    setAppearance(name) {
        if (this._appearance)
            this.remove_style_class_name(`cartouche-${this._appearance}`);
        this._appearance = name;
        this.add_style_class_name(`cartouche-${name}`);
    }

    /** Horizontal distance from the middle of the screen, kept inside it whatever the size. */
    setOffset(offset) {
        this._offset = offset;
        this._applyOffset();
    }

    _applyOffset() {
        const room = Math.max(0, ((this.get_parent()?.width ?? 0) - this._target[0]) / 2);
        this.translation_x = Math.max(-room, Math.min(room, this._offset));
    }

    /**
     * Views that live on (the compact view, the dashboard) are hidden instead of destroyed. They
     * join the island now, so that they go with it even if they were never shown.
     */
    keep(actor) {
        this._persistent.add(actor);
        if (actor.get_parent() !== this) {
            actor.hide();
            this.add_child(actor);
        }
    }

    setView(actor, animate = true) {
        if (actor.get_parent() !== this)
            this.add_child(actor);
        if (this._view === actor) {
            this.refit(animate);
            return;
        }
        const old = this._view;
        this._view = actor;
        const smooth = animate && animations() && this.mapped;
        if (old) {
            old.remove_all_transitions();
            const done = () => {
                if (old === this._view)
                    return;
                if (this._persistent.has(old))
                    old.hide();
                else
                    old.destroy();
            };
            if (smooth)
                old.ease({opacity: 0, duration: FADE_OUT_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: done});
            else
                done();
        }
        actor.remove_all_transitions();
        actor.show();
        if (smooth) {
            actor.opacity = 0;
            actor.ease({opacity: 255, delay: old ? 70 : 0, duration: FADE_IN_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.opacity = 255;
        }
        this.refit(animate);
    }

    /** Grow or shrink to the current view's size; with a little overshoot when growing. */
    refit(animate = true) {
        const view = this._view;
        if (!view)
            return;
        const [, width] = view.get_preferred_width(-1);
        const [, height] = view.get_preferred_height(width);
        const [w0, h0] = this._target;
        if (width === w0 && height === h0)
            return;
        this._target = [width, height];
        this._applyOffset();
        if (!animate || !animations() || !this.mapped || !w0) {
            this.remove_transition('width');
            this.remove_transition('height');
            this.set_size(width, height);
            return;
        }
        const grow = width * height >= w0 * h0;
        this.ease({
            width,
            height,
            duration: grow ? GROW_MS : SHRINK_MS,
            mode: grow ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUINT,
        });
    }

    /**
     * A pill when it is thin; softer corners as it grows. The margin lives here too: St sets an
     * actor's margins from its style, so a margin set in code would not survive a restyle.
     */
    _restyle() {
        const radius = Math.min(this.height / 2, MAX_RADIUS * this._scale) / this._scale;
        this.style = `border-radius: ${Math.max(0, radius).toFixed(1)}px; margin-top: ${this._top}px;`;
    }

    /** A short nudge sideways: "no". */
    shake() {
        if (!animations())
            return;
        this.remove_transition('translation-x');
        this._applyOffset();
        const base = this.translation_x;
        const steps = [6, -5, 3, -2, 0];
        const next = i => {
            if (i >= steps.length)
                return;
            this.ease({translation_x: base + steps[i] * this._scale, duration: 55, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => next(i + 1)});
        };
        next(0);
    }
});
