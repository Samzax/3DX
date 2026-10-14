// passage.js — where a creature on foot can and cannot go (pure: no three.js
// and no DOM; server.js imports this same file, so a move the screen allows is
// a move the server allows).
//
// Everything stands on the 5-ft grid. A wall run blocks along cell edges: solid
// cells, windows and shut doors stop a walker, gaps and open doors do not. An
// "Iron bars" prop is one more blocked edge (or, dropped in the middle of a
// cell, a blocked cell). A move is allowed when the straight line is clear, or
// when a short walk around (through an open door, round a corner) exists.
//
// Like vision.js, terrain relief is not part of this: the server has no
// heights. Cliffs and cave walls are the GM's `sight` wall runs, which block
// here exactly like masonry.

import { wallCellsOf, doorStateOf, buildRand } from './vision.js';

// Props that fence a cell edge. `rot` even: the piece runs along X.
export const BARRIER_PROPS = ['bars'];
// Furniture a character can use, and the pose it takes (server-validated).
export const PROP_POSES = { cot: 'lying', bench: 'sitting', throne: 'sitting' };
export const POSE_KINDS = ['lying', 'sitting'];
export const USE_REACH = 2.1;         // cells between a token and what it uses

const BODY_LOW = 0.3, BODY_HIGH = 0.9;  // the slice of a walker a barrier must cross
const DETOUR_PAD = 8;                   // cells searched around the straight line
const DETOUR_MAX = 64;                  // longer moves are judged on the line alone
const LEVEL_STEP = 0.75;                // a move changing height by more is a stair

const hKey = (ix, iz) => 'h' + ix + ',' + iz;   // edge (ix,iz) → (ix+1,iz)
const vKey = (ix, iz) => 'v' + ix + ',' + iz;   // edge (ix,iz) → (ix,iz+1)
const cKey = (ix, iz) => ix + ',' + iz;

function addBand(map, key, y0, y1) {
    const bands = map.get(key);
    if (bands) bands.push(y0, y1); else map.set(key, [y0, y1]);
}

// Everything on a map that stops a walker, from its object records.
export function buildBarriers(objects) {
    const barriers = { edges: new Map(), cells: new Map(), count: 0 };
    for (const o of objects || []) {
        if (!o || !o.position) continue;
        const px = Number(o.position.x) || 0, py = Number(o.position.y) || 0, pz = Number(o.position.z) || 0;
        if (o.type === 'wall') {
            const h = Math.max(0.4, Number(o.wallHeight) || 2);
            const ys = Array.isArray(o.ys) ? o.ys : [];
            const segments = Array.isArray(o.segments) ? o.segments : [];
            const seed = o.seed || 1;
            wallCellsOf(o).forEach((cell, i) => {
                const raw = segments[i];
                let top = h;
                if (raw === 'gap') return;
                if (raw === 'door') {
                    if (doorStateOf(o, i) === 'open') return;
                } else if (raw !== 'window') {
                    // Scruffy runs lose some cells and stand at ragged heights (structures.js).
                    if (o.scruffy && raw !== 'solid' && buildRand(seed, i, 1) < 0.15) return;
                    if (o.scruffy) top = h * (0.35 + 0.6 * buildRand(seed, i, 2));
                }
                const y = py + (Number(ys[i]) || 0);
                const ax = Math.round(px + cell.x), az = Math.round(pz + cell.z);
                const key = cell.ux ? hKey(cell.ux > 0 ? ax : ax - 1, az) : vKey(ax, cell.uz > 0 ? az : az - 1);
                addBand(barriers.edges, key, y - 0.5, y + top);
                barriers.count++;
            });
        } else if (o.type === 'prop' && BARRIER_PROPS.includes(o.kind)) {
            const alongX = (Math.round(Number(o.rot) || 0) & 1) === 0;
            const across = alongX ? pz : px;
            const line = Math.round(across);
            const ix = Math.floor(px), iz = Math.floor(pz);
            if (Math.abs(across - line) <= 0.25) {
                addBand(barriers.edges, alongX ? hKey(ix, line) : vKey(line, iz), py - 0.2, py + 2);
            } else {
                addBand(barriers.cells, cKey(ix, iz), py - 0.2, py + 2);
            }
            barriers.count++;
        }
    }
    return barriers;
}

function bandHit(bands, low, high) {
    if (!bands) return false;
    for (let i = 0; i < bands.length; i += 2) {
        if (bands[i] < high && bands[i + 1] > low) return true;
    }
    return false;
}

// Is the unit step from cell (ix,iz) by (dx,dz) — one of the four sides —
// stopped for a walker whose soles are at `feet`?
function sideBlocked(barriers, ix, iz, dx, dz, feet) {
    const low = feet + BODY_LOW, high = feet + BODY_HIGH;
    const key = dx > 0 ? vKey(ix + 1, iz) : dx < 0 ? vKey(ix, iz) : dz > 0 ? hKey(ix, iz + 1) : hKey(ix, iz);
    if (bandHit(barriers.edges.get(key), low, high)) return true;
    return bandHit(barriers.cells.get(cKey(ix + dx, iz + dz)), low, high);
}

