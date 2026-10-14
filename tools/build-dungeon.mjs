// build-dungeon.mjs — writes the "Calabouço do Mago" dungeon into a pocket map.
//
//   node tools/build-dungeon.mjs --saves <campaign store dir> --pocket pocket/<id>
//        [--campaign <campaigns.json> <campaign id>]  also turn token vision on (pockets dark)
//                                                     and build the gate around the world portal
//
// Run it with the server STOPPED (the server owns map_state.json while it is
// up) and start the server afterwards. It is re-runnable: everything in the
// pocket except its portals is replaced.
//
// The dungeon is cut out of solid rock. The pocket's heightmap is raised into
// a rock mass and the rooms, tunnels and caverns are carved down to floor
// level, so cave walls are real terrain (the chasm and the cistern basin are
// just deeper cuts). The worked half gets "dungeon" masonry walls, flagstone
// floors, doors and torches as ordinary structure/prop records; the natural
// half gets invisible sight-blocker walls along the rock so token vision works
// (the server does not read terrain for sight).
//
// Units: 1 world unit = one 5-ft cell. +X is east, +Z is south. Cell (i, j)
// covers x in [i, i+1], z in [j, j+1].

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGround } from '../public/js/shared/ground.js';

const args = process.argv.slice(2);
const arg = (name, count = 1) => {
    const at = args.indexOf(name);
    return at < 0 ? null : args.slice(at + 1, at + 1 + count);
};
const savesDir = arg('--saves')?.[0];
const pocketKey = arg('--pocket')?.[0];
if (!savesDir || !pocketKey) {
    console.error('usage: node tools/build-dungeon.mjs --saves <store dir> --pocket pocket/<id> [--campaign <campaigns.json> <id>]');
    process.exit(1);
}

// ---- terrain lattice (mirrors public/js/shared/terrain.js) -----------------
const VSPACE = 0.5, CHUNK_VERTS = 64, HEIGHT_QUANT = 0.05;
const HALF = 128;                                   // the pocket is 256 x 256 cells
const MAT_DIRT = 1, MAT_ROCK = 2;

// ---- deterministic noise ----------------------------------------------------
function hash2(x, z, k = 0) {
    let h = (Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(k + 1, 2246822519)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z, k = 0) {                       // value noise in [-1, 1]
    const ix = Math.floor(x), iz = Math.floor(z);
    let fx = x - ix, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz, k), b = hash2(ix + 1, iz, k), c = hash2(ix, iz + 1, k), d = hash2(ix + 1, iz + 1, k);
    return ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz) * 2 - 1;
}
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- layout: the worked half ------------------------------------------------
// Rooms are their own region; every corridor shares region 'c'. A wall is
// raised wherever a built cell meets rock, room meets room is a wall, and room
// meets corridor is a door.
const ROOMS = [
    { id: 'cell',    x0: -62, z0: -52, x1: -52, z1: -45, wall: 3 },   // the shared cell: the party wakes here
    { id: 'cell2',   x0: -52, z0: -52, x1: -46, z1: -45, wall: 3 },
    { id: 'guard',   x0: -62, z0: -45, x1: -46, z1: -40, wall: 3 },
    { id: 'hall',    x0: -7,  z0: -58, x1: 7,   z1: -40, wall: 4 },   // audience hall
    { id: 'hatch',   x0: 44,  z0: -50, x1: 60,  z1: -38, wall: 3 },   // hatchery
    { id: 'archive', x0: -62, z0: -22, x1: -44, z1: -8,  wall: 3 },
    { id: 'cross',   x0: -8,  z0: -22, x1: 8,   z1: -8,  wall: 3 },   // the crossing
    { id: 'vault',   x0: 44,  z0: -22, x1: 56,  z1: -10, wall: 3 }    // vault stair, sealed
];
const CORRIDORS = [
    { x0: -46, z0: -44, x1: -7,  z1: -42 },     // guard room -> hall
    { x0: 7,   z0: -44, x1: 44,  z1: -42 },     // hall -> hatchery
    { x0: -1,  z0: -40, x1: 1,   z1: -22 },     // hall -> crossing
    { x0: -44, z0: -16, x1: -8,  z1: -14 },     // archive -> crossing
    { x0: 8,   z0: -16, x1: 44,  z1: -14 },     // crossing -> vault
    { x0: 51,  z0: -38, x1: 53,  z1: -22 },     // hatchery -> vault
    { x0: -58, z0: -40, x1: -57, z1: -22 }      // the jailer's back passage: guard room -> archive
];
const LOCKED_ROOMS = new Set(['vault']);        // every door into these is barred
// Edges that are not what the rules above would make them. Key = edgeKey().
const EDGE_OVERRIDE = new Map();
const hKey = (i, j) => `h,${i},${j}`;           // edge along X from corner (i,j) to (i+1,j)
const vKey = (i, j) => `v,${i},${j}`;           // edge along Z from corner (i,j) to (i,j+1)
// Cell fronts: open ironwork toward the guard room, one door each.
for (let i = -62; i < -46; i++) EDGE_OVERRIDE.set(hKey(i, -45), 'bars');
EDGE_OVERRIDE.set(hKey(-57, -45), 'locked');
EDGE_OVERRIDE.set(hKey(-49, -45), 'door');
// The back passage is barred from the guard room side.
EDGE_OVERRIDE.set(hKey(-58, -40), 'locked');

