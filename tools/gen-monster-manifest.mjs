#!/usr/bin/env node
// tools/gen-monster-manifest.mjs — regenerate public/assets/monsters/manifest.json.
//
// Reads the vendored SRD bestiary (data/srd/monsters.json), assigns every
// monster a procedural body plan + params (name/type heuristics, overridable
// per index via tools/monster-model-overrides.json), derives its tabletop
// height from the size ladder × plan factor, and writes a one-line-per-monster
// manifest so diffs stay reviewable. The server reads the same file for the
// variant accept-list; clients render from it (monster-models.js).
//
// Monsters listed in tools/gltf-model-map.json instead become kind:'gltf'
// entries pointing at a vendored CC0 GLB in public/assets/monsters/glbs/
// (explicit height per mapping); everything else stays procedural.
//
// Usage:
//   node tools/gen-monster-manifest.mjs          # write the manifest
//   node tools/gen-monster-manifest.mjs --check  # exit 1 if it would change
//
// This tool is data-only (no three.js import): plan/height building is
// validated by tests/monster-models.test.cjs instead. PLAN_NAMES below must
// stay in sync with monster-generators.js — the test enforces the match.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRD_PATH = join(ROOT, 'data', 'srd', 'monsters.json');
const OVERRIDES_PATH = join(ROOT, 'tools', 'monster-model-overrides.json');
const GLTF_MAP_PATH = join(ROOT, 'tools', 'gltf-model-map.json');
const OUT_PATH = join(ROOT, 'public', 'assets', 'monsters', 'manifest.json');
const GLB_DIR = join(ROOT, 'public', 'assets', 'monsters', 'glbs');
const GLB_FILE_RE = /^[a-z0-9-]+\.glb$/i;
const GLB_URL_RE = /^\/assets\/monsters\/glbs\/[a-z0-9-]+\.glb$/i;
const CHECK_ONLY = process.argv.includes('--check');

const PLAN_NAMES = [
    'ape', 'quadruped', 'humanoid', 'dragon', 'saurian', 'avian', 'serpent',
    'arthropod', 'aquatic', 'ooze', 'swarm', 'elemental', 'construct',
    'plant', 'aberrant'
];

// Tabletop size ladder (world units ≈ 5 ft each). height = ladder × PLAN_FACTOR
// is the target soles-to-top height the client scales the model to.
const SIZE_UNITS = { Tiny: 0.4, Small: 0.8, Medium: 1.2, Large: 2.4, Huge: 3.6, Gargantuan: 5.0 };
const PLAN_FACTOR = {
    ape: 0.92, quadruped: 0.75, humanoid: 1.0, dragon: 0.95, saurian: 0.8,
    avian: 0.7, serpent: 0.35, arthropod: 0.4, aquatic: 0.4, ooze: 0.6,
    swarm: 0.3, elemental: 0.9, construct: 1.0, plant: 0.9, aberrant: 0.8
};

const NAMEPLATE_MIN = 0.72;
const NAMEPLATE_MAX = 20;
const HEIGHT_MIN = 0.1;
const HEIGHT_MAX = 12;

// --- small helpers -----------------------------------------------------------

const round2 = value => Math.round(value * 100) / 100;

function hash01(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
}

const byte = value => Math.max(0, Math.min(255, Math.round(value)));

function hexToRgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
}

