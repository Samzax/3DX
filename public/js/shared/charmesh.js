// charmesh.js — rigged, animated player characters.
//
// A character is built from its saved appearance, one of two ways:
//   * the parametric body (mhbody.js + the kit under /assets/characters/mh/,
//     MakeHuman CC0 data): a morphed body, a skin, and worn meshes — hair,
//     beard, clothes, boots, helm, the weapon in hand — each re-fitted to that
//     body. The animation rig is rebuilt around the body's joints, so the
//     Universal Animation Library clips (Quaternius, CC0) play on any shape.
//   * a "look": a whole authored/generated GLB from a model pack
//     (lib/character-packs.cjs → /assets/characters/manifest.json). A look
//     replaces the body wholesale; it animates with its own clips when the
//     pack maps them, and stands as a static miniature otherwise.
//
// createRigCharacter returns a group immediately and fills it in when the
// assets arrive, so callers stay synchronous.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
    loadCharacterKit, morphBase, fitJoints, fitSkeleton, bodyGeometry, assetGeometry, hiddenVertices, kitUrl
} from './mhbody.js';

export { loadCharacterKit };

const ASSET_BASE = '/assets/characters/';
// Grid units (1u = 5ft) per metre of body: an average adult stands ~1.15u.
const UNITS_PER_METRE = 1.15 / 1.75;

// --- Appearance vocabulary (mirrored by server.js sanitizeCharacterAppearance)
export const BODY_TYPES = ['male', 'female'];
export const TRAITS = ['pointed-ears', 'horns', 'tusks', 'snout', 'tail'];
// Shape sliders stored in appearance.form (0..1 each; 0.5 = average, age 0 = young adult).
export const FORM_KEYS = ['age', 'muscle', 'weight', 'stature'];
// One worn asset per slot (appearance.wear); '' = deliberately nothing.
export const WEAR_SLOTS = ['bodyform', 'headform', 'hair', 'beard', 'eyebrows', 'horns', 'outfit', 'top', 'bottom', 'feet', 'hands', 'head'];
export const EYE_COLORS = ['brown', 'brownlight', 'green', 'bluegreen', 'blue', 'lightblue', 'deepblue', 'grey', 'ice'];

// What a race looks like when the sheet doesn't say (older saves, tokens
// placed before traits were stored). Homebrew slugs match nothing.
export function raceTraits(race) {
    const r = String(race || '').toLowerCase();
    if (r.includes('dragonborn')) return ['snout', 'tail'];
    if (r.includes('tiefling')) return ['horns', 'tail'];
    if (r.includes('orc')) return ['tusks'];
    if (/(^|-)elf/.test(r) || r.includes('gnome')) return ['pointed-ears'];
    return [];
}

// Body defaults per race: the creator stores these on the sheet when a race is
// picked, and sheets saved before the parametric body fall back to them here.
export const RACE_FORMS = {
    dwarf: { stature: 0.1, muscle: 0.75, weight: 0.68, details: { 'head-scale-horiz': 0.3, 'torso-scale-horiz': 0.4, 'nose-scale-horiz': 0.5 } },
    halfling: { stature: 0.3, weight: 0.55, size: 0.62, details: { 'head-scale-vert': 0.25, 'head-scale-horiz': 0.3, 'head-round': 0.5 } },
    gnome: { stature: 0.25, weight: 0.4, size: 0.62, details: { 'head-scale-vert': 0.4, 'head-scale-horiz': 0.4, 'nose-scale-vert': 0.5, 'ear-scale': 0.5 } },
    elf: { stature: 0.62, weight: 0.3, muscle: 0.4, details: { 'head-oval': 0.5, 'ear-scale-vert': 0.6 } },
    'half-elf': { stature: 0.55, weight: 0.4, details: { 'ear-scale-vert': 0.25 } },
    'half-orc': { stature: 0.7, muscle: 0.9, weight: 0.65, details: { 'head-square': 0.6, 'torso-vshape': 0.5, 'nose-scale-horiz': 0.5 } },
    dragonborn: {}, // the body form (a full sculpt) carries the build; sliders start neutral
    tiefling: { stature: 0.55, weight: 0.42, details: { 'head-invertedtriangular': 0.4 } },
    human: {}
};
export function raceForm(race) {
    const r = String(race || '').toLowerCase();
    if (RACE_FORMS[r]) return RACE_FORMS[r];
    // Subraces and compounds: "hill-dwarf", "high-elf"… (longest key first so half-elf beats elf).
    const key = Object.keys(RACE_FORMS).sort((a, b) => b.length - a.length).find(k => r.includes(k));
    return key ? RACE_FORMS[key] : RACE_FORMS.human;
}

// Roles a caller can play without knowing clip names (creator preview buttons).
export const CHARACTER_ROLES = ['idle', 'walk', 'attack', 'cast', 'hit', 'death', 'talk'];
const BASE_ROLE_CLIPS = {
    idle: 'Idle_Loop', walk: 'Walk_Loop', attack: 'Sword_Attack', cast: 'Spell_Simple_Shoot',
    hit: 'Hit_Chest', death: 'Death01', talk: 'Idle_Talking_Loop',
    jog: 'Jog_Fwd_Loop', punch: 'Punch_Cross', shoot: 'Spell_Simple_Shoot', sit: 'Sitting_Idle_Loop'
};
const LOOPING_ROLES = new Set(['idle', 'walk', 'talk', 'jog', 'sit', 'carry_idle', 'carry_walk']);
const ROLE_FALLBACKS = { jog: 'walk', punch: 'attack', shoot: 'cast', cast: 'attack', heavy: 'attack' };

// A combat action's name → the role that shows it: weapons swing, bows and thrown things loose,
// bare hands punch, and whatever is left (spells, class abilities) is cast.
const SWUNG = /sword|axe|mace|hammer|dagger|spear|staff|club|rapier|scimitar|flail|pike|halberd|glaive|maul|whip|trident|lance|sickle|morningstar|pick|blade|strike|smite|attack/i;
const LOOSED = /bow|sling|dart|javelin|blowgun|net|thrown/i;
function actionRole(charData, actionName) {
    const name = String(actionName || '');
    if (/unarmed|punch|fist|kick|martial/i.test(name)) return 'punch';
    if (LOOSED.test(name)) return 'shoot';
    if (SWUNG.test(name)) return 'attack';
    const weapons = (charData && charData.equipment && charData.equipment.weapons) || [];
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return weapons.some(w => String(w).toLowerCase() === key) ? 'attack' : 'cast';
}

