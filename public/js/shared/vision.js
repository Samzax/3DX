// vision.js — the pure line-of-sight, light and senses model (no three.js and
// no DOM: server.js imports this same file, so both sides agree on who sees
// what). Everything here works on the plain synced object records.
//
// The model is 2.5D. Walls are vertical panels over their baked ground heights
// (one sight segment per wall cell: solid cells and closed doors block, windows
// and gaps do not), floors and roofs are horizontal slabs. A creature sees
// another when the straight line between eye and body crosses neither, the
// target is lit (or a sense makes light irrelevant) and it is within range.
// Terrain relief is NOT part of the model: the server has no heights.
//
// Units: world units are 5 ft tactical cells; senses, lights and ranges are in
// feet, the way the rules and the sheets state them.

export const FEET_PER_UNIT = 5;
export const LIGHT_DARK = 0, LIGHT_DIM = 1, LIGHT_BRIGHT = 2;
export const SENSE_KEYS = ['darkvision', 'blindsight', 'truesight', 'tremorsense', 'devilsSight'];
export const SENSE_LABELS = {
    darkvision: 'Darkvision', blindsight: 'Blindsight', truesight: 'Truesight',
    tremorsense: 'Tremorsense', devilsSight: "Devil's Sight"
};
export const SENSE_LIMIT = 1000;      // feet
export const LIGHT_LIMIT = 600;       // feet
export const MAX_SIGHT_FEET = 2000;   // clear-day cap on token-to-token sight

// Campaign `settings.vision` (mirrored in server.js; tests enforce the sync).
export const VISION_NIGHT = ['dim', 'dark'];
export const VISION_INDOORS = ['auto', 'bright', 'dim', 'dark'];
export const VISION_POCKETS = ['bright', 'dim', 'dark'];
export const VISION_DEFAULTS = { enabled: false, night: 'dim', indoors: 'auto', pockets: 'dim', memory: true };

export const LIGHT_PRESETS = {
    none: { label: 'No light', bright: 0, dim: 0, dark: 0 },
    candle: { label: 'Candle (5 / 5 ft)', bright: 5, dim: 5, dark: 0 },
    torch: { label: 'Torch (20 / 20 ft)', bright: 20, dim: 20, dark: 0 },
    lantern: { label: 'Hooded lantern (30 / 30 ft)', bright: 30, dim: 30, dark: 0 },
    light: { label: 'Light cantrip (20 / 20 ft)', bright: 20, dim: 20, dark: 0 },
    bonfire: { label: 'Bonfire (40 / 40 ft)', bright: 40, dim: 40, dark: 0 },
    daylight: { label: 'Daylight spell (60 / 60 ft)', bright: 60, dim: 60, dark: 0 },
    darkness: { label: 'Magical darkness (15 ft)', bright: 0, dim: 0, dark: 15 }
};
export const DOOR_STATES = ['open', 'locked'];

const CELL = 1;                 // scene.js GRID_CELL_SIZE
const GRID = 8;                 // spatial hash pitch for sight segments
const WALL_CELL_LIMIT = 48;
const LEVEL_NAMES = { bright: LIGHT_BRIGHT, dim: LIGHT_DIM, dark: LIGHT_DARK };

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, min, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
};

export function normalizeVision(raw) {
    const s = isRecord(raw) ? raw : {}, out = { ...VISION_DEFAULTS };
    if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
    if (VISION_NIGHT.includes(s.night)) out.night = s.night;
    if (VISION_INDOORS.includes(s.indoors)) out.indoors = s.indoors;
    if (VISION_POCKETS.includes(s.pockets)) out.pockets = s.pockets;
    if (typeof s.memory === 'boolean') out.memory = s.memory;
    return out;
}

// → { darkvision, blindsight, truesight, tremorsense, devilsSight (feet), blind }
// with zero/false entries dropped, so an empty record means "ordinary eyes".
export function normalizeSenses(raw) {
    const out = {};
    if (!isRecord(raw)) return out;
    for (const key of SENSE_KEYS) {
        const feet = clampInt(raw[key], 0, SENSE_LIMIT);
        if (feet > 0) out[key] = feet;
    }
    if (raw.blind === true) out.blind = true;
    return out;
}