const built = new Map();                        // "i,j" -> region id
const cellKey = (i, j) => `${i},${j}`;
for (const c of CORRIDORS) for (let i = c.x0; i < c.x1; i++) for (let j = c.z0; j < c.z1; j++) built.set(cellKey(i, j), 'c');
for (const r of ROOMS) for (let i = r.x0; i < r.x1; i++) for (let j = r.z0; j < r.z1; j++) built.set(cellKey(i, j), r.id);
const roomById = new Map(ROOMS.map(r => [r.id, r]));
const builtRects = [...ROOMS, ...CORRIDORS];

// ---- layout: the natural half -----------------------------------------------
// Capsules (a -> b, radius r) and blobs (a == b). Radii wobble with noise so
// no two stretches of tunnel are the same width.
const seg = (ax, az, bx, bz, r) => ({ ax, az, bx, bz, r });
const blob = (x, z, r) => seg(x, z, x, z, r);
const CHASM_CAVERN = blob(0, 18, 13);
const CISTERN = { x: -52, z: 22, r: 10.5, basin: 9.2, floor: -0.9, level: -0.2 };
const NATURAL = [
    // crossing -> chasm cavern
    seg(0, -8.4, 2, -2, 1.7), seg(2, -2, -1, 4, 1.7), seg(-1, 4, 0, 9, 1.9),
    CHASM_CAVERN,
    // archive -> cistern
    seg(-53, -8.4, -55, 0, 1.6), seg(-55, 0, -51, 8, 1.6), seg(-51, 8, -52, 14, 1.7),
    blob(CISTERN.x, CISTERN.z, CISTERN.r),
    // chasm cavern (north side) -> feral den
    seg(10, 11, 20, 8, 1.7), seg(20, 8, 31, 13, 1.6), seg(31, 13, 42, 19, 1.8),
    blob(52, 22, 11), blob(60, 12, 4.2), blob(62, 29, 4.6), blob(47, 33, 4.2),
    // cistern -> mist cavern
    seg(-45, 28, -34, 36, 1.6), seg(-34, 36, -22, 40, 1.5), seg(-22, 40, -9, 46, 1.7),
    // chasm cavern (south side) -> mist cavern
    seg(1, 29, -2, 36, 1.8), seg(-2, 36, 1, 42, 1.8),
    // feral den -> mist cavern
    seg(45, 31, 34, 38, 1.7), seg(34, 38, 22, 43, 1.6), seg(22, 43, 8, 47, 1.7),
    // mist cavern and the way out
    blob(0, 48, 8.5), seg(0, 55, 0, 66, 2.6)
];
const CHASM = { line: [[-17, 17], [-6, 20], [5, 18], [17, 21]], half: 2.3, depth: -10 };
const BRIDGE = { x0: -1, z0: 14, cols: 2, rows: 9 };
const VAULT_PIT = { x0: 47.5, z0: -19.5, x1: 52.5, z1: -12.5, depth: -7 };   // the stair down, choked with rubble
const EXIT = { x: 0, z: 63 };

