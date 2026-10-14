// Casting outside a fight: the live template the others watch, the request the
// GM allows or refuses, and the roll, slot and map effect an allowed cast gets.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

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

test('outside a fight a spell is asked for, watched while aimed, and rolled once the GM allows it', { timeout: 40000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-cast-'));
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
  await gm.wait('object-added');
  await gm.request('add-object', { type: 'token', name: 'Goblin Near', position: { x: 6, y: 0.1, z: 0 } }, 'object-added');
  await gm.request('add-object', { type: 'token', name: 'Goblin Far', position: { x: 40, y: 0.1, z: 0 } }, 'object-added');

  const ball = { kind: 'sphere', sizeFt: 20, rangeFt: 150 };
  const cast = {
    charId: character.id, tokenId: mira.id, spell: 'Fireball', level: 3, type: 'fire', concentration: false,
    roll: { label: 'casts Fireball', dice: [{ expr: '8d6', type: 'fire' }], note: 'DC 15 DEX save' },
    slot: { charId: character.id, level: 3, max: 1 },
    aim: { shape: ball, point: { x: 6, z: 0 } }
  };

  // Lists reach every screen: read on until this request is the one waiting.
  const asked = async (payload) => {
    await ana.emit('cast-request', payload);
    for (;;) {
      const { requests } = await ana.wait('cast-requests');
      if (requests.length === 1) return requests;
    }
  };

  // The GM watches the template while it is still being moved.
  gm.drop('cast-aim');
  await ana.emit('cast-aim', { tokenId: mira.id, name: 'Fireball', type: 'fire', shape: ball, point: { x: 5, z: 1 } });
  const ghost = await gm.wait('cast-aim');
  assert.equal(ghost.user, 'Ana');
  assert.equal(ghost.tokenId, mira.id);
  assert.deepEqual(ghost.point, { x: 5, z: 1 });
  assert.equal(ghost.shape.kind, 'sphere');

  // Released: nothing is rolled, the request waits for the GM.
  ana.drop('roll-logged');
  let list = await asked(cast);
  assert.equal(list.length, 1);
  assert.equal(list[0].spell, 'Fireball');
  assert.equal(list[0].area, '20 ft radius');
  assert.deepEqual(list[0].aim.point, { x: 6, z: 0 });
  assert.match((await ana.request('resolve-cast', { id: list[0].id, approve: true }, 'combat-denied')).reason, /GM only/);

  // Refused: the caster is told, the slot is untouched.
  gm.drop('cast-requests');
  await gm.emit('resolve-cast', { id: list[0].id, approve: false });
  assert.match((await ana.wait('cast-denied')).reason, /refused Fireball/);
  for (;;) { if (!(await gm.wait('cast-requests')).requests.length) break; } // the list empties for everyone

  // Asked again and allowed: rolled as hers, slot spent, the map plays it,
  // and only the GM is told who stands in it.
  list = await asked(cast);
  gm.drop('roll-logged'); ana.drop('roll-logged'); ana.drop('pools-updated'); ana.drop('cast-fx');
  await gm.emit('resolve-cast', { id: list[0].id, approve: true });
  const rolled = await ana.wait('roll-logged');
  assert.equal(rolled.user, 'Ana');
  assert.equal(rolled.actor, 'Mira');
  assert.equal(rolled.dice[0].expr, '8d6');
  assert.match(rolled.note, /level 3 slot spent/);
  assert.equal((await ana.wait('pools-updated')).pool.slots[3], 1);
  const played = await ana.wait('cast-fx');
  assert.equal(played.fx.actor, mira.id);
  assert.equal(played.fx.area.kind, 'sphere');
  assert.deepEqual(played.fx.area.center, [6, 0]);
  let told = await gm.wait('roll-logged');
  if (!told.gmOnly) told = await gm.wait('roll-logged');
  assert.equal(told.gmOnly, true);
  assert.match(told.text, /catches Goblin Near$/);

  // With the slot gone the GM's yes cannot stand: both hear why.
  list = await asked(cast);
  ana.drop('cast-denied');
  assert.match((await gm.request('resolve-cast', { id: list[0].id, approve: true }, 'combat-denied')).reason, /No level 3 spell slots left/);
  assert.match((await ana.wait('cast-denied')).reason, /No level 3 spell slots left/);

  // A caster may take a request back; someone else's character cannot be cast.
  list = await asked({ ...cast, spell: 'Light', level: 0, slot: undefined, aim: undefined, roll: { label: 'casts Light' } });
  assert.equal(list[0].aim, undefined);
  assert.equal((await ana.request('cancel-cast', { id: list[0].id }, 'cast-requests')).requests.length, 0);
  const bob = await connect(instance.port);
  await bob.request('login', 'Bob', 'login-success');
  assert.match((await bob.request('cast-request', cast, 'combat-denied')).reason, /Not your character/);
});
