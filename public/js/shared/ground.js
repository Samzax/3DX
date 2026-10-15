// The pure ground model (no three.js/DOM; `server.js` imports this same file):
// what the terrain is at a world point and what it costs to cross.
//
//  - `warpFields`: the painted-hex pull on the generator's fields. terrain.js
//    calls it for every vertex, so the server's heights are the client's.
//  - `createGround`: heights from the stored chunk edits over the generator —
//    the server's copy of `Terrain.sampleHeight` (it has no meshes, only the
//    synced blobs and the campaign's seed).
//  - `waterDepthAt` / `pathCost`: 5e movement over that ground. Steep slopes,
//    snow and wading are difficult terrain (+1 ft per ft), cliffs are climbed
//    and deep water swum (+1 ft per ft without that speed). The server charges
//    this in `move-object`; the screens preview it with the same function.

import { SEA_LEVEL, SEASONS, SNOW_T, WorldGen } from './worldgen.js';
import { TIER_WIDTH, worldToHexAtTier, hexCenterAtTier, hexEdgeDistance, hexDistance, HEX_FIELD_RADIUS } from './hexworld.js';

// Lattice constants: mirror terrain.js (tests/ground.test.cjs enforces it).
export const VSPACE = 0.5;
export const CHUNK_VERTS = 64;
export const HEIGHT_QUANT = 0.05;

// GM biome painting (hex tags) as generator overrides: each biome pulls the
// elevation/moisture FIELDS toward these targets, so heights, biome selection
// and materials all follow naturally (and blend continuously — no cliffs at
// hex borders). Values sit safely inside the biome classification bands.
// `t` also pulls the temperature (so a painted forest thaws a frozen land and
// painted tundra chills a warm one); mountains and coast keep the local climate.
export const BIOME_FIELDS = {
  plains:    { e: 0.52, mo: 0.50, t: 0.55 },
  forest:    { e: 0.56, mo: 0.78, t: 0.55 },
  mountains: { e: 0.85, mo: 0.50 },
  desert:    { e: 0.55, mo: 0.12, t: 0.70 },
  swamp:     { e: 0.44, mo: 0.85, t: 0.58 },  // wet lowland: mud, reeds, standing trees
  coast:     { e: 0.45, mo: 0.55 },           // hugs the waterline: beaches + shallow sea
  tundra:    { e: 0.52, mo: 0.30, t: 0.31 },
  taiga:     { e: 0.56, mo: 0.75, t: 0.31 },
  snow:      { e: 0.58, mo: 0.50, t: 0.12 }
};
// Feather width at hex borders, as a fraction of the tier's hex width.
export const BIOME_FEATHER = 0.18;

// Elevation + moisture at a world point, with painted-hex warping applied
// shallow -> deep (a Province tag refines its Kingdom tag, etc). (tt, tw) is
// the painted pull on temperature: target and weight (0 = unpainted). `tree`
// is { "world": { "q,r": { biome } }, "world/q,r": ... } or null.
export function warpFields(gen, tree, wx, wz) {
  let e = gen.elev(wx, wz);
  let mo = gen.moisture(wx, wz);
  let tt = 0, tw = 0;
  if (tree) {
    let cx = 0, cz = 0, key = 'world';
    for (let d = 0; d < 3; d++) {
      const lx = wx - cx, lz = wz - cz;
      const h = worldToHexAtTier(d, lx, lz);
      if (hexDistance(h) > HEX_FIELD_RADIUS) break; // outside this layer's field
      const tags = tree[key];
      const tag = tags && tags[h.q + ',' + h.r];
      const target = tag && BIOME_FIELDS[tag.biome];
      if (target) {
        const w = Math.max(0, Math.min(1, hexEdgeDistance(d, lx, lz, h.q, h.r) / (TIER_WIDTH[d] * BIOME_FEATHER)));
        e += (target.e - e) * w;
        mo += (target.mo - mo) * w;
        if (target.t != null) {
          tt = tw > 0 ? tt + (target.t - tt) * w : target.t;
          tw = Math.max(tw, w);
        }
      }
      const c = hexCenterAtTier(d, h.q, h.r);
      cx += c.x; cz += c.z;
      key += '/' + h.q + ',' + h.r;
    }
  }
  return { e, mo, tt, tw };
}

// --- heights without a Terrain ------------------------------------------------

// Stored chunk record ({ heights: base64 Int16 }) -> Int16Array, decoded once
// per blob (an edit replaces the string, which misses the cache).
const decoded = new WeakMap();
function chunkHeights(chunk) {
  if (!chunk || typeof chunk.heights !== 'string') return null;
  const hit = decoded.get(chunk);
  if (hit && hit.src === chunk.heights) return hit.q;
  let q = null;
  try {
    const bytes = typeof Buffer !== 'undefined'
      ? Buffer.from(chunk.heights, 'base64')
      : Uint8Array.from(atob(chunk.heights), ch => ch.charCodeAt(0));
    const even = bytes.byteLength - (bytes.byteLength % 2);
    q = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
    if (q.length < CHUNK_VERTS * CHUNK_VERTS) q = null;
  } catch (_) { q = null; }
  decoded.set(chunk, { src: chunk.heights, q });
  return q;
}

