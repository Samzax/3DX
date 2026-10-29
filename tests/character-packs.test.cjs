// Character model packs (lib/character-packs.cjs), the sheet fields that pick a
// look (server.js sanitizeCharacterAppearance) and the creator-side rules that
// ride on the saved sheet (ability score improvements in rules.js). Packs are
// uncommitted user data, so everything they declare is treated as hostile.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const { loadCharacterPacks, loadCharacterKit, LOOK_KEY_RE } = require('../lib/character-packs.cjs');
const { loadMonsterPacks } = require('../lib/monster-packs.cjs');

function makePacks(packs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-char-packs-'));
    for (const [id, { json, files = [] }] of Object.entries(packs)) {
        fs.mkdirSync(path.join(dir, id));
        if (json !== undefined) {
            fs.writeFileSync(path.join(dir, id, 'pack.json'), typeof json === 'string' ? json : JSON.stringify(json));
        }
        for (const file of files) fs.writeFileSync(path.join(dir, id, file), 'x');
    }
    return dir;
}

test('a missing packs folder yields no looks', () => {
    const result = loadCharacterPacks(path.join(os.tmpdir(), '3dx-no-such-char-packs'));
    assert.deepEqual(Object.keys(result.looks), []);
    assert.deepEqual(result.warnings, []);
});

test('looks are sanitized field by field and keyed pack/id', () => {
    const dir = makePacks({
        heroes: {
            files: ['ranger.glb', 'clips.glb', 'ranger.png', 'statue.glb'],
            json: {
                name: 'Heroes',
                props: {
                    Club: { name: 'Big club', file: 'statue.glb', length: 0.8, items: ['Club', 'greatclub', '<x>'], attack: 'heavy', url: 'https://evil.example' },
                    loose: { file: 'statue.glb' },
                    gone: { file: 'nope.glb', items: ['club'] }
                },
                characters: {
                    'Ranger-F': {
                        name: 'Wood elf ranger', file: 'ranger.glb', height: 1.1,
                        races: ['Elf', 'half-elf', '<img>', 'elf'], body: 'female', animations: 'clips.glb',
                        clips: { idle: 'Idle', walk: 'Walk', breath: 'Nope', attack: '<script>' },
                        thumb: 'ranger.png', url: 'https://evil.example/x.glb', extra: { nested: true }, toon: true, outline: 9
                    },
                    statue: { file: 'statue.glb', name: '<b>bold</b>', body: 'robot', thumb: 'missing.png', toon: 'yes', outline: 2 },
                    'bad id!': { file: 'statue.glb' },
                    escape: { file: '../../server.glb' },
                    absent: { file: 'nope.glb' },
                    giant: { file: 'statue.glb', height: 400 }
                }
            }
        }
    });
    const result = loadCharacterPacks(dir);
    assert.deepEqual(result.packs, [{ id: 'heroes', name: 'Heroes', count: 2 }]);
    // Props: held things keyed pack/id; one with no items, or no file, is dropped.
    assert.deepEqual(JSON.parse(JSON.stringify(result.props)), {
        'heroes/club': { id: 'heroes/club', name: 'Big club', pack: 'heroes', url: '/packs/heroes/statue.glb', length: 0.8, items: ['club', 'greatclub'], attack: 'heavy' }
    });
    assert.deepEqual(result.looks['heroes/ranger-f'], {
        id: 'heroes/ranger-f', name: 'Wood elf ranger', pack: 'heroes',
        url: '/packs/heroes/ranger.glb', height: 1.1,
        races: ['elf', 'half-elf'], body: 'female',
        animUrl: '/packs/heroes/clips.glb',
        clips: { idle: 'Idle', walk: 'Walk' },
        thumb: '/packs/heroes/ranger.png',
        toon: true, outline: 3
    });
    // A bare entry is a static figure at the default height; unsafe text falls back to the id.
    assert.deepEqual(result.looks['heroes/statue'], {
        id: 'heroes/statue', name: 'statue', pack: 'heroes', url: '/packs/heroes/statue.glb', height: 1.15
    });
    assert.equal(result.warnings.length, 6);
    for (const key of Object.keys(result.looks)) assert.match(key, LOOK_KEY_RE);
    assert.doesNotMatch(JSON.stringify(result.looks), /[<>]|evil/);
});

test('one pack can carry monsters and characters; a characters-only pack is not a monster warning', () => {
    const dir = makePacks({
        both: {
            files: ['dragon.glb', 'hero.glb'],
            json: { monsters: { 'adult-red-dragon': { file: 'dragon.glb', height: 3 } }, characters: { hero: { file: 'hero.glb' } } }
        },
        people: { files: ['a.glb'], json: { characters: { a: { file: 'a.glb' } } } },
        empty: { json: { name: 'nothing here' } }
    });
    const monsters = loadMonsterPacks(dir, {});
    assert.deepEqual(Object.keys(monsters.entries), ['adult-red-dragon']);
    assert.deepEqual(monsters.warnings.length, 1); // only the pack that declares neither
    assert.match(monsters.warnings[0], /^empty:/);
    const characters = loadCharacterPacks(dir);
    assert.deepEqual(Object.keys(characters.looks).sort(), ['both/hero', 'people/a']);
    assert.deepEqual(characters.warnings, []);
});

