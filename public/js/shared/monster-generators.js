// monster-generators.js — procedural body plans for the monster model pack.
//
// Every plan builds one static, ground-seated pose at a natural height of ~1
// unit, facing +Z, and returns a THREE.Group whose meshes carry the
// ownGeometry marker (so disposeBuiltObject releases them). monster-models.js
// resolves the plan from the generated manifest and normalizes the result onto
// the tabletop seating contract.
//
// Parameters arrive as plain JSON data: every field is read defensively with
// num()/pick()/flag() so a hand-edited manifest can never break a build.
// Shared silhouettes come from ARCHETYPE presets, which per-monster manifest
// params override field by field.

import * as THREE from 'three';
import { createApeModel } from './ape-model.js';
import { MonsterBuilder, num, flag, pick, paletteOf } from './monster-parts.js';

// --- shared plumbing ---------------------------------------------------------

function groupOf(name) {
    const group = new THREE.Group();
    group.name = name;
    group.userData.generatedModel = name;
    return group;
}

function paramsOf(params) {
    return params && typeof params === 'object' ? params : {};
}

function withArchetype(archetypes, params, fallback) {
    const base = archetypes[params.archetype] || archetypes[fallback] || {};
    return { ...base, ...params };
}

// A leg built as hip → knee → ankle → foot; shared by the quadruped, dragon
// and saurian plans. `forward` sets the knee break, `foot` the termination.
function addLeg(builder, options) {
    const {
        x, hipY, hipZ, length, bulk = 1, forward = 0.06, foot = 'paw',
        r0 = 0.06, colorKey = 'body', footKey = 'detail', toes = true
    } = options;
    const kneeY = hipY - length * 0.52;
    const ankleY = foot === 'hoof' ? length * 0.1 : length * 0.16;
    const kneeZ = hipZ + forward;
    const ankleZ = hipZ - forward * 0.35;

    builder.tube(colorKey, [x, hipY, hipZ], [x, kneeY, kneeZ], r0 * bulk, r0 * 0.72 * bulk);
    builder.sphere(colorKey, r0 * 0.8 * bulk, [x, kneeY, kneeZ], 10);
    builder.tube(colorKey, [x, kneeY, kneeZ], [x, ankleY, ankleZ], r0 * 0.68 * bulk, r0 * 0.45 * bulk);

    if (foot === 'hoof') {
        builder.box(footKey, [r0 * 1.1 * bulk, Math.max(0.03, ankleY * 1.6), r0 * 1.5 * bulk],
            [x, ankleY * 0.55, ankleZ + r0 * 0.3]);
    } else if (foot === 'digitigrade') {
        builder.ellipsoid(colorKey, [r0 * 0.75 * bulk, r0 * 0.42 * bulk, r0 * 1.25 * bulk],
            [x, ankleY * 0.5, ankleZ + r0 * 0.8]);
        if (toes) {
            for (const side of [-1, 0, 1]) {
                builder.ellipsoid(footKey, [r0 * 0.24 * bulk, r0 * 0.2 * bulk, r0 * 0.4 * bulk],
                    [x + side * r0 * 0.45 * bulk, ankleY * 0.28, ankleZ + r0 * 1.75]);
            }
        }
    } else {
        builder.ellipsoid(colorKey, [r0 * 0.95 * bulk, r0 * 0.55 * bulk, r0 * 1.35 * bulk],
            [x, ankleY * 0.45, ankleZ + r0 * 0.7]);
        if (toes) {
            for (const side of [-1, 0, 1]) {
                builder.ellipsoid(footKey, [r0 * 0.26 * bulk, r0 * 0.22 * bulk, r0 * 0.42 * bulk],
                    [x + side * r0 * 0.5 * bulk, ankleY * 0.24, ankleZ + r0 * 1.85]);
            }
        }
    }
}

// Thin double-sided sheet fan (wings, frills, fins, petals, plates):
// triangulated around the centroid so outlines can be non-convex, with each
// triangle duplicated along its own normal for thickness.
function polygon(builder, key, points, thickness = 0.012) {
    if (points.length < 3) return;
    const centroid = [0, 0, 0];
    for (const point of points) {
        centroid[0] += point[0] / points.length;
        centroid[1] += point[1] / points.length;
        centroid[2] += point[2] / points.length;
    }
    const edgeA = [points[0][0] - centroid[0], points[0][1] - centroid[1], points[0][2] - centroid[2]];
    for (let i = 0; i < points.length; i++) {
        const next = (i + 1) % points.length;
        const a = points[i];
        const b = points[next];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [centroid[0] - a[0], centroid[1] - a[1], centroid[2] - a[2]];
        const normal = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]
        ];
        const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
        const offset = [normal[0] / length * thickness / 2, normal[1] / length * thickness / 2, normal[2] / length * thickness / 2];
        void edgeA;
        for (const sign of [1, -1]) {
            const shift = (point) => [point[0] + offset[0] * sign, point[1] + offset[1] * sign, point[2] + offset[2] * sign];
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(
                [...shift(a), ...shift(b), ...shift(centroid)], 3));
            geometry.computeVertexNormals();
            builder.part(key, geometry);
        }
    }
}

// --- quadruped ---------------------------------------------------------------

const QUADRUPED_ARCHETYPES = {
    generic: {},
    canid: {
        headStyle: 'canine', muzzleLength: 0.15, torsoLength: 0.6, torsoDepth: 0.33,
        legLength: 0.33, neckLength: 0.2, neckRise: 0.3, ear: 'perk', tail: 'long',
        tailLength: 0.42
    },
    feline: {
        headStyle: 'feline', muzzleLength: 0.05, torsoLength: 0.58, torsoDepth: 0.32,
        legLength: 0.3, neckLength: 0.1, neckRise: 0.18, ear: 'round', tail: 'long',
        tailLength: 0.5, bulk: 1.05
    },
    ursine: {
        headStyle: 'ursine', muzzleLength: 0.09, torsoLength: 0.74, torsoDepth: 0.44,
        torsoWidth: 0.4, legLength: 0.27, neckLength: 0.06, neckRise: 0.12,
        ear: 'round', tail: 'stub', bulk: 1.25
    },
    equine: {
        headStyle: 'equine', muzzleLength: 0.19, torsoLength: 0.66, torsoDepth: 0.36,
        legLength: 0.44, neckLength: 0.4, neckRise: 0.62, ear: 'small', tail: 'brush',
        tailLength: 0.5, hooves: true, mane: true, bulk: 1.02
    },
    cervine: {
        headStyle: 'cervine', muzzleLength: 0.15, torsoLength: 0.6, torsoDepth: 0.33,
        legLength: 0.44, neckLength: 0.4, neckRise: 0.66, ear: 'long', tail: 'stub',
        horns: 'antlers', hornLength: 0.34, bulk: 0.95
    },
    bovine: {
        headStyle: 'bovine', muzzleLength: 0.13, torsoLength: 0.76, torsoDepth: 0.46,
        torsoWidth: 0.42, legLength: 0.3, neckLength: 0.12, neckRise: 0.16,
        ear: 'long', tail: 'long', tailLength: 0.45, horns: 'curved', hornLength: 0.3,
        bulk: 1.3
    },
    suine: {
        headStyle: 'suine', muzzleLength: 0.14, torsoLength: 0.68, torsoDepth: 0.4,
        legLength: 0.22, neckLength: 0.04, neckRise: 0.08, ear: 'small', tail: 'curl',
        bulk: 1.15, tusks: true
    },
    mustelid: {
        headStyle: 'generic', muzzleLength: 0.1, torsoLength: 0.82, torsoDepth: 0.26,
        torsoWidth: 0.24, legLength: 0.15, neckLength: 0.1, neckRise: 0.22,
        ear: 'round', tail: 'tuft', tailLength: 0.4
    },
    rodent: {
        headStyle: 'generic', muzzleLength: 0.08, torsoLength: 0.5, torsoDepth: 0.26,
        legLength: 0.14, neckLength: 0.05, neckRise: 0.16, ear: 'round', earSize: 0.07,
        tail: 'long', tailLength: 0.45, bulk: 0.9
    },
    primate: {
        headStyle: 'primate', muzzleLength: 0.07, torsoLength: 0.5, torsoDepth: 0.36,
        torsoWidth: 0.34, legLength: 0.26, neckLength: 0.05, neckRise: 0.2,
        ear: 'round', earSize: 0.05, tail: 'none', bulk: 1.1, armLength: 1.35
    },
    reptile: {
        headStyle: 'reptile', muzzleLength: 0.2, torsoLength: 0.68, torsoDepth: 0.26,
        legLength: 0.18, neckLength: 0.1, neckRise: 0.12, ear: 'none', tail: 'long',
        tailLength: 0.75, sprawl: true, crest: true
    },
    crocodilian: {
        headStyle: 'croc', muzzleLength: 0.3, torsoLength: 0.8, torsoDepth: 0.28,
        legLength: 0.16, neckLength: 0.06, neckRise: 0.06, ear: 'none', tail: 'long',
        tailLength: 0.9, sprawl: true, teeth: true
    },
    owlbear: {
        headStyle: 'beak', muzzleLength: 0.12, torsoLength: 0.6, torsoDepth: 0.42,
        torsoWidth: 0.38, legLength: 0.3, neckLength: 0.08, neckRise: 0.24,
        ear: 'tuft', tail: 'none', bulk: 1.2
    },
    caprine: {
        headStyle: 'generic', muzzleLength: 0.1, torsoLength: 0.55, torsoDepth: 0.33,
        legLength: 0.38, neckLength: 0.2, neckRise: 0.34, ear: 'long', tail: 'stub',
        horns: 'curved', hornLength: 0.2, beard: true, bulk: 0.95
    }
};

function addQuadrupedHead(builder, p, head) {
    const { style, size, muzzle, position: [hx, hy, hz] } = head;
    const ears = p.ear || 'perk';
    const earSize = num(p.earSize, size * 1.1, 0.02, 0.5);

    builder.ellipsoid('body', [size, size * 1.02, size * 1.08], [hx, hy, hz]);
    // Forehead mass gives the skull depth behind the muzzle.
    builder.ellipsoid('accent', [size * 0.86, size * 0.5, size * 0.55],
        [hx, hy + size * 0.34, hz + size * 0.45]);

    if (style === 'beak') {
        builder.cone('horn', size * 0.5, muzzle * 2.1, [hx, hy - size * 0.05, hz + size * 0.7 + muzzle],
            [Math.PI / 2 - 0.12, 0, 0], 6);
        builder.cone('horn', size * 0.42, muzzle * 1.7, [hx, hy - size * 0.22, hz + size * 0.62 + muzzle * 0.8],
            [Math.PI / 2 + 0.35, 0, 0], 6);
        for (const side of [-1, 1]) {
            builder.cone('accent', size * 0.3, size * 0.7, [hx + side * size * 0.6, hy + size * 0.5, hz + size * 0.2],
                [-0.4, 0, side * 0.5], 5);
        }
    } else if (muzzle > 0.015) {
        const longHead = style === 'equine' || style === 'croc' || style === 'reptile' || style === 'cervine';
        const wideHead = style === 'bovine' || style === 'ursine' || style === 'suine';
        builder.ellipsoid(style === 'croc' || style === 'reptile' ? 'accent' : 'body',
            [size * (wideHead ? 0.66 : longHead ? 0.4 : 0.5), size * (longHead ? 0.5 : 0.56), muzzle],
            [hx, hy - size * (longHead ? 0.1 : 0.16), hz + size * 0.55 + muzzle * 0.55]);
        builder.ellipsoid('accent', [size * (wideHead ? 0.55 : 0.42), size * 0.3, muzzle * 0.85],
            [hx, hy + size * 0.1, hz + size * 0.5 + muzzle * 0.5]);
        builder.ellipsoid('detail', [size * 0.2, size * 0.15, size * 0.14],
            [hx, hy - size * 0.02, hz + size * 0.55 + muzzle * 1.02]);
        if (p.teeth || style === 'canine') {
            for (const side of [-1, 1]) {
                builder.cone('horn', size * 0.06, size * 0.2,
                    [hx + side * size * 0.24, hy - size * 0.42, hz + size * 0.6 + muzzle * 0.7],
                    [Math.PI, 0, 0], 5);
            }
        }
    }

    if (style === 'croc') {
        for (const side of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                builder.cone('horn', size * 0.045, size * 0.14,
                    [hx + side * size * 0.3, hy - size * 0.3, hz + size * 0.7 + i * muzzle * 0.24],
                    [Math.PI, 0, 0], 4);
            }
        }
    }

    // Ears.
    if (ears !== 'none') {
        const earSpread = size * 0.72;
        for (const side of [-1, 1]) {
            const ex = hx + side * earSpread;
            if (ears === 'round') {
                builder.ellipsoid('body', [earSize * 0.5, earSize * 0.5, earSize * 0.28],
                    [ex, hy + size * 0.8, hz - size * 0.05], [0, side * 0.3, 0], 10);
            } else if (ears === 'long') {
                builder.ellipsoid('body', [earSize * 0.3, earSize * 1.05, earSize * 0.26],
                    [ex, hy + size * 1.1, hz - size * 0.05], [0.1, 0, side * 0.4], 10);
            } else if (ears === 'tuft') {
                builder.cone('accent', earSize * 0.4, earSize * 1.2,
                    [ex, hy + size * 0.95, hz], [0.15, 0, side * 0.35], 5);
                builder.cone('body', earSize * 0.34, earSize * 0.7,
                    [ex - side * size * 0.2, hy + size * 0.8, hz], [0.2, 0, side * 0.2], 5);
            } else if (ears === 'small') {
                builder.cone('body', size * 0.16, size * 0.42,
                    [ex, hy + size * 0.85, hz], [0.1, 0, side * 0.3], 5);
            } else {
                builder.cone('body', size * 0.3, size * 0.95,
                    [ex, hy + size * 0.9, hz - size * 0.02], [0.12, 0, side * 0.32], 5);
            }
            builder.ellipsoid('belly', [earSize * 0.16, earSize * 0.5, earSize * 0.12],
                [ex - side * size * 0.05, hy + size * 1.0, hz + size * 0.04], [0, 0, side * 0.35], 8);
        }
    }

    // Horns / antlers.
    const horns = p.horns || 'none';
    if (horns !== 'none') {
        const length = num(p.hornLength, size * 1.6, 0.05, 1.4);
        if (horns === 'straight') {
            for (const side of [-1, 1]) {
                builder.cone('horn', size * 0.22, length,
                    [hx + side * size * 0.4, hy + size * 0.7 + length * 0.4, hz + size * 0.1],
                    [-0.15, 0, side * 0.22], 6);
            }
        } else if (horns === 'curved') {
            for (const side of [-1, 1]) {
                builder.curve('horn', [
                    [hx + side * size * 0.5, hy + size * 0.5, hz],
                    [hx + side * (size * 0.5 + length * 0.3), hy + size * 0.75 + length * 0.4, hz - length * 0.15],
                    [hx + side * (size * 0.4 + length * 0.15), hy + size * 0.8 + length * 0.8, hz - length * 0.35]
                ], size * 0.19, size * 0.03, 10, 6);
            }
        } else if (horns === 'sickle') {
            for (const side of [-1, 1]) {
                builder.curve('horn', [
                    [hx + side * size * 0.42, hy + size * 0.6, hz + size * 0.2],
                    [hx + side * size * 0.6, hy + size * 0.75 + length * 0.35, hz + size * 0.1],
                    [hx + side * size * 0.5, hy + size * 0.8 + length * 0.7, hz - length * 0.45]
                ], size * 0.16, size * 0.02, 10, 6);
            }
        } else if (horns === 'ram') {
            for (const side of [-1, 1]) {
                builder.curve('horn', [
                    [hx + side * size * 0.55, hy + size * 0.55, hz],
                    [hx + side * (size * 0.95 + length * 0.25), hy + size * 0.6, hz - length * 0.1],
                    [hx + side * (size * 0.95 + length * 0.1), hy + size * 0.25, hz - length * 0.3],
                    [hx + side * size * 0.6, hy + size * 0.3, hz + length * 0.15]
                ], size * 0.2, size * 0.05, 14, 6);
            }
        } else if (horns === 'antlers') {
            for (const side of [-1, 1]) {
                builder.curve('horn', [
                    [hx + side * size * 0.4, hy + size * 0.6, hz - size * 0.1],
                    [hx + side * size * 0.55, hy + size * 0.9, hz - size * 0.35],
                    [hx + side * size * 0.6, hy + size * 1.15 + length * 0.3, hz - size * 0.75]
                ], size * 0.13, size * 0.05, 10, 5);
                for (let tine = 0; tine < 3; tine++) {
                    builder.cone('horn', size * 0.09, length * (0.5 + tine * 0.2),
                        [hx + side * (size * 0.45 + tine * size * 0.12), hy + size * (0.75 + tine * 0.32), hz - size * (0.3 + tine * 0.3)],
                        [-0.9 - tine * 0.15, 0, side * 0.35], 5);
                }
            }
        }
    }

    if (p.tusks) {
        for (const side of [-1, 1]) {
            builder.cone('horn', size * 0.07, size * 0.5,
                [hx + side * size * 0.3, hy - size * 0.3, hz + size * 0.55 + muzzle * 0.5],
                [-0.4, 0, side * 0.15], 5);
        }
    }
    if (p.beard) {
        builder.ellipsoid('accent', [size * 0.2, size * 0.4, size * 0.16],
            [hx, hy - size * 0.7, hz + size * 0.5 + muzzle * 0.4], [0.3, 0, 0], 8);
    }

    // Eyes.
    const eyeSpread = size * (style === 'reptile' || style === 'croc' ? 0.62 : 0.5);
    const eyeY = hy + size * (style === 'reptile' || style === 'croc' ? 0.3 : 0.14);
    for (const side of [-1, 1]) {
        builder.ellipsoid('eye', [size * 0.16, size * 0.15, size * 0.12],
            [hx + side * eyeSpread, eyeY, hz + size * 0.78 + muzzle * 0.35], [0, 0, 0], 10);
    }
}

