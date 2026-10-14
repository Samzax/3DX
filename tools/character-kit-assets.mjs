// The asset half of tools/build-character-kit.mjs: converts a curated set of
// MakeHuman assets (all CC0 — the pack and author of each are recorded in
// kit.json and public/assets/characters/ATTRIBUTION.md) into fitted meshes the
// browser can re-fit to any morphed body.
//
// A MakeHuman asset (.mhclo + .obj + .mhmat) binds every one of its vertices
// to three base-mesh vertices (barycentric weights) plus an offset that scales
// with the body. assets/<id>/mesh.bin keeps exactly that:
//   fitVerts  Uint16[n*3]   base vertices each asset vertex hangs from
//   fitWeight Float32[n*3]  barycentric weights
//   fitOffset Float32[n*3]  offset in kit units, scaled per axis at fit time
//   src/uv/index            the render mesh (src = asset vertex per render vertex)
// and kit.json records the scale references, the body vertices the asset hides,
// its slot and its textures (downsized to 1024 px by Pillow).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// slot -> [id, pack-relative folder, label, extra]. One asset per slot is worn
// (except "extra" slots); `covers` lists slots a full outfit replaces.
const A = (slot, id, dir, label, extra = {}) => ({ slot, id, dir, label, ...extra });
const SYS = 'makehuman_system_assets';
// What a body form stands in for: the face and everything human-shaped that would not fit it.
const FORM_COVERS = ['headform', 'hair', 'beard', 'eyebrows', 'horns', 'feet', 'hands', 'head'];
// Generated parts keep their own paint (steel must not take the outfit dye).
const PART = { textureSize: 2048, license: 'private', noTint: true };
export const CATALOG = [
    A('eyes', 'eyes', `${SYS}/eyes/high-poly`, 'Eyes', { materials: `${SYS}/eyes/materials` }),
    A('eyebrows', 'brows-soft', `${SYS}/eyebrows/eyebrow001`, 'Soft'),
    A('eyebrows', 'brows-heavy', `${SYS}/eyebrows/eyebrow006`, 'Heavy'),
    A('eyebrows', 'brows-arched', `${SYS}/eyebrows/eyebrow010`, 'Arched'),
    A('eyelashes', 'lashes', `${SYS}/eyelashes/eyelashes01`, 'Lashes'),

    A('hair', 'hair-short', `${SYS}/hair/short02`, 'Short'),
    A('hair', 'hair-cropped', `${SYS}/hair/short04`, 'Cropped'),
    A('hair', 'hair-swept', `${SYS}/hair/short01`, 'Swept'),
    A('hair', 'hair-messy', 'hair01/hair/cortu_short_messy_hair', 'Messy'),
    A('hair', 'hair-bob', `${SYS}/hair/bob01`, 'Bob'),
    A('hair', 'hair-long', `${SYS}/hair/long01`, 'Long'),
    A('hair', 'hair-long-straight', 'hair01/hair/o4saken_long01', 'Long, straight'),
    A('hair', 'hair-ponytail', `${SYS}/hair/ponytail01`, 'Ponytail'),
    A('hair', 'hair-braid', `${SYS}/hair/braid01`, 'Braid'),
    A('hair', 'hair-twin-braids', 'hair01/hair/elvs_double_mh_braid', 'Twin braids'),
    A('hair', 'hair-bun', 'hair01/hair/rehmanpolanski_hair_bun_brown', 'Bun'),
    A('hair', 'hair-afro', `${SYS}/hair/afro01`, 'Afro'),

    A('beard', 'beard-viking', 'bodyparts05/clothes/rehmanpolanski_beard_viking', 'Braided'),
    A('beard', 'beard-full', 'bodyparts05/clothes/grinsegold_beard_sigmund_wip', 'Full'),
    A('beard', 'beard-scruffy', 'bodyparts05/clothes/wdg_scruffy_beard', 'Scruffy'),
    A('beard', 'beard-moustache', 'bodyparts05/clothes/rehmanpolanski_moustache_viking', 'Moustache'),

    A('horns', 'horns-curled', 'bodyparts01/clothes/culturalibre_faun_horns', 'Curled'),
    A('horns', 'horns-bull', 'bodyparts01/clothes/culturalibre_minotaur_horns', 'Bull'),
    A('horns', 'horns-swept', 'bodyparts01/clothes/freezychan_lucoa_quetzalcoatl_horns', 'Swept'),

    A('outfit', 'robe', 'suits02/clothes/donitz_monk_robe', 'Robe', { covers: ['top', 'bottom'] }),
    A('top', 'tunic', 'suits02/clothes/rehmanpolanski_viking_tunic', 'Tunic'),
    A('top', 'sweater', 'shirts01/clothes/toigo_fisherman_sweater', 'Knit sweater'),
    A('top', 'bodice', 'shirts01/clothes/toigo_bodice-style_top', 'Bodice'),
    A('top', 'shirt', 'shirts01/clothes/elvs_crude_t-shirt_male', 'Plain shirt'),
    A('bottom', 'trousers', 'suits02/clothes/rehmanpolanski_viking_pants', 'Trousers'),
    A('bottom', 'wool-pants', 'pants01/clothes/toigo_wool_pants', 'Wool pants'),
    A('bottom', 'harem-pants', 'pants01/clothes/toigo_harem_pants', 'Loose pants'),
    A('feet', 'boots', 'suits02/clothes/rehmanpolanski_viking_boots', 'Hide boots'),
    A('feet', 'boots-tall', 'shoes01/clothes/culturalibre_male_boots', 'Tall boots'),
    A('feet', 'boots-cuffed', 'shoes01/clothes/grinsegold_female_pirate_boots', 'Cuffed boots'),
    A('feet', 'boots-ankle', 'shoes01/clothes/toigo_ankle_boots_male', 'Ankle boots'),
    A('hands', 'gloves', 'gloves01/clothes/toigo_gloves_medium', 'Gloves'),
    A('hands', 'gloves-long', 'gloves01/clothes/toigo_gloves_long', 'Long gloves'),
    A('head', 'hood', 'suits02/clothes/donitz_monk_robe_hood', 'Hood'),
    A('head', 'helm-warrior', 'hats02/clothes/culturalibre_warrior_helmet', 'Warrior helm'),
    A('head', 'helm-corinthian', 'hats02/clothes/grinsegold_corinthian_helmet', 'Crested helm'),
    A('head', 'helm-great', 'hats02/clothes/javherre_casco_caballero_templario_templar_knight_helmet', 'Great helm'),

    // Body forms (--parts <dir>, from a 3DGen project): a whole generated sculpt bound to the kit
    // body like a skin-tight suit. It replaces the visible body and face; the kit body underneath
    // still carries the joints, the shape sliders and the clothes. `target` is the body morph that
    // gives the kit body the sculpt's bulk.
    A('bodyform', 'dragonborn-a', '3dx_parts/clothes/dragonborn_a', 'Dragonborn, classic',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'dragonborn-a', armSpread: 0.14 }),
    A('bodyform', 'dragonborn-b', '3dx_parts/clothes/dragonborn_b', 'Dragonborn, brute',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'dragonborn-b', armSpread: 0.3 }),
    A('bodyform', 'dragonborn-c', '3dx_parts/clothes/dragonborn_c', 'Dragonborn, sleek',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'dragonborn-c', armSpread: 0.06 }),
    A('bodyform', 'dragonborn-d', '3dx_parts/clothes/dragonborn_d', 'Dragonborn, crowned',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'dragonborn-d', armSpread: 0.18 }),

    A('bodyform', 'tabaxi-cheetah', '3dx_parts/clothes/tabaxi_cheetah', 'Tabaxi, cheetah',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'tabaxi-cheetah', armSpread: 0.05, clothGap: 0.05, neckHold: 0.85 }),
    A('bodyform', 'tabaxi-leopard', '3dx_parts/clothes/tabaxi_leopard', 'Tabaxi, leopard',
        { covers: FORM_COVERS, replacesFace: true, textureSize: 2048, license: 'private', target: 'tabaxi-leopard', armSpread: 0.1, clothGap: 0.05, neckHold: 0.85 }),

    // Armour sets (--parts): sculpted, armoured figures cut into pieces. `armor` names the set a
    // piece belongs to, so equipping that armour on the sheet can put the whole set on.
    A('outfit', 'plate-armor', '3dx_parts/clothes/plate_armor', 'Full plate', { covers: ['top', 'bottom'], armor: 'plate', ...PART }),
    A('hands', 'plate-hands', '3dx_parts/clothes/plate_hands', 'Plate gauntlets', { armor: 'plate', ...PART }),
    A('feet', 'plate-feet', '3dx_parts/clothes/plate_feet', 'Sabatons', { armor: 'plate', ...PART }),
    A('head', 'plate-helm', '3dx_parts/clothes/plate_helm', 'Great helm', { covers: ['hair', 'beard', 'eyebrows', 'horns'], replacesFace: true, armor: 'plate', ...PART }),
    A('outfit', 'mail-armor', '3dx_parts/clothes/mail_armor', 'Mail and breastplate', { covers: ['top', 'bottom'], armor: 'mail', ...PART }),
    A('feet', 'mail-feet', '3dx_parts/clothes/mail_feet', 'Soldier boots', { armor: 'mail', ...PART }),
    A('outfit', 'leather-armor', '3dx_parts/clothes/leather_armor', 'Studded leather', { covers: ['top', 'bottom'], armor: 'leather', ...PART }),
    A('hands', 'leather-hands', '3dx_parts/clothes/leather_hands', 'Leather gloves', { armor: 'leather', bareSkin: true, ...PART }),
    A('feet', 'leather-feet', '3dx_parts/clothes/leather_feet', 'Scout boots', { armor: 'leather', ...PART }),

    A('weapon', 'sword', 'equipment01/clothes/joepal_crude_sword', 'Sword'),
    A('weapon', 'dagger', 'equipment01/clothes/o4saken_dagger', 'Dagger'),
    A('weapon', 'hammer', 'equipment01/clothes/culturalibre_war_hammer', 'War hammer'),
    A('weapon', 'bow', 'equipment01/clothes/culturalibre_wooden_bow', 'Bow'),
    A('weapon', 'sceptre', 'equipment01/clothes/culturalibre_magic_sceptre', 'Sceptre')
];

