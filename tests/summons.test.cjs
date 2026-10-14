// What a spell leaves on the map for its caster to move about (Mage Hand,
// Spiritual Weapon): the kit schema and the server ruling, in and out of a fight.

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

test('kit: a summoning spell is rebuilt', () => {
  const [hand, weapon, odd] = kit.normalizeSpells([
    { name: 'Mage Hand', level: 0, summon: { kind: 'hand', leashFt: 30, moveFt: 30, strike: 'yes' }, rangeFt: 30, damage: '9d9' },
    { name: 'Spiritual Weapon', level: 2, damage: '1d8+3', damageType: 'force', summon: { kind: 'weapon', moveFt: 20, strike: true, light: { dim: 5 } }, rangeFt: 60, time: 'bonus', rounds: 10 },
    { name: 'Odd', level: 0, summon: { kind: 'dragon' } }
  ]);
  assert.deepEqual(hand.summon, { kind: 'hand', leashFt: 30, moveFt: 30 });
  assert.equal(hand.damage, '');
  assert.equal(hand.attackType, undefined, 'nothing is rolled when it is cast');
  assert.deepEqual(weapon.summon, { kind: 'weapon', leashFt: 0, moveFt: 20, strike: true, light: { bright: 0, dim: 5, dark: 0 } });
  assert.equal(weapon.damage, '1d8+3');
  assert.equal(weapon.rounds, 10);
  assert.equal(weapon.time, 'bonus');
  assert.equal(odd.summon, undefined);
  assert.equal(kit.normalizeSummon({ kind: 'disk', leashFt: 9999 }).leashFt, 600);
});

test('in a fight a summon is set down, moved within its rules, strikes, and goes with its spell', { timeout: 60000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-summon-'));
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
    charData: { name: 'Mira', race: 'human', classes: [{ class: 'cleric', level: 5 }], abilities: { str: 8, dex: 14, con: 12, int: 10, wis: 16, cha: 10 } }
  }, 'character-saved-success');
  const mira = await gm.request('add-object', { type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } }, 'object-added');
  const goblin = await gm.request('add-object', { type: 'token', name: 'Goblin', position: { x: 7, y: 0.1, z: 0 } }, 'object-added');
  const until = async (event, payload, shows) => {
    await gm.emit(event, payload);
    for (;;) {
      const state = await gm.wait('combat-updated');
      if (state && shows(state)) return state;
    }
  };
  const summoned = async (spell) => {
    for (;;) { const object = await gm.wait('object-added'); if (object.type === 'summon' && object.spell === spell) return object; }
  };
  await gm.request('combat-start', null, 'combat-updated');
  await until('combat-set-stats', {
    combatantId: mira.id, ac: 12, speedFeet: 30, initMod: 2, maxHP: 30, spellDC: 14, spellAtk: 30,
    spells: [
      { name: 'Mage Hand', level: 0, summon: { kind: 'hand', leashFt: 30, moveFt: 30 }, rangeFt: 30 },
      { name: 'Spiritual Weapon', level: 0, damage: '1d2', damageType: 'force', summon: { kind: 'weapon', moveFt: 20, strike: true }, rangeFt: 60, time: 'bonus', rounds: 10 },
      { name: 'Unseen Servant', level: 0, summon: { kind: 'servant', leashFt: 60, moveFt: 15 }, rangeFt: 60, concentration: true }
    ]
  }, state => state.combatants[mira.id].statsPending === false);
  await until('combat-begin', {}, state => state.started);
  const myTurn = () => until('combat-set-turn', { combatantId: mira.id }, state => state.activeId === mira.id && state.combatants[mira.id].actionUsed === false && state.combatants[mira.id].bonusUsed === false);
  await myTurn();

  // Out of reach: refused, nothing is spent.
  assert.match((await gm.request('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 20, z: 0 } }, 'combat-denied')).reason, /Mage Hand reaches 30 ft/);

  // Mage Hand: an object of its own, the caster's to move — not a combatant.
  gm.drop('object-added');
  let combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 4, z: 0 } }, state => state.combatants[mira.id].actionUsed === true);
  const hand = await summoned('Mage Hand');
  assert.equal(hand.kind, 'hand');
  assert.equal(hand.casterId, mira.id);
  assert.equal(hand.owner, 'GM');
  assert.deepEqual([hand.position.x, hand.position.z], [4, 0]);
  assert.equal(combat.combatants[hand.id], undefined);
  assert.match(combat.log.find(entry => /casts Mage Hand/.test(entry.text)).fx.form, /aura/);

  // Spiritual Weapon: a bonus action; its strike is free on the turn it is cast.
  combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 1, aim: { x: 6, z: 0 } }, state => state.combatants[mira.id].bonusUsed === true);
  const weapon = await summoned('Spiritual Weapon');
  assert.equal(weapon.until, combat.round + 10);
  assert.match((await gm.request('combat-action', { combatantId: mira.id, kind: 'strike', summonId: hand.id, targetId: goblin.id }, 'combat-denied')).reason, /Nothing to strike with/);
  combat = await until('combat-action', { combatantId: mira.id, kind: 'strike', summonId: weapon.id, targetId: goblin.id },
    state => state.log.some(entry => /Spiritual Weapon strikes at Goblin/.test(entry.text)));
  const struck = combat.log.find(entry => /Spiritual Weapon strikes at Goblin/.test(entry.text));
  assert.equal(struck.fx.actor, weapon.id);
  assert.equal(struck.roll.mod, 30);
  if (struck.roll.hit) assert.ok(combat.combatants[goblin.id].hp.current < 10);
  assert.match((await gm.request('combat-action', { combatantId: mira.id, kind: 'strike', summonId: weapon.id, targetId: goblin.id }, 'combat-denied')).reason, /Bonus action already used/);

  // Next turn the strike is the bonus action, and only within 5 ft of the weapon.
  await myTurn();
  await gm.emit('move-object', { id: weapon.id, position: { x: 2, y: 0, z: 0 } });
  assert.match((await gm.request('combat-action', { combatantId: mira.id, kind: 'strike', summonId: weapon.id, targetId: goblin.id }, 'combat-denied')).reason, /not within 5 ft/);
  await gm.emit('move-object', { id: weapon.id, position: { x: 6, y: 0, z: 0 } });
  combat = await until('combat-action', { combatantId: mira.id, kind: 'strike', summonId: weapon.id, targetId: goblin.id }, state => state.combatants[mira.id].bonusUsed === true);

  // Cast again: the old hand goes, a new one stands where it was aimed.
  gm.drop('object-deleted'); gm.drop('object-added');
  await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, aim: { x: 1, z: 3 } }, state => state.combatants[mira.id].actionUsed === true);
  assert.equal((await gm.wait('object-deleted')).id, hand.id);
  const second = await summoned('Mage Hand');
  assert.deepEqual([second.position.x, second.position.z], [1, 3]);

  // A held summon goes when concentration does.
  await myTurn();
  gm.drop('object-added');
  await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 2, aim: { x: 2, z: 2 } }, state => (state.combatants[mira.id].concentration || {}).name === 'Unseen Servant');
  const servant = await summoned('Unseen Servant');
  assert.equal(servant.held, true);
  gm.drop('object-deleted');
  await until('combat-concentration', { combatantId: mira.id }, state => !state.combatants[mira.id].concentration);
  assert.equal((await gm.wait('object-deleted')).id, servant.id);

  // The caster leaves the map: what it summoned goes too.
  gm.drop('object-deleted');
  await gm.emit('delete-object', { id: mira.id });
  const gone = new Set();
  while (gone.size < 3) gone.add((await gm.wait('object-deleted')).id);
  assert.ok(gone.has(mira.id) && gone.has(second.id) && gone.has(weapon.id));
});

