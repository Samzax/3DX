// grass.js — instanced ground-cover grass scattered over the terrain near the
// camera. Shared by /gm and /player (step 2: the "living world" pass).
//
// Placement/streaming lives in scatter.js (ScatterField): the field is cut
// into cached world-anchored tiles built a few per frame under a millisecond
// budget, so roaming never regenerates the whole field in one hitched frame.
// This file owns what grass LOOKS like: blade geometry, wind, colors, fades.
//
// How it stays cheap and correct:
// - ONE InstancedMesh, one draw call; density makes turf, not blade size.
// - Blades grow only on the grass material (respects GM paint) and only above
//   the waterline, seated on the real terrain height (terrain.sampleHeight).
// - Placement is deterministic per world cell (a fract-sin hash): no sync, no
//   shimmer, and every client grows the same field.
// - The rim fade is a shader scale by distance-to-camera (applyScatterFade);
//   a camera-distance opacity fade dissolves the whole field on zoom-out
//   (sub-pixel blades only alias into speckle from a high camera).
//
// Scale is real: 1 world unit = 1 grid cell = 5 ft = 60 inches. A blade is
// BLADE_H 0.12u ~= 7", ~1" wide at the root — tiny next to a 5 ft square, so
// it only reads as turf when dense.

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';
import { ScatterField, applyScatterFade } from './scatter.js';

const CAP          = 135000; // instance capacity (worst case: all-grass tile cover)
const RADIUS       = 12;     // world-units of grass around the camera target (60 ft)
const TILE         = 6;      // scatter tile size (world units)
const STEP         = 0.18;   // tuft spacing (~11 inches)
const DENSITY      = 0.8;    // fraction of candidate cells that grow a tuft
const CLUMP        = 4;      // blades per tuft
const CLUMP_R      = 0.09;   // tuft spread radius (~5 inches)
const EDGE_FADE    = 0.7;    // rim fade starts at this fraction of RADIUS
// Camera-distance fade: past FADE_NEAR the whole field dissolves, gone by FADE_FAR.
const FADE_NEAR    = 22;
const FADE_FAR     = 38;
const BLADE_H      = 0.12;   // ~7 inches
const BLADE_W      = 0.018;  // ~1 inch base half-width

// Deterministic 0..1 hash of two world coords (GLSL fract-sin trick).
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
        // vertexColors multiplies the baked root->tip gradient with the
        // per-instance green tint. The emissive floor keeps back faces (whose
        // up-normals get flipped downward by DoubleSide) from going black.
        const mat = new THREE.MeshLambertMaterial({
            color: 0xffffff, emissive: 0x233f18,
            vertexColors: true, side: THREE.DoubleSide,
            transparent: true, opacity: 1   // opacity drives the camera-distance fade
        });
        this._timeU = { value: 0 };
        this._fadeU = {
            uCenter: { value: new THREE.Vector2() },
            uFadeStart: { value: RADIUS * EDGE_FADE },
            uFadeEnd: { value: RADIUS }
        };
        mat.onBeforeCompile = (shader) => {
            // Wind: sway the tip, phase-shifted per blade by its instance
            // translation so the field ripples instead of marching in step.
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
            applyScatterFade(shader, this._fadeU);   // rim fade (anchors project_vertex)
        };
        this.mesh = new THREE.InstancedMesh(makeBladeGeometry(), mat, CAP);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;     // instances live near the camera, not the mesh origin
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = false;
        this.mesh.visible = false;
        scene.add(this.mesh);

        const dummy = new THREE.Object3D();
        this.field = new ScatterField({
            terrain, meshes: [this.mesh],
            tileSize: TILE, radius: RADIUS, budgetMs: 3,
            buildTile: (x0, z0, x1, z1, emit) => {
                // Cell grid anchored to world multiples of STEP (independent of
                // tile boundaries), half-open per tile so no seam double-plants.
                const k0x = Math.ceil(x0 / STEP - 1e-9), k1x = Math.ceil(x1 / STEP - 1e-9);
                const k0z = Math.ceil(z0 / STEP - 1e-9), k1z = Math.ceil(z1 / STEP - 1e-9);
                for (let kx = k0x; kx < k1x; kx++) {
                    for (let kz = k0z; kz < k1z; kz++) {
                        const wx = kx * STEP, wz = kz * STEP;
                        if (hash2(wx * 1.3, wz * 1.7) > DENSITY) continue;   // thin out
                        if (terrain.dominantMaterial(wx, wz) !== 0) continue; // grass channel only
                        const px = wx + (hash2(wx + 11.3, wz) - 0.5) * STEP;
                        const pz = wz + (hash2(wx, wz + 7.7) - 0.5) * STEP;
                        const hy = terrain.sampleHeight(px, pz);
                        if (hy < SEA_LEVEL + 0.3) continue;                  // no underwater/beach grass
                        // A tight clump of blades per cell: single tiny blades
                        // read as specks, a tuft reads as grass.
                        for (let k = 0; k < CLUMP; k++) {
                            const ang = hash2(px + k * 1.7, pz + k * 2.3) * Math.PI * 2;
                            const rad = hash2(px + k * 3.1, pz - k) * CLUMP_R;
                            const bx = px + Math.cos(ang) * rad;
                            const bz = pz + Math.sin(ang) * rad;
                            dummy.position.set(bx, hy, bz);   // TRUE world coords (pack shifts by origin)
                            // Random yaw spins the bend direction; a small random
                            // lean breaks the "planted flagpoles" look.
                            dummy.rotation.set(
                                (hash2(bx + 7.7, bz + 1.2) - 0.5) * 0.5,
                                hash2(bx + 3.1, bz + 9.2) * Math.PI * 2,
                                (hash2(bx + 4.4, bz + 6.6) - 0.5) * 0.5);
                            const s = 0.6 + hash2(bx + 5, bz + 5) * 0.7;
                            dummy.scale.set(s, s, s);
                            dummy.updateMatrix();
                            // Per-blade green with a little hue jitter, kept a touch
                            // BRIGHTER than the ground: darker blades read as dirt
                            // speckle from above, brighter ones as lush growth.
                            const v = hash2(bx + 2, bz + 9);
                            emit(0, dummy.matrix, 0.34 + v * 0.10, 0.56 + v * 0.09, 0.24 + v * 0.05);
                        }
                    }
                }
            }
        });
        this.terrain = terrain;
    }

    // Call each frame. `unified` gates grass to the continuous outdoor world
    // (pockets/dungeons stay bare). camera+controls give zoom + ground point.
    update(camera, controls, unified) {
        this._timeU.value = performance.now() / 1000;
        const dist = camera.position.distanceTo(controls.target);
        if (!unified || dist > FADE_FAR) {
            this.mesh.visible = false;       // cache survives; returning is instant
            return;
        }
        this.mesh.visible = true;
        // Dissolve with zoom instead of popping.
        this.mesh.material.opacity = Math.min(1, Math.max(0, (FADE_FAR - dist) / (FADE_FAR - FADE_NEAR)));
        this._fadeU.uCenter.value.set(controls.target.x, controls.target.z); // scene coords
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        this.field.update(controls.target.x + ox, controls.target.z + oz, ox, oz);
    }
}