// Skins: a diffuse texture for the body mesh.
const S = (id, dir, label, tags) => ({ id, dir, label, tags });
export const SKINS = [
    S('young-light-male', `${SYS}/skins/young_caucasian_male`, 'Light', ['male', 'young']),
    S('young-light-female', `${SYS}/skins/young_caucasian_female`, 'Light', ['female', 'young']),
    S('young-dark-male', `${SYS}/skins/young_african_male`, 'Dark', ['male', 'young']),
    S('young-dark-female', `${SYS}/skins/young_african_female`, 'Dark', ['female', 'young']),
    S('young-tan-male', `${SYS}/skins/young_asian_male`, 'Tan', ['male', 'young']),
    S('young-tan-female', `${SYS}/skins/young_asian_female`, 'Tan', ['female', 'young']),
    S('old-light-male', `${SYS}/skins/old_caucasian_male`, 'Light, aged', ['male', 'old']),
    S('old-light-female', `${SYS}/skins/old_caucasian_female`, 'Light, aged', ['female', 'old']),
    S('old-dark-male', `${SYS}/skins/old_african_male`, 'Dark, aged', ['male', 'old']),
    S('old-dark-female', `${SYS}/skins/old_african_female`, 'Dark, aged', ['female', 'old']),
    S('tattooed-male', 'skins02/skins/rehmanpolanski_skin_viking_tattoos', 'War tattoos', ['male', 'young']),
    S('freckled-female', 'skins01/skins/toigo_light_skin_female_freckles', 'Freckled', ['female', 'young']),
    S('feline', 'skins03/skins/culturalibre_tigra_skin', 'Striped fur', ['fantasy']),
    S('grey', 'skins03/skins/bobby_03_grey_skinned_person', 'Ashen', ['fantasy'])
];