// The ground of one map from what the server stores.
//   seed/world/season — the campaign's generator settings
//   hexTree           — painted biome tags (see warpFields)
//   chunks            — terrain.chunks: { "cx,cz": { heights } } (GM edits)
//   water             — terrain.water: { bodies }
//   generator         — false on pocket maps (flat ground where nothing is stored)
export function createGround({ seed, world, season, hexTree = null, chunks = null, water = null, generator = true } = {}) {
  const gen = new WorldGen();
  gen.set(seed, world);
  const tree = hexTree && Object.keys(hexTree).length ? hexTree : null;
  const seasonOffset = Object.prototype.hasOwnProperty.call(SEASONS, season) ? SEASONS[season] : 0;
  const bodies = water && Array.isArray(water.bodies) ? water.bodies : [];
  const has = (key) => chunks && Object.prototype.hasOwnProperty.call(chunks, key);

  const vertex = (gx, gz) => {
    const cx = Math.floor(gx / CHUNK_VERTS), cz = Math.floor(gz / CHUNK_VERTS);
    const key = cx + ',' + cz;
    const q = has(key) ? chunkHeights(chunks[key]) : null;
    if (q) return q[(gz - cz * CHUNK_VERTS) * CHUNK_VERTS + (gx - cx * CHUNK_VERTS)] * HEIGHT_QUANT;
    if (!generator) return 0;
    const wx = gx * VSPACE, wz = gz * VSPACE;
    const f = warpFields(gen, tree, wx, wz);
    return gen.height(f.e, f.mo, wx, wz);
  };

  // Bilinear over the vertex lattice, exactly like Terrain.sampleHeight.
  const height = (x, z) => {
    const fx = x / VSPACE, fz = z / VSPACE;
    const gx = Math.floor(fx), gz = Math.floor(fz);
    const tx = fx - gx, tz = fz - gz;
    const h00 = vertex(gx, gz), h10 = vertex(gx + 1, gz);
    const h01 = vertex(gx, gz + 1), h11 = vertex(gx + 1, gz + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };

  return {
    height,
    waterDepth(x, z, h) { return waterDepthAt(bodies, x, z, h, generator, height); },
    snow(x, z, h) {
      if (!generator) return false;
      const f = tree ? warpFields(gen, tree, x, z) : null;
      return gen.temp(x, z, h, f ? f.tt : 0, f ? f.tw : 0) + seasonOffset < SNOW_T;
    }
  };
}

// --- water --------------------------------------------------------------------

function nearPolyline(points, x, z, reach) {
  const r2 = reach * reach;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t - x, pz = a.z + dz * t - z;
    if (px * px + pz * pz <= r2) return true;
  }
  return false;
}

// Is the ground under `level` all the way from (x,z) to the lake's pour point?
function floodedTo(seed, level, x, z, heightAt) {
  const dx = seed.x - x, dz = seed.z - z;
  const steps = Math.ceil(Math.hypot(dx, dz));
  for (let i = 1; i <= steps; i++) {
    if (!(heightAt(x + dx * i / steps, z + dz * i / steps) < level)) return false;
  }
  return true;
}

// How deep the water stands over ground of height `h` at (x,z); 0 = dry.
// The sea is exact. Authored bodies are read from their synced definition, not
// the screens' settled footprints (a flood fill the server cannot afford): a
// lake covers what lies under its level in open water from its pour point —
// a cove behind a headland reads dry — and a river wades (its bed is carved,
// its depth is not data). `heightAt(x, z)` is the ground the lakes lie on.
export const RIVER_DEPTH = 0.3;
export function waterDepthAt(bodies, x, z, h, sea = true, heightAt = null) {
  let depth = sea && h < SEA_LEVEL ? SEA_LEVEL - h : 0;
  for (const body of bodies || []) {
    if (!body) continue;
    if (body.kind === 'lake' && body.seed) {
      const level = Number(body.level);
      if (!heightAt || !(level - h > depth)) continue;
      const reach = Number(body.maxRadius) || 96;
      if (Math.max(Math.abs(x - body.seed.x), Math.abs(z - body.seed.z)) > reach) continue;
      if (floodedTo(body.seed, level, x, z, heightAt)) depth = level - h;
    } else if (body.kind === 'river' && Array.isArray(body.points)) {
      if (depth < RIVER_DEPTH && nearPolyline(body.points, x, z, (Number(body.width) || 2.5) / 2)) depth = RIVER_DEPTH;
    }
  }
  return depth;
}

// --- movement cost ------------------------------------------------------------

