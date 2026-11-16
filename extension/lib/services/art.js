// Album art: fetched once, kept in ~/.cache/cartouche/art under a name made from its contents
// (so a player reusing one file name for every cover still shows the right one), and the colour
// the visualiser takes from it.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const KEEP = 48;
const MAX_BYTES = 8 * 1024 * 1024;

function loadFile(file, cancellable) {
    return new Promise(resolve => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                resolve(contents.length && contents.length <= MAX_BYTES ? new GLib.Bytes(contents) : null);
            } catch (_e) {
                resolve(null);
            }
        });
    });
}

function saveFile(file, bytes, cancellable) {
    return new Promise(resolve => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve(true);
                } catch (_e) {
                    resolve(false);
                }
            });
    });
}

/** A lively, readable colour from a picture, as 'rgb(r, g, b)'; null if it cannot be read. */
export function accentOf(path) {
    let pixbuf;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, false);
    } catch (_e) {
        return null;
    }
    const px = pixbuf.get_pixels();
    const n = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    let r = 0, g = 0, b = 0, total = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            const [pr, pg, pb] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            const sat = max ? (max - min) / max : 0;
            const weight = 0.04 + sat * sat * max;     // colourful, bright pixels count most
            r += pr * weight;
            g += pg * weight;
            b += pb * weight;
            total += weight;
        }
    }
    if (!total)
        return null;
    let [h, s, l] = rgbToHsl(r / total, g / total, b / total);
    s = s < 0.12 ? s : Math.min(0.9, Math.max(0.45, s * 1.15));
    l = Math.min(0.74, Math.max(0.6, l));
    const [rr, gg, bb] = hslToRgb(h, s, l).map(v => Math.round(v * 255));
    return `rgb(${rr}, ${gg}, ${bb})`;
}

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (!s)
        return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

export class ArtCache {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'cartouche', 'art']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        this._cancellable = new Gio.Cancellable();
        this._session = null;
        this._known = new Map();        // url -> {uri, path, accent}
        this._pending = new Map();      // url -> Promise
    }

    /** What is already known about a picture, without waiting. */
    peek(url) {
        return this._known.get(url) ?? null;
    }

    /** Resolves to {uri, path, accent}, or null when the picture cannot be had. */
    fetch(url) {
        if (!url)
            return Promise.resolve(null);
        if (this._known.has(url))
            return Promise.resolve(this._known.get(url));
        if (this._pending.has(url))
            return this._pending.get(url);
        const promise = this._load(url).catch(() => null).then(art => {
            this._pending.delete(url);
            if (art && !this._cancellable.is_cancelled()) {
                this._known.set(url, art);
                if (this._known.size > KEEP)
                    this._known.delete(this._known.keys().next().value);
            }
            return art;
        });
        this._pending.set(url, promise);
        return promise;
    }

    async _load(url) {
        const scheme = (GLib.Uri.peek_scheme(url) ?? '').toLowerCase();
        let bytes = null;
        if (scheme === 'file')
            bytes = await loadFile(Gio.File.new_for_uri(url), this._cancellable);
        else if (scheme === 'http' || scheme === 'https')
            bytes = await this._download(url);
        else if (!scheme && url.startsWith('/'))
            bytes = await loadFile(Gio.File.new_for_path(url), this._cancellable);
        if (!bytes || this._cancellable.is_cancelled())
            return null;
        const sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        const path = GLib.build_filenamev([this._dir, sum]);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null) && !await saveFile(file, bytes, this._cancellable))
            return null;
        const accent = accentOf(path);
        if (accent === null) {
            file.delete_async(GLib.PRIORITY_LOW, null, (f, res) => {   // not a picture we can read
                try {
                    f.delete_finish(res);
                } catch (_e) {
                    // already gone
                }
            });
            return null;
        }
        this._prune();
        return {uri: file.get_uri(), path, accent};
    }

    _download(url) {
        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch (_e) {
            return Promise.resolve(null);
        }
        if (!message)
            return Promise.resolve(null);
        this._session ??= new Soup.Session({timeout: 15, user_agent: 'Cartouche (GNOME Shell extension)'});
        return new Promise(resolve => {
            this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const ok = message.get_status() === Soup.Status.OK;
                    resolve(ok && bytes.get_size() > 0 && bytes.get_size() <= MAX_BYTES ? bytes : null);
                } catch (_e) {
                    resolve(null);
                }
            });
        });
    }

    /** Keep the newest pictures only. */
    _prune() {
        if (this._pruning)
            return;
        this._pruning = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
            this._pruning = 0;
            try {
                const dir = Gio.File.new_for_path(this._dir);
                const iter = dir.enumerate_children('standard::name,time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                const files = [];
                let info;
                while ((info = iter.next_file(null)))
                    files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
                iter.close(null);
                files.sort((a, b) => b[1] - a[1]);
                for (const [name] of files.slice(KEEP))
                    dir.get_child(name).delete(null);
            } catch (_e) {
                // the cache is best effort
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._pruning)
            GLib.source_remove(this._pruning);
        this._pruning = 0;
        this._session?.abort();
        this._session = null;
        this._known.clear();
        this._pending.clear();
    }
}
