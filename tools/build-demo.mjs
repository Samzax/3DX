// build-demo.mjs — writes the showcase table into an empty saves folder.
//
//   node tools/build-demo.mjs --saves <dir> [--force]
//
// The default campaign becomes "The Emberfall Marches": a world tuned to look
// good from the continent lens down to the grass, the hamlet of Thornbrook at
// the spawn (five buildings round a lit square), a level-5 party standing in
// it, a goblin war band coming over the rise to the east in plain sight of the
// square, a few journal entries, and the dungeon from build-dungeon.mjs behind
// a gated portal at the south-west edge of the village. GM bookmarks mark the
// showcase shots. `npm run demo` builds it once into data/demo and starts the
// server over it, so a fresh clone opens on something to look at.
//
// Run it with the server STOPPED. Without --force it refuses a folder that
// already holds a campaign registry. Log in as `gm` to run the table, or as
// `player` to play the party (the demo server runs in open-login mode).
//
// Units: 1 world unit = one 5-ft cell. +X is east, +Z is south.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGround } from '../public/js/shared/ground.js';
import { worldToHexAtTier, hexCenterAtTier } from '../public/js/shared/hexworld.js';
import { monsterTokenSnapshot, monsterColor } from '../public/js/shared/monsters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const savesDir = arg('--saves') && path.resolve(arg('--saves'));
const force = args.includes('--force');
if (!savesDir) {
    console.error('usage: node tools/build-demo.mjs --saves <dir> [--force]');
    process.exit(1);
}
const registryFile = path.join(savesDir, 'campaigns.json');
if (fs.existsSync(registryFile) && !force) {
    console.error(`${registryFile} exists; pass --force to rebuild the demo.`);
    process.exit(1);
}

// ---- the world ---------------------------------------------------------------
// The "Continents" preset with a guaranteed homeland round the spawn: lakes
// and forest about the village, snow-capped ranges on the skyline.
const SEED = 2;
const SPAWN = { x: -1000, z: -1000 };
const WORLD = { ocean: 60, landSize: 100, wetness: 0, temperature: 0, latitude: 50, rugged: 0, zones: 60, relief: 50, home: SPAWN };
const SEASON = 'summer';
const height = createGround({ seed: SEED, world: WORLD, season: SEASON }).height;
const round = (v) => Math.round(v * 100) / 100;
const uuid = () => crypto.randomUUID();

// Everything below is laid out in cells relative to the village square.
const OX = SPAWN.x, OZ = SPAWN.z;
const at = (lx, lz) => ({ x: OX + lx, z: OZ + lz });
const objects = [];
const put = (data) => { const id = uuid(); objects.push({ ...data, id, addedBy: 'gm' }); return id; };

// ---- buildings ---------------------------------------------------------------
// A house is one closed wall loop (door/window cells marked), a floor that
// follows the ground and a roof at the building's datum (its highest corner),
// all sharing one building id, exactly what the GM's Build tool writes.
function house({ lx, lz, cols, rows, style, roof = 'gable-x', wallHeight = 2, doors = [], windows = [] }) {
    const buildingId = `building-${uuid()}`;
    const x0 = OX + lx, z0 = OZ + lz;
    let datum = -Infinity;
    for (let x = x0; x <= x0 + cols; x++) for (let z = z0; z <= z0 + rows; z++) datum = Math.max(datum, height(x, z));
    datum = round(datum);
    const seed = 1 + Math.floor(Math.random() * 1e9);
    const piece = (data) => put({
        structureId: `structure-${uuid()}`, buildingId, buildingDatumY: datum,
        style, scruffy: false, seed, level: 0, levelHeight: wallHeight, ...data
    });
    // Clockwise from the north-west corner: north, east, south, west sides.
    const corners = [{ x: 0, z: 0 }, { x: cols, z: 0 }, { x: cols, z: rows }, { x: 0, z: rows }, { x: 0, z: 0 }];
    const cells = [];
    for (let i = 1; i < corners.length; i++) {
        const a = corners[i - 1], b = corners[i];
        const n = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
        const ux = Math.sign(b.x - a.x), uz = Math.sign(b.z - a.z);
        for (let k = 0; k < n; k++) cells.push({ side: i - 1, k, x: a.x + ux * (k + 0.5), z: a.z + uz * (k + 0.5) });
    }
    // Openings are given per side ('n', 'e', 's', 'w') as the cell counted
    // from that side's start.
    const sideIndex = { n: 0, e: 1, s: 2, w: 3 };
    const mark = (list, kind) => list.map(([side, k]) =>
        cells.findIndex(c => c.side === sideIndex[side] && c.k === k)).filter(i => i >= 0).map(i => [i, kind]);
    const segments = cells.map(() => null);
    for (const [i, kind] of [...mark(windows, 'window'), ...mark(doors, 'door')]) segments[i] = kind;
    const y = round(height(x0, z0));
    piece({
        type: 'wall', wallHeight, heightMode: 'terrain', position: { x: x0, y, z: z0 },
        path: corners, bx: 0, bz: 0, segments,
        ys: cells.map(c => round(height(x0 + c.x, z0 + c.z) - y))
    });
    const fy = round(height(x0 + cols / 2, z0 + rows / 2));
    const ys = [];
    for (let tz = 0; tz < rows; tz++) for (let tx = 0; tx < cols; tx++) ys.push(round(height(x0 + tx + 0.5, z0 + tz + 0.5) - fy));
    piece({ type: 'floor', heightMode: 'terrain', position: { x: x0, y: fy, z: z0 }, cols, rows, ys });
    piece({
        type: 'roof', level: 1, coversLevel: 0, roofShape: roof, pitch: roof === 'flat' ? 0.5 : 0.6,
        overhang: 0.16, heightMode: 'flat', position: { x: x0, y: round(datum + wallHeight), z: z0 }, cols, rows
    });
}

