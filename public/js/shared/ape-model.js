// ape-model.js - original, procedural SRD Ape model shared by both tabletop views.
//
// The Ape is intentionally built as a named joint hierarchy instead of one
// anonymous mesh.  It can be posed immediately by rotating the exported joint
// names, and the hierarchy is suitable for a later skinned-mesh replacement.
// Its local origin preserves the historical token seating contract: the feet
// extend APE_MODEL_GROUND_OFFSET below the synced object position.

import * as THREE from 'three';

export const APE_MODEL_GROUND_OFFSET = 0.1;
export const DEFAULT_APE_VARIANT = 'silverback';

export const APE_RIG_JOINTS = Object.freeze([
    'ApeRigRoot',
    'ApePelvis',
    'ApeSpine',
    'ApeChest',
    'ApeNeck',
    'ApeHead',
    'ApeJaw',
    'ApeShoulder.L',
    'ApeElbow.L',
    'ApeWrist.L',
    'ApeShoulder.R',
    'ApeElbow.R',
    'ApeWrist.R',
    'ApeHip.L',
    'ApeKnee.L',
    'ApeAnkle.L',
    'ApeHip.R',
    'ApeKnee.R',
    'ApeAnkle.R'
]);

// Stable IDs are persisted by the map object.  Labels and descriptions are UI
// copy; consumers should store only the id.
export const APE_VARIANTS = Object.freeze([
    Object.freeze({
        id: 'silverback',
        label: 'Silverback',
        description: 'Heavy charcoal coat, silver saddle and a broad mature build.',
        texture: '/assets/monsters/ape/silverback-fur.webp',
        colors: Object.freeze({
            fur: 0x171b1d,
            furAccent: 0x292e30,
            saddle: 0x7a7e7c,
            skin: 0x25282a,
            muzzle: 0x343638,
            nose: 0x0b0d0e,
            eye: 0x6c4a22
        }),
        build: Object.freeze({ torso: 1.08, shoulder: 1.08, belly: 1.04, brow: 1.06, furClumps: 1.0 })
    }),
    Object.freeze({
        id: 'highland',
        label: 'Highland',
        description: 'Long warm-brown coat with tawny tips and a lean climbing build.',
        texture: '/assets/monsters/ape/highland-fur.webp',
        colors: Object.freeze({
            fur: 0x493225,
            furAccent: 0x6b4930,
            saddle: 0x7d5a3c,
            skin: 0x34271f,
            muzzle: 0x594435,
            nose: 0x15100d,
            eye: 0xa8732e
        }),
        build: Object.freeze({ torso: 0.98, shoulder: 0.98, belly: 0.94, brow: 0.97, furClumps: 1.18 })
    }),
    Object.freeze({
        id: 'albino',
        label: 'Albino',
        description: 'Ivory coat, pale skin and rose eyes with a lighter frame.',
        texture: '/assets/monsters/ape/albino-fur.webp',
        colors: Object.freeze({
            fur: 0xe1ddd2,
            furAccent: 0xf0ede5,
            saddle: 0xc9c4b9,
            skin: 0xd6aaa0,
            muzzle: 0xe2bbb0,
            nose: 0x9b716f,
            eye: 0xaa3041
        }),
        build: Object.freeze({ torso: 0.94, shoulder: 0.94, belly: 0.92, brow: 0.94, furClumps: 0.96 })
    })
]);

const VARIANT_BY_ID = new Map(APE_VARIANTS.map(variant => [variant.id, variant]));
const textureCache = new Map();

export function normalizeApeVariant(value) {
    const id = String(value == null ? '' : value).trim().toLowerCase();
    return VARIANT_BY_ID.has(id) ? id : DEFAULT_APE_VARIANT;
}

export function apeVariantDefinition(value) {
    return VARIANT_BY_ID.get(normalizeApeVariant(value));
}

