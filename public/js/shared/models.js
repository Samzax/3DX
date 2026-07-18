// models.js — token, prop and character meshes shared by the GM and player screens,
// plus movement helpers. All synced objects are built from server data through
// buildObjectFromData so both screens render identical scenes.

import * as THREE from 'three';
import { GRID_CELL_SIZE } from './scene.js';
import { buildWallRun, buildFloorPatch } from './structures.js';
import { createRigCharacter } from './charmesh.js';

export const defaultMaterial = new THREE.MeshLambertMaterial({ color: 0xdd4444 });
export const selectedMaterial = new THREE.MeshLambertMaterial({ color: 0xffff44, emissive: 0xaaaa00 });

// --- Character models -------------------------------------------------------
// Stylized low-poly adventurers built entirely from the saved character data:
// the appearance sliders (height/build/headSize/armLength/legLength) shape the
// body, appearance.colors dress it, the race adds features (elf ears, dwarf
// beard, tiefling horns, half-orc tusks, dragonborn snout) and the equipment
// adds a shield / weapon / metal-armor plating. The group origin sits at hip
// height (whole body dropped by BODY_DROP) so characters already placed on maps
// keep their stored seating; buildObjectFromData measures the true bottom for
// halfHeight either way.

const CHAR_SCALE = 0.4;
const BODY_DROP = 0.95;

export function charColors(charData) {
    const c = (charData.appearance && charData.appearance.colors) || {};
    const legacy = charData.color || '#dd4444';
    return {
        skin: c.skin || '#c68642',
        hair: c.hair || '#3b2716',
        torso: c.torso || legacy,
        legs: c.legs || '#3a3f4a',
        eyes: c.eyes || '#111111'
    };
}

function shade(hex, k) {
    return new THREE.Color(hex).multiplyScalar(k);
}

