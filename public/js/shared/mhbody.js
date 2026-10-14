// mhbody.js — the parametric character body.
//
// A MakeHuman-style pipeline run in the browser on the kit that
// tools/build-character-kit.mjs writes to /assets/characters/mh/:
//
//   shape     base mesh (19158 vertices: body + fitting helpers) + a weighted
//             sum of morph targets — the macro space (gender × age × muscle ×
//             weight × height × ethnicity) and ~160 detail sliders
//   fit       every worn mesh (clothes, hair, eyes…) is bound to base-mesh
//             vertices, so it is re-fitted to whatever body the morphs produce
//   skeleton  joints are read off the morphed mesh (joint cubes) and the
//             shared animation rig is rebuilt around them, so the animation
//             library plays on any body shape
//
// Three r132 blends at most 8 morph targets on the GPU, and a character's
// shape never changes after it is built, so morphs are baked into plain
// geometry here instead of being shipped as shape keys.
//
// No DOM beyond fetch; charmesh.js owns materials, animation and lifecycle.

import * as THREE from 'three';

const KIT_URL = '/assets/characters/mh/';
const DM = 0.1; // kit units are decimetres

let _kitPromise = null;
export function loadCharacterKit() {
    if (_kitPromise) return _kitPromise;
    const bin = (file) => fetch(KIT_URL + file).then(r => { if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.arrayBuffer(); });
    _kitPromise = Promise.all([
        fetch(KIT_URL + 'kit.json').then(r => { if (!r.ok) throw new Error(`kit.json: ${r.status}`); return r.json(); }),
        bin('base.bin'), bin('body.bin'), bin('weights.bin')
    ]).then(([kit, base, body, weights]) => {
        const section = (buffer, s) => new (globalThis[s.type])(buffer, s.offset, s.count);
        kit.base = new Float32Array(base);
        kit.bodySrc = section(body, kit.body.src);
        kit.bodyUv = section(body, kit.body.uv);
        kit.bodyIndex = section(body, kit.body.index);
        kit.skinIndex = section(weights, kit.weights.skinIndex);
        kit.skinWeight = section(weights, kit.weights.skinWeight);
        kit.boneIndex = Object.fromEntries(kit.bones.map((name, i) => [name, i]));
        return kit;
    });
    return _kitPromise;
}

// --- Morph targets -----------------------------------------------------------
const _targets = new Map(); // id -> Promise<{ index: Uint16Array, delta: Int16Array, scale }>
function loadTarget(id) {
    if (!_targets.has(id)) {
        _targets.set(id, fetch(`${KIT_URL}targets/${id}.bin`).then(r => {
            if (!r.ok) throw new Error(`target ${id}: ${r.status}`);
            return r.arrayBuffer();
        }).then(buffer => {
            const view = new DataView(buffer);
            const scale = view.getFloat32(0, true), n = view.getUint32(4, true);
            const indexBytes = n * 2 + (n * 2 % 4 ? 2 : 0);
            return { scale: scale / 32767, index: new Uint16Array(buffer, 8, n), delta: new Int16Array(buffer, 8 + indexBytes, n * 3) };
        }));
    }
    return _targets.get(id);
}

const clamp01 = (v, fallback) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : fallback);