// The tabletop renders linear-out with every color authored for that (like the
// monster GLBs, its textures are sampled raw); the creator preview is a
// gamma-out PBR viewport and says so before its first character is built.
let _gammaOut = false;
export function configureCharacterRendering({ gammaOut = false } = {}) { _gammaOut = !!gammaOut; }
function rawTextures(root) {
    if (_gammaOut) return;
    root.traverse(o => {
        for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
            for (const key of ['map', 'emissiveMap']) {
                if (m[key] && m[key].encoding !== THREE.LinearEncoding) { m[key].encoding = THREE.LinearEncoding; m[key].needsUpdate = true; }
            }
        }
    });
}
// Colors are authored as sRGB hex and must sit in the same space as the
// textures they tint: decoded to linear in a gamma-out viewport, left as
// written on the linear-out tabletop.
const lin = (hex, fallback) => {
    const c = new THREE.Color(fallback);
    try { c.set(hex || fallback); } catch (_) { /* keep fallback */ }
    return _gammaOut ? c.convertSRGBToLinear() : c;
};

// --- Animation library ------------------------------------------------------
// One GLB: the clips plus the rig they were authored on (its bone names and
// local frames are what fitSkeleton rebuilds around each body).
let _animPromise = null;
export function loadCharacterAssets() {
    if (_animPromise) return _animPromise;
    _animPromise = new Promise((res, rej) => new GLTFLoader().load(ASSET_BASE + 'UAL1_Standard.glb', res, undefined, rej))
        .then(gltf => {
            const rig = gltf.scene;
            const meshes = [];
            rig.traverse(o => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
            meshes.forEach(o => o.parent.remove(o)); // the library's mannequin
            // The library keys every bone's position and scale (constants from
            // its own mannequin), which would undo each body's fitted joints.
            // Only the pelvis really travels; it is re-scaled per character.
            for (const clip of gltf.animations) {
                clip.tracks = clip.tracks.filter(t => t.name.endsWith('.quaternion') || t.name === 'pelvis.position');
            }
            return { rig, clips: gltf.animations };
        });
    return _animPromise;
}

// --- Looks (model packs) ----------------------------------------------------
// { "<pack>/<id>": { name, pack, url, height, races?, body?, clips?, animUrl? } }
let _looks = {};
let _props = {};
let _looksPromise = null;
export function loadCharacterLooks() {
    if (_looksPromise) return _looksPromise;
    _looksPromise = (typeof fetch === 'function'
        ? fetch(ASSET_BASE + 'manifest.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(null)
    ).then(json => {
        _looks = (json && json.looks && typeof json.looks === 'object') ? json.looks : {};
        _props = (json && json.props && typeof json.props === 'object') ? json.props : {};
        return _looks;
    });
    return _looksPromise;
}
export function characterLooks() { return _looks; }
// The pack prop (a thing held in the hand) the sheet's first equipped weapon calls for, if any.
function heldProp(charData) {
    const eq = (charData && charData.equipment) || {};
    const weapon = Array.isArray(eq.weapons) && eq.weapons[0] ? String(eq.weapons[0]).toLowerCase() : '';
    return (weapon && Object.values(_props).find(prop => Array.isArray(prop.items) && prop.items.includes(weapon))) || null;
}

const _lookFiles = new Map(); // url -> Promise<gltf>
function loadLookFile(url) {
    if (!_lookFiles.has(url)) {
        _lookFiles.set(url, new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej))
            .then(gltf => { rawTextures(gltf.scene); return gltf; }));
    }
    return _lookFiles.get(url);
}