// SRD monsters state senses as { darkvision: "60 ft.", blindsight: "30 ft.
// (blind beyond this radius)" }; homebrew ones keep free text under `notes`.
export function parseMonsterSenses(raw) {
    const found = {};
    if (!isRecord(raw)) return found;
    const scan = (key, text) => {
        const feet = parseInt(String(text).match(/\d+/)?.[0] || '', 10);
        if (Number.isFinite(feet) && SENSE_KEYS.includes(key)) found[key] = Math.max(found[key] || 0, feet);
        if (/blind beyond/i.test(String(text))) found.blind = true;
    };
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'notes') {
            const re = /(darkvision|blindsight|truesight|tremorsense)\s*(\d+)[^,;]*/gi;
            let m;
            while ((m = re.exec(String(value)))) scan(m[1].toLowerCase(), m[0].slice(m[1].length));
        } else if (typeof value === 'number') {
            if (SENSE_KEYS.includes(key)) found[key] = value;
        } else if (typeof value === 'string') {
            scan(key, value);
        }
    }
    return normalizeSenses(found);
}

export function normalizeLight(raw) {
    if (!isRecord(raw)) return null;
    const light = {
        bright: clampInt(raw.bright, 0, LIGHT_LIMIT),
        dim: clampInt(raw.dim, 0, LIGHT_LIMIT),
        dark: clampInt(raw.dark, 0, LIGHT_LIMIT)
    };
    return light.bright || light.dim || light.dark ? light : null;
}

export function lightPresetKey(light) {
    const l = normalizeLight(light) || { bright: 0, dim: 0, dark: 0 };
    for (const [key, p] of Object.entries(LIGHT_PRESETS)) {
        if (p.bright === l.bright && p.dim === l.dim && p.dark === l.dark) return key;
    }
    return 'custom';
}

export function isCreature(obj) {
    return !!obj && (obj.type === 'token' || obj.type === 'character');
}

// A token's stored senses (set by its owner's sheet or the GM) win over the
// ones read off its stat block.
export function sensesOf(obj) {
    if (!obj) return {};
    if (isRecord(obj.senses)) return normalizeSenses(obj.senses);
    if (isRecord(obj.monsterData)) return parseMonsterSenses(obj.monsterData.senses);
    return {};
}

const SIZE_EYE = { Tiny: 0.35, Small: 0.7, Medium: 1.05, Large: 1.7, Huge: 2.8, Gargantuan: 4 };
// Synced positions are mesh centers: characters sit 0.38 above their soles,
// monster tokens 0.1 (models.js halfHeight).
function groundOf(obj) {
    return (Number(obj.position.y) || 0) - (obj.type === 'character' ? 0.38 : 0.1);
}
function eyeOf(obj) {
    const size = obj.monsterData && obj.monsterData.size;
    return obj.type === 'character' ? 1.05 : (SIZE_EYE[size] || 1.05);
}
export function viewerOf(obj) {
    return {
        id: obj.id, x: Number(obj.position.x) || 0, z: Number(obj.position.z) || 0,
        y: groundOf(obj) + eyeOf(obj), ground: groundOf(obj), senses: sensesOf(obj)
    };
}
export function targetOf(obj) {
    return {
        id: obj.id, x: Number(obj.position.x) || 0, z: Number(obj.position.z) || 0,
        y: groundOf(obj) + eyeOf(obj) * 0.6, invisible: obj.invisible === true
    };
}

// ---- structure geometry (mirrors structures.js; tests hold the two together) ----