test('the server keeps only known look fields on a saved appearance', () => {
    // sanitizeCharacterAppearance is module-private; lift it out with the
    // constants it reads rather than booting a server for a pure function.
    const source = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
    const grab = (start, end) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from);
        assert.ok(from >= 0 && to > from, `server.js no longer contains ${start}`);
        return source.slice(from, to);
    };
    const sanitize = new Function('LOOK_KEY_RE', `
        const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);
        const CHARACTER_COLOR_RE = /^#[0-9a-f]{6}$/i;
        const sanitizeColor = (v, f) => (typeof v === 'string' && CHARACTER_COLOR_RE.test(v) ? v.toLowerCase() : f);
        const boundedScalarNumber = (v, min, max, f) => {
            if (typeof v !== 'number' && typeof v !== 'string') return f;
            const n = Number(v); return Number.isFinite(n) && String(v).trim() !== '' ? Math.max(min, Math.min(max, n)) : f;
        };
        const CHARACTER_APPEARANCE_DEFAULTS = { height: 1, build: 1, headSize: 1, armLength: 1, legLength: 1 };
        ${grab('const CHARACTER_APPEARANCE_ENUMS', 'const CHARACTER_ABILITY_METHODS')}
        ${grab('function sanitizeCharacterAppearance', 'function sanitizeCharacterTextArray')}
        return sanitizeCharacterAppearance;`)(LOOK_KEY_RE);

    const legacy = sanitize({ height: 1.1, colors: { torso: '#123456' } }, '#000000');
    assert.deepEqual(Object.keys(legacy).sort(), ['armLength', 'build', 'colors', 'headSize', 'height', 'legLength']);

    const full = sanitize({
        body: 'female', outfit: 'robe', hair: 'long', beard: 'none',
        traits: ['tail', 'horns', 'wings', '<img>', 'horns'], look: 'heroes/ranger-f'
    }, '#000000');
    assert.equal(full.body, 'female');
    assert.equal(full.outfit, 'robe');
    assert.deepEqual(full.traits, ['horns', 'tail']);
    assert.equal(full.look, 'heroes/ranger-f');

    const hostile = sanitize({
        body: 'robot', outfit: { evil: true }, hair: '<svg>', beard: 7,
        traits: 'tail', look: '../../etc/passwd'
    }, '#000000');
    for (const key of ['body', 'outfit', 'hair', 'beard', 'traits', 'look']) assert.equal(hostile[key], undefined, key);

    // The parametric body: shape, detail sliders and one worn asset per slot.
    const body = sanitize({
        form: { age: 2, muscle: '0.75', weight: {}, stature: -1, extra: 1 },
        details: { 'nose-hump': 0.4, 'chin-width': -9, 'head-oval': 0, '<img>': 1, __proto__: 1 },
        wear: { hair: 'hair-long', beard: '', top: '<script>', wings: 'big', feet: 7 },
        skin: 'feline', eyeColor: 'Green!'
    }, '#000000');
    assert.deepEqual(body.form, { age: 1, muscle: 0.75, weight: 0.5, stature: 0 });
    assert.deepEqual(body.details, { 'nose-hump': 0.4, 'chin-width': -1 });
    assert.deepEqual(body.wear, { hair: 'hair-long', beard: '' }); // '' = deliberately nothing
    assert.equal(body.skin, 'feline');
    assert.equal(body.eyeColor, undefined);
    assert.doesNotMatch(JSON.stringify(body), /[<>]/);
});

// Checked as the server serves it: the owner's private parts are not in a
// clone, and loadCharacterKit drops whichever of them this checkout lacks.
test('the committed character kit is whole', () => {
    const dir = path.join(repoRoot, 'public/assets/characters/mh');
    const { kit } = loadCharacterKit(dir);
    assert.equal(kit.vertexCount, 19158);
    assert.equal(fs.statSync(path.join(dir, 'base.bin')).size, kit.vertexCount * 12);
    assert.equal(kit.rig.length, kit.bones.length);
    for (const bone of kit.rig) assert.ok(!bone.parent || kit.bones.includes(bone.parent), bone.name);
    for (const id of Object.keys(kit.targets)) assert.ok(fs.existsSync(path.join(dir, 'targets', id + '.bin')), id);
    for (const [id, slider] of Object.entries(kit.sliders)) {
        for (const target of [...slider.neg, ...slider.pos]) assert.ok(kit.targets[target], `${id} -> ${target}`);
    }
    for (const [id, asset] of Object.entries(kit.assets)) {
        assert.ok(fs.existsSync(path.join(dir, 'assets', id, 'mesh.bin')), id);
        // Race parts built with --parts are the owner's private work and live outside the CC0 set.
        assert.equal(asset.license, asset.source === '3dx_parts' ? 'private' : 'CC0', id);
        for (const material of [asset.material, ...Object.values(asset.materials || {})].filter(Boolean)) {
            for (const key of ['map', 'normalMap']) {
                if (material[key]) assert.ok(fs.existsSync(path.join(dir, 'assets', id, material[key])), `${id}/${material[key]}`);
            }
        }
    }
    for (const [id, skin] of Object.entries(kit.skins)) assert.ok(fs.existsSync(path.join(dir, 'skins', skin.map)), id);
    // What charmesh.js reaches for by name.
    for (const id of ['eyes', 'lashes', 'brows-soft', 'hair-short', 'hair-long', 'tunic', 'trousers', 'boots', 'robe', 'horns-curled', 'sword', 'dagger', 'hammer', 'bow', 'sceptre']) {
        assert.ok(kit.assets[id], id);
    }
    for (const id of ['young-light-male', 'young-light-female', 'old-light-male', 'old-light-female']) assert.ok(kit.skins[id], id);
});

