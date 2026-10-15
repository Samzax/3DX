// monster-anim.js — animation runtime for monster tokens (both tabletop screens).
//
// Three small pieces, all local presentation (nothing here is synced state):
//
//  - Rigs: a GLB entry that declares `clips` (role → clip name; model packs do,
//    see lib/monster-packs.cjs) gets an AnimationMixer when monster-models.js
//    swaps the model in. The 'idle' role loops; every other role is a one-shot
//    that blends back to the loop.
//  - Stance: a combatant carrying the 'flying' condition loops 'fly' instead,
//    hovers above its base, and prefers the airborne variant of a one-shot
//    (`fly_breath`, `fly_bite`…) when the pack has one. Pages hand every
//    combat state to syncMonsterStances().
//  - Combat fx: the server stamps `fx { actor, target, action, type, landed }`
//    on combat-log entries. Pages hand each entry to queueCombatFx(); the next
//    tick groups them (an area breath logs one entry per target), turns the
//    actor toward its targets, plays the clip the action maps to and a hit
//    reaction on the targets.
//  - Breath: any action named "…Breath…" also sprays a cone or line from the
//    mouth socket (or from head height on models without one — the procedural
//    dragons get the effect too), coloured by damage type.
//
// Pages call tickMonsterAnimations() once per frame. No DOM is touched, so the
// module stays importable in Node tests.

import * as THREE from 'three';
import { FX_COLORS, spawnSpellFx, tickSpellFx } from './spellfx.js';
import { tickSummons } from './summons.js';

const ACTION_ROLES = ['attack', 'bite', 'claw', 'tail', 'wing', 'breath', 'roar', 'hit'];
export const CLIP_ROLES = Object.freeze([
    'idle', 'walk', 'fly', ...ACTION_ROLES, 'death', 'talk',
    ...ACTION_ROLES.map(role => `fly_${role}`)
]);
const HOVER_HEIGHT = 0.55; // of the model's height; the base disc stays on the ground

// Stat-block action name → role, when the pack entry has no explicit `actions`.
const ROLE_PATTERNS = [
    [/breath/i, 'breath'],
    [/bite/i, 'bite'],
    [/claw|talon/i, 'claw'],
    [/tail|sting/i, 'tail'],
    [/wing/i, 'wing'],
    [/frightful|roar|howl|shriek/i, 'roar']
];
// A role without its own clip falls back along this chain.
const ROLE_FALLBACKS = {
    bite: ['attack', 'claw'], claw: ['attack', 'bite'], tail: ['attack', 'claw', 'bite'],
    wing: ['attack', 'roar'], breath: ['roar', 'attack', 'bite'], roar: ['talk'],
    attack: ['bite', 'claw'], fly: ['idle']
};

export const BREATH_COLORS = FX_COLORS; // one palette for breaths, bursts and spells
const LINE_BREATHS = new Set(['lightning', 'acid']); // 5e: lines; the rest are cones
const BREATH_SECONDS = 1.5;
const HIT_DELAY = 0.35;

const rigs = new Set();
const breaths = new Set();
const bursts = new Set();      // area bursts and the bolts that carry them
const reacts = [];             // save results: { fx, findMesh } — the target flinches, nobody recasts
const timers = [];             // { at, run } — fired from the tick, never setTimeout
const queued = new Map();      // `${actor}|${action}` → { fx, targets: Set, findMesh }
const flying = new Set();      // combatant ids carrying the 'flying' condition
let airborne = new Set();      // token ids whose soles hang free of their support
const unscaled = new WeakMap(); // clip → the same clip without scale tracks
const clock = new THREE.Clock();
let now = 0;

const boneName = name => THREE.PropertyBinding.sanitizeNodeName(String(name));

// --- rigs ---------------------------------------------------------------------

// Stage presets: scale named bones of one sculpt (wyrmling head, ancient horns…).
export function applyProportions(model, proportions) {
    if (!proportions || typeof proportions !== 'object') return;
    for (const [name, scale] of Object.entries(proportions)) {
        const bone = model.getObjectByName(boneName(name));
        if (bone && Number.isFinite(scale)) bone.scale.multiplyScalar(scale);
    }
}