house({ lx: -5, lz: -13, cols: 10, rows: 7, style: 'stone', roof: 'hip', wallHeight: 2.5,     // the Ember & Anvil inn
        doors: [['s', 5]], windows: [['s', 2], ['s', 7], ['e', 3], ['w', 3], ['n', 3], ['n', 6]] });
house({ lx: -16, lz: -4, cols: 6, rows: 5, style: 'plaster', roof: 'gable-x',
        doors: [['e', 2]], windows: [['n', 2], ['s', 3]] });
house({ lx: 9, lz: -2, cols: 5, rows: 6, style: 'wood', roof: 'gable-z',
        doors: [['w', 3]], windows: [['e', 2], ['n', 2]] });
house({ lx: -7, lz: 7, cols: 6, rows: 4, style: 'plaster', roof: 'gable-x',
        doors: [['n', 3]], windows: [['n', 1], ['s', 4]] });
house({ lx: 4, lz: 8, cols: 5, rows: 4, style: 'wood', roof: 'flat', wallHeight: 1.8,           // the barn
        doors: [['n', 2]] });

// ---- dressing ------------------------------------------------------------------
const LIGHTS = { torch: { bright: 20, dim: 20, dark: 0 }, brazier: { bright: 30, dim: 30, dark: 0 } };
function prop(kind, lx, lz, rot = 0) {
    const p = at(lx, lz);
    const data = { type: 'prop', kind, rot, position: { x: p.x, y: round(height(p.x, p.z)), z: p.z } };
    if (LIGHTS[kind]) data.light = { ...LIGHTS[kind] };
    return put(data);
}
prop('brazier', 0.5, 0.5);                                      // the square's fire
prop('table', -2.5, -3.5); prop('bench', -2.5, -2.5); prop('bench', -2.5, -4.5, 2);
prop('table', 3.5, -3.5); prop('bench', 3.5, -2.5); prop('bench', 3.5, -4.5, 2);
prop('barrel', -5.5, -5.5); prop('barrel', -4.5, -5.5); prop('crate', 5.5, -5.5);
prop('torch', -1.5, -5.5, 2); prop('torch', 2.5, -5.5, 2);   // either side of the inn door
prop('crate', 9.5, 12.5); prop('crate', 10.5, 12.5); prop('barrel', 3.5, 12.5); prop('barrel', 9.5, 8.5);
prop('crate', -9.5, -5.5); prop('barrel', -9.5, 1.5);