// Live mixers, ticked once per frame from each page's render loop.
const _mixers = new Set();
const _clock = new THREE.Clock();
// Carriage: the clips were authored for a slim mannequin whose arms hang against the ribs. A
// broad sculpt needs them held out, so after the clip is applied each upper arm is swung
// outward about the figure's front axis by the body form's `armSpread`.
const _carriages = new Set(); // { root, left, right, angle }
const _front = new THREE.Vector3(), _parentQ = new THREE.Quaternion(), _swing = new THREE.Quaternion(), _rootQ = new THREE.Quaternion();
function applyCarriage(c) {
    c.root.getWorldQuaternion(_rootQ);
    _front.set(0, 0, 1).applyQuaternion(_rootQ);
    for (const [bone, sign] of [[c.left, 1], [c.right, -1]]) {
        bone.parent.updateWorldMatrix(true, false);
        bone.parent.getWorldQuaternion(_parentQ);
        _swing.setFromAxisAngle(_front, sign * c.angle);
        // world-space swing expressed in the parent's frame: P⁻¹ · S · P · q
        bone.quaternion.premultiply(_parentQ).premultiply(_swing).premultiply(_parentQ.invert());
    }
}
// Tabletop motion: a token's position is game state and jumps when it is moved. The figure inside
// catches up on foot instead — it starts where the token was, faces the way it is going and walks
// (or jogs) to the new spot. Nothing here feeds back into the position anyone reads or syncs.
const WALK_SPEED = 1.5 * UNITS_PER_METRE; // units / second, what Walk_Loop was authored at
const GLIDE_TIME = 1.1;                   // a long move still arrives within about this long
const GLIDE_MAX = 40;                     // further than this is a teleport, not a walk
const _motions = new Set();
const _delta = new THREE.Vector3(), _groupQ = new THREE.Quaternion();
function installMotion(group, node) {
    const motion = { group, node, base: node.position.clone(), offset: new THREE.Vector3(), last: null, rate: 0, gait: null, hover: 0, hoverH: 0 };
    group.userData.motion = motion;
    _motions.add(motion);
    // Turn the figure toward a world-space point (an attacker faces its target).
    group.userData.faceToward = (point) => {
        const local = group.worldToLocal(_delta.copy(point));
        if (local.x * local.x + local.z * local.z > 1e-4) node.rotation.y = Math.atan2(local.x, local.z);
    };
}
function attachFigure(group, inner) {
    const lift = new THREE.Group();
    lift.add(inner);
    group.add(lift);
    group.userData.lift = lift;
}
// Furniture poses (`userData.pose`, set by the pages from the synced record: the server's
// `use-prop`). The token sits on the prop's cell; the figure walks there like any move, then lies
// along the cot or sits on the seat. Presentation only, like the walk itself.
const SEAT_LIFT = { bench: 0.06, throne: 0.3 };
const BED_TOP = 0.42;                     // a cot's blanket above its floor
const _poseBox = new THREE.Box3();
function applyPose(m, pose) {
    const key = pose ? `${pose.kind}|${pose.propKind}|${pose.rot}` : '';
    if (m.posed === key) return;
    const play = m.group.userData.playRole;
    const yaw = pose ? -(Number(pose.rot) || 0) * Math.PI / 2 : m.node.rotation.y;
    m.node.rotation.order = 'YXZ';
    if (!pose) {
        m.node.rotation.set(0, yaw, 0);
        m.node.position.copy(m.base);
        if (m.posed && play) play('idle');
    } else if (pose.kind === 'lying') {
        if (!m.height) {
            m.node.rotation.set(0, 0, 0);
            m.node.updateWorldMatrix(true, true);
            _poseBox.setFromObject(m.node);
            m.height = Math.max(0.6, Math.min(2.4, _poseBox.max.y - _poseBox.min.y)) || 1.15;
        }
        // On its back, head toward the cot's pillow (the prop's -Z), centred on the cell.
        m.node.rotation.set(-Math.PI / 2, yaw, 0);
        m.node.position.set(m.base.x + Math.sin(yaw) * m.height / 2, m.base.y + BED_TOP + 0.1, m.base.z + Math.cos(yaw) * m.height / 2);
        if (play) play('idle');
    } else {
        m.node.rotation.set(0, yaw, 0);
        m.node.position.set(m.base.x, m.base.y + (SEAT_LIFT[pose.propKind] || 0.06), m.base.z);
        if (play) play('sit');
    }
    m.posed = key;
}
function tickMotion(m, dt) {
    const p = m.group.position;
    if (!m.last) { m.last = p.clone(); return; }
    if (p.distanceToSquared(m.last) > 1e-8) {
        _delta.subVectors(m.last, p);
        m.last.copy(p);
        if (!m.group.parent || _delta.length() > GLIDE_MAX) m.offset.set(0, 0, 0);
        else {
            m.offset.add(_delta.applyQuaternion(_groupQ.copy(m.group.quaternion).invert()).divide(m.group.scale));
            if (m.offset.x * m.offset.x + m.offset.z * m.offset.z > 1e-4) m.node.rotation.y = Math.atan2(-m.offset.x, -m.offset.z);
            m.rate = Math.max(WALK_SPEED, m.offset.length() / GLIDE_TIME);
        }
    }
    const left = m.offset.length();
    if (!left) {
        if (m.gait) { m.gait = null; m.node.position.copy(m.base); if (m.group.userData.playRole) m.group.userData.playRole('idle'); }
        applyPose(m, m.group.userData.pose || null);
        return;
    }
    if (m.posed) applyPose(m, null);   // getting up to walk
    const gait = m.rate > WALK_SPEED * 2.2 ? 'jog' : 'walk';
    if (m.gait !== gait && m.group.userData.playRole) {
        const action = m.group.userData.playRole(gait);
        if (action) action.timeScale = Math.min(1.6, Math.max(0.8, m.rate / (WALK_SPEED * (gait === 'jog' ? 2.6 : 1))));
        m.gait = gait;
    }
    const step = m.rate * dt;
    if (step >= left) m.offset.set(0, 0, 0); else m.offset.multiplyScalar(1 - step / left);
    m.node.position.copy(m.base).add(m.offset);
}

// Neck hold: the clips carry the head like a human's, upright over the shoulders. A sculpt whose
// head hangs low and forward (a big cat's) would be straightened by them and tear at the neck, so
// its neck and head are pulled most of the way back to the pose they were sculpted in.
const _neckHolds = new Set(); // { bones: [{ bone, rest }], hold }
const HOVER_HEIGHT = 0.55;
const _flying = new Set();
let _airborne = new Set();

export function syncCharacterStances(combat, airborneIds) {
    _flying.clear();
    _airborne = airborneIds || new Set();
    const combatants = combat && combat.combatants && typeof combat.combatants === 'object' ? combat.combatants : {};
    for (const combatant of Object.values(combatants)) {
        const effects = combatant && Array.isArray(combatant.effects) ? combatant.effects : [];
        if (effects.some(effect => effect && effect.key === 'flying')) _flying.add(combatant.id);
    }
}

function hoverHeight(m) {
    if (!m.hoverH) {
        m.node.updateWorldMatrix(true, true);
        _poseBox.setFromObject(m.node);
        m.hoverH = Math.max(0.6, Math.min(2.4, _poseBox.max.y - _poseBox.min.y)) || 1.15;
    }
    return m.hoverH * HOVER_HEIGHT;
}

function tickHover(m, dt) {
    const lift = m.group.userData.lift;
    if (!lift) return;
    const id = m.group.userData.syncId;
    const target = (_flying.has(id) || _airborne.has(id)) ? hoverHeight(m) : 0;
    const rise = target - m.hover;
    m.hover = Math.abs(rise) > 1e-3 ? m.hover + rise * Math.min(1, dt * 2.5) : target;
    lift.position.y = m.hover;
    m.group.userData.airborne = m.hover > 0.02;
}

export function tickRigCharacters() {
    const dt = Math.min(0.1, _clock.getDelta());
    for (const m of _motions) { tickMotion(m, dt); tickHover(m, dt); }
    for (const m of _mixers) m.update(dt);
    for (const h of _neckHolds) for (const { bone, rest } of h.bones) bone.quaternion.slerp(rest, h.hold);
    for (const c of _carriages) applyCarriage(c);
    _swayTime.value += dt;
}