// Give a swapped-in GLB its mixer. `holder` is the seated group around `model`
// (it takes the turn-to-target yaw so the token's own rotation is untouched).
export function attachMonsterRig(wrapper, holder, model, entry, clips) {
    const wanted = entry && entry.clips && typeof entry.clips === 'object' ? entry.clips : null;
    if (!wanted || !Array.isArray(clips) || !clips.length) return null;
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    // Stage proportions are bone scales; a clip's own scale tracks would undo them.
    const keepScale = !(entry.proportions && typeof entry.proportions === 'object');
    for (const [role, clipName] of Object.entries(wanted)) {
        const found = clips.find(candidate => candidate.name === clipName);
        const clip = found && (keepScale ? found : withoutScaleTracks(found));
        if (clip) actions[role] = mixer.clipAction(clip);
        else console.warn(`[monsters] ${entry.index}: clip "${clipName}" (${role}) not found`);
    }
    if (!Object.keys(actions).length) return null;

    const rig = { wrapper, holder, model, entry, mixer, actions, current: null, yaw: 0, stance: 'idle', busy: false, hover: 0, seatY: model.position.y };
    mixer.addEventListener('finished', event => {
        if (event.action !== rig.current || event.action === actions.death) return;
        rig.yaw = 0;
        rig.busy = false;
        playLoop(rig, rig.stance, 0.3);
    });
    if (flyStance(wrapper.userData.syncId)) rig.stance = 'fly'; // the model landed after the combat state did
    playLoop(rig, rig.stance, 0);
    rigs.add(rig);
    wrapper.userData.monsterRig = rig;
    model.userData.onDispose = () => {
        rigs.delete(rig);
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        if (wrapper.userData.monsterRig === rig) { wrapper.userData.monsterRig = null; wrapper.userData.airborne = false; }
    };
    return rig;
}

function withoutScaleTracks(clip) {
    if (!unscaled.has(clip)) {
        unscaled.set(clip, new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter(track => !track.name.endsWith('.scale'))));
    }
    return unscaled.get(clip);
}

function resolveRole(rig, role) {
    const candidates = [role, ...(ROLE_FALLBACKS[role] || [])];
    if (rig.stance === 'fly') {
        const airborne = candidates.map(candidate => `fly_${candidate}`).find(candidate => rig.actions[candidate]);
        if (airborne) return airborne;
    }
    return candidates.find(candidate => rig.actions[candidate]) || null;
}

function setStance(rig, stance) {
    if (rig.stance === stance) return;
    rig.stance = stance;
    if (!rig.busy) playLoop(rig, stance, 0.5);
}

function flyStance(id) {
    return flying.has(id) || airborne.has(id);
}

// Hand over each combat state (or null when combat ends): combatants with the
// 'flying' condition take to the air, everyone else lands. `airborneIds` is
// what the pages measured — tokens whose soles hang free of any support.
export function syncMonsterStances(combat, airborneIds) {
    flying.clear();
    airborne = airborneIds || new Set();
    const combatants = combat && combat.combatants && typeof combat.combatants === 'object' ? combat.combatants : {};
    for (const combatant of Object.values(combatants)) {
        const effects = combatant && Array.isArray(combatant.effects) ? combatant.effects : [];
        if (effects.some(effect => effect && effect.key === 'flying')) flying.add(combatant.id);
    }
    for (const rig of rigs) setStance(rig, flyStance(rig.wrapper.userData.syncId) ? 'fly' : 'idle');
}

function crossTo(rig, action, fade) {
    const previous = rig.current;
    action.reset();
    action.play();
    if (previous && previous !== action && fade > 0) action.crossFadeFrom(previous, fade, false);
    else if (previous && previous !== action) previous.stop();
    rig.current = action;
}

function playLoop(rig, role, fade) {
    const action = rig.actions[resolveRole(rig, role)];
    if (!action) {
        if (rig.current) rig.current.fadeOut(fade || 0.2);
        rig.current = null;
        return;
    }
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    crossTo(rig, action, fade);
}

