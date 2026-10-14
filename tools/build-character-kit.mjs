// Builds the player-character kit under public/assets/characters/mh/ from the
// MakeHuman data that ships with MPFB (the Blender extension) and, optionally,
// extracted MakeHuman asset packs. Everything read here is CC0 (see
// public/assets/characters/ATTRIBUTION.md); the output is plain binary the
// browser can morph, fit and skin without Blender (public/js/shared/mhbody.js).
//
//   node tools/build-character-kit.mjs [--mpfb <mpfb data dir>] [--assets <extracted packs dir>]
//
// Output:
//   kit.json            counts, rig (bone -> joint-cube vertex ranges), body mesh
//                       layout, morph-target catalog, slider catalog, asset list
//   base.bin            Float32 xyz of the 19158 base vertices (body + helpers,
//                       decimetres, +Y up, +Z front) — helpers stay: clothes and
//                       joints are fitted against them
//   body.bin            the renderable body: src (Uint16 base index per render
//                       vertex), uv (Float32), index (Uint32)
//   weights.bin         4 bone indices (Uint8) + 4 weights (Uint8, sum 255) per
//                       base vertex
//   targets/*.bin       one morph target each: Float32 scale, Uint32 n,
//                       Uint16 index[n] (padded to 4 bytes), Int16 xyz[n] (×scale/32767)
//   assets/<id>/…       fitted meshes (clothes, hair, eyes…): see writeAsset()

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const MPFB = path.resolve(arg('--mpfb', path.join(process.env.APPDATA || '', 'Blender Foundation/Blender/5.1/extensions/blender_org/mpfb/data')));
const ASSETS = arg('--assets', null);
const PARTS = arg('--parts', null); // fitted race parts (private, from a 3DGen project): never committed without the owner's say
const OUT = path.join(repoRoot, 'public/assets/characters/mh');

// Player characters are adults: the baby/child halves of the macro space stay out.
const AGES = ['young', 'old'];
// Detail groups offered as sliders (expression/asym/genitals/measure are not).
const DETAIL_GROUPS = ['head', 'forehead', 'eyebrows', 'eyes', 'nose', 'mouth', 'cheek', 'chin', 'ears', 'neck',
    'torso', 'stomach', 'hip', 'pelvis', 'buttocks', 'arms', 'legs', 'hands', 'feet', 'breast'];

if (!fs.existsSync(path.join(MPFB, '3dobjs/base.obj'))) {
    console.error(`MPFB data not found at ${MPFB} (pass --mpfb <dir>)`);
    process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'targets'), { recursive: true });

// ---- OBJ -------------------------------------------------------------------
function parseObj(text) {
    const v = [], vt = [], faces = [];
    let group = '';
    for (const line of text.split('\n')) {
        const c = line.charCodeAt(0);
        if (c === 118 /* v */) {
            const p = line.trim().split(/\s+/);
            if (p[0] === 'v') v.push(+p[1], +p[2], +p[3]);
            else if (p[0] === 'vt') vt.push(+p[1], +p[2]);
        } else if (c === 103 /* g */) {
            group = line.slice(2).trim();
        } else if (c === 102 /* f */) {
            const corners = line.trim().split(/\s+/).slice(1).map(s => {
                const [a, b] = s.split('/');
                return [parseInt(a, 10) - 1, b ? parseInt(b, 10) - 1 : -1];
            });
            faces.push({ group, corners });
        }
    }
    return { v, vt, faces };
}

// Split vertices on UV seams and triangulate: { src, uv, index }.
function renderMesh(obj, keep) {
    const key = new Map(), src = [], uv = [], index = [];
    const corner = ([vi, ti]) => {
        const k = vi * 65536 * 4 + (ti + 1);
        let r = key.get(k);
        if (r === undefined) {
            r = src.length; key.set(k, r); src.push(vi);
            uv.push(ti >= 0 ? obj.vt[ti * 2] : 0, ti >= 0 ? obj.vt[ti * 2 + 1] : 0);
        }
        return r;
    };
    for (const face of obj.faces) {
        if (!keep(face)) continue;
        const r = face.corners.map(corner);
        for (let i = 1; i + 1 < r.length; i++) index.push(r[0], r[i], r[i + 1]);
    }
    return { src, uv, index };
}

