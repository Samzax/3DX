// terrain.js — chunked, sparse, virtually infinite heightmap terrain + material
// painting + water for the tactical map. Shared by the GM editor (pages/gm.js)
// and the player viewer (pages/player.js).
//
// Design: docs/chunked-terrain-design.md. Summary:
// - Global vertex lattice every 0.5 world units (2 verts per 5-ft cell edge).
// - Chunks of 32x32 cells own 64x64 unique vertices each; sparse Map storage —
//   only chunks the GM has touched exist, everything else is implicit flat ground.
// - A chunk's mesh is 65x65 verts: its own 64 rows/cols plus a 1-vertex apron
//   sampled from neighbor data, so positions agree at seams by construction.
//   Normals use central differences over the global lattice — also seamless.
// - All chunk meshes share ONE material (Lambert + the shader brush cursor),
//   so the brush ring spans chunk borders for free.
// - Sync format v2: { chunks: { "cx,cz": { heights?, splat? } | null }, water? }.
//   heights are Int16-quantized base64, splat is Uint8 RGBA base64; the server
//   stores them opaquely. null deletes a chunk. Legacy v1 blobs (res:128 single
//   tile) are migrated on load (applyData returns { migrated: true }).

import * as THREE from 'three';

export const VSPACE = 0.5;                       // world units between lattice verts
export const CHUNK_VERTS = 64;                   // unique verts per chunk side
export const CHUNK_SIZE = CHUNK_VERTS * VSPACE;  // 32 world units per chunk side
const MESH_VERTS = CHUNK_VERTS + 1;              // 65: owned verts + 1 apron row/col
const HEIGHT_QUANT = 0.05;                       // Int16 quantization step for sync
const HEIGHT_LIMIT = 50;

// Paintable materials, in splat channel order R,G,B,A.
export const MATERIALS = [
  { key: 'grass', color: 0x4a7a3a },
  { key: 'dirt',  color: 0x6b4f2a },
  { key: 'rock',  color: 0x7d7d7d },
  { key: 'sand',  color: 0xc2b280 }
];
const MAT_COLORS = MATERIALS.map(m => new THREE.Color(m.color));

// --- base64 <-> typed array (browser btoa/atob; server stores these opaquely) ---
function u8ToB64(u8) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64); const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const smooth = (t) => t * t * (3 - 2 * t); // smoothstep falloff
const ckey = (cx, cz) => cx + ',' + cz;

// --- deterministic noise for biome seeding (same result on every client) ---
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
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
function fbm(seed, x, z, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < oct; o++) { v += seededNoise(seed + o * 101, x * f, z * f) * amp; amp *= 0.5; f *= 2; }
  return v; // ~0..1
}

function newChunk() {
  const c = {
    heights: new Float32Array(CHUNK_VERTS * CHUNK_VERTS),
    splat: new Uint8Array(CHUNK_VERTS * CHUNK_VERTS * 4),
    mesh: null
  };
  for (let i = 0; i < CHUNK_VERTS * CHUNK_VERTS; i++) c.splat[i * 4] = 255; // all grass
  return c;
}