// The macro space → { targetId: weight }. Mirrors MakeHuman's macro rules for
// the adult half of the age axis (age 0 = young adult, 1 = old).
export function macroWeights(shape = {}) {
    const gender = clamp01(shape.gender, 0.5), age = clamp01(shape.age, 0);
    const muscle = clamp01(shape.muscle, 0.5), weight = clamp01(shape.weight, 0.5), height = clamp01(shape.height, 0.5);
    const genders = [['female', 1 - gender], ['male', gender]];
    const ages = [['young', 1 - age], ['old', age]];
    const three = (v, low, mid, high) => (v < 0.5
        ? [[low, 1 - v * 2], [mid, v * 2]] : [[mid, 1 - (v - 0.5) * 2], [high, (v - 0.5) * 2]]);
    const muscles = three(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle');
    const weights = three(weight, 'minweight', 'averageweight', 'maxweight');
    const heights = height < 0.5 ? [['minheight', 1 - height * 2]] : [['maxheight', (height - 0.5) * 2]];
    const eth = shape.ethnicity || {};
    let races = [['african', +eth.african || 0], ['asian', +eth.asian || 0], ['caucasian', +eth.caucasian || 0]];
    const total = races.reduce((s, [, w]) => s + Math.max(0, w), 0);
    races = total > 0 ? races.map(([n, w]) => [n, Math.max(0, w) / total]) : races.map(([n]) => [n, 1 / 3]);

    const out = {};
    const add = (id, w) => { if (w > 1e-4) out[id] = (out[id] || 0) + w; };
    for (const [g, gw] of genders) for (const [a, aw] of ages) {
        for (const [r, rw] of races) add(`${r}-${g}-${a}`, gw * aw * rw);
        for (const [m, mw] of muscles) for (const [w, ww] of weights) {
            add(`universal-${g}-${a}-${m}-${w}`, gw * aw * mw * ww);
            for (const [h, hw] of heights) add(`${g}-${a}-${m}-${w}-${h}`, gw * aw * mw * ww * hw);
        }
    }
    return out;
}

// Detail sliders (-1..1 each) → { targetId: weight }.
export function detailWeights(kit, details = {}) {
    const out = {};
    for (const [id, raw] of Object.entries(details || {})) {
        const slider = kit.sliders[id];
        const v = Math.max(-1, Math.min(1, +raw || 0));
        if (!slider || Math.abs(v) < 1e-3) continue;
        for (const target of (v < 0 ? slider.neg : slider.pos)) out[target] = Math.abs(v);
    }
    return out;
}

// Morphed base mesh (all 19158 vertices, kit units) for a shape.
export async function morphBase(kit, shape) {
    const weights = { ...macroWeights(shape), ...detailWeights(kit, shape && shape.details) };
    const ids = Object.keys(weights).filter(id => kit.targets[id]); // absent = an empty target
    const loaded = await Promise.all(ids.map(loadTarget));
    const out = new Float32Array(kit.base);
    loaded.forEach((target, t) => {
        const k = weights[ids[t]] * target.scale;
        const { index, delta } = target;
        for (let i = 0; i < index.length; i++) {
            const v = index[i] * 3;
            out[v] += delta[i * 3] * k; out[v + 1] += delta[i * 3 + 1] * k; out[v + 2] += delta[i * 3 + 2] * k;
        }
    });
    return out;
}

// --- Geometry ------------------------------------------------------------------
// Area-weighted normals on the base topology (render vertices are split on UV
// seams; computing on the split mesh would crease every seam).
function sharedNormals(positions, src, index, vertexCount) {
    const acc = new Float32Array(vertexCount * 3);
    for (let i = 0; i < index.length; i += 3) {
        const a = src[index[i]] * 3, b = src[index[i + 1]] * 3, c = src[index[i + 2]] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz; }
    }
    const out = new Float32Array(src.length * 3);
    for (let r = 0; r < src.length; r++) {
        const o = src[r] * 3;
        const len = Math.hypot(acc[o], acc[o + 1], acc[o + 2]) || 1;
        out[r * 3] = acc[o] / len; out[r * 3 + 1] = acc[o + 1] / len; out[r * 3 + 2] = acc[o + 2] / len;
    }
    return out;
}