export function createCharacterModel(charData) {
    const modelGroup = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = -BODY_DROP;
    modelGroup.add(body);

    const ap = charData.appearance || {};
    const H = ap.height || 1, B = ap.build || 1, HS = ap.headSize || 1;
    const AL = ap.armLength || 1, LL = ap.legLength || 1;
    const col = charColors(charData);
    const race = String(charData.race || '').toLowerCase();
    const eq = charData.equipment || {};
    const dragon = race.includes('dragonborn');

    const lambert = (c) => new THREE.MeshLambertMaterial({ color: c });
    const skinMat = lambert(col.skin);
    const hairMat = lambert(col.hair);
    const torsoMat = lambert(col.torso);
    const legsMat = lambert(col.legs);
    const tunicMat = lambert(shade(col.torso, 0.78));
    const bootsMat = lambert(shade(col.legs, 0.55));
    const noseMat = lambert(shade(col.skin, 0.86));
    const eyeMat = new THREE.MeshBasicMaterial({ color: col.eyes });
    const leatherMat = lambert('#6b4a2f');
    const steelMat = lambert('#c3ccd6');
    const woodMat = lambert('#7a5a3a');
    const goldMat = lambert('#d8b04a');

    const add = (parent, geo, mat) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        parent.add(m);
        return m;
    };

    // Legs + boots. Feet rest on body-local y=0.
    const legTopY = 0.9 * LL;
    for (const side of [-1, 1]) {
        const x = side * 0.16 * B;
        const leg = add(body, new THREE.CylinderGeometry(0.10, 0.12, 1, 10), legsMat);
        leg.scale.set(B, legTopY, B);
        leg.position.set(x, legTopY / 2, 0);
        const boot = add(body, new THREE.CylinderGeometry(0.13, 0.15, 0.26, 10), bootsMat);
        boot.position.set(x, 0.13, 0);
        const toe = add(body, new THREE.SphereGeometry(0.11, 10, 8), bootsMat);
        toe.scale.set(1, 0.62, 1.2);
        toe.position.set(x, 0.07, 0.13);
    }

    // Tunic skirt, torso (shoulders wider than waist), belt.
    const skirt = add(body, new THREE.CylinderGeometry(0.29, 0.34, 0.2, 12), tunicMat);
    skirt.scale.set(B, 1, B);
    skirt.position.y = legTopY + 0.04;
    const torso = add(body, new THREE.CylinderGeometry(0.34, 0.26, 1, 12), torsoMat);
    torso.scale.set(B, H, B);
    torso.position.y = legTopY + 0.1 + H * 0.5;
    const shoulderY = legTopY + 0.1 + H;
    const belt = add(body, new THREE.CylinderGeometry(0.30, 0.30, 0.1, 12), leatherMat);
    belt.scale.set(B, 1, B);
    belt.position.y = legTopY + 0.21;
    const buckle = add(body, new THREE.BoxGeometry(0.1, 0.08, 0.05), goldMat);
    buckle.position.set(0, legTopY + 0.21, 0.29 * B);
    for (const side of [-1, 1]) {
        const pad = add(body, new THREE.SphereGeometry(0.11, 10, 8), torsoMat);
        pad.scale.set(1.2, 0.95, 1.1);
        pad.position.set(side * 0.31 * B, shoulderY - 0.04, 0);
    }

    // Metal armor reads as a steel chest plate + pauldrons.
    const armor = String(eq.armor || '');
    if (/chain|plate|splint|scale-mail|ring/.test(armor)) {
        const chest = add(body, new THREE.CylinderGeometry(0.355, 0.30, 0.5, 12), steelMat);
        chest.scale.set(B, H, B);
        chest.position.y = shoulderY - 0.3 * H;
        for (const side of [-1, 1]) {
            const p = add(body, new THREE.SphereGeometry(0.13, 10, 8), steelMat);
            p.scale.set(1.25, 0.9, 1.15);
            p.position.set(side * 0.33 * B, shoulderY - 0.02, 0);
        }
    }

    // Neck + head.
    const neck = add(body, new THREE.CylinderGeometry(0.09, 0.11, 0.2, 8), skinMat);
    neck.position.y = shoulderY + 0.05;
    const headR = 0.36 * HS;
    const headCY = shoulderY + 0.1 + headR;
    const head = add(body, new THREE.SphereGeometry(0.36, 20, 16), skinMat);
    head.scale.setScalar(HS);
    head.position.y = headCY;

    for (const side of [-1, 1]) {
        const eye = add(body, new THREE.SphereGeometry(0.048, 8, 8), eyeMat);
        eye.scale.setScalar(HS);
        eye.position.set(side * 0.13 * HS, headCY + 0.04 * HS, 0.33 * HS);
    }
    if (!dragon) {
        const nose = add(body, new THREE.SphereGeometry(0.05, 8, 8), noseMat);
        nose.scale.set(0.9 * HS, 1.1 * HS, HS);
        nose.position.set(0, headCY - 0.03 * HS, 0.35 * HS);
        const hair = add(body, new THREE.SphereGeometry(0.385, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
        hair.scale.setScalar(HS);
        hair.position.y = headCY + 0.015 * HS;
        hair.rotation.x = -0.12; // fringe dips toward the brow
        const nape = add(body, new THREE.SphereGeometry(0.3, 12, 10), hairMat);
        nape.scale.set(0.9 * HS, 0.75 * HS, 0.7 * HS);
        nape.position.set(0, headCY + 0.02 * HS, -0.16 * HS);
    }

    // Race features. Homebrew race slugs simply match nothing and stay plain.
    if (/(^|-)elf/.test(race)) {
        for (const side of [-1, 1]) {
            const ear = add(body, new THREE.ConeGeometry(0.05, 0.22, 6), skinMat);
            ear.scale.setScalar(HS);
            ear.position.set(side * 0.37 * HS, headCY + 0.06 * HS, 0);
            ear.rotation.z = side * -(Math.PI / 2 - 0.5); // tips angle up-and-out
        }
    } else if (race.includes('dwarf')) {
        const beard = add(body, new THREE.ConeGeometry(0.19, 0.42, 8), hairMat);
        beard.scale.setScalar(HS);
        beard.rotation.x = Math.PI - 0.2; // apex down, flowing slightly forward
        beard.position.set(0, headCY - 0.33 * HS, 0.15 * HS);
    } else if (race.includes('orc')) {
        for (const side of [-1, 1]) {
            const tusk = add(body, new THREE.ConeGeometry(0.028, 0.1, 6), lambert('#e9e2cf'));
            tusk.scale.setScalar(HS);
            tusk.position.set(side * 0.09 * HS, headCY - 0.16 * HS, 0.29 * HS);
            tusk.rotation.x = 0.25;
        }
    } else if (race.includes('tiefling')) {
        for (const side of [-1, 1]) {
            const horn = add(body, new THREE.ConeGeometry(0.06, 0.3, 6), lambert('#4a3038'));
            horn.scale.setScalar(HS);
            horn.position.set(side * 0.17 * HS, headCY + 0.32 * HS, -0.05 * HS);
            horn.rotation.set(-0.35, 0, side * -0.45); // swept back and out
        }
    }
    if (dragon) {
        const snout = add(body, new THREE.BoxGeometry(0.22, 0.16, 0.26), skinMat);
        snout.scale.setScalar(HS);
        snout.position.set(0, headCY - 0.05 * HS, 0.38 * HS);
        for (const side of [-1, 1]) {
            const spike = add(body, new THREE.ConeGeometry(0.05, 0.22, 6), noseMat);
            spike.scale.setScalar(HS);
            spike.position.set(side * 0.14 * HS, headCY + 0.24 * HS, -0.16 * HS);
            spike.rotation.x = -1.0;
        }
    }

    // Arms: sleeve + forearm + hand hanging from shoulder pivots, tilted out a
    // touch. Held gear counter-scales so build/arm sliders don't distort it.
    let armL = null, armR = null;
    for (const side of [-1, 1]) {
        const arm = new THREE.Group();
        arm.position.set(side * (0.34 * B + 0.04), shoulderY - 0.05, 0);
        arm.rotation.z = side * 0.12;
        arm.scale.set(B, AL, B);
        body.add(arm);
        const sleeve = add(arm, new THREE.CylinderGeometry(0.085, 0.075, 0.34, 8), torsoMat);
        sleeve.position.y = -0.16;
        const forearm = add(arm, new THREE.CylinderGeometry(0.068, 0.06, 0.42, 8), skinMat);
        forearm.position.y = -0.52;
        const hand = add(arm, new THREE.SphereGeometry(0.085, 8, 8), skinMat);
        hand.position.y = -0.76;
        if (side === -1) armL = arm; else armR = arm;
    }

    if (eq.shield) {
        const shield = new THREE.Group();
        shield.position.set(-0.13, -0.5, 0.03);
        shield.rotation.z = Math.PI / 2; // disc axis along x, face outward
        shield.scale.set(1 / AL, 1 / B, 1 / B);
        armL.add(shield);
        add(shield, new THREE.CylinderGeometry(0.3, 0.3, 0.045, 14), woodMat);
        const rim = add(shield, new THREE.TorusGeometry(0.3, 0.028, 8, 20), steelMat);
        rim.rotation.x = Math.PI / 2;
        const boss = add(shield, new THREE.SphereGeometry(0.07, 10, 8), steelMat);
        boss.position.y = 0.04;
    }

    const weapon = (Array.isArray(eq.weapons) && eq.weapons[0]) ? String(eq.weapons[0]) : '';
    if (weapon) {
        const grip = new THREE.Group();
        grip.position.set(0, -0.76, 0.03);
        grip.rotation.x = 0.2; // rests slightly forward
        grip.scale.set(1 / B, 1 / AL, 1 / B);
        armR.add(grip);
        if (/bow/.test(weapon)) {
            const bow = add(grip, new THREE.TorusGeometry(0.42, 0.025, 6, 16, Math.PI), woodMat);
            bow.rotation.z = -Math.PI / 2; // chord vertical, bulge outward
        } else if (/staff|wand/.test(weapon)) {
            const shaft = add(grip, new THREE.CylinderGeometry(0.032, 0.032, 1.5, 8), woodMat);
            shaft.position.y = 0.15;
            const orb = add(grip, new THREE.SphereGeometry(0.075, 10, 8),
                new THREE.MeshLambertMaterial({ color: 0x6fd3c3, emissive: 0x1e4f46 }));
            orb.position.y = 0.97;
        } else if (/axe/.test(weapon)) {
            const haft = add(grip, new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), woodMat);
            haft.position.y = 0.25;
            const head_ = add(grip, new THREE.BoxGeometry(0.04, 0.22, 0.26), steelMat);
            head_.position.set(0, 0.62, 0.13);
        } else { // sword
            const blade = add(grip, new THREE.BoxGeometry(0.07, 0.55, 0.02), steelMat);
            blade.position.y = 0.36;
            const guard = add(grip, new THREE.BoxGeometry(0.2, 0.045, 0.05), goldMat);
            guard.position.y = 0.07;
            const pommel = add(grip, new THREE.SphereGeometry(0.045, 8, 8), goldMat);
            pommel.position.y = -0.1;
        }
    }

    modelGroup.scale.setScalar(CHAR_SCALE);
    return modelGroup;
}