function buildQuadruped(rawParams) {
    const p = withArchetype(QUADRUPED_ARCHETYPES, paramsOf(rawParams), 'generic');
    const group = groupOf('Quadruped');
    const legLength = num(p.legLength, 0.32, 0.06, 0.9);
    const torsoLength = num(p.torsoLength, 0.62, 0.2, 2.4);
    const torsoDepth = num(p.torsoDepth, 0.34, 0.1, 1.4);
    const torsoWidth = num(p.torsoWidth, 0.3, 0.08, 1.2);
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const bodyY = legLength + torsoDepth * 0.46;
    const chestZ = torsoLength * 0.26;
    const hipZ = -torsoLength * 0.26;
    const legR = 0.055 * Math.min(1.4, bulk);
    const sprawl = flag(p.sprawl);
    const builder = new MonsterBuilder(paletteOf(p));

    // Torso: deep chest in front, hips behind, belly between.
    builder.ellipsoid('body', [torsoWidth * 0.56, torsoDepth * 0.52, torsoLength * 0.34],
        [0, bodyY, chestZ + torsoLength * 0.06], [-0.06, 0, 0], 16);
    builder.ellipsoid('body', [torsoWidth * 0.5, torsoDepth * 0.46, torsoLength * 0.3],
        [0, bodyY - torsoDepth * 0.03, hipZ - torsoLength * 0.04], [0.05, 0, 0], 16);
    builder.ellipsoid('body', [torsoWidth * 0.46, torsoDepth * 0.4, torsoLength * 0.3],
        [0, bodyY - torsoDepth * 0.06, 0], [0, 0, 0], 14);
    builder.ellipsoid('belly', [torsoWidth * 0.4, torsoDepth * 0.24, torsoLength * 0.34],
        [0, bodyY - torsoDepth * 0.3, chestZ * 0.2], [0, 0, 0], 14);
    // Shoulder + haunch masses.
    for (const side of [-1, 1]) {
        builder.ellipsoid('accent', [torsoWidth * 0.2, torsoDepth * 0.4, torsoLength * 0.2],
            [side * torsoWidth * 0.38, bodyY + torsoDepth * 0.1, chestZ + torsoLength * 0.1]);
        builder.ellipsoid('body', [torsoWidth * 0.24, torsoDepth * 0.42, torsoLength * 0.22],
            [side * torsoWidth * 0.4, bodyY - torsoDepth * 0.04, hipZ - torsoLength * 0.06]);
    }

    // Legs.
    const stanceX = torsoWidth * (sprawl ? 0.58 : 0.42);
    const legOptions = {
        bulk: 1, foot: p.hooves ? 'hoof' : 'paw', colorKey: 'accent', footKey: 'detail',
        forward: sprawl ? 0.02 : 0.055
    };
    for (const side of [-1, 1]) {
        addLeg(builder, {
            ...legOptions, x: side * stanceX, hipY: bodyY - torsoDepth * 0.22,
            hipZ: chestZ + torsoLength * 0.1, length: legLength, r0: legR * 1.05
        });
        addLeg(builder, {
            ...legOptions, x: side * stanceX * 1.02, hipY: bodyY - torsoDepth * 0.26,
            hipZ: hipZ - torsoLength * 0.08, length: legLength, r0: legR * 1.15,
            forward: sprawl ? 0.04 : 0.03
        });
    }

    // Neck.
    const neckLength = num(p.neckLength, 0.2, 0, 1.4);
    const neckRise = num(p.neckRise, 0.3, -0.5, 1.4);
    const neckStartY = bodyY + torsoDepth * 0.3;
    const neckStartZ = chestZ + torsoLength * 0.16;
    const headSize = num(p.headSize, 0.16, 0.05, 0.7);
    const headZ = neckStartZ + neckLength * 0.75 + headSize * 0.6;
    const headY = neckStartY + neckRise * 0.55;
    if (neckLength > 0.02 || neckRise > 0.02) {
        builder.curve('accent', [
            [0, neckStartY - headSize * 0.1, neckStartZ],
            [0, neckStartY + neckRise * 0.3, neckStartZ + neckLength * 0.35],
            [0, headY - headSize * 0.2, headZ - headSize * 0.6]
        ], torsoDepth * 0.26, headSize * 0.62, 10, 8);
    } else {
        builder.sphere('accent', headSize * 0.8, [0, headY, headZ - headSize * 0.5], 10);
    }

    // Head.
    addQuadrupedHead(builder, p, {
        style: p.headStyle || 'canine', size: headSize,
        muzzle: num(p.muzzleLength, 0.1, 0, 0.6), position: [0, headY, headZ]
    });

    // Mane (equine/cervine crest along neck and spine).
    if (p.mane) {
        for (let i = 0; i < 9; i++) {
            const t = i / 8;
            const y = neckStartY + (headY - neckStartY) * t + headSize * 0.5 * (1 - t) + torsoDepth * 0.1;
            const z = neckStartZ + (headZ - neckStartZ) * t - headSize * 0.2;
            builder.cone('accent', headSize * 0.3, headSize * (0.7 + 0.4 * (1 - t)),
                [0, y, z - headSize * 0.3], [-0.5 - t * 0.4, 0, 0], 5);
        }
        for (let i = 0; i < 5; i++) {
            builder.cone('accent', torsoDepth * 0.14, torsoDepth * 0.4,
                [0, bodyY + torsoDepth * 0.45, chestZ - i * torsoLength * 0.12], [-0.9, 0, 0], 5);
        }
    }

    // Tail.
    const tail = p.tail || 'long';
    if (tail !== 'none') {
        const tailLength = num(p.tailLength, 0.4, 0, 2.4) * (tail === 'stub' ? 0.4 : 1);
        const rise = num(p.tailRise, 0.25, -0.6, 1);
        const startY = bodyY + torsoDepth * 0.2;
        const startZ = hipZ - torsoLength * 0.24;
        const thick = tail === 'brush' || tail === 'tuft' ? 1.5 : 1;
        const end = tail === 'curl'
            ? [0, startY + rise * 0.5 - tailLength * 0.2, startZ - tailLength * 0.9]
            : [0, startY + rise * 0.4 - tailLength * 0.5, startZ - tailLength];
        builder.curve('accent', [
            [0, startY, startZ],
            [0, startY + rise * 0.35, startZ - tailLength * 0.35],
            [0, startY + rise * 0.5 - tailLength * 0.15, startZ - tailLength * 0.7],
            end
        ], legR * 1.2 * thick, legR * 0.3, 12, 6);
        if (tail === 'tuft' || tail === 'brush') {
            builder.ellipsoid('accent', [legR * 1.4, legR * 1.6, legR * 2],
                [end[0], end[1], end[2] - legR]);
        }
        if (tail === 'curl') {
            builder.curve('accent', [
                end,
                [legR * 0.8, end[1] + legR * 1.6, end[2] - legR * 1.4],
                [legR * 1.4, end[1] + legR * 2.6, end[2] - legR * 0.4]
            ], legR * 0.3, legR * 0.18, 8, 5);
        }
    }

    // Optional dorsal crest.
    if (p.crest) {
        for (let i = 0; i < 8; i++) {
            const t = i / 7;
            builder.cone('horn', torsoDepth * 0.08, torsoDepth * 0.3,
                [0, bodyY + torsoDepth * 0.48, chestZ + torsoLength * 0.25 - t * torsoLength * 0.85],
                [-0.3 + t * 0.5, 0, 0], 4);
        }
    }

    builder.finish(group, 'Quadruped');
    return group;
}

// --- humanoid ----------------------------------------------------------------

const HUMANOID_ARCHETYPES = {
    generic: {},
    civilian: { clothing: 'cloth', weapon: 'none' },
    warrior: { clothing: 'armor', weapon: 'sword', shield: true, headgear: 'helmet' },
    bandit: { clothing: 'rags', weapon: 'club' },
    priest: { clothing: 'robe', weapon: 'staff', headgear: 'hood' },
    mage: { clothing: 'robe', weapon: 'staff', headgear: 'hood' },
    noble: { clothing: 'robe', headgear: 'crown' },
    brute: { bulk: 1.4, clothing: 'none', weapon: 'club', headStyle: 'orc' },
    orc: { bulk: 1.25, clothing: 'armor', weapon: 'axe', headStyle: 'orc', horns: 'small' },
    goblin: { bulk: 0.85, clothing: 'rags', weapon: 'dagger', headStyle: 'muzzle', ears: 'long' },
    skeleton: { headStyle: 'skull', clothing: 'none', bone: true, weapon: 'sword' },
    zombie: { headStyle: 'dead', clothing: 'rags', bulk: 1.05, slouch: 0.12 },
    ghoul: { headStyle: 'dead', clothing: 'rags', bulk: 0.9, claws: true, ears: 'pointy', slouch: 0.08 },
    giant: { bulk: 1.5, clothing: 'rags', weapon: 'club', headStyle: 'human' },
    gnoll: { headStyle: 'gnoll', clothing: 'rags', weapon: 'spear', ears: 'long' },
    kobold: { bulk: 0.8, clothing: 'cloth', weapon: 'dagger', headStyle: 'muzzle', tail: 'beast', ears: 'none' },
    lizardfolk: { headStyle: 'muzzle', clothing: 'none', weapon: 'spear', tail: 'beast', crest: true },
    merfolk: { form: 'serpentine', clothing: 'none', weapon: 'trident' },
    specter: { form: 'floating', ethereal: true, clothing: 'none', weapon: 'none' },
    wraith: { form: 'floating', ethereal: true, clothing: 'none', weapon: 'none', bulk: 1.15 },
    villager: { clothing: 'cloth', weapon: 'none', headgear: 'hood' },
    monk: { clothing: 'cloth', weapon: 'staff' },
    knight: { clothing: 'scale', weapon: 'sword', shield: true, headgear: 'helmet' }
};

function addHumanoidArm(builder, side, p, y, bulk, options = {}) {
    const scale = options.scale || 1;
    const shoulderX = side * (0.17 + 0.05 * (bulk - 1)) * scale;
    const armLength = num(p.armLength, 1, 0.6, 2) * scale;
    const upperY = y - 0.16 * armLength;
    const wristY = y - 0.33 * armLength;
    const handX = shoulderX + side * 0.05 * scale;
    const skin = p.bone ? 'horn' : 'body';
    const sleeveKey = p.clothing === 'none' || p.clothing == null ? skin : 'accent';

    builder.tube(sleeveKey, [shoulderX, y, 0], [shoulderX + side * 0.03, upperY, 0.02], 0.055 * scale * bulk, 0.045 * scale);
    builder.sphere(sleeveKey, 0.05 * scale * bulk, [shoulderX, y, 0], 10);
    builder.tube(sleeveKey, [shoulderX + side * 0.03, upperY, 0.02], [handX, wristY, 0.045], 0.042 * scale, 0.032 * scale);
    if (p.claws) {
        builder.ellipsoid(skin, [0.035 * scale, 0.04 * scale, 0.03 * scale], [handX, wristY - 0.035, 0.05]);
        for (let claw = -1; claw <= 1; claw++) {
            builder.cone('horn', 0.008 * scale, 0.05 * scale,
                [handX + claw * 0.02 * scale, wristY - 0.06, 0.075], [Math.PI - 0.5, 0, 0], 4);
        }
    } else {
        builder.ellipsoid(p.bone ? 'horn' : skin, [0.032 * scale, 0.04 * scale, 0.03 * scale],
            [handX, wristY - 0.03, 0.05]);
    }
    return [handX, wristY - 0.03, 0.05];
}

function addWeapon(builder, hand, weapon) {
    if (!weapon || weapon === 'none' || !hand) return;
    const [x, y, z] = hand;
    switch (weapon) {
        case 'club':
            builder.tube('detail', [x, y, z], [x - 0.02, y + 0.34, z + 0.05], 0.028, 0.02);
            builder.ellipsoid('detail', [0.05, 0.06, 0.05], [x - 0.03, y + 0.38, z + 0.06]);
            break;
        case 'sword':
            builder.box('detail', [0.02, 0.34, 0.05], [x, y + 0.2, z + 0.02], [-0.25, 0, 0.1]);
            builder.box('horn', [0.11, 0.02, 0.03], [x, y + 0.05, z], [-0.25, 0, 0.1]);
            builder.tube('detail', [x, y + 0.04, z], [x, y - 0.05, z - 0.02], 0.016, 0.014);
            break;
        case 'dagger':
            builder.box('detail', [0.016, 0.16, 0.035], [x, y + 0.1, z + 0.02], [-0.4, 0, 0.15]);
            builder.box('horn', [0.06, 0.016, 0.025], [x, y + 0.02, z], [-0.4, 0, 0.15]);
            break;
        case 'spear':
        case 'trident':
            builder.tube('detail', [x, y - 0.3, z - 0.08], [x + 0.02, y + 0.62, z + 0.12], 0.018, 0.015);
            builder.cone('horn', 0.03, 0.14, [x + 0.024, y + 0.68, z + 0.13], [-0.35, 0, -0.05], 5);
            if (weapon === 'trident') {
                for (const side of [-1, 1]) {
                    builder.cone('horn', 0.02, 0.1, [x + 0.024 + side * 0.04, y + 0.64, z + 0.13], [-0.35, 0, -0.05], 4);
                }
            }
            break;
        case 'staff':
            builder.tube('detail', [x - 0.01, y - 0.42, z - 0.12], [x + 0.02, y + 0.55, z + 0.1], 0.02, 0.016);
            builder.sphere('glow', 0.045, [x + 0.02, y + 0.6, z + 0.11], 10);
            break;
        case 'axe':
            builder.tube('detail', [x, y - 0.12, z - 0.03], [x + 0.02, y + 0.36, z + 0.06], 0.02, 0.018);
            builder.box('horn', [0.03, 0.13, 0.14], [x + 0.02, y + 0.36, z + 0.13], [0, 0, 0.3]);
            builder.box('horn', [0.02, 0.09, 0.1], [x + 0.02, y + 0.36, z + 0.03], [0, 0, 0.3]);
            break;
        case 'hammer':
            builder.tube('detail', [x, y - 0.1, z - 0.03], [x + 0.02, y + 0.3, z + 0.05], 0.02, 0.018);
            builder.box('horn', [0.1, 0.1, 0.16], [x + 0.02, y + 0.34, z + 0.06]);
            break;
        case 'bow':
            builder.curve('detail', [
                [x, y - 0.24, z + 0.06], [x + 0.04, y, z + 0.16], [x, y + 0.24, z + 0.06]
            ], 0.014, 0.014, 10, 5);
            builder.box('horn', [0.006, 0.5, 0.006], [x - 0.01, y, z + 0.05]);
            break;
        default:
            break;
    }
}

function addHumanoidHead(builder, p, y, bulk) {
    const style = p.headStyle || 'human';
    const headR = 0.095 * num(p.headSize, 1, 0.7, 1.6);
    const skin = p.bone ? 'horn' : 'body';

    if (style === 'skull') {
        builder.ellipsoid('horn', [headR, headR * 1.1, headR * 1.05], [0, y, 0], [0.05, 0, 0], 16);
        builder.box('horn', [headR * 1.1, headR * 0.4, headR * 0.8], [0, y - headR * 0.85, headR * 0.25]);
        for (const side of [-1, 1]) {
            builder.ellipsoid('detail', [headR * 0.3, headR * 0.32, headR * 0.2],
                [side * headR * 0.4, y + headR * 0.1, headR * 0.78]);
        }
        builder.box('detail', [headR * 0.16, headR * 0.3, 0.02], [0, y - headR * 0.05, headR * 0.95]);
        for (let i = 0; i < 4; i++) {
            builder.box('horn', [headR * 0.16, headR * 0.22, headR * 0.12],
                [(i - 1.5) * headR * 0.24, y - headR * 0.85, headR * 0.5]);
        }
        return;
    }

    builder.ellipsoid(skin, [headR, headR * 1.12, headR * 1.02], [0, y, 0], [0.05, 0, 0], 16);
    if (style === 'muzzle' || style === 'gnoll' || style === 'dead') {
        const length = style === 'gnoll' ? headR * 1.35 : headR * 0.9;
        builder.ellipsoid(skin, [headR * 0.55, headR * 0.5, length],
            [0, y - headR * 0.3, headR * 0.55 + length * 0.4], [0.12, 0, 0], 12);
        builder.ellipsoid('detail', [headR * 0.2, headR * 0.14, headR * 0.16],
            [0, y - headR * 0.16, headR * 0.6 + length * 0.85]);
        if (style === 'gnoll') {
            for (const side of [-1, 1]) {
                builder.cone('horn', headR * 0.08, headR * 0.3,
                    [side * headR * 0.3, y - headR * 0.62, headR * 0.7 + length * 0.5], [Math.PI, 0, 0], 5);
            }
        }
    } else if (style === 'orc') {
        builder.ellipsoid(skin, [headR * 0.6, headR * 0.5, headR * 0.6],
            [0, y - headR * 0.3, headR * 0.5], [0.1, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.cone('horn', headR * 0.1, headR * 0.45,
                [side * headR * 0.32, y - headR * 0.5, headR * 0.72], [-0.35, 0, side * 0.1], 5);
        }
    } else if (style !== 'skull') {
        builder.ellipsoid(skin, [headR * 0.62, headR * 0.6, headR * 0.5],
            [0, y - headR * 0.28, headR * 0.42], [0.08, 0, 0], 12);
        builder.ellipsoid(skin, [headR * 0.14, headR * 0.16, headR * 0.16],
            [0, y - headR * 0.1, headR * 0.92]);
    }

    // Eyes — sunken glow for the dead, plain eyes otherwise.
    const eyeY = y + headR * 0.12;
    for (const side of [-1, 1]) {
        if (style === 'dead') {
            builder.ellipsoid('glow', [headR * 0.18, headR * 0.16, headR * 0.1],
                [side * headR * 0.38, eyeY, headR * 0.82], [0, 0, 0], 8);
        } else {
            builder.ellipsoid('eye', [headR * 0.14, headR * 0.13, headR * 0.09],
                [side * headR * 0.38, eyeY, headR * 0.85], [0, 0, 0], 8);
        }
    }

    // Ears.
    const ears = p.ears || 'none';
    if (ears === 'pointy') {
        for (const side of [-1, 1]) {
            builder.cone(skin, headR * 0.18, headR * 0.55,
                [side * headR * 0.95, y + headR * 0.25, -headR * 0.05], [0.1, 0, side * 1.15], 5);
        }
    } else if (ears === 'long') {
        for (const side of [-1, 1]) {
            builder.ellipsoid(skin, [headR * 0.22, headR * 0.75, headR * 0.16],
                [side * headR * 1.05, y + headR * 0.45, -headR * 0.05], [0, 0, side * 0.5], 8);
        }
    } else if (ears === 'round') {
        for (const side of [-1, 1]) {
            builder.ellipsoid(skin, [headR * 0.24, headR * 0.26, headR * 0.14],
                [side * headR * 0.95, y + headR * 0.45, -headR * 0.05], [0, 0, side * 0.3], 8);
        }
    }

    // Horns.
    const horns = p.horns || 'none';
    if (horns !== 'none') {
        const length = num(p.hornLength, headR * 2.2, 0.05, 1.2);
        for (const side of [-1, 1]) {
            if (horns === 'small') {
                builder.cone('horn', headR * 0.2, length * 0.5,
                    [side * headR * 0.5, y + headR * 0.95, 0], [0, 0, side * 0.3], 5);
            } else if (horns === 'curved') {
                builder.curve('horn', [
                    [side * headR * 0.55, y + headR * 0.75, 0],
                    [side * headR * 0.8, y + headR * 0.75 + length * 0.5, -length * 0.2],
                    [side * headR * 0.5, y + headR * 0.7 + length, -length * 0.55]
                ], headR * 0.2, headR * 0.05, 10, 5);
            } else if (horns === 'long') {
                builder.curve('horn', [
                    [side * headR * 0.5, y + headR * 0.8, 0],
                    [side * headR * 0.75, y + headR * 1 + length * 0.4, length * 0.1],
                    [side * headR * 0.85, y + headR * 1.05 + length * 0.9, length * 0.3]
                ], headR * 0.17, headR * 0.04, 10, 5);
            } else if (horns === 'ram') {
                builder.curve('horn', [
                    [side * headR * 0.7, y + headR * 0.6, 0],
                    [side * headR * 1.3, y + headR * 0.5, -headR * 0.5],
                    [side * headR * 1.1, y + headR * 0.1, -headR * 0.2],
                    [side * headR * 0.7, y + headR * 0.3, headR * 0.35]
                ], headR * 0.18, headR * 0.05, 14, 5);
            }
        }
    }

    // Headgear.
    if (p.headgear === 'hood') {
        builder.ellipsoid('accent', [headR * 1.2, headR * 1.2, headR * 1.15],
            [0, y + headR * 0.15, -headR * 0.1], [0.1, 0, 0], 14);
        builder.ellipsoid('accent', [headR * 0.9, headR * 0.5, headR * 0.5],
            [0, y + headR * 0.85, -headR * 0.15], [0, 0, 0], 10);
    } else if (p.headgear === 'helmet') {
        builder.ellipsoid('detail', [headR * 1.15, headR * 1.15, headR * 1.1],
            [0, y + headR * 0.2, -headR * 0.05], [0.05, 0, 0], 14);
        builder.box('detail', [headR * 2.3, headR * 0.5, headR * 0.4],
            [0, y + headR * 0.1, headR * 0.8]);
        builder.box('detail', [headR * 2.4, headR * 0.14, headR * 0.5],
            [0, y + headR * 1.05, headR * 0.2]);
    } else if (p.headgear === 'crown') {
        builder.part('horn', new THREE.CylinderGeometry(headR * 0.85, headR * 0.9, headR * 0.3, 10),
            [0, y + headR * 0.8, 0]);
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            builder.cone('horn', headR * 0.14, headR * 0.4,
                [Math.cos(angle) * headR * 0.8, y + headR * 1.1, Math.sin(angle) * headR * 0.8], [0, 0, 0], 4);
        }
    }
    void bulk;
}