function distSeg(px, pz, s) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / len2)) : 0;
    return Math.hypot(px - (s.ax + dx * t), pz - (s.az + dz * t));
}
// Signed distance to the natural open space (< 0 inside).
function naturalDistance(x, z) {
    const wobble = 1 + 0.2 * noise(x / 3.3, z / 3.3, 1) + 0.08 * noise(x / 1.3, z / 1.3, 2);
    let best = Infinity;
    for (const s of NATURAL) {
        const d = distSeg(x, z, s) - s.r * wobble;
        if (d < best) best = d;
    }
    return best;
}
function builtDistance(x, z) {
    let best = Infinity;
    for (const r of builtRects) {
        const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
    }
    return best;
}
function chasmDistance(x, z) {
    let best = Infinity;
    for (let i = 1; i < CHASM.line.length; i++) {
        const [ax, az] = CHASM.line[i - 1], [bx, bz] = CHASM.line[i];
        best = Math.min(best, distSeg(x, z, { ax, az, bx, bz }));
    }
    return best - CHASM.half * (1 + 0.25 * noise(x / 2.1, z / 2.1, 3));
}

// Ground height and dominant material at a world point.
function ground(x, z) {
    const top = 4.3 + 0.9 * noise(x / 9, z / 9, 4) + 0.35 * noise(x / 2.7, z / 2.7, 5);
    const dB = builtDistance(x, z), dN = naturalDistance(x, z);
    if (dB <= 0) {
        // Worked floor: dead level under the flagstones, except the vault's stair pit.
        const p = VAULT_PIT;
        if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) {
            const ramp = (z - p.z0) / (p.z1 - p.z0);                 // descends southward
            const edge = Math.min(x - p.x0, p.x1 - x, z - p.z0);
            return { h: p.depth * ramp * smoothstep(0, 0.6, edge), mat: MAT_ROCK, open: true };
        }
        return { h: 0, mat: MAT_ROCK, open: true };
    }
    if (dN <= 0) {
        let h = 0.1 * noise(x / 1.7, z / 1.7, 6);
        let mat = noise(x / 4.1, z / 4.1, 7) > -0.15 ? MAT_DIRT : MAT_ROCK;
        if (distSeg(x, z, CHASM_CAVERN) < CHASM_CAVERN.r * 1.3) {
            const c = chasmDistance(x, z);
            if (c < 1.2) { h += CHASM.depth * (1 - smoothstep(-0.4, 1.2, c)); mat = MAT_ROCK; }
        }
        const dc = Math.hypot(x - CISTERN.x, z - CISTERN.z);
        if (dc < CISTERN.basin) { h = Math.min(h, 0) + CISTERN.floor * (1 - smoothstep(CISTERN.basin - 2.2, CISTERN.basin, dc)); mat = MAT_ROCK; }
        return { h, mat, open: true };
    }
    // Rock: sheer behind the masonry, a short scree slope in the caves.
    const rise = Math.min(smoothstep(0, 0.5, dB), smoothstep(0, 1.5, dN));
    return { h: top * rise, mat: MAT_ROCK, open: false };
}

