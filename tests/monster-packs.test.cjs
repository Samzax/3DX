// Monster model packs: pack.json sanitizing (lib/monster-packs.cjs). Packs are
// uncommitted user data, so everything they declare is treated as hostile.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { loadMonsterPacks } = require('../lib/monster-packs.cjs');

function makePacks(packs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-packs-'));
    for (const [id, { json, files = [] }] of Object.entries(packs)) {
        fs.mkdirSync(path.join(dir, id));
        if (json !== undefined) {
            fs.writeFileSync(path.join(dir, id, 'pack.json'), typeof json === 'string' ? json : JSON.stringify(json));
        }
        for (const file of files) fs.writeFileSync(path.join(dir, id, file), 'glb');
    }
    return dir;
}

const BASE = { 'adult-red-dragon': { plan: 'dragon', height: 3.42 } };

test('a missing packs folder yields nothing', () => {
    const result = loadMonsterPacks(path.join(os.tmpdir(), '3dx-no-such-packs-dir'), BASE);
    assert.deepEqual(Object.keys(result.entries), []);
    assert.deepEqual(result.warnings, []);
});

test('templates merge into monsters and produce sanitized gltf entries', () => {
    const dir = makePacks({
        dragons: {
            files: ['red.glb', 'clips.glb'],
            json: {
                name: 'Dragons',
                templates: {
                    red: {
                        file: 'red.glb', animations: 'clips.glb',
                        clips: { idle: 'Idle', breath: 'Breath', nonsense: 'X', bite: '<script>' },
                        actions: { 'Fire Breath': 'breath', Bite: 'not-a-role' },
                        breath: { socket: 'Mouth', shape: 'cone', color: '#FF7A1F', at: 0.4, extra: 1 }
                    }
                },
                monsters: {
                    'Adult-Red-Dragon': { template: 'red' },
                    'red-dragon-wyrmling': { template: 'red', height: 1.1, proportions: { Head: 1.3, Tail: 99, 'Wing.L': 0.8 } }
                }
            }
        }
    });
    const result = loadMonsterPacks(dir, BASE);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.packs, [{ id: 'dragons', name: 'Dragons', count: 2 }]);

    const adult = result.entries['adult-red-dragon'];
    assert.deepEqual(adult, {
        index: 'adult-red-dragon', kind: 'gltf', plan: 'dragon', pack: 'dragons',
        url: '/packs/dragons/red.glb', height: 3.42, // inherited from the committed manifest
        animUrl: '/packs/dragons/clips.glb',
        clips: { idle: 'Idle', breath: 'Breath' },
        actions: { 'fire breath': 'breath' },
        breath: { socket: 'Mouth', shape: 'cone', color: '#ff7a1f', at: 0.4 }
    });
    const wyrmling = result.entries['red-dragon-wyrmling'];
    assert.equal(wyrmling.height, 1.1);
    assert.equal(wyrmling.plan, 'pack');
    assert.deepEqual(wyrmling.proportions, { Head: 1.3, 'Wing.L': 0.8 });
});

test('bad packs and entries are skipped with a warning, never thrown', () => {
    const dir = makePacks({
        'Bad Name': { json: { monsters: {} } },
        broken: { json: '{ not json' },
        empty: { json: { name: 'x' } },
        nojson: {},
        mixed: {
            files: ['ok.glb'],
            json: {
                monsters: {
                    'traversal': { file: '../ok.glb', height: 1 },
                    'slashes': { file: 'sub/ok.glb', height: 1 },
                    'missing-file': { file: 'gone.glb', height: 1 },
                    'no-height': { file: 'ok.glb' },
                    'bad-template': { template: 'nope', height: 1 },
                    'proto': { template: '__proto__', height: 1 },
                    'bad index!': { file: 'ok.glb', height: 1 },
                    'fine': { file: 'ok.glb', height: 2, nameplateY: 500 }
                }
            }
        }
    });
    const result = loadMonsterPacks(dir, BASE);
    assert.deepEqual(Object.keys(result.entries), ['fine']);
    assert.equal(result.entries.fine.nameplateY, undefined);
    assert.equal(result.warnings.length, 10);
    assert.ok(!('nojson' in result.entries));
});

test('airborne clip roles and a stage tint pass through', () => {
    const dir = makePacks({
        d: {
            files: ['m.glb'],
            json: { monsters: {
                'ancient-red-dragon': { file: 'm.glb', height: 4, tint: '#CFA8A4', clips: { fly: 'Fly', fly_breath: 'FlyBreath', fly_idle: 'Nope' } },
                'young-red-dragon': { file: 'm.glb', height: 2, tint: 'red' }
            } }
        }
    });
    const { entries } = loadMonsterPacks(dir, {});
    assert.equal(entries['ancient-red-dragon'].tint, '#cfa8a4');
    assert.deepEqual(entries['ancient-red-dragon'].clips, { fly: 'Fly', fly_breath: 'FlyBreath' });
    assert.equal(entries['young-red-dragon'].tint, undefined);
});

test('later packs win a contested monster', () => {
    const dir = makePacks({
        a: { files: ['a.glb'], json: { monsters: { goblin: { file: 'a.glb', height: 1 } } } },
        b: { files: ['b.glb'], json: { monsters: { goblin: { file: 'b.glb', height: 1 } } } }
    });
    assert.equal(loadMonsterPacks(dir, {}).entries.goblin.url, '/packs/b/b.glb');
});