// ---- the party ------------------------------------------------------------------
// Level 5, SRD 5.1 only. Base scores are point-buy (racial increases are the
// sheet's job); HP is the fixed-average progression.
const PLAYER = 'player';
const hp = (die, lvl, conScore, perLevel = 0) => {
    const con = Math.floor((conScore - 10) / 2);
    return die + con + (lvl - 1) * (die / 2 + 1 + con) + perLevel * lvl;
};
const party = [
    {
        name: 'Ysolde Varr', race: 'human', subrace: null, background: null, alignment: 'lawful-good',
        classes: [{ class: 'fighter', subclass: 'champion', level: 5 }],
        abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
        skills: ['athletics', 'perception', 'intimidation'],
        equipment: { armor: 'plate-armor', shield: true, weapons: ['longsword', 'javelin'], items: ['explorers-pack'] },
        spells: [], languages: ['Common', 'Dwarvish'],
        hp: hp(10, 5, 15),
        appearance: { body: 'female', skin: 'young-tan-female', eyeColor: 'green',
            wear: { hair: 'hair-braid', eyebrows: 'brows-arched', top: 'shirt', bottom: 'trousers', feet: 'boots-tall', head: '' },
            colors: { skin: '#c9946b', hair: '#3a2416', torso: '#7a2b24', legs: '#3a3f4a', eyes: '#3d6b3a' } },
        notes: 'A sellsword who stayed in Thornbrook when her company moved on.'
    },
    {
        name: 'Borin Ashgrove', race: 'dwarf', subrace: 'hill-dwarf', background: 'acolyte', alignment: 'neutral-good',
        classes: [{ class: 'cleric', subclass: 'life', level: 5 }],
        abilities: { str: 14, dex: 8, con: 13, int: 10, wis: 15, cha: 12 },
        skills: ['insight', 'religion', 'medicine', 'persuasion'],
        equipment: { armor: 'chain-mail', shield: true, weapons: ['warhammer', 'crossbow-light'], items: ['priests-pack', 'amulet'] },
        spells: ['sacred-flame', 'light', 'thaumaturgy', 'guidance', 'bless', 'cure-wounds', 'healing-word', 'guiding-bolt',
                 'spiritual-weapon', 'lesser-restoration', 'aid', 'spirit-guardians', 'revivify', 'mass-healing-word'],
        languages: ['Common', 'Dwarvish', 'Celestial'],
        hp: hp(8, 5, 15, 1),
        appearance: { body: 'male', skin: 'old-light-male', eyeColor: 'brown',
            wear: { hair: 'hair-short', beard: 'beard-viking', eyebrows: 'brows-heavy', top: 'tunic', bottom: 'wool-pants', feet: 'boots' },
            colors: { skin: '#d9a88a', hair: '#8a4b23', torso: '#c9b27a', legs: '#4a3b2a', eyes: '#4b3621' } },
        notes: 'Keeps the shrine of the Hearthmother at the edge of the village.'
    },
    {
        name: 'Caelith Morrow', race: 'elf', subrace: 'high-elf', background: null, alignment: 'chaotic-good',
        classes: [{ class: 'wizard', subclass: 'evocation', level: 5 }],
        abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
        skills: ['arcana', 'history', 'investigation', 'perception'],
        equipment: { armor: null, shield: false, weapons: ['quarterstaff', 'dagger'], items: ['spellbook', 'component-pouch', 'scholars-pack'] },
        spells: ['fire-bolt', 'mage-hand', 'ray-of-frost', 'light', 'magic-missile', 'shield', 'burning-hands', 'sleep',
                 'mage-armor', 'detect-magic', 'scorching-ray', 'misty-step', 'hold-person', 'fireball', 'lightning-bolt', 'counterspell'],
        languages: ['Common', 'Elvish', 'Draconic', 'Goblin'],
        hp: hp(6, 5, 13),
        appearance: { body: 'male', skin: 'young-light-male', eyeColor: 'blue',
            wear: { hair: 'hair-long-straight', eyebrows: 'brows-soft', outfit: 'robe', feet: 'boots-ankle', head: 'hood' },
            colors: { skin: '#f1d3bd', hair: '#d8d0c0', torso: '#2b3f7a', legs: '#23283a', eyes: '#3c6fa8' } },
        notes: 'Came north chasing a rumour of a mage who walled himself up under the hills.'
    },
    {
        name: 'Pip Underbough', race: 'halfling', subrace: 'lightfoot-halfling', background: null, alignment: 'chaotic-neutral',
        classes: [{ class: 'rogue', subclass: 'thief', level: 5 }],
        abilities: { str: 8, dex: 15, con: 14, int: 12, wis: 10, cha: 13 },
        skills: ['stealth', 'acrobatics', 'perception', 'sleight-of-hand', 'deception', 'investigation'],
        expertise: ['stealth', 'sleight-of-hand'],
        equipment: { armor: 'leather-armor', shield: false, weapons: ['shortsword', 'shortbow', 'dagger'], items: ['burglars-pack', 'thieves-tools'] },
        spells: [], languages: ['Common', 'Halfling', "Thieves' Cant"],
        hp: hp(8, 5, 14),
        appearance: { body: 'female', skin: 'freckled-female', eyeColor: 'hazel',
            wear: { hair: 'hair-messy', eyebrows: 'brows-arched', top: 'bodice', bottom: 'trousers', feet: 'boots-cuffed', hands: 'gloves' },
            colors: { skin: '#e8b996', hair: '#a5502a', torso: '#4c6b34', legs: '#3b3226', eyes: '#7a5a2a' } },
        notes: 'Swears the goblins started it.'
    }
];
const characters = {};
const partySpots = [[1.5, 2.5], [-0.5, 2.5], [0.5, 3.5], [2.5, 3.5]];
party.forEach((spec, i) => {
    const id = uuid();
    const { hp: maxHp, ...sheet } = spec;
    const char = {
        schemaVersion: 2, abilityMethod: 'point-buy', racialChoice: [], feats: [], expertise: [], choices: {}, xp: 6500,
        ...sheet,
        appearance: { height: 1, build: 1, headSize: 1, armLength: 1, legLength: 1, traits: [], ...spec.appearance },
        stats: { ...spec.abilities }, color: spec.appearance.colors.torso,
        id, owner: PLAYER, hp: { current: maxHp }
    };
    characters[id] = char;
    const p = at(partySpots[i][0], partySpots[i][1]);
    put({ type: 'character', characterData: char, position: { x: p.x, y: round(height(p.x, p.z) + 0.2), z: p.z } });
});