// Shared static index buffer for every 65x65 chunk mesh.
let SHARED_INDEX = null;
function sharedIndex() {
  if (SHARED_INDEX) return SHARED_INDEX;
  const idx = new Uint16Array(CHUNK_VERTS * CHUNK_VERTS * 6);
  let o = 0;
  for (let z = 0; z < CHUNK_VERTS; z++) {
    for (let x = 0; x < CHUNK_VERTS; x++) {
      const a = z * MESH_VERTS + x, b = a + 1, c = a + MESH_VERTS, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  SHARED_INDEX = new THREE.BufferAttribute(idx, 1);
  return SHARED_INDEX;
}

export class Terrain {
  constructor() {
    this.chunks = new Map();               // "cx,cz" -> { heights, splat, mesh }
    // Floating origin (docs/unified-world-design.md §5): game logic uses TRUE
    // world coordinates everywhere; rendering subtracts worldOrigin so mesh
    // transforms (and thus GPU matrices) stay near zero even when content sits
    // hundreds of thousands of units out. Chunk/water geometry is built LOCAL to
    // its own anchor so vertex buffers never hold large float32 values.
    this.worldOrigin = { x: 0, z: 0 };
    this.genSeed = 1337;                    // U2: world generation seed (see genHeightAt)
    // Water v2 (docs/water-v2-design.md): authored bodies, physically settled
    // footprints. Footprints are recomputed from the shared quantized heights,
    // never synced.
    this.water = { bodies: [] };
    this._footprints = new Map();          // body id -> { cells:Set<"cx,cz">, level }
    this._waterMeshes = new Map();         // body id -> THREE.Mesh

    this._dirtyData = new Map();           // "cx,cz" -> { heights: bool, splat: bool } (needs sync)
    this._dirtyMesh = new Set();           // "cx,cz" (needs rebuild)
    this._strokePatch = null;              // copy-on-write undo patch while a stroke is open
    this._windowCenter = null;             // last streaming-window center chunk
    this.windowRadius = 5;                 // chunks kept meshed around the camera target

    // One material shared by every chunk mesh; carries the shader brush cursor.
    this._brushUniforms = {
      uBrushPos:     { value: new THREE.Vector2(0, 0) },
      uBrushRadius:  { value: 6 },
      uBrushColor:   { value: new THREE.Color(0xffdd55) },
      uBrushVisible: { value: 0 }
    };
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this._brushUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBrushWorld;')
        .replace('#include <fog_vertex>',
          '#include <fog_vertex>\nvBrushWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vBrushWorld;',
          'uniform vec2 uBrushPos;',
          'uniform float uBrushRadius;',
          'uniform vec3 uBrushColor;',
          'uniform float uBrushVisible;'
        ].join('\n'))
        .replace('#include <dithering_fragment>', [
          'if (uBrushVisible > 0.5) {',
          '  float d = distance(vBrushWorld.xz, uBrushPos);',
          '  float edgeW = max(uBrushRadius * 0.05, 0.06);',
          '  float edge = 1.0 - smoothstep(0.0, edgeW, abs(d - uBrushRadius));',
          '  float t = clamp(1.0 - d / uBrushRadius, 0.0, 1.0);',
          '  float fill = t * t * (3.0 - 2.0 * t) * 0.22;',
          '  gl_FragColor.rgb = mix(gl_FragColor.rgb, uBrushColor, max(edge * 0.85, fill));',
          '}',
          '#include <dithering_fragment>'
        ].join('\n'));
    };

    this.chunkGroup = new THREE.Group();   // chunk meshes only (raycast target)
    this.chunkGroup.name = 'terrain-chunks';

    // One stylized shader for every water mesh: depth tint, animated foam
    // contact line, sun glints, fresnel. All noise is procedural (no textures).
    this.waterMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime:      { value: 0 },
        uShallow:   { value: new THREE.Color(0x66d9d0) },
        uDeep:      { value: new THREE.Color(0x1a4f8a) },
        uFoamColor: { value: new THREE.Color(0xf2fbff) },
        uFoamWidth: { value: 0.35 },
        uBands:     { value: 0 }    // 0 = smooth; 3-4 = Wind-Waker banding
      },
      vertexShader: [
        'attribute float aDepth;',
        'attribute vec2 aFlow;',        // rivers: (arc length, across -1..1); lakes: 0
        'attribute float aFlowSpeed;',  // rivers: body speed; lakes: 0
        'varying float vDepth;',
        'varying vec3 vWorld;',
        'varying vec2 vFlow;',
        'varying float vFlowSpeed;',
        'void main() {',
        '  vDepth = aDepth;',
        '  vFlow = aFlow;',
        '  vFlowSpeed = aFlowSpeed;',
        '  vec4 w = modelMatrix * vec4(position, 1.0);',
        '  vWorld = w.xyz;',
        '  gl_Position = projectionMatrix * viewMatrix * w;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float uTime;',
        'uniform vec3 uShallow;',
        'uniform vec3 uDeep;',
        'uniform vec3 uFoamColor;',
        'uniform float uFoamWidth;',
        'uniform float uBands;',
        'varying float vDepth;',
        'varying vec3 vWorld;',
        'varying vec2 vFlow;',
        'varying float vFlowSpeed;',
        'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vnoise(vec2 p) {',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),',
        '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
        '}',
        'void main() {',
        '  float d = max(vDepth, 0.0);',
        // 1. depth tint (optionally quantized into stylized bands)
        '  float t = 1.0 - exp(-d * 0.45);',
        '  if (uBands > 0.5) t = (floor(t * uBands) + 0.5) / uBands;',
        '  vec3 col = mix(uShallow, uDeep, t);',
        // 3. surface motion: scrolling noise perturbs a fake normal -> sun glints.
        //    Lakes drift in world space; rivers scroll along their flow coord.
        '  vec2 p1, p2;',
        '  if (vFlowSpeed > 0.001) {',
        '    p1 = vec2(vFlow.x * 0.5 - uTime * vFlowSpeed, vFlow.y * 1.2);',
        '    p2 = vec2(vFlow.x * 1.6 - uTime * vFlowSpeed * 1.7, vFlow.y * 2.5);',
        '  } else {',
        '    p1 = vWorld.xz * 0.8 + vec2(uTime * 0.06, uTime * 0.045);',
        '    p2 = vWorld.xz * 2.3 - vec2(uTime * 0.11, uTime * 0.08);',
        '  }',
        '  float n = vnoise(p1) * 0.65 + vnoise(p2) * 0.35;',
        '  vec3 N = normalize(vec3((n - 0.5) * 0.6, 1.0, (vnoise(p1.yx) - 0.5) * 0.6));',
        '  float glint = pow(max(dot(N, normalize(vec3(0.35, 0.8, 0.25))), 0.0), 40.0);',
        // 2. foam contact line where water meets terrain, edge wobbled by noise
        '  float foamEdge = uFoamWidth * (0.75 + 0.5 * vnoise(vWorld.xz * 1.7 + uTime * 0.25));',
        '  float foam = 1.0 - smoothstep(foamEdge * 0.6, foamEdge, d);',
        //    rivers: elongated foam streaks racing along the flow
        '  if (vFlowSpeed > 0.001) {',
        '    float streak = vnoise(vec2(vFlow.x * 0.9 - uTime * vFlowSpeed * 1.3, vFlow.y * 2.2));',
        '    foam = max(foam, smoothstep(0.72, 0.95, streak) * 0.65);',
        '  }',
        // 4. fresnel-ish rim: opaque at grazing angles, clear from above
        '  vec3 V = normalize(cameraPosition - vWorld);',
        '  float fres = pow(1.0 - max(dot(V, vec3(0.0, 1.0, 0.0)), 0.0), 2.0);',
        '  float alpha = mix(0.45, 0.85, t) + fres * 0.15;',
        '  col += glint * 0.35 + fres * 0.08;',
        '  col = mix(col, uFoamColor, foam * 0.85);',
        '  alpha = max(alpha, foam * 0.9);',
        '  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));',
        '}'
      ].join('\n')
    });

    // Mist at waterfall bases: soft pulsing white discs (procedural, no textures).
    this.mistMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: [
        'varying vec2 vUv;',
        'varying vec3 vWorld;',
        'void main() {',
        '  vUv = uv;',
        '  vec4 w = modelMatrix * vec4(position, 1.0);',
        '  vWorld = w.xyz;',
        '  gl_Position = projectionMatrix * viewMatrix * w;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float uTime;',
        'varying vec2 vUv;',
        'varying vec3 vWorld;',
        'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float vnoise(vec2 p) {',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),',
        '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
        '}',
        'void main() {',
        '  float r = length(vUv - 0.5) * 2.0;',
        '  float swirl = vnoise(vWorld.xz * 1.8 + vec2(uTime * 0.5, uTime * 0.35));',
        '  float a = smoothstep(1.0, 0.15, r) * (0.3 + 0.35 * swirl);',
        '  gl_FragColor = vec4(vec3(0.97), a);',
        '}'
      ].join('\n')
    });

    this.waterGroup = new THREE.Group();
    this.waterGroup.name = 'water';
    this.waterGroup.renderOrder = 1;

    this.group = new THREE.Group();
    this.group.add(this.chunkGroup);
    this.group.add(this.waterGroup);
  }

  // Advance the water animation (call once per frame from the render loop).
  tick(nowSeconds) {
    this.waterMaterial.uniforms.uTime.value = nowSeconds;
    this.mistMaterial.uniforms.uTime.value = nowSeconds;
  }

  // ===== U2: implicit generated ground (docs/unified-world-design.md) =====
  // Untouched world isn't flat void — it's real terrain generated on demand from
  // continuous world-position noise, so ground exists everywhere and is editable.
  // All functions are pure/deterministic (same result on every client), so a
  // generated chunk never needs syncing; only GM edits are stored/synced and they
  // override the generation.

  // Continuous elevation field 0..1 (broad continents), seam-free by construction.
  _genElev(wx, wz) { return fbm(this.genSeed, wx * 0.0035, wz * 0.0035, 4); }
  // Ground height at a world point. One continuous formula (no piecewise cliffs):
  // a broad elevation base plus hill/detail octaves whose amplitude smoothly
  // rises in high country, so plains are gentle and mountains are tall.
  genHeightAt(wx, wz) {
    const e = this._genElev(wx, wz);
    const hills = fbm(this.genSeed + 50, wx * 0.02, wz * 0.02, 4) - 0.5;
    const detail = fbm(this.genSeed + 99, wx * 0.09, wz * 0.09, 3) - 0.5;
    const m = smooth(Math.max(0, Math.min(1, (e - 0.55) / 0.25))); // 0 plains .. 1 mountains
    const base = (e - 0.5) * 14;                     // broad lowlands/highlands
    return base + hills * (1.2 + m * 7.0) + detail * (0.8 + m * 1.6);
  }
  // Procedural biome at a world point (elevation + moisture), for material choice.
  genBiomeAt(wx, wz) {
    const e = this._genElev(wx, wz);
    if (e > 0.7) return 'mountains';
    if (e < 0.4) return 'coast';
    const mo = fbm(this.genSeed + 200, wx * 0.005, wz * 0.005, 4);
    if (mo < 0.38) return 'desert';
    if (mo > 0.62) return 'forest';
    return 'plains';
  }
  // Material channel (0 grass,1 dirt,2 rock,3 sand) for generated ground.
  genMaterialAt(wx, wz, h) {
    const b = this.genBiomeAt(wx, wz);
    const n = fbm(this.genSeed + 300, wx * 0.05, wz * 0.05, 2);
    if (b === 'mountains') return h > 4 || n > 0.55 ? 2 : (n > 0.35 ? 1 : 0);
    if (b === 'desert') return 3;
    if (b === 'coast') return h < 0.3 ? 3 : 0;
    if (b === 'forest') return n > 0.6 ? 1 : 0;
    return n > 0.72 ? 1 : 0; // plains
  }

  // Allocate a chunk filled from the generator (not synced/saved; regenerated on
  // demand). Marked `generated` so edit/sync paths treat it as disposable.
  _makeGeneratedChunk(cx, cz) {
    const c = { heights: new Float32Array(CHUNK_VERTS * CHUNK_VERTS), splat: new Uint8Array(CHUNK_VERTS * CHUNK_VERTS * 4), mesh: null, generated: true };
    this._fillFromGen(c, cx, cz);
    return c;
  }
  _fillFromGen(c, cx, cz) {
    const gox = cx * CHUNK_VERTS, goz = cz * CHUNK_VERTS;
    for (let lz = 0; lz < CHUNK_VERTS; lz++) {
      for (let lx = 0; lx < CHUNK_VERTS; lx++) {
        const i = lz * CHUNK_VERTS + lx;
        const wx = (gox + lx) * VSPACE, wz = (goz + lz) * VSPACE;
        const h = this.genHeightAt(wx, wz);
        c.heights[i] = h;
        const m = this.genMaterialAt(wx, wz, h);
        c.splat[i * 4] = 0; c.splat[i * 4 + 1] = 0; c.splat[i * 4 + 2] = 0; c.splat[i * 4 + 3] = 0;
        c.splat[i * 4 + m] = 255;
      }
    }
  }

  // ===== global lattice access (vertex coords gx,gz; world = g * VSPACE) =====

  _chunkOf(gx, gz) {
    const cx = Math.floor(gx / CHUNK_VERTS), cz = Math.floor(gz / CHUNK_VERTS);
    return { cx, cz, lx: gx - cx * CHUNK_VERTS, lz: gz - cz * CHUNK_VERTS };
  }

  getH(gx, gz) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const c = this.chunks.get(ckey(cx, cz));
    // Edited/generated chunk in memory, else generate on the fly (U2).
    if (c) return c.heights[lz * CHUNK_VERTS + lx];
    return this.genHeightAt(gx * VSPACE, gz * VSPACE);
  }

  _getSplat(gx, gz, out) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const c = this.chunks.get(ckey(cx, cz));
    if (c) {
      const i = (lz * CHUNK_VERTS + lx) * 4;
      out[0] = c.splat[i]; out[1] = c.splat[i + 1]; out[2] = c.splat[i + 2]; out[3] = c.splat[i + 3];
      return out;
    }
    // Generate on the fly (U2).
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    out[this.genMaterialAt(gx * VSPACE, gz * VSPACE, this.genHeightAt(gx * VSPACE, gz * VSPACE))] = 255;
    return out;
  }

  // Fetch-or-create the chunk owning (gx,gz) as an EDITED chunk, copy-on-write
  // for undo. A brand-new chunk is seeded from the generator (so sculpting
  // untouched ground blends with the terrain that was there); a generated chunk
  // is promoted to edited (its generated data becomes the edit baseline).
  _chunkForWrite(gx, gz) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const k = ckey(cx, cz);
    let c = this.chunks.get(k);
    if (this._strokePatch && !this._strokePatch.has(k)) {
      // A generated chunk had no persisted state before this edit -> patch is null
      // (undo removes it back to generated).
      this._strokePatch.set(k, (c && !c.generated) ? { heights: c.heights.slice(), splat: c.splat.slice() } : null);
    }
    if (!c) { c = this._makeGeneratedChunk(cx, cz); this.chunks.set(k, c); }
    c.generated = false; // now authored: it will sync and persist
    return { c, k, cx, cz, lx, lz };
  }

  _markDirty(k, cx, cz, lx, lz, layer) {
    let d = this._dirtyData.get(k);
    if (!d) { d = { heights: false, splat: false }; this._dirtyData.set(k, d); }
    d[layer] = true;
    this._dirtyMesh.add(k);
    // A border vertex is read by neighbor meshes (position apron at low edges,
    // normals at both edges) — mark them for rebuild too.
    if (lx === 0) this._dirtyMesh.add(ckey(cx - 1, cz));
    if (lx >= CHUNK_VERTS - 1) this._dirtyMesh.add(ckey(cx + 1, cz));
    if (lz === 0) this._dirtyMesh.add(ckey(cx, cz - 1));
    if (lz >= CHUNK_VERTS - 1) this._dirtyMesh.add(ckey(cx, cz + 1));
    if (lx === 0 && lz === 0) this._dirtyMesh.add(ckey(cx - 1, cz - 1));
    if (lx === 0 && lz >= CHUNK_VERTS - 1) this._dirtyMesh.add(ckey(cx - 1, cz + 1));
    if (lx >= CHUNK_VERTS - 1 && lz === 0) this._dirtyMesh.add(ckey(cx + 1, cz - 1));
    if (lx >= CHUNK_VERTS - 1 && lz >= CHUNK_VERTS - 1) this._dirtyMesh.add(ckey(cx + 1, cz + 1));
  }

  setH(gx, gz, v) {
    const { c, k, cx, cz, lx, lz } = this._chunkForWrite(gx, gz);
    c.heights[lz * CHUNK_VERTS + lx] = Math.max(-HEIGHT_LIMIT, Math.min(HEIGHT_LIMIT, v));
    this._markDirty(k, cx, cz, lx, lz, 'heights');
  }

  // Bilinear height at world (x,z); 0 where no chunk exists (implicit flat ground).
  sampleHeight(x, z) {
    const fx = x / VSPACE, fz = z / VSPACE;
    const gx = Math.floor(fx), gz = Math.floor(fz);
    const tx = fx - gx, tz = fz - gz;
    const h00 = this.getH(gx, gz), h10 = this.getH(gx + 1, gz);
    const h01 = this.getH(gx, gz + 1), h11 = this.getH(gx + 1, gz + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  // Dominant material channel at world (x,z) (eyedropper).
  dominantMaterial(x, z) {
    const s = this._getSplat(Math.round(x / VSPACE), Math.round(z / VSPACE), [0, 0, 0, 0]);
    let best = 0;
    for (let m = 1; m < 4; m++) if (s[m] > s[best]) best = m;
    return best;
  }

  // ===== brush cursor (drawn by the shared material's shader) =====
  setBrush({ x, z, radius, color, visible }) {
    const u = this._brushUniforms;
    if (x != null && z != null) u.uBrushPos.value.set(x, z);
    if (radius != null) u.uBrushRadius.value = radius;
    if (color != null) u.uBrushColor.value.set(color);
    if (visible != null) u.uBrushVisible.value = visible ? 1 : 0;
  }

  // ===== editing (world-space coords; chunks auto-created as touched) =====

  // Run cb(gx, gz, falloff) for every lattice vertex within `radius` of (x,z).
  _forEachInRadius(x, z, radius, cb) {
    const rg = radius / VSPACE, cx = x / VSPACE, cz = z / VSPACE;
    const x0 = Math.floor(cx - rg), x1 = Math.ceil(cx + rg);
    const z0 = Math.floor(cz - rg), z1 = Math.ceil(cz + rg);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const d = Math.hypot(gx - cx, gz - cz);
        if (d > rg) continue;
        cb(gx, gz, smooth(1 - d / rg));
      }
    }
  }

  // Sculpting. mode: raise|lower|smooth|flatten|noise|terrace. ref = flatten target.
  sculpt(x, z, radius, strength, mode, ref = 0) {
    if (mode === 'smooth') {
      const updates = [];
      this._forEachInRadius(x, z, radius, (gx, gz, f) => {
        let sum = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { sum += this.getH(gx + dx, gz + dz); n++; }
        updates.push([gx, gz, this.getH(gx, gz) + (sum / n - this.getH(gx, gz)) * f * Math.min(1, strength)]);
      });
      for (const [gx, gz, v] of updates) this.setH(gx, gz, v);
    } else {
      this._forEachInRadius(x, z, radius, (gx, gz, f) => {
        const h = this.getH(gx, gz);
        let v = h;
        if (mode === 'raise') v = h + strength * f;
        else if (mode === 'lower') v = h - strength * f;
        else if (mode === 'flatten') v = h + (ref - h) * f * Math.min(1, strength);
        else if (mode === 'noise') v = h + (Math.random() - 0.5) * 2 * strength * f;
        else if (mode === 'terrace') {
          const step = Math.max(0.25, strength * 4);
          v = h + (Math.round(h / step) * step - h) * f * 0.5;
        }
        if (v !== h) this.setH(gx, gz, v);
      });
    }
    // NOTE: no mesh rebuild here — sculpt() runs per dab, and a fast stroke lays
    // many dabs per input event. The caller flushes once via flushMeshes().
  }

  // Material painting toward channel matIndex (0..3).
  paint(x, z, radius, strength, matIndex) {
    this._forEachInRadius(x, z, radius, (gx, gz, f) => {
      const amt = Math.round(255 * strength * f);
      if (amt === 0) return;
      const { c, k, cx, cz, lx, lz } = this._chunkForWrite(gx, gz);
      const i = (lz * CHUNK_VERTS + lx) * 4;
      for (let m = 0; m < 4; m++) {
        const cur = c.splat[i + m];
        c.splat[i + m] = m === matIndex ? Math.min(255, cur + amt) : Math.max(0, cur - amt);
      }
      this._markDirty(k, cx, cz, lx, lz, 'splat');
    });
    // No rebuild here either — see sculpt(); callers flushMeshes() per event.
  }

  // Rebuild all mesh-dirty chunks. Call once per input event after a batch of
  // sculpt()/paint() dabs (ramp/applyPatch/applyData flush themselves).
  flushMeshes() { this._rebuildDirtyMeshes(); }

  // Scene-space position of a chunk mesh's local origin (its (gx=cx*CHUNK_VERTS)
  // corner) = true world corner minus the floating origin.
  _chunkScenePos(cx, cz) {
    return {
      x: cx * CHUNK_VERTS * VSPACE - this.worldOrigin.x,
      z: cz * CHUNK_VERTS * VSPACE - this.worldOrigin.z
    };
  }

  // Rebase the floating origin: shift every live mesh so game-logic world coords
  // stay unchanged but rendered transforms return near zero. Water/river meshes
  // carry their anchor in userData so they reposition without a rebuild.
  setWorldOrigin(x, z) {
    this.worldOrigin.x = x; this.worldOrigin.z = z;
    for (const [k, c] of this.chunks) {
      if (!c.mesh) continue;
      const [cx, cz] = k.split(',').map(Number);
      const p = this._chunkScenePos(cx, cz);
      c.mesh.position.set(p.x, 0, p.z);
    }
    for (const obj of this._waterMeshes.values()) {
      const a = obj.userData.anchor;
      if (a) obj.position.set(a.x - x, 0, a.z - z);
    }
  }

  // Hard-set one vertex's material channel (used by seeding, not brushes).
  _paintVertex(gx, gz, mat) {
    const { c, k, cx, cz, lx, lz } = this._chunkForWrite(gx, gz);
    const i = (lz * CHUNK_VERTS + lx) * 4;
    c.splat[i] = 0; c.splat[i + 1] = 0; c.splat[i + 2] = 0; c.splat[i + 3] = 0;
    c.splat[i + mat] = 255;
    this._markDirty(k, cx, cz, lx, lz, 'splat');
  }

  // Generate starting terrain for a fresh tactical map from its inherited hex
  // biome. Deterministic per (biome, seedStr): every client that ran this would
  // agree — but only the GM runs it and uploads the resulting chunks, so it
  // syncs like hand-sculpted terrain. Covers a 4x4-chunk area centered on the
  // origin; the world beyond stays implicit flat ground for the GM to extend.
  // Material channels: 0 grass, 1 dirt, 2 rock, 3 sand.
  seedFromBiome(biome, seedStr, radiusChunks = 2) {
    const seed = hashStr(seedStr + '|' + biome);
    const R = radiusChunks * CHUNK_VERTS; // lattice verts each side of origin
    const coastAxis = seed % 4; // which side the coast biome slopes down to
    const heightAt = (wx, wz) => {
      const n1 = fbm(seed, wx * 0.025, wz * 0.025);
      const n2 = fbm(seed + 777, wx * 0.06, wz * 0.06);
      switch (biome) {
        case 'plains':    return n1 * 2.2 - 0.6;
        case 'forest':    return n1 * 3.4 - 0.9 + n2 * 0.6;
        case 'mountains': return Math.pow(1 - Math.abs(2 * n1 - 1), 1.6) * 9 - 1 + n2 * 1.5;
        case 'desert':    return fbm(seed, wx * 0.02, wz * 0.045) * 2.6 - 0.5;
        case 'swamp':     return n1 * 1.2 - 0.65;
        case 'coast': {
          const span = R * VSPACE;
          const t = coastAxis === 0 ? wx / span : coastAxis === 1 ? -wx / span
                  : coastAxis === 2 ? wz / span : -wz / span;
          return n1 * 2.0 - 0.2 - (t + 1) * 2.2 + 1.4; // slopes into the sea
        }
        default: return n1 * 2 - 0.6;
      }
    };
    // Pass 1: heights.
    for (let gz = -R; gz < R; gz++) {
      for (let gx = -R; gx < R; gx++) {
        this.setH(gx, gz, heightAt(gx * VSPACE, gz * VSPACE));
      }
    }
    // Pass 2: materials from height + slope + variety noise.
    let minH = Infinity, minAt = { x: 0, z: 0 };
    for (let gz = -R; gz < R; gz++) {
      for (let gx = -R; gx < R; gx++) {
        const h = this.getH(gx, gz);
        if (h < minH) { minH = h; minAt = { x: gx * VSPACE, z: gz * VSPACE }; }
        const sx = (this.getH(gx + 1, gz) - this.getH(gx - 1, gz)) / (2 * VSPACE);
        const sz = (this.getH(gx, gz + 1) - this.getH(gx, gz - 1)) / (2 * VSPACE);
        const slope = Math.hypot(sx, sz);
        const n2 = fbm(seed + 777, gx * VSPACE * 0.06, gz * VSPACE * 0.06);
        let mat = 0; // grass
        if (biome === 'desert') mat = (slope > 1.4 || n2 > 0.75) ? 2 : 3;
        else if (biome === 'mountains') mat = (h > 3.5 || slope > 1.1) ? 2 : (h < 0.5 ? 0 : (n2 > 0.5 ? 1 : 0));
        else if (biome === 'swamp') mat = h < -0.2 ? 1 : 0;
        else if (biome === 'coast') mat = h < 0.4 ? 3 : (slope > 1.3 ? 2 : 0);
        else { // plains / forest
          if (slope > 1.3) mat = 2;
          else if (n2 > (biome === 'forest' ? 0.55 : 0.62)) mat = 1;
        }
        if (mat !== 0) this._paintVertex(gx, gz, mat);
      }
    }
    this._rebuildDirtyMeshes();
    // Wet biomes come with water poured at the lowest point.
    if (biome === 'swamp' && minH < -0.3) {
      this.addLake({ x: minAt.x, z: minAt.z, level: Math.min(-0.15, minH + 0.4) });
    } else if (biome === 'coast' && minH < -0.6) {
      this.addLake({ x: minAt.x, z: minAt.z, level: -0.3, maxRadius: 160 });
    }
    this.refreshWater();
  }

  // Ramp: blend heights linearly from (x0,z0,h0) to (x1,z1,h1) along the segment,
  // over a band `halfWidth` wide with smooth falloff at the edges.
  ramp(x0, z0, h0, x1, z1, h1, halfWidth, strength = 1) {
    const dx = x1 - x0, dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-6) return;
    const s = Math.min(1, strength);
    const gx0 = Math.floor((Math.min(x0, x1) - halfWidth) / VSPACE), gx1 = Math.ceil((Math.max(x0, x1) + halfWidth) / VSPACE);
    const gz0 = Math.floor((Math.min(z0, z1) - halfWidth) / VSPACE), gz1 = Math.ceil((Math.max(z0, z1) + halfWidth) / VSPACE);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * VSPACE, z = gz * VSPACE;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / lenSq));
        const dist = Math.hypot(x - (x0 + t * dx), z - (z0 + t * dz));
        if (dist > halfWidth) continue;
        const target = h0 + (h1 - h0) * t;
        const h = this.getH(gx, gz);
        this.setH(gx, gz, h + (target - h) * smooth(1 - dist / halfWidth) * s);
      }
    }
    this._rebuildDirtyMeshes();
  }

  // ===== undo (copy-on-write patches, only chunks touched by the stroke) =====

  beginStroke() { this._strokePatch = new Map(); }

  // Close the stroke; returns { "cx,cz": { heights, splat } | null } (null =
  // chunk did not exist before), or null if nothing was touched.
  endStroke() {
    const p = this._strokePatch;
    this._strokePatch = null;
    if (!p || p.size === 0) return null;
    const out = {};
    for (const [k, v] of p) out[k] = v;
    return out;
  }

  // Restore a patch; returns the inverse patch (for redo). Marks restored chunks dirty.
  applyPatch(patch) {
    const inverse = {};
    for (const k of Object.keys(patch)) {
      const cur = this.chunks.get(k);
      inverse[k] = cur ? { heights: cur.heights.slice(), splat: cur.splat.slice() } : null;
      const v = patch[k];
      if (v === null) {
        this._disposeChunkMesh(k);
        this.chunks.delete(k);
      } else {
        let c = this.chunks.get(k);
        if (!c) { c = newChunk(); this.chunks.set(k, c); }
        c.heights.set(v.heights);
        c.splat.set(v.splat);
      }
      this._markChunkDirtyAll(k);
    }
    this._rebuildDirtyMeshes();
    this.refreshWater();
    // A deleted chunk may sit inside the window; re-evaluate it so the hole
    // regenerates as ground instead of staying empty until the camera moves.
    this._windowCenter = null;
    return inverse;
  }

  _markChunkDirtyAll(k) {
    const [cx, cz] = k.split(',').map(Number);
    this._dirtyData.set(k, { heights: true, splat: true });
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this._dirtyMesh.add(ckey(cx + dx, cz + dz));
  }

  // ===== meshes =====

  _disposeChunkMesh(k) {
    const c = this.chunks.get(k);
    if (c && c.mesh) {
      this.chunkGroup.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh = null;
    }
  }

  _buildChunkMesh(k) {
    const c = this.chunks.get(k);
    if (!c) return;
    if (!c.mesh) {
      const geo = new THREE.BufferGeometry();
      geo.setIndex(sharedIndex());
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MESH_VERTS * MESH_VERTS * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MESH_VERTS * MESH_VERTS * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MESH_VERTS * MESH_VERTS * 3), 3));
      c.mesh = new THREE.Mesh(geo, this.material);
      c.mesh.receiveShadow = true;
      c.mesh.castShadow = true;
      c.mesh.name = 'terrain';
      this.chunkGroup.add(c.mesh);
    }
    const [cx, cz] = k.split(',').map(Number);
    const gox = cx * CHUNK_VERTS, goz = cz * CHUNK_VERTS;
    // Geometry is chunk-LOCAL (verts run 0..CHUNK_SIZE); the chunk's world
    // position lives on the mesh transform, offset by the floating origin.
    const sp = this._chunkScenePos(cx, cz);
    c.mesh.position.set(sp.x, 0, sp.z);
    const pos = c.mesh.geometry.attributes.position;
    const nor = c.mesh.geometry.attributes.normal;
    const col = c.mesh.geometry.attributes.color;
    const s = [0, 0, 0, 0];
    const cc = new THREE.Color();
    for (let lz = 0; lz < MESH_VERTS; lz++) {
      for (let lx = 0; lx < MESH_VERTS; lx++) {
        const i = lz * MESH_VERTS + lx;
        const gx = gox + lx, gz = goz + lz;
        const h = this.getH(gx, gz);
        pos.setXYZ(i, lx * VSPACE, h, lz * VSPACE);
        // Central-difference normal over the global lattice (seamless).
        const nx = (this.getH(gx - 1, gz) - this.getH(gx + 1, gz)) / (2 * VSPACE);
        const nz = (this.getH(gx, gz - 1) - this.getH(gx, gz + 1)) / (2 * VSPACE);
        const inv = 1 / Math.hypot(nx, 1, nz);
        nor.setXYZ(i, nx * inv, inv, nz * inv);
        this._getSplat(gx, gz, s);
        let r = 0, g = 0, b = 0, sum = 0;
        for (let m = 0; m < 4; m++) { sum += s[m]; r += MAT_COLORS[m].r * s[m]; g += MAT_COLORS[m].g * s[m]; b += MAT_COLORS[m].b * s[m]; }
        if (sum > 0) cc.setRGB(r / sum, g / sum, b / sum); else cc.copy(MAT_COLORS[0]);
        col.setXYZ(i, cc.r, cc.g, cc.b);
      }
    }
    pos.needsUpdate = true; nor.needsUpdate = true; col.needsUpdate = true;
    c.mesh.geometry.computeBoundingSphere();
  }

  // Rebuild dirty meshes that are actually on screen (or would be): rebuild any
  // chunk that already has a mesh, or a newly-edited chunk inside the window.
  // Off-window chunks are left for updateWindow to build when panned to — so a
  // large world doesn't build thousands of meshes at once on load.
  _rebuildDirtyMeshes() {
    const wc = this._windowCenter, r = this.windowRadius;
    for (const k of this._dirtyMesh) {
      const c = this.chunks.get(k);
      if (!c) continue;
      let build = c.mesh != null;
      if (!build && wc) {
        const [kx, kz] = k.split(',').map(Number);
        build = Math.max(Math.abs(kx - wc.cx), Math.abs(kz - wc.cz)) <= r;
      }
      if (build) this._buildChunkMesh(k);
    }
    this._dirtyMesh.clear();
  }

  // Streaming window: generate + mesh the chunks around the camera (U2 — ground
  // exists everywhere), and drop meshes (and disposable generated data) outside
  // it. Edited chunks keep their data when out of window; only their mesh is freed.
  updateWindow(center) {
    const cx = Math.floor(center.x / CHUNK_SIZE), cz = Math.floor(center.z / CHUNK_SIZE);
    if (this._windowCenter && this._windowCenter.cx === cx && this._windowCenter.cz === cz) return;
    this._windowCenter = { cx, cz };
    const r = this.windowRadius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const kx = cx + dx, kz = cz + dz, k = ckey(kx, kz);
        let c = this.chunks.get(k);
        if (!c) { c = this._makeGeneratedChunk(kx, kz); this.chunks.set(k, c); }
        if (!c.mesh) this._buildChunkMesh(k);
      }
    }
    for (const [k, c] of this.chunks) {
      const [kx, kz] = k.split(',').map(Number);
      if (Math.max(Math.abs(kx - cx), Math.abs(kz - cz)) > r + 1) {
        if (c.mesh) this._disposeChunkMesh(k);
        if (c.generated) this.chunks.delete(k); // regenerated deterministically on return
      }
    }
  }

  // ===== water v2: authored bodies with physically settled footprints =====
  // (docs/water-v2-design.md) Lakes "pour" at a seed point: a priority-flood
  // fills exactly the connected basin under the click, clamped to the basin's
  // spill point and to maxRadius. Deterministic on the shared quantized heights.

  // Cell height for flood connectivity: max of the cell's 4 corner verts, so
  // thin ridges block water (conservative — no leaking through corners).
  _cellFloodHeight(cx, cz) {
    const gx = cx * 2, gz = cz * 2; // 1-unit cells; lattice is 0.5 u
    return Math.max(this.getH(gx, gz), this.getH(gx + 2, gz),
                    this.getH(gx, gz + 2), this.getH(gx + 2, gz + 2));
  }

  // Pour at world (x,z) up to `level`: returns { cells:Set<"cx,cz">, level }.
  // The returned level may be lower than requested (basin spill / radius clamp).
  _computeLakeFootprint(seedX, seedZ, level, maxRadius = 96) {
    const seedCx = Math.floor(seedX), seedCz = Math.floor(seedZ);
    const maxCells = 80000; // hard safety cap
    // Binary min-heap of [floodHeight, cx, cz]
    const heap = [];
    const push = (e) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };

    const flood = new Map();   // "cx,cz" -> flood height needed to reach it
    const seen = new Set();
    let finalLevel = level;
    push([this._cellFloodHeight(seedCx, seedCz), seedCx, seedCz]);
    seen.add(seedCx + ',' + seedCz);
    let spill = -Infinity;
    while (heap.length && flood.size < maxCells) {
      const [h, cx, cz] = pop();
      spill = Math.max(spill, h);
      if (spill > level) break; // basin holds the requested level: done
      if (Math.max(Math.abs(cx - seedCx), Math.abs(cz - seedCz)) >= maxRadius) {
        // Basin leaks past containment: clamp the level to just under the leak.
        finalLevel = Math.min(finalLevel, spill - 0.01);
        break;
      }
      flood.set(cx + ',' + cz, spill);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = (cx + dx) + ',' + (cz + dz);
        if (seen.has(nk)) continue;
        seen.add(nk);
        push([this._cellFloodHeight(cx + dx, cz + dz), cx + dx, cz + dz]);
      }
    }
    const cells = new Set();
    for (const [k, h] of flood) if (h <= finalLevel) cells.add(k);
    return { cells, level: finalLevel };
  }

  _clearWaterMesh(id) {
    const obj = this._waterMeshes.get(id);
    if (obj) {
      this.waterGroup.remove(obj);
      obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      if (obj.geometry) obj.geometry.dispose();
      this._waterMeshes.delete(id);
    }
  }

  // Rebuild one lake's surface mesh from its footprint: 1-unit quads at the
  // water level, with per-vertex aDepth (level - corner height) for the shader.
  // Terrain depth-clips the quads, so the shoreline follows the ground exactly.
  _buildLakeMesh(body) {
    this._clearWaterMesh(body.id);
    const fp = this._footprints.get(body.id);
    if (!fp || fp.cells.size === 0) return;
    const level = fp.level;
    // Anchor-local geometry (floating-origin safe): cell verts are relative to
    // the lake's seed cell; the mesh transform carries the world position.
    const ax = Math.round(body.seed.x), az = Math.round(body.seed.z);
    const pos = [], depth = [];
    const corner = (cx, cz) => level - this.getH(cx * 2, cz * 2);
    for (const k of fp.cells) {
      const [cx, cz] = k.split(',').map(Number);
      const d00 = corner(cx, cz), d10 = corner(cx + 1, cz);
      const d01 = corner(cx, cz + 1), d11 = corner(cx + 1, cz + 1);
      const x0 = cx - ax, x1 = cx + 1 - ax, z0 = cz - az, z1 = cz + 1 - az;
      pos.push(x0, level, z0,  x1, level, z0,  x1, level, z1,
               x0, level, z0,  x1, level, z1,  x0, level, z1);
      depth.push(d00, d10, d11, d00, d11, d01);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
    // Lakes don't flow: zero the flow attributes the shared shader expects.
    const vcount = pos.length / 3;
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array(vcount * 2), 2));
    geo.setAttribute('aFlowSpeed', new THREE.Float32BufferAttribute(new Float32Array(vcount), 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.waterMaterial);
    mesh.renderOrder = 1;
    mesh.name = 'water';
    mesh.position.set(ax - this.worldOrigin.x, 0, az - this.worldOrigin.z);
    mesh.userData.anchor = { x: ax, z: az };
    this._waterMeshes.set(body.id, mesh);
    this.waterGroup.add(mesh);
  }

  // --- rivers (W2/W3): Catmull-Rom ribbon draped on the terrain ---

  // Spline samples every ~1 world unit through the GM's waypoints.
  _riverSamples(points) {
    if (!points || points.length < 2) return [];
    const curve = new THREE.CatmullRomCurve3(
      points.map(p => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
    const n = Math.max(2, Math.min(2048, Math.ceil(curve.getLength())));
    return curve.getSpacedPoints(n).map(v => ({ x: v.x, z: v.z }));
  }

  // Carve the river bed into the terrain: lower vertices near the path toward
  // (surface - depth), full depth at the centerline fading to zero at the
  // banks. Uses setH, so it is COW-undoable and syncs as normal chunk edits.
  carveRiverBed(points, halfWidth, depth) {
    const samples = this._riverSamples(points);
    const targets = samples.map(s => ({ x: s.x, z: s.z, t: this.sampleHeight(s.x, s.z) - depth }));
    // Smooth the bed profile along the path so it doesn't inherit bumps.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < targets.length - 1; i++) {
        targets[i].t = (targets[i - 1].t + targets[i].t * 2 + targets[i + 1].t) / 4;
      }
    }
    for (const s of targets) {
      this._forEachInRadius(s.x, s.z, halfWidth, (gx, gz, f) => {
        const h = this.getH(gx, gz);
        const target = s.t + (1 - f) * depth; // centerline hits s.t, banks stay
        if (h > target) this.setH(gx, gz, h + (target - h) * Math.min(1, f * 1.5));
      });
    }
  }

  // Ribbon mesh: 3 vertices per sample (left bank / center / right bank),
  // draped on the terrain. Steep drops become waterfalls (foam-white) with a
  // pulsing mist disc at their base.
  _buildRiverMesh(body, samples) {
    this._clearWaterMesh(body.id);
    if (!samples || samples.length < 2) return;
    // Drape + smooth heights along the path.
    const hs = samples.map(s => this.sampleHeight(s.x, s.z));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < hs.length - 1; i++) hs[i] = (hs[i - 1] + hs[i] * 2 + hs[i + 1]) / 4;
    }
    // Ends that touch a lake blend to its surface so rivers visibly feed lakes.
    const blendToLake = (end, dir) => {
      const lake = this.findLakeAt(samples[end].x, samples[end].z);
      if (!lake) return;
      const fp = this._footprints.get(lake.id);
      const lvl = fp ? fp.level : lake.level;
      for (let k = 0; k < 5; k++) {
        const i = end + dir * k;
        if (i < 0 || i >= hs.length) break;
        const w = 1 - k / 5;
        hs[i] = hs[i] * (1 - w) + (lvl - 0.06) * w;
      }
    };
    blendToLake(0, 1);
    blendToLake(samples.length - 1, -1);

    const half = body.width / 2;
    // Anchor-local geometry (floating-origin safe): verts are relative to the
    // river's first sample; the group transform carries the world position.
    const ax = samples[0].x, az = samples[0].z;
    const pos = [], depth = [], flow = [], fspd = [], idx = [];
    const mistBases = [];
    let arc = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const px = -tz, pz = tx; // path-perpendicular in XZ
      if (i > 0) arc += Math.hypot(s.x - samples[i - 1].x, s.z - samples[i - 1].z);
      const fall = i > 0 && (hs[i - 1] - hs[i]) > 1.2; // steep drop = waterfall
      if (fall) mistBases.push({ x: s.x - ax, y: hs[i], z: s.z - az });
      const y = hs[i] + 0.06;
      const dEdge = fall ? 0.02 : 0.06, dMid = fall ? 0.05 : 0.5; // shallow = foamy
      const lx = s.x - ax, lz = s.z - az;
      pos.push(lx - px * half, y, lz - pz * half, lx, y, lz, lx + px * half, y, lz + pz * half);
      depth.push(dEdge, dMid, dEdge);
      flow.push(arc, -1, arc, 0, arc, 1);
      fspd.push(body.speed, body.speed, body.speed);
      if (i > 0) {
        const o = (i - 1) * 3;
        idx.push(o, o + 3, o + 1, o + 1, o + 3, o + 4, o + 1, o + 4, o + 2, o + 2, o + 4, o + 5);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    geo.setAttribute('aFlowSpeed', new THREE.Float32BufferAttribute(fspd, 1));
    geo.computeBoundingSphere();
    const group = new THREE.Group();
    group.name = 'water';
    group.position.set(ax - this.worldOrigin.x, 0, az - this.worldOrigin.z);
    group.userData.anchor = { x: ax, z: az };
    const ribbon = new THREE.Mesh(geo, this.waterMaterial);
    ribbon.renderOrder = 1;
    group.add(ribbon);
    for (const m of mistBases) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(half * 1.5, 20), this.mistMaterial);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(m.x, m.y + 0.14, m.z); // already anchor-local
      disc.renderOrder = 2;
      group.add(disc);
    }
    this._waterMeshes.set(body.id, group);
    this.waterGroup.add(group);
  }

  _recomputeBody(body) {
    if (body.kind === 'river') {
      const samples = this._riverSamples(body.points);
      this._footprints.set(body.id, { samples, width: body.width });
      this._buildRiverMesh(body, samples);
      return;
    }
    this._footprints.set(body.id,
      this._computeLakeFootprint(body.seed.x, body.seed.z, body.level, body.maxRadius || 96));
    this._buildLakeMesh(body);
  }

  // Re-settle every body against the current terrain (stroke end, undo, remote
  // chunk updates). Cheap: a few ms per body, and body counts are small.
  refreshWater() {
    const liveIds = new Set(this.water.bodies.map(b => b.id));
    for (const id of [...this._waterMeshes.keys()]) {
      if (!liveIds.has(id)) { this._clearWaterMesh(id); this._footprints.delete(id); }
    }
    for (const body of this.water.bodies) this._recomputeBody(body);
  }

  // --- body management (GM tools) ---
  addLake({ x, z, level, maxRadius = 96 }) {
    const body = {
      id: 'w' + Math.random().toString(36).slice(2, 8),
      kind: 'lake', seed: { x, z }, level, maxRadius
    };
    this.water.bodies.push(body);
    this._recomputeBody(body);
    return body;
  }
  updateLake(id, { level }) {
    const body = this.water.bodies.find(b => b.id === id);
    if (!body) return;
    if (level != null) body.level = level;
    this._recomputeBody(body);
  }
  removeBody(id) {
    this.water.bodies = this.water.bodies.filter(b => b.id !== id);
    this._clearWaterMesh(id);
    this._footprints.delete(id);
  }
  addRiver({ points, width = 2.5, speed = 1 }) {
    const body = {
      id: 'w' + Math.random().toString(36).slice(2, 8),
      kind: 'river', points: points.map(p => ({ x: p.x, z: p.z })), width, speed
    };
    this.water.bodies.push(body);
    this._recomputeBody(body);
    return body;
  }
  // Which lake footprint contains world (x,z)? Used for click-select/delete.
  findLakeAt(x, z) {
    const k = Math.floor(x) + ',' + Math.floor(z);
    for (const body of this.water.bodies) {
      if (body.kind !== 'lake') continue;
      const fp = this._footprints.get(body.id);
      if (fp && fp.cells && fp.cells.has(k)) return body;
    }
    return null;
  }
  // Which river ribbon passes near world (x,z)? Used for Alt+click delete.
  findRiverAt(x, z) {
    for (const body of this.water.bodies) {
      if (body.kind !== 'river') continue;
      const fp = this._footprints.get(body.id);
      if (!fp || !fp.samples) continue;
      const r = fp.width / 2 + 0.4;
      for (const s of fp.samples) {
        if (Math.hypot(s.x - x, s.z - z) <= r) return body;
      }
    }
    return null;
  }

  // --- water sync (bodies only; footprints are always recomputed locally) ---
  getWaterData() {
    return {
      bodies: this.water.bodies.map(b => b.kind === 'river'
        ? { ...b, points: b.points.map(p => ({ ...p })) }
        : { ...b, seed: { ...b.seed } })
    };
  }
  setWaterData(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.bodies)) {
      this.water.bodies = data.bodies
        .filter(b => b && (
          (b.kind === 'lake' && b.seed && isFinite(b.level)) ||
          (b.kind === 'river' && Array.isArray(b.points) && b.points.length >= 2)))
        .map(b => b.kind === 'lake'
          ? { id: String(b.id), kind: 'lake',
              seed: { x: +b.seed.x, z: +b.seed.z },
              level: +b.level, maxRadius: +b.maxRadius || 96 }
          : { id: String(b.id), kind: 'river',
              points: b.points.slice(0, 256).map(p => ({ x: +p.x, z: +p.z })),
              width: Math.max(0.5, Math.min(16, +b.width || 2.5)),
              speed: Math.max(0.1, Math.min(4, +b.speed || 1)) });
    } else if (data.enabled != null) {
      // Legacy global sheet: convert to one lake seeded at the lowest vertex.
      this.water.bodies = [];
      if (data.enabled && this.chunks.size) {
        let best = null;
        for (const [k, c] of this.chunks) {
          const [cx, cz] = k.split(',').map(Number);
          for (let i = 0; i < c.heights.length; i++) {
            if (!best || c.heights[i] < best.h) {
              best = { h: c.heights[i],
                       x: (cx * CHUNK_VERTS + (i % CHUNK_VERTS)) * VSPACE,
                       z: (cz * CHUNK_VERTS + ((i / CHUNK_VERTS) | 0)) * VSPACE };
            }
          }
        }
        if (best && best.h < (Number(data.level) || 0)) {
          this.addLake({ x: best.x, z: best.z, level: Number(data.level) || 0 });
          return; // addLake already recomputed
        }
      }
    }
    this.refreshWater();
  }

  // Clear everything (map switch or GM reset). Local only; the caller syncs.
  reset() {
    if (this._strokePatch) {
      for (const [k, c] of this.chunks) {
        if (c.generated) continue; // generated ground regenerates; not part of undo
        if (!this._strokePatch.has(k)) this._strokePatch.set(k, { heights: c.heights.slice(), splat: c.splat.slice() });
      }
    }
    for (const k of [...this.chunks.keys()]) this._disposeChunkMesh(k);
    this.chunks.clear();
    this._dirtyData.clear();
    this._dirtyMesh.clear();
    this._windowCenter = null;
    this.water = { bodies: [] };
    this.refreshWater();
  }

  // ===== serialization / sync =====

  _encodeChunk(c, layers) {
    const out = {};
    if (layers.heights) {
      const q = new Int16Array(CHUNK_VERTS * CHUNK_VERTS);
      for (let i = 0; i < q.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(c.heights[i] / HEIGHT_QUANT)));
      out.heights = u8ToB64(new Uint8Array(q.buffer));
    }
    if (layers.splat) out.splat = u8ToB64(c.splat);
    return out;
  }

  _decodeInto(c, data) {
    if (typeof data.heights === 'string') {
      const u8 = b64ToU8(data.heights);
      const q = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
      const n = Math.min(q.length, CHUNK_VERTS * CHUNK_VERTS);
      for (let i = 0; i < n; i++) c.heights[i] = q[i] * HEIGHT_QUANT;
    }
    if (typeof data.splat === 'string') {
      const u8 = b64ToU8(data.splat);
      c.splat.set(u8.subarray(0, CHUNK_VERTS * CHUNK_VERTS * 4));
    }
  }

  // Drain the dirty-data set into a sync payload (null if nothing changed).
  collectDirtyPayload() {
    if (this._dirtyData.size === 0) return null;
    const chunks = {};
    let heightsChanged = false;
    for (const [k, layers] of this._dirtyData) {
      const c = this.chunks.get(k);
      if (!c) { chunks[k] = null; continue; }
      chunks[k] = this._encodeChunk(c, layers);
      if (layers.heights) heightsChanged = true;
    }
    this._dirtyData.clear();
    return { chunks, heightsChanged };
  }

  // Encode specific chunks (after undo/redo); missing OR generated chunks encode
  // as null (generated ground is never persisted — it regenerates deterministically).
  payloadForKeys(keys) {
    const chunks = {};
    for (const k of keys) {
      const c = this.chunks.get(k);
      chunks[k] = (c && !c.generated) ? this._encodeChunk(c, { heights: true, splat: true }) : null;
    }
    return { chunks };
  }

  // All EDITED chunks, split into batches that stay well under the socket buffer.
  fullPayloadBatches(batchSize = 8) {
    const keys = [...this.chunks.keys()].filter(k => !this.chunks.get(k).generated);
    const batches = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(this.payloadForKeys(keys.slice(i, i + batchSize)));
    }
    if (batches.length > 0) batches[0].water = this.getWaterData();
    return batches;
  }

  // Apply a v2 payload or a legacy v1 blob. Returns { changed, migrated }.
  applyData(data) {
    if (!data) return { changed: false, migrated: false };
    let changed = false, migrated = false, deleted = false;
    if (data.format === 2 || data.chunks) {
      for (const k of Object.keys(data.chunks || {})) {
        if (!/^-?\d+,-?\d+$/.test(k)) continue;
        const v = data.chunks[k];
        if (v === null) {
          this._disposeChunkMesh(k);
          this.chunks.delete(k);
          deleted = true;
        } else {
          let c = this.chunks.get(k);
          if (!c) { c = newChunk(); this.chunks.set(k, c); }
          this._decodeInto(c, v);
          c.generated = false; // authoritative server/GM data overrides generation
        }
        const [cx, cz] = k.split(',').map(Number);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this._dirtyMesh.add(ckey(cx + dx, cz + dz));
        changed = true;
      }
    } else if (typeof data.heights === 'string' || typeof data.splat === 'string') {
      this._migrateV1(data);
      changed = true; migrated = true;
    }
    this._rebuildDirtyMeshes();
    if (deleted) this._windowCenter = null; // regenerate any deleted-but-in-window holes
    if (data.water) this.setWaterData(data.water);
    else if (changed) this.refreshWater(); // terrain moved: lakes re-settle
    return { changed, migrated };
  }

  // Legacy v1: one 128^2 tile over [-50,50] at ~0.787 spacing. Resample onto the
  // new 0.5 lattice covering the same square.
  _migrateV1(data) {
    const RES1 = data.res || 128, SIZE1 = data.size || 100, HALF1 = SIZE1 / 2;
    const step1 = SIZE1 / (RES1 - 1);
    let oldH = null, oldS = null;
    if (typeof data.heights === 'string') {
      const u8 = b64ToU8(data.heights);
      oldH = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
    }
    if (typeof data.splat === 'string') oldS = b64ToU8(data.splat);
    const sampleOld = (arr, fx, fz, stride, ch) => {
      const ix = Math.max(0, Math.min(RES1 - 2, Math.floor(fx))), iz = Math.max(0, Math.min(RES1 - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - ix)), tz = Math.max(0, Math.min(1, fz - iz));
      const v00 = arr[(iz * RES1 + ix) * stride + ch], v10 = arr[(iz * RES1 + ix + 1) * stride + ch];
      const v01 = arr[((iz + 1) * RES1 + ix) * stride + ch], v11 = arr[((iz + 1) * RES1 + ix + 1) * stride + ch];
      return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
    };
    const g0 = Math.round(-HALF1 / VSPACE), g1 = Math.round(HALF1 / VSPACE);
    const sTmp = [0, 0, 0, 0];
    for (let gz = g0; gz <= g1; gz++) {
      for (let gx = g0; gx <= g1; gx++) {
        const x = gx * VSPACE, z = gz * VSPACE;
        const fx = (x + HALF1) / step1, fz = (z + HALF1) / step1;
        const { c, k, cx, cz, lx, lz } = this._chunkForWrite(gx, gz);
        const i = lz * CHUNK_VERTS + lx;
        if (oldH) {
          c.heights[i] = sampleOld(oldH, fx, fz, 1, 0) * HEIGHT_QUANT;
          this._markDirty(k, cx, cz, lx, lz, 'heights');
        }
        if (oldS) {
          for (let m = 0; m < 4; m++) sTmp[m] = Math.round(sampleOld(oldS, fx, fz, 4, m));
          c.splat.set(sTmp, i * 4);
          this._markDirty(k, cx, cz, lx, lz, 'splat');
        }
      }
    }
    // Legacy water ({enabled, level}) is handled by setWaterData's fallback
    // in applyData, after the resampled chunks exist.
  }

  dispose() {
    for (const k of [...this.chunks.keys()]) this._disposeChunkMesh(k);
    this.material.dispose();
    for (const id of [...this._waterMeshes.keys()]) this._clearWaterMesh(id);
    this.waterMaterial.dispose();
  }
}