function buildHumanoid(rawParams) {
    const p = withArchetype(HUMANOID_ARCHETYPES, paramsOf(rawParams), 'generic');
    const group = groupOf('Humanoid');
    const bulk = num(p.bulk, 1, 0.55, 2.4);
    const slouch = num(p.slouch, 0, 0, 0.25);
    const ethereal = flag(p.ethereal) || p.form === 'floating';
    const serpentine = p.form === 'serpentine';
    const builder = new MonsterBuilder(paletteOf(p), {
        opacity: ethereal ? num(p.opacity, 0.78, 0.2, 1) : 1,
        glow: ethereal ? ['body', 'accent', 'glow'] : (p.glow ? ['glow'] : [])
    });

    const hipY = 0.5;
    const shoulderY = 0.8 - slouch;
    const headY = 0.915 - slouch * 1.4;

    // Legs — or a serpentine tail / floating wisp.
    if (serpentine) {
        builder.curve('body', [
            [0, hipY, 0], [0, hipY * 0.6, 0.12], [0, hipY * 0.28, -0.02],
            [0, hipY * 0.1, 0.16], [0, 0.04, 0.38]
        ], 0.13 * bulk, 0.03, 16, 8);
        builder.ellipsoid('accent', [0.14 * bulk, 0.07, 0.1], [0, 0.03, 0.5]);
    } else if (ethereal) {
        builder.curve('body', [
            [0, hipY, 0], [0, hipY * 0.55, 0.02], [0, hipY * 0.2, -0.04], [0, 0.02, 0.05]
        ], 0.14 * bulk, 0.01, 14, 8);
    } else {
        for (const side of [-1, 1]) {
            const hipX = side * 0.08 * bulk;
            builder.tube('accent', [hipX, hipY, 0], [hipX + side * 0.01, 0.26, 0.02], 0.07 * bulk, 0.052 * bulk);
            builder.sphere('accent', 0.055 * bulk, [hipX + side * 0.01, 0.26, 0.02], 10);
            builder.tube('accent', [hipX + side * 0.01, 0.26, 0.02], [hipX + side * 0.015, 0.07, -0.01], 0.05 * bulk, 0.038 * bulk);
            if (p.clothing === 'armor' || p.clothing === 'scale') {
                builder.box('detail', [0.09 * bulk, 0.07, 0.13], [hipX + side * 0.015, 0.035, 0.03]);
            } else {
                builder.ellipsoid('detail', [0.05 * bulk, 0.04, 0.085], [hipX + side * 0.015, 0.035, 0.045]);
            }
        }
    }

    // Torso.
    builder.ellipsoid('body', [0.14 * bulk, 0.17, 0.09 * bulk], [0, 0.62 - slouch * 0.5, 0], [slouch, 0, 0], 16);
    builder.ellipsoid('accent', [0.16 * bulk, 0.15, 0.1 * bulk], [0, shoulderY - 0.06, 0], [slouch, 0, 0], 16);
    builder.ellipsoid('accent', [0.185 * bulk, 0.06, 0.1 * bulk], [0, shoulderY - 0.02, 0], [slouch, 0, 0], 14);

    // Clothing / armour over the torso.
    const clothing = p.clothing || 'none';
    if (clothing === 'robe') {
        builder.part('accent', new THREE.CylinderGeometry(0.16 * bulk, 0.3 * bulk, 0.62, 14, 1, true),
            [0, 0.31, 0]);
        builder.part('accent', new THREE.CylinderGeometry(0.19 * bulk, 0.2 * bulk, 0.3, 14, 1, true),
            [0, 0.68 - slouch * 0.5, 0]);
        builder.part('detail', new THREE.CylinderGeometry(0.15 * bulk, 0.15 * bulk, 0.05, 12),
            [0, 0.5 - slouch * 0.3, 0]);
    } else if (clothing === 'cloth' || clothing === 'rags') {
        builder.part('accent', new THREE.CylinderGeometry(0.15 * bulk, 0.19 * bulk, clothing === 'rags' ? 0.34 : 0.4, 14, 1, true),
            [0, 0.44 - slouch * 0.3, 0]);
        builder.part('detail', new THREE.CylinderGeometry(0.145 * bulk, 0.145 * bulk, 0.045, 12),
            [0, 0.55 - slouch * 0.4, 0]);
        if (clothing === 'rags') {
            for (let i = 0; i < 7; i++) {
                const angle = (i / 7) * Math.PI * 2;
                builder.cone('accent', 0.04, 0.1,
                    [Math.cos(angle) * 0.17 * bulk, 0.26, Math.sin(angle) * 0.17 * bulk], [Math.PI, 0, 0], 4);
            }
        }
    } else if (clothing === 'armor' || clothing === 'scale') {
        builder.part('detail', new THREE.CylinderGeometry(0.175 * bulk, 0.15 * bulk, 0.3, 14, 1, true),
            [0, 0.66 - slouch * 0.5, 0]);
        builder.box('detail', [0.3 * bulk, 0.1, 0.16 * bulk], [0, shoulderY - 0.04, 0.01], [slouch, 0, 0]);
        for (const side of [-1, 1]) {
            builder.ellipsoid('detail', [0.08 * bulk, 0.07, 0.08 * bulk],
                [side * 0.17 * bulk, shoulderY - 0.03, 0]);
        }
        if (clothing === 'scale') {
            for (let row = 0; row < 4; row++) {
                for (let col = -2; col <= 2; col++) {
                    builder.ellipsoid('horn', [0.035, 0.03, 0.02],
                        [col * 0.055 * bulk, 0.74 - row * 0.055 - slouch * 0.5, 0.1 * bulk]);
                }
            }
        }
        builder.part('detail', new THREE.CylinderGeometry(0.15 * bulk, 0.15 * bulk, 0.05, 12),
            [0, 0.52 - slouch * 0.3, 0]);
    }

    // Arms (up to three pairs; extra pairs sit lower and slightly smaller).
    const arms = Math.max(2, Math.min(6, Math.round(num(p.arms, 2, 2, 6))));
    const rightHand = addHumanoidArm(builder, 1, p, shoulderY - 0.04, bulk);
    const leftHand = addHumanoidArm(builder, -1, p, shoulderY - 0.04, bulk);
    if (arms >= 4) {
        addHumanoidArm(builder, 1, p, shoulderY - 0.17, bulk, { scale: 0.9 });
        addHumanoidArm(builder, -1, p, shoulderY - 0.17, bulk, { scale: 0.9 });
    }
    if (arms >= 6) {
        addHumanoidArm(builder, 1, p, shoulderY - 0.3, bulk, { scale: 0.82 });
        addHumanoidArm(builder, -1, p, shoulderY - 0.3, bulk, { scale: 0.82 });
    }

    addWeapon(builder, rightHand, p.weapon);
    if (p.shield) {
        builder.part('detail', new THREE.CylinderGeometry(0.14, 0.14, 0.03, 12),
            [leftHand[0] - 0.04, leftHand[1] + 0.05, leftHand[2] + 0.05],
            [0, 0, Math.PI / 2]);
    }

    // Neck + head.
    builder.tube('body', [0, shoulderY, 0.01], [0, headY - 0.07, 0.01], 0.05 * bulk, 0.045 * bulk);
    addHumanoidHead(builder, p, headY, bulk);

    // Tail for fiends, kobolds and lizardfolk.
    if (p.tail && p.tail !== 'none') {
        builder.curve(p.tail === 'spade' ? 'accent' : 'body', [
            [0, hipY - 0.05, -0.08 * bulk], [0, hipY * 0.6, -0.24],
            [0, hipY * 0.42, -0.4], [0, hipY * 0.5, -0.52]
        ], 0.05 * bulk, 0.012, 14, 6);
        if (p.tail === 'spade') {
            builder.ellipsoid('accent', [0.05, 0.07, 0.02], [0, hipY * 0.54, -0.55]);
        }
    }
    if (p.crest) {
        for (let i = 0; i < 6; i++) {
            builder.cone('horn', 0.025, 0.08,
                [0, headY - 0.02 - i * 0.05, -0.06 - i * 0.03], [-1.2, 0, 0], 4);
        }
    }

    builder.finish(group, 'Humanoid');
    return group;
}

// --- dragon ------------------------------------------------------------------

function buildDragon(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Dragon');
    const bulk = num(p.bulk, 1, 0.6, 2.2);
    const torsoLength = num(p.torsoLength, 0.72, 0.3, 2);
    const torsoDepth = num(p.torsoDepth, 0.4, 0.15, 1.2);
    const legLength = num(p.legLength, 0.3, 0.08, 0.8);
    const bodyY = legLength + torsoDepth * 0.5;
    const chestZ = torsoLength * 0.2;
    const hipZ = -torsoLength * 0.26;
    const neckLength = num(p.neckLength, 0.7, 0.1, 2.4);
    const tailLength = num(p.tailLength, 1, 0.3, 3.5);
    const forelegs = p.forelegs !== false;
    const builder = new MonsterBuilder(paletteOf(p));

    // Torso.
    builder.ellipsoid('body', [0.26 * bulk, torsoDepth * 0.55, torsoLength * 0.36],
        [0, bodyY, chestZ], [-0.08, 0, 0], 18);
    builder.ellipsoid('body', [0.22 * bulk, torsoDepth * 0.44, torsoLength * 0.3],
        [0, bodyY - torsoDepth * 0.06, hipZ], [0.06, 0, 0], 16);
    builder.ellipsoid('belly', [0.19 * bulk, torsoDepth * 0.3, torsoLength * 0.5],
        [0, bodyY - torsoDepth * 0.3, 0], [0, 0, 0], 16);
    builder.ellipsoid('belly', [0.12 * bulk, torsoDepth * 0.34, torsoLength * 0.2],
        [0, bodyY - torsoDepth * 0.2, chestZ + torsoLength * 0.16]);

    // Legs.
    const legR = 0.07 * bulk;
    if (forelegs) {
        for (const side of [-1, 1]) {
            addLeg(builder, {
                x: side * 0.2 * bulk, hipY: bodyY - torsoDepth * 0.2,
                hipZ: chestZ + torsoLength * 0.16, length: legLength,
                r0: legR, colorKey: 'accent', forward: 0.06
            });
        }
    }
    for (const side of [-1, 1]) {
        addLeg(builder, {
            x: side * 0.22 * bulk, hipY: bodyY - torsoDepth * 0.16,
            hipZ: hipZ - torsoLength * 0.05, length: legLength * 1.05, bulk: 1.15,
            r0: legR * 1.15, colorKey: 'accent', forward: -0.05
        });
    }

    // Neck: rising arc from chest to head.
    const headSize = num(p.headSize, 0.15, 0.05, 0.6);
    const neckBaseY = bodyY + torsoDepth * 0.28;
    const neckBaseZ = chestZ + torsoLength * 0.24;
    const headY = neckBaseY + neckLength * 0.55;
    const headZ = neckBaseZ + neckLength * 0.5;
    builder.curve('body', [
        [0, neckBaseY - 0.04, neckBaseZ],
        [0, neckBaseY + neckLength * 0.22, neckBaseZ + neckLength * 0.16],
        [0, neckBaseY + neckLength * 0.44, neckBaseZ + neckLength * 0.3],
        [0, headY - headSize * 0.5, headZ - headSize * 0.4]
    ], torsoDepth * 0.3, headSize * 0.75, 16, 9);
    for (let i = 0; i < 6; i++) {
        const t = i / 5;
        builder.ellipsoid('belly', [0.06 * bulk * (1 - t * 0.4), 0.03, 0.05],
            [0, neckBaseY + neckLength * 0.5 * t - 0.06, neckBaseZ + neckLength * 0.42 * t + 0.03]);
    }

    // Head: long snout, brow horns, jaw.
    const muzzle = num(p.muzzle, 0.2, 0.05, 0.7);
    builder.ellipsoid('body', [headSize, headSize * 0.9, headSize * 1.15], [0, headY, headZ]);
    builder.ellipsoid('accent', [headSize * 0.6, headSize * 0.5, muzzle],
        [0, headY - headSize * 0.18, headZ + headSize * 0.7 + muzzle * 0.55]);
    builder.ellipsoid('body', [headSize * 0.7, headSize * 0.34, muzzle * 0.9],
        [0, headY + headSize * 0.16, headZ + headSize * 0.6 + muzzle * 0.5]);
    builder.box('detail', [headSize * 0.9, 0.012, headSize * 0.5],
        [0, headY - headSize * 0.34, headZ + headSize * 0.55 + muzzle * 0.55]);
    for (const side of [-1, 1]) {
        builder.ellipsoid('detail', [headSize * 0.1, headSize * 0.08, headSize * 0.08],
            [side * headSize * 0.26, headY + headSize * 0.04, headZ + headSize * 0.7 + muzzle * 0.95]);
        builder.ellipsoid('eye', [headSize * 0.17, headSize * 0.16, headSize * 0.1],
            [side * headSize * 0.66, headY + headSize * 0.26, headZ + headSize * 0.55]);
        builder.curve('horn', [
            [side * headSize * 0.5, headY + headSize * 0.5, headZ + headSize * 0.1],
            [side * headSize * 0.62, headY + headSize * 0.75, headZ - headSize * 0.3],
            [side * headSize * 0.5, headY + headSize * 0.85, headZ - headSize * 0.75]
        ], headSize * 0.16, headSize * 0.03, 9, 5);
        builder.cone('horn', headSize * 0.12, headSize * 0.5,
            [side * headSize * 0.85, headY - headSize * 0.1, headZ + headSize * 0.1],
            [0.4, 0, side * 1.2], 5);
    }
    if (p.jaw !== 'none') {
        for (const side of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                builder.cone('horn', headSize * 0.05, headSize * 0.16,
                    [side * headSize * 0.34, headY - headSize * 0.4, headZ + headSize * 0.5 + i * muzzle * 0.28],
                    [Math.PI, 0, 0], 4);
            }
        }
    }

    // Tail.
    const tailRise = num(p.tailRise, 0.1, -0.5, 1);
    builder.curve('body', [
        [0, bodyY - torsoDepth * 0.05, hipZ - torsoLength * 0.22],
        [0, bodyY + tailRise * 0.2, hipZ - tailLength * 0.3],
        [0, bodyY + tailRise * 0.3 - tailLength * 0.12, hipZ - tailLength * 0.6],
        [0, bodyY + tailRise * 0.2 - tailLength * 0.38, hipZ - tailLength * 0.9],
        [0, bodyY + tailRise * 0.1 - tailLength * 0.7, hipZ - tailLength * 1.15]
    ], 0.14 * bulk, 0.012, 20, 8);
    if (p.tailBlade) {
        polygon(builder, 'horn', [
            [0, bodyY + 0.1, hipZ - tailLength * 1.0],
            [0, bodyY + 0.26, hipZ - tailLength * 1.3],
            [0, bodyY - 0.04, hipZ - tailLength * 1.38]
        ], 0.03);
    }

    // Dorsal spines.
    if (p.spines !== false) {
        for (let i = 0; i < 10; i++) {
            const t = i / 9;
            const z = chestZ + torsoLength * 0.3 - t * (torsoLength * 0.75 + tailLength * 0.5);
            const y = bodyY + torsoDepth * (0.45 - t * 0.25);
            builder.cone('horn', 0.035 * bulk * (1 - Math.abs(t - 0.3) * 0.6), 0.12 * bulk,
                [0, y, z], [-0.5 + t * 0.7, 0, 0], 4);
        }
        for (let i = 0; i < 5; i++) {
            const t = i / 4;
            builder.cone('horn', 0.03, 0.1,
                [0, neckBaseY + neckLength * 0.5 * t + 0.02, neckBaseZ + neckLength * 0.45 * t],
                [-0.9, 0, 0], 4);
        }
    }

    // Wings: arm chain + finger spars + membrane fan.
    const wing = p.wings || 'large';
    if (wing !== 'none') {
        const span = wing === 'small' ? 0.5 : num(p.wingSpan, 1, 0.4, 2.4);
        for (const side of [-1, 1]) {
            const shoulder = [side * 0.18 * bulk, bodyY + torsoDepth * 0.3, chestZ + torsoLength * 0.1];
            const elbow = [side * (0.3 + span * 0.35), bodyY + torsoDepth * 0.55 + span * 0.18, chestZ - span * 0.1];
            const wrist = [side * (0.35 + span * 0.75), bodyY + torsoDepth * 0.6 + span * 0.4, chestZ - span * 0.35];
            builder.tube('accent', shoulder, elbow, 0.05 * bulk, 0.04 * bulk);
            builder.sphere('accent', 0.045 * bulk, elbow, 8);
            builder.tube('accent', elbow, wrist, 0.04 * bulk, 0.028 * bulk);
            builder.sphere('accent', 0.035 * bulk, wrist, 8);

            const fingerTips = [];
            for (let f = 0; f < 4; f++) {
                const t = f / 3;
                const tip = [
                    wrist[0] + side * span * 0.12 * (1 - t),
                    wrist[1] + span * 0.22 - t * span * 0.7,
                    wrist[2] - span * 0.1 - t * span * 0.5
                ];
                builder.tube('horn', wrist, tip, 0.02 * bulk, 0.006, 6);
                fingerTips.push(tip);
            }
            polygon(builder, 'membrane', [
                shoulder, elbow, wrist, ...fingerTips,
                [side * 0.14 * bulk, bodyY + torsoDepth * 0.1, hipZ + torsoLength * 0.1]
            ], 0.012);
        }
    }

    builder.finish(group, 'Dragon');
    return group;
}

// --- saurian -----------------------------------------------------------------

