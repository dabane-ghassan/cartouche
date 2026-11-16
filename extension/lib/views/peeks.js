// What the island shows for a moment: a volume or brightness level, a notification, and the
// small announcements (charging, headphones, Do Not Disturb, a new song).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {vbox} from '../compat.js';
import {Artwork, Bars, Level, iconButton} from './widgets.js';

const HUD_ICONS = {
    volume: 'audio-volume-high-symbolic',
    microphone: 'audio-input-microphone-symbolic',
    brightness: 'display-brightness-symbolic',
    keyboard: 'keyboard-brightness-symbolic',
    other: 'dialog-information-symbolic',
};

function label(styleClass, params = {}) {
    const l = new St.Label({style_class: styleClass, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

/** Volume, brightness, keyboard light, microphone, and any other OSD GNOME shows. */
export class HudView {
    constructor(style, showPercent, height) {
        this.actor = new St.BoxLayout({style_class: 'cartouche-hud'});
        this.actor.style = `height: ${height}px;`;
        this._icon = new St.Icon({style_class: 'cartouche-hud-icon', y_align: Clutter.ActorAlign.CENTER});
        this._text = label('cartouche-hud-label', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._level = new Level(style);
        this._percent = new St.Label({style_class: 'cartouche-hud-percent', y_align: Clutter.ActorAlign.CENTER});
        this._showPercent = showPercent;
        this.actor.add_child(this._icon);
        this.actor.add_child(this._text);
        this.actor.add_child(this._level);
        this.actor.add_child(this._percent);
        this.kind = null;
    }

    update({kind, icon, label: text, level, maxLevel}) {
        this.kind = kind;
        if (icon)
            this._icon.gicon = icon;
        else
            this._icon.gicon = new Gio.ThemedIcon({name: HUD_ICONS[kind] ?? HUD_ICONS.other});
        const hasLevel = level !== null && level !== undefined && Number.isFinite(Number(level));
        let max = Number(maxLevel);
        if (!Number.isFinite(max) || max <= 0)
            max = 1;
        let value = hasLevel ? Number(level) : 0;
        if (value > max * 1.01 && value <= 100)
            value /= 100;       // an older settings daemon reporting percent
        this._level.visible = hasLevel;
        this._text.visible = !hasLevel || (!!text && kind === 'other');
        this._text.text = text ?? '';
        this._percent.visible = hasLevel && this._showPercent;
        if (hasLevel) {
            this._level.setValue(value / max, value > 1.001);
            this._percent.text = `${Math.round(value * 100)}%`;
        }
        if (hasLevel)
            this.actor.remove_style_pseudo_class('text');
        else
            this.actor.add_style_pseudo_class('text');
    }
}

/**
 * A small announcement:
 *   lead: {icon, tint} or {art: uri}
 *   title, subtitle
 *   trail: {text} | {bars: accent} | {ring: percent} | null
 */
export class ActivityView {
    constructor(height) {
        this.actor = new St.BoxLayout({style_class: 'cartouche-activity'});
        this.actor.style = `height: ${height}px;`;
        this._leadIcon = new St.Icon({style_class: 'cartouche-activity-icon', y_align: Clutter.ActorAlign.CENTER});
        this._leadBin = new St.Bin({style_class: 'cartouche-activity-lead', child: this._leadIcon, y_align: Clutter.ActorAlign.CENTER});
        this._art = new Artwork('cartouche-art-activity');
        const text = vbox({style_class: 'cartouche-activity-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('cartouche-title');
        this._subtitle = label('cartouche-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);
        this._trailText = new St.Label({style_class: 'cartouche-activity-trail', y_align: Clutter.ActorAlign.CENTER});
        this._bars = new Bars('cartouche-bars-activity');
        this.actor.add_child(this._leadBin);
        this.actor.add_child(this._art);
        this.actor.add_child(text);
        this.actor.add_child(this._trailText);
        this.actor.add_child(this._bars);
    }

    update({lead, title, subtitle, trail}) {
        const art = lead && 'art' in lead;
        this._art.visible = art;
        this._leadBin.visible = !art;
        if (art) {
            this._art.setArt(lead.art);
        } else {
            this._leadIcon.icon_name = lead?.icon ?? 'dialog-information-symbolic';
            this._leadBin.style = lead?.tint ? `background-color: ${lead.tint};` : null;
        }
        this._title.text = title ?? '';
        this._subtitle.text = subtitle ?? '';
        this._subtitle.visible = !!subtitle;
        this._trailText.visible = !!trail && 'text' in trail;
        this._trailText.text = trail?.text ?? '';
        this._trailText.style = trail?.color ? `color: ${trail.color};` : null;
        const bars = !!trail && 'bars' in trail;
        this._bars.visible = bars;
        this._bars.setColor(bars ? trail.bars : null);
        this._bars.setPlaying(bars);
    }
}

/** A notification, in the island instead of a banner. */
export class NotificationView {
    constructor(notification, {icon, app, title, body, actions, onClose}) {
        this.notification = notification;
        this.actor = vbox({style_class: 'cartouche-notification'});
        const row = new St.BoxLayout({style_class: 'cartouche-notification-row'});
        const iconBin = new St.Bin({style_class: 'cartouche-notification-icon-bin', y_align: Clutter.ActorAlign.START});
        iconBin.set_child(new St.Icon({
            style_class: 'cartouche-notification-icon',
            gicon: icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'}),
        }));
        const text = vbox({style_class: 'cartouche-notification-text', x_expand: true});
        const header = new St.BoxLayout({style_class: 'cartouche-notification-header'});
        header.add_child(label('cartouche-caption', {text: app || 'Notification', x_expand: true}));
        header.add_child(new St.Label({style_class: 'cartouche-caption', text: 'now'}));
        this._title = label('cartouche-title', {text: title});
        this._body = new St.Label({style_class: 'cartouche-body', text: trim(body, 140)});
        this._body.clutter_text.line_wrap = true;
        this._body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._body.visible = !!body;
        text.add_child(header);
        text.add_child(this._title);
        text.add_child(this._body);
        const close = iconButton('window-close-symbolic', 'cartouche-close', onClose, 'Close');
        close.y_align = Clutter.ActorAlign.START;
        row.add_child(iconBin);
        row.add_child(text);
        row.add_child(close);
        this.actor.add_child(row);
        if (actions.length) {
            const buttons = new St.BoxLayout({style_class: 'cartouche-actions', x_expand: true});
            for (const action of actions.slice(0, 3)) {
                const button = new St.Button({style_class: 'cartouche-action', label: action.label, x_expand: true, can_focus: true});
                button.connect('clicked', () => action.run());
                buttons.add_child(button);
            }
            this.actor.add_child(buttons);
        }
    }

    update({title, body}) {
        this._title.text = title;
        this._body.text = trim(body, 140);
        this._body.visible = !!body;
    }
}

function trim(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
