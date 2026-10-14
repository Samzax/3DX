// structures.js — tile-brush buildings (step 4 of the visual plan): modular wall
// runs, floor patches, staircases and roof/ceiling covers, Sims-style. The GM drags them on the tactical grid
// (gm.js build tool) and they sync as ordinary map objects; both screens rebuild
// identical meshes from the synced data here (models.buildObjectFromData), so
// ground heights are BAKED into the data at creation time (ys arrays) — no
// terrain sampling at render time, no GM/player disagreement, and moving a run
// keeps its shape.
//
// Every newly-authored piece also carries two stable identities:
//   buildingId      groups explicitly-related pieces across storeys
//   structureId     identifies this piece independently of its persisted map-object id
//   buildingDatumY  is the shared ground datum used to align fixed storeys
// Legacy pieces may omit both. They are never grouped by proximity; the GM can
// explicitly adopt them into a building from the Build panel.
//
// Data shapes (coords relative to data.position, which sits on a grid corner):
//   wall:  { type:'wall', style, scruffy, wallHeight, seed,
//            level, levelHeight, heightMode:'terrain'|'flat',
//            bx, bz,        // endpoint vector in world cells (legacy straight run)
//            path: [{x,z}], // optional relative orthogonal corners; starts at 0,0
//            ys: [...],     // per-piece ground offsets in path order
//            segments: [...], // optional per-cell 'door'|'window'|'gap'|'solid'
//            doors: [...] }   // optional per-cell 'open'|'locked' for door cells
//                             // (a closed door blocks sight: shared/vision.js)
//   floor: { type:'floor', style, scruffy, seed, cols, rows,
//            level, levelHeight, heightMode:'terrain'|'flat',
//            ys: [...],     // per-tile ground offsets, row-major cols*rows
//            tiles: [...] } // optional per-cell 'gap'|'solid' edit mask
//   stair: { type:'stair', style, scruffy, seed, level, toLevel,
//            levelHeight, bx, bz, rise, width }
//   roof:  { type:'roof', style, scruffy, seed, level, coversLevel,
//            levelHeight, roofShape:'flat'|'gable-x'|'gable-z'|'hip',
//            pitch, cols, rows,
//            tiles: [...] } // optional per-cell 'gap'|'solid' edit mask
//
// "Scruffy" is the ruins variant: deterministic per-piece gaps, crumbled
// heights and tilt driven by (seed, index) so every client sees the same decay.

import * as THREE from 'three';
import { GRID_CELL_SIZE } from './scene.js';

export const BUILD_STYLES = {
    stone:   {
        label: 'Stone', wall: 0x99948a, wallFace: 0xaaa59b, post: 0x827c70,
        wallPattern: 'stone', trim: 0x746f65,
        floorA: 0x8f8a7f, floorB: 0x847f73, ceiling: 0xb7b3aa,
        roofA: 0x4d5868, roofB: 0x3e4755
    },
    wood:    {
        label: 'Wood', wall: 0x8a6a42, wallFace: 0x9e7a4b, post: 0x6a4f2e,
        wallPattern: 'wood', trim: 0x5b4126,
        floorA: 0x96713f, floorB: 0x876336, ceiling: 0xa98558,
        roofA: 0x754733, roofB: 0x5f3728
    },
    plaster: {
        label: 'Plaster', wall: 0xd9d2c0, wallFace: 0xe7e1d2, post: 0x6a4f2e,
        wallPattern: 'plaster', trim: 0x5f452a,
        floorA: 0xb7b0a0, floorB: 0xaba491, ceiling: 0xe1dccf,
        roofA: 0x98513e, roofB: 0x7f4033
    },
    // Underground masonry: the same courses and flagstones as Stone, dark and
    // cold, for dungeons cut into rock.
    dungeon: {
        label: 'Dungeon', wall: 0x57534f, wallFace: 0x66625d, post: 0x403d3a,
        wallPattern: 'stone', trim: 0x2e2c2a,
        floorA: 0x5f5b56, floorB: 0x55514c, ceiling: 0x45423f,
        roofA: 0x34373d, roofB: 0x292c31
    },
    // A wall with no body: it only blocks sight and light (shared/vision.js).
    // The GM draws it along cave walls, cliffs and hedges the terrain cannot
    // model; players never see it, only what it hides.
    sight: {
        label: 'Sight blocker', wall: 0x99948a, wallFace: 0xaaa59b, post: 0x827c70,
        wallPattern: 'stone', trim: 0x746f65,
        floorA: 0x8f8a7f, floorB: 0x847f73, ceiling: 0xb7b3aa,
        roofA: 0x4d5868, roofB: 0x3e4755
    }
};

// Sight blockers draw as translucent panels on the GM screen only.
let sightBlockersShown = false;
export function showSightBlockers(shown) { sightBlockersShown = !!shown; }

// One world unit is one 5-foot tactical cell, so a two-unit storey is 10 feet.
// The value is copied into new structure records: old and new buildings can use
// different storey heights without changing shape when the author's dial moves.
export const DEFAULT_LEVEL_HEIGHT = 2;
export const STRUCTURE_EDIT_PICK_LAYER = 2;
// Kept as an alias for older imports while floor/roof cells join this layer.
export const WALL_SEGMENT_PICK_LAYER = STRUCTURE_EDIT_PICK_LAYER;

let structureIdentityCounter = 0;