// Skinned geometry for a mesh whose render vertices map to base vertices.
// `hidden` (Uint8 per base vertex) drops the triangles clothes cover.
export function bodyGeometry(kit, morphed, origin, hidden = null) {
    const { bodySrc: src, bodyUv: uv, bodyIndex } = kit;
    let index = bodyIndex;
    if (hidden) {
        const kept = [];
        for (let i = 0; i < bodyIndex.length; i += 3) {
            const a = bodyIndex[i], b = bodyIndex[i + 1], c = bodyIndex[i + 2];
            if (hidden[src[a]] && hidden[src[b]] && hidden[src[c]]) continue;
            kept.push(a, b, c);
        }
        index = new Uint32Array(kept);
    }
    const position = new Float32Array(src.length * 3);
    const skinIndex = new Uint16Array(src.length * 4), skinWeight = new Float32Array(src.length * 4);
    for (let r = 0; r < src.length; r++) {
        const v = src[r];
        position[r * 3] = (morphed[v * 3] - origin.x) * DM;
        position[r * 3 + 1] = (morphed[v * 3 + 1] - origin.y) * DM;
        position[r * 3 + 2] = (morphed[v * 3 + 2] - origin.z) * DM;
        for (let k = 0; k < 4; k++) {
            skinIndex[r * 4 + k] = kit.skinIndex[v * 4 + k];
            skinWeight[r * 4 + k] = kit.skinWeight[v * 4 + k] / 255;
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(sharedNormals(morphed, src, bodyIndex, kit.vertexCount), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.computeBoundingSphere();
    return geometry;
}

// --- Skeleton ------------------------------------------------------------------
function jointCentre(morphed, joint, out) {
    let x = 0, y = 0, z = 0, n = 0;
    const add = (v) => { x += morphed[v * 3]; y += morphed[v * 3 + 1]; z += morphed[v * 3 + 2]; n++; };
    if (joint.verts) for (let v = joint.verts[0]; v <= joint.verts[1]; v++) add(v);
    else for (const v of joint.list) add(v);
    return out.set(x / n, y / n, z / n);
}

// Joint positions (model metres, ground at y 0, root at x/z 0) for every kit bone.
export function fitJoints(kit, morphed) {
    const origin = jointCentre(morphed, kit.rig[0].head, new THREE.Vector3()); // Root sits on the ground cube
    const joints = {};
    for (const bone of kit.rig) {
        joints[bone.name] = jointCentre(morphed, bone.head, new THREE.Vector3()).sub(origin).multiplyScalar(DM);
    }
    return { origin, joints };
}

// Which child a bone "points at" when the animation rig is re-aimed at the
// fitted joints. Bones not listed (head, fingertips, toes) keep their parent's aim.
const AIM = {
    pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'head'
};
for (const s of ['l', 'r']) {
    Object.assign(AIM, {
        ['clavicle_' + s]: 'upperarm_' + s, ['upperarm_' + s]: 'lowerarm_' + s, ['lowerarm_' + s]: 'hand_' + s,
        ['hand_' + s]: 'middle_01_' + s, ['thigh_' + s]: 'calf_' + s, ['calf_' + s]: 'foot_' + s, ['foot_' + s]: 'ball_' + s
    });
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        AIM[`${f}_01_${s}`] = `${f}_02_${s}`; AIM[`${f}_02_${s}`] = `${f}_03_${s}`;
    }
}

// Rebuild the animation rig around fitted joints. `rigRoot` is a fresh clone of
// the animation library's armature (its bones keep the library's names and
// local frames, which is what makes the clips play unchanged): every kit bone
// is moved to its fitted joint and swung from the library's rest direction to
// this body's, then the pose is frozen as the bind pose.
// Returns { skeleton, pelvis: { bone, rest: Vector3 (library), fitted: Vector3 } }.
export function fitSkeleton(kit, rigRoot, joints) {
    rigRoot.updateMatrixWorld(true);
    const find = new Map();
    rigRoot.traverse(o => { if (o.isBone) find.set(o.name.toLowerCase(), o); });
    const bones = kit.bones.map(name => find.get(name.toLowerCase()) || null);
    const missing = kit.bones.filter((_, i) => !bones[i]);
    if (missing.length) throw new Error('animation rig is missing bones: ' + missing.join(', '));

    const restPos = {}, restQuat = {};
    kit.bones.forEach((name, i) => {
        restPos[name] = bones[i].getWorldPosition(new THREE.Vector3());
        restQuat[name] = bones[i].getWorldQuaternion(new THREE.Quaternion());
    });
    const pelvisBone = bones[kit.boneIndex.pelvis];
    const pelvisRest = pelvisBone.position.clone();

    const swing = {};
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const parentOf = Object.fromEntries(kit.rig.map(r => [r.name, r.parent]));
    for (const { name } of kit.rig) { // parents precede children in the kit
        const child = AIM[name];
        if (child && joints[child]) {
            a.subVectors(restPos[child], restPos[name]).normalize();
            b.subVectors(joints[child], joints[name]).normalize();
            swing[name] = new THREE.Quaternion().setFromUnitVectors(a, b);
        } else {
            swing[name] = (parentOf[name] && swing[parentOf[name]]) ? swing[parentOf[name]].clone() : new THREE.Quaternion();
        }
    }

    // Top-down: place each bone in world space, then express it in its
    // (already placed) parent's frame.
    const order = [];
    rigRoot.traverse(o => { if (o.isBone) order.push(o); });
    const nameOf = new Map(bones.map((bone, i) => [bone, kit.bones[i]]));
    const world = new THREE.Matrix4(), inv = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion(), scale = new THREE.Vector3();
    for (const bone of order) {
        const name = nameOf.get(bone);
        if (name) {
            q.copy(swing[name]).multiply(restQuat[name]);
            world.compose(joints[name], q, one);
            bone.parent.updateWorldMatrix(true, false);
            inv.copy(bone.parent.matrixWorld).invert();
            world.premultiply(inv).decompose(bone.position, bone.quaternion, scale);
            bone.scale.set(1, 1, 1);
        }
        bone.updateWorldMatrix(false, false);
    }
    rigRoot.updateMatrixWorld(true);
    return { skeleton: new THREE.Skeleton(bones), pelvis: { bone: pelvisBone, rest: pelvisRest, fitted: pelvisBone.position.clone() } };
}

// --- Worn assets ---------------------------------------------------------------
const _assetMeshes = new Map(); // id -> Promise<sections>
function loadAssetMesh(kit, id) {
    if (!_assetMeshes.has(id)) {
        const entry = kit.assets[id];
        _assetMeshes.set(id, fetch(`${KIT_URL}assets/${id}/mesh.bin`).then(r => {
            if (!r.ok) throw new Error(`asset ${id}: ${r.status}`);
            return r.arrayBuffer();
        }).then(buffer => {
            const out = {};
            for (const [name, s] of Object.entries(entry.layout)) out[name] = new (globalThis[s.type])(buffer, s.offset, s.count);
            return out;
        }));
    }
    return _assetMeshes.get(id);
}

// Base vertices hidden under the given worn assets (Uint8 per base vertex).
export function hiddenVertices(kit, assetIds) {
    const hidden = new Uint8Array(kit.vertexCount);
    for (const id of assetIds) {
        for (const [from, to] of (kit.assets[id] && kit.assets[id].hides) || []) hidden.fill(1, from, to + 1);
    }
    return hidden;
}

// Fit one asset to a morphed body: every asset vertex hangs from three base
// vertices plus an offset that scales with the body part it was modelled on;
// its skin weights are the same blend of those vertices' weights.
// `inflate` (kit units) pushes the fitted surface out along its normals: clothes worn over a
// body form have to clear scales and plates the kit body underneath doesn't have.
// For a body form: `covered` (Uint8 per base vertex, what the clothes over it hide) drops the
// sculpt's skin under armour, and `omit` (bone-name prefixes) drops whole rigid parts that a worn
// piece replaces — clawed hands under gauntlets, feet inside boots.
export async function assetGeometry(kit, id, morphed, origin, inflate = 0, { covered = null, omit = [], flatten = false } = {}) {
    const entry = kit.assets[id];
    if (!entry) throw new Error(`unknown asset ${id}`);
    const { fitVerts, fitWeight, fitOffset, src, uv, index } = await loadAssetMesh(kit, id);
    const n = entry.vertexCount;
    const axis = (key, c) => {
        const ref = entry.scale && entry.scale[key];
        return ref && ref[2] ? Math.abs(morphed[ref[0] * 3 + c] - morphed[ref[1] * 3 + c]) / ref[2] : 1;
    };
    const sx = axis('x', 0), sy = axis('y', 1), sz = axis('z', 2);

    const tuck = entry.slot === 'bodyform' && !!covered;
    const fitted = new Float32Array(n * 3);            // kit units, for normals
    const bones = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
    const acc = new Map();
    for (let v = 0; v < n; v++) {
        let x = fitOffset[v * 3] * sx, y = fitOffset[v * 3 + 1] * sy, z = fitOffset[v * 3 + 2] * sz;
        // A sculpt's skin under clothing lies down on the body beneath it (its scales and belly
        // would otherwise bulge through the armour); rigid parts — head, tail, claws — stay.
        // (`flatten`: a full suit of armour is on — all of the skin lies down, covered or not)
        if (tuck && (flatten || covered[fitVerts[v * 3]] || covered[fitVerts[v * 3 + 1]] || covered[fitVerts[v * 3 + 2]])
            && !(Math.abs(fitWeight[v * 3] - 1 / 3) < 1e-3 && Math.abs(fitWeight[v * 3 + 1] - 1 / 3) < 1e-3)) x = y = z = 0;
        acc.clear();
        for (let k = 0; k < 3; k++) {
            const b = fitVerts[v * 3 + k], w = fitWeight[v * 3 + k];
            if (!w) continue;
            x += morphed[b * 3] * w; y += morphed[b * 3 + 1] * w; z += morphed[b * 3 + 2] * w;
            for (let j = 0; j < 4; j++) {
                const bw = kit.skinWeight[b * 4 + j];
                if (bw) acc.set(kit.skinIndex[b * 4 + j], (acc.get(kit.skinIndex[b * 4 + j]) || 0) + bw * w);
            }
        }
        fitted[v * 3] = x; fitted[v * 3 + 1] = y; fitted[v * 3 + 2] = z;
        const top = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
        const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
        top.forEach(([bone, w], j) => { bones[v * 4 + j] = bone; weights[v * 4 + j] = w / sum; });
        if (!top.length) weights[v * 4] = 1;
    }

    const position = new Float32Array(src.length * 3);
    const skinIndex = new Uint16Array(src.length * 4), skinWeight = new Float32Array(src.length * 4);
    for (let r = 0; r < src.length; r++) {
        const v = src[r];
        position[r * 3] = (fitted[v * 3] - origin.x) * DM;
        position[r * 3 + 1] = (fitted[v * 3 + 1] - origin.y) * DM;
        position[r * 3 + 2] = (fitted[v * 3 + 2] - origin.z) * DM;
        skinIndex.set(bones.subarray(v * 4, v * 4 + 4), r * 4);
        skinWeight.set(weights.subarray(v * 4, v * 4 + 4), r * 4);
    }
    let faces = index;
    if (entry.slot === 'bodyform' && (covered || omit.length)) {
        const rigid = new Uint8Array(n), gone = new Uint8Array(n);
        for (let v = 0; v < n; v++) {
            const isRigid = Math.abs(fitWeight[v * 3] - 1 / 3) < 1e-3 && Math.abs(fitWeight[v * 3 + 1] - 1 / 3) < 1e-3;
            const a = fitVerts[v * 3], b = fitVerts[v * 3 + 1], c = fitVerts[v * 3 + 2];
            if (isRigid) {
                rigid[v] = 1;
                const bone = kit.bones[kit.skinIndex[a * 4]] || '';
                if (omit.some(prefix => bone.startsWith(prefix))) gone[v] = 1;
            } else if (covered && (flatten ? covered[a] || covered[b] || covered[c] : covered[a] && covered[b] && covered[c])) gone[v] = 1;
        }
        const kept = [];
        for (let i = 0; i < index.length; i += 3) {
            const a = src[index[i]], b = src[index[i + 1]], c = src[index[i + 2]];
            if (gone[a] && gone[b] && gone[c]) continue;
            kept.push(index[i], index[i + 1], index[i + 2]);
        }
        faces = new Uint32Array(kept);
    }
    const normal = sharedNormals(fitted, src, index, n);
    // A body form's tail hangs rigidly from one pelvis triangle. Mark how far along it each
    // vertex sits (0 at the root, 1 at the tip) so the renderer can make it sway.
    let sway = null;
    if (entry.slot === 'bodyform') {
        const groups = new Map();
        for (let v = 0; v < n; v++) {
            if (Math.abs(fitWeight[v * 3] - 1 / 3) > 1e-3 || Math.abs(fitWeight[v * 3 + 1] - 1 / 3) > 1e-3) continue;
            const key = fitVerts[v * 3] * 400000000 + fitVerts[v * 3 + 1] * 20000 + fitVerts[v * 3 + 2];
            let g = groups.get(key);
            if (!g) groups.set(key, g = { verts: [], back: Infinity, front: -Infinity });
            g.verts.push(v); g.back = Math.min(g.back, fitted[v * 3 + 2]); g.front = Math.max(g.front, fitted[v * 3 + 2]);
        }
        let tail = null; // the rigid part that reaches farthest behind the figure (front is +z)
        for (const g of groups.values()) if (g.verts.length > 500 && (!tail || g.back < tail.back)) tail = g;
        if (tail) {
            // Length along the tail = distance from its root, the tail vertex nearest the pelvis
            // triangle it hangs from (a cat tail hangs down, a dragon tail trails back).
            const t0 = tail.verts[0];
            let ax = 0, ay = 0, az = 0;
            for (let k = 0; k < 3; k++) { const b = fitVerts[t0 * 3 + k] * 3; ax += morphed[b] / 3; ay += morphed[b + 1] / 3; az += morphed[b + 2] / 3; }
            const d2 = (v, x, y, z) => (fitted[v * 3] - x) ** 2 + (fitted[v * 3 + 1] - y) ** 2 + (fitted[v * 3 + 2] - z) ** 2;
            let root = t0, best = Infinity;
            for (const v of tail.verts) { const d = d2(v, ax, ay, az); if (d < best) { best = d; root = v; } }
            const rx = fitted[root * 3], ry = fitted[root * 3 + 1], rz = fitted[root * 3 + 2];
            let reach = 0;
            for (const v of tail.verts) reach = Math.max(reach, d2(v, rx, ry, rz));
            reach = Math.sqrt(reach);
            if (reach > 3) {
                const along = new Float32Array(n);
                for (const v of tail.verts) along[v] = Math.sqrt(d2(v, rx, ry, rz)) / reach;
                sway = new Float32Array(src.length);
                for (let r = 0; r < src.length; r++) sway[r] = along[src[r]];
            }
        }
    }
    if (inflate) for (let i = 0; i < position.length; i++) position[i] += normal[i] * inflate * DM;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    if (sway) geometry.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
    geometry.setIndex(new THREE.BufferAttribute(faces, 1));
    geometry.computeBoundingSphere();
    return geometry;
}

export const kitUrl = (file) => KIT_URL + file;