// --- Textures ---------------------------------------------------------------
// Shared per URL. `tone` is the texture's average color (sRGB, opaque pixels),
// measured once so a tint can be expressed as "make this hair THAT color"
// instead of a multiply that can only darken.
const _textures = new Map(); // url -> Promise<{ texture, tone }>
function loadTexture(url, { color = true } = {}) {
    if (!_textures.has(url)) {
        _textures.set(url, new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej)).then(texture => {
            texture.encoding = color && _gammaOut ? THREE.sRGBEncoding : THREE.LinearEncoding;
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
            texture.anisotropy = 4;
            return { texture, tone: color ? measureTone(texture.image) : null };
        }));
    }
    return _textures.get(url);
}
function measureTone(image) {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        return n ? new THREE.Color(r / n / 255, g / n / 255, b / n / 255) : null;
    } catch (_) {
        return null; // no canvas (tests): tints fall back to a plain multiply
    }
}
// material.color that brings a texture of average `tone` to `hex`.
function tintToward(hex, tone, fallback) {
    const want = lin(hex, fallback);
    if (!tone) return want;
    const have = _gammaOut ? tone.clone().convertSRGBToLinear() : tone;
    const gain = (w, h) => Math.min(4, w / Math.max(h, 0.02));
    return new THREE.Color(gain(want.r, have.r), gain(want.g, have.g), gain(want.b, have.b));
}

// A painted sculpt (scales with a paler belly) can't be tinted by a multiply without washing
// out, so its ancestry color is a recolor: rotate the hue of the whole texture to the sheet
// color's, and nudge saturation and brightness toward it.
function hsv(c) {
    const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), d = max - min;
    let h = 0;
    if (d > 1e-5) {
        if (max === c.r) h = ((c.g - c.b) / d) % 6; else if (max === c.g) h = (c.b - c.r) / d + 2; else h = (c.r - c.g) / d + 4;
    }
    return { h: h * Math.PI / 3, s: max > 1e-5 ? d / max : 0, v: max };
}
// One shader hook for a sculpted body: the recolor above, and a slow sway of the tail (vertices
// carry how far along the tail they sit in a `sway` attribute, see mhbody.js).
const _swayTime = { value: 0 };
function formShader(material, hex, tone, hasTail) {
    const shift = new THREE.Vector3(0, 1, 1);
    if (hex && tone) {
        try {
            const want = hsv(new THREE.Color(hex)), have = hsv(tone);
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
            shift.set(
                want.s < 0.08 ? 0 : want.h - have.h,                   // greys keep the hue and just desaturate
                clamp(want.s / Math.max(have.s, 0.05), 0, 1.8),
                clamp(want.v / Math.max(have.v, 0.05), 0.55, 1.7));
        } catch (_) { /* not a color: leave the sculpt as painted */ }
    }
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uRecolor = { value: shift };
        shader.uniforms.uSwayTime = _swayTime;
        if (hasTail) {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute float sway;\nuniform float uSwayTime;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += sin(uSwayTime * 1.5 - sway * 2.4) * sway * sway * 0.11;');
        }
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uRecolor;')
            .replace('#include <map_fragment>', `#include <map_fragment>
{
    vec3 c = diffuseColor.rgb; const vec3 k = vec3(0.57735);
    float ca = cos(uRecolor.x), sa = sin(uRecolor.x);
    c = c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = max(mix(vec3(l), c, uRecolor.y) * uRecolor.z, 0.0);
}`);
    };
    material.customProgramCacheKey = () => (hasTail ? 'char-form-tail' : 'char-form');
}

// --- Appearance → what to build ----------------------------------------------
const LEGACY_HAIR = { short: 'hair-short', long: 'hair-long', tied: 'hair-ponytail', mohawk: 'hair-messy', bald: '' };
const LEGACY_BEARD = { none: '', short: 'beard-scruffy', long: 'beard-viking' };
const num = (v, fallback) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : fallback);

// The armour on the sheet → the set that shows it (kit assets carry `armor: <set>`).
function armorSet(charData) {
    const armor = String((charData.equipment && charData.equipment.armor) || '');
    if (!armor) return null;
    if (/plate|splint/.test(armor) && !/breastplate|half/.test(armor)) return 'plate';
    if (/chain|scale|ring|breastplate|half-plate/.test(armor)) return 'mail';
    if (/leather|hide|padded/.test(armor)) return 'leather';
    return null;
}

function weaponAsset(charData) {
    const eq = charData.equipment || {};
    const weapon = (Array.isArray(eq.weapons) && eq.weapons[0]) ? String(eq.weapons[0]) : '';
    if (!weapon) return null;
    if (/bow/.test(weapon) && !/crossbow/.test(weapon)) return 'bow';
    if (/dagger|sickle|dart|shortsword/.test(weapon)) return 'dagger';
    if (/hammer|maul|mace|club|flail|morningstar|axe/.test(weapon)) return 'hammer';
    if (/staff|wand|rod/.test(weapon)) return 'sceptre';
    if (/crossbow|sling|blowgun|net|whip/.test(weapon)) return null;
    return 'sword';
}

