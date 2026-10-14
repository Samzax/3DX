// Aimed areas and the saving throws they cause: the pure shape model
// (public/js/shared/aoe.js), the kit's schema for spells / save modifiers /
// pending saves (lib/combat-kit.cjs), and the real server ruling on who a
// burst catches and who rolls which save.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const kit = require('../lib/combat-kit.cjs');
const loadAoe = () => import(pathToFileURL(path.join(repoRoot, 'public/js/shared/aoe.js')).href);

test('shapes: who stands in a sphere, a cone, a line, a cube and an aura', async () => {
  const aoe = await loadAoe();
  const caster = { x: 0, z: 0 };
  const ids = (shape, point, creatures, options) =>
    aoe.caughtIn(aoe.resolveAim(shape, caster, point), creatures, options);
  const row = [1, 2, 3, 4, 5, 6].map(x => ({ id: `c${x}`, x, z: 0 }));

  // 20 ft sphere thrown 30 ft out (6 units): radius 4 units around x = 6.
  const ball = { kind: 'sphere', sizeFt: 20, rangeFt: 150 };
  assert.deepEqual(ids(ball, { x: 6, z: 0 }, row), ['c2', 'c3', 'c4', 'c5', 'c6']);
  // Beyond the range the burst is pulled back to it.
  const short = aoe.resolveAim({ kind: 'sphere', sizeFt: 5, rangeFt: 10 }, caster, { x: 50, z: 0 });
  assert.equal(short.clamped, true);
  assert.deepEqual(short.center, { x: 2, z: 0 });
  // The caster stands in its own fireball when it is dropped close.
  assert.ok(ids(ball, { x: 1, z: 0 }, [{ id: 'me', x: 0, z: 0 }]).includes('me'));

  // 15 ft cone toward +x: 3 units long, as wide as it is long.
  const cone = { kind: 'cone', sizeFt: 15 };
  const spread = [
    { id: 'near', x: 1, z: 0 }, { id: 'edge', x: 2, z: 1 }, { id: 'wide', x: 1, z: 1 },
    { id: 'far', x: 4, z: 0 }, { id: 'behind', x: -1, z: 0 }
  ];
  assert.deepEqual(ids(cone, { x: 9, z: 0 }, spread), ['near', 'edge']);
  // …and it swings with the aim.
  assert.deepEqual(ids(cone, { x: -5, z: 0 }, spread), ['behind']);

  // 30 ft line, 5 ft wide.
  const line = { kind: 'line', sizeFt: 30 };
  assert.deepEqual(ids(line, { x: 1, z: 0 }, [...row, { id: 'beside', x: 2, z: 1 }, { id: 'past', x: 7, z: 0 }]),
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);

  // A 15 ft cube with no range is pushed out in front of the caster.
  const cube = aoe.resolveAim({ kind: 'cube', sizeFt: 15 }, caster, { x: 0, z: 9 });
  assert.deepEqual(cube.center, { x: 0, z: 1.5 });
  assert.equal(aoe.inArea(cube, 1, 3), true);
  assert.equal(aoe.inArea(cube, 2, 1), false);

  // An aura spares its source when the caller says so, and walls give cover.
  const aura = { kind: 'self', sizeFt: 10 };
  const crowd = [{ id: 'me', x: 0, z: 0 }, { id: 'a', x: 1, z: 1 }, { id: 'b', x: 2, z: 0 }, { id: 'c', x: 3, z: 0 }];
  assert.deepEqual(ids(aura, null, crowd, { exclude: 'me' }), ['a', 'b']);
  assert.deepEqual(ids(aura, null, crowd, { exclude: 'me', blocked: (source, creature) => creature.id === 'a' }), ['b']);

  // Outlines are closed rings in world space; a single target has none.
  assert.equal(aoe.outline(aoe.resolveAim(ball, caster, { x: 6, z: 0 })).length, 48);
  assert.equal(aoe.outline(aoe.resolveAim(line, caster, { x: 1, z: 0 })).length, 4);
  assert.equal(aoe.outline(aoe.resolveAim({ kind: 'single' }, caster, caster)).length, 0);
  assert.equal(aoe.shapeNeedsPoint(aoe.normalizeShape(ball)), true);
  assert.equal(aoe.shapeNeedsPoint(aoe.normalizeShape({ kind: 'cone', sizeFt: 0 })), false);
  assert.equal(aoe.describeShape(ball), '20 ft radius');
  assert.equal(aoe.describeShape(cone), '15 ft cone');
});