test('outside a fight a summon is asked for, belongs to its player, and stays on its leash', { timeout: 40000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-summon2-'));
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
  const bea = await connect(instance.port);
  await bea.request('login', 'Bea', 'login-success');
  await bea.wait('map-state');
  const character = await ana.request('save-character', {
    username: 'Ana',
    charData: { name: 'Mira', race: 'human', classes: [{ class: 'wizard', level: 3 }], abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 } }
  }, 'character-saved-success');
  const mira = await ana.request('add-object', { type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } }, 'object-added');

  // Nobody conjures one by hand.
  await gm.emit('add-object', { type: 'summon', kind: 'hand', position: { x: 1, y: 0, z: 1 } });
  assert.match(await gm.wait('error'), /Unknown object type/);

  gm.drop('cast-requests');
  await ana.emit('cast-request', {
    charId: character.id, tokenId: mira.id, spell: 'Mage Hand', level: 0,
    roll: { label: 'casts Mage Hand', note: 'a spectral hand' }, form: 'aura',
    summon: { kind: 'hand', leashFt: 30, moveFt: 30 },
    aim: { shape: { kind: 'sphere', sizeFt: 3, rangeFt: 30 }, point: { x: 3, z: 0 } }
  });
  let list;
  for (;;) { list = (await gm.wait('cast-requests')).requests; if (list.length === 1) break; }
  assert.deepEqual(list[0].summon, { kind: 'hand', leashFt: 30, moveFt: 30 });
  ana.drop('object-added'); gm.drop('object-added');
  await gm.emit('resolve-cast', { id: list[0].id, approve: true });
  const hand = await ana.wait('object-added');
  assert.equal(hand.type, 'summon');
  assert.equal(hand.owner, 'Ana');
  assert.deepEqual([hand.position.x, hand.position.z], [3, 0]);
  assert.equal((await gm.wait('object-added')).id, hand.id);

  // Its player moves it; nobody else does, and not past the leash.
  assert.match((await bea.request('move-object', { id: hand.id, position: { x: 4, y: 0, z: 0 } }, 'combat-denied')).reason, /only move your own/);
  gm.drop('object-moved');
  await ana.emit('move-object', { id: hand.id, position: { x: 5, y: 0, z: 1 } });
  assert.deepEqual((await gm.wait('object-moved')).position, { x: 5, y: 0, z: 1 });
  assert.match((await ana.request('move-object', { id: hand.id, position: { x: 9, y: 0, z: 0 } }, 'combat-denied')).reason, /cannot go more than 30 ft from Mira/);

  // The caster walks away: beyond the leash it is gone.
  gm.drop('object-deleted');
  await ana.emit('move-object', { id: mira.id, position: { x: -6, y: 0.1, z: 0 } });
  assert.equal((await gm.wait('object-deleted')).id, hand.id);

  // Again, and this time its player dismisses it.
  gm.drop('cast-requests'); ana.drop('object-added');
  await ana.emit('cast-request', {
    charId: character.id, tokenId: mira.id, spell: 'Mage Hand', level: 0, roll: { label: 'casts Mage Hand' },
    summon: { kind: 'hand', leashFt: 30, moveFt: 30 }
  });
  for (;;) { list = (await gm.wait('cast-requests')).requests; if (list.length === 1) break; }
  await gm.emit('resolve-cast', { id: list[0].id, approve: true });
  const again = await ana.wait('object-added');
  assert.deepEqual([again.position.x, again.position.z], [-5, 0], 'no aim: beside the caster');
  gm.drop('object-deleted');
  await bea.emit('delete-object', { id: again.id });
  await ana.emit('delete-object', { id: again.id });
  assert.equal((await gm.wait('object-deleted')).id, again.id);
});
