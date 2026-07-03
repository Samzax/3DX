// terrain.js — heightmap terrain + material painting + water for the tactical map.
// Shared by the GM editor (pages/gm.js) and the player viewer (pages/player.js).
//
// Design (see the chat reasoning): a single 2.5D heightmap mesh over the central
// 100x100-cell tactical area at 128² vertices — one draw call. Material painting
// uses per-vertex weights baked into vertex colors (so we keep MeshLambert lighting
// and shadows with no custom shader). Water is a separate translucent plane at an
// adjustable level. Editing happens on the GM only; state syncs as compact base64
// blobs on stroke-end. Heights quantize to Int16; splat weights are Uint8 RGBA.

import * as THREE from 'three';

export const RES = 128;             // vertices per side
export const SIZE = 100;            // world units covered (= 100 cells at 1 unit/cell)
const HALF = SIZE / 2;
const STEP = SIZE / (RES - 1);      // world units between vertices
const HEIGHT_QUANT = 0.05;          // Int16 quantization step for sync

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

export class Terrain {
  constructor() {
    this.heights = new Float32Array(RES * RES);
    this.splat = new Uint8Array(RES * RES * 4);
    for (let i = 0; i < RES * RES; i++) this.splat[i * 4] = 255; // default: all grass
    this.water = { enabled: false, level: 0 };
    this._build();
  }

