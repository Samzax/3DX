// How spells look and heal: the kit keeps a spell's form, healing dice and
// casting time, and the server stamps every cast's log entry with what the
// map should play (shared/spellfx.js draws it).

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

test('kit: healing spells, bonus-action casts and effect forms are rebuilt', () => {
  const [word, bolt, odd] = kit.normalizeSpells([
    { name: 'Healing Word', level: 1, heal: '1d4 + 3', bySlot: { 2: '2d4+3' }, maxTargets: 1, time: 'bonus', form: 'heal', damage: '9d9' },
    { name: 'Fire Bolt', level: 0, damage: '2d10', damageType: 'fire', attackType: 'ranged', form: 'bolt' },
    { name: 'Odd', level: 0, damage: '1d6', form: 'fireworks', time: 'reaction' }
  ]);
  assert.deepEqual(word, { name: 'Healing Word', level: 1, damage: '', damageType: '', spellIndex: 0, heal: '1d4+3', form: 'heal', time: 'bonus', bySlot: { 2: '2d4+3' }, maxTargets: 1 });
  assert.equal(bolt.form, 'bolt');
  assert.equal(odd.form, undefined);
  assert.equal(odd.time, undefined);
});

test('a heal lands on the picked creatures for a bonus action, and every cast says how it looks', { timeout: 40000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-fx-'));
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
  const goblin = await gm.request('add-object', { type: 'token', name: 'Goblin', position: { x: 3, y: 0.1, z: 0 } }, 'object-added');
  const until = async (event, payload, shows) => {
    await gm.emit(event, payload);
    for (;;) {
      const state = await gm.wait('combat-updated');
      if (state && shows(state)) return state;
    }
  };
  await gm.request('combat-start', null, 'combat-updated');
  let combat = await until('combat-set-stats', {
    combatantId: mira.id, ac: 12, speedFeet: 30, initMod: 2, maxHP: 30, spellDC: 30, spellAtk: 30,
    spells: [
      { name: 'Healing Word', level: 0, heal: '1d4+3', maxTargets: 2, time: 'bonus', form: 'heal' },
      { name: 'Fire Bolt', level: 0, damage: '2d10', damageType: 'fire', attackType: 'ranged', form: 'bolt' },
      { name: 'Sacred Flame', level: 0, damage: '1d8', damageType: 'radiant', saveAbility: 'dex', saveSuccess: 'none', form: 'strike' }
    ]
  }, state => state.combatants[mira.id].statsPending === false);
  await until('combat-update-combatant', { combatantId: mira.id, patch: { hpCurrent: 30 } }, state => state.combatants[mira.id].hp.current === 30);
  await until('combat-begin', {}, state => state.started);
  await until('combat-set-turn', { combatantId: mira.id }, state => state.activeId === mira.id && state.combatants[mira.id].actionUsed === false);
  await until('combat-update-combatant', { combatantId: goblin.id, patch: { hpCurrent: 2 } }, state => state.combatants[goblin.id].hp.current === 2);

  // Fire Bolt: the log entry carries the form and whether it landed.
  combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 1, targetId: goblin.id },
    state => state.combatants[mira.id].actionUsed === true);
  const thrown = combat.log.find(entry => /casts Fire Bolt/.test(entry.text));
  assert.equal(thrown.fx.form, 'bolt');
  assert.equal(thrown.fx.type, 'fire');
  assert.equal(thrown.fx.target, goblin.id);
  // +30 to hit only misses on a natural 1; the hint follows the roll either way.
  const hit = thrown.roll.hit;
  assert.equal(thrown.fx.landed === true, hit);
  assert.equal(combat.combatants[goblin.id].hp.current, hit ? 0 : 2);

  // Healing Word after the action: a bonus action, both picked creatures heal.
  combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, targetIds: [goblin.id, mira.id] },
    state => state.combatants[mira.id].bonusUsed === true);
  const healed = combat.log.find(entry => /casts Healing Word/.test(entry.text));
  assert.match(healed.text, /\(bonus action\) on Goblin, Mira — 1d4\+3 → \d healed/);
  assert.equal(healed.fx.form, 'heal');
  assert.deepEqual(healed.fx.targets, [goblin.id, mira.id]);
  assert.equal(combat.combatants[goblin.id].hp.current, (hit ? 0 : 2) + healed.dmg.total);
  assert.ok(!combat.combatants[goblin.id].effects.some(effect => effect.key === 'down'), 'healing stands a downed creature up');
  assert.match((await gm.request('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 0, targetIds: [] }, 'combat-denied')).reason, /Bonus action already used/);

  // A single-target save spell keeps its form on the announcement.
  await until('combat-set-turn', { combatantId: mira.id }, state => state.combatants[mira.id].actionUsed === false);
  combat = await until('combat-action', { combatantId: mira.id, kind: 'cast', spellIndex: 2, targetId: goblin.id },
    state => state.combatants[mira.id].actionUsed === true);
  const flame = combat.log.find(entry => /casts Sacred Flame/.test(entry.text));
  assert.equal(flame.fx.form, 'strike');
  assert.equal(flame.fx.target, goblin.id);
});