function parseMhmat(file) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('//')) continue;
        const [key, ...rest] = t.split(/\s+/);
        if (!(key in out)) out[key] = rest.join(' ');
    }
    return out;
}

function parseMhclo(file) {
    const clo = { verts: [], weights: [], offsets: [], deleted: [], scale: {}, meta: {} };
    let status = '', last = 0;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            const m = /^#\s*(author|license)[:\s]\s*(.+)$/i.exec(line);
            if (m) clo.meta[m[1].toLowerCase()] = m[2].trim();
            continue;
        }
        const words = line.split(/\s+/);
        if (status === 'v' && /^\d+$/.test(words[0])) {
            if (words.length === 1) {
                clo.verts.push(+words[0], +words[0], +words[0]); clo.weights.push(1, 0, 0); clo.offsets.push(0, 0, 0);
            } else {
                clo.verts.push(+words[0], +words[1], +words[2]);
                clo.weights.push(+words[3], +words[4], +words[5]);
                clo.offsets.push(+words[6], +words[7], +words[8]);
            }
            continue;
        }
        if (status === 'd' && (/^\d+$/.test(words[0]))) {
            let sequence = false;
            for (const word of words) {
                if (word === '-') { sequence = true; continue; }
                const v = +word;
                if (sequence) { for (let k = last + 1; k <= v; k++) clo.deleted.push(k); sequence = false; }
                else clo.deleted.push(v);
                last = v;
            }
            continue;
        }
        // Some files put a keyword (material …) between "verts 0" and the
        // vertex rows, so only another section ends the vertex list.
        const key = words[0];
        if (status === 'd' || key === 'delete_verts') status = '';
        if (key === 'verts') status = 'v';
        else if (key === 'delete_verts') status = 'd';
        else if (key === 'x_scale' || key === 'y_scale' || key === 'z_scale') clo.scale[key[0]] = [+words[1], +words[2], +words[3]];
        else if (key === 'obj_file') clo.obj = words.slice(1).join(' ');
        else if (key === 'material') clo.material = words.slice(1).join(' ');
        else if (key === 'author' || key === 'license') clo.meta[key] = words.slice(1).join(' ');
    }
    return clo;
}