export function buildRand(seed, i, k) {
    let h = (seed ^ Math.imul(i + 1, 374761393) ^ Math.imul(k + 1, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

const snapWallCoord = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number / CELL) * CELL : 0;
};

// One entry per wall cell, relative to the run's anchor: the cell spans
// (x, z) → (x + ux, z + uz).
export function wallCellsOf(data) {
    const raw = Array.isArray(data && data.path) && data.path.length
        ? data.path
        : [{ x: 0, z: 0 }, { x: data && data.bx, z: data && data.bz }];
    const points = [{ x: 0, z: 0 }];
    let used = 0;
    const appendLeg = (axis, target) => {
        if (used >= WALL_CELL_LIMIT) return;
        const here = points[points.length - 1];
        const delta = axis === 'x' ? target.x - here.x : target.z - here.z;
        const cells = Math.min(Math.round(Math.abs(delta) / CELL), WALL_CELL_LIMIT - used);
        if (!cells) return;
        const next = { ...here };
        next[axis] += Math.sign(delta) * cells * CELL;
        points.push(next);
        used += cells;
    };
    for (let i = 0; i < raw.length && i <= WALL_CELL_LIMIT; i++) {
        const point = raw[i];
        if (used >= WALL_CELL_LIMIT) break;
        if (!point) continue;
        const target = { x: snapWallCoord(point.x), z: snapWallCoord(point.z) };
        appendLeg('x', target);
        appendLeg('z', target);
    }
    const cells = [];
    for (let p = 1; p < points.length; p++) {
        const a = points[p - 1], b = points[p];
        const dx = Math.round((b.x - a.x) / CELL), dz = Math.round((b.z - a.z) / CELL);
        const count = Math.abs(dx) + Math.abs(dz);
        const ux = Math.sign(dx), uz = Math.sign(dz);
        for (let i = 0; i < count && cells.length < WALL_CELL_LIMIT; i++) {
            cells.push({ x: a.x + ux * i * CELL, z: a.z + uz * i * CELL, ux, uz });
        }
    }
    return cells;
}

export function doorStateOf(data, index) {
    const state = Array.isArray(data && data.doors) ? data.doors[index] : null;
    return DOOR_STATES.includes(state) ? state : null;
}

// The door cell of a wall nearest a world point, within `reach` units.
// → { index, x, z, distance } or null.
export function nearestDoor(data, x, z, reach = 1.2) {
    if (!data || data.type !== 'wall' || !Array.isArray(data.segments)) return null;
    const px = Number(data.position && data.position.x) || 0, pz = Number(data.position && data.position.z) || 0;
    let best = null;
    wallCellsOf(data).forEach((cell, index) => {
        if (data.segments[index] !== 'door') return;
        const cx = px + cell.x + cell.ux * 0.5, cz = pz + cell.z + cell.uz * 0.5;
        const distance = Math.hypot(cx - x, cz - z);
        if (distance <= reach && (!best || distance < best.distance)) best = { index, x: cx, z: cz, distance };
    });
    return best;
}

// ---- occluders ----

function indexSegment(occ, seg) {
    const x0 = Math.floor(Math.min(seg.ax, seg.bx) / GRID), x1 = Math.floor(Math.max(seg.ax, seg.bx) / GRID);
    const z0 = Math.floor(Math.min(seg.az, seg.bz) / GRID), z1 = Math.floor(Math.max(seg.az, seg.bz) / GRID);
    for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
            const key = gx + ',' + gz;
            let bucket = occ.grid.get(key);
            if (!bucket) occ.grid.set(key, bucket = []);
            bucket.push(seg);
        }
    }
}