test('kit: spells keep their area, save modifiers and pending saves are rebuilt', () => {
  const [ball, bolt] = kit.normalizeSpells([
    { name: 'Fireball', level: 3, damage: '8d6', damageType: 'fire', saveAbility: 'dex', saveSuccess: 'half',
      area: 'sphere', areaFt: 20, rangeFt: 150, bySlot: { 4: '9d6', 5: 'rm -rf' }, junk: true },
    { name: 'Fire Bolt', damage: '1d10', attackType: 'ranged', area: 'banana', rangeFt: 120 }
  ]);
  assert.deepEqual(ball, {
    name: 'Fireball', level: 3, damage: '8d6', damageType: 'fire', spellIndex: 0, bySlot: { 4: '9d6' },
    saveAbility: 'dex', saveSuccess: 'half', rangeFt: 150, area: 'sphere', areaFt: 20
  });
  assert.equal(bolt.area, undefined);
  assert.equal(bolt.attackType, 'ranged');

  assert.deepEqual(kit.normalizeSaveMods({ advantage: ['dex', 'dex', 'luck'], bonus: 3.4, evasion: true, more: 1 }),
    { advantage: ['dex'], bonus: 3, evasion: true });
  assert.deepEqual(kit.normalizeSaveMods(null), {});

  const pending = kit.normalizePending([
    { id: 'p1', sourceId: 'hero', sourceName: 'Hero', name: 'Fireball', verb: 'casts', saveAbility: 'dex', dc: 15,
      saveSuccess: 'half', damageType: 'fire', damage: { expr: '8d6', rolls: [6, 6], total: 28 },
      targets: { a: { done: false }, b: { done: true, success: true, total: 17 }, ghost: { done: false } } },
    { id: 'p2', name: 'Done', targets: { a: { done: true, success: false, total: 3 } } },
    'junk'
  ], ['a', 'b']);
  assert.equal(pending.length, 1, 'a record with nothing left to roll is dropped');
  assert.deepEqual(Object.keys(pending[0].targets), ['a', 'b']);
  assert.deepEqual(pending[0].damage, { expr: '8d6', rolls: [6, 6], total: 28 });
});

// ---- protocol ---------------------------------------------------------------
async function startServer(dataDirectory) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  const env = { ...process.env, PORT: String(port), THREEDX_DATA_DIR: dataDirectory, THREEDX_OPEN_LOGIN: '1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (!output.includes('VTT Server Running')) {
    if (Date.now() > deadline || child.exitCode != null) throw new Error(`server did not start\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, port };
}

// Minimal Socket.IO-over-polling client.
async function connect(port) {
  const url = (sid) => `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling&t=${Math.random()}${sid ? `&sid=${sid}` : ''}`;
  const handshake = await (await fetch(url())).text();
  const sid = JSON.parse(handshake.slice(1)).sid;
  const post = async (packet) => { await fetch(url(sid), { method: 'POST', body: packet }); };
  await post('40');
  const inbox = [];
  const session = {
    emit: (event, payload) => post(`42${JSON.stringify([event, payload])}`),
    async wait(eventName, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = inbox.findIndex(([name]) => name === eventName);
        if (index >= 0) return inbox.splice(index, 1)[0][1];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventName}`);
        const response = await fetch(url(sid), { signal: AbortSignal.timeout(4000) });
        const packets = (await response.text()).split('\x1e');
        if (packets.includes('2')) await post('3');
        for (const packet of packets) {
          if (packet.startsWith('42')) inbox.push(JSON.parse(packet.slice(2)));
        }
      }
    },
    drop(eventName) { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i][0] === eventName) inbox.splice(i, 1); },
    async request(event, payload, answer) {
      session.drop(answer);
      await session.emit(event, payload);
      return session.wait(answer);
    }
  };
  return session;
}