// Play a one-shot role on a token's rig; returns the clip's duration (0 when
// the token has no rig or no usable clip).
export function playMonsterRole(wrapper, role) {
    const rig = wrapper && wrapper.userData && wrapper.userData.monsterRig;
    const resolved = rig && resolveRole(rig, role);
    if (!resolved) return 0;
    const action = rig.actions[resolved];
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    rig.busy = true;
    crossTo(rig, action, 0.15);
    return action.getClip().duration;
}

export function roleForAction(entry, actionName) {
    const name = String(actionName || '');
    const explicit = entry && entry.actions && entry.actions[name.toLowerCase()];
    if (explicit) return explicit;
    const match = ROLE_PATTERNS.find(([pattern]) => pattern.test(name));
    return match ? match[1] : 'attack';
}

// --- breath -------------------------------------------------------------------

const BREATH_VERTEX = `
varying float vT;
varying float vAngle;
varying vec3 vNormal;
varying vec3 vView;
void main() {
    vT = position.z;
    vAngle = atan(position.y, position.x);
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-eye.xyz);
    gl_Position = projectionMatrix * eye;
}`;
// Nested shells of scrolling noise: dense and white-hot at the mouth, ragged
// and thinning toward the far end, soft at the silhouette so the stacked
// shells read as one volume rather than a hard cone.
const BREATH_FRAGMENT = `
uniform vec3 uColor;
uniform float uLife;   // 0 → 1 over the effect
uniform float uClock;
uniform float uCore;   // 0 outer shell → 1 innermost, hottest shell
varying float vT;
varying float vAngle;
varying vec3 vNormal;
varying vec3 vView;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
    return 0.55 * noise(p) + 0.3 * noise(p * 2.1 + 7.3) + 0.15 * noise(p * 4.3 + 19.1);
}
void main() {
    float head = smoothstep(0.0, 0.22, uLife);                 // the stream reaches out…
    float reach = 1.0 - smoothstep(head - 0.12, head + 0.02, vT);
    float fade = 1.0 - smoothstep(0.62, 1.0, uLife);           // …and dies away
    // The angle enters as a point on a circle so the noise wraps seamlessly.
    vec2 ring = vec2(cos(vAngle), sin(vAngle)) * (1.6 + uCore);
    float speed = 3.4 + uCore * 1.6;
    float n = fbm(ring * 1.7 + vec2(vT * 5.5 - uClock * speed, vT * 2.3 + uClock * 1.1 + uCore * 5.0));
    float ragged = smoothstep(vT * 0.8 - 0.2, vT * 0.8 + 0.3, n + 0.3 * (1.0 - vT));
    float soft = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.4);
    float density = pow(1.0 - vT, 0.5) * mix(0.42, 0.7, uCore);
    float heat = smoothstep(0.05, 0.6, vT + (1.0 - n) * 0.35 - uCore * 0.25);
    vec3 color = mix(mix(uColor, vec3(1.0), 0.75), uColor, heat) * mix(1.0, 0.72, vT);
    gl_FragColor = vec4(color, density * ragged * soft * reach * fade);
}`;

let coneGeometry = null;
let lineGeometry = null;
function breathGeometry(shape) {
    // Unit shapes: apex/start at the origin, running to z = 1 (lookAt aims +Z).
    if (shape === 'line') {
        if (!lineGeometry) {
            lineGeometry = new THREE.CylinderGeometry(1, 0.6, 1, 20, 12, true);
            lineGeometry.translate(0, -0.5, 0).rotateX(-Math.PI / 2);
        }
        return lineGeometry;
    }
    if (!coneGeometry) {
        coneGeometry = new THREE.ConeGeometry(1, 1, 28, 12, true);
        coneGeometry.translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    }
    return coneGeometry;
}