function configureColorTexture(texture) {
    texture.wrapS = THREE.MirroredRepeatWrapping;
    texture.wrapT = THREE.MirroredRepeatWrapping;
    texture.repeat.set(2, 2);
    // r132 (currently vendored) uses encoding; colorSpace keeps this correct if
    // the project later upgrades Three.js.
    if ('colorSpace' in texture && THREE.SRGBColorSpace) {
        texture.colorSpace = THREE.SRGBColorSpace;
    } else if (THREE.sRGBEncoding != null) {
        texture.encoding = THREE.sRGBEncoding;
    }
    texture.anisotropy = 4;
    if (!texture.userData) texture.userData = {};
    texture.userData.apeSharedTexture = true;
    texture.needsUpdate = true;
}

// At most one texture object is retained per variant for the lifetime of the
// page.  Models own their geometries/materials (and normal disposal traversals
// can release those), while these three immutable maps are intentionally shared.
// A missing asset leaves every material's full procedural-color fallback intact.
function requestVariantTexture(variant, onReady, onError) {
    let state = textureCache.get(variant.id);
    if (state?.status === 'ready') {
        onReady(state.texture);
        return;
    }
    if (state?.status === 'failed') {
        onError();
        return;
    }
    if (state) {
        state.ready.push(onReady);
        state.error.push(onError);
        return;
    }

    state = { status: 'loading', texture: null, ready: [onReady], error: [onError] };
    textureCache.set(variant.id, state);
    const pending = new THREE.TextureLoader().load(
        variant.texture,
        texture => {
            configureColorTexture(texture);
            state.status = 'ready';
            state.texture = texture;
            const callbacks = state.ready.splice(0);
            state.error.length = 0;
            callbacks.forEach(callback => callback(texture));
        },
        undefined,
        () => {
            state.status = 'failed';
            if (pending?.dispose) pending.dispose();
            state.texture = null;
            const callbacks = state.error.splice(0);
            state.ready.length = 0;
            callbacks.forEach(callback => callback());
        }
    );
}

function material(color, roughness = 0.9, options = {}) {
    const result = new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness: 0,
        ...options
    });
    result.userData.apeMaterial = true;
    return result;
}

function markMesh(mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // disposeBuiltObject already skips shared structural geometry and releases
    // geometry carrying this marker.  Ape geometry is unique to each instance.
    mesh.userData.ownGeometry = true;
    mesh.userData.apePart = true;
    return mesh;
}

function addMesh(parent, name, geometry, meshMaterial, position = [0, 0, 0], rotation = [0, 0, 0]) {
    const mesh = markMesh(new THREE.Mesh(geometry, meshMaterial));
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
}

function geometryPart(geometry, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
    return { geometry, position, rotation, scale };
}

function spherePart(radii, position, segments = 14, rotation = [0, 0, 0]) {
    return geometryPart(
        new THREE.SphereGeometry(1, segments, Math.max(8, Math.round(segments * 0.72))),
        position,
        rotation,
        radii
    );
}

function cylinderPart(length, topRadius, bottomRadius, position = [0, 0, 0], rotation = [0, 0, 0]) {
    return geometryPart(
        new THREE.CylinderGeometry(bottomRadius, topRadius, length, 12, 3),
        [position[0], position[1] - length / 2, position[2]],
        rotation
    );
}

function conePart(radius, height, position, rotation = [0, 0, 0], scale = [1, 1, 1]) {
    return geometryPart(new THREE.ConeGeometry(radius, height, 7), position, rotation, scale);
}

// Merge same-material primitives into one draw call while retaining UVs and
// normals. Parts stay grouped by anatomical joint, so poseability is unchanged.
function mergeGeometryParts(parts) {
    const flattened = parts.map(part => {
        const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(...part.position),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)),
            new THREE.Vector3(...part.scale)
        );
        geometry.applyMatrix4(matrix);
        part.geometry.dispose();
        return geometry;
    });
    const merged = new THREE.BufferGeometry();
    for (const attributeName of ['position', 'normal', 'uv']) {
        const attributes = flattened.map(geometry => geometry.getAttribute(attributeName));
        if (attributes.some(attribute => !attribute)) continue;
        const itemSize = attributes[0].itemSize;
        const count = attributes.reduce((sum, attribute) => sum + attribute.array.length, 0);
        const values = new Float32Array(count);
        let offset = 0;
        for (const attribute of attributes) {
            values.set(attribute.array, offset);
            offset += attribute.array.length;
        }
        merged.setAttribute(attributeName, new THREE.BufferAttribute(values, itemSize));
    }
    flattened.forEach(geometry => geometry.dispose());
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
}