// The full build recipe for a sheet: shape, skin, tints and the worn assets.
// Everything optional on the sheet falls back to the race and the older fields.
export function resolveCharacter(charData, kit) {
    const ap = charData.appearance || {};
    const colors = ap.colors || {};
    const race = raceForm(charData.race);
    const form = ap.form && typeof ap.form === 'object' ? ap.form : {};
    const female = ap.body === 'female';
    const legacyBuild = num(ap.build, 1) - 1; // older sheets: one "build" slider
    const pick = (key, fallback) => Math.max(0, Math.min(1, num(form[key], num(race[key], fallback))));
    const shape = {
        gender: female ? 0 : 1,
        age: pick('age', 0),
        muscle: pick('muscle', 0.5 + legacyBuild * 0.6),
        weight: pick('weight', 0.5 + legacyBuild * 0.5),
        height: pick('stature', 0.5),
        details: { ...(ap.details && typeof ap.details === 'object' ? ap.details : (race.details || {})) }
    };
    const traits = Array.isArray(ap.traits) ? ap.traits.filter(t => TRAITS.includes(t)) : raceTraits(charData.race);
    if (traits.includes('pointed-ears') && !('ear-shape-pointed' in shape.details)) shape.details['ear-shape-pointed'] = 1;

    const stored = ap.wear && typeof ap.wear === 'object' ? ap.wear : {};
    const robed = ap.outfit === 'robe';
    const defaults = {
        bodyform: traits.includes('snout') ? 'dragonborn-a' : /tabaxi|catfolk|leonin/.test(String(charData.race || '').toLowerCase()) ? 'tabaxi-cheetah' : '',
        headform: '',
        hair: traits.includes('snout') ? '' : (LEGACY_HAIR[ap.hair] ?? (female ? 'hair-long' : 'hair-short')),
        beard: LEGACY_BEARD[ap.beard] ?? '',
        eyebrows: 'brows-soft',
        horns: traits.includes('horns') ? 'horns-curled' : '',
        outfit: robed ? 'robe' : '',
        top: robed || ap.outfit === 'bare' ? '' : 'tunic',
        bottom: robed ? '' : 'trousers',
        feet: 'boots', hands: '', head: ''
    };
    const wear = {};
    for (const slot of WEAR_SLOTS) {
        const id = typeof stored[slot] === 'string' ? stored[slot] : defaults[slot];
        if (id && kit.assets[id] && kit.assets[id].slot === slot) wear[slot] = id;
    }
    // Equipped armour is worn over whatever the wardrobe says (appearance.showArmor === false keeps
    // the wardrobe): the set's body piece, plus its gauntlets and boots. Its helm stays a choice.
    const set = ap.showArmor === false ? null : armorSet(charData);
    if (set) {
        for (const [id, asset] of Object.entries(kit.assets)) {
            if (asset.armor === set && asset.slot !== 'head') wear[asset.slot] = id;
        }
    }
    // A full outfit replaces the pieces it covers; a head form replaces what grows on a human head.
    const formKeeps = new Set(['feet', 'hands']); // on a body form these replace the sculpt's own
    for (const id of Object.values(wear)) {
        for (const slot of kit.assets[id].covers || []) {
            const piece = wear[slot] && kit.assets[wear[slot]];
            // (open-fingered gloves would show the sculpted wearer's human fingers on a clawed hand)
            if (kit.assets[id].slot === 'bodyform' && formKeeps.has(slot) && piece && piece.armor && !piece.bareSkin) continue;
            delete wear[slot];
        }
    }
    // A body form brings the morph that gives the kit body its bulk.
    // (a sheet may instead store a mix of form morphs: this type's scales on a build blended
    // toward another type's)
    const formTarget = wear.bodyform && kit.assets[wear.bodyform].target;
    const mixed = Object.keys(shape.details).some(id => kit.sliders[id] && kit.sliders[id].group === 'form');
    if (formTarget && !mixed) shape.details[formTarget] = 1;
    if (!wear.bodyform) for (const id of Object.keys(shape.details)) if (kit.sliders[id] && kit.sliders[id].group === 'form') delete shape.details[id];

    const old = shape.age > 0.6;
    const skinDefault = `${old ? 'old' : 'young'}-light-${female ? 'female' : 'male'}`;
    return {
        shape, traits, wear,
        skin: kit.skins[ap.skin] ? ap.skin : skinDefault,
        eyeColor: EYE_COLORS.includes(ap.eyeColor) ? ap.eyeColor : 'brown',
        weapon: heldProp(charData) ? null : weaponAsset(charData),
        shield: !!(charData.equipment && charData.equipment.shield),
        size: num(ap.height, 1) * num(race.size, 1),
        colors
    };
}

const CLOTH_SLOTS = new Set(['outfit', 'top', 'bottom']);
// Which sheet color dyes which slot (others keep their authored colors).
// (body and head forms keep their authored colors: a multiply tint washes a painted sculpt out)
const SLOT_TINT = { hair: 'hair', beard: 'hair', eyebrows: 'hair', outfit: 'torso', top: 'torso', bottom: 'legs' };
const TINT_FALLBACK = { hair: '#3b2716', torso: '#2f6e56', legs: '#3a3f4a', skin: '#c68642' };

// Metal needs something to reflect, and neither viewport has an environment. A tiny sky — pale
// overhead, a bright horizon band, dark ground — is enough for steel to read as steel.
let _metalSky = null;
function metalSky() {
    if (_metalSky) return _metalSky;
    const face = (paint) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        paint(canvas.getContext('2d'));
        return canvas;
    };
    const flat = (v) => face(ctx => { ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(0, 0, 32, 32); });
    const side = face(ctx => {
        const g = ctx.createLinearGradient(0, 0, 0, 32);
        g.addColorStop(0, 'rgb(200,208,220)'); g.addColorStop(0.42, 'rgb(250,246,236)'); g.addColorStop(0.56, 'rgb(120,112,104)'); g.addColorStop(1, 'rgb(40,38,36)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
    });
    _metalSky = new THREE.CubeTexture([side, side, flat(205), flat(34), side, side]);
    _metalSky.encoding = _gammaOut ? THREE.sRGBEncoding : THREE.LinearEncoding;
    _metalSky.needsUpdate = true;
    return _metalSky;
}

async function assetMaterial(kit, id, recipe, owned) {
    const entry = kit.assets[id];
    const spec = entry.materials ? (entry.materials[recipe.eyeColor] || Object.values(entry.materials)[0]) : (entry.material || {});
    const dir = `assets/${id}/`;
    const [map, normal, orm] = await Promise.all([
        spec.map ? loadTexture(kitUrl(dir + spec.map)) : null,
        spec.normalMap ? loadTexture(kitUrl(dir + spec.normalMap), { color: false }) : null,
        spec.ormMap ? loadTexture(kitUrl(dir + spec.ormMap), { color: false }) : null
    ]);
    const material = new THREE.MeshStandardMaterial({
        map: map ? map.texture : null, normalMap: normal ? normal.texture : null,
        roughness: entry.slot === 'weapon' || /^helm/.test(id) ? 0.45 : 0.85, metalness: 0,
        skinning: true, side: spec.doubleSided || spec.alpha ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: spec.alpha ? 0.4 : 0
    });
    if (entry.slot === 'bodyform' || entry.slot === 'headform') material.userData.form = { hex: recipe.colors.skin, tone: map && map.tone };
    const tintKey = SLOT_TINT[entry.slot];
    if (tintKey && !entry.noTint) material.color.copy(tintToward(recipe.colors[tintKey], map && map.tone, TINT_FALLBACK[tintKey]));
    if (orm) { // generated armour: per-texel roughness (G) and metal (B), reflecting the stand-in sky
        material.roughnessMap = material.metalnessMap = orm.texture;
        material.roughness = material.metalness = 1;
        material.envMap = metalSky();
        material.envMapIntensity = _gammaOut ? 1.1 : 1.5;
    }
    if (entry.gain) material.color.multiplyScalar(entry.gain);
    owned.materials.push(material);
    return material;
}