function buildSaurian(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Saurian');
    const biped = flag(p.biped);
    const bulk = num(p.bulk, 1, 0.6, 2.4);
    const torsoLength = num(p.torsoLength, 0.6, 0.25, 1.8);
    const torsoDepth = num(p.torsoDepth, 0.36, 0.15, 1.2);
    const torsoWidth = num(p.torsoWidth, 0.26, 0.1, 0.8);
    const legLength = num(p.legLength, biped ? 0.42 : 0.3, 0.1, 0.9);
    const bodyY = legLength + torsoDepth * 0.48;
    const chestZ = torsoLength * 0.22;
    const hipZ = -torsoLength * 0.24;
    const tailLength = num(p.tailLength, 0.9, 0.2, 2.4);
    const builder = new MonsterBuilder(paletteOf(p), { flatShading: flag(p.flat) });

    // Torso.
    builder.ellipsoid('body', [torsoWidth * bulk, torsoDepth * 0.55, torsoLength * 0.4],
        [0, bodyY, chestZ], [-0.05, 0, 0], 16);
    builder.ellipsoid('body', [torsoWidth * 0.92 * bulk, torsoDepth * 0.48, torsoLength * 0.34],
        [0, bodyY - torsoDepth * 0.04, hipZ], [0.04, 0, 0], 16);
    builder.ellipsoid('belly', [torsoWidth * 0.75 * bulk, torsoDepth * 0.3, torsoLength * 0.5],
        [0, bodyY - torsoDepth * 0.3, 0], [0, 0, 0], 14);

    if (biped) {
        // Powerful hind legs.
        for (const side of [-1, 1]) {
            const x = side * torsoWidth * 0.7 * bulk;
            builder.tube('accent', [x, bodyY - torsoDepth * 0.1, hipZ], [x + 0.02, bodyY - legLength * 0.5, hipZ + 0.1],
                0.09 * bulk, 0.06 * bulk);
            builder.sphere('accent', 0.07 * bulk, [x + 0.02, bodyY - legLength * 0.5, hipZ + 0.1], 10);
            builder.tube('accent', [x + 0.02, bodyY - legLength * 0.5, hipZ + 0.1], [x + 0.01, legLength * 0.16, hipZ - 0.04],
                0.055 * bulk, 0.035 * bulk);
            builder.ellipsoid('detail', [0.055 * bulk, 0.035, 0.1],
                [x + 0.01, legLength * 0.09, hipZ + 0.07]);
            for (const claw of [-1, 0, 1]) {
                builder.cone('horn', 0.016, 0.06,
                    [x + claw * 0.035, legLength * 0.05, hipZ + 0.17], [Math.PI / 2 + 0.3, 0, 0], 4);
            }
        }
        // Small clawed arms.
        for (const side of [-1, 1]) {
            const x = side * torsoWidth * 0.8 * bulk;
            builder.tube('accent', [x, bodyY + torsoDepth * 0.15, chestZ + torsoLength * 0.2],
                [x + side * 0.04, bodyY - 0.02, chestZ + torsoLength * 0.34], 0.04 * bulk, 0.03 * bulk);
            for (let claw = -1; claw <= 1; claw += 1) {
                builder.cone('horn', 0.012, 0.05,
                    [x + side * 0.05 + claw * 0.02, bodyY - 0.05, chestZ + torsoLength * 0.4], [2.4, 0, 0], 4);
            }
        }
    } else {
        const stanceX = torsoWidth * 0.75 * bulk;
        for (const side of [-1, 1]) {
            addLeg(builder, {
                x: side * stanceX, hipY: bodyY - torsoDepth * 0.2,
                hipZ: chestZ + torsoLength * 0.18, length: legLength, r0: 0.07 * bulk,
                colorKey: 'accent', forward: 0.05
            });
            addLeg(builder, {
                x: side * stanceX, hipY: bodyY - torsoDepth * 0.22,
                hipZ: hipZ - torsoLength * 0.06, length: legLength, r0: 0.075 * bulk,
                colorKey: 'accent', forward: -0.04
            });
        }
    }

    // Neck + head.
    const neckLength = num(p.neckLength, 0.3, 0.05, 1.6);
    const headSize = num(p.headSize, 0.14, 0.05, 0.5);
    const neckBaseY = bodyY + torsoDepth * 0.3;
    const neckBaseZ = chestZ + torsoLength * 0.28;
    const headY = neckBaseY + neckLength * 0.5;
    const headZ = neckBaseZ + neckLength * 0.7;
    builder.curve('body', [
        [0, neckBaseY - 0.05, neckBaseZ],
        [0, neckBaseY + neckLength * 0.3, neckBaseZ + neckLength * 0.3],
        [0, headY - headSize * 0.4, headZ - headSize * 0.5]
    ], torsoDepth * 0.3, headSize * 0.7, 12, 8);

    const snout = p.snout || 'sharp';
    const muzzle = snout === 'wide' ? headSize * 1.1 : snout === 'long' ? headSize * 1.6 : headSize * 1.05;
    builder.ellipsoid('body', [headSize * 0.85, headSize * 0.85, headSize], [0, headY, headZ]);
    builder.ellipsoid('accent', [headSize * 0.5, headSize * 0.42, muzzle],
        [0, headY - headSize * 0.14, headZ + headSize * 0.6 + muzzle * 0.5]);
    builder.box('detail', [headSize * 0.8, 0.012, muzzle * 0.9],
        [0, headY - headSize * 0.3, headZ + headSize * 0.55 + muzzle * 0.5]);
    for (const side of [-1, 1]) {
        builder.ellipsoid('eye', [headSize * 0.15, headSize * 0.14, headSize * 0.1],
            [side * headSize * 0.55, headY + headSize * 0.2, headZ + headSize * 0.5]);
    }
    if (p.teeth !== false) {
        for (const side of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                builder.cone('horn', headSize * 0.045, headSize * 0.14,
                    [side * headSize * 0.3, headY - headSize * 0.34, headZ + headSize * 0.55 + i * muzzle * 0.26],
                    [Math.PI, 0, 0], 4);
            }
        }
    }

    // Frill / horns / crest.
    if (p.frill) {
        const frillPoints = [];
        for (let i = 0; i <= 8; i++) {
            const angle = -0.4 + (i / 8) * (Math.PI + 0.8);
            frillPoints.push([
                Math.cos(angle) * headSize * 1.9,
                headY + headSize * 0.6 + Math.sin(angle) * headSize * 1.4,
                headZ - headSize * 0.7
            ]);
        }
        frillPoints.push([0, headY - headSize * 0.6, headZ - headSize * 0.5]);
        polygon(builder, 'accent', frillPoints, 0.03);
        for (const side of [-1, 1]) {
            builder.cone('horn', headSize * 0.16, headSize * 1.1,
                [side * headSize * 0.5, headY + headSize * 0.7, headZ + headSize * 0.2],
                [-0.6, 0, side * 0.5], 6);
        }
        builder.cone('horn', headSize * 0.2, headSize * 0.6, [0, headY + headSize * 0.1, headZ + headSize * 1.4],
            [1.35, 0, 0], 6);
    }
    if (p.browHorns) {
        for (const side of [-1, 1]) {
            builder.cone('horn', headSize * 0.14, headSize * 0.7,
                [side * headSize * 0.4, headY + headSize * 0.5, headZ + headSize * 0.45],
                [-0.9, 0, side * 0.35], 6);
        }
    }
    if (p.crest) {
        for (let i = 0; i < 7; i++) {
            builder.cone('horn', 0.03, 0.1,
                [0, neckBaseY + 0.08 - i * 0.02, neckBaseZ - i * 0.07], [-0.4, 0, 0], 4);
        }
    }

    // Tail (+ club / spikes).
    const tailClub = flag(p.club);
    builder.curve('body', [
        [0, bodyY - torsoDepth * 0.05, hipZ - torsoLength * 0.24],
        [0, bodyY - torsoDepth * 0.1, hipZ - tailLength * 0.35],
        [0, bodyY - torsoDepth * 0.22, hipZ - tailLength * 0.7],
        [0, bodyY - torsoDepth * 0.4 + (tailClub ? 0.15 : 0), hipZ - tailLength]
    ], 0.12 * bulk, tailClub ? 0.07 : 0.015, 18, 8);
    if (tailClub) {
        builder.ellipsoid('accent', [0.11 * bulk, 0.1, 0.12 * bulk],
            [0, bodyY - torsoDepth * 0.4 + 0.16, hipZ - tailLength - 0.05]);
    }
    if (p.tailSpikes) {
        for (const side of [-1, 1]) {
            builder.cone('horn', 0.03, 0.16,
                [side * 0.05, bodyY - torsoDepth * 0.3 + 0.06, hipZ - tailLength * 0.9],
                [-0.5, 0, side * 0.8], 4);
        }
    }

    // Back plates (stegosaur) or armour domes (ankylosaur).
    if (p.plates) {
        for (let i = 0; i < 8; i++) {
            const t = i / 7;
            const z = chestZ + torsoLength * 0.25 - t * (torsoLength * 0.8 + tailLength * 0.35);
            const y = bodyY + torsoDepth * (0.5 - Math.abs(t - 0.35) * 0.3);
            const size = 0.1 + Math.sin(t * Math.PI) * 0.12;
            polygon(builder, 'horn', [
                [-size * 0.4, y, z + size * 0.4], [0, y + size * 1.6, z], [-size * 0.4, y, z - size * 0.5],
                [size * 0.4, y, z - size * 0.5], [0, y + size * 1.6, z], [size * 0.4, y, z + size * 0.4]
            ], 0.02);
        }
    }
    if (p.armorDomes) {
        for (let row = 0; row < 3; row++) {
            for (const side of [-1, 0, 1]) {
                builder.ellipsoid('horn', [0.07 * bulk, 0.05, 0.09 * bulk],
                    [side * 0.14 * bulk, bodyY + torsoDepth * 0.42, chestZ - row * torsoLength * 0.3]);
            }
        }
    }

    builder.finish(group, 'Saurian');
    return group;
}

// --- avian -------------------------------------------------------------------

function buildAvian(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Avian');
    const legLength = num(p.legLength, 0.28, 0.05, 0.7);
    const bodyY = legLength + 0.2;
    const bodySize = num(p.bodySize, 0.24, 0.08, 0.7);
    const wingMode = p.wings || 'folded';
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const builder = new MonsterBuilder(paletteOf(p));

    // Body: plume ellipsoid tipped forward.
    builder.ellipsoid('body', [bodySize * 0.8 * bulk, bodySize * bulk, bodySize * 1.25 * bulk],
        [0, bodyY, 0], [0.35, 0, 0], 16);
    builder.ellipsoid('belly', [bodySize * 0.62 * bulk, bodySize * 0.7 * bulk, bodySize * 0.9 * bulk],
        [0, bodyY - bodySize * 0.28, bodySize * 0.15], [0.3, 0, 0], 14);

    // Neck + head.
    const headY = bodyY + bodySize * (p.upright ? 1.5 : 1.1);
    const headZ = bodySize * (p.upright ? 0.35 : 0.75);
    builder.curve('accent', [
        [0, bodyY + bodySize * 0.55, bodySize * 0.5],
        [0, bodyY + bodySize * 0.9, bodySize * 0.6],
        [0, headY - bodySize * 0.2, headZ - bodySize * 0.2]
    ], bodySize * 0.4, bodySize * 0.34, 8, 7);
    const headR = bodySize * 0.5;
    builder.ellipsoid('accent', [headR, headR * 1.05, headR], [0, headY, headZ]);

    // Beak — skipped for mammals (beak: 'none'), which get ears instead.
    const beakStyle = p.beak || 'short';
    if (beakStyle !== 'none') {
        const beakSize = num(p.beakLength, 0.12, 0.02, 0.5) * (beakStyle === 'long' ? 1.5 : 1);
        builder.cone('horn', headR * (beakStyle === 'hook' || beakStyle === 'raptor' ? 0.5 : 0.42), beakSize,
            [0, headY - headR * 0.1, headZ + headR * 0.7 + beakSize * 0.4], [Math.PI / 2 - 0.08, 0, 0], 6);
        if (beakStyle === 'hook' || beakStyle === 'raptor') {
            builder.cone('horn', headR * 0.24, beakSize * 0.5,
                [0, headY - headR * 0.45, headZ + headR * 0.7 + beakSize * 0.75], [Math.PI / 2 + 0.9, 0, 0], 5);
        }
    }
    if (p.mammal) {
        for (const side of [-1, 1]) {
            builder.cone('accent', headR * 0.3, headR * 1.35,
                [side * headR * 0.5, headY + headR * 1.1, headZ - headR * 0.15], [-0.12, 0, side * -0.28], 4);
        }
    }
    for (const side of [-1, 1]) {
        builder.ellipsoid('eye', [headR * 0.2, headR * 0.2, headR * 0.14],
            [side * headR * 0.62, headY + headR * 0.15, headZ + headR * 0.55]);
    }
    if (p.crest) {
        for (let i = 0; i < 5; i++) {
            builder.cone('horn', headR * 0.16, headR * (0.9 - i * 0.12),
                [(i - 2) * headR * 0.2, headY + headR * 0.9, headZ - i * headR * 0.08],
                [-0.3, 0, (i - 2) * 0.25], 4);
        }
    }

    // Legs.
    const talons = p.legs === 'talons' || beakStyle === 'hook' || beakStyle === 'raptor';
    for (const side of [-1, 1]) {
        const x = side * bodySize * 0.4;
        builder.tube('detail', [x, bodyY - bodySize * 0.3, 0], [x, legLength * 0.4, 0.02], 0.03 * bulk, 0.022 * bulk);
        builder.tube('detail', [x, legLength * 0.4, 0.02], [x, legLength * 0.06, -0.01], 0.02 * bulk, 0.016 * bulk);
        for (let toe = 0; toe < 3; toe++) {
            const spread = (toe - 1) * 0.05;
            builder.tube('detail', [x, legLength * 0.05, 0.01],
                [x + spread, legLength * 0.02, 0.06 + Math.abs(spread) * 0.4], 0.012 * bulk, 0.008 * bulk, 5);
            if (talons) {
                builder.cone('horn', 0.01, 0.04, [x + spread, legLength * 0.02, 0.08 + Math.abs(spread) * 0.4],
                    [2.6, 0, 0], 4);
            }
        }
        builder.tube('detail', [x, legLength * 0.05, 0.01], [x, legLength * 0.03, -0.05], 0.011 * bulk, 0.008 * bulk, 5);
    }

    // Wings.
    if (wingMode !== 'none') {
        for (const side of [-1, 1]) {
            const shoulder = [side * bodySize * 0.7 * bulk, bodyY + bodySize * 0.45, bodySize * 0.1];
            if (wingMode === 'spread') {
                const elbow = [side * bodySize * 1.5 * bulk, bodyY + bodySize * 1.0, -bodySize * 0.1];
                const tip = [side * bodySize * (2.6 + num(p.wingSpan, 0, 0, 1.5)) * bulk,
                    bodyY + bodySize * 1.4, -bodySize * 0.5];
                builder.tube('accent', shoulder, elbow, bodySize * 0.2, bodySize * 0.14, 6);
                builder.tube('accent', elbow, tip, bodySize * 0.14, bodySize * 0.06, 6);
                const featherPoints = [shoulder, elbow, tip];
                for (let f = 0; f < 5; f++) {
                    const t = f / 4;
                    featherPoints.push([
                        side * bodySize * (1.4 + t * 1.4) * bulk,
                        bodyY + bodySize * (0.75 - t * 0.9),
                        -bodySize * (0.3 + t * 1.1)
                    ]);
                }
                featherPoints.push([side * bodySize * 0.6 * bulk, bodyY - bodySize * 0.4, -bodySize * 0.4]);
                polygon(builder, 'accent', featherPoints, 0.014);
                for (let f = 0; f < 4; f++) {
                    const t = f / 3;
                    builder.tube('horn', [
                        side * bodySize * (1.3 + t * 1.2) * bulk,
                        bodyY + bodySize * (0.7 - t * 0.8),
                        -bodySize * (0.4 + t * 0.9)
                    ], [
                        side * bodySize * (1.5 + t * 1.5) * bulk,
                        bodyY + bodySize * (0.35 - t * 0.9),
                        -bodySize * (0.9 + t * 1.3)
                    ], 0.02, 0.004, 5);
                }
            } else {
                builder.ellipsoid('accent', [bodySize * 0.28 * bulk, bodySize * 0.42, bodySize * 1.0],
                    [side * bodySize * 0.72 * bulk, bodyY + bodySize * 0.1, -bodySize * 0.35],
                    [0.15, side * 0.12, side * 0.25], 12);
                for (let f = 0; f < 4; f++) {
                    builder.tube('horn',
                        [side * bodySize * 0.8 * bulk, bodyY - f * 0.01, -bodySize * (0.5 + f * 0.12)],
                        [side * bodySize * 0.75 * bulk, bodyY - 0.02 - f * 0.012, -bodySize * (1.2 + f * 0.16)],
                        0.02, 0.005, 5);
                }
            }
        }
    }

    // Tail fan.
    const tailZ = -bodySize * 1.15;
    const fan = Math.max(3, Math.min(9, Math.round(num(p.tailFan, 5, 3, 9))));
    const tailPoints = [];
    for (let i = 0; i <= fan; i++) {
        const t = i / fan - 0.5;
        tailPoints.push([t * bodySize * 1.5 * bulk, bodyY - bodySize * 0.2,
            tailZ - bodySize * (0.9 - Math.abs(t) * 0.5)]);
    }
    tailPoints.push([0, bodyY + bodySize * 0.1, tailZ + bodySize * 0.1]);
    polygon(builder, 'accent', tailPoints, 0.014);

    if (p.plume) {
        for (let i = 0; i < 4; i++) {
            builder.tube('horn', [0, bodyY + bodySize * 0.2, -bodySize * (0.9 + i * 0.1)],
                [0, bodyY + bodySize * (0.5 + i * 0.12), -bodySize * (1.5 + i * 0.3)], 0.014, 0.003, 5);
        }
    }

    builder.finish(group, 'Avian');
    return group;
}

// --- serpent -----------------------------------------------------------------

function buildSerpent(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Serpent');
    const bodyLength = num(p.bodyLength, 3, 0.6, 9);
    const thickness = num(p.thickness, 0.14, 0.04, 0.6);
    const raised = num(p.raised, 0.5, 0, 1.6);
    const coils = Math.max(1, Math.min(3, Math.round(num(p.coils, 1, 1, 3))));
    const builder = new MonsterBuilder(paletteOf(p));

    // Ground path: S-curves, optionally stacked into coils.
    const points = [];
    const segments = 16;
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const wave = Math.sin(t * Math.PI * 2 * coils) * (0.32 / coils);
        points.push([wave, thickness * 0.9, -bodyLength * 0.5 + t * bodyLength * 0.72]);
    }
    // Raise the front of the body and lift the head.
    const riseStart = Math.floor(segments * 0.6);
    for (let i = riseStart; i <= segments; i++) {
        const t = (i - riseStart) / (segments - riseStart);
        const point = points[i];
        point[1] += raised * t * t * 1.15;
        point[2] += raised * t * 0.3;
        if (t > 0.7) point[1] -= raised * (t - 0.7) * 1.2;
    }
    builder.curve('body', points, thickness * (p.bulge ? 1.5 : 1.15), thickness * 0.3, 44, 9);

    // Belly scutes read as a snake even from a shallow camera angle.
    for (let i = 1; i < points.length - 2; i += 2) {
        const point = points[i];
        builder.ellipsoid('belly', [thickness * 0.8, thickness * 0.3, thickness * 0.5],
            [point[0], point[1] - thickness * 0.7, point[2]]);
    }

    // Head at the raised end.
    const headPoint = points[points.length - 1];
    const headSize = num(p.headSize, thickness * 1.6, 0.05, 0.7);
    const headY = headPoint[1] + headSize * 0.4;
    const headZ = headPoint[2] + headSize * 0.5;
    const flat = headSize * (p.viper ? 1.35 : 1);
    builder.ellipsoid('body', [flat, headSize * 0.7, headSize * 1.15], [0, headY, headZ], [0.15, 0, 0], 14);
    builder.ellipsoid('accent', [flat * 0.6, headSize * 0.4, headSize * 0.7],
        [0, headY - headSize * 0.2, headZ + headSize * 0.85], [0.2, 0, 0], 12);
    builder.box('detail', [headSize * 1.1, 0.01, headSize * 0.6],
        [0, headY - headSize * 0.34, headZ + headSize * 0.6]);
    for (const side of [-1, 1]) {
        builder.ellipsoid('eye', [headSize * 0.2, headSize * 0.18, headSize * 0.12],
            [side * flat * 0.7, headY + headSize * 0.15, headZ + headSize * 0.4]);
    }
    if (p.fangs) {
        for (const side of [-1, 1]) {
            builder.cone('horn', headSize * 0.07, headSize * 0.3,
                [side * headSize * 0.3, headY - headSize * 0.42, headZ + headSize * 1.1],
                [Math.PI - 0.2, 0, 0], 5);
        }
    }
    // Tongue flick.
    builder.tube('accent', [0, headY - headSize * 0.25, headZ + headSize * 1.3],
        [0, headY - headSize * 0.3, headZ + headSize * 1.9], 0.02, 0.008, 4);
    if (p.hood) {
        for (const side of [-1, 1]) {
            polygon(builder, 'accent', [
                [side * headSize * 0.4, headY + headSize * 0.4, headZ - headSize * 0.6],
                [side * flat * 2.2, headY + headSize * 0.9, headZ - headSize * 1.4],
                [side * flat * 2.0, headY - headSize * 0.6, headZ - headSize * 1.6],
                [side * headSize * 0.3, headY - headSize * 0.5, headZ - headSize * 0.8]
            ], 0.02);
        }
    }
    if (p.rattle) {
        const tailPoint = points[0];
        for (let i = 0; i < 4; i++) {
            builder.box('horn', [thickness * 0.5 * (1 - i * 0.15), thickness * 0.4, thickness * 0.45],
                [tailPoint[0], tailPoint[1] + thickness * 0.4, tailPoint[2] - i * thickness * 0.55]);
        }
    }

    builder.finish(group, 'Serpent');
    return group;
}