// ---- terrain chunks ---------------------------------------------------------
function buildTerrain() {
    const chunks = {};
    const span = HALF / (CHUNK_VERTS * VSPACE);                      // 4 chunks each way
    for (let cz = -span; cz < span; cz++) {
        for (let cx = -span; cx < span; cx++) {
            const heights = new Int16Array(CHUNK_VERTS * CHUNK_VERTS);
            const splat = new Uint8Array(CHUNK_VERTS * CHUNK_VERTS * 4);
            for (let lz = 0; lz < CHUNK_VERTS; lz++) {
                for (let lx = 0; lx < CHUNK_VERTS; lx++) {
                    const i = lz * CHUNK_VERTS + lx;
                    const g = ground((cx * CHUNK_VERTS + lx) * VSPACE, (cz * CHUNK_VERTS + lz) * VSPACE);
                    heights[i] = Math.max(-32768, Math.min(32767, Math.round(g.h / HEIGHT_QUANT)));
                    splat[i * 4 + g.mat] = 255;
                }
            }
            chunks[`${cx},${cz}`] = {
                heights: Buffer.from(heights.buffer).toString('base64'),
                splat: Buffer.from(splat.buffer).toString('base64')
            };
        }
    }
    return {
        format: 2, chunkCells: 32, vertexSpacing: VSPACE,
        water: { bodies: [{ id: 'cistern', kind: 'lake', seed: { x: CISTERN.x, z: CISTERN.z }, level: CISTERN.level, maxRadius: 16 }] },
        chunks
    };
}

// ---- cells --------------------------------------------------------------------
const naturalCells = new Set();
for (let j = -HALF; j < HALF; j++) {
    for (let i = -HALF; i < HALF; i++) {
        if (!built.has(cellKey(i, j)) && naturalDistance(i + 0.5, j + 0.5) <= 0) naturalCells.add(cellKey(i, j));
    }
}
const regionOf = (i, j) => built.get(cellKey(i, j)) || (naturalCells.has(cellKey(i, j)) ? 'n' : null);

// ---- objects ------------------------------------------------------------------
const objects = [];
const structure = (data) => objects.push({
    structureId: `structure-${crypto.randomUUID()}`, scruffy: false, level: 0, levelHeight: 2, ...data
});
const occupied = new Set();                     // cells that already hold a prop
function prop(kind, x, z, rot = 0, extra = {}) {
    occupied.add(cellKey(Math.floor(x), Math.floor(z)));
    objects.push({ type: 'prop', kind, rot, position: { x, y: Math.round(ground(x, z).h * 100) / 100, z }, ...extra });
}
const LIGHTS = { torch: { bright: 20, dim: 20, dark: 0 }, brazier: { bright: 30, dim: 30, dark: 0 }, candles: { bright: 5, dim: 5, dark: 0 } };
const lit = (kind, x, z, rot = 0) => prop(kind, x, z, rot, { light: { ...LIGHTS[kind] } });

// What stands on the edge between two regions (a = north/west side, b = south/east).
function edgeKind(key, a, b) {
    if (EDGE_OVERRIDE.has(key)) return EDGE_OVERRIDE.get(key);
    const aBuilt = a && a !== 'n', bBuilt = b && b !== 'n';
    if (!aBuilt && !bBuilt) return (a === 'n') !== (b === 'n') ? 'sight' : null;
    if (aBuilt && bBuilt) {
        if (a === b) return null;
        if (a === 'c' || b === 'c') {
            const room = a === 'c' ? b : a;
            return LOCKED_ROOMS.has(room) ? 'locked' : 'door';
        }
        return 'solid';
    }
    return (a === 'n' || b === 'n') ? null : 'solid';       // built meets cave: an open archway
}
const wallHeightAt = (a, b) => Math.max(roomById.get(a)?.wall || 3, roomById.get(b)?.wall || 3);