// --- Rigid extras -------------------------------------------------------------
// Pieces without a kit asset yet are modelled here in bind-pose model space
// (metres) and handed to the bone that carries them.
function addRigid(bone, owned, geometry, material, matrix) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.applyMatrix4(matrix);
    bone.updateWorldMatrix(true, false);
    mesh.applyMatrix4(new THREE.Matrix4().copy(bone.matrixWorld).invert());
    bone.add(mesh);
    owned.geometries.push(geometry);
    return mesh;
}

function addExtras(recipe, joints, boneOf, owned) {
    const flat = (color) => { const m = new THREE.MeshLambertMaterial({ color }); owned.materials.push(m); return m; };
    if (recipe.traits.includes('tail') && !recipe.wear.bodyform) { // a body form has its own
        const p = joints.pelvis;
        const reach = p.y * 0.55;
        const curve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(0, p.y - 0.02, p.z - 0.09), new THREE.Vector3(0, p.y - 0.12, p.z - 0.26),
            new THREE.Vector3(0, p.y - reach * 0.6, p.z - 0.42), new THREE.Vector3(0, p.y - reach, p.z - 0.6),
            new THREE.Vector3(0, p.y - reach * 0.95, p.z - 0.8)]);
        const tail = new THREE.TubeGeometry(curve, 18, 0.05, 8, false);
        // Taper toward the tip (tube rings are laid out along the curve).
        const pos = tail.attributes.position, centre = new THREE.Vector3(), v = new THREE.Vector3();
        for (let ring = 0; ring <= 18; ring++) {
            curve.getPointAt(ring / 18, centre);
            const k = 1 - 0.82 * (ring / 18);
            for (let j = 0; j <= 8; j++) {
                const i = ring * 9 + j;
                v.fromBufferAttribute(pos, i).sub(centre).multiplyScalar(k).add(centre);
                pos.setXYZ(i, v.x, v.y, v.z);
            }
        }
        tail.computeVertexNormals();
        addRigid(boneOf('pelvis'), owned, tail, flat(lin(recipe.colors.skin, TINT_FALLBACK.skin)), new THREE.Matrix4());
    }
    if (recipe.shield) {
        // Strapped to the left forearm, face turned away from the body.
        const elbow = joints.lowerarm_l, hand = joints.hand_l;
        const along = new THREE.Vector3().subVectors(hand, elbow);
        const out = new THREE.Vector3(-along.y, along.x, 0).normalize(); // forearm's outer side, in the frontal plane
        const centre = elbow.clone().addScaledVector(along, 0.6).addScaledVector(out, 0.06);
        const frame = new THREE.Matrix4().compose(centre, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), out), new THREE.Vector3(1, 1, 1));
        const wood = flat(lin('#6e4f33')), steel = flat(lin('#9aa4b0'));
        const bone = boneOf('lowerarm_l');
        addRigid(bone, owned, new THREE.CylinderGeometry(0.2, 0.2, 0.03, 20), wood, frame);
        addRigid(bone, owned, new THREE.TorusGeometry(0.2, 0.017, 8, 24), steel,
            frame.clone().multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
        addRigid(bone, owned, new THREE.SphereGeometry(0.05, 12, 8), steel,
            frame.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.025, 0)));
    }
}

