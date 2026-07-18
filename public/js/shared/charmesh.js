// charmesh.js — EXPERIMENT (worktree branch): rigged, animated GLTF characters.
// Assets are Quaternius "Universal Base Characters" + "Universal Animation
// Library" (both CC0), which share one UE-style humanoid rig, vendored under
// /assets/characters/. The bodies load once; each character is a skeleton
// clone (SkeletonUtils) and the UAL clips play directly on it — bone names
// match 1:1, no retargeting. createRigCharacter returns a group immediately
// and fills it in when the shared assets arrive, so callers stay synchronous.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const ASSET_BASE = '/assets/characters/';
const BODIES = {
    male: 'base/Superhero_Male_FullBody.gltf',
    female: 'base/Superhero_Female_FullBody.gltf'
};
// Human height in grid units (1u = 5ft): ~5'9".
const TARGET_HEIGHT = 1.15;

let _assetsPromise = null;

export function loadCharacterAssets() {
    if (_assetsPromise) return _assetsPromise;
    const loader = new GLTFLoader();
    const load = (url) => new Promise((res, rej) => loader.load(ASSET_BASE + url, res, undefined, rej));
    _assetsPromise = Promise.all([
        load(BODIES.male), load(BODIES.female), load('UAL1_Standard.glb')
    ]).then(([male, female, anims]) => ({
        bodies: { male: male.scene, female: female.scene },
        clips: anims.animations
    }));
    return _assetsPromise;
}

// Live mixers, ticked once per frame from each page's render loop.
const _mixers = new Set();
const _clock = new THREE.Clock();
export function tickRigCharacters() {
    const dt = _clock.getDelta();
    for (const m of _mixers) m.update(dt);
}

// Build an animated character group from saved character data. Options:
//   footY   — group-local y the soles should rest at (0 for the creator
//             preview, -0.38 for tabletop objects, matching halfHeight).
//   onReady — called with the group once the mesh is in place.
export function createRigCharacter(charData, { footY = 0, onReady } = {}) {
    const group = new THREE.Group();
    group.userData.rigCharacter = true;
    loadCharacterAssets().then(({ bodies, clips }) => {
        if (group.userData.disposed) return;
        const ap = charData.appearance || {};
        const col = (charData.appearance && charData.appearance.colors) || {};
        const src = bodies[ap.body === 'female' ? 'female' : 'male'];
        const inner = cloneSkinned(src);

        // Per-character materials so tints don't leak across clones. The body
        // texture stays authored (it IS the skin); hair takes the hair color.
        const owned = [];
        inner.traverse(o => {
            if (!o.isMesh && !o.isSkinnedMesh) return;
            o.castShadow = true;
            o.material = o.material.clone();
            owned.push(o.material);
            const name = o.material.name || '';
            if (/hair/i.test(name) && col.hair) o.material.color.set(col.hair);
            if (/superhero/i.test(name) && col.skin) {
                // Soft tint toward the chosen skin color (multiply can only
                // darken, so blend gently instead of stamping the hex on).
                o.material.color.lerp(new THREE.Color(col.skin), 0.35);
            }
        });
        group.userData.ownedMaterials = owned;

        // Scale to the tabletop and seat the soles at footY.
        const H = ap.height || 1, B = ap.build || 1;
        const box = new THREE.Box3().setFromObject(inner);
        const s = (TARGET_HEIGHT * H) / (box.max.y - box.min.y);
        inner.scale.set(s * B, s, s * B);
        const box2 = new THREE.Box3().setFromObject(inner);
        inner.position.y = footY - box2.min.y;
        group.add(inner);

        const mixer = new THREE.AnimationMixer(inner);
        _mixers.add(mixer);
        group.userData.mixer = mixer;
        group.userData.clips = clips;
        group.userData.playClip = (clipName, fade = 0.25) => {
            const clip = THREE.AnimationClip.findByName(clips, clipName);
            if (!clip) return null;
            const action = mixer.clipAction(clip);
            mixer.stopAllAction();
            action.reset().fadeIn(fade).play();
            return action;
        };
        group.userData.playClip('Idle_Loop', 0);
        if (onReady) onReady(group);
    }).catch(err => console.error('charmesh: failed to load character assets', err));
    return group;
}

// Detach a character built here: unhook its mixer and drop its per-clone
// materials (geometry/textures are shared with the cached source — keep them).
export function releaseRigCharacter(group) {
    group.userData.disposed = true;
    if (group.userData.mixer) {
        group.userData.mixer.stopAllAction();
        _mixers.delete(group.userData.mixer);
    }
    (group.userData.ownedMaterials || []).forEach(m => m.dispose());
}
