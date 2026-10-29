// groundcover.js — small biome-specific ground detail between the grass and
// the trees: flower drifts on plains, ferns under forest, reeds in swamps, dry
// tufts on desert and tundra, pebbles on dirt and rock. Shared by /gm and
// /player.
//
// Same machinery and conventions as trees.js (scatter.js ScatterField: cached
// world-anchored tiles, deterministic per-cell placement, TRUE world coords,
// rim fade in the vertex shader), but DENSE and SMALL: a close-up layer that
// only exists at tactical zoom and casts no shadows.

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';
import { ScatterField, applyScatterFade } from './scatter.js';

const RADIUS     = 46;     // world units of cover around the camera target
const TILE       = 16;     // scatter tile size
const STEP       = 1.15;   // candidate-cell spacing
const SHOW_BELOW = 75;     // hide when camera-to-target exceeds this
const CAP        = 4000;   // instance capacity per species
const EDGE_FADE  = 0.7;

function hash2(x, z) {
    const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return h - Math.floor(h);
}
// Smooth value noise 0..1: plants grow in drifts and patches, not evenly.
function patch(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    let fx = x - ix, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// ---- species geometry (built once; faceted, vertex-colored) ---------------
// Colors here are multiplied by the per-instance color, so parts meant to take
// the instance tint (petals) are white and fixed parts carry their own hue.

function merge(parts) {
    let total = 0;
    const flat = parts.map(p => {
        const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
        total += g.getAttribute('position').count;
        return { pos: g.getAttribute('position').array, color: p.color };
    });
    const position = new Float32Array(total * 3), color = new Float32Array(total * 3);
    let o = 0;
    for (const f of flat) {
        position.set(f.pos, o);
        for (let i = 0; i < f.pos.length; i += 3) { color[o + i] = f.color[0]; color[o + i + 1] = f.color[1]; color[o + i + 2] = f.color[2]; }
        o += f.pos.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.computeVertexNormals();
    return g;
}
// A flat tapering blade/frond: base at the origin, leaning out along +x.
function blade(len, width, lean, yaw, color) {
    const g = new THREE.BufferGeometry();
    const tipX = Math.sin(lean) * len, tipY = Math.cos(lean) * len;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, -width / 2, 0, 0, width / 2, tipX, tipY, 0
    ]), 3));
    g.rotateY(yaw);
    return { geo: g, color };
}
function blob(radius, x, y, z, color, sy = 1) {
    const g = new THREE.OctahedronGeometry(radius, 0);
    g.scale(1, sy, 1);
    g.translate(x, y, z);
    return { geo: g, color };
}

function flowerClump() {                    // white heads take the instance color
    const stem = [0.35, 0.55, 0.25], head = [1, 1, 1];
    const parts = [];
    const spots = [[0, 0.34, 0], [0.16, 0.26, 0.1], [-0.13, 0.3, 0.14], [0.05, 0.22, -0.17], [-0.15, 0.2, -0.08]];
    spots.forEach(([x, y, z], i) => {
        const s = blade(y, 0.035, 0.0, i * 1.3, stem); s.geo.translate(x, 0, z); parts.push(s);
        parts.push(blob(0.065, x, y + 0.03, z, head, 0.7));
    });
    return merge(parts);
}
function fern() {
    const parts = [];
    for (let i = 0; i < 7; i++) parts.push(blade(0.5 + (i % 3) * 0.1, 0.2, 1.0 + (i % 2) * 0.22, i / 7 * Math.PI * 2, [0.55, 0.9, 0.5]));
    return merge(parts);
}
function reeds() {                          // cattails: tall blades, brown heads
    const parts = [], green = [0.62, 0.78, 0.42], head = [0.42, 0.27, 0.16];
    const at = [[0, 0], [0.12, 0.07], [-0.1, 0.1], [0.06, -0.12], [-0.08, -0.07]];
    at.forEach(([x, z], i) => {
        const h = 0.75 + (i % 3) * 0.2;
        const b = blade(h, 0.05, 0.08 + (i % 2) * 0.1, i * 1.9, green); b.geo.translate(x, 0, z); parts.push(b);
        if (i < 3) parts.push(blob(0.035, x + Math.sin(i * 1.9) * 0.02, h * 0.92, z, head, 3.2));
    });
    return merge(parts);
}
function tuft() {                           // a dry bunch-grass fan
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(blade(0.3 + (i % 3) * 0.09, 0.05, 0.25 + (i % 4) * 0.2, i / 8 * Math.PI * 2 + 0.3, [1, 1, 1]));
    return merge(parts);
}
function pebbles() {
    const grey = [1, 1, 1];
    return merge([
        blob(0.11, 0, 0.03, 0, grey, 0.6), blob(0.07, 0.17, 0.02, 0.06, grey, 0.6),
        blob(0.05, -0.1, 0.02, 0.14, grey, 0.7), blob(0.08, -0.05, 0.02, -0.16, grey, 0.55)
    ]);
}