function rgbToHex([r, g, b]) {
    return '#' + [byte(r), byte(g), byte(b)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function mixHex(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    return rgbToHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

const lighten = (hex, t) => mixHex(hex, '#ffffff', t);
const darken = (hex, t) => mixHex(hex, '#000000', t);

// "Giant Rat (Diseased)" -> "giant rat"; names carry parentheticals.
function baseName(monster) {
    return monster.name.toLowerCase().replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

function baseType(type) {
    return /^swarm\b/i.test(type) ? 'swarm' : type;
}

// --- palettes ----------------------------------------------------------------

// Mirrors TYPE_COLORS in public/js/shared/monsters.js (cosmetic tint only —
// rule/UI colors there, model sheen here).
const TYPE_TINTS = {
    aberration: '#8b5cf6', beast: '#65a30d', celestial: '#eab308',
    construct: '#64748b', dragon: '#dc2626', elemental: '#0891b2',
    fey: '#db2777', fiend: '#7f1d1d', giant: '#b45309',
    humanoid: '#2563eb', monstrosity: '#9333ea', ooze: '#16a34a',
    plant: '#15803d', undead: '#475569', swarm: '#475569'
};
const TINT_STRENGTH = { beast: 0.14, monstrosity: 0.18, humanoid: 0.22, undead: 0.2, default: 0.26 };

const NEUTRAL_TONES = [
    '#8a7358', '#6f6a60', '#7d7161', '#5f6b5a', '#8a8175',
    '#7a6a5a', '#66707a', '#94846c', '#6b5f52', '#7f7a6a'
];

// Name-pattern palettes: matched against the parenthetical-stripped lowercase
// name, so dragon colors cover wyrmling/young/adult/ancient in one rule.
const SPECIES_PALETTES = [
    [/\bdragon turtle\b/, { body: '#5d7a52', accent: '#43593c', belly: '#b9a06a', detail: '#3a3026' }],
    [/\bred dragon\b/, { body: '#9e3527', accent: '#7c2519', belly: '#e3ac66' }],
    [/\bblue dragon\b/, { body: '#4270a4', accent: '#2f547f', belly: '#c6d4e4' }],
    [/\bgreen dragon\b/, { body: '#4d7c45', accent: '#386031', belly: '#b5c89c' }],
    [/\bwhite dragon\b/, { body: '#dde5ed', accent: '#b4c2d0', belly: '#f4f8fb' }],
    [/\bblack dragon\b/, { body: '#434b41', accent: '#2f362f', belly: '#94a08a' }],
    [/\bbrass dragon\b/, { body: '#a87b40', accent: '#815e2e', belly: '#e4c994' }],
    [/\bbronze dragon\b/, { body: '#8d6c4c', accent: '#6b5037', belly: '#d5b98f' }],
    [/\bcopper dragon\b/, { body: '#a05c3d', accent: '#79442b', belly: '#dfae80' }],
    [/\bgold dragon\b/, { body: '#cb9c40', accent: '#a27827', belly: '#f0daa2' }],
    [/\bsilver dragon\b/, { body: '#bcc3cb', accent: '#979fa8', belly: '#e8ecef' }],
    // Bones and grave dirt.
    [/skeleton\b/, { body: '#ded7c5', accent: '#c6bea9', belly: '#efe9da', horn: '#e8e2d2' }],
    [/\bmummy\b/, { body: '#c9b98d', accent: '#a89667', belly: '#e2d7b4' }],
    [/^lich\b/, { body: '#b9c2ae', accent: '#93a08a', belly: '#d8ded0' }],
    // Pale spirits.
    [/^(ghost|specter|shadow|wraith)\b/, { body: '#9fb0bd', accent: '#7c8e9d', belly: '#c6d2db', glow: '#bcd8ea' }],
    [/will-o/, { body: '#6fe8c8', accent: '#3fbfa0', belly: '#c8fff2', glow: '#8affdf' }],
    [/^vampire/, { body: '#4a3f46', accent: '#332b30', belly: '#8f8890', detail: '#5c1f24' }],
    // Elementals by name.
    [/\b(air )?elemental\b|^air |invisible stalker|\bdjinni\b/, { body: '#bcd7e4', accent: '#8fb6cb', belly: '#e6f2f8' }],
    [/^earth elemental|\bxorn\b/, { body: '#7d6b57', accent: '#5f5142', belly: '#a89680' }],
    [/^fire elemental|\bmagmin\b|\befreeti\b/, { body: '#e2762e', accent: '#b8541c', belly: '#f7c66f', glow: '#ffb347' }],
    [/^water elemental/, { body: '#4d86b8', accent: '#36688f', belly: '#9cc4de', glow: '#7fd4e8' }],
    [/^magma mephit|\bsalamander\b/, { body: '#6b4a40', accent: '#4d352d', belly: '#e07a3a', glow: '#ff9147' }],
    [/^ice mephit/, { body: '#a9cede', accent: '#7fa8c0', belly: '#e3f1f8', detail: '#dff2fb' }],
    [/^dust mephit/, { body: '#b3a184', accent: '#8f8067', belly: '#d8cbb2' }],
    [/^steam mephit/, { body: '#aeb6ba', accent: '#8b9498', belly: '#dfe4e6' }],
    [/\bazer\b/, { body: '#b07b3e', accent: '#8a5d2b', belly: '#e6c489', glow: '#ffcf7a' }],
    // Oozes.
    [/\bblack pudding\b/, { body: '#33342e', accent: '#23241f', belly: '#4a4b43' }],
    [/\bgray ooze\b/, { body: '#77787a', accent: '#5b5c5e', belly: '#9d9ea0' }],
    [/\bochre jelly\b/, { body: '#c99a34', accent: '#a37a23', belly: '#e8c77b' }],
    [/\bgelatinous cube\b/, { body: '#6fae74', accent: '#4f8a56', belly: '#a8d8ac' }],
    // Constructs.
    [/^animated armor|\bflying sword\b|\biron golem\b/, { body: '#82888f', accent: '#61666c', belly: '#a9aeb4', horn: '#c3c7cb' }],
    [/^clay golem/, { body: '#b5765a', accent: '#945c43', belly: '#d9a184' }],
    [/^flesh golem|\bhomunculus\b/, { body: '#bd8f80', accent: '#9a6d60', belly: '#ddbcae' }],
    [/^stone golem|\bshield guardian\b/, { body: '#8d8779', accent: '#6c675c', belly: '#b3ada0' }],
    [/\brug of smothering\b/, { body: '#8e3b34', accent: '#6e2b26', belly: '#c98a6a' }],
    // Plants.
    [/^treant|awakened (shrub|tree)/, { body: '#6a5334', accent: '#4f3f27', belly: '#7fa05a', detail: '#43351f' }],
    [/^shambling mound/, { body: '#4f7a3f', accent: '#3b5e2f', belly: '#7fa05a' }],
    [/^shrieker/, { body: '#6f5aa8', accent: '#54417f', belly: '#a48fd6', glow: '#8f77d0' }],
    [/^violet fungus/, { body: '#7a4a9c', accent: '#5d3777', belly: '#a377c4' }],
    // Races and peoples.
    [/\bgoblin\b|\bkobold\b|\blizardfolk\b|\bsahuagin\b/, { body: '#6b8f4e', accent: '#517039', belly: '#a4bd86' }],
    [/\bmerfolk\b/, { body: '#4f9c8e', accent: '#3a7a6e', belly: '#8fd0c4' }],
    [/\bgnoll\b|\bhyena\b/, { body: '#9a8255', accent: '#7a6541', belly: '#c0ad83' }],
    [/\borc\b|\bbugbear\b|\bhobgoblin\b/, { body: '#6f7f4a', accent: '#54613a', belly: '#9aa877' }],
    [/\bdrow\b|\bduergar\b|\bdeep gnome\b|\bgrimlock\b/, { body: '#77707f', accent: '#5a5462', belly: '#a49cab' }],
    [/\bsahuagin\b/, { body: '#4e8a6a', accent: '#3a6a50', belly: '#8cc0a4' }],
    // Giants by adjective.
    [/\bcloud giant\b/, { body: '#94a0ad', accent: '#727d89', belly: '#c2cbd4' }],
    [/\bfire giant\b/, { body: '#96543a', accent: '#743e2a', belly: '#cb9070' }],
    [/\bfrost giant\b/, { body: '#8ba0ad', accent: '#6b7e8a', belly: '#bccbd4' }],
    [/\bhill giant\b/, { body: '#87724f', accent: '#67563c', belly: '#b0a07c' }],
    [/\bstone giant\b/, { body: '#8a8474', accent: '#6a6558', belly: '#b2ad9e' }],
    [/\bstorm giant\b/, { body: '#7d7394', accent: '#5f5775', belly: '#aaa1c0' }],
    [/\btroll\b/, { body: '#77875a', accent: '#5b6944', belly: '#9fae7d' }],
    [/\bogre\b|\boni\b/, { body: '#8b8761', accent: '#6c6849', belly: '#b0ab84' }],
    // Famous standouts.
    [/polar bear|winter wolf|^unicorn|^pegasus/, { body: '#e2e7ea', accent: '#bfc8cd', belly: '#f5f8f9' }],
    [/\bblack bear|^grick\b/, { body: '#4f463c', accent: '#3b342c', belly: '#7d7264' }],
    [/\bworg\b|^death dog\b|\bhell hound\b/, { body: '#5c5548', accent: '#443f35', belly: '#8b8371' }],
    [/\bcouatl\b/, { body: '#5aa06a', accent: '#c9a34a', belly: '#4a86b8', detail: '#a85a9c' }],
    [/\bcult(ist| fanatic)\b|\bpriest\b|\bacolyte\b|\bnight hag\b|\bgreen hag\b|\bsea hag\b|\bsatyr\b|\bdryad\b/, { body: '#5f6b4f', accent: '#47513b', belly: '#8f9a7a' }],
    [/\bdeve?a\b|\bplanetar\b|\bsolar\b/, { body: '#d8d2c2', accent: '#b3ab96', belly: '#efe9db', horn: '#e8c86a' }],
    [/\btiefling|\bdevil\b|\bbalor\b|\bmarilith\b|\bdrider\b|\bchimera\b|\bmanticore\b/, { body: '#8a4a42', accent: '#6a352f', belly: '#b57f70' }]
];

// Index-keyed palettes for monsters whose name pattern is ambiguous.
const INDEX_PALETTES = {
    'gargoyle': { body: '#8d8877', accent: '#6d6959', belly: '#b1ac9a' },
    'vampire-vampire': { body: '#3f3440', accent: '#2b232e', belly: '#8f8890', detail: '#5c1f24' },
    'vampire-spawn': { body: '#54464f', accent: '#3c3139', belly: '#9c939b', detail: '#5c1f24' },
    'vampire-bat': { body: '#4a4046', accent: '#352d32', belly: '#7f767d' },
    'vampire-mist': { body: '#9aa8b2', accent: '#7a8894', belly: '#c2ccd4', glow: '#aabcc8' },
    'ogre-zombie': { body: '#7d8461', accent: '#616749', belly: '#9aa07c' },
    'minotaur-skeleton': { body: '#ded7c5', accent: '#c6bea9', belly: '#efe9da', horn: '#e8e2d2' },
    'warhorse-skeleton': { body: '#ded7c5', accent: '#c6bea9', belly: '#efe9da', horn: '#e8e2d2' },
    'half-red-dragon-veteran': { body: '#9a5a48', accent: '#7c2519', belly: '#d9a98f' },
    'tarrasque': { body: '#8a6a4a', accent: '#6a4e34', belly: '#c9a97f', horn: '#e0d5b8' },
    'kraken': { body: '#4a3f5c', accent: '#373049', belly: '#7f7299', glow: '#8fd0e8' },
    'aboleth': { body: '#5b6f73', accent: '#44545a', belly: '#8fa5a8' },
    'roper': { body: '#6b5a48', accent: '#524435', belly: '#95856f' },
    'purple-worm': { body: '#6e4a78', accent: '#523660', belly: '#a07aae' },
    'remorhaz': { body: '#7a5a4a', accent: '#5e4437', belly: '#e07a3a', glow: '#ff9147' },
    'gibbering-mouther': { body: '#8a6a5a', accent: '#6b4f43', belly: '#b5948a', glow: '#d0a070' },
    'mimic': { body: '#8a6a4a', accent: '#6b4f37', belly: '#b08f6a' },
    'ochre-jelly': { body: '#c99a34', accent: '#a37a23', belly: '#e8c77b' }
};

function paletteFor(monster, type) {
    const indexed = INDEX_PALETTES[monster.index];
    if (indexed) return { ...indexed };
    const name = baseName(monster);
    for (const [pattern, colors] of SPECIES_PALETTES) {
        if (pattern.test(name)) return { ...colors };
    }
    const tint = TYPE_TINTS[type] || TYPE_TINTS.humanoid;
    const strength = TINT_STRENGTH[type] ?? TINT_STRENGTH.default;
    const body = mixHex(NEUTRAL_TONES[Math.floor(hash01(monster.index) * NEUTRAL_TONES.length) % NEUTRAL_TONES.length], tint, strength);
    return { body, accent: darken(body, 0.2), belly: lighten(body, 0.3) };
}

// --- classification ----------------------------------------------------------
// Name rules run before type defaults: "Dragon Turtle" is a dragon type but a
// turtle plan, "wolf spider" is a beast but a bug, and lycanthrope form
// records are typed humanoid yet render as their animal.

function quad(archetype, extra = {}, rule = 'type:default') {
    return { plan: 'quadruped', params: { archetype, ...extra }, rule };
}

function human(archetype, extra = {}, rule = 'type:default') {
    return { plan: 'humanoid', params: { archetype, ...extra }, rule };
}

function plan(name, params = {}, rule = 'type:default') {
    return { plan: name, params, rule };
}

const LYCANTHROPE_FORMS = { bear: 'ursine', boar: 'suine', rat: 'rodent', tiger: 'feline', wolf: 'canid' };

function swarmCreature(name) {
    if (/\bbats?\b/.test(name)) return 'bat';
    if (/\brats?\b/.test(name)) return 'rat';
    if (/\bsnakes?\b/.test(name)) return 'snake';
    if (/\bquippers?\b/.test(name)) return 'fish';
    if (/\bravens?\b/.test(name)) return 'bat'; // winged birds read best as the flying sketch
    if (/\b(spiders?|insects?|beetles?|wasps?|centipedes?)\b/.test(name)) return 'insect';
    if (/\b(human|claws?|zombies?|skeletons?)\b/.test(name)) return 'humanoid';
    return 'insect';
}

function dragonAgeParams(name) {
    if (/\bwyrmling\b/.test(name)) return { bulk: 0.8, wingSpan: 0.3, neckLength: 0.5, tailLength: 0.7 };
    if (/^young /.test(name)) return { bulk: 0.95, wingSpan: 0.6, neckLength: 0.6 };
    if (/^ancient /.test(name)) return { bulk: 1.15, wingSpan: 1.3, neckLength: 0.9, tailLength: 1.4 };
    return {}; // adult defaults
}

const AVIAN_BY_NAME = {
    'hawk': { beak: 'short', legs: 'talons' },
    'eagle': { beak: 'hook', legs: 'talons', upright: true },
    'owl': { beak: 'hook', legs: 'talons', upright: true, wings: 'folded', tailFan: 4 },
    'raven': { beak: 'hook', legs: 'talons', wings: 'folded', tailFan: 4 },
    'vulture': { beak: 'hook', legs: 'talons', wings: 'folded', crest: false },
    'blood hawk': { beak: 'hook', legs: 'talons', wings: 'spread' },
    'giant owl': { beak: 'hook', legs: 'talons', upright: true, wings: 'folded', tailFan: 4, bulk: 1.3, wingSpan: 0.7 },
    'giant eagle': { beak: 'hook', legs: 'talons', upright: true, bulk: 1.3, wingSpan: 0.7 },
    'giant vulture': { beak: 'hook', legs: 'talons', wings: 'folded', bulk: 1.3, wingSpan: 0.7 },
    'axe beak': { beak: 'long', beakLength: 0.2, crest: true, legs: 'talons', bulk: 1.1 },
    'roc': { beak: 'hook', legs: 'talons', bulk: 1.6, wingSpan: 1.3, wings: 'spread' },
    'bat': { beak: 'none', mammal: true, wings: 'spread', crest: false, bulk: 0.9 },
    'giant bat': { beak: 'none', mammal: true, wings: 'spread', crest: false, bulk: 1.2, wingSpan: 0.5 },
    'darkmantle': { beak: 'none', mammal: true, wings: 'spread', crest: false, bulk: 0.95 }
};

// Exact-name rules for famous monsters whose silhouette comes from the plan
// rather than the SRD type. Keys are parenthetical-stripped lowercase names.
const FAMOUS = {
    // Monstrosities and familiars.
    'minotaur': () => quad('bovine', { bulk: 1.25, tailLength: 0.5 }, 'name:minotaur'),
    'gorgon': () => quad('bovine', { bulk: 1.2 }, 'name:gorgon'),
    'centaur': () => quad('equine', { bulk: 1.05 }, 'name:centaur'),
    'griffon': () => quad('owlbear', { bulk: 1.15, tail: 'long', tailLength: 0.45 }, 'name:griffon'),
    'hippogriff': () => quad('owlbear', { bulk: 1.0, tail: 'brush', tailLength: 0.5, mane: true }, 'name:hippogriff'),
    'androsphinx': () => quad('feline', { mane: true, bulk: 1.15 }, 'name:sphinx'),
    'gynosphinx': () => quad('feline', { bulk: 1.1 }, 'name:sphinx'),
    'chimera': () => quad('feline', { bulk: 1.2, horns: 'curved', hornLength: 0.35, tailLength: 0.35 }, 'name:chimera'),
    'manticore': () => quad('feline', { bulk: 1.1, tailLength: 0.65 }, 'name:manticore'),
    'owlbear': () => quad('owlbear', {}, 'name:owlbear'),
    'lamia': () => quad('feline', { bulk: 1.05, tailLength: 0.4 }, 'name:lamia'),
    'hydra': () => plan('saurian', { biped: false, bulk: 1.4, neckLength: 0.7, tailLength: 1.1, crest: true, teeth: true }, 'name:hydra'),
    'tarrasque': () => plan('saurian', { biped: true, plates: true, tailSpikes: true, browHorns: true, teeth: true, bulk: 1.5, tailLength: 1.3 }, 'name:tarrasque'),
    'bulette': () => plan('saurian', { biped: false, plates: true, armorDomes: true, bulk: 1.3, tailLength: 0.5 }, 'name:bulette'),
    'behir': () => plan('saurian', { biped: false, neckLength: 1.0, bulk: 1.2, tailLength: 1.1, teeth: true }, 'name:behir'),
    'rust monster': () => plan('saurian', { biped: false, plates: true, armorDomes: true, crest: true }, 'name:rust-monster'),
    'basilisk': () => plan('saurian', { biped: false, crest: true, frill: true, tailLength: 0.7 }, 'name:basilisk'),
    'cockatrice': () => plan('saurian', { biped: false, crest: true, frill: true, bulk: 0.9, tailLength: 0.6 }, 'name:cockatrice'),
    'drider': () => plan('arthropod', { form: 'spider', bulk: 1.25 }, 'name:drider'),
    'chuul': () => plan('arthropod', { form: 'crab', bulk: 1.2, pincers: true }, 'name:chuul'),
    'ettercap': () => plan('arthropod', { form: 'spider', bulk: 1.1, pattern: false }, 'name:ettercap'),
    'phase spider': () => plan('arthropod', { form: 'spider', pattern: true, bulk: 1.15 }, 'name:phase-spider'),
    'ankheg': () => plan('arthropod', { form: 'beetle', horn: true, bulk: 1.15 }, 'name:ankheg'),
    'grick': () => plan('aberrant', { form: 'roper', tentacles: 5, stalks: 4 }, 'name:grick'),
    'otyugh': () => plan('aberrant', { form: 'roper', tentacles: 7 }, 'name:otyugh'),
    'roper': () => plan('aberrant', { form: 'roper', tentacles: 6 }, 'name:roper'),
    'purple worm': () => plan('aberrant', { form: 'worm', segments: 10, bulk: 1.3 }, 'name:purple-worm'),
    'remorhaz': () => plan('aberrant', { form: 'worm', segments: 8, bulk: 1.2, glow: true }, 'name:remorhaz'),
    'gibbering mouther': () => plan('ooze', { form: 'mass', mouths: 6, eyes: 4 }, 'name:gibbering-mouther'),
    'mimic': () => plan('ooze', { form: 'blob', mouths: 2, eyes: 1, bulk: 1.05 }, 'name:mimic'),
    'cloaker': () => plan('aquatic', { form: 'ray', opacity: 0.9 }, 'name:cloaker'),
    'aboleth': () => plan('aquatic', { form: 'squid', bulk: 1.1 }, 'name:aboleth'),
    'kraken': () => plan('aquatic', { form: 'squid', bulk: 1.5 }, 'name:kraken'),
    'couatl': () => plan('serpent', { bodyLength: 2.2, raised: 0.6, coils: 1, fangs: true, bulk: 1.1 }, 'name:couatl'),
    'dragon turtle': () => plan('aquatic', { form: 'turtle', bulk: 1.3 }, 'name:dragon-turtle'),
    'medusa': () => human('lizardfolk', { weapon: 'none' }, 'name:medusa'),
    'merrow': () => human('lizardfolk', { weapon: 'trident' }, 'name:merrow'),
    'sahuagin': () => human('lizardfolk', { weapon: 'trident', clothing: 'none' }, 'name:sahuagin'),
    'marilith': () => human('generic', { arms: 6, weapon: 'sword', clothing: 'none', form: 'serpentine' }, 'name:marilith'),
    'harpy': () => human('civilian', { weapon: 'dagger', claws: true, clothing: 'none' }, 'name:harpy'),
    'doppelganger': () => human('civilian', { weapon: 'none' }, 'name:doppelganger'),
    'gargoyle': () => human('brute', { weapon: 'none', clothing: 'none' }, 'name:gargoyle'),
    'azer': () => human('warrior', { weapon: 'hammer', headgear: 'none' }, 'name:azer'),
    'will-o-wisp': () => plan('elemental', { form: 'fire', bulk: 0.6 }, 'name:will-o-wisp'), // SRD name carries an apostrophe; matched below too
    "will-o'-wisp": () => plan('elemental', { form: 'fire', bulk: 0.6 }, 'name:will-o-wisp'),
    // Beasts and celestials that fall outside the type default.
    'winter wolf': () => quad('canid', { bulk: 1.15 }, 'name:winter-wolf'),
    'worg': () => quad('canid', { bulk: 1.15 }, 'name:worg'),
    'death dog': () => quad('canid', { bulk: 1.05 }, 'name:death-dog'),
    'blink dog': () => quad('canid', { bulk: 0.9 }, 'name:blink-dog'),
    'hell hound': () => quad('canid', { bulk: 1.05 }, 'name:hell-hound'),
    'nightmare': () => quad('equine', { bulk: 1.1 }, 'name:nightmare'),
    'pegasus': () => quad('equine', { bulk: 1.05 }, 'name:pegasus'),
    'unicorn': () => quad('equine', { horns: 'straight', hornLength: 0.5, bulk: 1.05 }, 'name:unicorn')
};

const BEAST_QUADRUPEDS = [
    [/\b(elephant|mammoth)\b/, 'bovine', { tusks: true }],
    [/rhinoceros/, 'bovine', { horns: 'straight', hornLength: 0.12 }],
    [/\bboar\b/, 'suine', {}],
    [/\b(wolf|hyena|jackal|mastiff)\b/, 'canid', {}],
    [/\bbear\b/, 'ursine', {}],
    [/\b(lion|tiger|panther|cat)\b/, 'feline', {}],
    [/\b(camel|mule|pony)\b|horse/, 'equine', {}],
    [/\b(deer|elk)\b/, 'cervine', {}],
    [/\b(rat|weasel|badger)\b/, 'rodent', {}],
    [/\bgoat\b/, 'caprine', {}],
    [/baboon/, 'primate', {}],
    [/\bcrocodile\b/, 'crocodilian', {}],
    [/^(giant )?lizard$/, 'reptile', {}]
];

function humanoidFor(name) {
    const rules = [
        [/\b(acolyte|priest|cult fanatic)\b/, 'priest', {}],
        [/\b(archmage|mage|druid)\b/, 'mage', {}],
        [/\b(bandit captain)\b/, 'warrior', { headgear: 'none' }],
        [/\bbandit\b/, 'bandit', {}],
        [/\bguard\b/, 'warrior', { weapon: 'spear' }],
        [/\b(knight|veteran)\b/, 'warrior', {}],
        [/\bhalf-red dragon\b/, 'warrior', {}],
        [/\bgladiator\b/, 'warrior', { clothing: 'scale', weapon: 'spear', headgear: 'none' }],
        [/\bassassin\b/, 'civilian', { clothing: 'armor', weapon: 'dagger', headgear: 'none' }],
        [/\bspy\b/, 'civilian', { weapon: 'dagger', headgear: 'none' }],
        [/\bscout\b/, 'civilian', { clothing: 'armor', weapon: 'bow', headgear: 'none' }],
        [/\bthug\b/, 'bandit', {}],
        [/\bberserker\b/, 'brute', { weapon: 'axe' }],
        [/\btribal warrior\b/, 'bandit', { weapon: 'spear', clothing: 'none' }],
        [/\bcultist\b/, 'civilian', { clothing: 'robe', weapon: 'dagger' }],
        [/\bgoblin\b/, 'goblin', {}],
        [/\bkobold\b/, 'kobold', {}],
        [/\bgnoll\b/, 'gnoll', {}],
        [/\bbugbear\b/, 'brute', { bulk: 1.15, weapon: 'axe' }],
        [/\bhobgoblin\b/, 'orc', { weapon: 'sword' }],
        [/\borc\b/, 'orc', {}],
        [/\blizardfolk\b/, 'lizardfolk', {}],
        [/\bmerfolk\b/, 'merfolk', {}],
        [/\bdeep gnome\b/, 'goblin', { bulk: 0.8 }],
        [/\bdrow\b/, 'warrior', { weapon: 'dagger' }],
        [/\bduergar\b/, 'warrior', { weapon: 'axe' }],
        [/\bnoble\b/, 'noble', {}],
        [/\bcommoner\b/, 'villager', {}],
        [/\bgrimlock\b/, 'ghoul', { weapon: 'none', clothing: 'none' }]
    ];
    for (const [pattern, archetype, extra] of rules) {
        if (pattern.test(name)) return human(archetype, extra, `name:${archetype}`);
    }
    return human('civilian', {}, 'type:humanoid');
}

function giantFor(name) {
    if (/\bogre\b/.test(name)) return human('brute', {}, 'name:ogre');
    if (/\btroll\b/.test(name)) return human('brute', { bulk: 1.45, slouch: 0.1 }, 'name:troll');
    if (/\boni\b/.test(name)) return human('brute', { bulk: 1.45 }, 'name:oni');
    if (/\bettin\b/.test(name)) return human('giant', { bulk: 1.6 }, 'name:ettin');
    return human('giant', {}, 'type:giant');
}

function fiendFor(name) {
    const rules = [
        [/\bdretch\b/, 'brute', { bulk: 0.9 }],
        [/\blemure\b/, 'zombie', { bulk: 0.9 }],
        [/\b(imp|quasit)\b/, 'goblin', { bulk: 0.6 }],
        [/\b(hezrou|vrock|nalfeshnee|glabrezu)\b/, 'brute', { bulk: 1.5 }],
        [/\bbalor\b/, 'brute', { bulk: 1.9, weapon: 'axe' }],
        [/\bpit fiend\b/, 'brute', { bulk: 1.7, weapon: 'none' }],
        [/\b(bone devil)\b/, 'brute', { weapon: 'none', clothing: 'none', tail: 'spade' }],
        [/\b(horned devil)\b/, 'brute', { weapon: 'none', clothing: 'none', horns: 'curved' }],
        [/\b(barbed|bearded|ice) devil\b/, 'brute', { weapon: 'none', clothing: 'none' }],
        [/\bchain devil\b/, 'brute', { weapon: 'none', clothing: 'none' }],
        [/\berinyes\b/, 'warrior', { weapon: 'bow', shield: false }],
        [/\b(succubus|incubus)\b/, 'civilian', { weapon: 'none' }],
        [/\bnight hag\b/, 'ghoul', { weapon: 'none' }],
        [/\brakshasa\b/, 'civilian', { clothing: 'robe', weapon: 'dagger', claws: true }]
    ];
    for (const [pattern, archetype, extra] of rules) {
        if (pattern.test(name)) return human(archetype, extra, `name:${archetype}`);
    }
    return human('brute', {}, 'type:fiend');
}

function undeadFor(name) {
    if (/minotaur skeleton$/.test(name)) return quad('bovine', { bone: true, bulk: 1.1 }, 'name:minotaur-skeleton');
    if (/warhorse skeleton$/.test(name)) return quad('equine', { bone: true }, 'name:warhorse-skeleton');
    if (/^skeleton$/.test(name)) return human('skeleton', {}, 'name:skeleton');
    if (/ogre zombie$/.test(name)) return human('zombie', { bulk: 1.5, slouch: 0.18 }, 'name:ogre-zombie');
    if (/^(ghast)$/.test(name)) return human('ghoul', { bulk: 1.0 }, 'name:ghast');
    if (/^(ghoul)$/.test(name)) return human('ghoul', {}, 'name:ghoul');
    if (/^(wraith)$/.test(name)) return human('wraith', {}, 'name:wraith');
    if (/^(ghost|specter|shadow)$/.test(name)) return human('specter', {}, 'name:spirit');
    if (/^wight$/.test(name)) return human('ghoul', { clothing: 'armor', weapon: 'sword' }, 'name:wight');
    if (/^lich$/.test(name)) return human('mage', { weapon: 'staff' }, 'name:lich');
    if (/^mummy/.test(name)) return human('zombie', { clothing: 'rags' }, 'name:mummy');
    if (/^vampire/.test(name)) return human('civilian', { weapon: 'sword', clothing: 'robe' }, 'name:vampire');
    if (/^zombie$/.test(name)) return human('zombie', {}, 'name:zombie');
    return human('zombie', {}, 'type:undead');
}

function elementalFor(name) {
    if (/magma|salamander/.test(name)) return plan('elemental', { form: 'magma' }, 'name:magma');
    if (/ice/.test(name)) return plan('elemental', { form: 'ice' }, 'name:ice');
    if (/dust/.test(name)) return plan('elemental', { form: 'sand' }, 'name:dust');
    if (/steam/.test(name)) return plan('elemental', { form: 'steam' }, 'name:steam');
    if (/\bwater\b/.test(name)) return plan('elemental', { form: 'water' }, 'name:water');
    if (/\bearth\b|\bxorn\b/.test(name)) return plan('elemental', { form: 'earth' }, 'name:earth');
    if (/\bfire\b|\bmagmin\b|\befreeti\b/.test(name)) return plan('elemental', { form: 'fire' }, 'name:fire');
    if (/\bair\b|invisible stalker|\bdjinni\b/.test(name)) return plan('elemental', { form: 'air' }, 'name:air');
    return plan('elemental', { form: 'fire' }, 'type:elemental');
}

function constructFor(name) {
    if (/animated armor/.test(name)) return plan('construct', { form: 'armor' }, 'name:animated-armor');
    if (/flying sword/.test(name)) return plan('construct', { form: 'animated', bulk: 0.7 }, 'name:flying-sword');
    if (/homunculus/.test(name)) return plan('construct', { form: 'animated', bulk: 0.6 }, 'name:homunculus');
    if (/rug of smothering/.test(name)) return plan('construct', { form: 'animated', bulk: 1.1 }, 'name:rug');
    if (/shield guardian/.test(name)) return plan('construct', { form: 'golem', material: 'stone' }, 'name:shield-guardian');
    if (/clay golem/.test(name)) return plan('construct', { form: 'golem', material: 'clay' }, 'name:golem');
    if (/flesh golem/.test(name)) return plan('construct', { form: 'golem', material: 'clay' }, 'name:golem');
    if (/iron golem/.test(name)) return plan('construct', { form: 'golem', material: 'iron' }, 'name:golem');
    if (/stone golem/.test(name)) return plan('construct', { form: 'golem', material: 'stone' }, 'name:golem');
    return plan('construct', { form: 'golem', material: 'stone' }, 'type:construct');
}

function oozeFor(name) {
    if (/gelatinous cube/.test(name)) return plan('ooze', { form: 'cube', opacity: 0.62 }, 'name:gelatinous-cube');
    if (/black pudding/.test(name)) return plan('ooze', { form: 'blob', bulk: 1.15 }, 'name:black-pudding');
    if (/gray ooze/.test(name)) return plan('ooze', { form: 'blob', bulk: 0.9 }, 'name:gray-ooze');
    if (/ochre jelly/.test(name)) return plan('ooze', { form: 'blob', bulk: 1.1 }, 'name:ochre-jelly');
    return plan('ooze', { form: 'blob' }, 'type:ooze');
}

function plantFor(name) {
    if (/shrieker/.test(name)) return plan('plant', { form: 'shrieker' }, 'name:shrieker');
    if (/violet fungus/.test(name)) return plan('plant', { form: 'fungus' }, 'name:violet-fungus');
    if (/shambling mound/.test(name)) return plan('plant', { form: 'vine', bulk: 1.2 }, 'name:shambling-mound');
    if (/awakened shrub/.test(name)) return plan('plant', { form: 'treant', bulk: 0.7 }, 'name:awakened');
    if (/awakened tree|treant/.test(name)) return plan('plant', { form: 'treant' }, 'name:treant');
    return plan('plant', { form: 'vine' }, 'type:plant');
}

function feyFor(name) {
    if (/(green|sea) hag/.test(name)) return human('gnoll', { weapon: 'none' }, 'name:hag');
    if (/^dryad$/.test(name)) return human('villager', { weapon: 'none' }, 'name:dryad');
    if (/^satyr$/.test(name)) return human('villager', { weapon: 'spear', headgear: 'none', horns: 'small' }, 'name:satyr');
    if (/^sprite$/.test(name)) return human('civilian', { bulk: 0.6, weapon: 'none' }, 'name:sprite');
    return human('civilian', {}, 'type:fey');
}

function celestialFor(name) {
    if (/\bdeva\b/.test(name)) return human('warrior', {}, 'name:deva');
    if (/\b(planetar|solar)\b/.test(name)) return human('warrior', { bulk: 1.3, weapon: 'sword' }, 'name:planetar');
    return human('warrior', { weapon: 'sword' }, 'type:celestial');
}

function beastQuadruped(name) {
    for (const [pattern, archetype, extra] of BEAST_QUADRUPEDS) {
        if (pattern.test(name)) return quad(archetype, extra, `name:${archetype}`);
    }
    return quad('generic', {}, 'type:beast');
}

function classify(monster) {
    const name = baseName(monster);
    const type = baseType(monster.type);

    // 1. Lycanthrope / vampire alternate forms (suffix records, typed humanoid).
    const formMatch = name.match(/, (bear|boar|rat|tiger|wolf|human|hybrid|bat|mist) form$/);
    if (formMatch) {
        const form = formMatch[1];
        if (LYCANTHROPE_FORMS[form]) return quad(LYCANTHROPE_FORMS[form], {}, `form:${form}`);
        if (form === 'human') return human('civilian', {}, 'form:human');
        if (form === 'hybrid') return human('brute', { bulk: 1.15, weapon: 'none', claws: true }, 'form:hybrid');
        if (form === 'bat') return plan('avian', { beak: 'none', mammal: true, wings: 'spread', crest: false }, 'form:bat');
        if (form === 'mist') return human('specter', {}, 'form:mist');
    }

    // 2. Swarms: name picks the critter silhouette.
    if (type === 'swarm') {
        return plan('swarm', { creature: swarmCreature(name), seed: 1 + Math.floor(hash01(monster.index) * 9998) }, 'type:swarm');
    }

    // 3. Famous monsters (exact names, plan beats SRD type).
    const famous = FAMOUS[name];
    if (famous) return famous();

    // 4. Snakes.
    if (/snake$/.test(name)) {
        return plan('serpent', {
            viper: name.includes('poisonous'),
            fangs: true,
            raised: name.includes('flying') ? 0.5 : 0.3,
            thickness: name.includes('giant') ? 1.15 : 0.9
        }, 'name:snake');
    }

    // 5. Aquatic critters.
    if (/whale$/.test(name)) return plan('aquatic', { form: 'whale', baleen: !name.includes('killer') }, 'name:whale');
    if (/shark$/.test(name)) return plan('aquatic', { form: 'shark' }, 'name:shark');
    if (/octopus/.test(name)) return plan('aquatic', { form: 'octopus' }, 'name:octopus');
    if (/sea horse$/.test(name)) return plan('aquatic', { form: 'seahorse' }, 'name:sea-horse');
    if (name === 'quipper') return plan('aquatic', { form: 'fish' }, 'name:quipper');
    if (name === 'plesiosaurus') return plan('aquatic', { form: 'plesiosaur' }, 'name:plesiosaurus');

    // 6. Birds and bats.
    const avian = AVIAN_BY_NAME[name];
    if (avian) return plan('avian', avian, 'name:avian');

    // 7. Dinosaurs and amphibians.
    if (name === 'tyrannosaurus rex') {
        return plan('saurian', { biped: true, teeth: true, bulk: 1.3, legLength: 0.5, neckLength: 0.35, tailLength: 1.2 }, 'name:trex');
    }
    if (name === 'triceratops') {
        return plan('saurian', { biped: false, browHorns: true, frill: true, bulk: 1.3, tailLength: 0.7 }, 'name:triceratops');
    }
    if (/^(giant )?(frog|toad)$/.test(name)) {
        return plan('saurian', { biped: false, bulk: 1.05, legLength: 0.22, neckLength: 0.06, tailLength: 0.3, snout: true }, 'name:amphibian');
    }

    // 8. Apes and dragons.
    if (name === 'ape' || name === 'giant ape') return plan('ape', {}, 'name:ape');
    if (/^(adult|ancient|young) .*dragon$/.test(name) || /dragon wyrmling$/.test(name)) {
        return plan('dragon', dragonAgeParams(name), 'name:dragon-age');
    }
    if (name === 'wyvern') return plan('dragon', { forelegs: false, neckLength: 0.5, tailLength: 1.1, wingSpan: 0.7 }, 'name:wyvern');
    if (name === 'pseudodragon') {
        return plan('dragon', { bulk: 0.7, wingSpan: 0.2, neckLength: 0.45, tailLength: 0.6, tailBlade: true }, 'name:pseudodragon');
    }

    // 9. Nagas.
    if (/naga$/.test(name)) return plan('serpent', { hood: true, fangs: true, raised: 0.85, bulk: 1.05 }, 'name:naga');

    // 10. Vermin families — after the famous rules, before the fur lists so
    //     "giant wolf spider" lands on eight legs instead of four.
    if (/spider$/.test(name)) return plan('arthropod', { form: 'spider', pattern: true }, 'name:spider');
    if (/scorpion$/.test(name)) return plan('arthropod', { form: 'scorpion' }, 'name:scorpion');
    if (/centipede/.test(name)) return plan('arthropod', { form: 'centipede', segments: 14 }, 'name:centipede');
    if (/\bcrab$/.test(name)) return plan('arthropod', { form: 'crab' }, 'name:crab');
    if (/\bbeetle\b/.test(name)) return plan('arthropod', { form: 'beetle' }, 'name:beetle');
    if (/\bwasp$/.test(name)) return plan('arthropod', { form: 'spider', pattern: true }, 'name:wasp');
    if (name === 'stirge') return plan('arthropod', { form: 'spider', pattern: false }, 'name:stirge');

    // 11. Four-legged species lists (beasts and leftovers).
    if (type === 'beast') return beastQuadruped(name);
    const quadruped = BEAST_QUADRUPEDS.find(([pattern]) => pattern.test(name));
    if (quadruped && (type === 'monstrosity' || type === 'fey' || type === 'celestial' || type === 'fiend')) {
        return quad(quadruped[1], quadruped[2], `name:${quadruped[1]}`);
    }

    // 12. Type defaults.
    switch (type) {
        case 'humanoid': return humanoidFor(name);
        case 'giant': return giantFor(name);
        case 'fiend': return fiendFor(name);
        case 'undead': return undeadFor(name);
        case 'elemental': return elementalFor(name);
        case 'construct': return constructFor(name);
        case 'ooze': return oozeFor(name);
        case 'plant': return plantFor(name);
        case 'fey': return feyFor(name);
        case 'celestial': return celestialFor(name);
        case 'dragon': return plan('dragon', dragonAgeParams(name), 'type:dragon');
        case 'monstrosity': return quad('generic', {}, 'type:monstrosity');
        case 'aberration': return plan('aberrant', { form: 'roper' }, 'type:aberration');
        default: return human('civilian', {}, 'type:default');
    }
}

// --- manifest build ----------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const VARIANT_ID = /^[a-z0-9][a-z0-9_-]*$/i;

function loadOverrides() {
    if (!existsSync(OVERRIDES_PATH)) return {};
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    const overrides = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('$')) continue; // $comment and friends
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`overrides.${key} must be an object`);
        }
        overrides[key] = value;
    }
    return overrides;
}

