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
    this.water = { enabled: false, level: 0 };

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

    const wmat = new THREE.MeshStandardMaterial({
      color: 0x2f6ea5, transparent: true, opacity: 0.62,
      metalness: 0.1, roughness: 0.3, depthWrite: false, side: THREE.DoubleSide
    });
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), wmat);
    this.waterMesh.visible = false;
    this.waterMesh.renderOrder = 1;
    this.waterMesh.name = 'water';

    this.group = new THREE.Group();
    this.group.add(this.chunkGroup);
    this.group.add(this.waterMesh);
  }

  // ===== global lattice access (vertex coords gx,gz; world = g * VSPACE) =====

  _chunkOf(gx, gz) {
    const cx = Math.floor(gx / CHUNK_VERTS), cz = Math.floor(gz / CHUNK_VERTS);
    return { cx, cz, lx: gx - cx * CHUNK_VERTS, lz: gz - cz * CHUNK_VERTS };
  }

  getH(gx, gz) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const c = this.chunks.get(ckey(cx, cz));
    return c ? c.heights[lz * CHUNK_VERTS + lx] : 0;
  }

  _getSplat(gx, gz, out) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const c = this.chunks.get(ckey(cx, cz));
    if (!c) { out[0] = 255; out[1] = 0; out[2] = 0; out[3] = 0; return out; }
    const i = (lz * CHUNK_VERTS + lx) * 4;
    out[0] = c.splat[i]; out[1] = c.splat[i + 1]; out[2] = c.splat[i + 2]; out[3] = c.splat[i + 3];
    return out;
  }

  // Fetch-or-create the chunk owning (gx,gz), with copy-on-write for undo.
  _chunkForWrite(gx, gz) {
    const { cx, cz, lx, lz } = this._chunkOf(gx, gz);
    const k = ckey(cx, cz);
    let c = this.chunks.get(k);
    if (this._strokePatch && !this._strokePatch.has(k)) {
      this._strokePatch.set(k, c ? { heights: c.heights.slice(), splat: c.splat.slice() } : null);
    }
    if (!c) { c = newChunk(); this.chunks.set(k, c); }
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
    this._rebuildDirtyMeshes();
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
    this._rebuildDirtyMeshes();
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
    this._rebuildWater();
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
        pos.setXYZ(i, gx * VSPACE, h, gz * VSPACE);
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

  _rebuildDirtyMeshes() {
    for (const k of this._dirtyMesh) {
      if (this.chunks.has(k)) this._buildChunkMesh(k);
    }
    this._dirtyMesh.clear();
  }

  // Streaming window: keep meshes only for chunks near the camera target.
  // Data always stays in memory (it's small); only GPU meshes come and go.
  updateWindow(center) {
    const cx = Math.floor(center.x / CHUNK_SIZE), cz = Math.floor(center.z / CHUNK_SIZE);
    if (this._windowCenter && this._windowCenter.cx === cx && this._windowCenter.cz === cz) return;
    this._windowCenter = { cx, cz };
    const r = this.windowRadius;
    for (const [k, c] of this.chunks) {
      const [kx, kz] = k.split(',').map(Number);
      const dist = Math.max(Math.abs(kx - cx), Math.abs(kz - cz));
      if (dist <= r && !c.mesh) this._buildChunkMesh(k);
      else if (dist > r + 1 && c.mesh) this._disposeChunkMesh(k); // +1 hysteresis
    }
  }

  // ===== water (interim: global level per map; replaced by water v2) =====

  _rebuildWater() {
    const geo = this.waterMesh.geometry;
    if (!this.water.enabled) { this.waterMesh.visible = false; return; }
    const level = this.water.level, pos = [];
    // Cover each existing chunk's cells whose corners dip below the level.
    for (const k of this.chunks.keys()) {
      const [cx, cz] = k.split(',').map(Number);
      const gox = cx * CHUNK_VERTS, goz = cz * CHUNK_VERTS;
      for (let lz = 0; lz < CHUNK_VERTS; lz += 2) {       // 1 cell = 2 lattice steps
        for (let lx = 0; lx < CHUNK_VERTS; lx += 2) {
          const gx = gox + lx, gz = goz + lz;
          const a = this.getH(gx, gz), b = this.getH(gx + 2, gz);
          const c2 = this.getH(gx, gz + 2), d = this.getH(gx + 2, gz + 2);
          if (Math.min(a, b, c2, d) >= level) continue;
          const x0 = gx * VSPACE, x1 = x0 + 1, z0 = gz * VSPACE, z1 = z0 + 1;
          pos.push(x0, level, z0, x1, level, z0, x1, level, z1,
                   x0, level, z0, x1, level, z1, x0, level, z1);
        }
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.waterMesh.visible = pos.length > 0;
  }
  refreshWater() { this._rebuildWater(); }

  setWater({ enabled, level }) {
    if (enabled != null) this.water.enabled = enabled;
    if (level != null) this.water.level = level;
    this._rebuildWater();
  }

  // Clear everything (map switch or GM reset). Local only; the caller syncs.
  reset() {
    if (this._strokePatch) {
      for (const [k, c] of this.chunks) {
        if (!this._strokePatch.has(k)) this._strokePatch.set(k, { heights: c.heights.slice(), splat: c.splat.slice() });
      }
    }
    for (const k of [...this.chunks.keys()]) this._disposeChunkMesh(k);
    this.chunks.clear();
    this._dirtyData.clear();
    this._dirtyMesh.clear();
    this._windowCenter = null;
    this.water = { enabled: false, level: 0 };
    this._rebuildWater();
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

  // Encode specific chunks (after undo/redo); missing chunks encode as null (delete).
  payloadForKeys(keys) {
    const chunks = {};
    for (const k of keys) {
      const c = this.chunks.get(k);
      chunks[k] = c ? this._encodeChunk(c, { heights: true, splat: true }) : null;
    }
    return { chunks };
  }

  // All chunks, split into batches that stay well under the socket buffer.
  fullPayloadBatches(batchSize = 8) {
    const keys = [...this.chunks.keys()];
    const batches = [];
    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(this.payloadForKeys(keys.slice(i, i + batchSize)));
    }
    if (batches.length > 0) batches[0].water = { ...this.water };
    return batches;
  }

  // Apply a v2 payload or a legacy v1 blob. Returns { changed, migrated }.
  applyData(data) {
    if (!data) return { changed: false, migrated: false };
    let changed = false, migrated = false;
    if (data.format === 2 || data.chunks) {
      for (const k of Object.keys(data.chunks || {})) {
        if (!/^-?\d+,-?\d+$/.test(k)) continue;
        const v = data.chunks[k];
        if (v === null) {
          this._disposeChunkMesh(k);
          this.chunks.delete(k);
        } else {
          let c = this.chunks.get(k);
          if (!c) { c = newChunk(); this.chunks.set(k, c); }
          this._decodeInto(c, v);
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
    if (data.water) this.setWater(data.water);
    else if (changed) this._rebuildWater();
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
    if (data.water) this.water = { enabled: !!data.water.enabled, level: Number(data.water.level) || 0 };
  }

  dispose() {
    for (const k of [...this.chunks.keys()]) this._disposeChunkMesh(k);
    this.material.dispose();
    this.waterMesh.geometry.dispose();
    this.waterMesh.material.dispose();
  }
}