function addCompositeMesh(parent, name, parts, meshMaterial) {
    return addMesh(parent, name, mergeGeometryParts(parts), meshMaterial);
}

function addEllipsoid(parent, name, radii, position, meshMaterial, segments = 18) {
    const mesh = addMesh(
        parent,
        name,
        new THREE.SphereGeometry(1, segments, Math.max(10, Math.round(segments * 0.72))),
        meshMaterial,
        position
    );
    mesh.scale.set(...radii);
    return mesh;
}

function addJoint(parent, name, position, rotation = [0, 0, 0]) {
    const joint = new THREE.Bone();
    joint.name = name;
    joint.position.set(...position);
    joint.rotation.set(...rotation);
    joint.userData.isApeRigJoint = true;
    parent.add(joint);
    return joint;
}

function addHand(wrist, side, materials) {
    const parts = [spherePart([0.15, 0.115, 0.115], [0, -0.105, 0.055], 14, [0.2, 0, 0])];
    const direction = side === 'L' ? -1 : 1;
    for (let finger = 0; finger < 4; finger++) {
        const x = (finger - 1.5) * 0.055;
        parts.push(spherePart(
            [0.038, 0.045, 0.048],
            [x, -0.205, 0.1 + Math.abs(finger - 1.5) * 0.008],
            10,
            [0.18, 0, 0]
        ));
    }
    parts.push(spherePart(
        [0.045, 0.08, 0.045],
        [direction * 0.135, -0.12, 0.07],
        10,
        [0, 0, direction * 0.65]
    ));
    addCompositeMesh(wrist, `ApePalm.${side}`, parts, materials.skin);
}

function addFoot(ankle, side, materials) {
    const parts = [spherePart([0.15, 0.075, 0.245], [0, -0.04, 0.13], 14, [-0.05, 0, 0])];
    for (let toe = 0; toe < 4; toe++) {
        const x = (toe - 1.5) * 0.055;
        parts.push(spherePart(
            [0.035, 0.03, 0.075 - Math.abs(toe - 1.5) * 0.006],
            [x, -0.058, 0.325 - Math.abs(toe - 1.5) * 0.008],
            9
        ));
    }
    const direction = side === 'L' ? -1 : 1;
    parts.push(spherePart(
        [0.042, 0.035, 0.09],
        [direction * 0.13, -0.048, 0.2],
        9,
        [0, direction * 0.48, 0]
    ));
    addCompositeMesh(ankle, `ApeFoot.${side}`, parts, materials.skin);
}

function addArm(chest, side, build, materials) {
    const direction = side === 'L' ? -1 : 1;
    const shoulder = addJoint(
        chest,
        `ApeShoulder.${side}`,
        [direction * 0.405 * build.shoulder, 0.04, 0],
        [-0.08, 0, direction * -0.09]
    );
    addCompositeMesh(shoulder, `ApeUpperArm.${side}`, [
        spherePart([0.2, 0.22, 0.2], [0, -0.08, 0], 16),
        cylinderPart(0.52, 0.15, 0.125, [0, -0.06, 0])
    ], materials.fur);

    const elbow = addJoint(shoulder, `ApeElbow.${side}`, [0, -0.54, 0.045], [-0.2, 0, direction * 0.05]);
    const forearmParts = [
        spherePart([0.135, 0.14, 0.135], [0, -0.025, 0], 13),
        cylinderPart(0.54, 0.14, 0.105, [0, -0.03, 0.02])
    ];
    const clumpCount = build.furClumps > 1.1 ? 4 : 3;
    for (let index = 0; index < clumpCount; index++) {
        forearmParts.push(conePart(
            0.055,
            0.18,
            [direction * (0.085 + (index % 2) * 0.018), -0.14 - index * 0.105, -0.045],
            [0.12, 0, direction * (0.22 + index * 0.04)],
            [build.furClumps, build.furClumps, build.furClumps]
        ));
    }
    addCompositeMesh(elbow, `ApeForearm.${side}`, forearmParts, materials.furAccent);

    const wrist = addJoint(elbow, `ApeWrist.${side}`, [0, -0.55, 0.09], [0.18, 0, direction * 0.04]);
    addHand(wrist, side, materials);
}