const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - buf.length % 4)]) : buf);
const bytes = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
// Concatenate named typed arrays into one file; returns the layout for kit.json.
function writeSections(file, sections) {
    const layout = {}, parts = [];
    let offset = 0;
    for (const [name, typed] of Object.entries(sections)) {
        const buf = pad4(bytes(typed));
        layout[name] = { offset, count: typed.length, type: typed.constructor.name };
        parts.push(buf); offset += buf.length;
    }
    fs.writeFileSync(file, Buffer.concat(parts));
    return layout;
}

// ---- Base mesh ---------------------------------------------------------------
const base = parseObj(fs.readFileSync(path.join(MPFB, '3dobjs/base.obj'), 'utf8'));
const vertexCount = base.v.length / 3;
const groups = JSON.parse(fs.readFileSync(path.join(MPFB, 'mesh_metadata/basemesh_vertex_groups.json'), 'utf8'));
const bodyEnd = groups.body[0][1]; // inclusive
fs.writeFileSync(path.join(OUT, 'base.bin'), bytes(new Float32Array(base.v)));
const body = renderMesh(base, face => face.group === 'body' && face.corners.every(([vi]) => vi <= bodyEnd));
const bodyLayout = writeSections(path.join(OUT, 'body.bin'), {
    src: new Uint16Array(body.src), uv: new Float32Array(body.uv), index: new Uint32Array(body.index)
});

// ---- Rig + weights -----------------------------------------------------------
const rigJson = JSON.parse(fs.readFileSync(path.join(MPFB, 'rigs/standard/rig.game_engine.json'), 'utf8'));
const boneNames = Object.keys(rigJson);
const jointRange = (end) => {
    if (end.strategy === 'CUBE') {
        const range = groups[end.cube_name];
        if (!range) throw new Error(`rig: unknown joint cube ${end.cube_name}`);
        return { verts: range[0] }; // [first, last] inclusive
    }
    if (Array.isArray(end.vertex_indices)) return { list: end.vertex_indices };
    throw new Error(`rig: unsupported joint strategy ${end.strategy}`);
};
const rig = boneNames.map(name => ({
    name, parent: rigJson[name].parent || null,
    head: jointRange(rigJson[name].head), tail: jointRange(rigJson[name].tail)
}));
const weightJson = JSON.parse(fs.readFileSync(path.join(MPFB, 'rigs/standard/weights.game_engine.json'), 'utf8')).weights;
const influences = Array.from({ length: vertexCount }, () => []);
boneNames.forEach((name, bone) => { for (const [vi, w] of weightJson[name] || []) influences[vi].push([bone, w]); });
const skinIndex = new Uint8Array(vertexCount * 4), skinWeight = new Uint8Array(vertexCount * 4);
influences.forEach((list, vi) => {
    list.sort((a, b) => b[1] - a[1]);
    const top = list.slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    let used = 0;
    top.forEach(([bone, w], i) => {
        const q = i === top.length - 1 ? 255 - used : Math.round(w / sum * 255);
        skinIndex[vi * 4 + i] = bone; skinWeight[vi * 4 + i] = Math.max(0, q); used += q;
    });
    if (!top.length) skinWeight[vi * 4] = 255; // unweighted helper: rides the root
});
const weightLayout = writeSections(path.join(OUT, 'weights.bin'), { skinIndex, skinWeight });