const FLOWER = 0, FERN = 1, REED = 2, TUFT = 3, PEBBLE = 4;
const PETALS = [[1.0, 0.95, 0.85], [1.0, 0.82, 0.25], [0.72, 0.5, 0.95], [0.95, 0.4, 0.42], [0.55, 0.7, 1.0]];

export class GroundCover {
    constructor(terrain, scene) {
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
        this._fadeU = {
            uCenter: { value: new THREE.Vector2() },
            uFadeStart: { value: RADIUS * EDGE_FADE },
            uFadeEnd: { value: RADIUS }
        };
        mat.onBeforeCompile = (shader) => applyScatterFade(shader, this._fadeU);
        this.species = [flowerClump(), fern(), reeds(), tuft(), pebbles()].map(geo => {
            const mesh = new THREE.InstancedMesh(geo, mat, CAP);
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.receiveShadow = true;
            mesh.visible = false;
            scene.add(mesh);
            return mesh;
        });

        const dummy = new THREE.Object3D();
        const place = (emit, sp, px, pz, hy, scale, r, g, b) => {
            dummy.position.set(px, hy, pz);
            dummy.rotation.set(0, hash2(px + 3.1, pz + 9.2) * Math.PI * 2, 0);
            dummy.scale.set(scale, scale * (0.85 + hash2(px + 1.7, pz + 4.4) * 0.4), scale);
            dummy.updateMatrix();
            emit(sp, dummy.matrix, r, g, b);
        };
        this.field = new ScatterField({
            terrain, meshes: this.species,
            tileSize: TILE, radius: RADIUS, budgetMs: 1.5, clearance: 0.4,
            buildTile: (x0, z0, x1, z1, emit) => {
                const k0x = Math.ceil(x0 / STEP - 1e-9), k1x = Math.ceil(x1 / STEP - 1e-9);
                const k0z = Math.ceil(z0 / STEP - 1e-9), k1z = Math.ceil(z1 / STEP - 1e-9);
                for (let kx = k0x; kx < k1x; kx++) {
                    for (let kz = k0z; kz < k1z; kz++) {
                        const wx = kx * STEP, wz = kz * STEP;
                        const roll = hash2(wx * 0.83 + 2.2, wz * 1.19 - 7.4);
                        if (roll > 0.42) continue;                    // most cells are empty: cheap early out
                        const biome = terrain.genBiomeAt(wx, wz);
                        const m = terrain.dominantMaterial(wx, wz);
                        if (m === 3 && biome !== 'desert') continue;  // clean beaches
                        const px = wx + (hash2(wx + 4.3, wz) - 0.5) * STEP;
                        const pz = wz + (hash2(wx, wz + 8.1) - 0.5) * STEP;
                        const hy = terrain.sampleHeight(px, pz);
                        if (hy < SEA_LEVEL + 0.25) continue;
                        if (terrain.inWater(px, pz)) continue;        // lakes and rivers stay clear
                        if (Math.abs(terrain.sampleHeight(px + 0.8, pz) - hy) > 0.9 ||
                            Math.abs(terrain.sampleHeight(px, pz + 0.8) - hy) > 0.9) continue;   // not on cliffs
                        const snowy = terrain.snowAt(px, pz, hy);
                        const v = 0.8 + hash2(px + 2, pz + 9) * 0.4;                              // brightness jitter
                        const big = patch(wx * 0.06, wz * 0.06), fine = patch(wx * 0.23 + 40, wz * 0.23);
                        const size = 0.8 + hash2(px + 5, pz + 5) * 0.6;

                        // Pebbles: wherever the ground is dirt or rock.
                        if (m === 1 || m === 2) {
                            if (roll < (m === 2 ? 0.07 : 0.04)) {
                                const w = (hash2(px + 6.1, pz + 0.7) - 0.5) * 0.14;
                                const c = snowy ? 0.9 : 0.36 * v;
                                place(emit, PEBBLE, px, pz, hy, size * (m === 2 ? 1.5 : 1), c + w, c, c - w);
                            }
                            continue;
                        }
                        if (snowy) continue;                           // nothing green pokes through snow
                        if (biome === 'plains' || biome === 'coast') {
                            // Flower drifts: one color per patch, a few strays.
                            if (big > 0.6 && roll < 0.3 * (big - 0.6) / 0.4 + 0.02) {
                                const hue = Math.floor(patch(wx * 0.021 + 9, wz * 0.021) * PETALS.length * 0.999);
                                const p = PETALS[hash2(px, pz + 3) < 0.15 ? Math.floor(hash2(px + 9, pz) * PETALS.length) : hue];
                                place(emit, FLOWER, px, pz, hy, size * 0.8, p[0] * v, p[1] * v, p[2] * v);
                            } else if (biome === 'coast' && fine > 0.7 && roll < 0.05) {
                                place(emit, TUFT, px, pz, hy, size * 1.2, 0.55 * v, 0.6 * v, 0.32 * v);
                            }
                        } else if (biome === 'forest' || biome === 'taiga') {
                            if (fine > 0.45 && roll < 0.22) {
                                const d = biome === 'taiga' ? 0.75 : 1;
                                place(emit, FERN, px, pz, hy, size * 1.1, 0.4 * v * d, 0.62 * v * d, 0.32 * v);
                            } else if (big > 0.72 && roll < 0.26) {
                                place(emit, FLOWER, px, pz, hy, size * 0.8, 0.95 * v, 0.95 * v, 1.0 * v);   // woodland whites
                            }
                        } else if (biome === 'swamp') {
                            if (fine > 0.4 && roll < 0.3) {
                                place(emit, REED, px, pz, hy, size * 1.15, 0.55 * v, 0.62 * v, 0.4 * v);
                            } else if (roll < 0.34) {
                                place(emit, FERN, px, pz, hy, size * 0.9, 0.32 * v, 0.5 * v, 0.3 * v);
                            }
                        } else if (biome === 'desert') {
                            if (fine > 0.62 && roll < 0.07) place(emit, TUFT, px, pz, hy, size * 1.3, 0.72 * v, 0.62 * v, 0.34 * v);
                        } else if (biome === 'tundra' || biome === 'mountains') {
                            if (fine > 0.5 && roll < 0.12) place(emit, TUFT, px, pz, hy, size, 0.6 * v, 0.56 * v, 0.34 * v);
                            else if (biome === 'mountains' && big > 0.7 && roll < 0.2) {
                                place(emit, FLOWER, px, pz, hy, size * 0.7, 0.6 * v, 0.72 * v, 1.0 * v);    // alpine blues
                            }
                        }
                    }
                }
            }
        });
        this.terrain = terrain;
    }

    update(camera, controls, unified) {
        if (!unified || camera.position.distanceTo(controls.target) > SHOW_BELOW) {
            this.field.hide();
            return;
        }
        this.field.show();
        this._fadeU.uCenter.value.set(controls.target.x, controls.target.z); // scene coords
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        this.field.update(controls.target.x + ox, controls.target.z + oz, ox, oz);
    }

    hide() {
        this.field.hide();
    }
}
