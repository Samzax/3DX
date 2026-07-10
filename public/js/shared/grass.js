// grass.js — instanced ground-cover grass scattered over the terrain near the
// camera. Shared by /gm and /player (step 2: the "living world" pass).
//
// Placement/streaming lives in scatter.js (ScatterField): the field is cut
// into cached world-anchored tiles built a few per frame under a millisecond
// budget, so roaming never regenerates the whole field in one hitched frame.
// This file owns what grass LOOKS like: blade geometry, wind, colors, fades.
//
// TWO LAYERS, one look: full-density blades out to ~176u (the fine-chunk
// window) would be ~13M instances, so the field is split like game grass LODs:
// - NEAR: dense turf underfoot (the close-up carpet).
// - FAR: a sparser blanket of slightly larger blades reaching most of the
//   fine-terrain window, so the vegetated ground visually covers the detailed
//   tiles instead of ending in a small disc around the camera.
// Each layer has its own rim fade and camera-distance opacity fade; zooming
// out dissolves the dense layer first, then the far blanket.
//
// How it stays cheap and correct:
// - One InstancedMesh per layer (two draw calls total).
// - Blades grow only on the grass material (respects GM paint) and only above
//   the waterline, seated on the real terrain height (terrain.sampleHeight).
// - Placement is deterministic per world cell (a fract-sin hash): no sync, no
//   shimmer, and every client grows the same field.
//
// Scale is real: 1 world unit = 1 grid cell = 5 ft = 60 inches. A blade is
// BLADE_H 0.12u ~= 7", ~1" wide at the root — tiny next to a 5 ft square, so
// it only reads as turf when dense.

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';
import { ScatterField, applyScatterFade } from './scatter.js';

// Layer dials. CAP is the worst case (every cell grass material) of the tile
// cover area x blades per cell; blades/u^2 = DENSITY*CLUMP/STEP^2.
const NEAR = {
    RADIUS: 12, TILE: 6, STEP: 0.17, DENSITY: 0.85, CLUMP: 5, CLUMP_R: 0.09,
    CAP: 195000, EDGE: 0.7, SCALE: 1,
    FADE_NEAR: 22, FADE_FAR: 38          // camera-distance opacity fade
};
const FAR = {
    RADIUS: 55, TILE: 16, STEP: 0.55, DENSITY: 0.6, CLUMP: 2, CLUMP_R: 0.12,
    CAP: 85000, EDGE: 0.75, SCALE: 1.35,
    FADE_NEAR: 28, FADE_FAR: 50
};
const BLADE_H = 0.12;   // ~7 inches
const BLADE_W = 0.018;  // ~1 inch base half-width

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
        this.terrain = terrain;
        this._timeU = { value: 0 };
        this._geometry = makeBladeGeometry();
        this._layers = [
            this._makeLayer(NEAR, terrain, scene),
            this._makeLayer(FAR, terrain, scene)
        ];
        // Kept for pages/tests that peek at .mesh (the dense layer is "the" grass).
        this.mesh = this._layers[0].mesh;
    }

    _makeLayer(cfg, terrain, scene) {
        // vertexColors multiplies the baked root->tip gradient with the
        // per-instance green tint. The emissive floor keeps back faces (whose
        // up-normals get flipped downward by DoubleSide) from going black.
        const mat = new THREE.MeshLambertMaterial({
            color: 0xffffff, emissive: 0x233f18,
            vertexColors: true, side: THREE.DoubleSide,
            transparent: true, opacity: 1   // opacity drives the camera-distance fade
        });
        const fadeU = {
            uCenter: { value: new THREE.Vector2() },
            uFadeStart: { value: cfg.RADIUS * cfg.EDGE },
            uFadeEnd: { value: cfg.RADIUS }
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
            applyScatterFade(shader, fadeU);   // rim fade (anchors project_vertex)
        };
        const mesh = new THREE.InstancedMesh(this._geometry, mat, cfg.CAP);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;     // instances live near the camera, not the mesh origin
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.visible = false;
        scene.add(mesh);

        const dummy = new THREE.Object3D();
        const field = new ScatterField({
            terrain, meshes: [mesh],
            tileSize: cfg.TILE, radius: cfg.RADIUS, budgetMs: 3,
            buildTile: (x0, z0, x1, z1, emit) => {
                // Cell grid anchored to world multiples of STEP (independent of
                // tile boundaries), half-open per tile so no seam double-plants.
                const S = cfg.STEP;
                const k0x = Math.ceil(x0 / S - 1e-9), k1x = Math.ceil(x1 / S - 1e-9);
                const k0z = Math.ceil(z0 / S - 1e-9), k1z = Math.ceil(z1 / S - 1e-9);
                for (let kx = k0x; kx < k1x; kx++) {
                    for (let kz = k0z; kz < k1z; kz++) {
                        const wx = kx * S, wz = kz * S;
                        if (hash2(wx * 1.3, wz * 1.7) > cfg.DENSITY) continue;  // thin out
                        if (terrain.dominantMaterial(wx, wz) !== 0) continue;   // grass channel only
                        const px = wx + (hash2(wx + 11.3, wz) - 0.5) * S;
                        const pz = wz + (hash2(wx, wz + 7.7) - 0.5) * S;
                        const hy = terrain.sampleHeight(px, pz);
                        if (hy < SEA_LEVEL + 0.3) continue;                     // no underwater/beach grass
                        // A tight clump of blades per cell: single tiny blades
                        // read as specks, a tuft reads as grass.
                        for (let k = 0; k < cfg.CLUMP; k++) {
                            const ang = hash2(px + k * 1.7, pz + k * 2.3) * Math.PI * 2;
                            const rad = hash2(px + k * 3.1, pz - k) * cfg.CLUMP_R;
                            const bx = px + Math.cos(ang) * rad;
                            const bz = pz + Math.sin(ang) * rad;
                            dummy.position.set(bx, hy, bz);   // TRUE world coords (pack shifts by origin)
                            // Random yaw spins the bend direction; a small random
                            // lean breaks the "planted flagpoles" look.
                            dummy.rotation.set(
                                (hash2(bx + 7.7, bz + 1.2) - 0.5) * 0.5,
                                hash2(bx + 3.1, bz + 9.2) * Math.PI * 2,
                                (hash2(bx + 4.4, bz + 6.6) - 0.5) * 0.5);
                            const s = (0.6 + hash2(bx + 5, bz + 5) * 0.7) * cfg.SCALE;
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
        return { cfg, mat, mesh, field, fadeU };
    }

    // Call each frame. `unified` gates grass to the continuous outdoor world
    // (pockets/dungeons stay bare). camera+controls give zoom + ground point.
    update(camera, controls, unified) {
        this._timeU.value = performance.now() / 1000;
        const dist = camera.position.distanceTo(controls.target);
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        const cwx = controls.target.x + ox, cwz = controls.target.z + oz;
        for (const L of this._layers) {
            if (!unified || dist > L.cfg.FADE_FAR) {
                L.mesh.visible = false;      // cache survives; returning is instant
                continue;
            }
            L.mesh.visible = true;
            // Dissolve with zoom instead of popping.
            L.mat.opacity = Math.min(1, Math.max(0, (L.cfg.FADE_FAR - dist) / (L.cfg.FADE_FAR - L.cfg.FADE_NEAR)));
            L.fadeU.uCenter.value.set(controls.target.x, controls.target.z);   // scene coords
            L.field.update(cwx, cwz, ox, oz);
        }
    }
}
