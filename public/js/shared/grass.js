// grass.js — instanced ground-cover grass scattered over the terrain near the
// camera. Shared by /gm and /player (step 2: the "living world" pass).
//
// How it stays cheap and correct:
// - ONE InstancedMesh, one draw call. Tens of thousands of blades is trivial
//   for the GPU; the look comes from density + per-blade variation, not size.
// - Blades are placed only on the grass material (respects GM paint) and only
//   above the waterline, seated on the real terrain height (terrain.sampleHeight).
// - Placement is deterministic per world cell (a fract-sin hash), so a static
//   camera shows a stable field with no shimmer; the field only rebuilds when
//   the camera's ground point moves past a threshold.
// - Floating origin: sampling is in TRUE world coords, instance matrices are in
//   SCENE coords (world - terrain.worldOrigin), matching how chunk meshes render.
// - Grass is tactical-scale detail, so it hides entirely once you zoom out past
//   a lens altitude (also keeps the per-rebuild cost off the hex tiers).
//
// Scale is real: 1 world unit = 1 grid cell = 5 ft = 60 inches. A blade is
// BLADE_H 0.12u ~= 7", a couple inches of sway at the tip, ~1" wide at the
// root — tiny next to a 5 ft square, so it only reads as turf when dense.

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';

const MAX_BLADES   = 60000;  // instance capacity (one draw call either way)
const RADIUS       = 12;     // world-units of grass around the camera target (60 ft)
const STEP         = 0.18;   // tuft spacing (~11 inches)
const DENSITY      = 0.8;    // fraction of candidate cells that grow a tuft
const CLUMP        = 4;      // blades per tuft
const CLUMP_R      = 0.09;   // tuft spread radius (~5 inches)
const REBUILD_MOVE = 2.0;    // rebuild once the ground point moves this far
// Camera-distance fade: past FADE_NEAR the whole field dissolves, gone by
// FADE_FAR. Sub-pixel blades from a high camera just alias into dark speckle,
// so grass belongs only to genuinely close tactical views.
const FADE_NEAR    = 22;
const FADE_FAR     = 38;
const BLADE_H      = 0.12;   // ~7 inches
const BLADE_W      = 0.018;  // ~1 inch base half-width
const EDGE_FADE    = 0.7;    // blades start shrinking at this fraction of RADIUS

// Deterministic 0..1 hash of two world coords (GLSL fract(sin) trick).
function hash2(x, z) {
    const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return h - Math.floor(h);
}

// One tapered blade: a 2-segment plane that narrows to a point and bends
// slightly forward (random per-instance yaw distributes the bend direction).
// A baked root->tip vertex-color gradient (dark base, bright tip) is what makes
// a field of these read as grass instead of green confetti. Normals are forced
// straight up so blades take the hemisphere sky light evenly.
function makeBladeGeometry() {
    const H = BLADE_H, w = BLADE_W;
    const midH = H * 0.55, midW = w * 0.62, bend1 = H * 0.12, bend2 = H * 0.38;
    const position = new Float32Array([
        -w, 0, 0,               w, 0, 0,               // root
        -midW, midH, bend1,     midW, midH, bend1,     // mid
        0, H, bend2                                    // tip
    ]);
    const index = [0, 1, 2, 1, 3, 2, 2, 3, 4];
    // Grayscale multipliers: shadowed root -> sunlit tip. Kept gentle: from a
    // high gameplay camera you mostly see roots/mids, and a dark root makes the
    // field read as dirt speckle on the lighter ground instead of turf.
    const shades = [0.72, 0.72, 1.0, 1.0, 1.3];
    const color = new Float32Array(shades.flatMap(s => [s, s, s]));
    const normal = new Float32Array(position.length);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1; // all (0,1,0)
    const g = new THREE.BufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    return g;
}

