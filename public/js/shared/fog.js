// fog.js — U4 fog of war over the unified world (docs/unified-world-design.md).
// The GM reveals regions; players only ever RECEIVE content (objects + edited
// terrain chunks) inside revealed regions — the server withholds the rest, this
// module is the client half: the mask bookkeeping and the visual fog sheet.
//
// Reveal granularity is a GLOBAL hex lattice at province pitch (1 mile,
// TIER_WIDTH[2] = 1056 u flat-to-flat) centered on the world origin. It is
// deliberately NOT the nested navigation lattice (whose province grid recenters
// on each kingdom hex, so the same ground gets different hex ids under
// different parents) — fog is a property of the ground itself, so its lattice
// must be world-global. The math here MUST stay bit-identical to server.js
// (fogHexKeyAt): the server is the authority on what each player receives.

import * as THREE from 'three';
import { tierRadius, hexCenterAtTier, worldToHexAtTier } from './hexworld.js';

export const FOG_TIER = 2;       // province pitch — 1 fog cell = 1 mile hex
// The fog sheet floats above the terrain like a cloud deck: high enough to
// cover normal relief, low enough that province-lens views read it as ground.
export const FOG_ALTITUDE = 80;

// Containing fog hex of a WORLD point (global lattice, origin-centered).
export function fogHexAt(x, z) { return worldToHexAtTier(FOG_TIER, x, z); }
export function fogHexKeyAt(x, z) { const h = fogHexAt(x, z); return h.q + ',' + h.r; }

// Fog hex containing a terrain chunk (by its center) — chunk keys are
// "cx,cz" in CHUNK_CELLS-unit steps. Boundary chunks classify by center on
// both client and server, so the two always agree on what was sent.
export function chunkFogHexKey(chunkKey, chunkCells = 32) {
    const [cx, cz] = chunkKey.split(',').map(Number);
    return fogHexKeyAt((cx + 0.5) * chunkCells, (cz + 0.5) * chunkCells);
}

// All fog-hex keys within `radius` hex steps of (q,r) — the GM brush footprint.
export function hexesWithin(q, r, radius) {
    const out = [];
    for (let dq = -radius; dq <= radius; dq++) {
        for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
            out.push((q + dq) + ',' + (r + dr));
        }
    }
    return out;
}

// The revealed set, mirrored from the server (map-state `fog` + `fog-updated`).
// `rev` bumps on every change so renderers can memo against it.
export class FogMask {
    constructor() {
        this.revealed = new Set();
        this.rev = 0;
    }
    setList(keys) {
        this.revealed = new Set(keys || []);
        this.rev++;
    }
    set(hexKey, on) {
        if (this.revealed.has(hexKey) === !!on) return;
        if (on) this.revealed.add(hexKey);
        else this.revealed.delete(hexKey);
        this.rev++;
    }
    has(hexKey) { return this.revealed.has(hexKey); }
    isRevealed(x, z) { return this.revealed.has(fogHexKeyAt(x, z)); }
}