function buildWalls() {
    const sight = new Set();                    // unit edges for the invisible cave walls
    const bars = [];
    // Straight masonry runs, one line at a time.
    const scan = (horizontal) => {
        for (let line = -HALF; line <= HALF; line++) {
            let run = null;
            const flush = () => {
                if (!run) return;
                const length = run.kinds.length;
                const data = {
                    type: 'wall', style: 'dungeon', wallHeight: run.height, seed: 1 + objects.length, heightMode: 'terrain',
                    position: horizontal ? { x: run.start, y: 0, z: line } : { x: line, y: 0, z: run.start },
                    bx: horizontal ? length : 0, bz: horizontal ? 0 : length,
                    path: [{ x: 0, z: 0 }, horizontal ? { x: length, z: 0 } : { x: 0, z: length }],
                    ys: run.kinds.map(() => 0)
                };
                if (run.kinds.some(k => k !== 'solid')) {
                    data.segments = run.kinds.map(k => (k === 'solid' ? null : 'door'));
                    if (run.kinds.includes('locked')) data.doors = run.kinds.map(k => (k === 'locked' ? 'locked' : null));
                }
                structure(data);
                run = null;
            };
            for (let t = -HALF; t < HALF; t++) {
                const a = horizontal ? regionOf(t, line - 1) : regionOf(line - 1, t);
                const b = horizontal ? regionOf(t, line) : regionOf(line, t);
                const key = horizontal ? hKey(t, line) : vKey(line, t);
                const kind = edgeKind(key, a, b);
                if (kind === 'sight') sight.add(key);
                if (kind === 'bars') bars.push(horizontal ? { x: t + 0.5, z: line, rot: 0 } : { x: line, z: t + 0.5, rot: 1 });
                const masonry = kind === 'solid' || kind === 'door' || kind === 'locked';
                const height = masonry ? wallHeightAt(a, b) : 0;
                if (!masonry || (run && (run.height !== height || run.kinds.length >= 48))) flush();
                if (masonry) {
                    if (!run) run = { start: t, height, kinds: [] };
                    run.kinds.push(kind);
                    placeTorch(horizontal, line, t, a, b, kind);
                }
            }
            flush();
        }
    };
    scan(true);
    scan(false);
    for (const b of bars) prop('bars', b.x, b.z, b.rot);
    buildSightWalls(sight);
}

// Torches on the masonry, on the room side: every eighth cell of wall in
// rooms, and along one side of the corridors.
const torchQueue = [];
function placeTorch(horizontal, line, t, a, b, kind) {
    if (kind !== 'solid') return;
    const aBuilt = a && a !== 'n', bBuilt = b && b !== 'n';
    if (aBuilt === bBuilt) return;              // room-to-room walls stay bare
    const region = aBuilt ? a : b;
    const corridor = region === 'c';
    if (corridor && aBuilt) return;             // corridors: north and west walls only
    const step = corridor ? 9 : 8;
    if ((((t % step) + step) % step) !== 4) return;
    const cell = horizontal
        ? { i: t, j: aBuilt ? line - 1 : line, rot: aBuilt ? 2 : 0 }
        : { i: aBuilt ? line - 1 : line, j: t, rot: aBuilt ? 1 : 3 };
    torchQueue.push(cell);
}

// Chain the cave-wall edges into bent runs of up to 48 cells.
function buildSightWalls(edges) {
    const ends = (key) => {
        const [o, i, j] = key.split(','); const x = Number(i), z = Number(j);
        return o === 'h' ? [[x, z], [x + 1, z]] : [[x, z], [x, z + 1]];
    };
    const at = (x, z) => [hKey(x - 1, z), hKey(x, z), vKey(x, z - 1), vKey(x, z)].filter(k => edges.has(k));
    while (edges.size) {
        const first = edges.values().next().value;
        edges.delete(first);
        let [[sx, sz], [cx, cz]] = ends(first);
        const corners = [[sx, sz], [cx, cz]];
        let dir = [cx - sx, cz - sz];
        for (let count = 1; count < 48; count++) {
            const options = at(cx, cz);
            if (!options.length) break;
            const next = (k) => { const [p, q] = ends(k); return (p[0] === cx && p[1] === cz) ? q : p; };
            const straight = options.find(k => { const n = next(k); return n[0] - cx === dir[0] && n[1] - cz === dir[1]; });
            const key = straight || options[0];
            edges.delete(key);
            const n = next(key);
            dir = [n[0] - cx, n[1] - cz];
            [cx, cz] = n;
            corners.push(n);
        }
        // Keep only the bends.
        const pathPoints = [{ x: 0, z: 0 }];
        for (let k = 1; k < corners.length; k++) {
            const last = k === corners.length - 1;
            const turn = !last && (corners[k + 1][0] - corners[k][0] !== corners[k][0] - corners[k - 1][0]
                || corners[k + 1][1] - corners[k][1] !== corners[k][1] - corners[k - 1][1]);
            if (last || turn) pathPoints.push({ x: corners[k][0] - sx, z: corners[k][1] - sz });
        }
        const end = pathPoints[pathPoints.length - 1];
        structure({
            type: 'wall', style: 'sight', wallHeight: 4, seed: 1, heightMode: 'terrain',
            position: { x: sx, y: 0, z: sz }, bx: end.x, bz: end.z, path: pathPoints,
            ys: Array.from({ length: corners.length - 1 }, () => 0)
        });
    }
}