// Everything on a map that blocks sight or sheds light, from its object records.
export function buildOccluders(objects) {
    const occ = { segs: [], slabs: [], lights: [], grid: new Map(), stamp: 0 };
    for (const o of objects || []) {
        if (!o || !o.position) continue;
        const px = Number(o.position.x) || 0, py = Number(o.position.y) || 0, pz = Number(o.position.z) || 0;
        const light = normalizeLight(o.light);
        if (light) {
            occ.lights.push({
                id: o.id, x: px, z: pz, y: isCreature(o) ? groundOf(o) + eyeOf(o) : py + 0.6,
                bright: light.bright / FEET_PER_UNIT, dim: light.dim / FEET_PER_UNIT, dark: light.dark / FEET_PER_UNIT
            });
        }
        if (o.type === 'wall') {
            const h = Math.max(0.4, Number(o.wallHeight) || 2);
            const ys = Array.isArray(o.ys) ? o.ys : [];
            const segments = Array.isArray(o.segments) ? o.segments : [];
            const seed = o.seed || 1;
            wallCellsOf(o).forEach((cell, i) => {
                const raw = segments[i];
                const kind = raw === 'door' || raw === 'window' || raw === 'gap' ? raw : 'solid';
                let top = h;
                if (kind === 'solid') {
                    if (o.scruffy && raw !== 'solid' && buildRand(seed, i, 1) < 0.15) return;
                    if (o.scruffy) top = h * (0.35 + 0.6 * buildRand(seed, i, 2));
                } else if (kind === 'door') {
                    if (doorStateOf(o, i) === 'open') return;
                } else {
                    return; // windows and gaps pass sight and light
                }
                const y = py + (Number(ys[i]) || 0);
                const seg = {
                    ax: px + cell.x, az: pz + cell.z,
                    bx: px + cell.x + cell.ux * CELL, bz: pz + cell.z + cell.uz * CELL,
                    y0: y - 0.5, y1: y + top, mark: 0
                };
                occ.segs.push(seg);
                indexSegment(occ, seg);
            });
        } else if (o.type === 'floor' || o.type === 'roof') {
            // A terrain-following ground floor is the ground itself, not a ceiling.
            if (o.type === 'floor' && o.heightMode === 'terrain') continue;
            const cols = Math.max(1, Math.min(48, Number(o.cols) | 0));
            const rows = Math.max(1, Math.min(48, Number(o.rows) | 0));
            const tiles = Array.isArray(o.tiles) ? o.tiles : null;
            let open = null;
            for (let i = 0; i < cols * rows; i++) {
                const kind = tiles ? tiles[i] : null;
                const gone = kind === 'gap' || (o.type === 'floor' && o.scruffy && kind !== 'solid' &&
                    buildRand(o.seed || 1, i, 11) < 0.14);
                if (gone) (open = open || new Set()).add(i);
            }
            occ.slabs.push({ x0: px, z0: pz, cols, rows, y: py + (o.type === 'roof' ? 0.24 : 0.07), open });
        }
    }
    return occ;
}

function slabSolidAt(slab, x, z) {
    const tx = Math.floor((x - slab.x0) / CELL), tz = Math.floor((z - slab.z0) / CELL);
    if (tx < 0 || tz < 0 || tx >= slab.cols || tz >= slab.rows) return false;
    return !(slab.open && slab.open.has(tz * slab.cols + tx));
}

// Height of the lowest ceiling over a point (Infinity under open sky).
export function coverAbove(occ, x, y, z) {
    let cover = Infinity;
    for (const slab of occ.slabs) {
        if (slab.y > y + 0.3 && slab.y < cover && slabSolidAt(slab, x, z)) cover = slab.y;
    }
    return cover;
}

function segmentHits(seg, ax, ay, az, bx, by, bz) {
    const rx = bx - ax, rz = bz - az;
    const sx = seg.bx - seg.ax, sz = seg.bz - seg.az;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return false;
    const qx = seg.ax - ax, qz = seg.az - az;
    const t = (qx * sz - qz * sx) / den;
    if (t <= 1e-4 || t >= 1 - 1e-4) return false;
    const u = (qx * rz - qz * rx) / den;
    if (u < -1e-6 || u > 1 + 1e-6) return false;
    const y = ay + (by - ay) * t;
    return y >= seg.y0 && y <= seg.y1;
}

