// props.js — dungeon dressing: small procedural furniture and fixtures the GM
// drops on the tactical grid (type:'prop', kind, rot). They sync as ordinary
// map objects and both screens build the same mesh here through
// models.buildObjectFromData.
//
// Every prop is built around its own origin on the ground, facing +Z, inside
// one 5-ft cell unless its label says otherwise; `rot` (0..3) turns it in
// quarter turns. Props that burn carry a default `light` (feet, the shape
// shared/vision.js reads) which the page stores on the record when placing
// one, so the server and the vision pass treat it like any other light.
//
// The key list is mirrored in server.js (PROP_KINDS) — tests/props.test.cjs
// enforces the sync.

import * as THREE from 'three';

export const PROP_KINDS = {
    torch:      { label: 'Wall torch', light: { bright: 20, dim: 20, dark: 0 } },
    brazier:    { label: 'Brazier', light: { bright: 30, dim: 30, dark: 0 } },
    candles:    { label: 'Candles', light: { bright: 5, dim: 5, dark: 0 } },
    shackles:   { label: 'Wall shackles' },
    bars:       { label: 'Iron bars' },
    cot:        { label: 'Cot' },
    table:      { label: 'Long table' },
    bench:      { label: 'Bench' },
    throne:     { label: 'High seat' },
    lectern:    { label: 'Lectern' },
    bookshelf:  { label: 'Bookshelf' },
    crate:      { label: 'Crate' },
    barrel:     { label: 'Barrel' },
    chest:      { label: 'Chest' },
    egg:        { label: 'Dragon egg' },
    bones:      { label: 'Bones' },
    rubble:     { label: 'Rubble' },
    stalagmite: { label: 'Stalagmite' },
    pillar:     { label: 'Pillar' }
};

export function propLabel(kind) {
    return (PROP_KINDS[kind] && PROP_KINDS[kind].label) || 'Prop';
}

export function propLight(kind) {
    const light = PROP_KINDS[kind] && PROP_KINDS[kind].light;
    return light ? { ...light } : null;
}

export function propRotation(rot) {
    const turns = Math.round(Number(rot) || 0);
    return ((turns % 4) + 4) % 4;
}

// Shared unit geometries, scaled per piece — never disposed (the pages only
// free a built object's materials).
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CONE = new THREE.ConeGeometry(0.5, 1, 7);
const BALL = new THREE.SphereGeometry(0.5, 14, 10);
const RING = new THREE.TorusGeometry(0.5, 0.09, 6, 14);

const IRON = 0x2b2d31, WOOD = 0x6a4a2c, WOOD_DARK = 0x4a3320, CLOTH = 0x8c8676;
const STONE = 0x5d5a55, BONE = 0xd8d2bf, FLAME = 0xffb347, EMBER = 0xff6a1f;