// IDs are generated before persistence so a piece retains its identity if the
// server-side map-object id changes (for example during a storey duplicate).
// The fallback exists for older/insecure browser contexts without randomUUID.
export function newStructureIdentity(kind = 'structure') {
    const prefix = kind === 'building' ? 'building' : 'structure';
    const randomUUID = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${(++structureIdentityCounter).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}-${randomUUID}`;
}

export function structureBuildingId(data) {
    const value = data && typeof data.buildingId === 'string' ? data.buildingId.trim() : '';
    return value || null;
}

export function structurePieceId(data) {
    const value = data && typeof data.structureId === 'string' ? data.structureId.trim() : '';
    return value || null;
}

function explicitBuildingDatum(data) {
    const raw = data && data.buildingDatumY;
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export function structureLevel(data) {
    const n = Number(data && data.level);
    return Number.isFinite(n) ? Math.round(n) : 0;
}

export function structureStairRiseCompatible(data, expectedLevelHeight = DEFAULT_LEVEL_HEIGHT, tolerance = 0.001) {
    if (!data || data.type !== 'stair') return true;
    const rise = Object.prototype.hasOwnProperty.call(data, 'rise')
        ? Number(data.rise) : DEFAULT_LEVEL_HEIGHT;
    const expected = Number(expectedLevelHeight);
    const direction = Math.sign(rise);
    const level = structureLevel(data);
    const toLevel = Object.prototype.hasOwnProperty.call(data, 'toLevel')
        ? Number(data.toLevel) : level + direction;
    return Number.isFinite(rise) && Number.isFinite(expected) && Number.isFinite(toLevel)
        && direction !== 0 && Math.round(toLevel) === level + direction
        && Math.abs(Math.abs(rise) - expected) <= tolerance;
}

export function structureRoofLevelCompatible(data) {
    if (!data || data.type !== 'roof') return true;
    const level = structureLevel(data);
    const coversLevel = Object.prototype.hasOwnProperty.call(data, 'coversLevel')
        ? Number(data.coversLevel) : level - 1;
    return Number.isFinite(coversLevel) && Math.round(coversLevel) === level - 1;
}

export function structureHeightModeCompatible(data) {
    if (!data || data.heightMode !== 'terrain') return true;
    return structureLevel(data) === 0 && (data.type === 'wall' || data.type === 'floor');
}

// A roof is stored at the datum above the room it covers, but semantically it
// belongs to that covered storey. Stairs belong to their starting storey; their
// toLevel is shifted by the same delta when the storey is duplicated.
export function structureStoreyLevel(data) {
    const level = structureLevel(data);
    if (!data || data.type !== 'roof') return level;
    const covered = Number(data.coversLevel);
    return Number.isFinite(covered) ? Math.round(covered) : level - 1;
}

export function structureBelongsToStorey(data, level) {
    const wanted = Number(level);
    return Number.isFinite(wanted) && structureStoreyLevel(data) === Math.round(wanted);
}

// Resolve a piece's building datum without treating a persisted null as zero.
// Modern grouped pieces carry an explicit datum. Legacy pieces derive it from
// their stored anchor and level so the GM can explicitly adopt them.
export function structureBuildingDatum(data, positionY = data && data.position && data.position.y) {
    const explicit = explicitBuildingDatum(data);
    if (explicit != null) return explicit;
    const levelHeight = Number(data && data.levelHeight) > 0
        ? Number(data.levelHeight) : DEFAULT_LEVEL_HEIGHT;
    const y = Number(positionY);
    return (Number.isFinite(y) ? y : 0) - structureLevel(data) * levelHeight;
}

// A terrain-following legacy ground piece may legitimately have an anchor Y
// different from the building datum. Fixed/non-ground pieces must already line
// up, and modern grouped pieces must retain both their persisted datum and the
// anchor implied by that datum.
export function structureDatumCompatible(data, buildingDatumY,
    positionY = data && data.position && data.position.y, tolerance = 0.001) {
    if (buildingDatumY == null || buildingDatumY === '') return false;
    const expected = Number(buildingDatumY);
    if (!Number.isFinite(expected)) return false;
    const explicit = explicitBuildingDatum(data);
    if (explicit != null && Math.abs(explicit - expected) > tolerance) return false;
    if (structureLevel(data) === 0 && data && data.heightMode === 'terrain') return true;
    const levelHeight = Number(data && data.levelHeight) > 0
        ? Number(data.levelHeight) : DEFAULT_LEVEL_HEIGHT;
    const y = Number(positionY);
    const derived = (Number.isFinite(y) ? y : 0) - structureLevel(data) * levelHeight;
    return Math.abs(derived - expected) <= tolerance;
}

// Canonical duplicate-storey transform shared by browser tests and the server
// implementation contract. The persisted map-object id and server-stamped
// fields are deliberately removed; buildingId stays stable, while structureId
// must be remapped for the new piece.
export function duplicateStructureToStorey(data, destinationLevel, {
    buildingId = structureBuildingId(data),
    structureId = newStructureIdentity('structure'),
    buildingDatumY = explicitBuildingDatum(data)
} = {}) {
    if (!data || !isStructureType(data.type)) return null;
    const destination = Number(destinationLevel);
    if (!Number.isFinite(destination)) return null;
    const toStorey = Math.round(destination);
    const fromStorey = structureStoreyLevel(data);
    const delta = toStorey - fromStorey;
    if (!delta || !buildingId) return null;
    const levelHeight = Number(data.levelHeight) > 0
        ? Number(data.levelHeight) : DEFAULT_LEVEL_HEIGHT;
    const sourcePosition = data.position || {};
    // Modern pieces persist the common building datum. For a legacy source,
    // cautiously derive one from that selected piece's stored level and anchor;
    // callers should persist/confirm this datum when explicitly adopting it.
    const datumY = Number.isFinite(buildingDatumY)
        ? buildingDatumY
        : structureBuildingDatum(data, sourcePosition.y);
    const destinationStoredLevel = data.type === 'roof' ? toStorey + 1 : toStorey;
    const clone = {
        ...data,
        buildingId,
        structureId,
        buildingDatumY: datumY,
        // A duplicate is a fixed copy. It must not re-sample terrain later even
        // when its source was a terrain-following ground storey.
        heightMode: 'flat',
        position: {
            x: Number(sourcePosition.x) || 0,
            y: datumY + destinationStoredLevel * levelHeight,
            z: Number(sourcePosition.z) || 0
        }
    };
    delete clone.id;
    delete clone.addedBy;
    if (Array.isArray(data.path)) clone.path = data.path.map(point => ({ ...point }));
    // Terrain-following sources can have a different anchor and per-cell Y
    // offsets for every piece. A fixed destination storey is planar by design.
    if (Array.isArray(data.ys)) clone.ys = data.ys.map(() => 0);
    if (Array.isArray(data.segments)) clone.segments = data.segments.slice();
    if (Array.isArray(data.tiles)) clone.tiles = data.tiles.slice();
    if (data.type === 'roof') {
        clone.coversLevel = toStorey;
        clone.level = toStorey + 1;
    } else {
        clone.level = toStorey;
        if (data.type === 'stair') {
            const sourceToLevel = Number.isFinite(Number(data.toLevel))
                ? Math.round(Number(data.toLevel))
                : fromStorey + Math.sign(Number(data.rise) || 1);
            clone.toLevel = sourceToLevel + delta;
        }
    }
    return clone;
}

export function structureTouchesLevel(data, level) {
    if (!data) return false;
    const here = structureLevel(data);
    if (data.type !== 'stair') return here === level;
    const there = Number.isFinite(Number(data.toLevel)) ? Math.round(Number(data.toLevel)) : here + Math.sign(Number(data.rise) || 1);
    return here === level || there === level;
}

export function isStructureType(type) {
    return type === 'wall' || type === 'floor' || type === 'stair' || type === 'roof';
}

const WALL_THICKNESS = 0.24;
const WALL_FACE_THICKNESS = 0.30;
const WALL_FRAME_THICKNESS = 0.32;
const POST_SIZE = 0.32;
const POST_CAP_SIZE = 0.38;
const EMBED = 0.5;             // pieces sink this far into the ground (no slope gaps)
const FLOOR_SLAB = 0.16;       // flat/elevated floors are slabs, not buried terrain tiles
const ROOF_EAVE = 0.24;        // covers the wall-run posts that stand 0.22 above panels
const CELL = GRID_CELL_SIZE;
const WALL_SEGMENT_KINDS = new Set(['door', 'window', 'gap', 'solid']);
const STRUCTURE_TILE_LIMIT = 48;
const STRUCTURE_TILE_KINDS = new Set(['gap', 'solid']);

const structureGridDimension = value => Math.max(1, Math.min(STRUCTURE_TILE_LIMIT, Number(value) | 0));

export function structureTileCount(data) {
    if (!data || (data.type !== 'floor' && data.type !== 'roof')) return 0;
    return structureGridDimension(data.cols) * structureGridDimension(data.rows);
}

function structureTileKind(data, index) {
    const kind = Array.isArray(data.tiles) ? data.tiles[index] : null;
    return STRUCTURE_TILE_KINDS.has(kind) ? kind : null;
}

const snapWallCoord = value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number / CELL) * CELL : 0;
};

// Produce the clean one-bend path used by the GM drag gesture. The first
// snapped movement locks the first leg axis, so dragging straight and then
// turning creates a stable L instead of a diagonal staircase. Total length is
// bounded across both legs.
export function wallGesturePath(anchor, target, firstAxis = null, maxCells = 48) {
    const a = { x: snapWallCoord(anchor?.x), z: snapWallCoord(anchor?.z) };
    const b = { x: snapWallCoord(target?.x), z: snapWallCoord(target?.z) };
    const dx = Math.round((b.x - a.x) / CELL);
    const dz = Math.round((b.z - a.z) / CELL);
    if (!dx && !dz) return { axis: null, points: [a] };

    const axis = firstAxis === 'x' || firstAxis === 'z'
        ? firstAxis
        : Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
    const limit = Math.max(1, Math.min(48, Math.round(Number(maxCells) || 48)));
    const primary = axis === 'x' ? dx : dz;
    const secondary = axis === 'x' ? dz : dx;
    const primaryCells = Math.min(Math.abs(primary), limit);
    const secondaryCells = Math.min(Math.abs(secondary), limit - primaryCells);
    const corner = axis === 'x'
        ? { x: a.x + Math.sign(primary) * primaryCells * CELL, z: a.z }
        : { x: a.x, z: a.z + Math.sign(primary) * primaryCells * CELL };
    const end = axis === 'x'
        ? { x: corner.x, z: corner.z + Math.sign(secondary) * secondaryCells * CELL }
        : { x: corner.x + Math.sign(secondary) * secondaryCells * CELL, z: corner.z };
    const points = [a];
    if (corner.x !== a.x || corner.z !== a.z) points.push(corner);
    if (end.x !== corner.x || end.z !== corner.z) points.push(end);
    return { axis, points };
}

// Normalize either a new orthogonal path record or a legacy bx/bz straight
// run. Malformed diagonal waypoints are deterministically split X then Z, and
// no record can expand beyond 48 wall cells on a client.
export function wallPathPoints(data) {
    const raw = Array.isArray(data?.path) && data.path.length
        ? data.path
        : [{ x: 0, z: 0 }, { x: data?.bx, z: data?.bz }];
    const points = [{ x: 0, z: 0 }];
    let used = 0;
    const appendLeg = (axis, target) => {
        if (used >= 48) return;
        const here = points[points.length - 1];
        const delta = axis === 'x' ? target.x - here.x : target.z - here.z;
        const cells = Math.min(Math.round(Math.abs(delta) / CELL), 48 - used);
        if (!cells) return;
        const next = { ...here };
        next[axis] += Math.sign(delta) * cells * CELL;
        points.push(next);
        used += cells;
    };

    for (let i = 0; i < raw.length && i <= 48; i++) {
        const point = raw[i];
        if (used >= 48) break;
        if (!point) continue;
        const target = { x: snapWallCoord(point.x), z: snapWallCoord(point.z) };
        appendLeg('x', target);
        appendLeg('z', target);
    }
    return points;
}

function wallCells(data) {
    const points = wallPathPoints(data);
    const cells = [];
    for (let p = 1; p < points.length; p++) {
        const a = points[p - 1], b = points[p];
        const dx = Math.round((b.x - a.x) / CELL);
        const dz = Math.round((b.z - a.z) / CELL);
        const count = Math.abs(dx) + Math.abs(dz);
        const ux = Math.sign(dx), uz = Math.sign(dz);
        for (let i = 0; i < count && cells.length < 48; i++) {
            cells.push({ x: a.x + ux * i * CELL, z: a.z + uz * i * CELL, ux, uz });
        }
    }
    return cells;
}

export function wallSegmentCount(data) {
    return wallCells(data).length;
}
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1); // shared, scaled per piece — never dispose

// Deterministic per-piece randomness: the same (seed, i, k) gives the same
// value on every client, so scruffy jitter matches between GM and players.
export function buildRand(seed, i, k) {
    let h = (seed ^ Math.imul(i + 1, 374761393) ^ Math.imul(k + 1, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

// Tiny generated surface maps break up the old flat-color boxes without adding
// asset files or extra geometry. Box UVs give each one-cell panel one repeat.
const wallTextureCache = new Map();
function wallPatternTexture(pattern) {
    if (wallTextureCache.has(pattern)) return wallTextureCache.get(pattern);
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (pattern === 'stone') {
        ctx.fillStyle = '#777';
        ctx.fillRect(0, 0, 96, 96);
        const courseH = 23;
        for (let row = 0; row < 4; row++) {
            const y = row * 24 + 1;
            const offset = row & 1 ? -16 : 0;
            for (let col = -1; col < 4; col++) {
                const shade = 190 + ((row * 19 + col * 13 + 256) % 28);
                ctx.fillStyle = `rgb(${shade},${shade - 3},${shade - 8})`;
                ctx.fillRect(offset + col * 32 + 1, y, 30, courseH);
            }
        }
    } else if (pattern === 'wood') {
        ctx.fillStyle = '#c9c1b5';
        ctx.fillRect(0, 0, 96, 96);
        for (let col = 0; col < 6; col++) {
            const x = col * 16;
            const shade = 184 + (col % 3) * 12;
            ctx.fillStyle = `rgb(${shade + 10},${shade},${shade - 18})`;
            ctx.fillRect(x + 1, 0, 14, 96);
            ctx.fillStyle = 'rgba(70,48,28,.28)';
            ctx.fillRect(x, 0, 1, 96);
            for (let y = 7 + (col * 11) % 19; y < 96; y += 23) {
                ctx.fillStyle = 'rgba(82,55,30,.20)';
                ctx.fillRect(x + 3, y, 10, 1);
            }
        }
    } else {
        ctx.fillStyle = '#ece9df';
        ctx.fillRect(0, 0, 96, 96);
        for (let i = 0; i < 96; i++) {
            const x = (i * 37 + 11) % 96;
            const y = (i * 61 + 17) % 96;
            const shade = 185 + (i % 5) * 9;
            ctx.fillStyle = `rgba(${shade},${shade - 3},${shade - 8},.22)`;
            ctx.fillRect(x, y, i % 7 === 0 ? 2 : 1, 1);
        }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    if (THREE.sRGBEncoding != null) texture.encoding = THREE.sRGBEncoding;
    wallTextureCache.set(pattern, texture);
    return texture;
}

// Floors and roofs are merged vertex-colored boxes — one flat color per cell.
// This paints the material onto them in the shader (object space, so it is
// identical on every client and costs no geometry or saved data): flagstone
// joints, floorboards or tiles on anything facing up, and courses of
// staggered shingles on pitched roofs. `pattern` is the style's wallPattern.
function applySurfaceDetail(mat, kind, pattern) {
    const code = kind === 'roof' ? 3 : pattern === 'wood' ? 1 : pattern === 'plaster' ? 2 : 0;
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;\nvarying vec3 vSurfNor;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfPos = position;\nvSurfNor = normal;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vSurfPos;',
                'varying vec3 vSurfNor;',
                'float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
                'float sLine(float f, float w) { return smoothstep(0.0, w, f) * smoothstep(0.0, w, 1.0 - f); }'
            ].join('\n'))
            .replace('#include <color_fragment>', [
                '#include <color_fragment>',
                `const int SURF = ${code};`,
                `vec2 sp = vSurfPos.xz / ${CELL.toFixed(3)};`,
                'vec3 sn = normalize(vSurfNor);',
                'float sShade = 1.0;',
                'if (SURF == 3 && sn.y > 0.15 && sn.y < 0.985) {',
                // Shingle courses step down the slope; joints stagger row to row.
                '  float course = vSurfPos.y * 4.6;',
                '  float row = floor(course), up = fract(course);',
                '  float along = (abs(sn.x) > abs(sn.z) ? vSurfPos.z : vSurfPos.x) * 3.2 + mod(row, 2.0) * 0.5;',
                '  sShade = (1.0 - 0.30 * smoothstep(0.62, 1.0, up)) * (0.80 + 0.2 * sLine(fract(along), 0.07));',
                '  sShade *= 0.88 + 0.24 * sHash(vec2(row, floor(along)));',
                '} else if (sn.y > 0.5) {',
                '  if (SURF == 1) {',
                // Floorboards: four to a cell, butt joints at staggered lengths.
                '    float board = floor(sp.y * 4.0);',
                '    float run = sp.x * 0.45 + sHash(vec2(board, 3.0)) * 5.0;',
                '    sShade = (0.70 + 0.3 * sLine(fract(sp.y * 4.0), 0.07)) * (0.82 + 0.18 * sLine(fract(run), 0.012));',
                '    sShade *= 0.88 + 0.22 * sHash(vec2(board, floor(run)));',
                '  } else if (SURF == 2) {',
                // Square tiles, two to a cell, with pale grout.
                '    vec2 t = fract(sp * 2.0);',
                '    sShade = (0.74 + 0.26 * sLine(t.x, 0.05) * sLine(t.y, 0.05)) * (0.93 + 0.12 * sHash(floor(sp * 2.0)));',
                '  } else {',
                // Flagstones: one slab per cell, some split in two, worn mottling.
                '    vec2 cell = floor(sp), f = fract(sp);',
                '    float split = step(0.55, sHash(cell + 11.0));',
                '    float halfF = mix(f.x, fract(f.x * 2.0), split * step(0.5, sHash(cell + 5.0)));',
                '    float halfG = mix(f.y, fract(f.y * 2.0), split * (1.0 - step(0.5, sHash(cell + 5.0))));',
                '    sShade = 0.66 + 0.34 * sLine(halfF, 0.045) * sLine(halfG, 0.045);',
                '    sShade *= 0.9 + 0.2 * sHash(floor(vSurfPos.xz * 7.0));',
                '  }',
                '}',
                'diffuseColor.rgb *= sShade;'
            ].join('\n'));
    };
    mat.customProgramCacheKey = () => `structure-surface-${code}`;
}

function pieceMaterial(color, ghost, map = null) {
    const mat = new THREE.MeshLambertMaterial({ color, map });
    if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
    return mat;
}

// An orthogonal run of wall panels between grid corners, with chunky posts on
// every cell boundary and turn. New records may carry a one-bend path; legacy
// bx/bz records still rebuild as their original straight run. Children are
// positioned relative to the run's anchor corner (the caller sets
// group.position from data.position). A zero-length run renders a single post
// for the build tool's hover marker.
export function buildWallRun(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const h = Math.max(0.4, data.wallHeight || 2);
    const path = wallPathPoints(data);
    const cells = wallCells(data);
    const n = cells.length;
    const ys = data.ys || [];
    const seed = data.seed || 1;
    const scruffy = !!data.scruffy;
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const doors = Array.isArray(data.doors) ? data.doors : [];
    const sight = data.style === 'sight';
    const sightMat = sight && (sightBlockersShown || ghost) ? new THREE.MeshBasicMaterial({
        color: 0xff4fd8, transparent: true, opacity: ghost ? 0.3 : 0.2, depthWrite: false, side: THREE.DoubleSide
    }) : null;
    const group = new THREE.Group();
    const wallTexture = wallPatternTexture(style.wallPattern);
    const wallMat = pieceMaterial(style.wall, ghost, wallTexture);
    const faceMat = pieceMaterial(style.wallFace || style.wall, ghost, wallTexture);
    const postMat = pieceMaterial(style.post, ghost);
    const trimMat = pieceMaterial(style.trim || style.post, ghost);
    const doorMat = pieceMaterial(0x65482f, ghost);
    const windowMat = new THREE.MeshLambertMaterial({
        color: 0x9ac8d8,
        transparent: true,
        opacity: ghost ? 0.22 : 0.42,
        depthWrite: false,
        side: THREE.DoubleSide
    });
    let detailCount = 0;
    const pickMat = ghost ? null : new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
        side: THREE.DoubleSide
    });

    const tag = (object, segment) => {
        object.userData.wallSegment = segment;
        return object;
    };
    const addPanel = (segment, length, height, bottom, material = wallMat, alongOffset = 0, thickness = WALL_THICKNESS) => {
        if (height <= 0) return null;
        const cell = cells[segment];
        if (!cell) return null;
        const { x, z, ux, uz } = cell;
        const m = tag(new THREE.Mesh(UNIT_BOX, material), segment);
        const along = CELL * 0.5 + alongOffset;
        m.scale.set(ux ? length : thickness, height, uz ? length : thickness);
        m.position.set(x + ux * along, bottom + height / 2, z + uz * along);
        m.castShadow = !ghost;
        m.receiveShadow = !ghost;
        group.add(m);
        return m;
    };

    for (let i = 0; i < n; i++) {
        const { x, z, ux, uz } = cells[i];
        const rawKind = WALL_SEGMENT_KINDS.has(segments[i]) ? segments[i] : null;
        const kind = rawKind || 'solid';
        const y = ys[i] || 0;
        // On slopes the baked height is the piece's midpoint; extend the embed
        // down to the lowest neighbor so steep runs stay solid (no daylight
        // under panels where the ground falls away toward the next cell).
        const yLo = Math.min(y, ys[i - 1] != null ? ys[i - 1] : y, ys[i + 1] != null ? ys[i + 1] : y);
        const embed = EMBED + (y - yLo);

        if (sight) {
            const blocks = kind === 'solid' || (kind === 'door' && doors[i] !== 'open');
            const panel = blocks && sightMat ? addPanel(i, CELL, h, y, sightMat, 0, 0.05) : null;
            if (panel) { panel.castShadow = false; panel.receiveShadow = false; }
        } else if (kind === 'solid' && !(scruffy && rawKind !== 'solid' && buildRand(seed, i, 1) < 0.15)) {
            let ph = h;
            const m = addPanel(i, CELL * 1.06, ph + embed, y - embed);
            if (scruffy) {
                ph = h * (0.35 + 0.6 * buildRand(seed, i, 2));
                m.scale.y = ph + embed;
                m.position.y = y - embed + (ph + embed) / 2;
                m.rotation.x = (buildRand(seed, i, 3) - 0.5) * 0.12;
                m.rotation.z = (buildRand(seed, i, 4) - 0.5) * 0.12;
            } else {
                // A raised face leaves a visible border of the thicker core,
                // giving each cell a readable architectural panel from either
                // side without changing collision/picker behavior.
                const border = Math.min(0.14, ph * 0.18);
                addPanel(i, CELL * 0.76, Math.max(0.12, ph - border * 2),
                    y + border, faceMat, 0, WALL_FACE_THICKNESS);
                detailCount++;
            }
        } else if (kind === 'door') {
            const doorH = Math.max(0.28, Math.min(h - 0.12, h * 0.78));
            const doorW = CELL * 0.66;
            const frameW = CELL * 0.09;
            addPanel(i, CELL * 1.06, h - doorH, y + doorH);
            addPanel(i, frameW, doorH, y, trimMat, -(doorW + frameW) / 2, WALL_FRAME_THICKNESS);
            addPanel(i, frameW, doorH, y, trimMat, (doorW + frameW) / 2, WALL_FRAME_THICKNESS);
            addPanel(i, doorW + frameW * 2, frameW, y + doorH - frameW / 2,
                trimMat, 0, WALL_FRAME_THICKNESS);
            detailCount += 3;

            // The leaf hangs shut in its frame until someone opens the door:
            // a closed door blocks sight, an open one swings clear of the
            // doorway. The invisible segment picker still fills the cell.
            const pivot = tag(new THREE.Group(), i);
            const hingeAlong = CELL * 0.5 - doorW / 2;
            pivot.position.set(x + ux * hingeAlong, y + 0.025, z + uz * hingeAlong);
            pivot.rotation.y = doors[i] === 'open' ? (ux ? -ux : uz) * Math.PI * 0.47 : 0;
            pivot.userData.doorLeaf = true;
            const leaf = tag(new THREE.Mesh(UNIT_BOX, doorMat), i);
            leaf.scale.set(ux ? doorW : 0.075, doorH * 0.94, uz ? doorW : 0.075);
            leaf.position.set(ux * doorW / 2, doorH * 0.47, uz * doorW / 2);
            leaf.castShadow = !ghost;
            leaf.receiveShadow = !ghost;
            pivot.add(leaf);
            if (doors[i] === 'locked') {
                // An iron bar across the leaf: this door will not open for players.
                const bar = tag(new THREE.Mesh(UNIT_BOX, pieceMaterial(0x2c2f36, ghost)), i);
                bar.scale.set(ux ? doorW * 1.08 : 0.13, 0.09, uz ? doorW * 1.08 : 0.13);
                bar.position.set(ux * doorW / 2, doorH * 0.5, uz * doorW / 2);
                pivot.add(bar);
            }
            group.add(pivot);
        } else if (kind === 'window') {
            const sill = Math.max(0.16, h * 0.30);
            const openingTop = Math.max(sill + 0.1, Math.min(h - 0.12, h * 0.74));
            const openingH = openingTop - sill;
            const frameH = Math.min(0.08, openingH * 0.24);
            const paneW = CELL * 0.68;
            addPanel(i, CELL * 1.06, sill + embed, y - embed);
            addPanel(i, CELL * 1.06, h - openingTop, y + openingTop);
            addPanel(i, paneW + 0.12, frameH, y + sill - frameH / 2,
                trimMat, 0, WALL_FRAME_THICKNESS);
            addPanel(i, paneW + 0.12, frameH, y + openingTop - frameH / 2,
                trimMat, 0, WALL_FRAME_THICKNESS);
            addPanel(i, 0.07, openingH, y + sill, trimMat, -paneW / 2, WALL_FRAME_THICKNESS);
            addPanel(i, 0.07, openingH, y + sill, trimMat, paneW / 2, WALL_FRAME_THICKNESS);
            addPanel(i, paneW, Math.max(0.04, openingH - frameH), y + sill + frameH / 2,
                windowMat, 0, 0.035);
            detailCount += 4;
        }

        // Keep every cell editable even when its visible panel is an open gap.
        if (pickMat) {
            addPanel(i, CELL * 0.94, h + EMBED, y - EMBED, pickMat, 0,
                WALL_FRAME_THICKNESS).layers.set(STRUCTURE_EDIT_PICK_LAYER);
        }
    }
    const corners = n
        ? [{ x: cells[0].x, z: cells[0].z }, ...cells.map(cell => ({
            x: cell.x + cell.ux * CELL, z: cell.z + cell.uz * CELL
        }))]
        : [path[0] || { x: 0, z: 0 }];
    for (let j = 0; j < corners.length && !sight; j++) {
        const touchesOpening = ['door', 'window', 'gap'].includes(segments[j - 1]) ||
            ['door', 'window', 'gap'].includes(segments[j]);
        if (scruffy && n > 0 && !touchesOpening && buildRand(seed, j, 5) < 0.1) continue;
        // A post stands where two panels meet: seat it on the higher neighbor.
        const y = Math.max(ys[Math.max(0, j - 1)] || 0, ys[Math.min(Math.max(n - 1, 0), j)] || 0);
        let ph = h + 0.22;
        if (scruffy) ph = (h + 0.22) * (0.45 + 0.55 * buildRand(seed, j, 6));
        const p = new THREE.Mesh(UNIT_BOX, postMat);
        if (n > 0) tag(p, Math.min(n - 1, j));
        p.scale.set(POST_SIZE, ph + EMBED, POST_SIZE);
        p.position.set(corners[j].x, y - EMBED + (ph + EMBED) / 2, corners[j].z);
        p.castShadow = !ghost;
        p.receiveShadow = !ghost;
        group.add(p);
        if (!scruffy || buildRand(seed, j, 7) > 0.35) {
            const cap = tag(new THREE.Mesh(UNIT_BOX, trimMat), Math.min(Math.max(n - 1, 0), j));
            const capH = scruffy ? 0.07 : 0.10;
            const capSize = scruffy ? POST_SIZE + 0.03 : POST_CAP_SIZE;
            cap.scale.set(capSize, capH, capSize);
            cap.position.set(corners[j].x, y + ph - capH / 2, corners[j].z);
            cap.castShadow = !ghost;
            cap.receiveShadow = !ghost;
            group.add(cap);
            detailCount++;
        }
    }
    group.userData.wallSegmentCount = n;
    group.userData.wallThickness = WALL_THICKNESS;
    group.userData.wallDetailCount = detailCount;
    group.userData.wallVisualProfile = 'panel-v2';
    return group;
}

// One merged mesh for the whole patch: per-tile top+skirt boxes with vertex-color
// checker variation, so a 48x48 room is a single draw call.
const _tileColor = new THREE.Color();
const _sideColor = new THREE.Color();
const _tilePickerTransform = new THREE.Object3D();

// Edit-only instance boxes retain a row-major cell hit target even when the
// visible floor/roof tile has been cut away. They live off the normal raycast
// layer, so movement, selection and support-surface casts never see them.
function buildStructureTilePicker(cols, rows, transformAt) {
    const count = cols * rows;
    const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
        side: THREE.DoubleSide
    });
    const picker = new THREE.InstancedMesh(UNIT_BOX, material, count);
    picker.layers.set(STRUCTURE_EDIT_PICK_LAYER);
    picker.userData.structureTilePicker = true;
    picker.castShadow = false;
    picker.receiveShadow = false;
    for (let tz = 0; tz < rows; tz++) {
        for (let tx = 0; tx < cols; tx++) {
            const i = tz * cols + tx;
            const transform = transformAt(i, tx, tz);
            _tilePickerTransform.position.set(
                (tx + 0.5) * CELL,
                transform.y,
                (tz + 0.5) * CELL
            );
            _tilePickerTransform.rotation.set(0, 0, 0);
            _tilePickerTransform.scale.set(CELL * 0.96, transform.height, CELL * 0.96);
            _tilePickerTransform.updateMatrix();
            picker.setMatrixAt(i, _tilePickerTransform.matrix);
        }
    }
    picker.instanceMatrix.needsUpdate = true;
    return picker;
}

function pushTileBox(arr, cx, cz, top, bottom, half, color, bottomColor = color) {
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
    quad(x0, bottom, z1, x0, bottom, z0, x1, bottom, z0, x1, bottom, z1, 0, -1, 0, bottomColor); // ceiling
}

export function buildFloorPatch(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const cols = structureGridDimension(data.cols), rows = structureGridDimension(data.rows);
    const ys = data.ys || [];
    const seed = data.seed || 1;
    const scruffy = !!data.scruffy;
    const colA = new THREE.Color(style.floorA), colB = new THREE.Color(style.floorB);
    const ceilingColor = new THREE.Color(style.ceiling);
    const arr = { pos: [], nor: [], col: [], idx: [] };
    for (let tz = 0; tz < rows; tz++) {
        for (let tx = 0; tx < cols; tx++) {
            const i = tz * cols + tx;
            const tileKind = structureTileKind(data, i);
            if (tileKind === 'gap') continue;
            // Explicit restoration wins over deterministic ruin damage.
            if (scruffy && tileKind !== 'solid' && buildRand(seed, i, 11) < 0.14) continue;
            let top = (ys[i] || 0) + 0.07;
            if (scruffy) top += (buildRand(seed, i, 12) - 0.5) * 0.08;
            _tileColor.copy(((tx + tz) & 1) ? colB : colA);
            _tileColor.offsetHSL(0, 0, (buildRand(seed, i, 13) - 0.5) * (scruffy ? 0.22 : 0.10));
            const thickness = data.heightMode === 'flat' ? FLOOR_SLAB : EMBED;
            pushTileBox(arr, (tx + 0.5) * CELL, (tz + 0.5) * CELL, top, top - thickness,
                CELL * 0.49, _tileColor, ceilingColor);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
    geo.setIndex(arr.idx);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
    else applySurfaceDetail(mat, 'floor', style.wallPattern);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !ghost;
    mesh.userData.ownGeometry = true;  // merged per-patch geometry — safe to dispose
    const group = new THREE.Group();
    group.add(mesh);
    if (!ghost) {
        group.add(buildStructureTilePicker(cols, rows, (i) => {
            const top = (Number(ys[i]) || 0) + 0.07;
            return { y: top, height: 0.18 };
        }));
    }
    group.userData.tileCount = cols * rows;
    return group;
}

function pushRoofFace(arr, points, color) {
    if (points.length < 3) return;
    const base = arr.pos.length / 3;
    for (const [x, y, z] of points) {
        arr.pos.push(x, y, z);
        arr.col.push(color.r, color.g, color.b);
    }
    for (let i = 1; i < points.length - 1; i++) {
        arr.idx.push(base, base + i, base + i + 1);
    }
}

// Once any roof cell is cut, the optimized whole-shell roof becomes a tiled
// closed shell. Active cells retain their ceiling and add fascia around both
// the exterior perimeter and the newly exposed hole edges.
function buildTiledRoofShell({
    data, ghost, cols, rows, shape, pitch, overhang,
    width, depth, x0, x1, z0, z1, eave, maxRise,
    roofA, roofB, ceiling
}) {
    const spanX = x1 - x0, spanZ = z1 - z0;
    const across = shape === 'gable-x' ? spanZ
        : shape === 'gable-z' ? spanX
            : shape === 'hip' ? Math.min(spanX, spanZ) : 0;
    const rise = shape === 'flat' ? 0 : Math.min(maxRise, across * pitch / 2);
    const heightAt = (x, z) => {
        if (shape === 'flat') return eave;
        if (shape === 'gable-x') {
            return eave + Math.min(rise, Math.max(0, Math.min(z - z0, z1 - z)) * pitch);
        }
        if (shape === 'gable-z') {
            return eave + Math.min(rise, Math.max(0, Math.min(x - x0, x1 - x)) * pitch);
        }
        const edgeDistance = Math.max(0, Math.min(x - x0, x1 - x, z - z0, z1 - z));
        return eave + Math.min(rise, edgeDistance * pitch);
    };
    const active = (tx, tz) => tx >= 0 && tx < cols && tz >= 0 && tz < rows &&
        structureTileKind(data, tz * cols + tx) !== 'gap';
    const arr = { pos: [], col: [], idx: [] };
    const face = (points, color) => pushRoofFace(arr, points, color);
    const edgeSubdivisions = shape === 'flat' ? 1 : 2;
    const side = (ax, az, bx, bz) => {
        for (let part = 0; part < edgeSubdivisions; part++) {
            const t0 = part / edgeSubdivisions, t1 = (part + 1) / edgeSubdivisions;
            const px0 = ax + (bx - ax) * t0, pz0 = az + (bz - az) * t0;
            const px1 = ax + (bx - ax) * t1, pz1 = az + (bz - az) * t1;
            face([
                [px0, 0, pz0], [px1, 0, pz1],
                [px1, heightAt(px1, pz1), pz1], [px0, heightAt(px0, pz0), pz0]
            ], roofB);
        }
    };

    for (let tz = 0; tz < rows; tz++) {
        for (let tx = 0; tx < cols; tx++) {
            if (!active(tx, tz)) continue;
            const tileX0 = tx * CELL - (tx === 0 ? overhang : 0);
            const tileX1 = (tx + 1) * CELL + (tx === cols - 1 ? overhang : 0);
            const tileZ0 = tz * CELL - (tz === 0 ? overhang : 0);
            const tileZ1 = (tz + 1) * CELL + (tz === rows - 1 ? overhang : 0);
            const topSubdivisions = shape === 'flat' ? 1 : 2;
            const centerX = (tileX0 + tileX1) / 2, centerZ = (tileZ0 + tileZ1) / 2;
            const topColor = shape === 'gable-x' ? (centerZ <= depth / 2 ? roofA : roofB)
                : shape === 'gable-z' ? (centerX <= width / 2 ? roofA : roofB)
                    : roofA;
            for (let sz = 0; sz < topSubdivisions; sz++) {
                for (let sx = 0; sx < topSubdivisions; sx++) {
                    const xa = tileX0 + (tileX1 - tileX0) * (sx / topSubdivisions);
                    const xb = tileX0 + (tileX1 - tileX0) * ((sx + 1) / topSubdivisions);
                    const za = tileZ0 + (tileZ1 - tileZ0) * (sz / topSubdivisions);
                    const zb = tileZ0 + (tileZ1 - tileZ0) * ((sz + 1) / topSubdivisions);
                    face([
                        [xa, heightAt(xa, za), za], [xa, heightAt(xa, zb), zb],
                        [xb, heightAt(xb, zb), zb], [xb, heightAt(xb, za), za]
                    ], topColor);
                }
            }
            face([
                [tileX0, 0, tileZ1], [tileX1, 0, tileZ1],
                [tileX1, 0, tileZ0], [tileX0, 0, tileZ0]
            ], ceiling);
            if (!active(tx, tz - 1)) side(tileX0, tileZ0, tileX1, tileZ0);
            if (!active(tx + 1, tz)) side(tileX1, tileZ0, tileX1, tileZ1);
            if (!active(tx, tz + 1)) side(tileX1, tileZ1, tileX0, tileZ1);
            if (!active(tx - 1, tz)) side(tileX0, tileZ1, tileX0, tileZ0);
        }
    }

    const group = new THREE.Group();
    if (arr.idx.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
        geo.setIndex(arr.idx);
        geo.computeVertexNormals();
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
        if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
        else applySurfaceDetail(mat, 'roof');
        const shell = new THREE.Mesh(geo, mat);
        shell.castShadow = !ghost;
        shell.receiveShadow = !ghost;
        shell.userData.ownGeometry = true;
        group.add(shell);
    }
    if (!ghost) {
        const pickerHeight = eave + rise + 0.28;
        group.add(buildStructureTilePicker(cols, rows, () => ({
            y: pickerHeight / 2,
            height: pickerHeight
        })));
    }
    group.userData.roofRise = rise;
    group.userData.tileCount = cols * rows;
    group.userData.tiledRoof = true;
    return group;
}

// A roof patch is authored "over" the active storey and stored at the next
// level datum. Its closed bottom face is the room's ceiling; pitched shapes
// add a gable or hip shell above it. In All-levels view the cover gives the
// building an exterior silhouette; isolating the covered level hides it.
export function buildRoofPatch(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const cols = Math.max(1, Math.min(48, data.cols | 0));
    const rows = Math.max(1, Math.min(48, data.rows | 0));
    const shape = ['flat', 'gable-x', 'gable-z', 'hip'].includes(data.roofShape)
        ? data.roofShape : 'gable-x';
    const pitch = Math.max(0.1, Math.min(1, Number(data.pitch) || 0.5));
    const overhang = Math.max(0, Math.min(CELL * 0.45, Number(data.overhang) || CELL * 0.16));
    const width = cols * CELL, depth = rows * CELL;
    const x0 = -overhang, x1 = width + overhang;
    const z0 = -overhang, z1 = depth + overhang;
    const xm = width / 2, zm = depth / 2;
    const spanX = x1 - x0, spanZ = z1 - z0;
    const eave = ROOF_EAVE;
    const maxRise = Math.max(0.4, (Number(data.levelHeight) || DEFAULT_LEVEL_HEIGHT) * 1.5);
    const seed = Number(data.seed) || 1;
    const weather = (buildRand(seed, 0, 31) - 0.5) * (data.scruffy ? 0.28 : 0.08);
    const roofA = new THREE.Color(style.roofA).offsetHSL(0, 0, weather);
    const roofB = new THREE.Color(style.roofB).offsetHSL(0, 0, weather * 0.7);
    const ceiling = new THREE.Color(style.ceiling);
    const hasTileGaps = Array.isArray(data.tiles) &&
        data.tiles.slice(0, cols * rows).some(kind => kind === 'gap');
    if (hasTileGaps) {
        const group = buildTiledRoofShell({
            data, ghost, cols, rows, shape, pitch, overhang,
            width, depth, x0, x1, z0, z1, eave, maxRise,
            roofA, roofB, ceiling
        });
        group.userData.coveredLevel = Number.isFinite(Number(data.coversLevel))
            ? Math.round(Number(data.coversLevel)) : structureLevel(data) - 1;
        return group;
    }
    const arr = { pos: [], col: [], idx: [] };
    const face = (points, color) => pushRoofFace(arr, points, color);
    let rise = 0;
    let ridge = null;

    if (shape === 'flat') {
        face([[x0, eave, z0], [x0, eave, z1], [x1, eave, z1], [x1, eave, z0]], roofA);
    } else if (shape === 'gable-x' || shape === 'gable-z') {
        const across = shape === 'gable-x' ? spanZ : spanX;
        rise = Math.min(maxRise, across * pitch / 2);
        const peak = eave + rise;
        if (shape === 'gable-x') {
            face([[x0, eave, z0], [x0, peak, zm], [x1, peak, zm], [x1, eave, z0]], roofA);
            face([[x0, eave, z1], [x1, eave, z1], [x1, peak, zm], [x0, peak, zm]], roofB);
            face([[x0, eave, z0], [x0, peak, zm], [x0, eave, z1]], roofB);
            face([[x1, eave, z1], [x1, peak, zm], [x1, eave, z0]], roofB);
            ridge = { axis: 'x', length: spanX, x: xm, z: zm, y: peak };
        } else {
            face([[x0, eave, z1], [x0, eave, z0], [xm, peak, z0], [xm, peak, z1]], roofA);
            face([[x1, eave, z0], [x1, eave, z1], [xm, peak, z1], [xm, peak, z0]], roofB);
            face([[x0, eave, z0], [xm, peak, z0], [x1, eave, z0]], roofB);
            face([[x1, eave, z1], [xm, peak, z1], [x0, eave, z1]], roofB);
            ridge = { axis: 'z', length: spanZ, x: xm, z: zm, y: peak };
        }
    } else {
        const ridgeAlongX = spanX >= spanZ;
        const across = ridgeAlongX ? spanZ : spanX;
        rise = Math.min(maxRise, across * pitch / 2);
        const peak = eave + rise;
        if (ridgeAlongX) {
            const rx0 = x0 + across / 2, rx1 = x1 - across / 2;
            if (rx1 - rx0 < 0.001) {
                face([[x0, eave, z0], [x1, eave, z0], [xm, peak, zm]], roofA);
                face([[x1, eave, z1], [x0, eave, z1], [xm, peak, zm]], roofB);
            } else {
                face([[x0, eave, z0], [x1, eave, z0], [rx1, peak, zm], [rx0, peak, zm]], roofA);
                face([[x1, eave, z1], [x0, eave, z1], [rx0, peak, zm], [rx1, peak, zm]], roofB);
                ridge = { axis: 'x', length: rx1 - rx0, x: (rx0 + rx1) / 2, z: zm, y: peak };
            }
            face([[x0, eave, z1], [x0, eave, z0], [rx0, peak, zm]], roofB);
            face([[x1, eave, z0], [x1, eave, z1], [rx1, peak, zm]], roofA);
        } else {
            const rz0 = z0 + across / 2, rz1 = z1 - across / 2;
            if (rz1 - rz0 < 0.001) {
                face([[x0, eave, z1], [x0, eave, z0], [xm, peak, zm]], roofA);
                face([[x1, eave, z0], [x1, eave, z1], [xm, peak, zm]], roofB);
            } else {
                face([[x0, eave, z1], [x0, eave, z0], [xm, peak, rz0], [xm, peak, rz1]], roofA);
                face([[x1, eave, z0], [x1, eave, z1], [xm, peak, rz1], [xm, peak, rz0]], roofB);
                ridge = { axis: 'z', length: rz1 - rz0, x: xm, z: (rz0 + rz1) / 2, y: peak };
            }
            face([[x0, eave, z0], [x1, eave, z0], [xm, peak, rz0]], roofB);
            face([[x1, eave, z1], [x0, eave, z1], [xm, peak, rz1]], roofA);
        }
    }

    // Fascia and the horizontal interior ceiling close every roof shape.
    face([[x0, 0, z0], [x1, 0, z0], [x1, eave, z0], [x0, eave, z0]], roofB);
    face([[x1, 0, z1], [x0, 0, z1], [x0, eave, z1], [x1, eave, z1]], roofB);
    face([[x0, 0, z1], [x0, 0, z0], [x0, eave, z0], [x0, eave, z1]], roofB);
    face([[x1, 0, z0], [x1, 0, z1], [x1, eave, z1], [x1, eave, z0]], roofB);
    face([[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]], ceiling);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arr.col, 3));
    geo.setIndex(arr.idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    if (ghost) { mat.transparent = true; mat.opacity = 0.45; mat.depthWrite = false; }
    else applySurfaceDetail(mat, 'roof');
    const shell = new THREE.Mesh(geo, mat);
    shell.castShadow = !ghost;
    shell.receiveShadow = !ghost;
    shell.userData.ownGeometry = true;
    const group = new THREE.Group();
    group.add(shell);

    if (ridge) {
        const cap = new THREE.Mesh(UNIT_BOX, pieceMaterial(style.roofB, ghost));
        const capLength = Math.max(0.12, ridge.length * (data.scruffy ? 0.88 : 1));
        cap.scale.set(ridge.axis === 'x' ? capLength : 0.12, 0.09,
            ridge.axis === 'z' ? capLength : 0.12);
        cap.position.set(ridge.x, ridge.y + 0.025, ridge.z);
        cap.castShadow = !ghost;
        cap.receiveShadow = !ghost;
        group.add(cap);
    }

    if (!ghost) {
        const pickerHeight = eave + rise + 0.28;
        group.add(buildStructureTilePicker(cols, rows, () => ({
            y: pickerHeight / 2,
            height: pickerHeight
        })));
    }

    group.userData.roofRise = rise;
    group.userData.tileCount = cols * rows;
    group.userData.coveredLevel = Number.isFinite(Number(data.coversLevel))
        ? Math.round(Number(data.coversLevel)) : structureLevel(data) - 1;
    return group;
}

// A straight staircase between adjacent build levels. data.position is the
// centre of the first occupied cell; bx/bz point from the first cell's near edge
// to the far edge of the last cell. Four treads per cell keep a 10-foot rise
// readable without creating an expensive mesh or requiring external assets.
export function buildStaircase(data, opts = {}) {
    const ghost = !!opts.ghost;
    const style = BUILD_STYLES[data.style] || BUILD_STYLES.stone;
    const bx = Number(data.bx) || 0, bz = Number(data.bz) || 0;
    const run = Math.max(CELL, Math.abs(bx) + Math.abs(bz));
    const ux = Math.abs(bx) >= Math.abs(bz) ? (Math.sign(bx) || 1) : 0;
    const uz = ux ? 0 : (Math.sign(bz) || 1);
    const rise = Number.isFinite(Number(data.rise)) ? Number(data.rise) : DEFAULT_LEVEL_HEIGHT;
    const width = Math.max(CELL * 0.5, Number(data.width) || CELL * 0.9);
    const stepCount = Math.max(4, Math.round(run / CELL) * 4);
    const stepRun = run / stepCount;
    const low = Math.min(0, rise) - FLOOR_SLAB;
    const group = new THREE.Group();
    const mats = [pieceMaterial(style.floorA, ghost), pieceMaterial(style.floorB, ghost)];
    const seed = data.seed || 1;

    for (let i = 0; i < stepCount; i++) {
        const top = rise < 0
            ? rise * (i / Math.max(1, stepCount - 1))
            : rise * ((i + 1) / stepCount);
        const height = Math.max(FLOOR_SLAB, top - low);
        const tread = new THREE.Mesh(UNIT_BOX, mats[i & 1]);
        const along = -CELL * 0.5 + (i + 0.5) * stepRun;
        tread.scale.set(ux ? stepRun * 1.04 : width, height, uz ? stepRun * 1.04 : width);
        tread.position.set(ux * along, low + height / 2, uz * along);
        if (data.scruffy) {
            tread.position.y += (buildRand(seed, i, 21) - 0.5) * 0.035;
            tread.rotation.y = (buildRand(seed, i, 22) - 0.5) * 0.025;
        }
        tread.castShadow = !ghost;
        tread.receiveShadow = !ghost;
        group.add(tread);
    }
    return group;
}

// Free GPU resources of a built wall/floor/stair/roof (used for ghosts and live
// geometry replacement). Shared unit-box geometry is skipped; only per-object
// merged geometry (ownGeometry) and materials go.
export function disposeBuiltObject(obj) {
    if (!obj) return;
    const onDispose = obj.userData && obj.userData.onDispose;
    if (typeof onDispose === 'function') {
        // Runtime models can cancel pending async work without taking over the
        // shared geometry/material cleanup below.
        obj.userData.onDispose = null;
        onDispose();
    }
    obj.traverse(o => {
        if (o.userData.ownGeometry && o.geometry) o.geometry.dispose();
        if (o.material) {
            const materials = Array.isArray(o.material) ? o.material : [o.material];
            materials.forEach(material => material.dispose());
        }
    });
}