// Is the straight line between two points cut by a wall, closed door, floor
// or roof?
export function sightBlocked(occ, ax, ay, az, bx, by, bz) {
    for (const slab of occ.slabs) {
        if ((ay - slab.y) * (by - slab.y) >= 0) continue;
        const t = (slab.y - ay) / (by - ay);
        if (slabSolidAt(slab, ax + (bx - ax) * t, az + (bz - az) * t)) return true;
    }
    if (!occ.segs.length) return false;
    const x0 = Math.floor(Math.min(ax, bx) / GRID), x1 = Math.floor(Math.max(ax, bx) / GRID);
    const z0 = Math.floor(Math.min(az, bz) / GRID), z1 = Math.floor(Math.max(az, bz) / GRID);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) {
        for (const seg of occ.segs) if (segmentHits(seg, ax, ay, az, bx, by, bz)) return true;
        return false;
    }
    const stamp = ++occ.stamp;
    for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
            const bucket = occ.grid.get(gx + ',' + gz);
            if (!bucket) continue;
            for (const seg of bucket) {
                if (seg.mark === stamp) continue;
                seg.mark = stamp;
                if (segmentHits(seg, ax, ay, az, bx, by, bz)) return true;
            }
        }
    }
    return false;
}

// ---- light ----

// Daylight by game hour: bright by day, dim through dawn and dusk, then the
// campaign's night (a moonlit `dim`, or true `dark`).
export function outdoorLevel(hour, night = 'dim') {
    const h = ((Number(hour) % 24) + 24) % 24;
    if (h >= 6 && h < 18.5) return LIGHT_BRIGHT;
    if ((h >= 5 && h < 6) || (h >= 18.5 && h < 20)) return LIGHT_DIM;
    return night === 'dark' ? LIGHT_DARK : LIGHT_DIM;
}

// How far ordinary sight carries through the weather, in feet (a table
// simplification: thick fog 60 ft, storms and blizzards 150 ft, mist and
// heavy rain 300 ft).
export function weatherSightFeet(w) {
    if (!w) return MAX_SIGHT_FEET;
    if (w.fog > 0.6) return 60;
    if (w.storm > 0.4 || w.snow > 0.88) return 150;
    if (w.fog > 0.25 || w.rain > 0.8) return 300;
    return MAX_SIGHT_FEET;
}

// The ambient light a map is under. vision: campaign settings; hour: game
// hour; pocket: indoors map (no sky); weather: resolved weather or null.
export function visionContext(vision, { hour = 12, pocket = false, weather = null } = {}) {
    const v = normalizeVision(vision);
    const outdoor = outdoorLevel(hour, v.night);
    return {
        pocket: !!pocket,
        outdoor: pocket ? LEVEL_NAMES[v.pockets] : outdoor,
        indoor: pocket ? LEVEL_NAMES[v.pockets]
            : (v.indoors === 'auto' ? Math.max(LIGHT_DARK, outdoor - 1) : LEVEL_NAMES[v.indoors]),
        sightFeet: pocket ? MAX_SIGHT_FEET : weatherSightFeet(weather)
    };
}

export function ambientAt(occ, ctx, x, y, z) {
    if (ctx.pocket || ctx.indoor === ctx.outdoor) return ctx.outdoor;
    return coverAbove(occ, x, y, z) < Infinity ? ctx.indoor : ctx.outdoor;
}

// → { level: LIGHT_*, magical } at a point. Magical darkness swallows every
// other light; ordinary lights are stopped by walls like sight is.
export function lightAt(occ, ctx, x, y, z) {
    let level = ambientAt(occ, ctx, x, y, z);
    let magical = false;
    for (const l of occ.lights) {
        const d = Math.hypot(l.x - x, l.y - y, l.z - z);
        if (l.dark > 0 && d <= l.dark) { magical = true; continue; }
        if (level >= LIGHT_BRIGHT || d > l.bright + l.dim) continue;
        const reach = d <= l.bright ? LIGHT_BRIGHT : LIGHT_DIM;
        if (reach > level && !sightBlocked(occ, l.x, l.y, l.z, x, y, z)) level = reach;
    }
    return magical ? { level: LIGHT_DARK, magical } : { level, magical };
}

// ---- who sees what ----