function addLeg(pelvis, side, materials) {
    const direction = side === 'L' ? -1 : 1;
    const hip = addJoint(pelvis, `ApeHip.${side}`, [direction * 0.22, -0.02, 0], [0.2, 0, direction * 0.06]);
    addCompositeMesh(hip, `ApeThigh.${side}`, [
        spherePart([0.19, 0.22, 0.2], [0, -0.04, -0.025], 15),
        cylinderPart(0.37, 0.16, 0.13, [0, -0.07, 0])
    ], materials.fur);

    const knee = addJoint(hip, `ApeKnee.${side}`, [0, -0.39, 0.08], [-0.38, 0, direction * -0.03]);
    addCompositeMesh(knee, `ApeShin.${side}`, [
        spherePart([0.12, 0.12, 0.13], [0, -0.02, 0.06], 12),
        cylinderPart(0.29, 0.12, 0.09, [0, -0.04, 0])
    ], materials.furAccent);

    const ankle = addJoint(knee, `ApeAnkle.${side}`, [0, -0.3, -0.05], [0.22, 0, 0]);
    addFoot(ankle, side, materials);
}

function addHead(neck, build, materials) {
    const head = addJoint(neck, 'ApeHead', [0, 0.17, 0.075], [-0.06, 0, 0]);
    addEllipsoid(head, 'ApeCranium', [0.29, 0.32, 0.27], [0, 0.07, 0], materials.fur, 22);
    addCompositeMesh(head, 'ApeFaceMask', [
        spherePart([0.235, 0.23, 0.105], [0, 0.0, 0.245], 18),
        spherePart([0.075, 0.105, 0.035], [-0.275, 0.045, 0.02], 13),
        spherePart([0.075, 0.105, 0.035], [0.275, 0.045, 0.02], 13)
    ], materials.skin);

    // Heavy supraorbital ridge and deep-set eyes give a readable ape profile at
    // tabletop scale without borrowing any protected bestiary artwork.
    addCompositeMesh(head, 'ApeMuzzle', [
        spherePart([0.255 * build.brow, 0.07, 0.075], [0, 0.105, 0.315], 16, [-0.1, 0, 0]),
        spherePart([0.22, 0.135, 0.18], [0, -0.07, 0.315], 18),
        spherePart([0.045, 0.07, 0.018], [-0.287, 0.045, 0.047], 11),
        spherePart([0.045, 0.07, 0.018], [0.287, 0.045, 0.047], 11)
    ], materials.muzzle);
    addCompositeMesh(head, 'ApeEyes', [
        spherePart([0.042, 0.038, 0.025], [-0.09, 0.075, 0.333], 12),
        spherePart([0.042, 0.038, 0.025], [0.09, 0.075, 0.333], 12)
    ], materials.eyeWhite);
    addCompositeMesh(head, 'ApeIrises', [
        spherePart([0.023, 0.023, 0.014], [-0.09, 0.074, 0.354], 10),
        spherePart([0.023, 0.023, 0.014], [0.09, 0.074, 0.354], 10)
    ], materials.eye);
    addCompositeMesh(head, 'ApeEyeGlints', [
        spherePart([0.006, 0.006, 0.006], [-0.083, 0.082, 0.366], 7),
        spherePart([0.006, 0.006, 0.006], [0.083, 0.082, 0.366], 7)
    ], materials.glint);
    addEllipsoid(head, 'ApeNose', [0.13, 0.075, 0.07], [0, -0.015, 0.455], materials.nose, 15);
    addCompositeMesh(head, 'ApeNostrils', [
        spherePart([0.025, 0.014, 0.012], [-0.05, -0.02, 0.515], 9),
        spherePart([0.025, 0.014, 0.012], [0.05, -0.02, 0.515], 9)
    ], materials.mouth);

    const jaw = addJoint(head, 'ApeJaw', [0, -0.11, 0.31], [0.03, 0, 0]);
    addEllipsoid(jaw, 'ApeLowerMuzzle', [0.19, 0.09, 0.145], [0, -0.025, 0.045], materials.muzzle, 16);
    addMesh(jaw, 'ApeMouthLine', new THREE.BoxGeometry(0.245, 0.012, 0.012), materials.mouth, [0, 0.002, 0.17]);
    addCompositeMesh(jaw, 'ApeCanines', [
        conePart(0.016, 0.065, [-0.105, -0.025, 0.17], [0, 0, Math.PI]),
        conePart(0.016, 0.065, [0.105, -0.025, 0.17], [0, 0, Math.PI])
    ], materials.tooth);
}