  _build() {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, RES - 1, RES - 1);
    geo.rotateX(-Math.PI / 2); // lay flat; +Y is up, vertex index = iz*RES + ix
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(RES * RES * 3), 3));
    this.geometry = geo;
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    // Brush cursor drawn in the terrain shader itself (edge ring + falloff fill),
    // so it conforms to slopes and cliffs exactly. Uniform objects are created
    // once and shared with the compiled program; setBrush mutates them.
    this._brushUniforms = {
      uBrushPos:     { value: new THREE.Vector2(0, 0) },
      uBrushRadius:  { value: 6 },
      uBrushColor:   { value: new THREE.Color(0xffdd55) },
      uBrushVisible: { value: 0 }
    };
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

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'terrain';

    // Water is built only over submerged cells (see _rebuildWater) so it pools in
    // depressions instead of flooding the whole map; geometry is filled on demand.
    const wmat = new THREE.MeshStandardMaterial({
      color: 0x2f6ea5, transparent: true, opacity: 0.62,
      metalness: 0.1, roughness: 0.3, depthWrite: false, side: THREE.DoubleSide
    });
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), wmat);
    this.waterMesh.visible = false;
    this.waterMesh.renderOrder = 1;
    this.waterMesh.name = 'water';

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.add(this.waterMesh);

    this._applyHeights();
    this._updateColors();
    this._rebuildWater();
  }

  // Build a water surface covering only the cells whose terrain dips below the
  // water level. Flat ground at/above the level gets no water (no z-fighting),
  // and isolated pits become isolated ponds.
  _rebuildWater() {
    const geo = this.waterMesh.geometry;
    if (!this.water.enabled) { this.waterMesh.visible = false; return; }
    const level = this.water.level, h = this.heights, pos = [];
    for (let iz = 0; iz < RES - 1; iz++) {
      for (let ix = 0; ix < RES - 1; ix++) {
        const a = h[iz * RES + ix], b = h[iz * RES + ix + 1], c = h[(iz + 1) * RES + ix], d = h[(iz + 1) * RES + ix + 1];
        if (Math.min(a, b, c, d) >= level) continue; // cell not submerged
        const x0 = -HALF + ix * STEP, x1 = x0 + STEP, z0 = -HALF + iz * STEP, z1 = z0 + STEP;
        pos.push(x0, level, z0, x1, level, z0, x1, level, z1,
                 x0, level, z0, x1, level, z1, x0, level, z1);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.waterMesh.visible = pos.length > 0;
  }
  // Recompute the water surface (call after terrain heights settle, e.g. stroke-end).
  refreshWater() { this._rebuildWater(); }

  // --- index / coordinate helpers ---
  inBounds(x, z) { return x >= -HALF && x <= HALF && z >= -HALF && z <= HALF; }

  // Bilinear height at world (x,z); 0 outside the terrain footprint.
  sampleHeight(x, z) {
    if (!this.inBounds(x, z)) return 0;
    const fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    const ix = Math.min(RES - 2, Math.floor(fx)), iz = Math.min(RES - 2, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz;
    const h = this.heights;
    const h00 = h[iz * RES + ix], h10 = h[iz * RES + ix + 1];
    const h01 = h[(iz + 1) * RES + ix], h11 = h[(iz + 1) * RES + ix + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  _applyHeights() {
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < RES * RES; i++) pos.setY(i, this.heights[i]);
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  _updateColors() {
    const col = this.geometry.attributes.color;
    const c = new THREE.Color();
    for (let i = 0; i < RES * RES; i++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let m = 0; m < 4; m++) { const w = this.splat[i * 4 + m]; sum += w; r += MAT_COLORS[m].r * w; g += MAT_COLORS[m].g * w; b += MAT_COLORS[m].b * w; }
      if (sum > 0) { c.setRGB(r / sum, g / sum, b / sum); } else { c.copy(MAT_COLORS[0]); }
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // Run cb(index, falloff) for every vertex within `radius` world units of (x,z).
  _forEachInRadius(x, z, radius, cb) {
    const cx = (x + HALF) / STEP, cz = (z + HALF) / STEP;
    const rg = radius / STEP;
    const x0 = Math.max(0, Math.floor(cx - rg)), x1 = Math.min(RES - 1, Math.ceil(cx + rg));
    const z0 = Math.max(0, Math.floor(cz - rg)), z1 = Math.min(RES - 1, Math.ceil(cz + rg));
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const d = Math.hypot(ix - cx, iz - cz);
        if (d > rg) continue;
        cb(iz * RES + ix, smooth(1 - d / rg));
      }
    }
  }

  // --- Brush cursor (drawn by the terrain shader; see _build) ---
  setBrush({ x, z, radius, color, visible }) {
    const u = this._brushUniforms;
    if (x != null && z != null) u.uBrushPos.value.set(x, z);
    if (radius != null) u.uBrushRadius.value = radius;
    if (color != null) u.uBrushColor.value.set(color);
    if (visible != null) u.uBrushVisible.value = visible ? 1 : 0;
  }

  // --- Sculpting. mode: raise|lower|smooth|flatten|noise|terrace. ref = flatten target. ---
  sculpt(x, z, radius, strength, mode, ref = 0) {
    if (mode === 'smooth') {
      const updates = [];
      this._forEachInRadius(x, z, radius, (i, f) => {
        const ix = i % RES, iz = (i / RES) | 0;
        let sum = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= RES || jz < 0 || jz >= RES) continue;
          sum += this.heights[jz * RES + jx]; n++;
        }
        updates.push([i, this.heights[i] + (sum / n - this.heights[i]) * f * Math.min(1, strength)]);
      });
      for (const [i, v] of updates) this.heights[i] = v;
    } else {
      this._forEachInRadius(x, z, radius, (i, f) => {
        if (mode === 'raise') this.heights[i] += strength * f;
        else if (mode === 'lower') this.heights[i] -= strength * f;
        else if (mode === 'flatten') this.heights[i] += (ref - this.heights[i]) * f * Math.min(1, strength);
        else if (mode === 'noise') this.heights[i] += (Math.random() - 0.5) * 2 * strength * f;
        else if (mode === 'terrace') {
          // Pull heights toward the nearest step; strength controls the step size.
          const step = Math.max(0.25, strength * 4);
          const target = Math.round(this.heights[i] / step) * step;
          this.heights[i] += (target - this.heights[i]) * f * 0.5;
        }
        const v = this.heights[i]; this.heights[i] = Math.max(-50, Math.min(50, v));
      });
    }
    this._applyHeights();
  }

  // --- Material painting toward channel matIndex (0..3). ---
  paint(x, z, radius, strength, matIndex) {
    this._forEachInRadius(x, z, radius, (i, f) => {
      const amt = Math.round(255 * strength * f);
      for (let m = 0; m < 4; m++) {
        const cur = this.splat[i * 4 + m];
        this.splat[i * 4 + m] = m === matIndex
          ? Math.min(255, cur + amt)
          : Math.max(0, cur - amt);
      }
    });
    this._updateColors();
  }

  // --- Ramp: blend heights linearly from (x0,z0,h0) to (x1,z1,h1) along the segment,
  // over a band `halfWidth` wide with smooth falloff at the edges. Roads, riverbeds,
  // cliff paths — the one shape brushes can't make.
  ramp(x0, z0, h0, x1, z1, h1, halfWidth, strength = 1) {
    const dx = x1 - x0, dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-6) return;
    const minX = Math.min(x0, x1) - halfWidth, maxX = Math.max(x0, x1) + halfWidth;
    const minZ = Math.min(z0, z1) - halfWidth, maxZ = Math.max(z0, z1) + halfWidth;
    const ix0 = Math.max(0, Math.floor((minX + HALF) / STEP)), ix1 = Math.min(RES - 1, Math.ceil((maxX + HALF) / STEP));
    const iz0 = Math.max(0, Math.floor((minZ + HALF) / STEP)), iz1 = Math.min(RES - 1, Math.ceil((maxZ + HALF) / STEP));
    const s = Math.min(1, strength);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -HALF + ix * STEP, z = -HALF + iz * STEP;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / lenSq));
        const px = x0 + t * dx, pz = z0 + t * dz;
        const dist = Math.hypot(x - px, z - pz);
        if (dist > halfWidth) continue;
        const target = h0 + (h1 - h0) * t;
        const i = iz * RES + ix;
        this.heights[i] += (target - this.heights[i]) * smooth(1 - dist / halfWidth) * s;
      }
    }
    this._applyHeights();
  }

  // --- Undo snapshots (heights + splat; water is a separate toggle, not a stroke) ---
  snapshot() {
    return { heights: this.heights.slice(), splat: this.splat.slice() };
  }
  restore(snap) {
    this.heights.set(snap.heights);
    this.splat.set(snap.splat);
    this._applyHeights();
    this._updateColors();
    this._rebuildWater();
  }

  // --- Water ---
  setWater({ enabled, level }) {
    if (enabled != null) this.water.enabled = enabled;
    if (level != null) this.water.level = level;
    this._rebuildWater();
  }

  reset() {
    this.heights.fill(0);
    this.splat.fill(0);
    for (let i = 0; i < RES * RES; i++) this.splat[i * 4] = 255;
    this.water = { enabled: false, level: 0 };
    this.setWater(this.water);
    this._applyHeights();
    this._updateColors();
  }

  // --- Serialization (compact, base64). Pass which fields you changed. ---
  encodeHeights() {
    const q = new Int16Array(RES * RES);
    for (let i = 0; i < RES * RES; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(this.heights[i] / HEIGHT_QUANT)));
    return u8ToB64(new Uint8Array(q.buffer));
  }
  encodeSplat() { return u8ToB64(this.splat); }

  // Full snapshot for map-state / persistence.
  toData() {
    return { res: RES, size: SIZE, water: { ...this.water }, heights: this.encodeHeights(), splat: this.encodeSplat() };
  }
  // Just-changed layers for a stroke-end sync.
  delta({ heights = false, splat = false, water = false }) {
    const d = {};
    if (heights) d.heights = this.encodeHeights();
    if (splat) d.splat = this.encodeSplat();
    if (water) d.water = { ...this.water };
    return d;
  }

  // Apply a full or partial blob (from the server). Returns true if anything changed.
  applyData(data) {
    if (!data) return false;
    let changedH = false, changedS = false;
    if (data.heights) {
      const u8 = b64ToU8(data.heights);
      const q = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
      const n = Math.min(q.length, RES * RES);
      for (let i = 0; i < n; i++) this.heights[i] = q[i] * HEIGHT_QUANT;
      changedH = true;
    }
    if (data.splat) {
      const u8 = b64ToU8(data.splat);
      this.splat.set(u8.subarray(0, RES * RES * 4));
      changedS = true;
    }
    if (changedH) this._applyHeights();
    if (changedS) this._updateColors();
    if (data.water) this.setWater(data.water);      // setWater rebuilds the water surface
    else if (changedH) this._rebuildWater();         // heights changed → ponds may shift
    return changedH || changedS || !!data.water;
  }

  dispose() {
    this.geometry.dispose(); this.material.dispose();
    this.waterMesh.geometry.dispose(); this.waterMesh.material.dispose();
  }
}