test('a fireball is aimed, the server says who is caught, and each side rolls its own saves', { timeout: 40000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-aoe-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(saveDir, { recursive: true, force: true });
  });
  instance = await startServer(saveDir);
  const gm = await connect(instance.port);
  await gm.request('login', 'GM', 'login-success');
  await gm.wait('map-state');
  const ana = await connect(instance.port);
  await ana.request('login', 'Ana', 'login-success');
  await ana.wait('map-state');

  const character = await ana.request('save-character', {
    username: 'Ana',
    charData: { name: 'Mira', race: 'human', classes: [{ class: 'wizard', level: 5 }], abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 } }
  }, 'character-saved-success');
  const mira = await ana.request('add-object', { type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } }, 'object-added');
  await gm.wait('object-added'); // Mira's token reaches the GM before the GM adds its own
  const add = async (name, x, z) => gm.request('add-object', { type: 'token', name, position: { x, y: 0.1, z } }, 'object-added');
  const near = await add('Goblin Near', 2, 0);
  const also = await add('Goblin Also', 3, 1);
  const far = await add('Goblin Far', 30, 0);

  // Both screens hear every broadcast: read on until the state shows the step.
  const until = async (session, event, payload, shows) => {
    await session.emit(event, payload);
    for (;;) {
      const state = await session.wait('combat-updated');
      if (state && shows(state)) return state;
    }
  };
  await gm.request('combat-start', null, 'combat-updated');
  // The player's screen answers with the sheet: a fireball, and Evasion.
  await until(ana, 'combat-set-stats', {
    combatantId: mira.id, ac: 12, speedFeet: 30, initMod: 2, maxHP: 60, saves: { dex: 2 }, spellDC: 30, spellAtk: 7,
    slots: { 3: 2 },
    spells: [{ name: 'Fireball', level: 3, damage: '8d6', damageType: 'fire', saveAbility: 'dex', saveSuccess: 'half', area: 'sphere', areaFt: 20, rangeFt: 150 }],
    saveMods: { evasion: true }
  }, state => state.combatants[mira.id].statsPending === false);
  await until(gm, 'combat-update-combatant', { combatantId: mira.id, patch: { initiative: 60, hpCurrent: 60 } },
    state => state.combatants[mira.id].initiative === 60);
  let combat = await until(gm, 'combat-begin', {}, state => state.started);
  assert.equal(combat.activeId, mira.id);

  // No hand-picked victims: an area is aimed.
  const refused = await ana.request('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, targetId: far.id }, 'combat-denied');
  assert.match(refused.reason, /Aim Fireball first/);

  // Dropped at her own feet: Mira and the two close goblins are in it, the far one is not.
  combat = await until(ana, 'combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 1, z: 0 } },
    state => Array.isArray(state.pending));
  assert.equal(combat.combatants[mira.id].slots[3], 1, 'the slot is spent');
  assert.equal(combat.pending.length, 1);
  const pending = combat.pending[0];
  assert.deepEqual(Object.keys(pending.targets).sort(), [mira.id, near.id, also.id].sort());
  assert.equal(pending.targets[mira.id].done, true, 'her own save is rolled on the spot');
  assert.equal(pending.targets[near.id].done, false, 'the goblins wait for the GM');
  const announced = combat.log.find(entry => /casts Fireball/.test(entry.text));
  assert.match(announced.text, /3 caught/);
  assert.equal(announced.fx.area.kind, 'sphere');
  assert.deepEqual(announced.fx.area.center, [1, 0]);
  // DC 30 cannot be made: Evasion turns the failure into half damage.
  const total = pending.damage.total;
  assert.equal(combat.combatants[mira.id].hp.current, 60 - Math.floor(total / 2));
  assert.match(combat.log.find(entry => /Mira saves against/.test(entry.text)).text, /Evasion: half/);
  assert.equal(combat.combatants[near.id].hp.current, 10, 'nothing lands before the save');

  // The turn waits for the saves; a player cannot roll the GM's.
  assert.match((await ana.request('combat-end-turn', {}, 'combat-denied')).reason, /Saving throws are still being rolled/);
  assert.match((await ana.request('combat-save', { pendingId: pending.id, combatantId: near.id }, 'combat-denied')).reason, /No saving throw of yours/);

  // The GM rolls one, then the rest.
  combat = await until(gm, 'combat-save', { pendingId: pending.id, combatantId: near.id },
    state => state.pending && state.pending[0].targets[near.id].done);
  assert.equal(combat.combatants[near.id].hp.current, Math.max(0, 10 - total));
  assert.equal(combat.pending[0].targets[also.id].done, false);
  combat = await until(gm, 'combat-save', {}, state => !state.pending);
  assert.equal(combat.pending, undefined, 'nothing is left to roll');
  assert.equal(combat.combatants[also.id].hp.current, Math.max(0, 10 - total));
  assert.equal(combat.combatants[far.id].hp.current, 10);

  // A pending save never outlives the GM moving the fight on.
  combat = await until(gm, 'combat-set-turn', { combatantId: mira.id }, state => state.combatants[mira.id].actionUsed === false);
  combat = await until(ana, 'combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 30, z: 0 } },
    state => Array.isArray(state.pending) && !!state.pending[0].targets[far.id]);
  assert.deepEqual(Object.keys(combat.pending[0].targets), [far.id]);
  combat = await until(gm, 'combat-end-turn', {}, state => state.activeId !== mira.id);
  assert.equal(combat.pending, undefined);
  assert.ok(combat.combatants[far.id].hp.current < 10);
});