export const FEET_PER_UNIT = 5;
export const MOVE_RULES = Object.freeze({
  step: 0.5,       // path sampling, world units (one lattice vertex)
  steep: 0.6,      // rise over run from which a slope is difficult terrain (~31°)
  climb: 1.2,      // ... and from which it is a climb (~50°)
  wade: 0.2,       // water this deep (1 ft) is difficult terrain
  swim: 0.6,       // ... and this deep (3 ft) is swum
  airborne: 0.4    // soles this far off the ground are not walking on it
});
export const MOVE_MODES = Object.freeze(['climb', 'swim', 'fly']);
export const MOVE_KIND_LABELS = Object.freeze({
  steep: 'steep ground', climb: 'climbing', wade: 'wading', swim: 'swimming', snow: 'snow'
});
// `walls`: players' characters stop at walls, bars and shut doors (passage.js).
export const MOVEMENT_DEFAULTS = Object.freeze({ terrain: true, snow: true, walls: true });
export function normalizeMovement(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    terrain: typeof source.terrain === 'boolean' ? source.terrain : MOVEMENT_DEFAULTS.terrain,
    snow: typeof source.snow === 'boolean' ? source.snow : MOVEMENT_DEFAULTS.snow,
    walls: typeof source.walls === 'boolean' ? source.walls : MOVEMENT_DEFAULTS.walls
  };
}

// What a straight move from `from` to `to` costs. Points are { x, z, y? } with
// y the height of the SOLES (null/undefined = standing on the ground).
//   ground — { height(x,z), waterDepth(x,z,h), snow(x,z,h) }
//   modes  — speeds the mover has: ['climb', 'swim', 'fly']
//   snow   — false: snow is not counted
// Returns { feet, cost, kinds: { steep|climb|wade|swim|snow: feet crossed } };
// `feet` is the flat distance (what the ruler shows), `cost` what it spends.
// Stretches where the soles are off the ground (flight, a floor, a bridge)
// cost their plain distance.
export function pathCost(from, to, ground, { modes = [], snow = true } = {}) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  const kinds = {};
  if (!(length > 0) || !ground || modes.includes('fly')) return { feet: length * FEET_PER_UNIT || 0, cost: length * FEET_PER_UNIT || 0, kinds };
  const R = MOVE_RULES;
  const climber = modes.includes('climb'), swimmer = modes.includes('swim');
  const steps = Math.max(1, Math.ceil(length / R.step));
  const run = length / steps;
  const startH = ground.height(from.x, from.z), endH = ground.height(to.x, to.z);
  const known = (v) => v != null && Number.isFinite(v);
  const fromY = known(from.y) ? from.y : startH, toY = known(to.y) ? to.y : endH;
  const walked = Math.abs(fromY - startH) <= R.airborne && Math.abs(toY - endH) <= R.airborne;
  const add = (kind, feet) => { kinds[kind] = (kinds[kind] || 0) + feet; };

  let cost = 0, lastH = startH;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, x = from.x + dx * t, z = from.z + dz * t;
    const h = i === steps ? endH : ground.height(x, z);
    const rise = h - lastH;
    lastH = h;
    // Both ends on the ground: the mover follows it. Otherwise only where the
    // straight line between the two heights actually touches it.
    if (!walked && Math.abs(fromY + (toY - fromY) * t - h) > R.airborne) { cost += run; continue; }
    const mx = x - dx / steps / 2, mz = z - dz / steps / 2;
    const mh = h - rise / 2;
    let depth = ground.waterDepth ? ground.waterDepth(mx, mz, mh) : 0;
    // Frozen over: the surface is cold enough to hold snow, so it is walked.
    if (depth > 0 && ground.snow && ground.snow(mx, mz, mh + depth)) depth = 0;
    let extra = 0, travelled = run;
    if (depth >= R.swim) {
      if (!swimmer) { extra++; add('swim', run * FEET_PER_UNIT); }
    } else {
      const along = Math.abs(rise) / run;
      // A hillside is hard to cross whichever way it is walked: the slope
      // itself decides "steep", the rise along the path decides "climb".
      const e = R.step / 2;
      const slope = Math.max(along, Math.hypot(
        ground.height(mx + e, mz) - ground.height(mx - e, mz),
        ground.height(mx, mz + e) - ground.height(mx, mz - e)) / (2 * e));
      let difficult = false;
      if (along >= R.climb) {
        travelled = Math.hypot(run, rise);
        if (!climber) { extra++; add('climb', travelled * FEET_PER_UNIT); }
      } else if (slope >= R.steep && !climber) {
        difficult = true; add('steep', run * FEET_PER_UNIT);
      }
      if (depth >= R.wade) {
        if (!swimmer) { difficult = true; add('wade', run * FEET_PER_UNIT); }
      } else if (snow && ground.snow && ground.snow(mx, mz, mh)) {
        difficult = true; add('snow', run * FEET_PER_UNIT);
      }
      if (difficult) extra++;
    }
    cost += travelled * (1 + extra);
  }
  return { feet: length * FEET_PER_UNIT, cost: cost * FEET_PER_UNIT, kinds };
}

// "steep ground, snow" — the kinds that mattered, biggest first.
export function describeCost(result) {
  return Object.entries((result && result.kinds) || {})
    .filter(([, feet]) => feet >= 2.5)
    .sort((a, b) => b[1] - a[1])
    .map(([kind]) => MOVE_KIND_LABELS[kind] || kind)
    .join(', ');
}