// tools/gltf-model-map.json — SRD index -> vendored GLB:
//   { "wolf": { "f": "aa-wolf.glb", "h": 0.85, "np": 1.3 } }
// `h` is the required soles-to-top token height; `np` an optional nameplate Y
// (default height + 0.42). Unknown SRD keys or malformed values fail hard;
// files present but unmapped are only warned about (a pool of spare models).
function loadGltfMap(monsters) {
    if (!existsSync(GLTF_MAP_PATH)) return new Map();
    const parsed = JSON.parse(readFileSync(GLTF_MAP_PATH, 'utf8'));
    const known = new Set(monsters.map(monster => monster.index));
    const map = new Map();
    for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('$')) continue;
        if (!known.has(key)) throw new Error(`gltf-model-map key "${key}" has no SRD monster`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`gltf-model-map.${key} must be an object { f, h }`);
        }
        if (typeof value.f !== 'string' || !GLB_FILE_RE.test(value.f)) {
            throw new Error(`gltf-model-map.${key}: bad file "${value.f}"`);
        }
        const height = Number(value.h);
        if (!Number.isFinite(height) || height < HEIGHT_MIN || height > HEIGHT_MAX) {
            throw new Error(`gltf-model-map.${key}: height ${value.h} outside [${HEIGHT_MIN}, ${HEIGHT_MAX}]`);
        }
        const mapped = { file: value.f, height: round2(height) };
        if (value.np != null) {
            const np = Number(value.np);
            if (!Number.isFinite(np) || np < NAMEPLATE_MIN || np > NAMEPLATE_MAX) {
                throw new Error(`gltf-model-map.${key}: nameplateY ${value.np} outside [${NAMEPLATE_MIN}, ${NAMEPLATE_MAX}]`);
            }
            mapped.nameplateY = round2(np);
        }
        map.set(key, mapped);
    }
    return map;
}