async function buildKitCharacter(group, charData, footY) {
    const [kit, { rig, clips }] = await Promise.all([loadCharacterKit(), loadCharacterAssets()]);
    const recipe = resolveCharacter(charData, kit);
    const morphed = await morphBase(kit, recipe.shape);
    const { origin, joints } = fitJoints(kit, morphed);
    const ownFace = Object.values(recipe.wear).some(id => kit.assets[id].replacesFace);
    const worn = [...Object.values(recipe.wear), ...(ownFace ? [] : ['eyes', 'lashes']), ...(recipe.weapon ? [recipe.weapon] : [])].filter(id => kit.assets[id]);
    const owned = { materials: [], geometries: [] };
    const overForm = !!recipe.wear.bodyform;
    const clothGap = overForm ? (kit.assets[recipe.wear.bodyform].clothGap ?? 0.22) : 0; // scales need room, fur does not

    const skinUrl = kitUrl('skins/' + kit.skins[recipe.skin].map);
    // What the clothes cover (for the sculpt under them) and which of its parts a piece replaces.
    const covered = overForm ? hiddenVertices(kit, worn.filter(id => kit.assets[id].slot !== 'bodyform')) : null;
    const omit = [...(recipe.wear.hands ? ['hand_'] : []), ...(recipe.wear.feet ? ['foot_'] : [])];
    const [skin, parts] = await Promise.all([
        loadTexture(skinUrl),
        Promise.all(worn.map(async id => ({
            id,
            geometry: await assetGeometry(kit, id, morphed, origin, overForm && kit.assets[id].slot !== 'bodyform' && kit.assets[id].slot !== 'weapon' ? clothGap : 0,
                kit.assets[id].slot === 'bodyform' ? { covered, omit, flatten: !!(recipe.wear.outfit && kit.assets[recipe.wear.outfit].armor) } : undefined),
            material: await assetMaterial(kit, id, recipe, owned)
        })))
    ]);
    if (group.userData.disposed) { owned.materials.forEach(m => m.dispose()); parts.forEach(p => p.geometry.dispose()); return; }

    const inner = new THREE.Group();
    const rigRoot = cloneSkinned(rig);
    inner.add(rigRoot);
    const fit = fitSkeleton(kit, rigRoot, joints);
    const identity = new THREE.Matrix4();
    const addSkinned = (geometry, material) => {
        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.castShadow = true;
        mesh.frustumCulled = false; // bounds are the bind pose; the figure is small and always near its base
        inner.add(mesh);
        mesh.bind(fit.skeleton, identity);
        owned.geometries.push(geometry);
        return mesh;
    };
    const skinMaterial = new THREE.MeshStandardMaterial({ map: skin.texture, roughness: 0.75, metalness: 0, skinning: true });
    skinMaterial.color.copy(tintToward(recipe.colors.skin, skin.tone, TINT_FALLBACK.skin));
    owned.materials.push(skinMaterial);
    // Clothes hide the body under them; skin-tight extras (brows, lashes, eyes) hide nothing.
    const skinGeometry = bodyGeometry(kit, morphed, origin, hiddenVertices(kit, worn));
    if (skinGeometry.index.count) addSkinned(skinGeometry, skinMaterial); else skinGeometry.dispose();
    for (const part of parts) {
        const form = part.material.userData.form;
        if (form) formShader(part.material, form.hex, form.tone, !!part.geometry.attributes.sway);
        addSkinned(part.geometry, part.material);
    }

    const boneOf = (name) => fit.skeleton.bones[kit.boneIndex[name]];
    addExtras(recipe, joints, boneOf, owned);

    const s = UNITS_PER_METRE * recipe.size;
    inner.scale.setScalar(s);
    inner.position.y = footY;
    attachFigure(group, inner);
    group.userData.owned = owned;
    group.userData.recipe = recipe;

    // The pelvis is the one bone the clips move: re-base its path on this
    // body's hip height so short legs don't float and long ones don't sink.
    const k = fit.pelvis.fitted.length() / fit.pelvis.rest.length();
    const fitted = new Map();
    const fitClip = (clip) => {
        if (!fitted.has(clip)) {
            const tracks = clip.tracks.map(track => {
                if (track.name !== 'pelvis.position') return track;
                const copy = track.clone(), v = copy.values, r = fit.pelvis.rest, f = fit.pelvis.fitted;
                for (let i = 0; i < v.length; i += 3) {
                    v[i] = f.x + (v[i] - r.x) * k; v[i + 1] = f.y + (v[i + 1] - r.y) * k; v[i + 2] = f.z + (v[i + 2] - r.z) * k;
                }
                return copy;
            });
            fitted.set(clip, new THREE.AnimationClip(clip.name, clip.duration, tracks));
        }
        return fitted.get(clip);
    };
    const neckHold = recipe.wear.bodyform && kit.assets[recipe.wear.bodyform].neckHold;
    if (neckHold) { // read the sculpted pose before any clip touches it
        group.userData.neckHold = { hold: neckHold, bones: ['neck_01', 'head'].map(name => ({ bone: boneOf(name), rest: boneOf(name).quaternion.clone() })) };
        _neckHolds.add(group.userData.neckHold);
    }
    holdProp(group, rigRoot, charData);
    installAnimation(group, new THREE.AnimationMixer(rigRoot), clips, BASE_ROLE_CLIPS, fitClip);
    installMotion(group, inner);
    const spread = recipe.wear.bodyform && kit.assets[recipe.wear.bodyform].armSpread;
    if (spread) {
        group.userData.carriage = { root: inner, left: boneOf('upperarm_l'), right: boneOf('upperarm_r'), angle: spread };
        _carriages.add(group.userData.carriage);
    }
}

// Bounds of a model as it stands. A skinned mesh is measured through its bones: rigs exported with
// a scaled armature keep their vertices in another unit, and the geometry box alone is off by that.
function posedBox(root) {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    root.traverse(o => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const position = o.geometry.attributes.position;
        if (!o.isSkinnedMesh || !position) { box.expandByObject(o); return; }
        o.skeleton.update();
        for (let i = 0, step = Math.max(1, Math.floor(position.count / 4000)); i < position.count; i += step) {
            box.expandByPoint(o.boneTransform(i, v).applyMatrix4(o.matrixWorld));
        }
    });
    return box;
}

// A cartoon look: every surface is its flat texture colour (no lighting), wrapped in an ink line —
// the same mesh again, pushed out along its normals, back faces only, black.
function toonLook(root, owned, height, weight) {
    const meshes = [];
    root.traverse(o => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
    const push = (height * 0.007 * weight).toFixed(5);
    const inks = {};
    const inkFor = (skinned) => inks[skinned] || (inks[skinned] = (() => {
        const ink = new THREE.MeshBasicMaterial({ color: 0x0a0a0c, side: THREE.BackSide, skinning: skinned });
        ink.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `vec3 transformed = position + normalize( normal ) * ${push};`);
        };
        owned.materials.push(ink);
        return ink;
    })());
    for (const mesh of meshes) {
        const flat = (m) => {
            const basic = new THREE.MeshBasicMaterial({ map: m.map || null, color: m.map ? 0xffffff : m.color, skinning: !!mesh.isSkinnedMesh, side: m.side });
            owned.materials.push(basic);
            return basic;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(flat) : flat(mesh.material);
        mesh.castShadow = true;
        if (!(weight > 0) || !mesh.geometry.attributes.normal) continue;
        if (!mesh.isSkinnedMesh) { mesh.add(new THREE.Mesh(mesh.geometry, inkFor(false))); continue; }
        const line = new THREE.SkinnedMesh(mesh.geometry, inkFor(true));
        line.bind(mesh.skeleton, mesh.bindMatrix);
        line.frustumCulled = false;
        line.position.copy(mesh.position); line.quaternion.copy(mesh.quaternion); line.scale.copy(mesh.scale);
        mesh.parent.add(line);
    }
}

// Put the sheet's pack prop in the right hand. It is placed in the rest pose — grip just past the
// wrist, handle pointing where the figure faces — and from then on rides the hand bone, whatever
// the rig (kit body or look) and whatever unit its bones are in. Call before the mixer first runs.
const HAND_R = /^(right_?hand|hand_?r)$/i, FOREARM_R = /^(right_?fore_?arm|lowerarm_?r)$/i;
function holdProp(group, root, charData, { toon = false, weight = 1, height = 1.1 } = {}) {
    const entry = heldProp(charData);
    let hand = null, fore = null;
    if (entry) root.traverse(o => { if (o.isBone) { if (!hand && HAND_R.test(o.name)) hand = o; if (!fore && FOREARM_R.test(o.name)) fore = o; } });
    if (!hand || !fore) return;
    group.updateMatrixWorld(true);
    const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const handRest = new THREE.Matrix4().multiplyMatrices(toGroup, hand.matrixWorld);
    const wrist = new THREE.Vector3().setFromMatrixPosition(handRest);
    const elbow = new THREE.Vector3().setFromMatrixPosition(fore.matrixWorld).applyMatrix4(toGroup);
    const grip = wrist.clone().add(wrist.clone().sub(elbow).normalize().multiplyScalar(height * 0.05));
    const forward = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));
    const local = handRest.invert().multiply(new THREE.Matrix4().compose(grip, forward, new THREE.Vector3().setScalar(entry.length)));
    group.userData.holding = entry;
    loadLookFile(entry.url).then(gltf => {
        if (group.userData.disposed) return;
        const prop = gltf.scene.clone(true);
        prop.traverse(o => { if (o.isMesh) o.castShadow = true; });
        if (toon) toonLook(prop, group.userData.owned || { materials: [] }, height / entry.length, weight);
        prop.matrixAutoUpdate = false;
        prop.matrix.copy(local);
        hand.add(prop);
    }).catch(err => console.warn('charmesh: prop failed to load', entry.id, err));
}