// ---- Morph targets -----------------------------------------------------------
function writeTarget(sourceFile, id) {
    const raw = fs.readFileSync(sourceFile);
    const lines = (sourceFile.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n');
    const idx = [], d = [];
    let max = 0;
    for (const line of lines) {
        if (!line || line[0] === '#') continue;
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        const x = +p[1], y = +p[2], z = +p[3];
        if (!(x || y || z)) continue;
        idx.push(+p[0]); d.push(x, y, z);
        max = Math.max(max, Math.abs(x), Math.abs(y), Math.abs(z));
    }
    if (!idx.length) return 0;
    const q = new Int16Array(d.length);
    for (let i = 0; i < d.length; i++) q[i] = Math.round(d[i] / max * 32767);
    const head = Buffer.alloc(8);
    head.writeFloatLE(max, 0); head.writeUInt32LE(idx.length, 4);
    fs.writeFileSync(path.join(OUT, 'targets', id + '.bin'), Buffer.concat([head, pad4(bytes(new Uint16Array(idx))), bytes(q)]));
    return idx.length;
}
const targets = {}; // id -> vertex count (absent = empty target)
const macroDir = path.join(MPFB, 'targets/macrodetails');
const isAdult = (name) => AGES.some(age => name.includes(`-${age}`));
for (const file of fs.readdirSync(macroDir)) {
    if (!file.endsWith('.target.gz') || !isAdult(file)) continue;
    const id = file.replace('.target.gz', '');
    const n = writeTarget(path.join(macroDir, file), id);
    if (n) targets[id] = n;
}
for (const file of fs.readdirSync(path.join(macroDir, 'height'))) {
    if (!file.endsWith('.target.gz') || !isAdult(file)) continue;
    const id = file.replace('.target.gz', '');
    const n = writeTarget(path.join(macroDir, 'height', file), id);
    if (n) targets[id] = n;
}

// Detail sliders. MakeHuman names opposite ends of one slider with these pairs.
const PAIRS = [['decr', 'incr'], ['in', 'out'], ['down', 'up'], ['backward', 'forward'], ['concave', 'convex'],
    ['compress', 'uncompress'], ['less', 'more'], ['small', 'big']];
const sliders = {}; // id -> { group, neg: [targetIds], pos: [targetIds] }
for (const group of DETAIL_GROUPS) {
    const dir = path.join(MPFB, 'targets', group);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('.target.gz')) continue;
        const name = file.replace('.target.gz', '');
        // Skip the macro-combination families (breast cup × firmness × age…) and tape-measure targets.
        if (/^(female|male)-/.test(name) || name.startsWith('measure-')) continue;
        const n = writeTarget(path.join(dir, file), name);
        if (!n) continue;
        targets[name] = n;
        const sym = name.replace(/^[lr]-/, ''); // left/right twins move together
        let slider = sym, side = 'pos';
        for (const [neg, pos] of PAIRS) {
            if (sym.endsWith('-' + neg)) { slider = sym.slice(0, -neg.length - 1); side = 'neg'; break; }
            if (sym.endsWith('-' + pos)) { slider = sym.slice(0, -pos.length - 1); side = 'pos'; break; }
        }
        const entry = sliders[slider] || (sliders[slider] = { group, neg: [], pos: [] });
        entry[side].push(name);
    }
}

// Body-form morphs from the parts folder: one switch each (0..1), not a face slider.
const partTargets = PARTS && path.join(path.resolve(PARTS), '3dx_parts', 'targets');
if (partTargets && fs.existsSync(partTargets)) {
    for (const file of fs.readdirSync(partTargets).filter(f => f.endsWith('.target'))) {
        const id = file.replace('.target', '');
        if (writeTarget(path.join(partTargets, file), id)) { targets[id] = true; sliders[id] = { group: 'form', neg: [], pos: [id] }; }
    }
}

// ---- Assets (clothes, hair, eyes, …) -----------------------------------------
// The --assets pass (tools/character-kit-assets.mjs) needs the extracted
// MakeHuman asset packs; the body alone builds without it.
let assets = {}, skins = {};
if (ASSETS) {
    const { buildAssets } = await import('./character-kit-assets.mjs');
    ({ assets, skins } = buildAssets({ dir: path.resolve(ASSETS), parts: PARTS && path.resolve(PARTS), out: path.join(OUT, 'assets'), vertexCount, parseObj, renderMesh, writeSections }));
}

fs.writeFileSync(path.join(OUT, 'kit.json'), JSON.stringify({
    version: 1,
    source: 'MakeHuman HM08 base mesh, targets, game_engine rig and weights (CC0), via MPFB',
    vertexCount, bodyVertexCount: bodyEnd + 1,
    body: bodyLayout, weights: weightLayout,
    bones: boneNames, rig, targets, sliders, assets, skins
}));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`kit: ${vertexCount} base vertices, body ${body.src.length} render vertices / ${body.index.length / 3} triangles`);
console.log(`     ${boneNames.length} bones, ${Object.keys(targets).length} targets, ${Object.keys(sliders).length} sliders, ${Object.keys(assets).length} assets, ${Object.keys(skins).length} skins`);
console.log(`     ${(size(OUT) / 1048576).toFixed(1)} MB in ${path.relative(repoRoot, OUT)}`);
