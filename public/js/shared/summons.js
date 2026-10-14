// summons.js — what a spell leaves on the map for its caster to move about
// (three.js, no DOM): Mage Hand, Spiritual Weapon, Dancing Lights, Unseen
// Servant, Floating Disk. They sync as `type: 'summon'` objects the server
// creates when the spell is cast (`kind` + the rules the server enforces:
// owner, leash, feet per turn); `models.js` builds them through `buildSummon`
// and `monster-anim.js` keeps them hovering with `tickSummons`.

import * as THREE from 'three';

export const SUMMON_KINDS = Object.freeze(['hand', 'weapon', 'lights', 'servant', 'disk']);
export const SUMMON_LABELS = Object.freeze({
    hand: 'Spectral hand', weapon: 'Spectral weapon', lights: 'Dancing lights', servant: 'Unseen servant', disk: 'Floating disk'
});
const TINTS = { hand: 0x8fd0ff, weapon: 0xffe08a, lights: 0xfff2b0, servant: 0xc9d6e6, disk: 0x9fb8ff };
const HOVER = { hand: 0.75, weapon: 0.95, lights: 1.25, servant: 0, disk: 0.6 };

const live = new Set();

function ghostly(color, opacity = 0.55) {
    return new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity,
        roughness: 0.4, metalness: 0, depthWrite: false
    });
}
function part(geometry, material, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
}

function hand(material) {
    const group = new THREE.Group();
    group.add(part(new THREE.BoxGeometry(0.2, 0.24, 0.07), material));
    for (let i = 0; i < 4; i++) {
        const finger = part(new THREE.CylinderGeometry(0.022, 0.026, 0.19 - Math.abs(i - 1.3) * 0.03, 8), material, -0.075 + i * 0.05, 0.21, 0);
        finger.rotation.x = -0.25;
        group.add(finger);
    }
    const thumb = part(new THREE.CylinderGeometry(0.024, 0.028, 0.13, 8), material, 0.14, 0.02, 0);
    thumb.rotation.z = -0.9;
    group.add(thumb);
    group.rotation.x = -0.35;
    return group;
}
function weapon(material) {
    const group = new THREE.Group();
    group.add(part(new THREE.BoxGeometry(0.07, 0.72, 0.022), material, 0, 0.22, 0));
    const tip = part(new THREE.ConeGeometry(0.036, 0.12, 4), material, 0, 0.64, 0);
    tip.scale.z = 0.45;
    group.add(tip);
    group.add(part(new THREE.BoxGeometry(0.26, 0.035, 0.05), material, 0, -0.15, 0));
    group.add(part(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 8), material, 0, -0.26, 0));
    group.rotation.z = Math.PI;      // point down, over the creature it threatens
    group.position.y = 0.25;
    return group;
}
function lights(material) {
    const group = new THREE.Group();
    for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        const orb = part(new THREE.SphereGeometry(0.075, 12, 10), material, Math.cos(angle) * 0.32, (i % 2) * 0.12, Math.sin(angle) * 0.32);
        orb.userData.orb = i;
        group.add(orb);
    }
    return group;
}
function servant(material) {
    const group = new THREE.Group();
    const body = part(new THREE.CylinderGeometry(0.16, 0.24, 1.0, 12, 1, true), material, 0, 0.55, 0);
    group.add(body);
    group.add(part(new THREE.SphereGeometry(0.14, 12, 10), material, 0, 1.2, 0));
    return group;
}
function disk(material) {
    const group = new THREE.Group();
    group.add(part(new THREE.CylinderGeometry(0.3, 0.3, 0.025, 28), material));
    return group;
}
const BUILDERS = { hand, weapon, lights, servant, disk };

// A synced summon (`data.kind`, optional `data.color` from its caster). The
// group sits on the ground at the object's position; the figure hovers inside.
export function buildSummon(data) {
    const kind = SUMMON_KINDS.includes(data && data.kind) ? data.kind : 'hand';
    const tint = new THREE.Color(TINTS[kind]);
    const material = ghostly(tint, kind === 'servant' ? 0.22 : kind === 'lights' ? 0.9 : 0.55);
    const group = new THREE.Group();
    const figure = BUILDERS[kind](material);
    const holder = new THREE.Group();
    holder.add(figure);
    holder.position.y = HOVER[kind];
    group.add(holder);
    // Where it is over the ground: a faint ring in its caster's colour.
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.26, 28),
        new THREE.MeshBasicMaterial({ color: data && data.color != null ? data.color : tint, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);
    group.userData.summon = { kind, holder, figure, material, phase: Math.random() * 6.28 };
    live.add(group);
    return group;
}

// Bob, turn and shimmer. `seconds` is any running clock.
export function tickSummons(seconds) {
    for (const group of live) {
        if (!group.parent) { live.delete(group); continue; }
        const { kind, holder, figure, material, phase } = group.userData.summon;
        const t = seconds + phase;
        holder.position.y = HOVER[kind] + Math.sin(t * 1.7) * 0.05;
        if (kind === 'lights') {
            figure.rotation.y = t * 0.6;
            for (const orb of figure.children) orb.position.y = (orb.userData.orb % 2) * 0.12 + Math.sin(t * 2.3 + orb.userData.orb) * 0.07;
        } else if (kind === 'weapon') {
            figure.rotation.y = t * 0.8;
        } else if (kind === 'disk') {
            figure.rotation.y = t * 0.3;
        } else if (kind === 'hand') {
            figure.rotation.y = Math.sin(t * 0.7) * 0.4;
        }
        material.emissiveIntensity = 0.6 + 0.2 * Math.sin(t * 2.1);
    }
}