test('the served kit drops private parts whose files are missing, and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-kit-'));
    try {
        const touch = (rel) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), ''); };
        fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify({
            assets: {
                'form-here': { slot: 'bodyform', license: 'private', target: 'form-here' },
                'form-gone': { slot: 'bodyform', license: 'private', target: 'form-gone' },
                'tunic': { slot: 'top', license: 'CC0' },
                'cape': { slot: 'top', license: 'CC0' }   // missing CC0 file: stays, so the kit test catches it
            },
            targets: { 'form-here': {}, 'form-gone': {}, 'nose-hump': {} },
            sliders: {
                'form-here': { group: 'form', neg: [], pos: ['form-here'] },
                'form-gone': { group: 'form', neg: [], pos: ['form-gone'] },
                'nose-hump': { group: 'nose', neg: [], pos: ['nose-hump'] }
            }
        }));
        for (const rel of ['assets/form-here/mesh.bin', 'assets/tunic/mesh.bin', 'targets/form-here.bin', 'targets/nose-hump.bin']) touch(rel);
        const { kit, dropped } = loadCharacterKit(dir);
        assert.deepEqual(dropped, ['form-gone']);
        assert.deepEqual(Object.keys(kit.assets).sort(), ['cape', 'form-here', 'tunic']);
        assert.deepEqual(Object.keys(kit.targets).sort(), ['form-here', 'nose-hump']);
        assert.deepEqual(Object.keys(kit.sliders).sort(), ['form-here', 'nose-hump']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('macro shape weights partition the adult body space', async () => {
    const source = fs.readFileSync(path.join(repoRoot, 'public/js/shared/mhbody.js'), 'utf8');
    const from = source.indexOf('const clamp01'), to = source.indexOf('// Detail sliders');
    const macroWeights = new Function(source.slice(from, to).replace('export function', 'function') + '; return macroWeights;')();
    const kit = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/assets/characters/mh/kit.json'), 'utf8'));
    const sum = (weights, test) => Object.entries(weights).filter(([id]) => test(id)).reduce((s, [, w]) => s + w, 0);
    for (const shape of [{}, { gender: 1, muscle: 1, weight: 0.2, height: 0.9 }, { gender: 0, age: 0.7, muscle: 0.3, weight: 0.8, height: 0.1 }]) {
        const weights = macroWeights(shape);
        assert.ok(Math.abs(sum(weights, id => /^(african|asian|caucasian)-/.test(id)) - 1) < 1e-6);
        assert.ok(Math.abs(sum(weights, id => id.startsWith('universal-')) - 1) < 1e-6);
        // Every non-empty target the rules name must exist in the kit (the average body is an empty target).
        for (const id of Object.keys(weights)) assert.ok(kit.targets[id] || /averagemuscle-averageweight$/.test(id), id);
    }
    assert.ok(macroWeights({ gender: 1, height: 0 })['male-young-averagemuscle-averageweight-minheight'] > 0.99);
});

test('ability score improvements raise the sheet and stop at 20', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
        ok: true,
        json: async () => JSON.parse(fs.readFileSync(path.join(repoRoot, String(url)), 'utf8'))
    });
    let SRD, rules;
    try {
        const moduleUrl = (file) => pathToFileURL(path.join(repoRoot, 'public/js/shared', file)).href;
        SRD = await (await import(moduleUrl('srd.js'))).loadSRD();
        rules = await import(moduleUrl('rules.js'));
    } finally {
        globalThis.fetch = realFetch;
    }
    const base = { race: 'human', classes: [{ class: 'fighter', level: 8 }], abilities: { str: 15, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } };
    const plain = rules.buildSheet(base, SRD);
    assert.equal(plain.finals.str, 16); // 15 + human
    const improved = rules.buildSheet({ ...base, asi: { str: 2, con: 1, dex: '<img>', wis: -4 } }, SRD);
    assert.equal(improved.finals.str, 18);
    assert.equal(improved.finals.con, 12);
    assert.equal(improved.finals.dex, plain.finals.dex);
    assert.equal(improved.finals.wis, plain.finals.wis);
    assert.equal(rules.buildSheet({ ...base, asi: { str: 12 } }, SRD).finals.str, 20);
});