// --- arthropod ---------------------------------------------------------------

function addArthropodLeg(builder, x, z, y, reach, colorKey, segments = 3) {
    const joints = [
        [x, y, z],
        [x + Math.sign(x || 1) * reach * 0.5, y + reach * 0.35, z],
        [x + Math.sign(x || 1) * reach * 0.95, y + reach * 0.1, z + reach * 0.1],
        [x + Math.sign(x || 1) * reach * 1.1, 0.01, z + reach * 0.25]
    ];
    for (let i = 0; i < segments; i++) {
        const from = joints[i];
        const to = joints[i + 1];
        builder.tube(colorKey, from, to, 0.028 * (1 - i * 0.2), 0.02 * (1 - i * 0.22), 6);
        if (i < segments - 1) builder.sphere(colorKey, 0.026 * (1 - i * 0.2), to, 7);
    }
}

function buildArthropod(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Arthropod');
    const form = pick(p.form, ['spider', 'scorpion', 'centipede', 'beetle', 'crab'], 'spider');
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const builder = new MonsterBuilder(paletteOf(p));

    if (form === 'spider') {
        const bodyY = 0.16 * bulk;
        const abdomenR = 0.22 * bulk;
        // Abdomen behind, cephalothorax in front.
        builder.ellipsoid('body', [abdomenR, abdomenR * 0.9, abdomenR * 1.25], [0, bodyY + 0.04, -0.28 * bulk], [-0.15, 0, 0], 16);
        builder.ellipsoid('accent', [0.16 * bulk, 0.13 * bulk, 0.18 * bulk], [0, bodyY, 0.06 * bulk], [0.1, 0, 0], 14);
        if (p.pattern) {
            builder.ellipsoid('belly', [abdomenR * 0.55, abdomenR * 0.6, abdomenR * 0.5],
                [0, bodyY + 0.16, -0.34 * bulk]);
        }
        // Eyes + chelicerae.
        const eyes = Math.max(2, Math.min(8, Math.round(num(p.eyes, 4, 2, 8))));
        for (let i = 0; i < eyes; i++) {
            const spread = (i % 2 ? 1 : -1) * (0.03 + Math.floor(i / 2) * 0.035) * bulk;
            builder.sphere('eye', 0.022 * bulk, [spread, bodyY + 0.1 * bulk, 0.2 * bulk], 7);
        }
        for (const side of [-1, 1]) {
            builder.cone('horn', 0.03 * bulk, 0.12 * bulk,
                [side * 0.05 * bulk, bodyY - 0.02, 0.22 * bulk], [2.6, 0, side * 0.2], 5);
        }
        // Eight legs, four per side.
        const legs = Math.max(4, Math.min(6, Math.round(num(p.legs, 4, 4, 6))));
        for (let i = 0; i < legs; i++) {
            const z = (i - (legs - 1) / 2) * 0.12 * bulk;
            for (const side of [-1, 1]) {
                addArthropodLeg(builder, side * 0.12 * bulk, z, bodyY, 0.3 * bulk, 'accent');
            }
        }
        // Pedipalps.
        for (const side of [-1, 1]) {
            addArthropodLeg(builder, side * 0.08 * bulk, 0.16 * bulk, bodyY, 0.16 * bulk, 'accent', 2);
        }
    } else if (form === 'scorpion') {
        const bodyY = 0.14 * bulk;
        // Segmented body.
        for (let i = 0; i < 4; i++) {
            const size = (0.2 - i * 0.02) * bulk;
            builder.ellipsoid(i < 2 ? 'accent' : 'body', [size, size * 0.6, size * 0.75],
                [0, bodyY, 0.24 * bulk - i * 0.17 * bulk], [0, 0, 0], 12);
        }
        // Pincers.
        for (const side of [-1, 1]) {
            const base = [side * 0.14 * bulk, bodyY + 0.02, 0.34 * bulk];
            builder.tube('accent', base, [side * 0.26 * bulk, bodyY + 0.08, 0.5 * bulk], 0.045 * bulk, 0.035 * bulk, 6);
            builder.ellipsoid('body', [0.07 * bulk, 0.05 * bulk, 0.1 * bulk],
                [side * 0.3 * bulk, bodyY + 0.08, 0.58 * bulk], [0, side * 0.3, 0], 10);
            builder.cone('horn', 0.03 * bulk, 0.12 * bulk,
                [side * 0.3 * bulk, bodyY + 0.06, 0.66 * bulk], [1.7, 0, side * 0.2], 5);
        }
        // Legs.
        for (let i = 0; i < 4; i++) {
            const z = 0.2 * bulk - i * 0.13 * bulk;
            for (const side of [-1, 1]) {
                addArthropodLeg(builder, side * 0.12 * bulk, z, bodyY, 0.24 * bulk, 'accent');
            }
        }
        // Arched tail with stinger.
        const tailBase = [0, bodyY + 0.04, -0.36 * bulk];
        builder.curve('body', [
            tailBase,
            [0, bodyY + 0.16, -0.5 * bulk],
            [0, bodyY + 0.36, -0.52 * bulk],
            [0, bodyY + 0.5, -0.38 * bulk],
            [0, bodyY + 0.52, -0.2 * bulk]
        ], 0.055 * bulk, 0.02 * bulk, 18, 7);
        builder.cone('horn', 0.035 * bulk, 0.14 * bulk,
            [0, bodyY + 0.5, -0.12 * bulk], [2.4, 0, 0], 5);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.02 * bulk, [side * 0.05 * bulk, bodyY + 0.12 * bulk, 0.34 * bulk], 7);
        }
    } else if (form === 'centipede') {
        const segments = Math.max(6, Math.min(16, Math.round(num(p.segments, 10, 6, 16))));
        for (let i = 0; i < segments; i++) {
            const t = i / (segments - 1);
            const size = (0.13 - t * 0.05) * bulk;
            const z = 0.5 * bulk - t * 1.1 * bulk;
            const y = 0.13 * bulk + Math.sin(t * Math.PI) * 0.03;
            builder.ellipsoid(i % 2 ? 'body' : 'accent', [size, size * 0.8, size * 0.85], [0, y, z], [0, 0, 0], 10);
            if (i < segments - 1) {
                for (const side of [-1, 1]) {
                    builder.tube('horn', [side * size * 0.8, y, z], [side * size * 2.2, 0.02, z + 0.02],
                        0.014 * bulk, 0.006 * bulk, 5);
                }
            }
        }
        // Head with antennae and forcipules.
        const headZ = 0.56 * bulk;
        builder.ellipsoid('accent', [0.14 * bulk, 0.11 * bulk, 0.13 * bulk], [0, 0.14 * bulk, headZ], [0.2, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.02 * bulk, [side * 0.06 * bulk, 0.18 * bulk, headZ + 0.1 * bulk], 7);
            builder.curve('horn', [
                [side * 0.05 * bulk, 0.2 * bulk, headZ + 0.08 * bulk],
                [side * 0.16 * bulk, 0.3 * bulk, headZ + 0.24 * bulk],
                [side * 0.24 * bulk, 0.34 * bulk, headZ + 0.4 * bulk]
            ], 0.014 * bulk, 0.004 * bulk, 8, 5);
            builder.cone('horn', 0.02 * bulk, 0.1 * bulk,
                [side * 0.07 * bulk, 0.1 * bulk, headZ + 0.12 * bulk], [2.2, 0, side * 0.4], 5);
        }
    } else if (form === 'beetle') {
        const bodyY = 0.16 * bulk;
        // Shell dome + head.
        builder.ellipsoid('body', [0.26 * bulk, 0.2 * bulk, 0.34 * bulk], [0, bodyY, -0.05 * bulk], [0, 0, 0], 16);
        builder.ellipsoid('belly', [0.22 * bulk, 0.1 * bulk, 0.3 * bulk], [0, bodyY - 0.1 * bulk, -0.05 * bulk], [0, 0, 0], 12);
        builder.ellipsoid('accent', [0.13 * bulk, 0.1 * bulk, 0.12 * bulk], [0, bodyY, 0.3 * bulk], [0.1, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.022 * bulk, [side * 0.07 * bulk, bodyY + 0.05 * bulk, 0.4 * bulk], 7);
        }
        if (p.horn) {
            builder.curve('horn', [
                [0, bodyY + 0.06 * bulk, 0.36 * bulk],
                [0, bodyY + 0.24 * bulk, 0.44 * bulk],
                [0, bodyY + 0.4 * bulk, 0.36 * bulk]
            ], 0.035 * bulk, 0.01 * bulk, 10, 6);
        }
        if (p.pincers) {
            for (const side of [-1, 1]) {
                builder.curve('horn', [
                    [side * 0.05 * bulk, bodyY, 0.38 * bulk],
                    [side * 0.12 * bulk, bodyY + 0.06 * bulk, 0.5 * bulk],
                    [side * 0.08 * bulk, bodyY + 0.04 * bulk, 0.6 * bulk]
                ], 0.025 * bulk, 0.008 * bulk, 8, 5);
            }
        }
        // Six legs.
        for (let i = 0; i < 3; i++) {
            const z = 0.2 * bulk - i * 0.18 * bulk;
            for (const side of [-1, 1]) {
                addArthropodLeg(builder, side * 0.14 * bulk, z, bodyY - 0.04, 0.26 * bulk, 'accent');
            }
        }
    } else {
        // crab — wide carapace, big claws, four walking legs.
        const bodyY = 0.16 * bulk;
        builder.ellipsoid('body', [0.34 * bulk, 0.16 * bulk, 0.24 * bulk], [0, bodyY, 0], [0, 0, 0], 16);
        builder.ellipsoid('belly', [0.3 * bulk, 0.08 * bulk, 0.2 * bulk], [0, bodyY - 0.1 * bulk, 0], [0, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.024 * bulk, [side * 0.08 * bulk, bodyY + 0.14 * bulk, 0.16 * bulk], 7);
            // Claw arm.
            builder.tube('accent', [side * 0.24 * bulk, bodyY, 0.1 * bulk],
                [side * 0.4 * bulk, bodyY + 0.05, 0.28 * bulk], 0.05 * bulk, 0.04 * bulk, 6);
            builder.ellipsoid('body', [0.1 * bulk, 0.07 * bulk, 0.13 * bulk],
                [side * 0.46 * bulk, bodyY + 0.06, 0.38 * bulk], [0, side * 0.4, 0], 10);
            builder.cone('horn', 0.035 * bulk, 0.14 * bulk,
                [side * 0.46 * bulk, bodyY + 0.04, 0.5 * bulk], [1.6, 0, side * 0.3], 5);
        }
        for (let i = 0; i < 4; i++) {
            const z = 0.12 * bulk - i * 0.1 * bulk;
            for (const side of [-1, 1]) {
                addArthropodLeg(builder, side * 0.24 * bulk, z, bodyY - 0.02, 0.24 * bulk, 'accent');
            }
        }
    }

    builder.finish(group, 'Arthropod');
    return group;
}

// --- aquatic -----------------------------------------------------------------

function finPolygon(builder, key, base, width, height, sweep = 0) {
    polygon(builder, key, [
        [base[0] - width / 2, base[1], base[2]],
        [base[0] - width * 0.2 + sweep, base[1] + height, base[2]],
        [base[0] + width * 0.3 + sweep, base[1] + height * 0.7, base[2]],
        [base[0] + width / 2, base[1], base[2]]
    ], 0.014);
}

function buildAquatic(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Aquatic');
    const form = pick(p.form, ['fish', 'shark', 'ray', 'seahorse', 'whale', 'squid', 'octopus', 'eel', 'turtle', 'plesiosaur'], 'fish');
    const bulk = num(p.bulk, 1, 0.4, 2.6);
    const builder = new MonsterBuilder(paletteOf(p), {
        opacity: p.translucent ? num(p.opacity, 0.8, 0.2, 1) : 1,
        glow: p.glow ? ['glow'] : []
    });

    if (form === 'squid' || form === 'octopus') {
        const mantle = form === 'squid'
            ? [0.22 * bulk, 0.24 * bulk, 0.6 * bulk]
            : [0.3 * bulk, 0.26 * bulk, 0.3 * bulk];
        const top = form === 'squid' ? 0.72 : 0.5;
        builder.ellipsoid('body', mantle, [0, top, form === 'squid' ? -0.2 * bulk : 0], [form === 'squid' ? -0.5 : 0, 0, 0], 16);
        if (form === 'squid') {
            for (const side of [-1, 1]) {
                polygon(builder, 'accent', [
                    [0, top + 0.1 * bulk, -0.5 * bulk],
                    [side * 0.3 * bulk, top + 0.05 * bulk, -0.75 * bulk],
                    [0, top - 0.05 * bulk, -0.6 * bulk]
                ], 0.014);
            }
        }
        const headY = form === 'squid' ? top - 0.32 * bulk : top - 0.26 * bulk;
        builder.ellipsoid('accent', [0.2 * bulk, 0.16 * bulk, 0.16 * bulk], [0, headY, 0.1 * bulk], [0, 0, 0], 14);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.06 * bulk, 0.055 * bulk, 0.04 * bulk],
                [side * 0.16 * bulk, headY + 0.05 * bulk, 0.16 * bulk]);
        }
        const arms = form === 'octopus' ? 8 : 8;
        for (let i = 0; i < arms; i++) {
            const angle = (i / arms) * Math.PI * 2;
            const reach = 0.5 * bulk * (i % 4 === 0 ? 1.35 : 1);
            const x = Math.cos(angle) * 0.16 * bulk;
            const z = Math.sin(angle) * 0.14 * bulk + 0.12 * bulk;
            builder.curve('accent', [
                [x, headY - 0.08 * bulk, z],
                [x + Math.cos(angle) * reach * 0.5, 0.24 * bulk, z + Math.sin(angle) * reach * 0.4 + 0.1],
                [x + Math.cos(angle) * reach * 0.75, 0.08 * bulk, z + Math.sin(angle) * reach * 0.6 + 0.18],
                [x + Math.cos(angle) * reach * 0.5, 0.02, z + Math.sin(angle) * reach * 0.5 + 0.3]
            ], 0.045 * bulk, 0.008 * bulk, 14, 6);
        }
        if (form === 'squid') {
            for (const side of [-1, 1]) {
                builder.curve('accent', [
                    [side * 0.06 * bulk, headY - 0.1 * bulk, 0.2 * bulk],
                    [side * 0.1 * bulk, 0.2 * bulk, 0.5 * bulk],
                    [side * 0.06 * bulk, 0.1 * bulk, 0.85 * bulk],
                    [side * 0.12 * bulk, 0.05 * bulk, 1.0 * bulk]
                ], 0.04 * bulk, 0.012 * bulk, 16, 6);
            }
        }
    } else if (form === 'ray') {
        const width = 0.9 * bulk;
        const bodyY = 0.1 * bulk;
        // Flat diamond disc with wing tips that dip to the ground.
        polygon(builder, 'body', [
            [0, bodyY + 0.06, 0.6 * bulk], [width, bodyY, -0.1 * bulk],
            [width * 0.5, bodyY + 0.02, -0.55 * bulk], [0, bodyY + 0.04, -0.4 * bulk],
            [-width * 0.5, bodyY + 0.02, -0.55 * bulk], [-width, bodyY, -0.1 * bulk]
        ], 0.09);
        builder.ellipsoid('body', [0.24 * bulk, 0.1 * bulk, 0.4 * bulk], [0, bodyY + 0.04, 0], [0, 0, 0], 14);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.035 * bulk, 0.03 * bulk, 0.03 * bulk],
                [side * 0.1 * bulk, bodyY + 0.12 * bulk, 0.28 * bulk]);
        }
        builder.curve('accent', [
            [0, bodyY + 0.04, -0.4 * bulk], [0, bodyY + 0.06, -0.7 * bulk], [0, bodyY + 0.02, -1.1 * bulk]
        ], 0.035 * bulk, 0.005 * bulk, 12, 6);
    } else if (form === 'seahorse') {
        const bodyY = 0.3;
        builder.curve('body', [
            [0, 0.06, -0.3 * bulk], [0, bodyY * 0.4, -0.15 * bulk],
            [0, bodyY * 0.75, 0.05 * bulk], [0, bodyY * 1.05, 0.1 * bulk],
            [0, bodyY * 1.25, 0.24 * bulk]
        ], 0.14 * bulk, 0.07 * bulk, 20, 8);
        // Curled tail.
        builder.curve('accent', [
            [0, 0.06, -0.3 * bulk], [0, 0.03, -0.45 * bulk],
            [0, 0.05, -0.55 * bulk], [0, 0.1, -0.48 * bulk], [0, 0.1, -0.4 * bulk]
        ], 0.06 * bulk, 0.014 * bulk, 14, 6);
        // Snout + head.
        const headY = bodyY * 1.32;
        builder.ellipsoid('accent', [0.09 * bulk, 0.1 * bulk, 0.11 * bulk], [0, headY, 0.26 * bulk], [0.3, 0, 0], 12);
        builder.tube('accent', [0, headY - 0.02, 0.32 * bulk], [0, headY - 0.05, 0.52 * bulk], 0.045 * bulk, 0.03 * bulk, 6);
        builder.sphere('eye', 0.03 * bulk, [0.07 * bulk, headY + 0.04, 0.3 * bulk], 8);
        // Dorsal fin + crown.
        finPolygon(builder, 'accent', [0, bodyY * 0.8, -0.05 * bulk], 0.3 * bulk, 0.22 * bulk, -0.06);
        for (let i = 0; i < 3; i++) {
            builder.cone('horn', 0.03 * bulk, 0.12 * bulk,
                [(i - 1) * 0.05 * bulk, headY + 0.1 * bulk, 0.24 * bulk], [-0.3, 0, (i - 1) * 0.4], 4);
        }
    } else if (form === 'whale') {
        const bodyY = 0.34 * bulk;
        const length = 1.5 * bulk;
        builder.ellipsoid('body', [0.36 * bulk, 0.4 * bulk, length * 0.55], [0, bodyY, 0], [0.05, 0, 0], 18);
        builder.ellipsoid('body', [0.26 * bulk, 0.3 * bulk, length * 0.3], [0, bodyY - 0.04, length * 0.5], [-0.1, 0, 0], 14);
        builder.ellipsoid('belly', [0.28 * bulk, 0.22 * bulk, length * 0.5], [0, bodyY - 0.22 * bulk, 0.05], [0, 0, 0], 16);
        // Tail stock + horizontal flukes.
        builder.curve('body', [
            [0, bodyY, -length * 0.5], [0, bodyY + 0.04, -length * 0.68], [0, bodyY + 0.08, -length * 0.78]
        ], 0.16 * bulk, 0.05 * bulk, 10, 7);
        for (const side of [-1, 1]) {
            polygon(builder, 'accent', [
                [0, bodyY + 0.08, -length * 0.76],
                [side * 0.5 * bulk, bodyY + 0.1, -length * 0.95],
                [side * 0.3 * bulk, bodyY + 0.06, -length * 0.72]
            ], 0.05);
        }
        // Jaw, eye, pectoral fins.
        builder.box('detail', [0.5 * bulk, 0.02, length * 0.35], [0, bodyY - 0.12 * bulk, length * 0.32]);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.045 * bulk, 0.04 * bulk, 0.03 * bulk],
                [side * 0.3 * bulk, bodyY + 0.12 * bulk, length * 0.35]);
            polygon(builder, 'accent', [
                [side * 0.3 * bulk, bodyY - 0.05, length * 0.1],
                [side * 0.75 * bulk, bodyY - 0.3 * bulk, -length * 0.1],
                [side * 0.32 * bulk, bodyY - 0.2 * bulk, length * 0.2]
            ], 0.05);
        }
        if (p.baleen) {
            for (let i = 0; i < 6; i++) {
                builder.box('detail', [0.02, 0.1 * bulk, 0.02],
                    [(i - 2.5) * 0.07 * bulk, bodyY - 0.05, length * 0.42]);
            }
        }
    } else if (form === 'turtle') {
        const bodyY = 0.16 * bulk;
        // Shell dome + plastron.
        builder.ellipsoid('body', [0.4 * bulk, 0.26 * bulk, 0.5 * bulk], [0, bodyY, 0], [0, 0, 0], 16);
        builder.ellipsoid('belly', [0.36 * bulk, 0.1 * bulk, 0.46 * bulk], [0, bodyY - 0.12 * bulk, 0], [0, 0, 0], 12);
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            builder.ellipsoid('accent', [0.1 * bulk, 0.07 * bulk, 0.1 * bulk],
                [Math.cos(angle) * 0.2 * bulk, bodyY + 0.2 * bulk, Math.sin(angle) * 0.24 * bulk], [0, 0, 0], 8);
        }
        // Head + neck.
        builder.curve('accent', [
            [0, bodyY + 0.05, 0.4 * bulk], [0, bodyY + 0.1, 0.56 * bulk], [0, bodyY + 0.12, 0.66 * bulk]
        ], 0.1 * bulk, 0.08 * bulk, 8, 7);
        builder.ellipsoid('accent', [0.11 * bulk, 0.1 * bulk, 0.13 * bulk], [0, bodyY + 0.13, 0.74 * bulk], [0.1, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.028 * bulk, [side * 0.08 * bulk, bodyY + 0.17, 0.8 * bulk], 8);
        }
        // Flippers.
        for (const side of [-1, 1]) {
            polygon(builder, 'accent', [
                [side * 0.3 * bulk, bodyY, 0.24 * bulk],
                [side * 0.7 * bulk, 0.02, 0.02],
                [side * 0.34 * bulk, bodyY - 0.02, -0.02]
            ], 0.05);
            builder.ellipsoid('accent', [0.12 * bulk, 0.05, 0.16 * bulk],
                [side * 0.34 * bulk, bodyY - 0.06, -0.34 * bulk]);
        }
    } else if (form === 'plesiosaur') {
        const bodyY = 0.28 * bulk;
        builder.ellipsoid('body', [0.34 * bulk, 0.28 * bulk, 0.6 * bulk], [0, bodyY, -0.1 * bulk], [0.1, 0, 0], 16);
        builder.ellipsoid('belly', [0.28 * bulk, 0.16 * bulk, 0.5 * bulk], [0, bodyY - 0.16 * bulk, -0.1 * bulk], [0, 0, 0], 12);
        // Long neck.
        builder.curve('body', [
            [0, bodyY + 0.1, 0.4 * bulk], [0, bodyY + 0.34, 0.6 * bulk],
            [0, bodyY + 0.56, 0.68 * bulk], [0, bodyY + 0.72, 0.62 * bulk]
        ], 0.12 * bulk, 0.055 * bulk, 16, 7);
        builder.ellipsoid('accent', [0.07 * bulk, 0.07 * bulk, 0.11 * bulk], [0, bodyY + 0.76, 0.68 * bulk], [0.3, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.sphere('eye', 0.024 * bulk, [side * 0.05 * bulk, bodyY + 0.8, 0.76 * bulk], 8);
        }
        // Four flippers + tail.
        for (const side of [-1, 1]) {
            for (const z of [0.18, -0.42]) {
                polygon(builder, 'accent', [
                    [side * 0.26 * bulk, bodyY - 0.06, z * bulk],
                    [side * 0.85 * bulk, 0.04, (z - 0.16) * bulk],
                    [side * 0.7 * bulk, 0.02, (z - 0.34) * bulk],
                    [side * 0.3 * bulk, bodyY - 0.1, (z - 0.2) * bulk]
                ], 0.05);
            }
        }
        builder.curve('body', [
            [0, bodyY, -0.6 * bulk], [0, bodyY - 0.04, -0.9 * bulk], [0, bodyY - 0.1, -1.1 * bulk]
        ], 0.1 * bulk, 0.02 * bulk, 10, 6);
    } else {
        // Fish, shark, eel — one body axis, tail fin, dorsal fin.
        const length = form === 'eel' ? num(p.length, 2.4, 0.8, 5) : num(p.length, 1.6, 0.6, 4);
        const depth = form === 'shark' ? 0.34 : form === 'eel' ? 0.14 : 0.3;
        const bodyY = depth * 0.62 * bulk + 0.02;
        builder.ellipsoid('body', [depth * 0.5 * bulk, depth * 0.62 * bulk, length * 0.36 * bulk],
            [0, bodyY, 0], [0, 0, 0], 18);
        builder.ellipsoid('accent', [depth * 0.42 * bulk, depth * 0.5 * bulk, length * 0.2 * bulk],
            [0, bodyY + depth * 0.05, length * 0.3 * bulk], [0.1, 0, 0], 14);
        builder.ellipsoid('belly', [depth * 0.4 * bulk, depth * 0.34 * bulk, length * 0.3 * bulk],
            [0, bodyY - depth * 0.3, 0], [0, 0, 0], 14);
        // Snout.
        builder.ellipsoid(form === 'shark' ? 'accent' : 'body',
            [depth * 0.3 * bulk, depth * 0.32 * bulk, length * 0.16 * bulk],
            [0, bodyY + depth * 0.02, length * 0.46 * bulk], [0.05, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.035 * bulk, 0.032 * bulk, 0.025 * bulk],
                [side * depth * 0.34 * bulk, bodyY + depth * 0.24, length * 0.4 * bulk]);
        }
        if (form === 'shark') {
            builder.box('detail', [depth * 0.5 * bulk, 0.02, length * 0.2 * bulk],
                [0, bodyY - depth * 0.22, length * 0.42 * bulk], [0.1, 0, 0]);
            // Gill slits.
            for (const side of [-1, 1]) {
                for (let i = 0; i < 3; i++) {
                    builder.box('detail', [0.012, depth * 0.3 * bulk, 0.02],
                        [side * depth * 0.46 * bulk, bodyY, length * (0.24 - i * 0.04) * bulk]);
                }
            }
        }
        // Dorsal + pectoral + tail fins.
        finPolygon(builder, 'accent', [0, bodyY + depth * 0.55 * bulk, -length * 0.05 * bulk],
            length * 0.2 * bulk, depth * (form === 'shark' ? 0.9 : 0.5) * bulk, -length * 0.05 * bulk);
        for (const side of [-1, 1]) {
            polygon(builder, 'accent', [
                [side * depth * 0.4 * bulk, bodyY - depth * 0.1, length * 0.18 * bulk],
                [side * depth * 1.4 * bulk, bodyY - depth * 0.4, -length * 0.05 * bulk],
                [side * depth * 0.45 * bulk, bodyY - depth * 0.4, length * 0.05 * bulk]
            ], 0.03);
        }
        const tailY = bodyY + depth * 0.05;
        const tailZ = -length * 0.42 * bulk;
        polygon(builder, 'accent', [
            [0, tailY, tailZ],
            [0, tailY + depth * 0.9 * bulk, tailZ - length * 0.16 * bulk],
            [0, tailY + depth * 0.15, tailZ - length * 0.06 * bulk],
            [0, tailY - depth * 0.8 * bulk, tailZ - length * 0.16 * bulk]
        ], 0.03);
        if (form === 'eel') {
            builder.curve('body', [
                [0, bodyY, -length * 0.4 * bulk],
                [0, bodyY + 0.06, -length * 0.6 * bulk],
                [0.1, bodyY + 0.02, -length * 0.8 * bulk]
            ], depth * 0.4 * bulk, 0.01, 12, 6);
        }
    }

    builder.finish(group, 'Aquatic');
    return group;
}

