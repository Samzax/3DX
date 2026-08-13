// object-ui.js — shared visual identity for synced tabletop objects.
//
// The scene meshes remain gameplay-owned. This module adds the lightweight UX
// layer around them: readable token nameplates, deterministic instance numbers
// for duplicate characters/tokens, and a selection ring that works for groups
// as well as simple meshes.

import * as THREE from 'three';

function colorValue(value, fallback = '#7f8a99') {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `#${Math.max(0, Math.min(0xffffff, value)).toString(16).padStart(6, '0')}`;
    }
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function sourceData(object) {
    return (object && object.userData && object.userData.objectData) || {};
}

function identityBase(object) {
    const data = sourceData(object);
    const char = object && object.userData && object.userData.characterData;
    if (char) {
        return {
            key: `character:${char.id || `${char.owner || ''}:${char.name || ''}`}`,
            name: char.name || 'Adventurer',
            color: colorValue(char.color || char.appearance?.colors?.torso, '#6ea8fe'),
            type: 'character'
        };
    }
    const type = (object && object.userData && object.userData.objectType) || data.type || 'object';
    const labels = {
        token: 'Token', cube: 'Cube', sphere: 'Sphere', cave: 'Cave', arch: 'Rock Arch',
        portal: data.name || object?.userData?.portalName || 'Portal', wall: 'Wall', floor: 'Floor'
    };
    const name = data.name || labels[type] || type.replace(/(^|-)(\w)/g, (_, __, c) => ` ${c.toUpperCase()}`).trim();
    return {
        key: `${type}:${String(name).toLowerCase()}`,
        name,
        color: colorValue(data.color, type === 'token' ? '#dd4444' : '#7f8a99'),
        type
    };
}

// Duplicate numbering is based on sync ids, so every connected screen shows
// the same "Aria · 2" even if object-added events arrive in a different order.
export function objectIdentity(object, objects = []) {
    const base = identityBase(object);
    const matches = objects
        .filter(candidate => identityBase(candidate).key === base.key)
        .slice()
        .sort((a, b) => String(a.userData.syncId || '').localeCompare(String(b.userData.syncId || '')));
    const index = Math.max(0, matches.indexOf(object));
    const count = Math.max(1, matches.length);
    return {
        ...base,
        index,
        count,
        displayName: count > 1 ? `${base.name} · ${index + 1}` : base.name,
        instanceText: count > 1 ? `Instance ${index + 1} of ${count}` : 'Single instance'
    };
}

function makeNameplate(text, accent) {
    const canvas = document.createElement('canvas');
    canvas.height = 96;
    const safeText = String(text || '').slice(0, 38);
    let ctx = canvas.getContext('2d');
    ctx.font = '700 34px system-ui, -apple-system, sans-serif';
    const measured = Math.min(455, Math.ceil(ctx.measureText(safeText).width));
    const width = Math.max(116, measured + 62);
    canvas.width = width;
    ctx = canvas.getContext('2d');
    ctx.font = '700 34px system-ui, -apple-system, sans-serif';
    const x = 0;

    ctx.fillStyle = 'rgba(9, 12, 18, 0.86)';
    ctx.beginPath();
    ctx.roundRect(x, 14, width, 64, 18);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x + 8, 22, 8, 48, 4);
    ctx.fill();
    ctx.fillStyle = '#f4f7fb';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(safeText, canvas.width / 2 + 4, 47, width - 38);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false
    }));
    const ratio = width / 96;
    sprite.scale.set(Math.max(1.25, ratio * 0.48), 0.48, 1);
    sprite.renderOrder = 1200;
    sprite.raycast = () => {};
    sprite.userData.objectNameplate = true;
    sprite.userData.nameplateKey = `${safeText}|${accent}`;
    return sprite;
}

export class ObjectNameplates {
    sync(objects = []) {
        const labelable = new Set(objects.filter(object => {
            const type = identityBase(object).type;
            return type === 'character' || type === 'token';
        }));

        for (const object of objects) {
            const existing = object.userData.objectNameplate;
            if (!labelable.has(object)) {
                if (existing) this.removeFrom(object);
                continue;
            }
            const identity = objectIdentity(object, objects);
            const key = `${identity.displayName}|${identity.color}`;
            if (existing && existing.userData.nameplateKey === key) continue;
            if (existing) this.removeFrom(object);
            const sprite = makeNameplate(identity.displayName, identity.color);
            sprite.position.set(0, Math.max(0.72, (object.userData.halfHeight || 0) + 0.78), 0);
            object.add(sprite);
            object.userData.objectNameplate = sprite;
        }
    }

    removeFrom(object) {
        const sprite = object && object.userData && object.userData.objectNameplate;
        if (!sprite) return;
        object.remove(sprite);
        if (sprite.material?.map) sprite.material.map.dispose();
        if (sprite.material) sprite.material.dispose();
        delete object.userData.objectNameplate;
    }

    clear(objects = []) {
        objects.forEach(object => this.removeFrom(object));
    }
}

export function setObjectSelected(object, selected) {
    if (!object) return;
    const existing = object.userData.workspaceSelectionRing;
    if (!selected) {
        if (!existing) return;
        object.remove(existing);
        if (existing.geometry) existing.geometry.dispose();
        if (existing.material) existing.material.dispose();
        delete object.userData.workspaceSelectionRing;
        return;
    }
    if (existing) return;

    const type = identityBase(object).type;
    const outer = type === 'character' || type === 'token' ? 0.62
        : type === 'cube' || type === 'sphere' ? 0.72
            : type === 'portal' ? 1.05 : 1.3;
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.18, outer - 0.085), outer, 48),
        new THREE.MeshBasicMaterial({
            color: 0x6ea8fe,
            transparent: true,
            opacity: 0.92,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -(object.userData.halfHeight || 0) + 0.025;
    ring.renderOrder = 1190;
    ring.raycast = () => {};
    ring.userData.workspaceSelectionRing = true;
    object.add(ring);
    object.userData.workspaceSelectionRing = ring;
}

export function updateObjectPresentation(object, patch = {}) {
    if (!object || !object.userData) return;
    object.userData.objectData = { ...sourceData(object), ...patch };
    if (patch.name != null && object.userData.objectType === 'portal') {
        object.userData.portalName = String(patch.name);
    }
    if (patch.color != null && object.material && object.material.color) {
        object.material.color.set(patch.color);
    }
}

export function updateObjectPositionData(object) {
    if (!object || !object.userData) return;
    const data = sourceData(object);
    object.userData.objectData = {
        ...data,
        position: { x: object.position.x, y: object.position.y, z: object.position.z }
    };
}
