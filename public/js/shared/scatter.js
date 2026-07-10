// scatter.js — chunked, budgeted instance scattering shared by the vegetation
// systems (grass.js, trees.js). One idea: the world is cut into fixed square
// TILES; a tile's instances are generated ONCE (deterministic content keyed on
// world coords) and cached, so roaming only pays for the tiles entering the
// radius — a few milliseconds amortized per frame instead of regenerating the
// whole field in one hitched frame.
//
// Contracts:
// - Instance matrices are cached with TRUE-WORLD translations; the pack step
//   subtracts terrain.worldOrigin, so a floating-origin rebase is just a
//   repack, never a regeneration.
// - The rim fade lives in the vertex shader (applyScatterFade), scaling each
//   instance by its distance to a uCenter uniform — cached tiles can't bake a
//   center-relative scale, and this makes the fade free as the camera roams.
// - terrain.rev bumps on any content edit; the field clears its cache ~350ms
//   after edits settle, so sculpt/paint reshapes the vegetation.

import * as THREE from 'three';

export class ScatterField {
    // opts: {
    //   terrain, meshes: [InstancedMesh...],
    //   tileSize, radius,           // world units
    //   buildTile(x0, z0, x1, z1, emit)  // deterministic; emit(meshIndex, matrix4, r, g, b)
    //   budgetMs = 3                 // per-frame tile-building budget
    // }
    constructor(opts) {
        this.terrain = opts.terrain;
        this.meshes = opts.meshes;
        this.tileSize = opts.tileSize;
        this.radius = opts.radius;
        this.buildTile = opts.buildTile;
        this.budgetMs = opts.budgetMs || 3;
        this.tiles = new Map();          // "tx,tz" -> per-mesh { mats, cols, n }
        this._packedOrigin = null;
        this._appliedRev = this.terrain.rev || 0;
        this._revSeen = this._appliedRev;
        this._revTime = 0;
        // Allocate instance color buffers at full capacity up-front (three's
        // setColorAt sizes them from the CURRENT count, which we keep at the
        // live instance total; _pack writes the arrays directly).
        for (const m of this.meshes) {
            if (!m.instanceColor) {
                m.instanceColor = new THREE.InstancedBufferAttribute(
                    new Float32Array(m.instanceMatrix.count * 3), 3);
            }
        }
    }

    // Call each frame while visible. (cwx,cwz) = camera ground point in TRUE
    // world coords; (ox,oz) = terrain.worldOrigin.
    update(cwx, cwz, ox, oz) {
        const now = performance.now();
        // Terrain edits: rebuild only after the stroke settles, not per dab.
        const rev = this.terrain.rev || 0;
        if (rev !== this._revSeen) { this._revSeen = rev; this._revTime = now; }
        if (this._revSeen !== this._appliedRev && now - this._revTime > 350) {
            this.tiles.clear();
            this._appliedRev = this._revSeen;
        }

        const T = this.tileSize, R = this.radius, r2 = R * R;
        const tx0 = Math.floor((cwx - R) / T), tx1 = Math.floor((cwx + R) / T);
        const tz0 = Math.floor((cwz - R) / T), tz1 = Math.floor((cwz + R) / T);
        const desired = new Set();
        for (let tx = tx0; tx <= tx1; tx++) {
            for (let tz = tz0; tz <= tz1; tz++) {
                // Keep tiles whose nearest point is inside the radius.
                const nx = Math.max(tx * T, Math.min(cwx, tx * T + T));
                const nz = Math.max(tz * T, Math.min(cwz, tz * T + T));
                const dx = nx - cwx, dz = nz - cwz;
                if (dx * dx + dz * dz <= r2) desired.add(tx + ',' + tz);
            }
        }

        let changed = false;
        for (const k of this.tiles.keys()) {
            if (!desired.has(k)) { this.tiles.delete(k); changed = true; }
        }
        const missing = [];
        for (const k of desired) if (!this.tiles.has(k)) missing.push(k);
        if (missing.length) {
            // Nearest tiles first so the ground under the camera fills before the rim.
            missing.sort((a, b) => this._tileDist2(a, cwx, cwz) - this._tileDist2(b, cwx, cwz));
            const t0 = performance.now();
            for (const k of missing) {
                this.tiles.set(k, this._build(k));
                changed = true;
                if (performance.now() - t0 > this.budgetMs) break;
            }
        }

        const o = this._packedOrigin;
        if (changed || !o || o.x !== ox || o.z !== oz) this._pack(ox, oz);
    }