// Free the GPU resources of a model built here (creator preview rebuilds on
// every appearance tweak; synced map objects are handled by the pages).
export function disposeModel(root) {
    root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
}

// Simple decorative props for the folded geometry a heightmap can't do.
export function createPropMesh(type) {
    const group = new THREE.Group();
    if (type === 'cave') {
        const rock = new THREE.MeshLambertMaterial({ color: 0x6b6b6b });
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.2, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), rock);
        dome.castShadow = true; group.add(dome);
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.6), new THREE.MeshBasicMaterial({ color: 0x0a0a0a }));
        mouth.position.set(0, 0.42, 1.0); group.add(mouth);
    } else { // arch
        const stone = new THREE.MeshLambertMaterial({ color: 0x8a7f6b });
        const arch = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.22, 12, 24, Math.PI), stone);
        arch.castShadow = true; group.add(arch);
    }
    return group;
}

// Portal: a standing glowing ring on a stone base. Double-clicking it travels to
// userData.portalTarget (another map key — a pocket dungeon or any world map).
export function createPortalMesh() {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.62, 0.12, 16),
        new THREE.MeshLambertMaterial({ color: 0x555566 }));
    base.position.y = 0.06;
    base.castShadow = true;
    group.add(base);
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.7, 0.12, 12, 32),
        new THREE.MeshLambertMaterial({ color: 0x7b3fbf, emissive: 0x3a1d66 }));
    ring.position.y = 0.95;
    ring.castShadow = true;
    group.add(ring);
    const swirl = new THREE.Mesh(
        new THREE.CircleGeometry(0.6, 24),
        new THREE.MeshBasicMaterial({ color: 0xb38cff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    swirl.position.y = 0.95;
    group.add(swirl);
    return group;
}

// Build a synced scene object from server data ('object-added' / 'map-state').
// Returns the mesh with userData (syncId, halfHeight, characterData/objectType)
// filled in, or null for unknown types. The caller adds it to scene + object list.
export function buildObjectFromData(id, data) {
    let objectMesh;
    let halfHeight = 0.5;

    switch (data.type) {
        case 'token':
            objectMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(GRID_CELL_SIZE * 0.4, GRID_CELL_SIZE * 0.4, 0.2, 32),
                defaultMaterial.clone());
            halfHeight = 0.1;
            break;
        case 'cube':
            objectMesh = new THREE.Mesh(
                new THREE.BoxGeometry(GRID_CELL_SIZE * 0.8, GRID_CELL_SIZE * 0.8, GRID_CELL_SIZE * 0.8),
                defaultMaterial.clone());
            halfHeight = GRID_CELL_SIZE * 0.4;
            break;
        case 'sphere':
            objectMesh = new THREE.Mesh(
                new THREE.SphereGeometry(GRID_CELL_SIZE * 0.4, 32, 32),
                defaultMaterial.clone());
            halfHeight = GRID_CELL_SIZE * 0.4;
            break;
        case 'character':
            if (data.characterData) {
                // EXPERIMENT: rigged GLTF character. The procedural model shows
                // instantly as a placeholder and swaps out inside the same group
                // once the shared assets arrive (position/selection unaffected).
                // Both seat their soles at -0.38, the procedural foot depth.
                halfHeight = 0.38;
                objectMesh = createRigCharacter(data.characterData, {
                    footY: -0.38,
                    onReady: (g) => {
                        const ph = g.userData.placeholder;
                        if (ph) { g.remove(ph); disposeModel(ph); delete g.userData.placeholder; }
                    }
                });
                const ph = createCharacterModel(data.characterData);
                objectMesh.add(ph);
                objectMesh.userData.placeholder = ph;
            }
            break;
        case 'cave':
        case 'arch':
            objectMesh = createPropMesh(data.type);
            halfHeight = 0;
            break;
        case 'portal':
            objectMesh = createPortalMesh();
            halfHeight = 0;
            break;
        case 'wall':
            // Tile-brush wall run: pieces + baked ground heights live in data
            // (structures.js), position is the run's anchor grid corner.
            objectMesh = buildWallRun(data);
            halfHeight = 0;
            break;
        case 'floor':
            objectMesh = buildFloorPatch(data);
            halfHeight = 0;
            break;
        default:
            return null;
    }
    if (!objectMesh) return null;

    if (data.type === 'portal') {
        objectMesh.userData.portalTarget = data.target || null;
        objectMesh.userData.portalName = data.name || 'Portal';
    }

    objectMesh.position.set(data.position.x, data.position.y, data.position.z);
    objectMesh.castShadow = true;
    objectMesh.receiveShadow = true;
    objectMesh.userData.halfHeight = halfHeight;
    objectMesh.userData.syncId = id;
    if (data.type === 'character') {
        objectMesh.userData.characterData = data.characterData;
    } else {
        objectMesh.userData.objectType = data.type;
    }
    return objectMesh;
}

// Apply a move-tool drag. computeY(x, z, halfHeight, currentY) decides the height:
// the GM seats objects on the terrain surface, the player keeps the current height
// clamped above the ground. 'y-only' height dragging is handled by the pages.
export function applyMove(object, newPosition, mode, computeY) {
    if (!object) return;
    const halfHeight = object.userData.halfHeight || 0;
    switch (mode) {
        case 'standard':
            object.position.x = newPosition.x;
            object.position.z = newPosition.z;
            break;
        case 'x-only':
            object.position.x = newPosition.x;
            break;
        case 'z-only':
            object.position.z = newPosition.z;
            break;
        default: // 'y-only'
            return;
    }
    object.position.y = computeY(object.position.x, object.position.z, halfHeight, object.position.y);
}