function buildEntry(monster, overrides, gltfMap) {
    const override = overrides[monster.index] || {};
    const mapped = gltfMap.get(monster.index);
    const sizeUnits = SIZE_UNITS[monster.size];
    if (!sizeUnits) throw new Error(`${monster.index}: unknown size "${monster.size}"`);

    if (mapped) {
        if (override.plan != null || override.params != null || override.variants != null) {
            throw new Error(`${monster.index}: plan/params/variants overrides do not apply to a GLB-mapped monster`);
        }
        const height = round2(override.height != null ? Number(override.height) : mapped.height);
        const nameplateRaw = override.nameplateY != null ? Number(override.nameplateY)
            : mapped.nameplateY != null ? mapped.nameplateY
            : height + 0.42;
        const nameplateY = round2(Math.max(NAMEPLATE_MIN, Math.min(NAMEPLATE_MAX, nameplateRaw)));
        return {
            index: monster.index,
            name: monster.name,
            kind: 'gltf',
            url: `/assets/monsters/glbs/${mapped.file}`,
            height,
            nameplateY,
            provenance: { size: monster.size, type: monster.type, rule: `gltf:${mapped.file}` }
        };
    }

    const type = baseType(monster.type);
    const classified = classify(monster);
    const planName = typeof override.plan === 'string' ? override.plan : classified.plan;
    if (!PLAN_NAMES.includes(planName)) {
        throw new Error(`${monster.index}: unknown plan "${planName}"`);
    }

    const params = { ...classified.params };
    const overrideParams = override.params && typeof override.params === 'object' ? override.params : null;
    if (overrideParams) {
        for (const [key, value] of Object.entries(overrideParams)) {
            if (key === 'colors') continue; // merged separately below
            params[key] = value;
        }
    }
    params.colors = {
        ...paletteFor(monster, type),
        ...(overrideParams && overrideParams.colors && typeof overrideParams.colors === 'object'
            ? overrideParams.colors
            : {})
    };

    const height = round2(override.height != null ? Number(override.height) : sizeUnits * PLAN_FACTOR[planName]);
    const nameplateRaw = override.nameplateY != null ? Number(override.nameplateY) : height + 0.42;
    const nameplateY = round2(Math.max(NAMEPLATE_MIN, Math.min(NAMEPLATE_MAX, nameplateRaw)));

    const entry = {
        index: monster.index,
        name: monster.name,
        kind: 'procedural',
        plan: planName,
        height,
        nameplateY,
        params,
        provenance: { size: monster.size, type: monster.type, rule: classified.rule }
    };
    if (Array.isArray(override.variants)) entry.variants = override.variants;
    return entry;
}

