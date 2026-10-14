// Areas that linger in a fight (Moonbeam, Spirit Guardians) and the lights a
// spell puts on creatures: the kit schema and the server ruling.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const kit = require('../lib/combat-kit.cjs');

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

test('kit: lingering areas and spell lights are rebuilt', () => {
  const [beam, light, plain] = kit.normalizeSpells([
    { name: 'Moonbeam', level: 2, damage: '2d10', damageType: 'radiant', saveAbility: 'con', saveSuccess: 'half', area: 'cylinder', areaFt: 5, rangeFt: 120, zone: { on: 'both', follow: 'yes' }, concentration: true },
    { name: 'Light', level: 0, light: { bright: 20, dim: 20, dark: 0 }, maxTargets: 1 },
    { name: 'Odd', level: 0, damage: '1d6', zone: { on: 'both' }, light: { bright: 0 } }
  ]);
  assert.deepEqual(beam.zone, { on: 'both' });
  assert.deepEqual(light.light, { bright: 20, dim: 20, dark: 0 });
  assert.equal(light.damage, '');
  assert.equal(light.maxTargets, 1);
  assert.equal(plain.zone, undefined, 'only a save spell can linger');
  assert.equal(plain.light, undefined);

  const aim = { kind: 'cylinder', size: 1, width: 0, origin: { x: 0, z: 0 }, center: { x: 6, z: 0 }, dir: { x: 1, z: 0 } };
  const zones = kit.normalizeZones([
    { id: 'z1', sourceId: 'a', sourceName: 'Mira', name: 'Moonbeam', aim, on: 'both', saveAbility: 'con', dc: 15, damage: '2d10', damageType: 'radiant', touched: ['b', 'ghost'], held: true },
    { id: 'z2', sourceId: 'gone', name: 'Lost', aim },
    { id: 'z3', sourceId: 'a', name: 'Bad', aim: { kind: 'blob' } }
  ], ['a', 'b']);
  assert.equal(zones.length, 1);
  assert.deepEqual(zones[0].touched, ['b']);
  assert.equal(zones[0].held, true);
  assert.deepEqual(zones[0].aim.center, { x: 6, z: 0 });
  assert.deepEqual(kit.normalizeConcentration({ name: 'Darkness', lights: ['t1', 7, ''] }).lights, ['t1']);
});

test('an area lingers and catches who starts a turn in it or walks in; spell lights follow concentration', { timeout: 60000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-zone-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(saveDir, { recursive: true, force: true });
  });
  instance = await startServer(saveDir);
  const gm = await connect(instance.port);
  await gm.request('login', 'GM', 'login-success');
  await gm.wait('map-state');
  const character = await gm.request('save-character', {
    username: 'GM',
    charData: { name: 'Mira', race: 'human', classes: [{ class: 'druid', level: 5 }], abilities: { str: 8, dex: 14, con: 12, int: 10, wis: 16, cha: 10 } }
  }, 'character-saved-success');
  const mira = await gm.request('add-object', { type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } }, 'object-added');
  const inside = await gm.request('add-object', { type: 'token', name: 'Goblin Inside', position: { x: 6, y: 0.1, z: 0 } }, 'object-added');
  const walker = await gm.request('add-object', { type: 'token', name: 'Goblin Walker', position: { x: 12, y: 0.1, z: 0 } }, 'object-added');
  const until = async (event, payload, shows) => {
    await gm.emit(event, payload);
    for (;;) {
      const state = await gm.wait('combat-updated');
      if (state && shows(state)) return state;
    }
  };
  const hp = (state, token) => state.combatants[token.id].hp.current;
  await gm.request('combat-start', null, 'combat-updated');
  await until('combat-set-stats', {
    combatantId: mira.id, ac: 12, speedFeet: 30, initMod: 2, maxHP: 30, spellDC: 30, spellAtk: 5, saves: { con: 30 },
    spells: [
      { name: 'Moonbeam', level: 0, damage: '2d10', damageType: 'radiant', saveAbility: 'con', saveSuccess: 'half', area: 'cylinder', areaFt: 5, rangeFt: 120, zone: { on: 'both' }, concentration: true },
      { name: 'Light', level: 0, light: { bright: 20, dim: 20, dark: 0 }, maxTargets: 1 },
      { name: 'Darkness', level: 0, light: { bright: 0, dim: 0, dark: 15 }, maxTargets: 1, concentration: true }
    ]
  }, state => state.combatants[mira.id].statsPending === false);
  await until('combat-begin', {}, state => state.started);
  const myTurn = () => until('combat-set-turn', { combatantId: mira.id }, state => state.activeId === mira.id && state.combatants[mira.id].actionUsed === false);
  await myTurn();

  // Cast: the area stays, nobody saves yet.
  let combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 6, z: 0 } },
    state => Array.isArray(state.zones));
  assert.equal(combat.zones.length, 1);
  assert.equal(combat.zones[0].name, 'Moonbeam');
  assert.equal(combat.zones[0].held, true);
  assert.deepEqual(combat.zones[0].aim.center, { x: 6, z: 0 });
  assert.equal(combat.pending, undefined);
  assert.equal(hp(combat, inside), 10);
  assert.match(combat.log.find(entry => /casts Moonbeam/.test(entry.text)).text, /the area stays/);

  // Starting a turn in it: the save is owed at once (DC 30 cannot be made).
  combat = await until('combat-set-turn', { combatantId: inside.id }, state => state.activeId === inside.id);
  assert.ok(hp(combat, inside) < 10, 'the goblin standing in the beam is burned');
  assert.ok(combat.log.some(entry => /Moonbeam \(lingering\)/.test(entry.text)));
  assert.equal(hp(combat, walker), 10);

  // Walking through it, even without stopping there — but once a turn only.
  await until('combat-set-turn', { combatantId: walker.id }, state => state.activeId === walker.id);
  await gm.emit('move-object', { id: walker.id, position: { x: 3, y: 0.1, z: 0 } });
  for (;;) { combat = await gm.wait('combat-updated'); if (hp(combat, walker) < 10) break; }
  const burned = hp(combat, walker);
  if (burned > 0) {
    await gm.emit('move-object', { id: walker.id, position: { x: 12, y: 0.1, z: 0 } });
    for (;;) { combat = await gm.wait('combat-updated'); if (combat.combatants[walker.id].movementUsedFeet > 60) break; }
    assert.equal(hp(combat, walker), burned, 'the same turn does not burn twice');
  }

  // The area is held by concentration: letting go removes it.
  combat = await until('combat-concentration', { combatantId: mira.id }, state => !state.combatants[mira.id].concentration);
  assert.equal(combat.zones, undefined);

  // Light sits on the creature picked; Darkness is held and ends with the spell.
  await myTurn();
  gm.drop('object-updated');
  await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 1, targetIds: [inside.id] }, state => state.combatants[mira.id].actionUsed === true);
  let lit = await gm.wait('object-updated');
  assert.equal(lit.id, inside.id);
  assert.deepEqual(lit.patch.light, { bright: 20, dim: 20, dark: 0 });
  await myTurn();
  combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 2, targetIds: [] },
    state => (state.combatants[mira.id].concentration || {}).name === 'Darkness');
  assert.deepEqual(combat.combatants[mira.id].concentration.lights, [mira.id]);
  lit = await gm.wait('object-updated');
  assert.deepEqual(lit.patch.light, { bright: 0, dim: 0, dark: 15 });
  await until('combat-concentration', { combatantId: mira.id }, state => !state.combatants[mira.id].concentration);
  lit = await gm.wait('object-updated');
  assert.equal(lit.id, mira.id);
  assert.equal(lit.patch.light, null);
});
