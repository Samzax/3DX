// trees.js — procedural low-poly trees scattered over the terrain by biome.
// Shared by /gm and /player (step 2: the "living world" pass, vegetation layer).
//
// Trees are SPARSE and LARGE (unlike grass): hundreds of instances, ~25-40 ft
// tall, visible far, casting shadows. So they don't need grass's dense chunked
// streaming — a simple rebuild-on-move over a wide radius is cheap here.
//
// Variety is the point: four species silhouettes (oak / pine / bush / poplar),
// each faceted low-poly with a baked trunk+foliage vertex-color split, mixed by
// biome and then jittered per instance (scale, yaw, lean, brightness).
//
// Shared conventions with grass.js: deterministic per-cell placement (no sync,
// no shimmer), sampling in TRUE world coords, instance matrices in SCENE coords
// (world - terrain.worldOrigin), hidden above tactical/near-lens zoom.

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';

const RADIUS       = 110;    // world-units of trees around the camera (~550 ft)
const STEP         = 3.5;    // candidate-cell spacing (~17 ft)
const REBUILD_MOVE = 8;      // rebuild once the ground point moves this far
const SHOW_BELOW   = 220;    // hide trees when camera-to-target exceeds this
const CAP          = 700;    // instance capacity per species
const EDGE_FADE    = 0.82;   // trees shrink toward the rim past this fraction of RADIUS

function hash2(x, z) {
    const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return h - Math.floor(h);
}

// ---- species geometry (built once) --------------------------------------
// Each part is a primitive positioned in tree-local space (y=0 at the ground,
// growing +y) and tagged with an RGB color; mergeParts flattens them into one
// faceted, vertex-colored geometry so a whole tree is a single instanced draw.

const BARK = [0.42, 0.29, 0.18];

function part(geo, color, { sy = 1, ty = 0 } = {}) {
    if (sy !== 1) geo.scale(1, sy, 1);
    geo.translate(0, ty, 0);
    return { geo, color };
}

function mergeParts(parts) {
    const arrays = [], colors = [];
    let total = 0;
    for (const p of parts) {
        const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
        const pos = g.getAttribute('position').array;
        arrays.push(pos);
        const c = new Float32Array(pos.length);
        for (let i = 0; i < pos.length; i += 3) { c[i] = p.color[0]; c[i + 1] = p.color[1]; c[i + 2] = p.color[2]; }
        colors.push(c);
        total += pos.length;
    }
    const position = new Float32Array(total), color = new Float32Array(total);
    let o = 0;
    for (let i = 0; i < arrays.length; i++) { position.set(arrays[i], o); color.set(colors[i], o); o += arrays[i].length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.computeVertexNormals();   // non-indexed => flat per-face normals (low-poly look)
    return g;
}

function oakTree() {                                   // rounded broadleaf
    const green = [0.24, 0.44, 0.19];
    return mergeParts([
        part(new THREE.CylinderGeometry(0.16, 0.26, 2.6, 6), BARK, { ty: 1.3 }),
        part(new THREE.IcosahedronGeometry(1.5, 0), green, { ty: 3.4 }),
        part(new THREE.IcosahedronGeometry(1.15, 0), green, { ty: 4.3 }),
        part(new THREE.IcosahedronGeometry(1.0, 0), green, { ty: 3.7 }),
    ]);
}
function pineTree() {                                  // stacked conifer
    const green = [0.16, 0.33, 0.18];
    return mergeParts([
        part(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 6), BARK, { ty: 0.8 }),
        part(new THREE.ConeGeometry(1.5, 1.9, 7), green, { ty: 2.1 }),
        part(new THREE.ConeGeometry(1.15, 1.7, 7), green, { ty: 3.1 }),
        part(new THREE.ConeGeometry(0.75, 1.5, 7), green, { ty: 4.1 }),
    ]);
}
function bushTree() {                                  // low round shrub-tree
    const green = [0.30, 0.48, 0.22];
    return mergeParts([
        part(new THREE.CylinderGeometry(0.14, 0.18, 0.9, 6), BARK, { ty: 0.45 }),
        part(new THREE.IcosahedronGeometry(1.5, 0), green, { sy: 0.8, ty: 1.4 }),
    ]);
}
function poplarTree() {                                // tall slim
    const green = [0.27, 0.45, 0.2];
    return mergeParts([
        part(new THREE.CylinderGeometry(0.12, 0.16, 3.6, 6), BARK, { ty: 1.8 }),
        part(new THREE.IcosahedronGeometry(0.95, 1), green, { sy: 2.3, ty: 4.0 }),
    ]);
}

