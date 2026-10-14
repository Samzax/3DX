// spellfx.js — what a spell with no area looks like on the map, on both
// tabletop screens (areas are the burst and the spray in monster-anim.js).
// Six forms, coloured by damage type:
//   bolt   a thrown mote with a tail; it bursts on the target, or flies wide
//   ray    a beam, there at once, thinning away
//   strike a column from above onto the target
//   touch  a flash on the target
//   heal   motes rising round the target over a widening ring
//   aura   a ring and a soft pillar settling on the target
// `spawnSpellFx` adds to a parent in true world coordinates (worldGroup);
// `tickSpellFx(now)` runs from monster-anim's tick, which owns the clock.
// No DOM; importable in Node.

import * as THREE from 'three';

export const FX_COLORS = {
    fire: '#ff7a1f', cold: '#bfe9ff', lightning: '#9fd0ff', acid: '#b6e23a',
    poison: '#6fcf4a', necrotic: '#7a4bd6', radiant: '#ffe9a8', thunder: '#d8e4ff',
    psychic: '#e58cff', force: '#c9a5ff'
};
export const SPELL_FORMS = ['bolt', 'ray', 'strike', 'touch', 'heal', 'aura'];
const HEAL_COLOR = '#8dffb0';
const AURA_COLOR = '#ffe9a8';
const BOLT_SPEED = 30;      // world units per second
const STRIKE_HEIGHT = 9;

const effects = new Set();
let sphere = null, ring = null, beam = null;

function geometries() {
    if (sphere) return;
    sphere = new THREE.SphereGeometry(1, 14, 10);
    ring = new THREE.RingGeometry(0.82, 1, 40);
    ring.rotateX(-Math.PI / 2);
    beam = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true); // unit tall, base at the origin
    beam.translate(0, 0.5, 0);
}

function glow(color, opacity = 1) {
    return new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
}
function part(geometry, material, parent) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.raycast = () => {};
    parent.add(mesh);
    return mesh;
}
const UP = new THREE.Vector3(0, 1, 0);
// Lay a unit beam from `a` to `b`.
function span(mesh, a, b, width) {
    const along = new THREE.Vector3().subVectors(b, a);
    const length = Math.max(0.001, along.length());
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(UP, along.multiplyScalar(1 / length));
    mesh.scale.set(width, length, width);
}
const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// The pop where something lands: a ball and a ground ring, both thinning.
function pop(group, at, color, size, feetY) {
    const ball = part(sphere, glow(color.clone().lerp(new THREE.Color('#ffffff'), 0.4), 0), group);
    const halo = part(ring, glow(color, 0), group);
    ball.position.copy(at);
    halo.position.set(at.x, feetY + 0.06, at.z);
    return (t) => { // t: 0..1 of the pop's own life, < 0 before it starts
        const on = t >= 0 && t < 1;
        ball.visible = halo.visible = on;
        if (!on) return;
        ball.scale.setScalar(size * (0.25 + 0.75 * ease(t / 0.4)));
        ball.material.opacity = 0.85 * (1 - t);
        halo.scale.setScalar(size * (0.5 + 1.6 * ease(t)));
        halo.material.opacity = 0.7 * (1 - t);
    };
}

