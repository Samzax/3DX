// grass.js — instanced ground-cover grass scattered over the terrain near the
// camera. Shared by /gm and /player (step 2: the "living world" pass).
//
// How it stays cheap and correct:
// - ONE InstancedMesh of crossed-triangle blades; instances are repositioned,
//   never re-allocated.
// - Blades are placed only on the grass material (respects GM paint) and only
//   above the waterline, seated on the real terrain height (terrain.sampleHeight).
// - Placement is deterministic per world cell (a fract-sin hash), so a static
//   camera shows a stable field with no shimmer; the field only rebuilds when
//   the camera's ground point moves past a threshold.
// - Floating origin: sampling is in TRUE world coords, instance matrices are in
//   SCENE coords (world - terrain.worldOrigin), matching how chunk meshes render.
// - Grass is tactical-scale detail, so it hides entirely once you zoom out past
//   a lens altitude (also keeps the per-rebuild cost off the hex tiers).

import * as THREE from 'three';
import { SEA_LEVEL } from './terrain.js';

const MAX_BLADES   = 6000;   // instance capacity
const RADIUS       = 26;     // world-units of grass around the camera target
const STEP         = 0.5;    // candidate-cell spacing (world units)
const DENSITY      = 0.6;    // fraction of candidate cells that grow a blade
const REBUILD_MOVE = 1.5;    // rebuild once the ground point moves this far
const SHOW_BELOW   = 110;    // hide grass when camera-to-target exceeds this
const BLADE_H      = 0.45;
const BLADE_W      = 0.08;

// Deterministic 0..1 hash of two world coords (GLSL fract(sin) trick).
function hash2(x, z) {
    const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return h - Math.floor(h);
}

// Two crossed tapered blades (a wide base narrowing toward the tip reads as
// grass, not a spiky pine). Normals are forced straight up so every blade
// catches the hemisphere sky light evenly — soft, never dead-dark.
function makeBladeGeometry() {
    const H = BLADE_H, w = BLADE_W, t = BLADE_W * 0.4;   // base half-width, tip half-width
    // One plane = a tapered quad as two triangles (base-left, base-right, tip-right / base-left, tip-right, tip-left).
    const plane = (ax) => ax === 'x'
        ? [-w,0,0,  w,0,0,  t,H,0,   -w,0,0,  t,H,0,  -t,H,0]     // in XY
        : [0,0,-w,  0,0,w,  0,H,t,    0,0,-w,  0,H,t,  0,H,-t];   // in ZY
    const position = new Float32Array([...plane('x'), ...plane('z')]);
    const normal = new Float32Array(position.length);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;     // all normals = (0,1,0)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    return g;
}

export class Grass {
    constructor(terrain, scene) {
        this.terrain = terrain;
        // emissive green floor: crossed blades always turn one face away from the
        // sun, and DoubleSide flips those normals downward — without a floor they
        // render near-black. The floor keeps every blade a healthy green.
        const mat = new THREE.MeshLambertMaterial({
            color: 0xffffff, emissive: 0x24421a, side: THREE.DoubleSide
        });
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
        if (!unified || camera.position.distanceTo(controls.target) > SHOW_BELOW) {
            this.mesh.visible = false;
            this._last = null;               // force a rebuild when we return
            return;
        }
        this.mesh.visible = true;
        const ox = this.terrain.worldOrigin.x, oz = this.terrain.worldOrigin.z;
        const cwx = controls.target.x + ox, cwz = controls.target.z + oz;
        if (this._last && Math.hypot(cwx - this._last.x, cwz - this._last.z) < REBUILD_MOVE) return;
        this._last = { x: cwx, z: cwz };
        this._scatter(cwx, cwz, ox, oz);
    }

    _scatter(cwx, cwz, ox, oz) {
        const t = this.terrain, d = this._dummy, col = this._col;
        const r2 = RADIUS * RADIUS;
        // Snap the scan grid to world-space multiples of STEP so each cell's hash
        // is stable as the camera roams (no crawling/shimmer).
        const x0 = Math.floor((cwx - RADIUS) / STEP) * STEP;
        const z0 = Math.floor((cwz - RADIUS) / STEP) * STEP;
        let n = 0;
        for (let wx = x0; wx <= cwx + RADIUS && n < MAX_BLADES; wx += STEP) {
            for (let wz = z0; wz <= cwz + RADIUS && n < MAX_BLADES; wz += STEP) {
                const dx = wx - cwx, dz = wz - cwz;
                if (dx * dx + dz * dz > r2) continue;
                if (hash2(wx * 1.3, wz * 1.7) > DENSITY) continue;   // thin out
                if (t.dominantMaterial(wx, wz) !== 0) continue;      // grass channel only
                const px = wx + (hash2(wx + 11.3, wz) - 0.5) * STEP;
                const pz = wz + (hash2(wx, wz + 7.7) - 0.5) * STEP;
                const hy = t.sampleHeight(px, pz);
                if (hy < SEA_LEVEL + 0.3) continue;                  // no underwater/beach grass
                d.position.set(px - ox, hy, pz - oz);
                d.rotation.set(0, hash2(px + 3.1, pz + 9.2) * Math.PI * 2, 0);
                const s = 0.7 + hash2(px + 5, pz + 5) * 0.7;
                d.scale.set(s, s, s);
                d.updateMatrix();
                this.mesh.setMatrixAt(n, d.matrix);
                const v = 1.0 + hash2(px + 2, pz + 9) * 0.4;         // per-blade brightness (kept healthy)
                this.mesh.setColorAt(n, col.setRGB(0.30 * v, 0.52 * v, 0.24 * v));
                n++;
            }
        }
        this.mesh.count = n;
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
}