// One step to any of the eight neighbours. A diagonal may not cut a corner:
// both ways round it have to be open.
function stepBlocked(barriers, ix, iz, dx, dz, feet) {
    if (!dx || !dz) return sideBlocked(barriers, ix, iz, dx, dz, feet);
    return sideBlocked(barriers, ix, iz, dx, 0, feet) || sideBlocked(barriers, ix + dx, iz, 0, dz, feet) ||
        sideBlocked(barriers, ix, iz, 0, dz, feet) || sideBlocked(barriers, ix, iz + dz, dx, 0, feet);
}

// The straight line between two points, cell by cell. `feetAt(t)` gives the
// walker's sole height along it (0 at `from`, 1 at `to`).
function lineBlocked(barriers, from, to, feetAt) {
    let ix = Math.floor(from.x), iz = Math.floor(from.z);
    const ex = Math.floor(to.x), ez = Math.floor(to.z);
    const dx = to.x - from.x, dz = to.z - from.z;
    const sx = Math.sign(dx), sz = Math.sign(dz);
    const tdx = sx ? 1 / Math.abs(dx) : Infinity, tdz = sz ? 1 / Math.abs(dz) : Infinity;
    let tx = sx ? (sx > 0 ? ix + 1 - from.x : from.x - ix) * tdx : Infinity;
    let tz = sz ? (sz > 0 ? iz + 1 - from.z : from.z - iz) * tdz : Infinity;
    for (let guard = 0; guard < 4096 && (ix !== ex || iz !== ez); guard++) {
        const t = Math.min(tx, tz);
        const feet = feetAt(Math.min(1, t));
        if (Math.abs(tx - tz) < 1e-9) {
            if (stepBlocked(barriers, ix, iz, sx, sz, feet)) return true;
            ix += sx; iz += sz; tx += tdx; tz += tdz;
        } else if (tx < tz) {
            if (sideBlocked(barriers, ix, iz, sx, 0, feet)) return true;
            ix += sx; tx += tdx;
        } else {
            if (sideBlocked(barriers, ix, iz, 0, sz, feet)) return true;
            iz += sz; tz += tdz;
        }
    }
    return false;
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Shortest walk between two cells inside the padded box around them, in cells
// (a diagonal counts 1.5, the 5e "every other diagonal" average); null when
// there is none.
function detourCells(barriers, from, to, feet) {
    const sx = Math.floor(from.x), sz = Math.floor(from.z), ex = Math.floor(to.x), ez = Math.floor(to.z);
    const x0 = Math.min(sx, ex) - DETOUR_PAD, z0 = Math.min(sz, ez) - DETOUR_PAD;
    const w = Math.abs(sx - ex) + 1 + DETOUR_PAD * 2, h = Math.abs(sz - ez) + 1 + DETOUR_PAD * 2;
    const dist = new Float32Array(w * h).fill(Infinity);
    const start = (sz - z0) * w + (sx - x0), goal = (ez - z0) * w + (ex - x0);
    dist[start] = 0;
    // Step costs are 1 or 1.5: two buckets a half-step apart make this an
    // exact Dijkstra without a heap.
    let buckets = [[start]], level = 0;
    while (level < buckets.length) {
        const bucket = buckets[level];
        if (bucket) {
            for (let n = 0; n < bucket.length; n++) {
                const at = bucket[n];
                if (dist[at] * 2 !== level) continue;
                if (at === goal) return dist[at];
                const cx = at % w, cz = (at - cx) / w;
                for (const [dx, dz] of STEPS) {
                    const nx = cx + dx, nz = cz + dz;
                    if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                    if (stepBlocked(barriers, cx + x0, cz + z0, dx, dz, feet)) continue;
                    const cost = dist[at] + (dx && dz ? 1.5 : 1);
                    const next = nz * w + nx;
                    if (cost >= dist[next]) continue;
                    dist[next] = cost;
                    (buckets[cost * 2] || (buckets[cost * 2] = [])).push(next);
                }
            }
        }
        level++;
    }
    return null;
}

// Can a walker go from `from` to `to` ({ x, z, feet } — world cells, soles)?
// → { ok, detour, cells }: `detour` when the straight line is shut and the
// walk goes round, `cells` the length of that walk.
export function walkable(barriers, from, to) {
    const flat = Math.hypot(to.x - from.x, to.z - from.z);
    const clear = { ok: true, detour: false, cells: flat };
    if (!barriers || !barriers.count) return clear;
    const f0 = Number(from.feet) || 0, f1 = Number(to.feet) || 0;
    if (Math.floor(from.x) === Math.floor(to.x) && Math.floor(from.z) === Math.floor(to.z)) return clear;
    const stair = Math.abs(f1 - f0) >= LEVEL_STEP;
    if (!lineBlocked(barriers, from, to, stair ? (t) => f0 + (f1 - f0) * t : () => f0)) return clear;
    if (stair || flat > DETOUR_MAX) return { ok: false, detour: false, cells: flat };
    const cells = detourCells(barriers, from, to, f0);
    return cells == null ? { ok: false, detour: false, cells: flat } : { ok: true, detour: true, cells };
}
