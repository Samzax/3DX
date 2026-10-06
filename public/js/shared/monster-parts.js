// monster-parts.js — shared primitive kit for the procedural monster pack.
//
// Generators build one static pose from merged primitives: every builder call
// records a transformed geometry under a palette key, and finish() collapses
// each key into a single shadow-casting mesh (a handful of draw calls per
// creature). All creatures are authored facing +Z with their soles on y=0 at a
// natural height of ~1 unit; monster-models.js then scales the result to the
// manifest height and seats it on the tabletop contract (soles 0.1 below the
// synced object origin).

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_COLORS = {
    body: '#9a9a9a',
    accent: '#7d7d7d',
    belly: '#cbc3ad',
    detail: '#4c4c4c',
    horn: '#d9d0b8',
    eye: '#101010',
    glow: '#ffcf7a'
};

// Tapered tube through a polyline — tails, tentacles, necks and snake bodies.
// radius interpolates linearly from rStart to rEnd over the whole run; keep
// rEnd near 0 to close the tip (rings collapse into a soft point).
export function taperedTube(points, rStart, rEnd, tubularSegments = 20, radialSegments = 7) {
    const path = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(point[0], point[1], point[2])));
    const frames = path.computeFrenetFrames(tubularSegments, false);
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let i = 0; i <= tubularSegments; i++) {
        const u = i / tubularSegments;
        path.getPointAt(u, point);
        const radius = rStart + (rEnd - rStart) * u;
        const normalFrame = frames.normals[i];
        const binormal = frames.binormals[i];
        for (let j = 0; j <= radialSegments; j++) {
            const v = (j / radialSegments) * Math.PI * 2;
            const sin = Math.sin(v);
            const cos = -Math.cos(v);
            normal.x = cos * normalFrame.x + sin * binormal.x;
            normal.y = cos * normalFrame.y + sin * binormal.y;
            normal.z = cos * normalFrame.z + sin * binormal.z;
            normal.normalize();
            positions.push(point.x + radius * normal.x, point.y + radius * normal.y, point.z + radius * normal.z);
            normals.push(normal.x, normal.y, normal.z);
            uvs.push(u, j / radialSegments);
        }
    }
    for (let j = 1; j <= tubularSegments; j++) {
        for (let i = 1; i <= radialSegments; i++) {
            const a = (radialSegments + 1) * (j - 1) + (i - 1);
            const b = (radialSegments + 1) * j + (i - 1);
            const c = (radialSegments + 1) * j + i;
            const d = (radialSegments + 1) * (j - 1) + i;
            indices.push(a, b, d, b, c, d);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

// Merge same-material parts into one geometry, baking each part's transform.
// Part geometries are owned by the merge and disposed here.
function mergeParts(parts) {
    const flattened = parts.map(part => {
        const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
        geometry.applyMatrix4(part.matrix);
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

function matrixFrom(position, rotation, scale) {
    return new THREE.Matrix4().compose(
        new THREE.Vector3(position[0], position[1], position[2]),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
        new THREE.Vector3(scale[0], scale[1], scale[2])
    );
}

export class MonsterBuilder {
    constructor(colors = {}, options = {}) {
        this.colors = { ...DEFAULT_COLORS, ...colors };
        this.glowKeys = new Set(options.glow || []);
        this.opacity = Number.isFinite(options.opacity) ? Math.max(0.05, Math.min(1, options.opacity)) : 1;
        this.flatShading = options.flatShading === true;
        this.groups = new Map();
        // Instance transform stack — swarms stamp many copies of one body.
        this._stack = [];
        this._current = new THREE.Matrix4();
    }

    // Push a local transform; every subsequent part is composed with it.
    save(offset = [0, 0, 0], rotationY = 0, scale = 1) {
        const local = matrixFrom(offset, [0, rotationY, 0], [scale, scale, scale]);
        this._stack.push(this._current);
        this._current = this._current.clone().multiply(local);
        return this;
    }

    restore() {
        this._current = this._stack.pop() || new THREE.Matrix4();
        return this;
    }

    _push(key, geometry, matrix) {
        const paletteKey = key || 'body';
        let bucket = this.groups.get(paletteKey);
        if (!bucket) {
            bucket = [];
            this.groups.set(paletteKey, bucket);
        }
        bucket.push({ geometry, matrix: this._current.clone().multiply(matrix) });
    }

    // Generic record: any geometry with an explicit transform.
    part(key, geometry, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
        this._push(key, geometry, matrixFrom(position, rotation, scale));
    }

    ellipsoid(key, radii, position = [0, 0, 0], rotation = [0, 0, 0], segments = 14) {
        const geometry = new THREE.SphereGeometry(1, segments, Math.max(8, Math.round(segments * 0.7)));
        this.part(key, geometry, position, rotation, radii);
    }

    sphere(key, radius, position = [0, 0, 0], segments = 12) {
        this.ellipsoid(key, [radius, radius, radius], position, [0, 0, 0], segments);
    }

    box(key, size, position = [0, 0, 0], rotation = [0, 0, 0]) {
        this.part(key, new THREE.BoxGeometry(size[0], size[1], size[2]), position, rotation);
    }

    // Tapered capsule between two points; r0 sits at `from`, r1 at `to`.
    tube(key, from, to, r0, r1, radial = 9) {
        const start = new THREE.Vector3(from[0], from[1], from[2]);
        const end = new THREE.Vector3(to[0], to[1], to[2]);
        const delta = end.clone().sub(start);
        const length = Math.max(delta.length(), 1e-4);
        const geometry = new THREE.CylinderGeometry(r1, r0, length, radial, 1, false);
        const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, delta.clone().normalize());
        const matrix = new THREE.Matrix4().compose(
            start.clone().addScaledVector(delta, 0.5),
            quaternion,
            new THREE.Vector3(1, 1, 1)
        );
        this._push(key, geometry, matrix);
    }

    // Cone pointing away from +Y by default; use rotation to aim it.
    cone(key, radius, height, position = [0, 0, 0], rotation = [0, 0, 0], radial = 7) {
        this.part(key, new THREE.ConeGeometry(radius, height, radial), position, rotation);
    }

    // Tapered tube through a polyline (see taperedTube).
    curve(key, points, rStart, rEnd, tubular = 18, radial = 7) {
        if (points.length < 2) return;
        this._push(key, taperedTube(points, rStart, rEnd, tubular, radial), new THREE.Matrix4());
    }

    // Convenience: ring of `count` copies around Y with a fixed jitter seed.
    scatter(key, count, radius, build) {
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + (i % 2 ? 0.4 : 0);
            const spread = radius * (0.35 + 0.65 * ((i * 7919) % 100) / 100);
            build(i, Math.cos(angle) * spread, Math.sin(angle) * spread, angle);
        }
    }

    _material(key) {
        const hex = this.colors[key] || this.colors.body || DEFAULT_COLORS.body;
        const color = new THREE.Color(hex);
        const parameters = { color };
        if (this.glowKeys.has(key)) parameters.emissive = color.clone().multiplyScalar(0.6);
        if (this.opacity < 1) {
            parameters.transparent = true;
            parameters.opacity = this.opacity;
            parameters.depthWrite = this.opacity >= 0.95;
        }
        // r132's Lambert has no flatShading — Phong with shininess 0 is the
        // facetted equivalent, used for rock/construct plans.
        const material = this.flatShading
            ? new THREE.MeshPhongMaterial({ ...parameters, flatShading: true, shininess: 0, specular: 0x000000 })
            : new THREE.MeshLambertMaterial(parameters);
        material.name = `monster:${key}`;
        return material;
    }

    // Collapse every palette key into one mesh and attach it to `parent`.
    finish(parent, name = 'MonsterPart') {
        const meshes = [];
        for (const [key, parts] of this.groups) {
            if (!parts.length) continue;
            const geometry = mergeParts(parts);
            const mesh = new THREE.Mesh(geometry, this._material(key));
            mesh.name = `${name}.${key}`;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            // disposeBuiltObject releases per-instance geometry behind this flag;
            // shared structural geometry stays unmarked.
            mesh.userData.ownGeometry = true;
            parent.add(mesh);
            meshes.push(mesh);
        }
        this.groups.clear();
        return meshes;
    }
}

// Small shared helpers generators reuse for eyes, teeth and glints.
export function addEyes(builder, key, eyeKey, position, spread, radius = 0.03, forward = 0) {
    for (const side of [-1, 1]) {
        builder.ellipsoid(eyeKey, [radius, radius * 0.95, radius * 0.7],
            [position[0] + side * spread, position[1], position[2] + forward], [0, 0, 0], 10);
    }
}

export function paletteOf(params = {}) {
    const colors = params.colors && typeof params.colors === 'object' ? params.colors : {};
    const result = {};
    for (const key of Object.keys(DEFAULT_COLORS)) {
        const value = colors[key];
        if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) result[key] = value;
    }
    return result;
}

export function num(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

export function flag(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

export function pick(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}