function breathOrigin(wrapper, out) {
    const rig = wrapper.userData.monsterRig;
    const socketName = rig && rig.entry.breath && rig.entry.breath.socket;
    const socket = socketName && rig.model.getObjectByName(boneName(socketName));
    if (socket) return socket.getWorldPosition(out);
    // No socket: roughly head height, on the token's axis.
    const height = Number(wrapper.userData.monsterHeight) || 1;
    return wrapper.getWorldPosition(out).add(new THREE.Vector3(0, height * 0.78, 0));
}

// Spray from `wrapper` toward the world-space `aim`, at least `reach` long.
// `forced` is the shape an aimed area already decided (a 5e cone or line).
function spawnBreath(wrapper, aim, reach, type, forced = null) {
    const parent = wrapper.parent;
    if (!parent) return;
    const entry = wrapper.userData.monsterRig ? wrapper.userData.monsterRig.entry : null;
    const config = (entry && entry.breath) || {};
    const shape = forced || config.shape || (LINE_BREATHS.has(type) ? 'line' : 'cone');
    const color = new THREE.Color(config.color || BREATH_COLORS[type] || '#e8e8e8');

    const origin = breathOrigin(wrapper, new THREE.Vector3());
    const length = forced ? Math.max(0.5, reach) : Math.max(1.5, origin.distanceTo(aim), reach) * 1.08;
    const radius = shape === 'line' ? Math.min(0.5, Math.max(0.12, length * 0.035)) : length * 0.5;

    const group = new THREE.Group();
    const uniforms = [];
    for (const core of [0, 0.5, 1]) {
        const material = new THREE.ShaderMaterial({
            vertexShader: BREATH_VERTEX,
            fragmentShader: BREATH_FRAGMENT,
            uniforms: {
                uColor: { value: color }, uLife: { value: 0 },
                uClock: { value: 0 }, uCore: { value: core }
            },
            transparent: true, depthWrite: false, side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending
        });
        const mesh = new THREE.Mesh(breathGeometry(shape), material);
        const shell = 1 - core * 0.58;
        mesh.scale.set(radius * shell, radius * shell, length);
        mesh.frustumCulled = false;
        mesh.renderOrder = 5;
        group.add(mesh);
        uniforms.push(material.uniforms);
    }
    // World → parent space (worldGroup carries the floating origin, unrotated).
    group.position.copy(parent.worldToLocal(origin.clone()));
    parent.add(group);
    group.lookAt(aim);
    breaths.add({ group, uniforms, born: now });
}

function tickBreaths() {
    for (const breath of breaths) {
        const life = (now - breath.born) / BREATH_SECONDS;
        if (life >= 1 || !breath.group.parent) {
            if (breath.group.parent) breath.group.parent.remove(breath.group);
            breath.group.children.forEach(mesh => mesh.material.dispose());
            breaths.delete(breath);
            continue;
        }
        for (const uniform of breath.uniforms) {
            uniform.uLife.value = life;
            uniform.uClock.value = now;
        }
    }
}

// --- area bursts ----------------------------------------------------------------
// A thrown area (Fireball): a bolt leaves the caster, then a noisy shell
// swells to the area's radius over a flash on the ground and thins away.

const BURST_SECONDS = 1.25;
const BOLT_SPEED = 26;         // world units per second (130 ft/s reads as "instant, but seen")
const BURST_VERTEX = `
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
void main() {
    vLocal = position;
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-eye.xyz);
    gl_Position = projectionMatrix * eye;
}`;
const BURST_FRAGMENT = `
uniform vec3 uColor;
uniform float uLife;
uniform float uClock;
uniform float uCore;
varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
    float n = 0.6 * noise(vLocal * 3.2 + vec3(0.0, -uClock * 1.6, uCore * 4.0)) + 0.4 * noise(vLocal * 7.1 + vec3(uClock * 0.9));
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float body = pow(facing, mix(0.6, 1.8, uCore));
    float fade = 1.0 - smoothstep(0.3, 1.0, uLife);
    float ragged = smoothstep(uLife * 0.75 - 0.15, uLife * 0.75 + 0.3, n + 0.25);
    vec3 color = mix(uColor, vec3(1.0), (1.0 - smoothstep(0.0, 0.5, uLife)) * mix(0.35, 0.9, uCore));
    gl_FragColor = vec4(color, body * ragged * fade * mix(0.55, 0.85, uCore));
}`;
let burstGeometry = null, boltGeometry = null, flashGeometry = null;

