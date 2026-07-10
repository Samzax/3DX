// structures.js — tile-brush buildings (step 4 of the visual plan): modular wall
// runs and floor patches, Sims-style. The GM drags them out on the tactical grid
// (gm.js build tool) and they sync as ordinary map objects; both screens rebuild
// identical meshes from the synced data here (models.buildObjectFromData), so
// ground heights are BAKED into the data at creation time (ys arrays) — no
// terrain sampling at render time, no GM/player disagreement, and moving a run
// keeps its shape.
//
// Data shapes (coords relative to data.position, which sits on a grid corner):
//   wall:  { type:'wall', style, scruffy, wallHeight, seed,
//            bx, bz,        // run vector in cells, axis-aligned (one of them 0)
//            ys: [...] }    // per-piece ground offsets (n = |bx|+|bz| entries)
//   floor: { type:'floor', style, scruffy, seed, cols, rows,
//            ys: [...] }    // per-tile ground offsets, row-major cols*rows
//
// "Scruffy" is the ruins variant: deterministic per-piece gaps, crumbled
// heights and tilt driven by (seed, index) so every client sees the same decay.

import * as THREE from 'three';
import { GRID_CELL_SIZE } from './scene.js';

export const BUILD_STYLES = {
    stone:   { label: 'Stone',   wall: 0x99948a, post: 0x827c70, floorA: 0x8f8a7f, floorB: 0x847f73 },
    wood:    { label: 'Wood',    wall: 0x8a6a42, post: 0x6a4f2e, floorA: 0x96713f, floorB: 0x876336 },
    plaster: { label: 'Plaster', wall: 0xd9d2c0, post: 0x6a4f2e, floorA: 0xb7b0a0, floorB: 0xaba491 }
};

const WALL_THICKNESS = 0.18;
const POST_SIZE = 0.3;
const EMBED = 0.5;             // pieces sink this far into the ground (no slope gaps)
const CELL = GRID_CELL_SIZE;
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1); // shared, scaled per piece — never dispose

