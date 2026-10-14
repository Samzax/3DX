// Standing on real ground. A token's position is one point and its model was
// posed for a flat floor, so on a slope a foot floats while another sinks. This
// settles each figure onto the terrain it actually covers — presentation only,
// nothing here feeds back into the position anyone reads or syncs:
//
//  - the body leans with the slope under its footprint (four-legged bodies
//    all the way, upright ones barely) and rides at the height of its lowest
//    foot;
//  - rigged legs are re-solved (two-bone IK that keeps the animation's bend
//    plane) so every foot lands on the ground under it — the uphill knees
//    bend — and the foot itself tips to the slope;
//  - a character walking to its token's new spot follows the ground between.
//
// Legs are found by bone name (foot / paw / hoof / ankle under two more leg
// bones), which covers the character rig and the pack monsters; a model with
// no such bones still gets the lean. Pages hand over the ground once with
// `configureGrounding` and call `tickGrounding(worldGroup.children)` each frame
// AFTER the animation ticks (the mixers pose the legs this corrects).

import * as THREE from 'three';

const RANGE = 220;             // world units from the view's focus; further figures are left alone
const SEATED = 0.3;            // soles this close to the terrain are standing on it
const MAX_LEAN = 0.6;          // radians
const UPRIGHT_LEAN = 0.15;     // how much of the slope a two-legged body takes
const BODY_RATE = 10, FOOT_RATE = 18; // smoothing, 1/s
const UPRIGHT_PLANS = new Set(['humanoid', 'ape', 'avian', 'construct', 'plant', 'elemental', 'aberrant', 'swarm']);
const FOOT_BONE = /foot|paw|hoof|ankle/i;
const HELPER_BONE = /(^|[^a-z])(ik|pole|ctrl|target|twist|end)([^a-z]|$)/i;

let probe = null;              // (wx, wz) => ground height, or null where there is no terrain to stand on
let focus = null;              // () => { x, z } the view looks at (true world coords)
const states = new WeakMap();  // token -> state
const clock = new THREE.Clock();

// probe(x, z): terrain height at a true world point, null when the figure
// should be left as posed (no terrain shown, hex lenses). focus(): optional.
export function configureGrounding(options = {}) {
    probe = typeof options.probe === 'function' ? options.probe : null;
    focus = typeof options.focus === 'function' ? options.focus : null;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _ac = new THREE.Vector3(), _ab = new THREE.Vector3(), _at = new THREE.Vector3(), _bc = new THREE.Vector3();
const _axis0 = new THREE.Vector3(), _axis1 = new THREE.Vector3(), _n = new THREE.Vector3(), _gn = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _r = new THREE.Quaternion(), _r2 = new THREE.Quaternion(), _align = new THREE.Quaternion(), _tq = new THREE.Quaternion();
const _box = new THREE.Box3(), _size = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const acos = (v) => Math.acos(clamp(v, -1, 1));

function findFeet(root) {
    const feet = [];
    root.traverse(bone => {
        if (!bone.isBone || !FOOT_BONE.test(bone.name) || HELPER_BONE.test(bone.name)) return;
        const mid = bone.parent, top = mid && mid.parent;
        if (!mid || !mid.isBone || !top || !top.isBone) return;
        // A toe named "foot_toe" under a foot: the foot above it already leads this leg.
        if (FOOT_BONE.test(mid.name) || FOOT_BONE.test(top.name)) return;
        feet.push({
            bones: [top, mid, bone], lift: 0, applied: false, align: new THREE.Quaternion(),
            pre: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
            post: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()]
        });
    });
    return feet;
}

// The object that leans: a monster's seated model holder, a character's
// walking figure. Null while only a placeholder (disc, loading body) shows.
function tiltObjectOf(token) {
    const data = token.userData;
    if (data.rigCharacter) return data.motion ? data.motion.node : null;
    if (data.monsterIndex) return token.children.find(child => child.name.startsWith('MonsterModel:')) || null;
    return null;
}

function setup(token, tilt) {
    const motion = token.userData.rigCharacter ? token.userData.motion : null;
    tilt.rotation.order = 'YXZ'; // lean in the figure's own frame, then its facing
    token.updateWorldMatrix(true, true);
    const feet = findFeet(tilt);
    const scale = token.scale.x || 1;
    let rx, rz;
    if (feet.length) {
        rx = rz = 0;
        for (const foot of feet) {
            tilt.worldToLocal(foot.bones[2].getWorldPosition(_c));
            rx = Math.max(rx, Math.abs(_c.x)); rz = Math.max(rz, Math.abs(_c.z));
        }
    } else {
        _box.setFromObject(tilt).getSize(_size);
        rx = rz = 0.35 * Math.max(_size.x, _size.z) / scale;
    }
    const upright = motion || (feet.length ? feet.length < 4 : UPRIGHT_PLANS.has(token.userData.monsterPlan));
    return {
        tilt, motion, feet,
        baseY: motion ? motion.base.y : tilt.position.y,
        rx: clamp(rx || 0, 0.2, 5), rz: clamp(rz || 0, 0.2, 5),
        lean: upright ? UPRIGHT_LEAN : 1,
        pitch: 0, roll: 0, settle: 0, last: token.position.clone(), fresh: true
    };
}