    hide() {
        for (const m of this.meshes) m.visible = false;
    }
    show() {
        for (const m of this.meshes) m.visible = true;
    }

    _tileDist2(k, cwx, cwz) {
        const i = k.indexOf(',');
        const cx = (+k.slice(0, i) + 0.5) * this.tileSize;
        const cz = (+k.slice(i + 1) + 0.5) * this.tileSize;
        return (cx - cwx) * (cx - cwx) + (cz - cwz) * (cz - cwz);
    }

    _build(k) {
        const i = k.indexOf(',');
        const tx = +k.slice(0, i), tz = +k.slice(i + 1);
        const T = this.tileSize;
        // Growable staging, frozen into typed arrays per mesh.
        const staging = this.meshes.map(() => ({ mats: [], cols: [] }));
        const emit = (mi, matrix, r, g, b) => {
            const s = staging[mi];
            for (let e = 0; e < 16; e++) s.mats.push(matrix.elements[e]);
            s.cols.push(r, g, b);
        };
        this.buildTile(tx * T, tz * T, tx * T + T, tz * T + T, emit);
        return staging.map(s => ({
            mats: new Float32Array(s.mats),
            cols: new Float32Array(s.cols),
            n: s.cols.length / 3
        }));
    }

    // Concatenate all live tiles into the InstancedMesh buffers, shifting the
    // cached world-space translations into scene space (minus the origin).
    _pack(ox, oz) {
        for (let mi = 0; mi < this.meshes.length; mi++) {
            const mesh = this.meshes[mi];
            const cap = mesh.instanceMatrix.count;
            const dstM = mesh.instanceMatrix.array;
            const dstC = mesh.instanceColor.array;
            let off = 0;
            for (const tile of this.tiles.values()) {
                const t = tile[mi];
                let n = t.n;
                if (off + n > cap) n = cap - off;   // silent clamp at capacity
                if (n <= 0) break;
                dstM.set(t.mats.subarray(0, n * 16), off * 16);
                dstC.set(t.cols.subarray(0, n * 3), off * 3);
                // Fix translations: world -> scene.
                for (let j = 0; j < n; j++) {
                    const b = (off + j) * 16;
                    dstM[b + 12] -= ox;
                    dstM[b + 14] -= oz;
                }
                off += n;
            }
            mesh.count = off;
            // Upload only the live instances, not the full capacity buffer
            // (stale data past `count` is never drawn).
            mesh.instanceMatrix.updateRange = { offset: 0, count: off * 16 };
            mesh.instanceColor.updateRange = { offset: 0, count: off * 3 };
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor.needsUpdate = true;
        }
        this._packedOrigin = { x: ox, z: oz };
    }
}

// Inject the rim fade into a material's shader: instances scale to zero as
// their ground point approaches uFadeEnd from uFadeStart, so a cached field
// has a soft edge that follows the camera for free. Call inside the caller's
// onBeforeCompile (anchors on project_vertex, so it composes with other
// begin_vertex edits like grass wind).
export function applyScatterFade(shader, uniforms) {
    shader.uniforms.uCenter = uniforms.uCenter;
    shader.uniforms.uFadeStart = uniforms.uFadeStart;
    shader.uniforms.uFadeEnd = uniforms.uFadeEnd;
    shader.vertexShader = (
        'uniform vec2 uCenter;\nuniform float uFadeStart;\nuniform float uFadeEnd;\n' +
        shader.vertexShader
    ).replace(
        '#include <project_vertex>',
        `#ifdef USE_INSTANCING
           float dCen = distance(vec2(instanceMatrix[3][0], instanceMatrix[3][2]), uCenter);
           transformed *= 1.0 - smoothstep(uFadeStart, uFadeEnd, dCen);
         #endif
         #include <project_vertex>`
    );
}
