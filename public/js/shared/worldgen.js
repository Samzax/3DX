// worldgen.js — the pure world generator: deterministic noise fields
// (elevation, moisture, temperature) -> heights, biomes and materials.
// No three.js and no DOM, so the same math drives the streamed 3D terrain
// (terrain.js), the 2D preview map (worldmap.js, lobby wizard + GM panel) and
// Node tests. Everything is a pure function of (seed, world settings, x, z):
// every client computes the same world and nothing here is ever synced.
//
// WORLD_DEFAULTS reproduce the original generator's heights bit-for-bit, so
// campaigns created before these settings existed never shift.

export const SEA_LEVEL = -0.6;

export const smooth = (t) => t * t * (3 - 2 * t); // smoothstep falloff
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// --- deterministic value noise (same result on every client) ---
function lattice(seed, x, z) {
  let h = (Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function seededNoise(seed, x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const sx = smooth(x - ix), sz = smooth(z - iz);
  const a = lattice(seed, ix, iz), b = lattice(seed, ix + 1, iz);
  const c = lattice(seed, ix, iz + 1), d = lattice(seed, ix + 1, iz + 1);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}
export function fbm(seed, x, z, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < oct; o++) { v += seededNoise(seed + o * 101, x * f, z * f) * amp; amp *= 0.5; f *= 2; }
  return v; // ~0..1
}

// --- campaign world settings (settings.world; server.js mirrors the bounds) ---
export const WORLD_DEFAULTS = {
  ocean: 80,        // % of the world under sea (a world-wide average)
  landSize: 100,    // % scale of continents and seas
  wetness: 0,       // -100 arid .. +100 lush
  temperature: 0,   // -100 frozen .. +100 scorching
  latitude: 0,      // 0 uniform climate .. 100 strong cold-north/hot-south bands
  rugged: 0,        // -100 gentle .. +100 alpine
  zones: 0,         // 0 fine patchwork of biomes .. 100 broad climate regions
  relief: 0,        // 0 = the original generator; 100 = deep mountain ranges
  home: null        // { x, z }: guaranteed landmass around this point
};
export const WORLD_LIMITS = {
  ocean: [10, 90], landSize: [50, 300], wetness: [-100, 100], temperature: [-100, 100],
  latitude: [0, 100], rugged: [-100, 100], zones: [0, 100], relief: [0, 100]
};
// Named starting points for the knobs above (the wizard's preset chips).
export const WORLD_PRESETS = [
  { key: 'continents', label: 'Continents', hint: 'Balanced landmasses and seas, cold north, warm south.',
    world: { ocean: 60, landSize: 100, wetness: 0, temperature: 0, latitude: 50, rugged: 0, zones: 60, relief: 50 } },
  { key: 'archipelago', label: 'Archipelago', hint: 'Scattered islands in a warm, wet sea.',
    world: { ocean: 78, landSize: 50, wetness: 20, temperature: 15, latitude: 30, rugged: -20, zones: 50, relief: 0 } },
  { key: 'heartland', label: 'Heartland', hint: 'One vast landmass; the sea is far away.',
    world: { ocean: 25, landSize: 220, wetness: 0, temperature: 0, latitude: 50, rugged: 10, zones: 70, relief: 0 } },
  { key: 'highlands', label: 'Highlands', hint: 'Cool, rugged country of ranges and snow-capped peaks.',
    world: { ocean: 40, landSize: 130, wetness: 10, temperature: -20, latitude: 40, rugged: 80, zones: 60, relief: 60 } },
  { key: 'frozen', label: 'Frozen North', hint: 'Tundra, taiga and ice; winter never fully leaves.',
    world: { ocean: 55, landSize: 110, wetness: -10, temperature: -70, latitude: 30, rugged: 30, zones: 60, relief: 0 } },
  { key: 'sunscorched', label: 'Sunscorched', hint: 'Hot, dry lands of dunes and rare oases.',
    world: { ocean: 35, landSize: 180, wetness: -70, temperature: 60, latitude: 20, rugged: 0, zones: 70, relief: 0 } },
  { key: 'classic', label: 'Classic', hint: 'The original generator: mostly ocean, patchwork biomes.',
    world: { ocean: 80, landSize: 100, wetness: 0, temperature: 0, latitude: 0, rugged: 0, zones: 0, relief: 0 } }
];

// Seasons are table state, not world state: they only slide the snowline.
export const SEASONS = { summer: 0, autumn: -0.05, winter: -0.18, spring: -0.03 };
export const SEASON_KEYS = Object.keys(SEASONS);

export const SNOW_T = 0.25;          // snow lies below this temperature
const COLD_T = 0.36;                 // tundra/taiga below this
const LAT_SPAN = 200000;             // units from the origin to full polar/tropic

// Deciles of the continental-mask fbm (measured over random seeds/positions):
// an ocean share maps to the mask level that share of the world sits below.
const CONT_QUANTILES = [0.038, 0.276, 0.327, 0.368, 0.403, 0.437, 0.472, 0.507, 0.547, 0.599, 0.840];
function contQuantile(pct) {
  const t = Math.max(0, Math.min(100, pct)) / 10, i = Math.min(9, Math.floor(t));
  return CONT_QUANTILES[i] + (CONT_QUANTILES[i + 1] - CONT_QUANTILES[i]) * (t - i);
}
export const HOME_INNER = 12000, HOME_OUTER = 26000, HOME_CORE = 4000;   // homeland: solid land .. open sea (units)

export function normalizeWorld(raw) {
  const w = raw || {}, out = {};
  for (const key of Object.keys(WORLD_LIMITS)) {
    const [lo, hi] = WORLD_LIMITS[key], v = w[key];
    out[key] = (v != null && Number.isFinite(Number(v)))
      ? Math.max(lo, Math.min(hi, Number(v))) : WORLD_DEFAULTS[key];
  }
  out.home = w.home && Number.isFinite(Number(w.home.x)) && Number.isFinite(Number(w.home.z))
    ? { x: Number(w.home.x), z: Number(w.home.z) } : null;
  return out;
}
function sameWorld(a, b) {
  for (const key of Object.keys(WORLD_LIMITS)) if (a[key] !== b[key]) return false;
  return a.home ? !!b.home && a.home.x === b.home.x && a.home.z === b.home.z : !b.home;
}
// Which preset (if any) a world's knobs currently match — drives the chips.
export function presetKeyOf(world) {
  const w = normalizeWorld(world);
  const hit = WORLD_PRESETS.find(p => Object.keys(WORLD_LIMITS).every(k => p.world[k] === w[k]));
  return hit ? hit.key : null;
}

export class WorldGen {
  constructor() {
    this.seed = 1337;
    this.world = { ...WORLD_DEFAULTS };
    this._derive();
  }

  // Adopt { seed, world }. Returns true when generation actually changed.
  set(seed, world) {
    const s = (seed != null && Number.isFinite(Number(seed))) ? Number(seed) : this.seed;
    const w = normalizeWorld(world);
    if (s === this.seed && sameWorld(w, this.world)) return false;
    this.seed = s;
    this.world = w;
    this._derive();
    return true;
  }

  _derive() {
    const w = this.world, r = w.rugged / 100;
    // Offsets from the default keep the default world exactly as it was.
    this._contT = 0.50 + (contQuantile(w.ocean) - contQuantile(WORLD_DEFAULTS.ocean));
    this._contF = 0.00001 / (w.landSize / 100);
    this._wetBias = w.wetness / 100 * 0.15;
    this._tBase = 0.55 + w.temperature / 100 * 0.30;
    this._latK = w.latitude / 100 * 0.40;
    this._mtn0 = 0.62 - r * 0.08;        // mountain mask starts rising here
    this._mtnT = 0.7 - r * 0.08;         // mountain biome threshold
    const rel = (w.relief || 0) / 100;
    this._rel = rel;
    this._relScale = 1 + 30 * rel;
    this._ridgeAmp = 22 * (1 + (r > 0 ? 1.1 : 0.4) * r) * this._relScale;
    this._ridgeFreq = 0.013 / (1 + 22 * rel);
    this._cragAmp = 15 * Math.max(0, r) + 60 * rel;
    this._cragFreq = 0.041 / (1 + 10 * rel);
    this._lapse = 0.016 / (1 + 7 * rel);
    this._hillK = 1 + 0.3 * r;
    this._zoneK = w.zones / 100;
  }

  get fogAltitude() {
    return Math.max(80, Math.ceil(this._ridgeAmp * 1.05 + 30));
  }

  // Continuous elevation field 0..1, seam-free by construction. Two scales:
  // a continental mask (features ~100k units — a couple of 60-mile hexes) that
  // decides where landmasses sit, and the regional field (~300u features) that
  // shapes terrain within them. Ocean floors keep a small regional swell (rare
  // islets); continental interiors get the full range (inland mountains where
  // the regional field runs high). `coarse` swaps the regional noise for its
  // mean — the preview map's view from too far up to resolve it.
  elev(wx, wz, coarse = false) {
    const seed = this.seed;
    const C = fbm(seed + 900, wx * this._contF, wz * this._contF, 3);
    // fbm(3 oct) centers near 0.44; by default the ramp opens at 0.50 and
    // saturates at 0.58, leaving roughly a fifth of the world as land. The
    // campaign's ocean share slides that ramp.
    let cont = smooth(Math.max(0, Math.min(1, (C - this._contT) / 0.08)));
    // Homeland: a guaranteed landmass around the campaign's home point, with a
    // noise-warped rim so its coast isn't a circle.
    const home = this.world.home;
    if (home) {
      const warp = 0.75 + 0.5 * fbm(seed + 901, wx * 0.00008, wz * 0.00008, 2);
      const d = Math.hypot(wx - home.x, wz - home.z) * warp;
      if (d < HOME_OUTER) {
        // 0.8, not 1: a deep continental interior runs to high mountains, and
        // a home should be somewhere a party can actually stand.
        const k = 0.8 * (1 - smooth(Math.max(0, (d - HOME_INNER) / (HOME_OUTER - HOME_INNER))));
        if (k > cont) cont = k;
      }
    }
    let regional = coarse ? 0.47 : fbm(seed, wx * 0.0035, wz * 0.0035, 4);
    // Broad regions: blend in a far lower-frequency field so highlands and
    // lowlands form country-sized ranges and basins instead of fine patchwork.
    const k = this._zoneK;
    if (k > 0) {
      const broad = 0.5 + (fbm(seed + 40, wx * 0.00009, wz * 0.00009, 3) - 0.44) * 2.2;
      regional = regional * (1 - 0.6 * k) + clamp01(broad) * 0.6 * k;
    }
    let e = 0.28 + cont * 0.38 + (regional - 0.5) * (0.35 + 0.40 * cont);
    // The home point itself must be dry land, not a lake the regional field
    // happened to dig: a low floor under the innermost few thousand units.
    if (home) {
      const core = Math.hypot(wx - home.x, wz - home.z) / HOME_CORE;
      if (core < 1) e = Math.max(e, 0.40 + 0.12 * (1 - smooth(core)));
    }
    return e;
  }

  // Moisture field 0..1 — shared by heights and biome selection so terrain
  // character and biome color always agree (dry = dunes, wet = rolling hills).
  moisture(wx, wz, coarse = false) {
    let mo = coarse ? 0.47 : fbm(this.seed + 200, wx * 0.005, wz * 0.005, 4);
    const k = this._zoneK;
    if (k > 0) {
      const broad = 0.5 + (fbm(this.seed + 250, wx * 0.00006, wz * 0.00006, 3) - 0.44) * 2.6;
      mo = mo * (1 - 0.7 * k) + clamp01(broad) * 0.7 * k;
    }
    return mo + this._wetBias;
  }

  // Mountain mask rises just below the mountain-biome threshold so foothills
  // stay modest instead of full ridges bleeding into other biomes.
  mtnMask(e) { return smooth(Math.max(0, Math.min(1, (e - this._mtn0) / 0.18))); }

  // Ground height from the two fields. Continuous (no cliffs at biome borders)
  // but strongly biome-differentiated via smooth masks over the same fields
  // the biome picker uses: plains lie nearly flat, forests roll, deserts
  // ripple with dunes, and mountain country rises into tall ridged peaks.
  // `lod` drops the high-frequency octaves — a spectral downsample for the far
  // LOD rings (coarse sampling of full-detail noise would alias; this doesn't).
  height(e, mo, wx, wz, lod = 0) {
    const seed = this.seed;
    const m = this.mtnMask(e);
    const wet = smooth(Math.max(0, Math.min(1, (mo - 0.38) / 0.24))); // 0 desert .. 1 forest
    const base = (e - 0.5) * 16;                     // broad lowlands/highlands
    // Rolling hills: amplitude grows with moisture (plains ~0.8, forest ~3.4).
    const hills = fbm(seed + 50, wx * 0.02, wz * 0.02, Math.max(1, 4 - lod)) - 0.5;
    let h = base + hills * (0.8 + wet * 2.6) * (1 - m * 0.6) * this._hillK;
    // Mountains: tall ridged peaks where the elevation field runs high.
    const ridgeOct = Math.max(1, 5 - lod);
    let f = fbm(seed + 500, wx * this._ridgeFreq, wz * this._ridgeFreq, ridgeOct);
    if (this._rel > 0 && ridgeOct < 5) {
      f *= (1 - Math.pow(0.5, 5)) / (1 - Math.pow(0.5, ridgeOct));   // 5-oct mean / oct-oct mean
    }
    const ridge = Math.pow(1 - Math.abs(2 * f - 1), 2);
    h += ridge * m * this._ridgeAmp;
    // Crags: a finer ridged octave, strongest high on the main ridges, breaks
    // the smooth domes into knife edges, spurs and gullies. The far rings
    // (lod >= 2) can't resolve it and take its mean instead.
    if (this._cragAmp > 0 && m > 0) {
      const crag = (lod < 2 || (this._rel > 0 && lod < 3))
        ? Math.pow(1 - Math.abs(2 * fbm(seed + 510, wx * this._cragFreq, wz * this._cragFreq, 3 - lod) - 1), 1.6)
        : 0.3;
      h += (crag - 0.3) * m * (0.35 + 0.65 * ridge) * this._cragAmp;
    }
    // Coastal shelf: damp high-frequency relief near the waterline so shores
    // are clean beaches with one surf line — otherwise dune/detail troughs dip
    // under SEA_LEVEL and the coast becomes a picket fence of water slivers.
    const shore = smooth(Math.min(1, Math.abs(h - SEA_LEVEL) / 2.5));
    // Deserts: banded dunes (anisotropic ripple) on dry, non-mountain land.
    if (lod < 3) {
      const dune = fbm(seed + 300, wx * 0.05, wz * 0.014, Math.max(1, 3 - lod)) - 0.5;
      h += dune * (1 - wet) * (1 - m) * 2.2 * shore;
    }
    if (lod < 2) {
      const detail = fbm(seed + 99, wx * 0.09, wz * 0.09, Math.max(1, 3 - lod)) - 0.5;
      h += detail * (0.6 + m * 2.0) * (0.25 + 0.75 * shore);
    }
    // Below the waterline the seabed falls away steeply (the shelf otherwise
    // leaves a wide barely-submerged shelf that sits entirely inside the foam
    // band and renders as dappled dashes instead of a tight surf line).
    if (h < SEA_LEVEL) h = SEA_LEVEL + (h - SEA_LEVEL) * 2.2;
    return h;
  }

  // Temperature 0..1 (~0.55 temperate) at altitude h: world setting, latitude
  // band (north = -z is cold), a little regional noise, minus altitude lapse.
  // (tt, tw): a painted hex pulling the sea-level temperature toward tt.
  temp(wx, wz, h, tt = 0, tw = 0) {
    let t = this._tBase + (fbm(this.seed + 700, wx * 0.0015, wz * 0.0015, 2) - 0.375) * 0.10;
    if (this._latK > 0) t += this._latK * Math.max(-1, Math.min(1, wz / LAT_SPAN));
    if (tw > 0) t += (tt - t) * tw;
    return t - Math.max(0, h) * this._lapse;
  }
  // Sea-level temperature without the local noise: what the water shader
  // evaluates per fragment for sea ice (it can't run this module's noise).
  seaTempUniforms() { return { base: this._tBase, latK: this._latK, span: LAT_SPAN }; }

  // Typical ground height for an elevation value (no local noise): the
  // altitude a biome's climate is judged at.
  estHeight(e) { return Math.max(0, (e - 0.5) * 16) + this.mtnMask(e) * 8 * this._relScale; }

  // Biome from elevation x moisture x temperature.
  biome(e, mo, t) {
    if (e > this._mtnT) return 'mountains';
    if (e < 0.4) return 'coast';
    if (t < SNOW_T) return 'snow';
    if (t < COLD_T) return mo > 0.5 ? 'taiga' : 'tundra';
    if (e < 0.47 && mo > 0.62) return 'swamp';
    // Heat widens the deserts.
    const dry = 0.38 + clamp01((t - 0.62) / 0.3) * 0.12;
    if (mo < dry) return 'desert';
    if (mo > 0.62) return 'forest';
    return 'plains';
  }

  // Material channel (0 grass, 1 dirt, 2 rock, 3 sand) under a biome. Snow is
  // not a material: the terrain shader lays it over whatever is here.
  material(biome, h, wx, wz) {
    if (h < SEA_LEVEL + 1.0) return 3;               // beaches ring every shore
    const n = fbm(this.seed + 300, wx * 0.05, wz * 0.05, 2);
    if (biome === 'mountains') return h > 9 * this._relScale || n > 0.55 ? 2 : (n > 0.35 ? 1 : 0);
    if (biome === 'desert') return 3;
    if (biome === 'coast') return h < 0.3 ? 3 : 0;
    if (biome === 'forest') return n > 0.6 ? 1 : 0;
    if (biome === 'swamp') return n > 0.5 ? 1 : 0;   // mud between the reeds
    if (biome === 'taiga') return n > 0.6 ? 1 : 0;
    if (biome === 'tundra') return n > 0.66 ? 2 : (n > 0.45 ? 1 : 0);
    if (biome === 'snow') return n > 0.6 ? 2 : 1;
    return n > 0.72 ? 1 : 0; // plains
  }

  // One preview-map sample: { sea, depth 0..1, biome, snow } at a world point.
  // pxSize = world units per pixel; past a few hundred units the local noise
  // can't be resolved, so the sample uses its mean (clean coasts, no confetti).
  sample(wx, wz, pxSize = 0, seasonOffset = 0) {
    const coarse = pxSize > 400;
    const e = this.elev(wx, wz, coarse), mo = this.moisture(wx, wz, coarse);
    const h = coarse
      ? (e - 0.5) * 16 + this.mtnMask(e) * this._ridgeAmp * 0.3
      : this.height(e, mo, wx, wz, 3);
    if (h < SEA_LEVEL) {
      const ice = this.temp(wx, wz, 0) + seasonOffset < SNOW_T - 0.04;
      return { sea: true, depth: clamp01((SEA_LEVEL - h) / 6), biome: 'sea', snow: ice };
    }
    const biome = this.biome(e, mo, this.temp(wx, wz, this.estHeight(e)));
    return { sea: false, depth: 0, biome, snow: this.temp(wx, wz, h) + seasonOffset < SNOW_T };
  }
}