const ranges = (list) => {
    const sorted = [...new Set(list)].sort((a, b) => a - b), out = [];
    for (const v of sorted) {
        const tail = out[out.length - 1];
        if (tail && tail[1] === v - 1) tail[1] = v; else out.push([v, v]);
    }
    return out;
};

export function buildAssets({ dir, parts, out, vertexCount, parseObj, renderMesh, writeSections }) {
    // Catalog folders resolve against the MakeHuman packs first, then the parts folder.
    const locate = (rel) => [dir, parts].filter(Boolean).map(root => path.join(root, rel)).find(p => fs.existsSync(p)) || path.join(dir, rel);
    fs.mkdirSync(out, { recursive: true });
    const assets = {}, skins = {}, imageJobs = [];
    const image = (from, toDir, name, limit = 1024) => {
        if (!from || !fs.existsSync(from)) return null;
        imageJobs.push({ from, to: path.join(toDir, name), limit });
        return name; // extension is appended by the resize pass (.jpg or .png)
    };
    const materialOf = (folder, mhmatFile, toDir, prefix, limit) => {
        const mat = parseMhmat(mhmatFile);
        const base = path.dirname(mhmatFile);
        const material = {};
        if (mat.diffuseTexture) material.map = image(path.join(base, mat.diffuseTexture), toDir, prefix + 'diffuse', limit);
        if (mat.normalmapTexture) material.normalMap = image(path.join(base, mat.normalmapTexture), toDir, prefix + 'normal', limit);
        // Generated armour: the sculpt's occlusion/roughness/metal texture (glTF channel layout).
        if (mat.ormTexture) material.ormMap = image(path.join(base, mat.ormTexture), toDir, prefix + 'orm', 1024);
        if (mat.diffuseColor) material.color = mat.diffuseColor.split(/\s+/).slice(0, 3).map(Number);
        if (/^true$/i.test(mat.transparent || '')) material.alpha = true;
        if (/^false$/i.test(mat.backfaceCull || '')) material.doubleSided = true;
        return material;
    };

    for (const item of CATALOG) {
        const folder = locate(item.dir);
        const mhcloFile = fs.existsSync(folder) && fs.readdirSync(folder).find(f => f.endsWith('.mhclo'));
        if (!mhcloFile) { console.warn(`asset ${item.id}: no .mhclo in ${item.dir} — skipped`); continue; }
        const clo = parseMhclo(path.join(folder, mhcloFile));
        const n = clo.verts.length / 3;
        if (!n || !clo.obj || clo.verts.some(v => v >= vertexCount)) { console.warn(`asset ${item.id}: unusable mhclo — skipped`); continue; }
        const obj = parseObj(fs.readFileSync(path.join(folder, clo.obj), 'utf8'));
        if (obj.v.length / 3 !== n) { console.warn(`asset ${item.id}: obj/mhclo vertex mismatch — skipped`); continue; }
        const mesh = renderMesh(obj, () => true);
        const toDir = path.join(out, item.id);
        fs.mkdirSync(toDir, { recursive: true });
        const layout = writeSections(path.join(toDir, 'mesh.bin'), {
            fitVerts: new Uint16Array(clo.verts), fitWeight: new Float32Array(clo.weights), fitOffset: new Float32Array(clo.offsets),
            src: new Uint16Array(mesh.src), uv: new Float32Array(mesh.uv), index: new Uint32Array(mesh.index)
        });
        const entry = {
            slot: item.slot, label: item.label, layout, vertexCount: n, scale: clo.scale,
            hides: ranges(clo.deleted), author: clo.meta.author || 'MakeHuman', license: item.license || 'CC0', source: item.dir.split('/')[0]
        };
        if (item.covers) entry.covers = item.covers;
        if (item.replacesFace) entry.replacesFace = true;
        if (item.target) entry.target = item.target;
        if (item.armSpread) entry.armSpread = item.armSpread;
        if (item.clothGap != null) entry.clothGap = item.clothGap; // how far clothes stand off this body (kit units)
        if (item.armor) entry.armor = item.armor;
        if (item.noTint) entry.noTint = true;
        if (item.neckHold) entry.neckHold = item.neckHold; // head carried low and forward: keep the neck near its sculpted pose
        if (item.bareSkin) entry.bareSkin = true; // shows its sculpted wearer's skin: not for body forms
        if (item.gain) entry.gain = item.gain; // a lift for a texture that reads too dark in the engine
        if (item.materials) { // a shared mesh with several materials (eye colors)
            entry.materials = {};
            for (const file of fs.readdirSync(path.join(dir, item.materials)).filter(f => f.endsWith('.mhmat')).sort()) {
                const name = file.replace('.mhmat', '');
                entry.materials[name] = materialOf(folder, path.join(dir, item.materials, file), toDir, name + '-');
            }
        } else if (clo.material) {
            entry.material = materialOf(folder, path.join(folder, clo.material), toDir, '', item.textureSize);
        }
        assets[item.id] = entry;
    }

    const skinDir = path.join(out, '..', 'skins');
    fs.mkdirSync(skinDir, { recursive: true });
    for (const skin of SKINS) {
        const folder = path.join(dir, skin.dir);
        const mhmat = fs.existsSync(folder) && fs.readdirSync(folder).find(f => f.endsWith('.mhmat'));
        if (!mhmat) { console.warn(`skin ${skin.id}: not found — skipped`); continue; }
        const mat = parseMhmat(path.join(folder, mhmat));
        const map = mat.diffuseTexture && image(path.join(folder, mat.diffuseTexture), skinDir, skin.id, 2048);
        if (!map) { console.warn(`skin ${skin.id}: no diffuse texture — skipped`); continue; }
        skins[skin.id] = { label: skin.label, tags: skin.tags, map, source: skin.dir.split('/')[0] };
    }

    // Downsize every texture in one Pillow pass: 1024 px is plenty for a
    // tabletop miniature; opaque images become JPEG, the rest stay PNG.
    const script = `
import json, sys
from PIL import Image
jobs = json.load(sys.stdin); out = {}
for job in jobs:
    im = Image.open(job['from'])
    alpha = im.mode in ('RGBA', 'LA', 'P') and im.convert('RGBA').getextrema()[3][0] < 250
    im = im.convert('RGBA' if alpha else 'RGB')
    limit = job.get('limit', 1024)
    if max(im.size) > limit: im.thumbnail((limit, limit), Image.LANCZOS)
    ext = '.png' if alpha else '.jpg'
    im.save(job['to'] + ext, **({'optimize': True} if alpha else {'quality': 88}))
    out[job['to']] = ext
json.dump(out, sys.stdout)`;
    const run = spawnSync('python', ['-c', script], { input: JSON.stringify(imageJobs), encoding: 'utf8', maxBuffer: 1 << 26 });
    if (run.status !== 0) throw new Error('texture pass failed (needs python + Pillow): ' + run.stderr);
    const extOf = JSON.parse(run.stdout);
    const withExt = (toDir, material) => {
        for (const key of ['map', 'normalMap', 'ormMap']) if (material && material[key]) material[key] += extOf[path.join(toDir, material[key])];
    };
    for (const [id, entry] of Object.entries(assets)) {
        withExt(path.join(out, id), entry.material);
        for (const material of Object.values(entry.materials || {})) withExt(path.join(out, id), material);
    }
    for (const skin of Object.values(skins)) skin.map += extOf[path.join(skinDir, skin.map)];
    return { assets, skins };
}