// Put a leg's pose back the way the animation left it, unless the mixer has
// already rewritten the bone this frame (it skips bones whose value held).
function restoreLeg(foot) {
    if (!foot.applied) return;
    for (let i = 0; i < 3; i++) {
        if (foot.bones[i].quaternion.equals(foot.post[i])) foot.bones[i].quaternion.copy(foot.pre[i]);
    }
    foot.applied = false;
}

// Rotate `bone` by the world-space rotation `q`.
function rotateWorld(bone, q) {
    bone.parent.getWorldQuaternion(_qp);
    bone.quaternion.premultiply(_qp).premultiply(q).premultiply(_qp.invert());
}

// Move the foot `lift` world units up (or down) by bending the two bones above
// it in the plane they already bend in; the foot keeps its world orientation,
// turned by `align`. Positions were read before any leg was touched.
function solveLeg(foot, lift, align, fallbackAxis) {
    const [top, mid, end] = foot.bones;
    top.getWorldPosition(_a); mid.getWorldPosition(_b); end.getWorldPosition(_c);
    const lab = _a.distanceTo(_b), lcb = _b.distanceTo(_c);
    if (lab < 1e-5 || lcb < 1e-5) return;
    for (let i = 0; i < 3; i++) foot.pre[i].copy(foot.bones[i].quaternion);
    _t.copy(_c); _t.y += lift;
    _ac.subVectors(_c, _a); _ab.subVectors(_b, _a); _at.subVectors(_t, _a); _bc.subVectors(_c, _b);
    const lat = clamp(_at.length(), Math.abs(lab - lcb) + 1e-4, lab + lcb - 1e-4);
    const acLen = _ac.length();
    if (acLen < 1e-5) return;
    // Interior angles now and wanted (law of cosines on the reach `lat`).
    const atA0 = acos(_ac.dot(_ab) / (acLen * lab));
    const atB0 = acos(-_ab.dot(_bc) / (lab * lcb));
    const atA1 = acos((lab * lab + lat * lat - lcb * lcb) / (2 * lab * lat));
    const atB1 = acos((lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb));
    _axis0.crossVectors(_ac, _ab);
    if (_axis0.lengthSq() < 1e-10) _axis0.crossVectors(_ac, fallbackAxis); // a dead-straight leg bends forward
    if (_axis0.lengthSq() < 1e-10) return;
    _axis0.normalize();
    mid.getWorldQuaternion(_qb);
    end.getWorldQuaternion(_qc);
    // Open or close the two joints, then swing the whole leg onto the target.
    _r.setFromAxisAngle(_axis0, atA1 - atA0);
    _axis1.crossVectors(_ac, _at);
    if (_axis1.lengthSq() > 1e-12) {
        _r2.setFromAxisAngle(_axis1.normalize(), acos(_ac.dot(_at) / (acLen * _at.length())));
        _r.premultiply(_r2);
    }
    rotateWorld(top, _r);
    _r.setFromAxisAngle(_axis0, atB1 - atB0);
    mid.quaternion.multiply(_qa.copy(_qb).invert().multiply(_r).multiply(_qb));
    top.updateWorldMatrix(false, true);
    mid.getWorldQuaternion(_qp);
    end.quaternion.copy(_qp.invert()).multiply(_tq.copy(align).multiply(_qc));
    for (let i = 0; i < 3; i++) foot.post[i].copy(foot.bones[i].quaternion);
    foot.applied = true;
}