// Deterministic scatter so a prop looks the same on every client.
function rand(i, k) {
    let h = (Math.imul(i + 1, 374761393) ^ Math.imul(k + 1, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function kit(group) {
    const mats = new Map();
    const lit = (color) => {
        if (!mats.has(color)) mats.set(color, new THREE.MeshLambertMaterial({ color }));
        return mats.get(color);
    };
    const add = (geometry, material, sx, sy, sz, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(sx, sy, sz);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };
    return {
        // Sizes are full extents; (x, y, z) is the piece's center.
        box: (color, sx, sy, sz, x, y, z) => add(BOX, lit(color), sx, sy, sz, x, y, z),
        cyl: (color, d, h, x, y, z) => add(CYL, lit(color), d, h, d, x, y, z),
        cone: (color, d, h, x, y, z) => add(CONE, lit(color), d, h, d, x, y, z),
        ball: (color, sx, sy, sz, x, y, z) => add(BALL, lit(color), sx, sy, sz, x, y, z),
        ring: (color, d, x, y, z) => add(RING, lit(color), d, d, d, x, y, z),
        // Fire is unlit so it still reads in a dark room.
        glow: (color, sx, sy, sz, x, y, z) => {
            const mesh = add(CONE, new THREE.MeshBasicMaterial({ color }), sx, sy, sz, x, y, z);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            return mesh;
        }
    };
}

function flame(k, x, y, z, size) {
    k.glow(EMBER, size, size * 1.5, size, x, y + size * 0.75, z);
    k.glow(FLAME, size * 0.55, size * 1.1, size * 0.55, x, y + size * 0.7, z);
}

const BUILDERS = {
    // Hangs on the wall behind it (the cell's -Z edge).
    torch(k) {
        k.box(IRON, 0.07, 0.07, 0.24, 0, 1.25, -0.36);
        k.cyl(WOOD_DARK, 0.07, 0.42, 0, 1.36, -0.26).rotation.x = 0.35;
        k.cyl(IRON, 0.13, 0.08, 0, 1.55, -0.19);
        flame(k, 0, 1.56, -0.19, 0.16);
    },
    brazier(k) {
        for (let i = 0; i < 3; i++) {
            const a = i / 3 * Math.PI * 2;
            const leg = k.cyl(IRON, 0.05, 0.72, Math.cos(a) * 0.18, 0.34, Math.sin(a) * 0.18);
            leg.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
        }
        k.cyl(IRON, 0.58, 0.16, 0, 0.74, 0);
        k.cyl(0x3a1c10, 0.48, 0.06, 0, 0.82, 0);
        flame(k, 0, 0.8, 0, 0.3);
    },
    candles(k) {
        k.cyl(IRON, 0.3, 0.04, 0, 0.02, 0);
        [[0, 0, 0.3], [0.09, 0.05, 0.22], [-0.08, 0.06, 0.18], [0.02, -0.09, 0.14]].forEach(([x, z, h]) => {
            k.cyl(0xe9e2cc, 0.05, h, x, 0.04 + h / 2, z);
            k.glow(FLAME, 0.045, 0.1, 0.045, x, 0.09 + h, z);
        });
    },
    // A wall plate with two chains and open cuffs (wall = the cell's -Z edge).
    shackles(k) {
        k.box(IRON, 0.62, 0.12, 0.05, 0, 1.3, -0.44);
        [-0.22, 0.22].forEach((x) => {
            k.ring(IRON, 0.11, x, 1.3, -0.4);
            for (let i = 0; i < 5; i++) {
                const link = k.ring(IRON, 0.09, x, 1.2 - i * 0.11, -0.38 + i * 0.012);
                link.rotation.y = i % 2 ? Math.PI / 2 : 0;
            }
            k.ring(IRON, 0.17, x, 0.62, -0.31).rotation.x = Math.PI / 2;
        });
    },
    // One cell of cell-front: bars along X through the origin.
    bars(k) {
        k.box(IRON, 1.02, 0.07, 0.09, 0, 0.06, 0);
        k.box(IRON, 1.02, 0.07, 0.09, 0, 1.0, 0);
        k.box(IRON, 1.02, 0.07, 0.09, 0, 1.92, 0);
        for (let i = 0; i < 6; i++) k.cyl(IRON, 0.045, 1.94, -0.42 + i * 0.168, 0.98, 0);
    },
    // Lies along Z, head at -Z; about 3 x 6.5 ft.
    cot(k) {
        k.box(WOOD_DARK, 0.62, 0.08, 1.34, 0, 0.24, 0);
        [[-0.27, -0.62], [0.27, -0.62], [-0.27, 0.62], [0.27, 0.62]].forEach(([x, z]) => {
            k.box(WOOD_DARK, 0.07, 0.3, 0.07, x, 0.15, z);
        });
        k.box(CLOTH, 0.56, 0.08, 1.26, 0, 0.32, 0);
        k.box(0x6b3b33, 0.58, 0.05, 0.72, 0, 0.37, 0.24);
        k.box(0xd8d2c0, 0.4, 0.07, 0.22, 0, 0.39, -0.48);
    },
    // Two cells long along X.
    table(k) {
        k.box(WOOD, 1.9, 0.08, 0.84, 0, 0.56, 0);
        [-0.84, 0.84].forEach((x) => {
            k.box(WOOD_DARK, 0.1, 0.52, 0.7, x, 0.26, 0);
        });
        k.box(WOOD_DARK, 1.6, 0.08, 0.08, 0, 0.2, 0);
    },
    bench(k) {
        k.box(WOOD, 1.7, 0.07, 0.3, 0, 0.34, 0);
        [-0.7, 0.7].forEach((x) => k.box(WOOD_DARK, 0.08, 0.32, 0.26, x, 0.16, 0));
    },
    throne(k) {
        k.box(STONE, 0.9, 0.16, 0.9, 0, 0.08, 0);
        k.box(WOOD_DARK, 0.66, 0.4, 0.6, 0, 0.36, 0.02);
        k.box(0x5a2530, 0.56, 0.06, 0.5, 0, 0.59, 0.04);
        k.box(WOOD_DARK, 0.7, 1.5, 0.1, 0, 0.91, -0.29);
        [-0.33, 0.33].forEach((x) => {
            k.box(WOOD_DARK, 0.09, 0.28, 0.56, x, 0.72, 0.02);
            k.cone(WOOD_DARK, 0.11, 0.24, x, 1.78, -0.29);
        });
    },
    lectern(k) {
        k.box(WOOD_DARK, 0.4, 0.06, 0.4, 0, 0.03, 0);
        k.cyl(WOOD_DARK, 0.12, 0.92, 0, 0.5, 0);
        const top = k.box(WOOD, 0.6, 0.05, 0.46, 0, 1.0, 0.03);
        top.rotation.x = 0.45;
        const book = k.box(0xe6dfc8, 0.46, 0.05, 0.32, 0, 1.05, 0.04);
        book.rotation.x = 0.45;
    },
    // Stands against the wall behind it (the cell's -Z edge).
    bookshelf(k) {
        k.box(WOOD_DARK, 0.96, 1.9, 0.06, 0, 0.95, -0.42);
        [-0.46, 0.46].forEach((x) => k.box(WOOD_DARK, 0.05, 1.9, 0.32, x, 0.95, -0.28));
        const spines = [0x6b2f2a, 0x2f4a5a, 0x4d5a2f, 0x8a6a3a, 0x3a2f4d, 0x7a7466];
        for (let row = 0; row < 4; row++) {
            const y = 0.06 + row * 0.47;
            k.box(WOOD, 0.9, 0.05, 0.3, 0, y, -0.27);
            let x = -0.4;
            for (let i = 0; x < 0.36; i++) {
                const w = 0.05 + rand(row, i) * 0.05, h = 0.26 + rand(i, row + 7) * 0.12;
                k.box(spines[(row * 3 + i) % spines.length], w, h, 0.22, x + w / 2, y + 0.03 + h / 2, -0.28);
                x += w + 0.008;
            }
        }
        k.box(WOOD_DARK, 0.96, 0.05, 0.32, 0, 1.9, -0.28);
    },
    crate(k) {
        k.box(WOOD, 0.62, 0.6, 0.62, 0, 0.3, 0);
        [0.06, 0.54].forEach((y) => k.box(WOOD_DARK, 0.66, 0.06, 0.66, 0, y, 0));
    },
    barrel(k) {
        k.cyl(WOOD, 0.5, 0.74, 0, 0.37, 0);
        [0.14, 0.37, 0.6].forEach((y) => k.cyl(IRON, 0.53, 0.04, 0, y, 0));
    },
    chest(k) {
        k.box(WOOD_DARK, 0.76, 0.32, 0.46, 0, 0.16, 0);
        const lid = k.cyl(WOOD, 0.46, 0.76, 0, 0.32, 0);
        lid.rotation.z = Math.PI / 2;
        [-0.3, 0.3].forEach((x) => k.box(IRON, 0.05, 0.5, 0.48, x, 0.26, 0));
        k.box(0xb08a3c, 0.1, 0.1, 0.04, 0, 0.3, 0.24);
    },
    // A scaled shell on a nest of straw and stones.
    egg(k) {
        k.cyl(0x8a7a4a, 0.84, 0.12, 0, 0.06, 0);
        for (let i = 0; i < 7; i++) {
            const a = i / 7 * Math.PI * 2;
            k.ball(STONE, 0.2, 0.14, 0.18, Math.cos(a) * 0.38, 0.1, Math.sin(a) * 0.38);
        }
        k.ball(0x7c8a86, 0.52, 0.78, 0.52, 0, 0.5, 0);
        for (let i = 0; i < 9; i++) {
            const a = rand(i, 1) * Math.PI * 2, y = 0.26 + rand(i, 2) * 0.46;
            const r = 0.25 * Math.sqrt(Math.max(0.05, 1 - Math.pow((y - 0.5) / 0.39, 2)));
            k.ball(0x566461, 0.09, 0.07, 0.09, Math.cos(a) * r, y, Math.sin(a) * r);
        }
    },
    bones(k) {
        k.ball(BONE, 0.2, 0.18, 0.24, 0.12, 0.09, -0.1);
        for (let i = 0; i < 6; i++) {
            const bone = k.cyl(BONE, 0.045, 0.3 + rand(i, 3) * 0.26,
                (rand(i, 4) - 0.5) * 0.7, 0.03, (rand(i, 5) - 0.5) * 0.7);
            bone.rotation.set(Math.PI / 2, 0, rand(i, 6) * Math.PI);
        }
        for (let i = 0; i < 4; i++) {
            const rib = k.ring(BONE, 0.3, -0.18 + i * 0.09, 0.02, 0.16);
            rib.scale.y *= 0.6;
            rib.rotation.y = Math.PI / 2;
        }
    },
    rubble(k) {
        for (let i = 0; i < 9; i++) {
            const s = 0.14 + rand(i, 8) * 0.26;
            const rock = k.box(i % 3 ? STONE : 0x6d6964, s * 1.2, s * 0.8, s,
                (rand(i, 9) - 0.5) * 0.74, s * 0.34, (rand(i, 10) - 0.5) * 0.74);
            rock.rotation.set(rand(i, 11), rand(i, 12) * 3, rand(i, 13));
        }
    },
    stalagmite(k) {
        k.cone(0x6a6660, 0.5, 1.5, 0, 0.75, 0);
        k.cone(0x625e58, 0.3, 0.8, 0.26, 0.4, 0.12);
        k.cone(0x716d67, 0.22, 0.5, -0.2, 0.25, -0.2);
    },
    pillar(k) {
        k.box(0x4c4945, 0.9, 0.2, 0.9, 0, 0.1, 0);
        k.cyl(0x5d5a55, 0.62, 3.4, 0, 1.9, 0);
        k.box(0x4c4945, 0.9, 0.22, 0.9, 0, 3.7, 0);
    }
};

export function buildProp(data) {
    const group = new THREE.Group();
    const build = BUILDERS[data && data.kind];
    if (build) build(kit(group));
    else kit(group).box(0x7f8a99, 0.5, 0.5, 0.5, 0, 0.25, 0);
    group.rotation.y = -propRotation(data && data.rot) * Math.PI / 2;
    return group;
}