// --- ooze --------------------------------------------------------------------

function buildOoze(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Ooze');
    const form = pick(p.form, ['blob', 'cube', 'mound', 'mass'], 'blob');
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const builder = new MonsterBuilder(paletteOf(p), {
        opacity: num(p.opacity, 0.86, 0.2, 1),
        glow: p.glow ? ['glow'] : []
    });

    if (form === 'cube') {
        const size = 0.42 * bulk;
        builder.box('body', [size * 2, size * 1.7, size * 2], [0, size * 0.88, 0]);
        // Sagging corners keep it from reading as a plain box.
        for (const side of [-1, 1]) {
            for (const z of [-1, 1]) {
                builder.ellipsoid('body', [size * 0.5, size * 0.4, size * 0.5],
                    [side * size * 0.9, 0.1, z * size * 0.9]);
            }
        }
        builder.ellipsoid('body', [size * 0.7, size * 0.24, size * 0.7], [0, 0.06, 0]);
        for (let i = 0; i < 5; i++) {
            const x = (i - 2) * size * 0.35;
            builder.ellipsoid('accent', [0.05 * bulk, 0.08 * bulk, 0.05 * bulk],
                [x, 0.04, size * 0.95]);
        }
    } else if (form === 'mound') {
        for (let i = 0; i < 7; i++) {
            const angle = (i / 7) * Math.PI * 2;
            const radius = i === 0 ? 0 : 0.3 * bulk;
            const size = (0.28 - (i % 3) * 0.05) * bulk;
            builder.ellipsoid(i % 2 ? 'body' : 'accent',
                [size, size * 0.8, size],
                [Math.cos(angle) * radius, 0.18 * bulk + (i % 2) * 0.1 * bulk, Math.sin(angle) * radius],
                [0, 0, 0], 14);
        }
        builder.ellipsoid('body', [0.3 * bulk, 0.34 * bulk, 0.3 * bulk], [0, 0.34 * bulk, 0], [0, 0, 0], 14);
    } else if (form === 'mass') {
        // Gibbering mass: overlapping lobes, many mouths, many eyes.
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const radius = 0.26 * bulk;
            builder.ellipsoid('body', [0.2 * bulk, 0.17 * bulk, 0.2 * bulk],
                [Math.cos(angle) * radius, 0.16 * bulk + (i % 2) * 0.09 * bulk, Math.sin(angle) * radius],
                [0, 0, 0], 12);
        }
        builder.ellipsoid('body', [0.3 * bulk, 0.28 * bulk, 0.3 * bulk], [0, 0.3 * bulk, 0], [0, 0, 0], 14);
        const mouths = Math.max(2, Math.min(8, Math.round(num(p.mouths, 5, 2, 8))));
        for (let i = 0; i < mouths; i++) {
            const angle = (i / mouths) * Math.PI * 2 + 0.4;
            const radius = 0.3 * bulk;
            builder.ellipsoid('detail', [0.09 * bulk, 0.07 * bulk, 0.05 * bulk],
                [Math.cos(angle) * radius, 0.2 * bulk + (i % 3) * 0.09 * bulk, Math.sin(angle) * radius],
                [0, -angle, 0], 10);
            for (let tooth = -1; tooth <= 1; tooth++) {
                builder.cone('horn', 0.012 * bulk, 0.04 * bulk,
                    [Math.cos(angle) * radius + Math.cos(angle + Math.PI / 2) * tooth * 0.04 * bulk,
                        0.24 * bulk + (i % 3) * 0.09 * bulk,
                        Math.sin(angle) * radius + Math.sin(angle + Math.PI / 2) * tooth * 0.04 * bulk],
                    [Math.PI, 0, 0], 4);
            }
        }
        const eyes = Math.max(1, Math.min(6, Math.round(num(p.eyes, 3, 1, 6))));
        for (let i = 0; i < eyes; i++) {
            const angle = i * 2.1;
            builder.sphere('eye', 0.035 * bulk,
                [Math.cos(angle) * 0.24 * bulk, 0.42 * bulk + (i % 2) * 0.06, Math.sin(angle) * 0.24 * bulk], 8);
        }
    } else {
        // Blob: main dome, bulges, drips.
        builder.ellipsoid('body', [0.42 * bulk, 0.4 * bulk, 0.44 * bulk], [0, 0.36 * bulk, 0], [0, 0, 0], 18);
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + 0.6;
            const size = (0.16 + (i % 2) * 0.06) * bulk;
            builder.ellipsoid('accent', [size, size * 0.8, size],
                [Math.cos(angle) * 0.3 * bulk, 0.3 * bulk + (i % 3) * 0.09 * bulk, Math.sin(angle) * 0.3 * bulk],
                [0, 0, 0], 12);
        }
        builder.ellipsoid('body', [0.36 * bulk, 0.16 * bulk, 0.38 * bulk], [0, 0.08, 0], [0, 0, 0], 14);
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2;
            builder.ellipsoid('accent', [0.07 * bulk, 0.1 * bulk, 0.07 * bulk],
                [Math.cos(angle) * 0.32 * bulk, 0.05, Math.sin(angle) * 0.32 * bulk], [0, 0, 0], 8);
        }
        const eyes = Math.max(1, Math.min(5, Math.round(num(p.eyes, 2, 1, 5))));
        for (let i = 0; i < eyes; i++) {
            const angle = -0.6 + i * 0.9;
            builder.ellipsoid('eye', [0.05 * bulk, 0.05 * bulk, 0.03 * bulk],
                [Math.sin(angle) * 0.24 * bulk, 0.46 * bulk + (i % 2) * 0.1, Math.cos(angle) * 0.34 * bulk], [0, angle, 0], 10);
        }
    }

    builder.finish(group, 'Ooze');
    return group;
}

// --- swarm -------------------------------------------------------------------

function buildSwarm(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Swarm');
    const creature = pick(p.creature, ['insect', 'bat', 'rat', 'snake', 'humanoid', 'fish'], 'insect');
    const count = Math.max(6, Math.min(32, Math.round(num(p.count, 16, 6, 32))));
    const radius = num(p.radius, 0.34, 0.1, 0.9);
    const builder = new MonsterBuilder(paletteOf(p), {
        opacity: num(p.opacity, 0.95, 0.3, 1)
    });

    // Deterministic pseudo-random placement so GM and player render identically.
    const seed = Math.abs(Math.round(num(p.seed, 7, 1, 9999)));
    const rand = (index, salt) => {
        const value = Math.sin((index + 1) * 12.9898 + salt * 78.233 + seed) * 43758.5453;
        return value - Math.floor(value);
    };

    for (let i = 0; i < count; i++) {
        const angle = rand(i, 1) * Math.PI * 2;
        const spread = radius * Math.sqrt(rand(i, 2));
        const ox = Math.cos(angle) * spread;
        const oz = Math.sin(angle) * spread;
        const oy = rand(i, 3) * radius * 0.7;
        // Creature sketches are authored ~2 units tall; each instance shrinks
        // to roughly a tenth of a world cell (half a foot).
        const scale = (0.07 + rand(i, 4) * 0.05) * 0.55;
        builder.save([ox, oy, oz], rand(i, 5) * Math.PI * 2, scale);

        if (creature === 'bat') {
            builder.ellipsoid('body', [0.5, 0.55, 0.8], [0, 1.4, 0], [0, 0, 0], 8);
            for (const side of [-1, 1]) {
                polygon(builder, 'accent', [
                    [side * 0.3, 1.6, 0], [side * 2.4, 2.2, -0.6], [side * 2.1, 0.9, -1.2],
                    [side * 0.3, 0.8, -0.5]
                ], 0.12);
            }
        } else if (creature === 'rat') {
            builder.ellipsoid('body', [0.7, 0.7, 1.4], [0, 1.4, 0], [0.2, 0, 0], 8);
            builder.ellipsoid('body', [0.5, 0.5, 0.6], [0, 1.6, 1.4], [0, 0, 0], 8);
            builder.curve('accent', [[0, 1.4, -1.4], [0.3, 1.5, -2.6], [0.6, 1.2, -3.4]], 0.16, 0.03, 8, 5);
        } else if (creature === 'snake') {
            builder.curve('body', [[-1.4, 0.6, 0], [0, 0.6, 0.7], [1.4, 0.6, 0]], 0.5, 0.14, 10, 6);
            builder.ellipsoid('body', [0.5, 0.4, 0.7], [1.6, 0.7, 0.2], [0, -0.4, 0], 8);
        } else if (creature === 'humanoid') {
            builder.ellipsoid('body', [0.7, 1.1, 0.6], [0, 2, 0], [0, 0, 0], 8);
            builder.sphere('body', 0.6, [0, 3.4, 0], 8);
            for (const side of [-1, 1]) {
                builder.tube('accent', [side * 0.7, 2.6, 0], [side * 1.2, 1.2, 0.2], 0.28, 0.2, 5);
                builder.tube('accent', [side * 0.4, 1.1, 0], [side * 0.5, 0, 0], 0.3, 0.2, 5);
            }
        } else if (creature === 'fish') {
            builder.ellipsoid('body', [0.6, 0.9, 1.6], [0, 1.5, 0], [0, 0, 0], 8);
            polygon(builder, 'accent', [[0, 1.5, -1.6], [0, 2.6, -2.6], [0, 0.6, -2.6]], 0.15);
        } else {
            // insect: segmented body, six legs, antennae.
            builder.ellipsoid('body', [0.7, 0.6, 0.7], [0, 1.4, 0.9], [0, 0, 0], 8);
            builder.ellipsoid('accent', [0.8, 0.7, 1.2], [0, 1.4, -0.4], [0, 0, 0], 8);
            builder.ellipsoid('accent', [0.6, 0.5, 0.7], [0, 1.5, -1.6], [0, 0, 0], 8);
            for (const side of [-1, 1]) {
                for (let leg = 0; leg < 3; leg++) {
                    builder.tube('horn', [side * 0.6, 1.2, 0.8 - leg * 0.8],
                        [side * 2, 0, 1 - leg * 0.9], 0.14, 0.05, 5);
                }
                builder.tube('horn', [side * 0.3, 1.8, 1.4], [side * 0.9, 2.6, 2.2], 0.08, 0.02, 5);
            }
        }
        builder.restore();
    }

    builder.finish(group, 'Swarm');
    return group;
}

// --- elemental ---------------------------------------------------------------