function buildLookCharacter(group, charData, entry, gltf, animGltf, footY) {
    const ap = charData.appearance || {};
    const inner = cloneSkinned(gltf.scene);
    inner.traverse(o => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; } });
    inner.updateMatrixWorld(true);
    const box = posedBox(inner);
    const size = Math.max(1e-4, box.max.y - box.min.y);
    const s = ((Number(entry.height) || 1.15) * num(ap.height, 1)) / size;
    inner.scale.setScalar(s);
    inner.position.set(-(box.min.x + box.max.x) / 2 * s, footY - box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
    attachFigure(group, inner);
    group.userData.owned = { materials: [], geometries: [] };
    const weight = entry.outline === undefined ? 1 : Number(entry.outline) || 0;
    if (entry.toon) toonLook(inner, group.userData.owned, size, weight);
    holdProp(group, inner, charData, { toon: !!entry.toon, weight, height: size * s });
    const clips = (animGltf && animGltf.animations && animGltf.animations.length ? animGltf.animations : gltf.animations) || [];
    if (entry.clips && clips.length) installAnimation(group, new THREE.AnimationMixer(inner), clips, entry.clips);
    else { group.userData.playRole = () => null; group.userData.playClip = () => null; }
    installMotion(group, inner);
}

function installAnimation(group, mixer, clips, roleClips, fitClip = (clip) => clip) {
    _mixers.add(mixer);
    group.userData.mixer = mixer;
    group.userData.clips = clips;
    let current = null;
    const play = (clipName, { fade = 0.25, loop = true } = {}) => {
        const clip = THREE.AnimationClip.findByName(clips, clipName);
        if (!clip) return null;
        const action = mixer.clipAction(fitClip(clip));
        action.reset();
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
        action.clampWhenFinished = !loop;
        if (current && current !== action) action.crossFadeFrom(current, fade, false);
        else action.fadeIn(fade);
        action.play();
        current = action;
        return action;
    };
    group.userData.playClip = (clipName, fade = 0.25) => play(clipName, { fade });
    // One-shot roles fall back to idle when they finish (death stays down).
    // A held prop changes the picture: its own kind of swing, and "carry_" clips where the look has them.
    const pick = (role) => (group.userData.holding && roleClips['carry_' + role] ? 'carry_' + role : roleClips[role] ? role : null);
    group.userData.playRole = (role) => {
        const held = group.userData.holding;
        if (held && held.attack && role === 'attack') role = held.attack;
        let chosen = null;
        while (role && !(chosen = pick(role))) role = ROLE_FALLBACKS[role];
        if (!chosen) return null;
        return play(roleClips[chosen], { loop: LOOPING_ROLES.has(chosen) });
    };
    mixer.addEventListener('finished', (event) => {
        if (event.action !== current || !pick('idle')) return;
        if (roleClips.death && event.action.getClip().name === roleClips.death) return;
        play(roleClips[pick('idle')], { fade: 0.3 });
    });
    if (pick('idle')) play(roleClips[pick('idle')], { fade: 0 });
}

// Build an animated character group from saved character data. Options:
//   footY   — group-local y the soles should rest at (0 for the creator
//             preview, -0.38 for tabletop objects, matching halfHeight).
//   onReady — called with the group once the mesh is in place.
export function createRigCharacter(charData, { footY = 0, onReady } = {}) {
    const group = new THREE.Group();
    group.userData.rigCharacter = true;
    // Combat fx (monster-anim.js): play the role a named action calls for; returns its length.
    group.userData.playAction = (actionName) => {
        const action = group.userData.playRole && group.userData.playRole(actionRole(charData, actionName));
        return action ? action.getClip().duration : 0;
    };
    const ap = (charData && charData.appearance) || {};
    const done = () => { if (!group.userData.disposed && onReady) onReady(group); };
    const body = () => loadCharacterLooks().then(() => buildKitCharacter(group, charData, footY)).then(done);
    const start = ap.look
        ? loadCharacterLooks().then(looks => {
            const entry = looks[ap.look];
            if (!entry || !entry.url) return body(); // pack not installed here: the parametric body stands in
            return Promise.all([loadLookFile(entry.url), entry.animUrl ? loadLookFile(entry.animUrl) : null])
                .then(([gltf, animGltf]) => {
                    if (group.userData.disposed) return;
                    buildLookCharacter(group, charData, entry, gltf, animGltf, footY);
                    done();
                }, (err) => { console.warn('charmesh: look failed to load, using the parametric body', ap.look, err); return body(); });
        })
        : body();
    start.catch(err => console.error('charmesh: failed to build character', err));
    return group;
}

// Detach a character built here: unhook its mixer and drop what it owns
// (textures and the animation rig are shared caches — keep them).
export function releaseRigCharacter(group) {
    group.userData.disposed = true;
    if (group.userData.mixer) {
        group.userData.mixer.stopAllAction();
        _mixers.delete(group.userData.mixer);
    }
    if (group.userData.carriage) _carriages.delete(group.userData.carriage);
    if (group.userData.motion) _motions.delete(group.userData.motion);
    if (group.userData.neckHold) _neckHolds.delete(group.userData.neckHold);
    const owned = group.userData.owned;
    if (owned) {
        owned.materials.forEach(m => m.dispose());
        owned.geometries.forEach(g => g.dispose());
    }
}
