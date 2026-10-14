// Concentration: one spell held at a time, the conditions it keeps on others,
// the CON save damage asks for (in the tracker and, outside a fight, on the
// sheet), and everything that ends it.

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

test('kit: effect spells, held concentration and its checks are rebuilt', () => {
  const [bless, hold, bolt] = kit.normalizeSpells([
    { name: 'Bless', level: 1, effect: 'blessed', maxTargets: 3, concentration: true, rounds: 10 },
    { name: 'Hold Person', level: 2, effect: 'paralyzed', saveAbility: 'wis', saveSuccess: 'none', concentration: true },
    { name: 'Fire Bolt', level: 0, damageType: 'fire' }
  ]);
  assert.deepEqual(bless, { name: 'Bless', level: 1, damage: '', damageType: '', spellIndex: 0, effect: 'blessed', concentration: true, rounds: 10, maxTargets: 3 });
  assert.equal(hold.saveAbility, 'wis');
  assert.equal(hold.attackType, undefined);
  assert.equal(hold.maxTargets, undefined);
  assert.equal(bolt.damage, '1d4', 'a spell with nothing to do still rolls something');
  assert.equal(bolt.attackType, 'ranged');

  assert.deepEqual(kit.normalizeConcentration({ name: 'Bless', effects: [{ id: 'a', key: 'blessed' }, { id: 'b', key: 'nope' }, null], until: 11 }),
    { name: 'Bless', effects: [{ id: 'a', key: 'blessed' }], until: 11 });
  assert.equal(kit.normalizeConcentration({ effects: [] }), null);
  assert.deepEqual(kit.normalizeSaveMods({ concentration: true }), { concentration: true });
  const [check] = kit.normalizePending([{ id: 'p', name: 'Bless', saveAbility: 'con', dc: 12, conc: true, targets: { a: { done: false } } }], ['a']);
  assert.equal(check.conc, true);
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

test('a held spell survives or ends by the rules, in a fight and outside one', { timeout: 60000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-conc-'));
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
  const pause = () => new Promise(resolve => setTimeout(resolve, 150)); // the roll handler's rate limit

  const character = await ana.request('save-character', {
    username: 'Ana',
    charData: { name: 'Mira', race: 'human', classes: [{ class: 'wizard', level: 5 }], abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 } }
  }, 'character-saved-success');
  const poolAfter = async (event, payload) => {
    ana.drop('pools-updated');
    await ana.emit(event, payload);
    return (await ana.wait('pools-updated')).pool;
  };

  // --- outside a fight: the sheet holds the spell, damage asks for a check
  await ana.request('update-hp', { id: character.id, current: 60 }, 'hp-updated');
  let pool = await poolAfter('roll', { actor: 'Mira', label: 'casts Fly', note: 'range touch', concentration: { charId: character.id, name: 'Fly' } });
  assert.deepEqual(pool.conc, { name: 'Fly' });
  pool = await poolAfter('update-hp', { id: character.id, current: 30 });
  assert.deepEqual(pool.conc, { name: 'Fly', dc: 15 }, 'half of 30 damage beats 10');
  assert.match((await gm.request('roll', { label: 'x', d20: { bonus: 0 }, concSave: { charId: 'nobody' } }, 'combat-denied')).reason, /Not your character/);
  await pause();
  ana.drop('roll-logged');
  pool = await poolAfter('roll', { actor: 'Mira', label: 'concentration', d20: { bonus: -20 }, concSave: { charId: character.id } });
  assert.ok(!(pool && pool.conc), 'a failed check ends the spell');
  const logged = await ana.wait('roll-logged');
  assert.equal(logged.dc, 15);
  assert.equal(logged.success, false);
  assert.match(logged.text, /concentrates on Fly/);
  await pause();
  pool = await poolAfter('roll', { actor: 'Mira', label: 'casts Fly', note: 'range touch', concentration: { charId: character.id, name: 'Fly' } });
  assert.deepEqual(pool.conc, { name: 'Fly' });

  // --- in a fight
  const mira = await ana.request('add-object', { type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } }, 'object-added');
  await gm.wait('object-added');
  const goblin = await gm.request('add-object', { type: 'token', name: 'Goblin', position: { x: 2, y: 0.1, z: 0 } }, 'object-added');
  const until = async (session, event, payload, shows) => {
    await session.emit(event, payload);
    for (;;) {
      const state = await session.wait('combat-updated');
      if (state && shows(state)) return state;
    }
  };
  const has = (state, id, key) => state.combatants[id].effects.some(effect => effect.key === key);
  await gm.request('combat-start', null, 'combat-updated');
  let combat = await until(ana, 'combat-set-stats', {
    combatantId: mira.id, ac: 12, speedFeet: 30, initMod: 2, maxHP: 60, saves: { con: -20 }, spellDC: 30, spellAtk: 7,
    slots: { 1: 3, 2: 2 },
    spells: [
      { name: 'Bless', level: 1, effect: 'blessed', maxTargets: 3, concentration: true, rounds: 10 },
      { name: 'Hold Person', level: 2, effect: 'paralyzed', saveAbility: 'wis', saveSuccess: 'none', concentration: true, rangeFt: 60 }
    ]
  }, state => state.combatants[mira.id].statsPending === false);
  assert.equal(combat.combatants[mira.id].concentration.name, 'Fly', 'she walks in holding what she held');
  await until(gm, 'combat-update-combatant', { combatantId: mira.id, patch: { initiative: 60 } },
    state => state.combatants[mira.id].initiative === 60);
  await until(gm, 'combat-begin', {}, state => state.started);

  // Bless on herself and the goblin: Fly gives way, both are blessed.
  combat = await until(ana, 'combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, targetIds: [mira.id, goblin.id] },
    state => state.combatants[mira.id].concentration && state.combatants[mira.id].concentration.name === 'Bless');
  assert.ok(has(combat, mira.id, 'blessed') && has(combat, goblin.id, 'blessed'));
  assert.equal(combat.combatants[mira.id].concentration.until, 11);
  assert.ok(combat.log.some(entry => /turns to another spell — Fly ends/.test(entry.text)));

  // The GM hurts her: the check is hers to roll, and CON -20 cannot make DC 10.
  combat = await until(gm, 'combat-update-combatant', { combatantId: mira.id, patch: { hpCurrent: 22 } },
    state => Array.isArray(state.pending));
  assert.equal(combat.pending[0].conc, true);
  assert.equal(combat.pending[0].dc, 10);
  assert.ok(has(combat, goblin.id, 'blessed'), 'nothing ends before the roll');
  combat = await until(ana, 'combat-save', {}, state => !state.pending && !state.combatants[mira.id].concentration);
  assert.equal(combat.combatants[mira.id].concentration, undefined);
  assert.ok(!has(combat, mira.id, 'blessed') && !has(combat, goblin.id, 'blessed'));
  assert.ok(combat.log.some(entry => /concentrates on Bless .* LOST/.test(entry.text)));

  // Hold Person: the goblin fails DC 30, and is only paralyzed while she holds it.
  await until(gm, 'combat-set-turn', { combatantId: mira.id }, state => state.combatants[mira.id].actionUsed === false);
  combat = await until(ana, 'combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 1, targetId: goblin.id },
    state => Array.isArray(state.pending) && state.pending[0].linked === true);
  assert.equal(combat.pending[0].linked, true);
  combat = await until(gm, 'combat-save', {}, state => !state.pending && has(state, goblin.id, 'paralyzed'));
  assert.ok(has(combat, goblin.id, 'paralyzed'));
  assert.deepEqual(combat.combatants[mira.id].concentration.effects, [{ id: goblin.id, key: 'paralyzed' }]);
  combat = await until(gm, 'combat-update-combatant', { combatantId: mira.id, patch: { hpCurrent: 0 } },
    state => !state.combatants[mira.id].concentration);
  assert.ok(!has(combat, goblin.id, 'paralyzed'), 'dropping to 0 HP frees the goblin');
  assert.equal(combat.pending, undefined, 'no check is asked of someone who dropped');

  // Letting go costs nothing; only its owner (or the GM) may.
  await until(gm, 'combat-update-combatant', { combatantId: mira.id, patch: { hpCurrent: 30 } }, state => state.combatants[mira.id].hp.current === 30);
  await until(gm, 'combat-set-turn', { combatantId: mira.id }, state => state.combatants[mira.id].actionUsed === false);
  combat = await until(ana, 'combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, targetIds: [] },
    state => state.combatants[mira.id].hp.current === 30 && (state.combatants[mira.id].concentration || {}).name === 'Bless');
  assert.ok(has(combat, mira.id, 'blessed'), 'nobody picked: it lands on the caster');
  combat = await until(ana, 'combat-concentration', { combatantId: mira.id }, state => !state.combatants[mira.id].concentration);
  assert.ok(!has(combat, mira.id, 'blessed'));
  assert.ok(combat.log.some(entry => /stops concentrating — Bless ends/.test(entry.text)));
});