// Flagstones: cover each region with as few rectangles as possible.
function buildFloors() {
    const pit = VAULT_PIT;
    const inPit = (i, j) => i + 0.5 > pit.x0 && i + 0.5 < pit.x1 && j + 0.5 > pit.z0 && j + 0.5 < pit.z1;
    const todo = new Set([...built.keys()].filter(k => { const [i, j] = k.split(',').map(Number); return !inPit(i, j); }));
    const sorted = [...todo].map(k => k.split(',').map(Number)).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    for (const [i, j] of sorted) {
        if (!todo.has(cellKey(i, j))) continue;
        const region = built.get(cellKey(i, j));
        const free = (x, z) => todo.has(cellKey(x, z)) && built.get(cellKey(x, z)) === region;
        let cols = 1;
        while (cols < 48 && free(i + cols, j)) cols++;
        let rows = 1;
        grow: while (rows < 48) {
            for (let x = 0; x < cols; x++) if (!free(i + x, j + rows)) break grow;
            rows++;
        }
        for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) todo.delete(cellKey(i + x, j + z));
        structure({
            type: 'floor', style: 'dungeon', seed: 1 + objects.length, heightMode: 'terrain',
            position: { x: i, y: 0, z: j }, cols, rows, ys: Array.from({ length: cols * rows }, () => 0)
        });
    }
    // The bridge: planks laid flat over the chasm.
    structure({
        type: 'floor', style: 'wood', seed: 7, heightMode: 'flat',
        position: { x: BRIDGE.x0, y: 0, z: BRIDGE.z0 }, cols: BRIDGE.cols, rows: BRIDGE.rows,
        ys: Array.from({ length: BRIDGE.cols * BRIDGE.rows }, () => 0)
    });
}