function settle(token, state, dt) {
    const { tilt, motion, feet } = state;
    const parent = token.parent;
    const scale = token.scale.x || 1;
    const half = token.userData.halfHeight || 0;
    const soleY = token.position.y - half;
    for (const foot of feet) restoreLeg(foot);

    // Where the figure stands (a walking character trails its token).
    const yaw = token.rotation.y;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fx = token.position.x + (cy * tilt.position.x + sy * tilt.position.z) * scale;
    const fz = token.position.z + (-sy * tilt.position.x + cy * tilt.position.z) * scale;
    const facing = yaw + tilt.rotation.y;
    const zx = Math.sin(facing), zz = Math.cos(facing);   // the figure's local +Z in the world
    const xx = Math.cos(facing), xz = -Math.sin(facing);  // ... and its +X
    const rx = state.rx * scale, rz = state.rz * scale;

    const under = probe(token.position.x, token.position.z);
    let seated = under != null && Math.abs(soleY - under) <= SEATED;
    let front, back, right, left, centre;
    if (seated) {
        centre = probe(fx, fz);
        front = probe(fx + zx * rz, fz + zz * rz); back = probe(fx - zx * rz, fz - zz * rz);
        right = probe(fx + xx * rx, fz + xz * rx); left = probe(fx - xx * rx, fz - xz * rx);
        seated = [centre, front, back, right, left].every(h => h != null);
    }

    if (!token.position.equals(state.last)) {
        // The token jumped. A walking figure is still where it stood (its
        // ground has not moved); anything else lands already settled.
        if (!motion) state.fresh = true;
        state.last.copy(token.position);
    }
    const kBody = state.fresh ? 1 : 1 - Math.exp(-dt * BODY_RATE);
    const kFoot = state.fresh ? 1 : 1 - Math.exp(-dt * FOOT_RATE);
    state.fresh = false;

    // The figure's height is the ground right under it (exact every frame, so
    // a walk never lags the hill) plus a smoothed settling onto its footprint.
    let slopeZ = 0, slopeX = 0, under0 = 0, settleTarget = 0;
    if (seated) {
        slopeZ = (front - back) / (2 * rz); slopeX = (right - left) / (2 * rx);
        under0 = centre - soleY;
        // Without legs to solve, the body rides the fitted plane.
        settleTarget = state.lean * ((front + back + right + left) / 4 - centre);
    }
    const drop = under0 + state.settle;
    const pitchTarget = clamp(-Math.atan(slopeZ) * state.lean, -MAX_LEAN, MAX_LEAN);
    const rollTarget = clamp(Math.atan(slopeX) * state.lean, -MAX_LEAN, MAX_LEAN);
    state.pitch += (pitchTarget - state.pitch) * kBody;
    state.roll += (rollTarget - state.roll) * kBody;
    tilt.rotation.x = state.pitch;
    tilt.rotation.z = state.roll;
    // Off the terrain (a floor, a flight) a walking character keeps the plain
    // glide between heights that charmesh gives it.
    const glideY = motion && !seated ? motion.offset.y : 0;
    tilt.position.y = state.baseY + glideY + drop / scale;

    if (feet.length) {
        tilt.updateWorldMatrix(true, true);
        // The floor the animation was posed on, leaning with the body.
        _n.copy(UP).applyQuaternion(tilt.getWorldQuaternion(_qa));
        const planeY = soleY + drop;
        const reach = feet[0].bones[0].getWorldPosition(_a).distanceTo(feet[0].bones[2].getWorldPosition(_c));
        const e = Math.max(0.08, reach * 0.12); // half a foot's length
        let low = Infinity, high = -Infinity;
        for (const foot of feet) {
            foot.want = 0;
            _align.copy(IDENTITY);
            parent.worldToLocal(foot.bones[2].getWorldPosition(_c));
            const ground = seated ? probe(_c.x, _c.z) : null;
            if (ground != null) {
                const floor = planeY - (_n.x * (_c.x - fx) + _n.z * (_c.z - fz)) / Math.max(0.2, _n.y);
                foot.want = ground - floor;
                low = Math.min(low, foot.want); high = Math.max(high, foot.want);
                // The foot tips from the body's floor to the ground right under it.
                const east = probe(_c.x + e, _c.z), west = probe(_c.x - e, _c.z);
                const south = probe(_c.x, _c.z + e), north = probe(_c.x, _c.z - e);
                if (east != null && west != null && south != null && north != null) {
                    _gn.set((west - east) / (2 * e), 1, (north - south) / (2 * e)).normalize();
                    _align.setFromUnitVectors(_n, _gn);
                    const angle = 2 * acos(_align.w);
                    if (angle > 0.7) _align.slerp(IDENTITY, 1 - 0.7 / angle);
                }
            }
            foot.align.slerp(_align, kFoot);
        }
        // Ride at the lowest foot — unless that would fold the highest leg past half its length.
        if (low !== Infinity) settleTarget = state.settle + Math.max(low, high - reach * 0.5);
        const fallback = _gn.set(zx, 0, zz); // forward: only read by a dead-straight leg
        for (const foot of feet) {
            foot.lift += (clamp(foot.want, -reach * 0.15, reach * 0.5) - foot.lift) * kFoot;
            if (Math.abs(foot.lift) > 0.002 || Math.abs(foot.align.w) < 0.99999) solveLeg(foot, foot.lift, foot.align, fallback);
        }
    }
    state.settle += (settleTarget - state.settle) * kBody;
}

// Once per frame, after tickRigCharacters / tickMonsterAnimations. `tokens` is
// the page's object container (worldGroup.children); `dt` is for manual loops.
export function tickGrounding(tokens, dt) {
    const delta = Math.min(0.1, Number.isFinite(dt) ? dt : clock.getDelta());
    if (!probe || !tokens) return;
    const at = focus ? focus() : null;
    for (const token of tokens) {
        const data = token.userData;
        if (!data || !(data.rigCharacter || data.monsterIndex) || !token.visible || !token.parent) continue;
        if (data.airborne) continue; // hovering (monster-anim.js): nothing to stand on
        if (data.pose) continue;     // lying or sitting on furniture (charmesh.js)
        if (at && (token.position.x - at.x) ** 2 + (token.position.z - at.z) ** 2 > RANGE * RANGE) continue;
        const tilt = tiltObjectOf(token);
        if (!tilt) continue;
        let state = states.get(token);
        if (!state || state.tilt !== tilt) states.set(token, state = setup(token, tilt));
        settle(token, state, delta);
    }
}