// → seconds until the effect reaches its target (when a flinch should start).
// options: from, to (Vector3 in `parent` space; `to` is the target's middle),
// feetY (its ground), type (damage type), landed (false = a miss), size (the
// target's rough radius).
export function spawnSpellFx(parent, form, { from, to, feetY = 0, type = '', landed = true, size = 0.5 } = {}) {
    if (!parent || !to || !SPELL_FORMS.includes(form)) return 0;
    geometries();
    const color = new THREE.Color(FX_COLORS[type] || (form === 'heal' ? HEAL_COLOR : form === 'aura' ? AURA_COLOR : '#e8e8e8'));
    const group = new THREE.Group();
    parent.add(group);
    const reach = Math.max(0.5, Math.min(1.4, size));
    let life = 1, arrive = 0, update;

    if (form === 'bolt' && from) {
        // A miss sails past the shoulder and gutters out.
        const goal = to.clone();
        if (!landed) {
            const along = new THREE.Vector3().subVectors(to, from).setY(0).normalize();
            goal.addScaledVector(along, 2.2).add(new THREE.Vector3(-along.z, 0.35, along.x).multiplyScalar(0.7));
        }
        arrive = from.distanceTo(to) / BOLT_SPEED;
        const flight = from.distanceTo(goal) / BOLT_SPEED;
        const head = part(sphere, glow(color.clone().lerp(new THREE.Color('#ffffff'), 0.55), 0.95), group);
        const tail = part(beam, glow(color, 0.55), group);
        const burst = landed ? pop(group, to, color, reach * 1.1, feetY) : null;
        life = flight + (landed ? 0.5 : 0.25);
        const at = new THREE.Vector3(), back = new THREE.Vector3();
        update = (age) => {
            const t = Math.min(1, age / Math.max(0.001, flight));
            const flying = age < flight;
            head.visible = tail.visible = flying || !landed;
            at.lerpVectors(from, goal, t);
            back.lerpVectors(from, goal, Math.max(0, t - Math.min(0.35, 1.4 / Math.max(0.1, from.distanceTo(goal)))));
            head.position.copy(at);
            head.scale.setScalar(0.13);
            span(tail, back, at, 0.07);
            if (!flying && !landed) { // gutter
                const fade = 1 - (age - flight) / 0.25;
                head.material.opacity = 0.95 * fade; tail.material.opacity = 0.55 * fade;
            }
            if (burst) burst((age - flight) / 0.5);
        };
    } else if (form === 'ray' && from) {
        const goal = to.clone();
        if (!landed) goal.add(new THREE.Vector3(0.5, 0.6, -0.4));
        const core = part(beam, glow(color.clone().lerp(new THREE.Color('#ffffff'), 0.6), 0.95), group);
        const sheath = part(beam, glow(color, 0.45), group);
        const burst = landed ? pop(group, to, color, reach, feetY) : null;
        life = 0.6; arrive = 0.05;
        update = (age) => {
            const t = age / life;
            const thin = 1 - ease(t);
            span(core, from, goal, 0.035 * (0.3 + thin));
            span(sheath, from, goal, 0.11 * (0.3 + thin));
            core.material.opacity = 0.95 * (1 - t); sheath.material.opacity = 0.45 * (1 - t);
            if (burst) burst(age / 0.5);
        };
    } else if (form === 'strike') {
        const top = new THREE.Vector3(to.x, feetY + STRIKE_HEIGHT, to.z);
        const foot = new THREE.Vector3(to.x, feetY, to.z);
        const core = part(beam, glow(color.clone().lerp(new THREE.Color('#ffffff'), 0.6), 0.9), group);
        const sheath = part(beam, glow(color, 0.4), group);
        const burst = pop(group, to, color, reach * 1.2, feetY);
        life = 0.8; arrive = 0.12;
        const tip = new THREE.Vector3();
        update = (age) => {
            const fall = ease(age / 0.12);                     // the column comes down, then thins
            const t = Math.max(0, (age - 0.12) / (life - 0.12));
            tip.lerpVectors(top, foot, fall);
            span(core, tip, top, reach * 0.22 * (1 - 0.8 * ease(t)));
            span(sheath, tip, top, reach * 0.55 * (1 - 0.6 * ease(t)));
            core.material.opacity = 0.9 * (1 - t); sheath.material.opacity = 0.4 * (1 - t);
            burst((age - 0.1) / 0.6);
        };
    } else if (form === 'heal' || form === 'aura') {
        const halo = part(ring, glow(color, 0.8), group);
        const pillar = part(beam, glow(color, 0.2), group);
        halo.position.set(to.x, feetY + 0.06, to.z);
        pillar.position.set(to.x, feetY, to.z);
        const motes = [];
        if (form === 'heal') {
            for (let i = 0; i < 9; i++) motes.push({ mesh: part(sphere, glow(color.clone().lerp(new THREE.Color('#ffffff'), 0.5), 0.9), group), turn: i * 2.4, lag: (i % 3) * 0.12 });
        }
        const tall = Math.max(1.2, (to.y - feetY) * 2.2);
        life = form === 'heal' ? 1.5 : 1.2;
        update = (age) => {
            const t = age / life;
            const fade = 1 - t;
            // The aura closes in on the creature; the heal spreads out from it.
            halo.scale.setScalar(reach * (form === 'aura' ? 2.2 - 1.2 * ease(t) : 0.6 + 1.2 * ease(t)));
            halo.material.opacity = 0.8 * fade;
            pillar.scale.set(reach * 0.9, tall * ease(t * 2), reach * 0.9);
            pillar.material.opacity = 0.2 * Math.sin(Math.PI * Math.min(1, t));
            for (const mote of motes) {
                const m = Math.max(0, Math.min(1, (t - mote.lag) / (1 - 0.36)));
                const angle = mote.turn + m * 3.2;
                mote.mesh.position.set(to.x + Math.cos(angle) * reach * 0.75, feetY + 0.1 + m * tall, to.z + Math.sin(angle) * reach * 0.75);
                mote.mesh.scale.setScalar(0.055);
                mote.mesh.material.opacity = 0.9 * Math.sin(Math.PI * m);
            }
        };
    } else { // touch, or a bolt/ray with nowhere to leave from
        const burst = pop(group, to, color, reach * 1.2, feetY);
        life = 0.55;
        update = (age) => burst(landed ? age / life : 2);
    }
    update(0);
    effects.add({ group, born: null, life, update });
    return arrive;
}

export function tickSpellFx(now) {
    for (const effect of effects) {
        if (effect.born == null) effect.born = now;
        const age = now - effect.born;
        if (age >= effect.life || !effect.group.parent) {
            if (effect.group.parent) effect.group.parent.remove(effect.group);
            effect.group.children.forEach(mesh => mesh.material.dispose());
            effects.delete(effect);
            continue;
        }
        effect.update(age);
    }
}

export function activeSpellFx() { return effects.size; }