function createMaterials(variant) {
    const colors = variant.colors;
    return {
        fur: material(colors.fur, 0.96),
        furAccent: material(colors.furAccent, 0.95),
        saddle: material(colors.saddle, 0.93),
        skin: material(colors.skin, 0.82),
        muzzle: material(colors.muzzle, 0.86),
        nose: material(colors.nose, 0.72),
        mouth: material(0x120b0b, 0.7),
        tooth: material(0xe7dfc9, 0.7),
        eyeWhite: material(0x201b18, 0.42),
        eye: material(colors.eye, 0.3),
        glint: new THREE.MeshBasicMaterial({ color: 0xffffff })
    };
}

function applyTexture(materials, texture) {
    for (const [meshMaterial, tint] of [
        [materials.fur, 0xffffff],
        [materials.furAccent, 0xe8e8e8]
    ]) {
        meshMaterial.map = texture;
        meshMaterial.bumpMap = texture;
        meshMaterial.bumpScale = 0.018;
        meshMaterial.color.setHex(tint);
        meshMaterial.needsUpdate = true;
    }
    // Preserve the variant's authored saddle color (most importantly the
    // Silverback's gray back) while sharing the same fur map for strand relief.
    materials.saddle.bumpMap = texture;
    materials.saddle.bumpScale = 0.018;
    materials.saddle.needsUpdate = true;
}

/**
 * Build a complete medium Ape scene object.
 *
 * @param {{variant?: string, loadTextures?: boolean}} options
 * @returns {THREE.Group} local feet sit 0.1 below the returned group's origin
 */