function dressRooms() {
    const mid = (v) => v + 0.5;
    // The shared cell: shackles along the back wall, straw-thin cots, a bucket.
    for (const i of [-61, -59, -57, -55, -53]) prop('shackles', mid(i), mid(-52), 0);
    prop('cot', mid(-61), mid(-48), 0); prop('cot', mid(-59), mid(-48), 0);
    prop('barrel', mid(-53), mid(-46), 0);
    // The empty cell: someone was here before.
    prop('shackles', mid(-50), mid(-52), 0); prop('shackles', mid(-48), mid(-52), 0);
    prop('bones', mid(-48), mid(-50), 1); prop('cot', mid(-51), mid(-48), 0);
    // Guard room.
    prop('table', -53, mid(-42), 0); prop('bench', -53, -41.2, 0);
    prop('crate', mid(-61), mid(-41), 0); prop('crate', mid(-60), mid(-41), 0); prop('barrel', mid(-61), mid(-43), 0);
    prop('chest', mid(-48), mid(-41), 2);
    lit('candles', -53.4, mid(-42), 0);
    // Audience hall: the high seat on a dais of light, pillars down both sides.
    prop('throne', 0, mid(-57), 0);
    lit('brazier', mid(-3), mid(-56), 0); lit('brazier', mid(2), mid(-56), 0);
    for (const j of [-53, -49, -45]) { prop('pillar', mid(-5), mid(j)); prop('pillar', mid(4), mid(j)); }
    lit('brazier', mid(-3), mid(-43), 0); lit('brazier', mid(2), mid(-43), 0);
    // Hatchery: two rows of nests, none of them warm.
    for (const i of [47, 51, 55]) for (const j of [-47, -42]) prop('egg', mid(i), mid(j), (i + j) & 3);
    lit('brazier', mid(51), mid(-45), 0); lit('brazier', mid(45), mid(-39), 0); lit('brazier', mid(58), mid(-49), 0);
    prop('lectern', mid(58), mid(-40), 3);
    // Archive: shelves on the long walls and two rows between them.
    for (let i = -61; i <= -47; i += 2) { prop('bookshelf', mid(i), mid(-22), 0); prop('bookshelf', mid(i), mid(-9), 2); }
    for (const i of [-58, -54, -50]) { prop('bookshelf', mid(i), mid(-18), 0); prop('bookshelf', mid(i), mid(-13), 2); }
    prop('table', -47, mid(-18), 0); lit('candles', -46.6, mid(-18), 0);
    prop('lectern', mid(-46), mid(-12), 1);
    // The crossing.
    for (const [i, j] of [[-5, -19], [4, -19], [-5, -12], [4, -12]]) prop('pillar', mid(i), mid(j));
    lit('brazier', 0, -15, 0);
    // Vault: the stair down is choked, the doors are barred.
    prop('rubble', mid(49), mid(-13), 0); prop('rubble', mid(50), mid(-14), 1); prop('rubble', mid(48), mid(-12), 2);
    prop('chest', mid(54), mid(-20), 3);
    // Cistern: the old columns still stand in the water.
    for (const [x, z] of [[-56, 19], [-49, 19], [-56, 26], [-49, 26]]) prop('pillar', x, z);
    // Feral den.
    for (const [x, z, r] of [[50, 20, 0], [55, 25, 1], [60, 12, 2], [62, 30, 3], [47, 33, 1], [57, 17, 2]]) prop('bones', x, z, r);
    prop('rubble', 45, 24, 0); prop('rubble', 58, 28, 1);
    // Stalagmites hug the cave walls.
    for (const key of naturalCells) {
        const [i, j] = key.split(',').map(Number);
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !regionOf(i + dx, j + dz));
        if (edge && hash2(i, j, 9) < 0.07 && Math.abs(i) + Math.abs(j - 60) > 8 && !occupied.has(key)) {
            prop('stalagmite', mid(i), mid(j), Math.floor(hash2(i, j, 10) * 4));
        }
    }
    // Torches last, so they never land on furniture.
    for (const t of torchQueue) if (!occupied.has(cellKey(t.i, t.j))) lit('torch', mid(t.i), mid(t.j), t.rot);
}

// ---- write ----------------------------------------------------------------------
const mapFile = path.join(savesDir, 'map_state.json');
const state = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const pocket = state.maps && state.maps[pocketKey];
if (!pocket || !pocket.meta || pocket.meta.kind !== 'pocket') {
    console.error(`${pocketKey} is not a pocket map in ${mapFile}`);
    process.exit(1);
}

buildWalls();
buildFloors();
dressRooms();

const kept = {};
for (const [id, object] of Object.entries(pocket.objects || {})) {
    if (object.type !== 'portal') continue;
    kept[id] = { ...object, position: { x: EXIT.x, y: Math.round(ground(EXIT.x, EXIT.z).h * 100) / 100, z: EXIT.z } };
}
pocket.objects = kept;
for (const object of objects) {
    const id = crypto.randomUUID();
    pocket.objects[id] = { ...object, id };
}
pocket.terrain = buildTerrain();

const count = (list, test) => list.filter(test).length;
console.log(`${pocketKey}: ${objects.length} objects (${count(objects, o => o.type === 'wall' && o.style !== 'sight')} walls, `
    + `${count(objects, o => o.style === 'sight')} sight blockers, ${count(objects, o => o.type === 'floor')} floors, `
    + `${count(objects, o => o.type === 'prop')} props, ${count(objects, o => o.light)} lights), ${Object.keys(pocket.terrain.chunks).length} terrain chunks`);