function validate(entries, monsters, overrides) {
    const known = new Set(monsters.map(monster => monster.index));
    const problems = [];
    for (const key of Object.keys(overrides)) {
        if (!known.has(key)) problems.push(`overrides key "${key}" has no SRD monster`);
    }
    if (entries.length !== monsters.length) {
        problems.push(`expected ${monsters.length} entries, built ${entries.length}`);
    }
    for (const entry of entries) {
        const id = entry.index;
        if (!(entry.height >= HEIGHT_MIN && entry.height <= HEIGHT_MAX)) {
            problems.push(`${id}: height ${entry.height} outside [${HEIGHT_MIN}, ${HEIGHT_MAX}]`);
        }
        if (!(entry.nameplateY >= NAMEPLATE_MIN && entry.nameplateY <= NAMEPLATE_MAX)) {
            problems.push(`${id}: nameplateY ${entry.nameplateY} outside [${NAMEPLATE_MIN}, ${NAMEPLATE_MAX}]`);
        }
        if (entry.kind === 'gltf') {
            if (entry.plan != null || entry.params != null || entry.variants != null) {
                problems.push(`${id}: gltf entry must not carry plan/params/variants`);
            }
            const url = typeof entry.url === 'string' ? entry.url : '';
            if (!GLB_URL_RE.test(url)) {
                problems.push(`${id}: bad gltf url ${entry.url}`);
            } else if (!existsSync(join(GLB_DIR, url.slice(url.lastIndexOf('/') + 1)))
                || statSync(join(GLB_DIR, url.slice(url.lastIndexOf('/') + 1))).size <= 1000) {
                problems.push(`${id}: GLB missing or implausibly small: ${url}`);
            }
            if (!/^gltf:[a-z0-9-]+\.glb$/i.test(entry.provenance.rule || '')) {
                problems.push(`${id}: bad gltf provenance rule ${entry.provenance.rule}`);
            }
        } else if (entry.kind === 'procedural') {
            if (!PLAN_NAMES.includes(entry.plan)) problems.push(`${id}: bad plan ${entry.plan}`);
            for (const [key, value] of Object.entries(entry.params.colors)) {
                if (!HEX_COLOR.test(value)) problems.push(`${id}: colors.${key} "${value}" is not 6-digit hex`);
            }
            if (entry.variants) {
                const seen = new Set();
                for (const variant of entry.variants) {
                    if (!variant || typeof variant.id !== 'string' || !VARIANT_ID.test(variant.id)) {
                        problems.push(`${id}: bad variant id ${variant && variant.id}`);
                    } else if (seen.has(variant.id)) {
                        problems.push(`${id}: duplicate variant id ${variant.id}`);
                    }
                    seen.add(variant && variant.id);
                }
            }
        } else {
            problems.push(`${id}: unknown kind "${entry.kind}"`);
        }
    }
    if (problems.length) {
        throw new Error(`manifest validation failed:\n  ${problems.join('\n  ')}`);
    }

    // Spare GLBs are allowed (a pool for future mappings) — just say so.
    if (existsSync(GLB_DIR)) {
        const referenced = new Set(entries
            .filter(entry => entry.kind === 'gltf')
            .map(entry => entry.url.slice(entry.url.lastIndexOf('/') + 1)));
        const orphans = readdirSync(GLB_DIR).filter(name => name.endsWith('.glb') && !referenced.has(name));
        if (orphans.length) {
            console.warn(`gltf-model-map leaves ${orphans.length} GLB(s) unreferenced (kept): ${orphans.join(', ')}`);
        }
    }
}