// The visual: one big dark sheet over the world with holes punched out of it
// for every revealed hex in range. Hidden ground is the infinite default, so
// drawing the INVERSE (per-hidden-hex tiles) can't work at survey altitudes —
// a single plane with a few hundred holes stays cheap at every zoom.
// Geometry is built LOCAL to a quantized center (float32 stays precise) and
// only rebuilt when the mask, the center bucket, or the zoom bucket changes.
export class FogOverlay {
    constructor(parent, { color = 0x11141b, opacity = 0.93, altitude = FOG_ALTITUDE } = {}) {
        this.altitude = altitude;
        // Unexplored country lies under a slow-drifting cloud bank rather than
        // a flat dark sheet: world-anchored noise in two scales (so it reads
        // from token height and from survey altitude alike) shades the base
        // color from deep shadow to pale mist. Opacity only wavers a little —
        // the sheet must keep hiding what the server withholds.
        this.material = new THREE.ShaderMaterial({
            transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: true,
            uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
                uColor: { value: new THREE.Color(color) },
                uOpacity: { value: opacity },
                uCenter: { value: new THREE.Vector2() },
                uTime: { value: 0 }
            }]),
            vertexShader: [
                '#include <common>',
                '#include <fog_pars_vertex>',
                'uniform vec2 uCenter;',
                'varying vec2 vFogWorld;',
                'void main() {',
                '  vFogWorld = position.xz + uCenter;',
                '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
                '  gl_Position = projectionMatrix * mvPosition;',
                '  #include <fog_vertex>',
                '}'
            ].join('\n'),
            fragmentShader: [
                '#include <common>',
                '#include <fog_pars_fragment>',
                'uniform vec3 uColor;',
                'uniform float uOpacity;',
                'uniform float uTime;',
                'varying vec2 vFogWorld;',
                'float fHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
                'float fNoise(vec2 p) {',
                '  vec2 i = floor(p), f = fract(p);',
                '  f = f * f * (3.0 - 2.0 * f);',
                '  return mix(mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x), mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x), f.y);',
                '}',
                'float fBillow(vec2 p) { return fNoise(p) * 0.55 + fNoise(p * 2.1 + 7.3) * 0.3 + fNoise(p * 4.3 + 1.9) * 0.15; }',
                'void main() {',
                '  float px = max(fwidth(vFogWorld.x), fwidth(vFogWorld.y));',
                '  vec2 drift = vec2(uTime * 2.2, uTime * 1.3);',
                '  float near = fBillow((vFogWorld + drift) / 140.0) * (1.0 - smoothstep(25.0, 110.0, px));',
                '  float mid = fBillow((vFogWorld + drift * 6.0) / 2600.0) * (1.0 - smoothstep(500.0, 2200.0, px));',
                '  float far = fBillow(vFogWorld / 52000.0);',
                '  float c = clamp(near * 0.55 + mid * 0.6 + far * 0.55 - 0.25, 0.0, 1.0);',
                '  vec3 col = mix(uColor * 0.7, uColor * 2.3 + vec3(0.07, 0.08, 0.10), c * c);',
                '  gl_FragColor = vec4(col, uOpacity * (0.95 + 0.05 * c));',
                '  #include <fog_fragment>',
                '}'
            ].join('\n')
        });
        this.material.extensions = { derivatives: true };
        this.group = new THREE.Group();
        this.mesh = null;
        this._key = '';
        parent.add(this.group);
    }
    setVisible(v) {
        this.group.visible = !!v;
        if (!v) this._key = ''; // force a fresh build on re-show
    }
    setAltitude(alt) {
        if (this.altitude === alt) return;
        this.altitude = alt;
        if (this.mesh) this.mesh.position.y = alt;
    }
    // centerX/centerZ: world coords of the view target; dist: camera distance
    // (drives how far the sheet must extend before scene fog swallows it).
    update(mask, centerX, centerZ, dist) {
        if (!this.group.visible) return;
        this.material.uniforms.uTime.value = performance.now() / 1000;
        const extent = Math.min(3e6, Math.max(4096, dist * 8));
        let S = 4096;
        while (S < extent) S *= 2;
        const step = S / 8;
        const cx = Math.round(centerX / step) * step;
        const cz = Math.round(centerZ / step) * step;
        const key = mask.rev + '|' + cx + ',' + cz + '|' + S;
        if (key === this._key) return;
        this._key = key;
        this._rebuild(mask, cx, cz, S);
    }
    _rebuild(mask, cx, cz, S) {
        if (this.mesh) {
            this.group.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh = null;
        }
        const shape = new THREE.Shape();
        shape.moveTo(-S, -S); shape.lineTo(S, -S);
        shape.lineTo(S, S); shape.lineTo(-S, S);
        shape.closePath();
        const R = tierRadius(FOG_TIER);
        const margin = S - R * 1.5; // holes must stay strictly inside the sheet
        for (const hk of mask.revealed) {
            const [q, r] = hk.split(',').map(Number);
            const c = hexCenterAtTier(FOG_TIER, q, r);
            const hx = c.x - cx, hz = c.z - cz;
            if (Math.abs(hx) > margin || Math.abs(hz) > margin) continue;
            const hole = new THREE.Path();
            for (let i = 0; i < 6; i++) {
                const ang = Math.PI / 180 * (60 * i - 30); // pointy-top corners
                const px = hx + R * Math.cos(ang), pz = hz + R * Math.sin(ang);
                if (i === 0) hole.moveTo(px, pz); else hole.lineTo(px, pz);
            }
            hole.closePath();
            shape.holes.push(hole);
        }
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(Math.PI / 2); // shape XY -> ground XZ
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.renderOrder = 8; // over terrain/water, under hex overlay lines
        this.mesh.position.set(cx, this.altitude, cz);
        this.material.uniforms.uCenter.value.set(cx, cz);   // geometry is local to (cx, cz)
        this.group.add(this.mesh);
    }
    dispose() {
        if (this.mesh) {
            this.group.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh = null;
        }
        this.material.dispose();
    }
}