export class Grass {
    constructor(terrain, scene) {
        this.terrain = terrain;
        // vertexColors multiplies the baked root->tip gradient with the
        // per-instance green tint. The emissive floor keeps back faces (whose
        // up-normals get flipped downward by DoubleSide) from going black.
        const mat = new THREE.MeshLambertMaterial({
            color: 0xffffff, emissive: 0x233f18,
            vertexColors: true, side: THREE.DoubleSide,
            transparent: true, opacity: 1   // opacity drives the camera-distance fade
        });
        // Wind: sway the tip in the vertex shader, phase-shifted per blade by its
        // instance translation so the field ripples instead of marching in step.
        this._timeU = { value: 0 };
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this._timeU;
            shader.vertexShader = ('uniform float uTime;\n' + shader.vertexShader).replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                #ifdef USE_INSTANCING
                  float gPhase = instanceMatrix[3][0] * 0.9 + instanceMatrix[3][2] * 1.3;
                  float gBend = transformed.y * transformed.y * ${(1 / (BLADE_H * BLADE_H)).toFixed(3)};
                  transformed.x += sin(uTime * 1.8 + gPhase) * gBend * 0.028;
                  transformed.z += cos(uTime * 1.3 + gPhase * 1.7) * gBend * 0.02;
                #endif`
            );
        };
        this.mesh = new THREE.InstancedMesh(makeBladeGeometry(), mat, MAX_BLADES);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;     // instances live near the camera, not the mesh origin
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = false;
        this.mesh.visible = false;
        scene.add(this.mesh);
        this._dummy = new THREE.Object3D();
        this._col = new THREE.Color();
        this._last = null;                   // last ground point we scattered around
    }

    // Call each frame. `unified` gates grass to the continuous outdoor world
    // (pockets/dungeons stay bare). camera+controls give zoom + ground point.
    update(camera, controls, unified) {
        this._timeU.value = performance.now() / 1000;
        const dist = camera.position.distanceTo(controls.target);
        if (!unified || dist > FADE_FAR) {
            this.mesh.visible = false;
            this._last = null;               // force a rebuild when we return
            return;
        }
        this.mesh.visible = true;
        // Dissolve with zoom instead of popping.
        this.mesh.material.opacity = Math.min(1, Math.max(0, (FADE_FAR - dist) / (FADE_FAR - FADE_NEAR)));
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        const cwx = controls.target.x + ox, cwz = controls.target.z + oz;
        if (this._last && Math.hypot(cwx - this._last.x, cwz - this._last.z) < REBUILD_MOVE) return;
        this._last = { x: cwx, z: cwz };
        this._scatter(cwx, cwz, ox, oz);
    }

    _scatter(cwx, cwz, ox, oz) {
        const t = this.terrain, d = this._dummy, col = this._col;
        const r2 = RADIUS * RADIUS, fadeR = RADIUS * EDGE_FADE;
        // Snap the scan grid to world-space multiples of STEP so each cell's hash
        // is stable as the camera roams (no crawling/shimmer).
        const x0 = Math.floor((cwx - RADIUS) / STEP) * STEP;
        const z0 = Math.floor((cwz - RADIUS) / STEP) * STEP;
        let n = 0;
        for (let wx = x0; wx <= cwx + RADIUS && n < MAX_BLADES; wx += STEP) {
            for (let wz = z0; wz <= cwz + RADIUS && n < MAX_BLADES; wz += STEP) {
                const dx = wx - cwx, dz = wz - cwz;
                const dd = dx * dx + dz * dz;
                if (dd > r2) continue;
                if (hash2(wx * 1.3, wz * 1.7) > DENSITY) continue;   // thin out
                if (t.dominantMaterial(wx, wz) !== 0) continue;      // grass channel only
                const px = wx + (hash2(wx + 11.3, wz) - 0.5) * STEP;
                const pz = wz + (hash2(wx, wz + 7.7) - 0.5) * STEP;
                const hy = t.sampleHeight(px, pz);
                if (hy < SEA_LEVEL + 0.3) continue;                  // no underwater/beach grass
                // Blades near the rim shrink away so the field has no hard circle edge.
                const edge = 1 - Math.max(0, (Math.sqrt(dd) - fadeR) / (RADIUS - fadeR));
                // A tight clump of blades per cell: single tiny blades read as
                // specks, a tuft reads as grass.
                for (let k = 0; k < CLUMP && n < MAX_BLADES; k++) {
                    const ang = hash2(px + k * 1.7, pz + k * 2.3) * Math.PI * 2;
                    const rad = hash2(px + k * 3.1, pz - k) * CLUMP_R;
                    const bx = px + Math.cos(ang) * rad;
                    const bz = pz + Math.sin(ang) * rad;
                    d.position.set(bx - ox, hy, bz - oz);
                    // Random yaw spins the bend direction; a small random lean
                    // breaks the "planted flagpoles" look.
                    d.rotation.set(
                        (hash2(bx + 7.7, bz + 1.2) - 0.5) * 0.5,
                        hash2(bx + 3.1, bz + 9.2) * Math.PI * 2,
                        (hash2(bx + 4.4, bz + 6.6) - 0.5) * 0.5);
                    const s = (0.6 + hash2(bx + 5, bz + 5) * 0.7) * edge;
                    d.scale.set(s, s, s);
                    d.updateMatrix();
                    this.mesh.setMatrixAt(n, d.matrix);
                    // Per-blade green with a little hue jitter (occasional warm
                    // blade). Kept a touch BRIGHTER than the ground color: blades
                    // darker than the ground read as dirt speckle from above,
                    // brighter ones read as lush growth.
                    const v = hash2(bx + 2, bz + 9);
                    col.setRGB(0.34 + v * 0.10, 0.56 + v * 0.09, 0.24 + v * 0.05);
                    this.mesh.setColorAt(n, col);
                    n++;
                }
            }
        }
        this.mesh.count = n;
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
}