// Deterministic per-piece randomness: the same (seed, i, k) gives the same
// value on every client, so scruffy jitter matches between GM and players.
export function buildRand(seed, i, k) {
    let h = (seed ^ Math.imul(i + 1, 374761393) ^ Math.imul(k + 1, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

function pieceMaterial(color, ghost) {
    const mat = new THREE.MeshLambertMaterial({ color });
    if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
    return mat;
}

// A straight run of wall panels between grid corners, with chunky posts on every
// corner. Children are positioned relative to the run's anchor corner (the
// caller sets group.position from data.position). A zero-length run renders a
// single post — the build tool uses that as its hover marker.
export function buildWallRun(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const h = Math.max(0.4, data.wallHeight || 2);
    const bx = data.bx || 0, bz = data.bz || 0;
    const n = Math.round((Math.abs(bx) + Math.abs(bz)) / CELL);
    const ux = Math.sign(bx), uz = Math.sign(bz);
    const ys = data.ys || [];
    const seed = data.seed || 1;
    const scruffy = !!data.scruffy;
    const group = new THREE.Group();
    const wallMat = pieceMaterial(style.wall, ghost);
    const postMat = pieceMaterial(style.post, ghost);

    for (let i = 0; i < n; i++) {
        if (scruffy && buildRand(seed, i, 1) < 0.15) continue;     // collapsed gap
        const y = ys[i] || 0;
        // On slopes the baked height is the piece's midpoint; extend the embed
        // down to the lowest neighbor so steep runs stay solid (no daylight
        // under panels where the ground falls away toward the next cell).
        const yLo = Math.min(y, ys[i - 1] != null ? ys[i - 1] : y, ys[i + 1] != null ? ys[i + 1] : y);
        const embed = EMBED + (y - yLo);
        let ph = h;
        const m = new THREE.Mesh(UNIT_BOX, wallMat);
        if (scruffy) {
            ph = h * (0.35 + 0.6 * buildRand(seed, i, 2));
            m.rotation.x = (buildRand(seed, i, 3) - 0.5) * 0.12;
            m.rotation.z = (buildRand(seed, i, 4) - 0.5) * 0.12;
        }
        // Panels overlap the posts slightly (1.06 long) so runs read as one wall.
        m.scale.set(ux ? CELL * 1.06 : WALL_THICKNESS, ph + embed, uz ? CELL * 1.06 : WALL_THICKNESS);
        m.position.set(ux * (i + 0.5) * CELL, y - embed + (ph + embed) / 2, uz * (i + 0.5) * CELL);
        m.castShadow = !ghost;
        m.receiveShadow = !ghost;
        group.add(m);
    }
    for (let j = 0; j <= n; j++) {
        if (scruffy && n > 0 && buildRand(seed, j, 5) < 0.1) continue;
        // A post stands where two panels meet: seat it on the higher neighbor.
        const y = Math.max(ys[Math.max(0, j - 1)] || 0, ys[Math.min(Math.max(n - 1, 0), j)] || 0);
        let ph = h + 0.22;
        if (scruffy) ph = (h + 0.22) * (0.45 + 0.55 * buildRand(seed, j, 6));
        const p = new THREE.Mesh(UNIT_BOX, postMat);
        p.scale.set(POST_SIZE, ph + EMBED, POST_SIZE);
        p.position.set(ux * j * CELL, y - EMBED + (ph + EMBED) / 2, uz * j * CELL);
        p.castShadow = !ghost;
        p.receiveShadow = !ghost;
        group.add(p);
    }
    return group;
}

// One merged mesh for the whole patch: per-tile top+skirt boxes with vertex-color
// checker variation, so a 48x48 room is a single draw call.
const _tileColor = new THREE.Color();
const _sideColor = new THREE.Color();
function pushTileBox(arr, cx, cz, top, bottom, half, color) {
    const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
    const side = _sideColor.copy(color).multiplyScalar(0.78);
    const quad = (ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, col) => {
        const base = arr.pos.length / 3;
        arr.pos.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz);
        for (let k = 0; k < 4; k++) { arr.nor.push(nx, ny, nz); arr.col.push(col.r, col.g, col.b); }
        arr.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad(x0, top, z0, x0, top, z1, x1, top, z1, x1, top, z0, 0, 1, 0, color);          // top
    quad(x0, bottom, z0, x0, top, z0, x1, top, z0, x1, bottom, z0, 0, 0, -1, side);    // -z skirt
    quad(x1, bottom, z1, x1, top, z1, x0, top, z1, x0, bottom, z1, 0, 0, 1, side);     // +z skirt
    quad(x0, bottom, z1, x0, top, z1, x0, top, z0, x0, bottom, z0, -1, 0, 0, side);    // -x skirt
    quad(x1, bottom, z0, x1, top, z0, x1, top, z1, x1, bottom, z1, 1, 0, 0, side);     // +x skirt
}

export function buildFloorPatch(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const cols = Math.max(1, data.cols | 0), rows = Math.max(1, data.rows | 0);
    const ys = data.ys || [];
    const seed = data.seed || 1;
    const scruffy = !!data.scruffy;
    const colA = new THREE.Color(style.floorA), colB = new THREE.Color(style.floorB);
    const arr = { pos: [], nor: [], col: [], idx: [] };
    for (let tz = 0; tz < rows; tz++) {
        for (let tx = 0; tx < cols; tx++) {
            const i = tz * cols + tx;
            if (scruffy && buildRand(seed, i, 11) < 0.14) continue;  // missing tiles
            let top = (ys[i] || 0) + 0.07;
            if (scruffy) top += (buildRand(seed, i, 12) - 0.5) * 0.08;
            _tileColor.copy(((tx + tz) & 1) ? colB : colA);
            _tileColor.offsetHSL(0, 0, (buildRand(seed, i, 13) - 0.5) * (scruffy ? 0.22 : 0.10));
            pushTileBox(arr, (tx + 0.5) * CELL, (tz + 0.5) * CELL, top, top - EMBED, CELL * 0.49, _tileColor);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
    geo.setIndex(arr.idx);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !ghost;
    mesh.userData.ownGeometry = true;  // merged per-patch geometry — safe to dispose
    return mesh;
}

// Free GPU resources of a built wall/floor (used for the build tool's ghost
// preview, which is rebuilt on every snap change). Shared unit-box geometry is
// skipped; only per-object merged geometry (ownGeometry) and materials go.
export function disposeBuiltObject(obj) {
    obj.traverse(o => {
        if (o.userData.ownGeometry && o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
}