// One line per monster so git diffs stay reviewable.
function serialize(entries) {
    const rows = entries.map(entry => `${JSON.stringify(entry.index)}: ${JSON.stringify(entry)}`);
    return `{
  "version": 1,
  "generator": "tools/gen-monster-manifest.mjs",
  "count": ${entries.length},
  "monsters": {
${rows.map((row, index) => `    ${row}${index < rows.length - 1 ? ',' : ''}`).join('\n')}
  }
}
`;
}

function main() {
    const monsters = JSON.parse(readFileSync(SRD_PATH, 'utf8'));
    if (!Array.isArray(monsters)) throw new Error('data/srd/monsters.json must be a JSON array');

    const overrides = loadOverrides();
    const gltfMap = loadGltfMap(monsters);
    const entries = monsters.map(monster => buildEntry(monster, overrides, gltfMap));
    validate(entries, monsters, overrides);
    const json = serialize(entries);

    if (CHECK_ONLY) {
        const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : '';
        if (current !== json) {
            console.error('public/assets/monsters/manifest.json is stale — run: node tools/gen-monster-manifest.mjs');
            process.exit(1);
        }
        console.log(`manifest.json is up to date (${entries.length} monsters).`);
        return;
    }

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, json, 'utf8');

    const plans = new Map();
    for (const entry of entries) {
        if (entry.kind !== 'procedural') continue;
        plans.set(entry.plan, (plans.get(entry.plan) || 0) + 1);
    }
    const summary = [...plans.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([planName, count]) => `${planName} ${count}`)
        .join(', ');
    const gltfCount = entries.length - [...plans.values()].reduce((sum, count) => sum + count, 0);
    const withVariants = entries.filter(entry => entry.variants).length;
    console.log(`wrote public/assets/monsters/manifest.json — ${entries.length} monsters, ${withVariants} with variants`);
    console.log(`  gltf: ${gltfCount} mapped to vendored GLBs, ${entries.length - gltfCount} procedural`);
    console.log(`  plans: ${summary}`);
}

main();