function buildElemental(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Elemental');
    const form = pick(p.form, ['fire', 'air', 'earth', 'water', 'magma', 'ice', 'smoke', 'steam', 'sand'], 'fire');
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const glowing = form === 'fire' || form === 'magma';
    const builder = new MonsterBuilder(paletteOf(p), {
        glow: glowing ? ['glow', 'accent'] : [],
        flatShading: form === 'earth' || form === 'ice' || form === 'sand'
    });

    const humanoid = form !== 'air' && form !== 'smoke' && form !== 'steam' && form !== 'water';
    const bodyY = humanoid ? 0.52 * bulk : 0.5 * bulk;

    if (form === 'air' || form === 'smoke' || form === 'steam') {
        // A coiling vortex that widens toward the top.
        for (let ring = 0; ring < 7; ring++) {
            const t = ring / 6;
            const y = 0.05 + t * 1.0 * bulk;
            const radius = (0.1 + t * 0.36) * bulk;
            builder.ellipsoid(ring % 2 ? 'accent' : 'body',
                [radius, 0.1 * bulk * (1 - t * 0.4), radius * 0.75],
                [Math.sin(t * 5) * 0.08 * bulk, y, Math.cos(t * 4) * 0.06 * bulk], [0, t * 2.4, 0], 12);
        }
        // Trailing wisps.
        builder.scatter('accent', 5, 0.3 * bulk, (i, x, z) => {
            builder.curve('accent', [
                [x * 0.4, 0.05, z * 0.4],
                [x * 0.7, 0.3 * bulk, z * 0.7],
                [x, 0.6 * bulk + i * 0.05, z]
            ], 0.05 * bulk, 0.01, 8, 5);
        });
        if (form === 'steam') {
            builder.ellipsoid('glow', [0.16 * bulk, 0.2 * bulk, 0.16 * bulk], [0, 0.5 * bulk, 0]);
        }
    } else if (form === 'water' || form === 'sand') {        // Fluid column with a wave crest / granular cone.
        if (form === 'water') {
            builder.curve('body', [
                [0, 0.04, 0], [0.12 * bulk, 0.3 * bulk, 0.06 * bulk],
                [-0.1 * bulk, 0.6 * bulk, 0], [0.06 * bulk, 0.9 * bulk, -0.04 * bulk]
            ], 0.3 * bulk, 0.14 * bulk, 20, 9);
            builder.ellipsoid('body', [0.24 * bulk, 0.16 * bulk, 0.22 * bulk], [0.06 * bulk, 1.0 * bulk, -0.04 * bulk]);
            for (const side of [-1, 1]) {
                builder.ellipsoid('accent', [0.1 * bulk, 0.06 * bulk, 0.12 * bulk],
                    [side * 0.3 * bulk, 0.62 * bulk, side * 0.1 * bulk]);
            }
            // Crest lobes (a wave breaking forward).
            for (let i = 0; i < 5; i++) {
                builder.ellipsoid('accent', [0.12 * bulk, 0.1 * bulk, 0.1 * bulk],
                    [(i - 2) * 0.1 * bulk, (1.1 + Math.abs(2 - i) * -0.06) * bulk, 0.1 * bulk]);
            }
            for (const side of [-1, 1]) {
                builder.ellipsoid('eye', [0.04 * bulk, 0.035 * bulk, 0.03 * bulk],
                    [side * 0.1 * bulk, 0.86 * bulk, 0.16 * bulk]);
            }
        } else {
            for (let i = 0; i < 4; i++) {
                const t = i / 3;
                builder.ellipsoid('body',
                    [(0.4 - t * 0.26) * bulk, (0.14 - t * 0.03) * bulk, (0.4 - t * 0.26) * bulk],
                    [0, 0.1 * bulk + t * 0.16 * bulk, 0], [0, 0, 0], 12);
            }
            builder.scatter('accent', 7, 0.3 * bulk, (i, x, z) => {
                builder.ellipsoid('accent', [0.05 * bulk, 0.05 * bulk, 0.05 * bulk],
                    [x, 0.5 * bulk + (i % 3) * 0.14 * bulk, z]);
            });
            builder.ellipsoid('body', [0.14 * bulk, 0.12 * bulk, 0.14 * bulk], [0, 0.9 * bulk, 0]);
            for (const side of [-1, 1]) {
                builder.ellipsoid('eye', [0.03 * bulk, 0.03 * bulk, 0.02 * bulk],
                    [side * 0.07 * bulk, 0.94 * bulk, 0.11 * bulk]);
            }
        }
    } else if (form === 'earth' || form === 'ice') {
        // Faceted boulder body with drifting shards.
        builder.ellipsoid('body', [0.34 * bulk, 0.4 * bulk, 0.3 * bulk], [0, bodyY, 0], [0, 0, 0], 7);
        builder.ellipsoid('body', [0.28 * bulk, 0.24 * bulk, 0.26 * bulk], [0, bodyY + 0.32 * bulk, 0.02], [0.3, 0, 0], 7);
        for (const side of [-1, 1]) {
            builder.ellipsoid('body', [0.16 * bulk, 0.24 * bulk, 0.16 * bulk],
                [side * 0.34 * bulk, bodyY - 0.1 * bulk, 0], [0, 0, side * 0.3], 7);
            builder.ellipsoid('body', [0.12 * bulk, 0.2 * bulk, 0.12 * bulk],
                [side * 0.16 * bulk, 0.12 * bulk, 0.04], [0, 0, side * 0.2], 7);
        }
        builder.scatter('accent', 6, 0.44 * bulk, (i, x, z) => {
            builder.ellipsoid(form === 'ice' ? 'glow' : 'accent',
                [0.07 * bulk, 0.09 * bulk, 0.07 * bulk],
                [x, 0.2 * bulk + (i % 4) * 0.2 * bulk, z], [i * 0.7, i * 1.1, 0], 6);
        });
        for (const side of [-1, 1]) {
            builder.ellipsoid(form === 'ice' ? 'glow' : 'eye', [0.045 * bulk, 0.04 * bulk, 0.03 * bulk],
                [side * 0.11 * bulk, bodyY + 0.34 * bulk, 0.2 * bulk]);
        }
        if (form === 'ice') {
            for (const side of [-1, 1]) {
                builder.cone('glow', 0.06 * bulk, 0.3 * bulk, [side * 0.2 * bulk, bodyY + 0.5 * bulk, 0], [-0.4, 0, side * 0.5], 5);
            }
        }
    } else {
        // Fire, magma: tapering flame tongues around a bright core.
        builder.ellipsoid('glow', [0.3 * bulk, 0.44 * bulk, 0.3 * bulk], [0, bodyY, 0], [0, 0, 0], 14);
        builder.ellipsoid('accent', [0.24 * bulk, 0.34 * bulk, 0.24 * bulk], [0, bodyY + 0.06, 0.06 * bulk], [0, 0, 0], 12);
        for (let i = 0; i < 7; i++) {
            const angle = (i / 7) * Math.PI * 2;
            const radius = 0.2 * bulk;
            const height = 0.5 * bulk + (i % 3) * 0.14 * bulk;
            builder.curve(i % 2 ? 'glow' : 'accent', [
                [Math.cos(angle) * radius, 0.1 * bulk, Math.sin(angle) * radius],
                [Math.cos(angle) * radius * 1.3, 0.45 * bulk, Math.sin(angle) * radius * 1.3],
                [Math.cos(angle + 0.6) * radius, height + 0.3 * bulk, Math.sin(angle + 0.6) * radius]
            ], 0.11 * bulk, 0.01, 10, 6);
        }
        // Arms.
        for (const side of [-1, 1]) {
            builder.curve('accent', [
                [side * 0.24 * bulk, bodyY + 0.12 * bulk, 0],
                [side * 0.44 * bulk, bodyY + 0.2 * bulk, 0.12 * bulk],
                [side * 0.5 * bulk, bodyY + 0.02, 0.3 * bulk]
            ], 0.08 * bulk, 0.03 * bulk, 10, 6);
        }
        // Legs (magma stays rooted; fire gets a narrowing plume skirt).
        if (form === 'magma') {
            for (const side of [-1, 1]) {
                builder.tube('body', [side * 0.14 * bulk, 0.02, 0], [side * 0.16 * bulk, bodyY - 0.1 * bulk, 0],
                    0.14 * bulk, 0.12 * bulk, 8);
            }
        } else {
            builder.ellipsoid('glow', [0.3 * bulk, 0.16 * bulk, 0.3 * bulk], [0, 0.1 * bulk, 0]);
            builder.scatter('accent', 4, 0.2 * bulk, (i, x, z) => {
                builder.cone('accent', 0.05 * bulk, 0.24 * bulk, [x, 0.02, z], [0, i, 0], 5);
            });
        }
        if (form === 'magma') {
            // Cooling crust plates.
            builder.scatter('detail', 6, 0.26 * bulk, (i, x, z) => {
                builder.ellipsoid('detail', [0.07 * bulk, 0.05 * bulk, 0.07 * bulk],
                    [x, bodyY + (i % 3) * 0.12 * bulk, z], [0, i, 0], 6);
            });
        }
        for (const side of [-1, 1]) {
            builder.ellipsoid('glow', [0.05 * bulk, 0.045 * bulk, 0.03 * bulk],
                [side * 0.12 * bulk, bodyY + 0.16 * bulk, 0.22 * bulk]);
        }
    }

    builder.finish(group, 'Elemental');
    return group;
}

// --- construct ---------------------------------------------------------------

function buildConstruct(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Construct');
    const form = pick(p.form, ['golem', 'armor', 'statue', 'animated', 'scarecrow'], 'golem');
    const material = pick(p.material, ['stone', 'clay', 'iron', 'wood', 'bone'], 'stone');
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const builder = new MonsterBuilder(paletteOf(p), {
        flatShading: material === 'stone' || material === 'clay'
    });
    const height = num(p.height, 1.05, 0.5, 1.8) * bulk;

    const shoulderY = height * 0.78;
    const hipY = height * 0.45;
    const bulkWidth = num(p.torsoWidth, 0.3, 0.15, 0.6) * bulk;

    // Legs: chunky stacked blocks for material, tapered for wood/bone.
    for (const side of [-1, 1]) {
        const x = side * bulkWidth * 0.42;
        if (material === 'wood' || material === 'bone') {
            builder.tube('body', [x, hipY, 0], [x, height * 0.12, 0.02], 0.07 * bulk, 0.055 * bulk, 7);
            builder.box('detail', [0.14 * bulk, 0.06 * bulk, 0.24 * bulk], [x, 0.04, 0.05]);
        } else {
            builder.box('body', [0.16 * bulk, hipY * 0.5, 0.18 * bulk], [x, hipY * 0.74, 0.01]);
            builder.box('body', [0.14 * bulk, hipY * 0.5, 0.16 * bulk], [x, hipY * 0.26, -0.01]);
            builder.box('detail', [0.17 * bulk, 0.07 * bulk, 0.26 * bulk], [x, 0.04, 0.06]);
        }
    }

    // Torso: stacked slab with an inset chest.
    if (material === 'wood') {
        builder.box('body', [bulkWidth, shoulderY - hipY + 0.1, 0.22 * bulk], [0, (shoulderY + hipY) / 2, 0]);
        for (let i = 0; i < 3; i++) {
            builder.box('detail', [bulkWidth * 1.02, 0.03, 0.23 * bulk],
                [0, hipY + 0.12 + i * 0.16, 0]);
        }
    } else {
        builder.box('body', [bulkWidth, shoulderY - hipY + 0.08, 0.26 * bulk], [0, (shoulderY + hipY) / 2, 0]);
        builder.box('accent', [bulkWidth * 0.6, 0.16 * bulk, 0.06 * bulk],
            [0, shoulderY - 0.14, 0.15 * bulk]);
        builder.box('detail', [bulkWidth * 1.04, 0.05 * bulk, 0.28 * bulk], [0, hipY + 0.04, 0]);
    }

    // Arms: heavy slabs hanging to the ground line.
    for (const side of [-1, 1]) {
        const x = side * (bulkWidth * 0.72);
        if (material === 'wood' || material === 'bone') {
            builder.tube('body', [x, shoulderY - 0.04, 0], [x * 1.15, height * 0.2, 0.05], 0.065 * bulk, 0.05 * bulk, 7);
        } else {
            builder.box('body', [0.14 * bulk, 0.24 * bulk, 0.16 * bulk], [x, shoulderY - 0.14, 0]);
            builder.box('body', [0.12 * bulk, shoulderY * 0.42, 0.14 * bulk], [x * 1.08, shoulderY * 0.44, 0.02]);
        }
        // Fist.
        builder.ellipsoid('detail', [0.09 * bulk, 0.1 * bulk, 0.09 * bulk],
            [x * 1.15, height * 0.16, 0.04], [0, 0, 0], 9);
    }

    // Head: block with a glowing slot or runic face.
    const headY = shoulderY + 0.16;
    const headSize = num(p.headSize, 0.17, 0.08, 0.34) * bulk;
    builder.box('body', [headSize * 1.1, headSize, headSize], [0, headY, 0.01]);
    builder.box('accent', [headSize * 1.14, headSize * 0.3, headSize * 1.04], [0, headY + headSize * 0.45, 0.01]);
    for (const side of [-1, 1]) {
        builder.box(material === 'iron' ? 'glow' : 'detail', [headSize * 0.24, headSize * 0.16, 0.02],
            [side * headSize * 0.3, headY, headSize * 0.52]);
    }
    if (material === 'stone' || material === 'clay') {
        // Engraved brow / rune.
        builder.box('detail', [headSize * 0.5, 0.02, 0.02], [0, headY + headSize * 0.3, headSize * 0.52]);
    }

    // Shoulder pauldrons for animated armor.
    if (form === 'armor') {
        for (const side of [-1, 1]) {
            builder.ellipsoid('accent', [0.14 * bulk, 0.1 * bulk, 0.16 * bulk],
                [side * bulkWidth * 0.7, shoulderY + 0.04, 0], [0, 0, side * 0.3], 9);
            builder.cone('detail', 0.04 * bulk, 0.16 * bulk,
                [side * bulkWidth * 0.8, shoulderY + 0.16, 0], [0, 0, side * 0.6], 5);
        }
        // Tassets skirt.
        for (let i = -2; i <= 2; i++) {
            builder.box('detail', [0.1 * bulk, 0.14 * bulk, 0.04 * bulk],
                [i * 0.09 * bulk, hipY - 0.06, 0.12 * bulk], [-0.25, 0, 0]);
        }
    }
    if (form === 'scarecrow') {
        // Hat brim + straw tufts.
        builder.ellipsoid('horn', [headSize * 1.4, 0.03, headSize * 1.4], [0, headY + headSize * 0.5, 0]);
        builder.cone('horn', headSize * 0.7, headSize * 0.8, [0, headY + headSize * 0.9, 0], [0, 0, 0], 7);
        builder.scatter('horn', 8, 0.2 * bulk, (i, x, z) => {
            builder.tube('horn', [x * 0.4, shoulderY - 0.06, z * 0.4], [x, shoulderY - 0.22, z], 0.02, 0.004, 4);
        });
    }

    builder.finish(group, 'Construct');
    return group;
}

// --- plant -------------------------------------------------------------------

function buildPlant(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Plant');
    const form = pick(p.form, ['treant', 'shrieker', 'vine', 'blight', 'flower', 'fungus'], 'treant');
    const bulk = num(p.bulk, 1, 0.5, 2.6);
    const builder = new MonsterBuilder(paletteOf(p));

    if (form === 'treant') {
        const height = num(p.height, 1.4, 0.8, 2.2) * bulk;
        // Trunk torso with root feet and bark slabs.
        builder.ellipsoid('body', [0.3 * bulk, height * 0.3, 0.26 * bulk], [0, height * 0.42, 0], [0, 0, 0], 14);
        builder.ellipsoid('body', [0.24 * bulk, height * 0.2, 0.22 * bulk], [0, height * 0.68, 0], [0, 0, 0], 14);
        for (const side of [-1, 1]) {
            const rootX = side * 0.2 * bulk;
            builder.curve('body', [
                [rootX, height * 0.3, 0], [rootX * 1.3, height * 0.14, 0.06],
                [rootX * 1.7, 0.03, 0.16], [rootX * 1.9, 0.02, 0.3]
            ], 0.11 * bulk, 0.03 * bulk, 12, 7);
            builder.curve('body', [
                [rootX, height * 0.28, -0.04], [rootX * 1.2, height * 0.12, -0.16],
                [rootX * 1.6, 0.03, -0.3]
            ], 0.1 * bulk, 0.03 * bulk, 10, 7);
        }
        // Arms: branch limbs with leaf clusters.
        for (const side of [-1, 1]) {
            builder.curve('body', [
                [side * 0.2 * bulk, height * 0.72, 0],
                [side * 0.42 * bulk, height * 0.78, 0.1],
                [side * 0.55 * bulk, height * 0.86, 0.16],
                [side * 0.62 * bulk, height * 0.94, 0.22]
            ], 0.08 * bulk, 0.03 * bulk, 14, 7);
            builder.scatter('accent', 5, 0.16 * bulk, (i, x, z) => {
                builder.ellipsoid('accent', [0.1 * bulk, 0.09 * bulk, 0.1 * bulk],
                    [side * 0.6 * bulk + x, height * 0.95 + (i % 3) * 0.08, 0.2 + z], [0, i, 0], 8);
            });
            // Twig fingers.
            for (let f = 0; f < 3; f++) {
                builder.tube('body',
                    [side * 0.62 * bulk, height * 0.94, 0.22],
                    [side * (0.68 + f * 0.03) * bulk, height * (1.02 + f * 0.02), 0.24 + f * 0.05],
                    0.024 * bulk, 0.006 * bulk, 5);
            }
        }
        // Head knot with a face.
        const headY = height * 0.92;
        builder.ellipsoid('body', [0.2 * bulk, 0.18 * bulk, 0.19 * bulk], [0, headY, 0.02], [0, 0, 0], 12);
        builder.ellipsoid('detail', [0.19 * bulk, 0.06 * bulk, 0.14 * bulk], [0, headY + 0.16 * bulk, 0.0]);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.035 * bulk, 0.03 * bulk, 0.02 * bulk],
                [side * 0.09 * bulk, headY + 0.03, 0.17 * bulk]);
        }
        builder.box('detail', [0.1 * bulk, 0.02, 0.02], [0, headY - 0.07, 0.17 * bulk]);
        // Crown leaves.
        builder.scatter('accent', 6, 0.16 * bulk, (i, x, z) => {
            builder.ellipsoid('accent', [0.08 * bulk, 0.06 * bulk, 0.08 * bulk],
                [x, headY + 0.16 * bulk + (i % 2) * 0.06, z], [0, i, 0], 8);
        });
    } else if (form === 'shrieker' || form === 'fungus') {
        const cap = num(p.cap, 0.3, 0.15, 0.6) * bulk;
        const stalk = cap * 1.1;
        builder.tube('belly', [0, 0.02, 0], [0, stalk, 0], cap * 0.4, cap * 0.3, 9);
        builder.ellipsoid('accent', [cap, cap * 0.7, cap], [0, stalk + cap * 0.2, 0], [0, 0, 0], 14);
        builder.ellipsoid('accent', [cap * 0.8, cap * 0.5, cap * 0.8], [0, stalk + cap * 0.5, 0], [0, 0, 0], 14);
        // Gills and spots.
        builder.scatter('glow', 6, cap * 0.6, (i, x, z) => {
            builder.ellipsoid('glow', [cap * 0.14, cap * 0.1, cap * 0.14],
                [x, stalk + cap * 0.62, z], [0, 0, 0], 7);
        });
        if (form === 'shrieker') {
            // Open mouth under the cap.
            builder.ellipsoid('detail', [cap * 0.5, cap * 0.3, cap * 0.5], [0, stalk, cap * 0.2]);
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                builder.cone('horn', cap * 0.06, cap * 0.2,
                    [Math.cos(angle) * cap * 0.3, stalk + cap * 0.1, Math.sin(angle) * cap * 0.3],
                    [Math.PI, 0, 0], 4);
            }
        }
    } else if (form === 'flower') {
        const stem = num(p.stem, 0.6, 0.2, 1.2) * bulk;
        builder.curve('body', [[0, 0.02, 0], [0.06 * bulk, stem * 0.5, 0.04], [0, stem, 0]],
            0.05 * bulk, 0.035 * bulk, 10, 7);
        for (const side of [-1, 1]) {
            polygon(builder, 'accent', [
                [0, stem * 0.4, 0], [side * 0.34 * bulk, stem * 0.5, 0.1 * bulk],
                [side * 0.3 * bulk, stem * 0.3, 0.02], [0, stem * 0.36, 0]
            ], 0.02);
        }
        // Petal ring around a maw.
        const petals = Math.max(5, Math.min(10, Math.round(num(p.petals, 6, 5, 10))));
        for (let i = 0; i < petals; i++) {
            const angle = (i / petals) * Math.PI * 2;
            const outward = 0.3 * bulk;
            polygon(builder, i % 2 ? 'accent' : 'glow', [
                [0, stem, 0],
                [Math.cos(angle) * outward, stem + 0.14 * bulk, Math.sin(angle) * outward],
                [Math.cos(angle + 0.4) * outward * 1.1, stem + 0.06 * bulk, Math.sin(angle + 0.4) * outward * 1.1],
                [Math.cos(angle - 0.4) * outward * 1.1, stem + 0.06 * bulk, Math.sin(angle - 0.4) * outward * 1.1]
            ], 0.02);
        }
        builder.ellipsoid('detail', [0.13 * bulk, 0.1 * bulk, 0.13 * bulk], [0, stem, 0], [0, 0, 0], 12);
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2;
            builder.cone('horn', 0.02 * bulk, 0.07 * bulk,
                [Math.cos(angle) * 0.07 * bulk, stem + 0.04, Math.sin(angle) * 0.07 * bulk],
                [Math.PI - 0.5, 0, 0], 4);
        }
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.02 * bulk, 0.02 * bulk, 0.015 * bulk],
                [side * 0.05 * bulk, stem + 0.05, 0.1 * bulk]);
        }
    } else if (form === 'vine') {
        // Coiling vine mass with a grasping crown.
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2;
            builder.curve(i % 2 ? 'accent' : 'body', [
                [0, 0.04, 0],
                [Math.cos(angle) * 0.26 * bulk, 0.16 * bulk, Math.sin(angle) * 0.26 * bulk],
                [Math.cos(angle + 0.7) * 0.3 * bulk, 0.42 * bulk, Math.sin(angle + 0.7) * 0.3 * bulk],
                [Math.cos(angle + 1.3) * 0.2 * bulk, 0.66 * bulk, Math.sin(angle + 1.3) * 0.2 * bulk]
            ], 0.07 * bulk, 0.02 * bulk, 14, 6);
        }
        builder.ellipsoid('accent', [0.2 * bulk, 0.24 * bulk, 0.2 * bulk], [0, 0.5 * bulk, 0], [0, 0, 0], 12);
        builder.ellipsoid('detail', [0.13 * bulk, 0.08 * bulk, 0.13 * bulk], [0, 0.62 * bulk, 0.04 * bulk]);
        for (const side of [-1, 1]) {
            builder.ellipsoid('eye', [0.03 * bulk, 0.028 * bulk, 0.02 * bulk],
                [side * 0.08 * bulk, 0.56 * bulk, 0.14 * bulk]);
            builder.cone('horn', 0.02 * bulk, 0.08 * bulk, [side * 0.06 * bulk, 0.6 * bulk, 0.12 * bulk],
                [2.4, 0, side * 0.3], 4);
        }
        builder.scatter('accent', 5, 0.34 * bulk, (i, x, z) => {
            builder.curve('accent', [
                [x * 0.6, 0.05, z * 0.6], [x, 0.14 * bulk, z],
                [x * 1.2, 0.3 * bulk + (i % 3) * 0.1, z * 1.2]
            ], 0.03 * bulk, 0.006 * bulk, 8, 5);
        });
    } else {
        // blight — hunched woody horror.
        const height = 0.85 * bulk;
        builder.ellipsoid('body', [0.24 * bulk, height * 0.3, 0.22 * bulk], [0, height * 0.5, 0.05], [0.3, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.curve('body', [
                [side * 0.16 * bulk, height * 0.6, 0.02],
                [side * 0.34 * bulk, height * 0.4, 0.16],
                [side * 0.4 * bulk, 0.14 * bulk, 0.34],
                [side * 0.36 * bulk, 0.03, 0.5 * bulk]
            ], 0.055 * bulk, 0.015 * bulk, 12, 6);
            builder.cone('horn', 0.03 * bulk, 0.14 * bulk,
                [side * 0.36 * bulk, 0.03, 0.56 * bulk], [1.9, 0, 0], 4);
            builder.curve('body', [
                [side * 0.14 * bulk, height * 0.4, 0],
                [side * 0.24 * bulk, height * 0.2, 0.06],
                [side * 0.28 * bulk, 0.03, 0.14 * bulk]
            ], 0.06 * bulk, 0.02 * bulk, 9, 6);
        }
        const headY = height * 0.78;
        builder.ellipsoid('accent', [0.16 * bulk, 0.14 * bulk, 0.17 * bulk], [0, headY, 0.1], [0.4, 0, 0], 12);
        builder.cone('horn', 0.07 * bulk, 0.16 * bulk, [0, headY - 0.02, 0.24 * bulk], [2.6, 0, 0], 5);
        for (const side of [-1, 1]) {
            builder.ellipsoid('glow', [0.03 * bulk, 0.026 * bulk, 0.02 * bulk],
                [side * 0.07 * bulk, headY + 0.05, 0.2 * bulk]);
            builder.cone('horn', 0.02 * bulk, 0.16 * bulk, [side * 0.1 * bulk, headY + 0.1, 0.04], [-0.3, 0, side * 0.5], 4);
        }
        builder.scatter('accent', 6, 0.22 * bulk, (i, x, z) => {
            builder.ellipsoid('accent', [0.05 * bulk, 0.06 * bulk, 0.05 * bulk],
                [x, height * 0.5 + (i % 4) * 0.09 * bulk, z], [0, i, 0], 7);
        });
    }

    builder.finish(group, 'Plant');
    return group;
}