export function createApeModel({ variant: requestedVariant = DEFAULT_APE_VARIANT, loadTextures = true } = {}) {
    const variant = apeVariantDefinition(requestedVariant);
    const build = variant.build;
    const materials = createMaterials(variant);

    const model = new THREE.Group();
    model.name = 'ApeModel';
    model.userData.monsterModel = 'ape';
    model.userData.monsterVariant = variant.id;
    model.userData.variantLabel = variant.label;
    model.userData.rigJointNames = [...APE_RIG_JOINTS];
    // ObjectNameplates uses this visual-height contract instead of the flat
    // token offset; its 0.48-high sprite then clears the Ape's head.
    model.userData.nameplateY = 1.52;
    model.userData.texturePath = variant.texture;
    // TextureLoader needs a DOM; without one (Node tests, manifest builds) the
    // procedural coat colours stay.
    model.userData.textureStatus = loadTextures && typeof document !== 'undefined' ? 'loading' : 'disabled';
    model.userData.disposed = false;
    model.userData.onDispose = () => {
        model.userData.disposed = true;
    };

    const visual = new THREE.Group();
    visual.name = 'ApeVisual';
    // One world unit is a five-foot tactical square. The 0.62 scale makes this
    // crouched Medium ape roughly 5.5 feet tall; the offset seats it on terrain.
    visual.scale.setScalar(0.62);
    visual.position.y = -0.033;
    model.add(visual);

    const rigRoot = addJoint(visual, 'ApeRigRoot', [0, 0, 0]);
    const pelvis = addJoint(rigRoot, 'ApePelvis', [0, 0.76, 0], [0.07, 0, 0]);
    addCompositeMesh(pelvis, 'ApePelvisMass', [
        spherePart([0.34, 0.3, 0.3], [0, 0.02, -0.015], 18),
        spherePart([0.31 * build.belly, 0.36, 0.27 * build.belly], [0, 0.22, 0.06], 18)
    ], materials.fur);

    const spine = addJoint(pelvis, 'ApeSpine', [0, 0.18, -0.015], [-0.04, 0, 0]);
    addEllipsoid(spine, 'ApeLowerTorso', [0.36 * build.torso, 0.36, 0.3], [0, 0.14, 0], materials.fur, 19);
    const chest = addJoint(spine, 'ApeChest', [0, 0.3, -0.02], [-0.02, 0, 0]);
    addCompositeMesh(chest, 'ApeRibcage', [
        spherePart([0.44 * build.shoulder, 0.34, 0.32 * build.torso], [0, 0.0, 0.015], 20),
        spherePart([0.32, 0.23, 0.035], [0, 0.0, 0.32], 16)
    ], materials.fur);
    addEllipsoid(chest, 'ApeBackSaddle', [0.39 * build.shoulder, 0.25, 0.045], [0, 0.015, -0.3], materials.saddle, 17);

    const neck = addJoint(chest, 'ApeNeck', [0, 0.18, 0.04], [-0.08, 0, 0]);
    addEllipsoid(neck, 'ApeNeckMass', [0.235, 0.22, 0.22], [0, 0.06, 0], materials.furAccent, 16);
    addHead(neck, build, materials);
    addArm(chest, 'L', build, materials);
    addArm(chest, 'R', build, materials);
    addLeg(pelvis, 'L', materials);
    addLeg(pelvis, 'R', materials);

    // Shoulder/neck tufts break the primitive silhouette and give the highland
    // variant a visibly longer coat even before its texture has loaded.
    const shoulderFurParts = [];
    for (const side of [-1, 1]) {
        for (let index = 0; index < 4; index++) {
            shoulderFurParts.push(conePart(
                0.055,
                0.18,
                [side * (0.24 + index * 0.045), 0.18 - index * 0.025, -0.16 + index * 0.025],
                [0.2, 0, side * (0.45 + index * 0.1)],
                [build.furClumps, build.furClumps, build.furClumps]
            ));
        }
    }
    addCompositeMesh(chest, 'ApeShoulderFur', shoulderFurParts, materials.furAccent);

    if (loadTextures && typeof document !== 'undefined') {
        requestVariantTexture(
            variant,
            texture => {
                if (model.userData.disposed) return;
                applyTexture(materials, texture);
                model.userData.textureStatus = 'ready';
            },
            () => {
                if (model.userData.disposed) return;
                model.userData.textureStatus = 'fallback';
            }
        );
    }

    return model;
}

// Optional direct cleanup for consumers that own an Ape outside the synced map
// object lifecycle. Shared cached fur maps are deliberately not disposed here.
export function disposeApeModel(model) {
    if (!model || model.userData?.disposed) return;
    model.userData.disposed = true;
    const geometries = new Set();
    const materials = new Set();
    model.traverse(object => {
        if (object.userData?.ownGeometry && object.geometry) geometries.add(object.geometry);
        const ownMaterials = Array.isArray(object.material) ? object.material : [object.material];
        ownMaterials.filter(Boolean).forEach(item => materials.add(item));
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(meshMaterial => meshMaterial.dispose());
}