// ---- the war band -------------------------------------------------------------------
const SRD_MONSTERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'srd', 'monsters.json'), 'utf8'));
function monster(index, lx, lz) {
    const snap = monsterTokenSnapshot(SRD_MONSTERS.find(m => m.index === index));
    const p = at(lx, lz);
    put({ type: 'token', name: snap.name, color: monsterColor(snap), monsterData: snap,
          position: { x: p.x, y: round(height(p.x, p.z) + 0.1), z: p.z } });
}
monster('hobgoblin', 21, 9);
monster('goblin', 19, 7.5); monster('goblin', 19.5, 11); monster('goblin', 23, 7); monster('goblin', 22.5, 11.5);
monster('wolf', 17, 6.5); monster('wolf', 17.5, 12);

// ---- the dungeon gate ---------------------------------------------------------------
const POCKET = 'pocket/e3b0c442';
const tactical = (x, z) => {                       // tactical map key over a world point
    const k = worldToHexAtTier(0, x, z), kc = hexCenterAtTier(0, k.q, k.r);
    const p = worldToHexAtTier(1, x - kc.x, z - kc.z), pc = hexCenterAtTier(1, p.q, p.r);
    const t = worldToHexAtTier(2, x - kc.x - pc.x, z - kc.z - pc.z);
    return `world/${k.q},${k.r}/${p.q},${p.r}/${t.q},${t.r}`;
};
const gate = at(-21.5, 15.5);
put({ type: 'portal', target: POCKET, name: 'The Sealed Undercroft', position: { x: gate.x, y: round(height(gate.x, gate.z)), z: gate.z } });

// ---- fog: the hamlet's mile and the hexes round it are known country ---------------
const fog = {};
const home = worldToHexAtTier(2, SPAWN.x, SPAWN.z);
for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) {
    if (Math.abs(dq + dr) <= 2) fog[`${home.q + dq},${home.r + dr}`] = 1;
}