// ---- the campaign side: vision, and a gate where the world portal stands ----------
const GATE_ID = 'building-mage-gate';
// A small stone gatehouse, open to the south, built around the portal on the
// world's own ground (heights baked from the same generator the screens run).
function buildGate(world, settings) {
    for (const [id, object] of Object.entries(world.objects)) {
        if (object.buildingId === GATE_ID || object.gate === GATE_ID) delete world.objects[id];
    }
    const portal = Object.values(world.objects).find(o => o.type === 'portal' && o.target === pocketKey);
    if (!portal) return false;
    const terrain = world.terrain && world.terrain.format === 2 ? world.terrain : null;
    const height = createGround({
        seed: settings.seed, world: settings.world, season: settings.season,
        chunks: terrain ? terrain.chunks : null, water: terrain ? terrain.water : null
    }).height;
    const round = (v) => Math.round(v * 100) / 100;
    const cx = Math.floor(portal.position.x), cz = Math.floor(portal.position.z);
    const x0 = cx - 1, x1 = cx + 2, z0 = cz - 2, z1 = cz + 1;       // 3 x 3 cells inside
    let datum = -Infinity;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) datum = Math.max(datum, height(x, z));
    datum = round(datum);
    const piece = (data) => {
        const id = crypto.randomUUID();
        world.objects[id] = {
            structureId: `structure-${crypto.randomUUID()}`, buildingId: GATE_ID, buildingDatumY: datum,
            style: 'stone', scruffy: false, seed: 3, level: 0, levelHeight: 3, ...data, id
        };
    };
    const run = (ax, az, dx, dz, length) => {
        const y = round(height(ax, az));
        piece({
            type: 'wall', wallHeight: 3, heightMode: 'terrain', position: { x: ax, y, z: az },
            bx: dx * length, bz: dz * length, path: [{ x: 0, z: 0 }, { x: dx * length, z: dz * length }],
            ys: Array.from({ length }, (_, k) => round(height(ax + dx * (k + 0.5), az + dz * (k + 0.5)) - y))
        });
    };
    run(x0, z0, 1, 0, 3);       // back
    run(x0, z0, 0, 1, 3);       // west
    run(x1, z0, 0, 1, 3);       // east
    const fy = round(height(x0 + 1.5, z0 + 1.5));
    piece({
        type: 'floor', heightMode: 'terrain', position: { x: x0, y: fy, z: z0 }, cols: 3, rows: 3,
        ys: Array.from({ length: 9 }, (_, k) => round(height(x0 + (k % 3) + 0.5, z0 + Math.floor(k / 3) + 0.5) - fy))
    });
    piece({
        type: 'roof', level: 1, coversLevel: 0, roofShape: 'flat', pitch: 0.5, heightMode: 'flat',
        position: { x: x0, y: datum + 3, z: z0 }, cols: 3, rows: 3
    });
    for (const x of [x0 - 0.5, x1 + 0.5]) {
        const id = crypto.randomUUID();
        world.objects[id] = {
            type: 'prop', kind: 'brazier', rot: 0, gate: GATE_ID, light: { ...LIGHTS.brazier },
            position: { x, y: round(height(x, z1 + 0.5)), z: z1 + 0.5 }, id
        };
    }
    return true;
}

const campaignArg = arg('--campaign', 2);
if (campaignArg && campaignArg.length === 2) {
    const [registryFile, campaignId] = campaignArg;
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const campaign = registry.campaigns && registry.campaigns[campaignId];
    if (!campaign) { console.error(`campaign ${campaignId} not found in ${registryFile}`); process.exit(1); }
    campaign.settings = campaign.settings || {};
    campaign.settings.vision = { ...(campaign.settings.vision || {}), enabled: true, pockets: 'dark' };
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
    console.log(`${campaign.name}: token vision on, pockets dark`);
    const world = state.maps['@world'];
    console.log(world && buildGate(world, campaign.settings)
        ? 'gate built around the world portal'
        : `no portal to ${pocketKey} on the world map: gate skipped`);
}

fs.copyFileSync(mapFile, mapFile + '.before-dungeon');
fs.writeFileSync(mapFile, JSON.stringify(state, null, 2));
