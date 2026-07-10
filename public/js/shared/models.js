// models.js — token, prop and character meshes shared by the GM and player screens,
// plus movement helpers. All synced objects are built from server data through
// buildObjectFromData so both screens render identical scenes.

import * as THREE from 'three';
import { GRID_CELL_SIZE } from './scene.js';
import { buildWallRun, buildFloorPatch } from './structures.js';

export const defaultMaterial = new THREE.MeshLambertMaterial({ color: 0xdd4444 });
export const selectedMaterial = new THREE.MeshLambertMaterial({ color: 0xffff44, emissive: 0xaaaa00 });

// --- Character models (per-part colors + proportions) ---
const BASE_TORSO_HEIGHT = 1;
const BASE_HEAD_RADIUS = 0.4;
const BASE_ARM_LENGTH = 0.8;

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

export function createCharacterModel(charData) {
    const modelGroup = new THREE.Group();
    const col = charColors(charData);
    const skinMat = new THREE.MeshLambertMaterial({ color: col.skin });
    const torsoMat = new THREE.MeshLambertMaterial({ color: col.torso });
    const legsMat = new THREE.MeshLambertMaterial({ color: col.legs });
    const hairMat = new THREE.MeshLambertMaterial({ color: col.hair });
    const eyeMat = new THREE.MeshBasicMaterial({ color: col.eyes });

    const add = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; modelGroup.add(m); return m; };
    add(new THREE.CylinderGeometry(0.3, 0.3, BASE_TORSO_HEIGHT, 32), torsoMat, 'torso');
    add(new THREE.SphereGeometry(BASE_HEAD_RADIUS, 32, 32), skinMat, 'head');
    add(new THREE.SphereGeometry(BASE_HEAD_RADIUS * 1.02, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat, 'hair');
    add(new THREE.SphereGeometry(0.05, 16, 16), eyeMat, 'leftEye');
    add(new THREE.SphereGeometry(0.05, 16, 16), eyeMat, 'rightEye');
    add(new THREE.CylinderGeometry(0.08, 0.08, BASE_ARM_LENGTH, 16), skinMat, 'leftArm');
    add(new THREE.CylinderGeometry(0.08, 0.08, BASE_ARM_LENGTH, 16), skinMat, 'rightArm');
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 16), legsMat, 'leftLeg');
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 16), legsMat, 'rightLeg');

    updateCharacterAppearance(modelGroup, charData.appearance || {});
    modelGroup.scale.set(0.4, 0.4, 0.4);
    return modelGroup;
}

export function updateCharacterAppearance(modelGroup, appearance) {
    const H = appearance.height || 1;
    const B = appearance.build || 1;
    const HS = appearance.headSize || 1;
    const AL = appearance.armLength || 1;
    const LL = appearance.legLength || 1;
    const g = (n) => modelGroup.getObjectByName(n);
    const torso = g('torso'), head = g('head'), hair = g('hair'),
          leftEye = g('leftEye'), rightEye = g('rightEye'),
          leftArm = g('leftArm'), rightArm = g('rightArm'),
          leftLeg = g('leftLeg'), rightLeg = g('rightLeg');

    torso.scale.set(B, H, B);
    torso.position.y = (BASE_TORSO_HEIGHT * H) / 2 - 0.5;
    head.scale.set(HS, HS, HS);
    const hr = BASE_HEAD_RADIUS * HS;
    head.position.y = (BASE_TORSO_HEIGHT * H) + hr - 0.5;
    if (hair) { hair.scale.set(HS, HS, HS); hair.position.y = head.position.y; }
    leftEye.position.set(-0.13 * HS, head.position.y + 0.1 * HS, hr - 0.05);
    rightEye.position.set(0.13 * HS, head.position.y + 0.1 * HS, hr - 0.05);
    leftArm.scale.set(B, AL, B); rightArm.scale.set(B, AL, B);
    const ay = torso.position.y + (BASE_TORSO_HEIGHT * H / 2) - (BASE_ARM_LENGTH * AL / 2);
    leftArm.position.set(-0.4 * B, ay, 0); rightArm.position.set(0.4 * B, ay, 0);
    leftLeg.scale.set(B, LL, B); rightLeg.scale.set(B, LL, B);
    const ly = torso.position.y - (BASE_TORSO_HEIGHT * H / 2);
    leftLeg.position.set(-0.15 * B, ly, 0); rightLeg.position.set(0.15 * B, ly, 0);
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
                objectMesh = createCharacterModel(data.characterData);
                // Seat the model on its feet: the group origin sits above the
                // soles (and the offset varies with build/leg length), so measure
                // the actual bottom instead of guessing from height. groundY adds
                // this back so position.y + box.min.y lands the feet on the ground.
                const box = new THREE.Box3().setFromObject(objectMesh);
                halfHeight = -box.min.y;
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