function burstColor(type) { return new THREE.Color(BREATH_COLORS[type] || '#e8e8e8'); }

// `at` and `from` are worldGroup-local points (true world coordinates).
function spawnBurst(parent, from, at, radius, type) {
    if (!parent) return;
    if (!burstGeometry) {
        burstGeometry = new THREE.SphereGeometry(1, 32, 20);
        boltGeometry = new THREE.SphereGeometry(1, 12, 8);
        flashGeometry = new THREE.CircleGeometry(1, 40);
        flashGeometry.rotateX(-Math.PI / 2);
    }
    const color = burstColor(type);
    const group = new THREE.Group();
    group.position.copy(at);
    const uniforms = [];
    for (const core of [0, 1]) {
        const material = new THREE.ShaderMaterial({
            vertexShader: BURST_VERTEX, fragmentShader: BURST_FRAGMENT,
            uniforms: { uColor: { value: color }, uLife: { value: 0 }, uClock: { value: 0 }, uCore: { value: core } },
            transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
        });
        const mesh = new THREE.Mesh(burstGeometry, material);
        mesh.userData.shell = 1 - core * 0.45;
        mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.raycast = () => {};
        group.add(mesh);
        uniforms.push(material.uniforms);
    }
    const flash = new THREE.Mesh(flashGeometry, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    flash.position.y = 0.06; flash.renderOrder = 4; flash.raycast = () => {};
    group.add(flash);
    group.visible = false;
    parent.add(group);

    let bolt = null;
    const travel = from ? from.distanceTo(at) / BOLT_SPEED : 0;
    if (from && travel > 0.04) {
        bolt = new THREE.Mesh(boltGeometry, new THREE.MeshBasicMaterial({
            color: color.clone().lerp(new THREE.Color('#ffffff'), 0.5), transparent: true, opacity: 0.95,
            depthWrite: false, blending: THREE.AdditiveBlending
        }));
        bolt.scale.setScalar(Math.min(0.22, Math.max(0.1, radius * 0.07)));
        bolt.position.copy(from); bolt.renderOrder = 5; bolt.raycast = () => {};
        parent.add(bolt);
    }
    bursts.add({ group, uniforms, flash, bolt, from, at, radius, born: now, travel: bolt ? travel : 0 });
}

function tickBursts() {
    for (const burst of bursts) {
        const age = now - burst.born;
        if (burst.bolt) {
            const t = burst.travel > 0 ? age / burst.travel : 1;
            if (t < 1 && burst.bolt.parent) {
                burst.bolt.position.lerpVectors(burst.from, burst.at, t);
                continue;
            }
            if (burst.bolt.parent) burst.bolt.parent.remove(burst.bolt);
            burst.bolt.material.dispose();
            burst.bolt = null;
        }
        const life = (age - burst.travel) / BURST_SECONDS;
        if (life >= 1 || !burst.group.parent) {
            if (burst.group.parent) burst.group.parent.remove(burst.group);
            burst.group.children.forEach(mesh => mesh.material.dispose());
            bursts.delete(burst);
            continue;
        }
        burst.group.visible = true;
        const swell = 1 - Math.pow(1 - Math.min(1, life / 0.3), 3);
        burst.group.children.forEach(mesh => {
            if (mesh === burst.flash) return;
            mesh.scale.setScalar(Math.max(0.01, burst.radius * swell * mesh.userData.shell));
        });
        burst.flash.scale.setScalar(Math.max(0.01, burst.radius * swell));
        burst.flash.material.opacity = 0.5 * (1 - Math.min(1, life / 0.6));
        for (const uniform of burst.uniforms) { uniform.uLife.value = life; uniform.uClock.value = now; }
    }
}

// --- combat fx ----------------------------------------------------------------

// Hand a 'combat-log' entry over; entries without `fx` are ignored. `findMesh`
// is the page's combatant-id → token lookup (the one CombatOverlays uses).
export function queueCombatFx(entry, findMesh) {
    const fx = entry && entry.fx;
    if (fx && fx.react === true && typeof fx.target === 'string' && typeof findMesh === 'function') {
        if (fx.landed === true) reacts.push({ fx, findMesh });
        return;
    }
    if (!fx || typeof fx.actor !== 'string' || typeof findMesh !== 'function') return;
    const key = `${fx.actor}|${fx.action || ''}`;
    let group = queued.get(key);
    if (!group) queued.set(key, group = { fx, findMesh, targets: new Map() });
    const ids = [fx.target, ...(Array.isArray(fx.targets) ? fx.targets.slice(0, 24) : [])];
    for (const id of ids) {
        if (typeof id === 'string') group.targets.set(id, fx.landed === true || group.targets.get(id) === true);
    }
}

function flushCombatFx() {
    // A save that failed (or was halved): the creature flinches once the
    // effect has had time to reach it.
    for (const { fx, findMesh } of reacts.splice(0)) {
        timers.push({ at: now + 0.7, run: () => {
            const mesh = findMesh(fx.target);
            if (!mesh || !mesh.parent) return;
            if (mesh.userData.monsterRig) playMonsterRole(mesh, 'hit');
            else if (mesh.userData.rigCharacter && mesh.userData.playRole) mesh.userData.playRole('hit');
        } });
    }
    if (!queued.size) return;
    const groups = [...queued.values()];
    queued.clear();
    for (const { fx, findMesh, targets } of groups) {
        const actor = findMesh(fx.actor);
        if (!actor || !actor.parent) continue; // not on this screen (fog, other map)
        const targetMeshes = [...targets].map(([id, landed]) => ({ mesh: findMesh(id), landed })).filter(item => item.mesh);

        const actorPos = actor.getWorldPosition(new THREE.Vector3());
        const aim = new THREE.Vector3();
        let reach = 0;
        for (const { mesh } of targetMeshes) {
            const position = mesh.getWorldPosition(new THREE.Vector3());
            position.y += (Number(mesh.userData.monsterHeight) || 1) * 0.5;
            aim.add(position);
            reach = Math.max(reach, position.distanceTo(actorPos));
        }
        let hasAim = targetMeshes.length > 0;
        if (hasAim) aim.multiplyScalar(1 / targetMeshes.length);
        // An aimed area: the caster turns to where it was sent, whoever is in it.
        const area = fx.area && Array.isArray(fx.area.center) && Array.isArray(fx.area.dir) ? fx.area : null;
        const fromCaster = area && (area.kind === 'cone' || area.kind === 'line');
        const headY = (Number(actor.userData.monsterHeight) || 1) * 0.7;
        const areaAt = area && new THREE.Vector3(
            fromCaster ? actor.position.x + area.dir[0] * area.size : area.center[0],
            actor.position.y + (fromCaster ? headY : 0),
            fromCaster ? actor.position.z + area.dir[1] * area.size : area.center[1]);
        if (area && area.kind !== 'self' && actor.parent) {
            aim.copy(actor.parent.localToWorld(areaAt.clone()));
            hasAim = aim.distanceTo(actorPos) > 0.05;
        }

        const rig = actor.userData.monsterRig;
        const role = roleForAction(rig && rig.entry, fx.action);
        if (rig && hasAim) {
            const local = actor.worldToLocal(aim.clone());
            rig.yaw = Math.atan2(local.x, local.z); // glTF models face +Z
        }
        // Player characters (charmesh.js) pick their own role from the action's name.
        const character = !rig && actor.userData.rigCharacter ? actor.userData : null;
        if (character && hasAim && character.faceToward) character.faceToward(aim);
        const duration = character && character.playAction ? character.playAction(fx.action) : playMonsterRole(actor, role);

        let strike = duration ? Math.min(duration * 0.5, 0.8) : 0;
        if (area) {
            const at = duration ? Math.min(duration * 0.35, 0.5) : 0;
            const parent = actor.parent;
            timers.push({ at: now + at, run: () => {
                if (!actor.parent) return;
                if (fromCaster) spawnBreath(actor, aim, Number(area.size) || 1, fx.type, area.kind);
                else {
                    const from = area.kind === 'self' ? null : actor.position.clone().setY(actor.position.y + headY);
                    const radius = area.kind === 'cube' ? (Number(area.size) || 1) * 0.6 : Number(area.size) || 1;
                    spawnBurst(parent, from, areaAt, radius, fx.type);
                }
            } });
            continue;
        }
        // A spell with a form (shared/spellfx.js): it leaves the caster's hand
        // and reaches each target, who flinches when it arrives.
        if (fx.form && actor.parent) {
            const at = duration ? Math.min(duration * 0.35, 0.5) : 0;
            const parent = actor.parent;
            const marks = targetMeshes.length ? targetMeshes : [{ mesh: actor, landed: true }];
            for (const { mesh, landed } of marks) {
                timers.push({ at: now + at, run: () => {
                    if (!actor.parent || mesh.parent !== parent) return;
                    const height = Number(mesh.userData.monsterHeight) || 1;
                    const from = mesh === actor ? null : actor.position.clone().setY(actor.position.y + headY);
                    const to = mesh.position.clone().setY(mesh.position.y + height * 0.5);
                    const arrive = spawnSpellFx(parent, fx.form, {
                        from, to, feetY: mesh.position.y - 0.1, type: fx.type, landed, size: Math.max(0.5, height * 0.45)
                    });
                    if (landed && fx.form !== 'heal' && fx.form !== 'aura') timers.push({ at: now + arrive + 0.05, run: () => {
                        if (mesh.userData.monsterRig) playMonsterRole(mesh, 'hit');
                        else if (mesh.userData.rigCharacter && mesh.userData.playRole) mesh.userData.playRole('hit');
                    } });
                } });
            }
            continue;
        }
        if (role === 'breath' && hasAim) {
            const at = rig && rig.entry.breath && Number.isFinite(rig.entry.breath.at)
                ? rig.entry.breath.at
                : duration * 0.35;
            timers.push({ at: now + at, run: () => { if (actor.parent) spawnBreath(actor, aim, reach, fx.type); } });
            strike = at + 0.25;
        }
        for (const { mesh, landed } of targetMeshes) {
            if (landed) timers.push({ at: now + strike + HIT_DELAY * 0.5, run: () => {
                if (mesh.userData.monsterRig) playMonsterRole(mesh, 'hit');
                else if (mesh.userData.rigCharacter && mesh.userData.playRole) mesh.userData.playRole('hit');
            } });
        }
    }
}

// --- tick ---------------------------------------------------------------------

// Once per frame from each page's render loop. `dt` is only for tests/manual
// frame loops; normally the module clock supplies it.
export function tickMonsterAnimations(dt) {
    const delta = Math.min(0.1, Number.isFinite(dt) ? dt : clock.getDelta());
    now += delta;
    flushCombatFx();
    for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].at > now) continue;
        const [timer] = timers.splice(i, 1);
        timer.run();
    }
    for (const rig of rigs) {
        rig.mixer.update(delta);
        // Hover lifts the model inside its holder (grounding.js owns the holder's
        // own height and leaves an airborne token alone).
        const hover = rig.stance === 'fly' ? (Number(rig.wrapper.userData.monsterHeight) || 1) * HOVER_HEIGHT : 0;
        const rise = hover - rig.hover;
        if (Math.abs(rise) > 1e-3) {
            rig.hover += rise * Math.min(1, delta * 2.5);
            rig.model.position.y = rig.seatY + rig.hover;
        }
        rig.wrapper.userData.airborne = rig.hover > 0.02;
        let turn = (rig.yaw - rig.holder.rotation.y) % (Math.PI * 2);
        if (turn > Math.PI) turn -= Math.PI * 2; else if (turn < -Math.PI) turn += Math.PI * 2;
        if (Math.abs(turn) > 1e-3) rig.holder.rotation.y += turn * Math.min(1, delta * 9);
    }
    tickBreaths();
    tickBursts();
    tickSpellFx(now);
    tickSummons(now);
}