// ---- write ----------------------------------------------------------------------------
fs.mkdirSync(savesDir, { recursive: true });
const now = Date.now();
const registry = {
    campaigns: {
        default: {
            id: 'default',
            name: 'The Emberfall Marches',
            description: 'A frontier of lakes, pine and old stone under the Emberfall range. The hamlet of Thornbrook '
                + 'has kept its fires lit for three hundred years; this autumn something under the hills has started answering them.',
            recap: 'The party reached Thornbrook at dusk with a wagon of salt and bad news: goblin sign on the ridge road, '
                + 'and the old barrow gate south-west of the village standing open for the first time in living memory.',
            owner: 'gm', createdAt: now, visibility: 'public', members: [], status: 'active', session: 'open',
            settings: {
                mapStyle: 'ladder', seed: SEED, spawn: SPAWN, world: WORLD, season: SEASON,
                sky: { clock: 'fixed', hour: 16, dayMinutes: 24, at: now, weather: 'clear', rainbow: 'auto' }
            }
        }
    }
};
fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
fs.writeFileSync(path.join(savesDir, 'characters.json'), JSON.stringify(characters, null, 2));
const world = { objects: {}, rulers: {}, fog, meta: { kind: 'world' }, terrain: { format: 2, chunkCells: 32, vertexSpacing: 0.5, water: { bodies: [] }, chunks: {} } };
for (const o of objects) world.objects[o.id] = o;
const exitId = uuid();
const maps = {
    '@world': world,
    [POCKET]: {
        objects: { [exitId]: { id: exitId, type: 'portal', target: tactical(gate.x, gate.z), name: 'Exit', position: { x: 0, y: 0, z: 0 } } },
        rulers: {},
        meta: { kind: 'pocket', name: 'The Sealed Undercroft', width: 256, height: 256, parentKey: tactical(gate.x, gate.z) }
    }
};
fs.writeFileSync(path.join(savesDir, 'map_state.json'), JSON.stringify({ maps }, null, 2));
const entry = (kind, title, text, visible = 'party') => ({ id: uuid().slice(0, 8), kind, title, text, visible, at: now, updated: now });
fs.writeFileSync(path.join(savesDir, 'journal.json'), JSON.stringify({
    entries: [
        entry('quest', 'Raiders on the ridge road', 'Goblins have been seen on the ridge east of Thornbrook, under a hobgoblin with a red shield. Reeve Marta Vell will pay 50 gp for every raider driven off.'),
        entry('npc', 'Marta Vell, reeve of Thornbrook', 'Runs the Ember & Anvil and, by extension, the village. Practical, short-tempered, owed favours by half the valley.'),
        entry('lore', 'The barrow gate', 'A stone door in the hillside south-west of the village. Local stories say a mage sealed himself and his library inside rather than surrender it.'),
        entry('handout', 'What the goblins want', 'The war band is not raiding for food. Their chief was promised the key to the barrow gate by someone who never came back up.', 'gm')
    ],
    treasury: { gp: 140, sp: 35 },
    xp: { mode: 'milestone', awards: [] }
}, null, 2));

// GM bookmarks for the showcase shots, in shooting order. "Fly" from the first to
// the third is the continent-to-street descent.
const view = (name, look, eye, up) => {
    const l = at(...look), e = at(...eye), gy = round(height(l.x, l.z));
    return { id: uuid().slice(0, 8), name, mapKey: tactical(l.x, l.z),
        pose: { pos: { x: e.x, y: round(gy + up), z: e.z }, look: { x: l.x, y: gy, z: l.z } } };
};
fs.writeFileSync(path.join(savesDir, 'bookmarks.json'), JSON.stringify({
    bookmarks: [
        view('1 · Continent', [2, -1], [2, 69999], 60000),
        view('2 · Thornbrook', [2, -1], [2.5, 17.5], 7),
        view('3 · The party', [2, 2], [0.4, 7.8], 2.3),
        view('4 · War band', [19, 8], [-7, -3], 12),
        view('5 · Barrow gate', [-21.5, 15.5], [-17.5, 21], 9)
    ]
}, null, 2));

// The dungeon itself, and the gatehouse round its portal (also turns token vision on).
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-dungeon.mjs'), '--saves', savesDir, '--pocket', POCKET,
    '--campaign', registryFile, 'default'], { stdio: 'inherit' });
fs.rmSync(path.join(savesDir, 'map_state.json.before-dungeon'), { force: true });

let lo = Infinity, hi = -Infinity;
for (let x = -20; x <= 25; x++) for (let z = -15; z <= 15; z++) { const h = height(OX + x, OZ + z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
console.log(`demo written to ${savesDir}: ${objects.length} world objects, ground ${round(lo)}..${round(hi)}`);