// How `viewer` (viewerOf) perceives `target` (targetOf): null, or the sense
// that does it — 'sight', 'darkvision', 'blindsight', 'truesight', 'tremor'.
// Tremorsense alone gives a position, not a look: screens show it as a ping.
export function canSee(occ, ctx, viewer, target) {
    const feet = Math.hypot(viewer.x - target.x, viewer.y - target.y, viewer.z - target.z) * FEET_PER_UNIT;
    const s = viewer.senses || {};
    if (!sightBlocked(occ, viewer.x, viewer.y, viewer.z, target.x, target.y, target.z)) {
        if ((s.truesight || 0) >= feet) return 'truesight';
        if ((s.blindsight || 0) >= feet) return 'blindsight';
        if (!s.blind && !target.invisible && feet <= Math.min(MAX_SIGHT_FEET, ctx.sightFeet || MAX_SIGHT_FEET)) {
            if (feet <= 5) return 'sight';      // close enough to make out by any means
            const light = lightAt(occ, ctx, target.x, target.y, target.z);
            if (light.level > LIGHT_DARK) return 'sight';
            if ((s.devilsSight || 0) >= feet) return 'sight';
            if (!light.magical && (s.darkvision || 0) >= feet) return 'darkvision';
        }
    }
    if ((s.tremorsense || 0) >= feet) return 'tremor';
    return null;
}

// Best perception of `target` across several viewers ('tremor' ranks last).
export function canAnySee(occ, ctx, viewers, target) {
    let best = null;
    for (const viewer of viewers) {
        const how = canSee(occ, ctx, viewer, target);
        if (how && how !== 'tremor') return how;
        best = best || how;
    }
    return best;
}

// ---- polar sight row (the render mask) ----

export const POLAR_FAR = 1e5;
// For `bins` directions around a point (bin i covers angles from
// -PI + i*step), the distance to the nearest sight segment standing across
// the eye's height, and that segment's top: out[offset + 2i] = distance,
// out[offset + 2i + 1] = top. Conservative: a segment fills every bin its arc
// touches, so adjoining cells never leak a sliver between them.
export function polarRow(occ, ox, oy, oz, bins, out, offset = 0, maxDist = POLAR_FAR) {
    for (let i = 0; i < bins; i++) { out[offset + 2 * i] = POLAR_FAR; out[offset + 2 * i + 1] = 0; }
    const step = Math.PI * 2 / bins;
    for (const seg of occ.segs) {
        if (oy < seg.y0 || oy > seg.y1) continue;
        const ax = seg.ax - ox, az = seg.az - oz, bx = seg.bx - ox, bz = seg.bz - oz;
        if (Math.min(Math.hypot(ax, az), Math.hypot(bx, bz)) > maxDist + CELL) continue;
        let a0 = Math.atan2(az, ax), sweep = Math.atan2(bz, bx) - a0;
        if (sweep > Math.PI) sweep -= Math.PI * 2;
        else if (sweep < -Math.PI) sweep += Math.PI * 2;
        if (sweep < 0) { a0 += sweep; sweep = -sweep; }
        const sx = bx - ax, sz = bz - az;
        const first = Math.floor((a0 + Math.PI) / step), last = Math.floor((a0 + sweep + Math.PI) / step);
        for (let n = first; n <= last; n++) {
            const i = ((n % bins) + bins) % bins;
            const theta = -Math.PI + (n + 0.5) * step;
            const dx = Math.cos(theta), dz = Math.sin(theta);
            const den = dx * sz - dz * sx;
            let dist;
            if (Math.abs(den) < 1e-9) {
                dist = Math.min(Math.hypot(ax, az), Math.hypot(bx, bz));
            } else {
                const u = Math.max(0, Math.min(1, (ax * dz - az * dx) / den));
                dist = Math.hypot(ax + sx * u, az + sz * u);
            }
            if (dist < out[offset + 2 * i]) { out[offset + 2 * i] = dist; out[offset + 2 * i + 1] = seg.y1; }
        }
    }
    return out;
}

// Read a polar row back on the CPU (explored-memory marking uses the exact
// mask the shader draws).
export function polarDistance(row, bins, offset, dx, dz, stride = 2) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2) * bins)));
    return row[offset + stride * i];
}