// --- aberrant ----------------------------------------------------------------

function buildAberrant(rawParams) {
    const p = paramsOf(rawParams);
    const group = groupOf('Aberrant');
    const form = pick(p.form, ['eye', 'flayer', 'roper', 'worm', 'jelly'], 'eye');
    const bulk = num(p.bulk, 1, 0.5, 2.4);
    const builder = new MonsterBuilder(paletteOf(p), {
        glow: p.glow !== false ? ['glow'] : [],
        opacity: form === 'jelly' ? num(p.opacity, 0.8, 0.2, 1) : 1
    });

    if (form === 'eye') {
        // Floating central eye with stalked eyes.
        const radius = 0.34 * bulk;
        const center = [0, 0.62 * bulk, 0];
        builder.ellipsoid('body', [radius, radius * 0.95, radius * 0.9], center, [0, 0, 0], 18);
        builder.ellipsoid('belly', [radius * 0.9, radius * 0.7, radius * 0.85],
            [0, 0.62 * bulk - radius * 0.2, radius * 0.15], [0, 0, 0], 16);
        // The main eye faces +Z.
        builder.ellipsoid('glow', [radius * 0.5, radius * 0.5, radius * 0.32],
            [0, 0.64 * bulk, radius * 0.72], [0, 0, 0], 16);
        builder.ellipsoid('detail', [radius * 0.2, radius * 0.24, radius * 0.12],
            [0, 0.64 * bulk, radius * 0.95], [0, 0, 0], 14);
        builder.ellipsoid('eye', [radius * 0.1, radius * 0.14, radius * 0.05],
            [0, 0.64 * bulk, radius * 1.02], [0, 0, 0], 10);
        // Mouth with teeth under the eye.
        builder.ellipsoid('detail', [radius * 0.55, radius * 0.28, radius * 0.2],
            [0, 0.62 * bulk - radius * 0.55, radius * 0.62], [0.4, 0, 0], 12);
        for (let i = 0; i < 7; i++) {
            const x = (i - 3) * radius * 0.16;
            builder.cone('horn', radius * 0.05, radius * 0.18,
                [x, 0.62 * bulk - radius * 0.42, radius * 0.72], [Math.PI - 0.3, 0, 0], 4);
            builder.cone('horn', radius * 0.05, radius * 0.16,
                [x + radius * 0.07, 0.62 * bulk - radius * 0.7, radius * 0.72], [0.3, 0, 0], 4);
        }
        // Eye stalks fanning up and out.
        const stalks = Math.max(4, Math.min(11, Math.round(num(p.stalks, 9, 4, 11))));
        for (let i = 0; i < stalks; i++) {
            const angle = -Math.PI * 0.9 + (i / (stalks - 1)) * Math.PI * 1.8;
            const reach = 0.62 * bulk + (i % 3) * 0.12 * bulk;
            const base = [Math.sin(angle) * radius * 0.7, 0.62 * bulk + Math.cos(angle) * radius * 0.6, -0.1 * bulk];
            const tip = [Math.sin(angle) * reach, 0.62 * bulk + Math.cos(angle) * reach * 0.9 + 0.18, -0.05 + Math.cos(angle) * 0.3 * bulk];
            builder.curve('accent', [base,
                [(base[0] + tip[0]) * 0.6, (base[1] + tip[1]) * 0.5 + 0.16, (base[2] + tip[2]) * 0.6 + 0.06],
                tip], radius * 0.16, radius * 0.07, 10, 6);
            builder.ellipsoid('glow', [radius * 0.13, radius * 0.13, radius * 0.1], tip, [0, 0, 0], 10);
            builder.ellipsoid('detail', [radius * 0.05, radius * 0.06, radius * 0.04],
                [tip[0], tip[1], tip[2] + radius * 0.09], [0, 0, 0], 8);
        }
        // Tentacle beard below.
        const tentacles = Math.max(4, Math.min(10, Math.round(num(p.tentacles, 7, 4, 10))));
        for (let i = 0; i < tentacles; i++) {
            const angle = (i / tentacles) * Math.PI * 2;
            const x = Math.cos(angle) * radius * 0.5;
            const z = Math.sin(angle) * radius * 0.45 + 0.05;
            builder.curve('accent', [
                [x, 0.62 * bulk - radius * 0.7, z],
                [x * 1.4, 0.36 * bulk, z * 1.5],
                [x * 1.6, 0.14 * bulk, z * 1.6 + 0.1],
                [x * 1.3, 0.03, z * 1.4 + 0.24]
            ], radius * 0.13, radius * 0.03, 12, 6);
        }
        // Polyp legs (a floating brain gets hovering limbs).
        for (const side of [-1, 1]) {
            builder.curve('accent', [
                [side * radius * 0.6, 0.62 * bulk - radius * 0.4, -0.1],
                [side * radius * 1.4, 0.34 * bulk, -0.16],
                [side * radius * 1.6, 0.03, 0.06]
            ], radius * 0.15, radius * 0.05, 12, 6);
        }
    } else if (form === 'flayer') {
        const height = 0.95 * bulk;
        // Head tentacles drape over a squat torso.
        builder.ellipsoid('body', [0.24 * bulk, 0.3 * bulk, 0.2 * bulk], [0, height * 0.45, 0], [0.1, 0, 0], 14);
        builder.ellipsoid('belly', [0.2 * bulk, 0.2 * bulk, 0.17 * bulk], [0, height * 0.36, 0.04], [0, 0, 0], 12);
        for (const side of [-1, 1]) {
            builder.curve('body', [
                [side * 0.16 * bulk, height * 0.56, 0],
                [side * 0.36 * bulk, height * 0.42, 0.1],
                [side * 0.44 * bulk, height * 0.2, 0.24],
                [side * 0.4 * bulk, 0.04, 0.4 * bulk]
            ], 0.06 * bulk, 0.02 * bulk, 12, 6);
            builder.curve('body', [
                [side * 0.14 * bulk, height * 0.3, 0],
                [side * 0.22 * bulk, height * 0.15, 0.04],
                [side * 0.24 * bulk, 0.03, 0.1 * bulk]
            ], 0.07 * bulk, 0.03 * bulk, 9, 6);
            // Third eye on the palm.
            builder.ellipsoid('glow', [0.04 * bulk, 0.035 * bulk, 0.025 * bulk],
                [side * 0.42 * bulk, height * 0.14, 0.44 * bulk]);
        }
        // Head: domed skull with four eyes and facial tentacles.
        const headY = height * 0.74;
        builder.ellipsoid('accent', [0.2 * bulk, 0.19 * bulk, 0.22 * bulk], [0, headY, 0.03], [0, 0, 0], 14);
        builder.ellipsoid('accent', [0.17 * bulk, 0.14 * bulk, 0.16 * bulk], [0, headY + 0.04, -0.12 * bulk], [-0.3, 0, 0], 12);
        const eyePositions = [[-0.09, 0.04, 0.19], [0.09, 0.04, 0.19], [-0.05, 0.1, 0.16], [0.05, 0.1, 0.16]];
        for (const [ex, ey, ez] of eyePositions) {
            builder.ellipsoid('glow', [0.035 * bulk, 0.03 * bulk, 0.02 * bulk],
                [ex * bulk, headY + ey * bulk, ez * bulk], [0, 0, 0], 10);
        }
        for (let i = 0; i < 6; i++) {
            const x = (i - 2.5) * 0.055 * bulk;
            builder.curve('accent', [
                [x, headY - 0.08 * bulk, 0.16 * bulk],
                [x * 1.3, headY - 0.24 * bulk, 0.2 * bulk],
                [x * 1.5, headY - 0.42 * bulk, 0.16 * bulk]
            ], 0.035 * bulk, 0.008 * bulk, 10, 6);
        }
        // Robe-free: exposed ribs.
        for (let i = 0; i < 3; i++) {
            builder.box('horn', [0.3 * bulk, 0.03 * bulk, 0.05 * bulk],
                [0, height * (0.42 + i * 0.06), 0.16 * bulk]);
        }
    } else if (form === 'roper') {
        // Bulbous anchored body with drooping grab tentacles.
        builder.ellipsoid('body', [0.3 * bulk, 0.42 * bulk, 0.3 * bulk], [0, 0.4 * bulk, 0], [0, 0, 0], 14);
        builder.ellipsoid('body', [0.36 * bulk, 0.18 * bulk, 0.36 * bulk], [0, 0.1 * bulk, 0], [0, 0, 0], 14);
        builder.ellipsoid('detail', [0.16 * bulk, 0.12 * bulk, 0.1 * bulk], [0, 0.62 * bulk, 0.14 * bulk], [0.4, 0, 0], 12);
        for (let i = 0; i < 7; i++) {
            builder.cone('horn', 0.025 * bulk, 0.1 * bulk,
                [(i - 3) * 0.045 * bulk, 0.56 * bulk, 0.2 * bulk], [Math.PI - 0.4, 0, 0], 4);
        }
        const tentacles = Math.max(5, Math.min(9, Math.round(num(p.tentacles, 7, 5, 9))));
        for (let i = 0; i < tentacles; i++) {
            const angle = (i / tentacles) * Math.PI * 2;
            const reach = 0.5 * bulk + (i % 3) * 0.16 * bulk;
            builder.curve('accent', [
                [Math.cos(angle) * 0.2 * bulk, 0.6 * bulk, Math.sin(angle) * 0.2 * bulk],
                [Math.cos(angle) * reach * 0.7, 0.7 * bulk + (i % 2) * 0.2 * bulk, Math.sin(angle) * reach * 0.7],
                [Math.cos(angle) * reach * 1.2, 0.42 * bulk, Math.sin(angle) * reach * 1.2],
                [Math.cos(angle) * reach * 1.4, 0.04, Math.sin(angle) * reach * 1.4]
            ], 0.05 * bulk, 0.012 * bulk, 16, 6);
        }
        for (const side of [-1, 1]) {
            builder.ellipsoid('glow', [0.03 * bulk, 0.028 * bulk, 0.02 * bulk],
                [side * 0.1 * bulk, 0.66 * bulk, 0.2 * bulk]);
        }
    } else if (form === 'worm') {
        // Burrowing segment tube arcing out of the ground.
        const segments = Math.max(5, Math.min(12, Math.round(num(p.segments, 8, 5, 12))));
        const bodyPoints = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            bodyPoints.push([
                Math.sin(t * 3.2) * 0.18 * bulk,
                Math.max(0.06, Math.sin(t * Math.PI) * 1.1) * bulk + (t > 0.85 ? -0.2 * bulk : 0),
                0.7 * bulk - t * 1.7 * bulk
            ]);
        }
        builder.curve('body', bodyPoints, 0.3 * bulk, 0.06 * bulk, 34, 9);
        for (let i = 1; i < segments - 1; i += 1) {
            const point = bodyPoints[i];
            const next = bodyPoints[i + 1];
            const size = 0.32 * bulk * (1 - i / segments * 0.5);
            builder.ellipsoid('body', [size, size * 0.9, size * 0.6],
                [point[0], point[1], point[2]], [0, 0, 0], 10);
            if (i % 2 === 0) {
                builder.cone('horn', size * 0.16, size * 0.5,
                    [point[0], point[1] + size * 0.9, point[2]], [-0.4, 0, 0], 5);
            }
            void next;
        }
        // Maw at the raised end.
        const head = bodyPoints[Math.floor(segments * 0.6)];
        const headSize = 0.34 * bulk;
        builder.ellipsoid('accent', [headSize, headSize * 0.9, headSize], [head[0], head[1] + 0.1, head[2] + 0.1], [0.3, 0, 0], 14);
        builder.ellipsoid('detail', [headSize * 0.7, headSize * 0.7, headSize * 0.3],
            [head[0], head[1] + 0.06, head[2] + 0.32], [0.3, 0, 0], 12);
        for (let ring = 0; ring < 2; ring++) {
            for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2 + ring * 0.4;
                builder.cone('horn', headSize * 0.1, headSize * 0.36,
                    [head[0] + Math.cos(angle) * headSize * 0.5,
                        head[1] + 0.06 + Math.sin(angle) * headSize * 0.5,
                        head[2] + 0.3 + ring * 0.1],
                    [Math.PI / 2 + ring * 0.5, 0, angle + Math.PI / 2], 4);
            }
        }
        for (const side of [-1, 1]) {
            builder.ellipsoid('glow', [0.035 * bulk, 0.032 * bulk, 0.02 * bulk],
                [head[0] + side * headSize * 0.5, head[1] + 0.26, head[2] + 0.16]);
        }
    } else {
        // jelly — translucent dome with trailing tendrils.
        builder.ellipsoid('body', [0.34 * bulk, 0.3 * bulk, 0.34 * bulk], [0, 0.36 * bulk, 0], [0, 0, 0], 16);
        builder.ellipsoid('glow', [0.24 * bulk, 0.2 * bulk, 0.24 * bulk], [0, 0.38 * bulk, 0], [0, 0, 0], 14);
        builder.ellipsoid('belly', [0.3 * bulk, 0.12 * bulk, 0.3 * bulk], [0, 0.14 * bulk, 0], [0, 0, 0], 14);
        const tendrils = Math.max(4, Math.min(9, Math.round(num(p.tentacles, 6, 4, 9))));
        for (let i = 0; i < tendrils; i++) {
            const angle = (i / tendrils) * Math.PI * 2;
            const x = Math.cos(angle) * 0.24 * bulk;
            const z = Math.sin(angle) * 0.24 * bulk;
            builder.curve('accent', [
                [x, 0.2 * bulk, z],
                [x * 1.2, 0.1 * bulk, z * 1.2],
                [x * 1.3, 0.03, z * 1.3 + 0.08]
            ], 0.05 * bulk, 0.01 * bulk, 10, 6);
        }
        for (const side of [-1, 1]) {
            builder.ellipsoid('detail', [0.05 * bulk, 0.045 * bulk, 0.03 * bulk],
                [side * 0.14 * bulk, 0.42 * bulk, 0.24 * bulk]);
        }
    }

    builder.finish(group, 'Aberrant');
    return group;
}

// --- registry ----------------------------------------------------------------

// plan name → builder(params, options) → THREE.Group. The ape plan routes to
// the textured pilot model, which already seats soles at -0.1 itself.
export const MONSTER_PLANS = Object.freeze({
    ape: (params = {}) => createApeModel({ variant: params.variant || undefined, loadTextures: params.loadTextures !== false }),
    quadruped: buildQuadruped,
    humanoid: buildHumanoid,
    dragon: buildDragon,
    saurian: buildSaurian,
    avian: buildAvian,
    serpent: buildSerpent,
    arthropod: buildArthropod,
    aquatic: buildAquatic,
    ooze: buildOoze,
    swarm: buildSwarm,
    elemental: buildElemental,
    construct: buildConstruct,
    plant: buildPlant,
    aberrant: buildAberrant
});

export const PLAN_NAMES = Object.freeze(Object.keys(MONSTER_PLANS));

// Build one plan by name; unknown plans fall back to the humanoid silhouette
// (never throws — the manifest is data, and data can drift).
export function buildMonsterModel(plan, params = {}, options = {}) {
    const builder = MONSTER_PLANS[plan] || MONSTER_PLANS.humanoid;
    return builder(params, options);
}