const OAK = 0, PINE = 1, BUSH = 2, POPLAR = 3;

export class Trees {
    constructor(terrain, scene) {
        this.terrain = terrain;
        const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
        const geos = [oakTree(), pineTree(), bushTree(), poplarTree()];
        this.species = geos.map(geo => {
            const mesh = new THREE.InstancedMesh(geo, mat, CAP);
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.count = 0;
            mesh.frustumCulled = false;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.visible = false;
            scene.add(mesh);
            return mesh;
        });
        this._dummy = new THREE.Object3D();
        this._col = new THREE.Color();
        this._last = null;
    }

    update(camera, controls, unified) {
        const far = camera.position.distanceTo(controls.target) > SHOW_BELOW;
        if (!unified || far) {
            for (const m of this.species) m.visible = false;
            this._last = null;
            return;
        }
        for (const m of this.species) m.visible = true;
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        const cwx = controls.target.x + ox, cwz = controls.target.z + oz;
        if (this._last && Math.hypot(cwx - this._last.x, cwz - this._last.z) < REBUILD_MOVE) return;
        this._last = { x: cwx, z: cwz };
        this._scatter(cwx, cwz, ox, oz);
    }

    _scatter(cwx, cwz, ox, oz) {
        const t = this.terrain, d = this._dummy, col = this._col;
        const r2 = RADIUS * RADIUS, fadeR = RADIUS * EDGE_FADE;
        const x0 = Math.floor((cwx - RADIUS) / STEP) * STEP;
        const z0 = Math.floor((cwz - RADIUS) / STEP) * STEP;
        const counts = [0, 0, 0, 0];
        for (let wx = x0; wx <= cwx + RADIUS; wx += STEP) {
            for (let wz = z0; wz <= cwz + RADIUS; wz += STEP) {
                const dx = wx - cwx, dz = wz - cwz, dd = dx * dx + dz * dz;
                if (dd > r2) continue;
                const biome = t.genBiomeAt(wx, wz);
                const dens = biome === 'forest' ? 0.55 : biome === 'mountains' ? 0.2
                           : biome === 'coast' ? 0.14 : biome === 'plains' ? 0.1 : 0;   // desert: none
                if (dens === 0 || hash2(wx * 0.7, wz * 0.9) > dens) continue;
                const mat = t.dominantMaterial(wx, wz);
                if (mat === 2 || mat === 3) continue;                // no trees on rock/sand
                const px = wx + (hash2(wx + 4.3, wz) - 0.5) * STEP;
                const pz = wz + (hash2(wx, wz + 8.1) - 0.5) * STEP;
                const hy = t.sampleHeight(px, pz);
                if (hy < SEA_LEVEL + 0.5) continue;                  // above the waterline
                // No trees on cliffs: reject steep ground.
                if (Math.abs(t.sampleHeight(px + 1.6, pz) - hy) > 3 ||
                    Math.abs(t.sampleHeight(px, pz + 1.6) - hy) > 3) continue;

                const sp = this._species(biome, hash2(wx + 50, wz + 50));
                const mesh = this.species[sp];
                if (counts[sp] >= CAP) continue;
                const edge = 1 - Math.max(0, (Math.sqrt(dd) - fadeR) / (RADIUS - fadeR));
                d.position.set(px - ox, hy, pz - oz);
                d.rotation.set(
                    (hash2(px + 2.2, pz + 5.5) - 0.5) * 0.14,          // slight lean
                    hash2(px + 3.1, pz + 9.2) * Math.PI * 2,           // yaw
                    (hash2(px + 6.6, pz + 1.1) - 0.5) * 0.14);
                const s = (0.75 + hash2(px + 5, pz + 5) * 0.6) * edge; // size variation
                d.scale.set(s, s, s);
                d.updateMatrix();
                mesh.setMatrixAt(counts[sp], d.matrix);
                const v = 0.85 + hash2(px + 2, pz + 9) * 0.3;          // per-tree brightness
                mesh.setColorAt(counts[sp], col.setRGB(v, v, v));
                counts[sp]++;
            }
        }
        for (let i = 0; i < this.species.length; i++) {
            const m = this.species[i];
            m.count = counts[i];
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
    }

    _species(biome, r) {
        if (biome === 'mountains') return r < 0.9 ? PINE : BUSH;
        if (biome === 'forest') return r < 0.42 ? OAK : r < 0.78 ? PINE : r < 0.9 ? BUSH : POPLAR;
        return r < 0.58 ? OAK : r < 0.85 ? BUSH : POPLAR;            // plains / coast
    }
}
