// The showcase table (`npm run demo`): tools/build-demo.mjs writes a world the
// real server loads without dropping anything, the GM gets the whole village,
// and the `player` account gets its party plus what the fog and token vision
// let it see.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

async function startDemo(dataDirectory) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  const env = { ...process.env, PORT: String(port), THREEDX_DATA_DIR: dataDirectory };
  const child = spawn(process.execPath, ['tools/demo.mjs'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (!output.includes('VTT Server Running')) {
    if (Date.now() > deadline || child.exitCode != null) throw new Error(`demo server did not start\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, port };
}

// Minimal Socket.IO-over-polling client (as in accounts-protocol.test.cjs).
async function connect(port) {
  const url = (sid) => `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling&t=${Math.random()}${sid ? `&sid=${sid}` : ''}`;
  const handshake = await (await fetch(url())).text();
  const sid = JSON.parse(handshake.slice(1)).sid;
  const post = async (packet) => { await fetch(url(sid), { method: 'POST', body: packet }); };
  await post('40');
  const inbox = [];
  const session = {
    emit: (event, payload) => post(`42${JSON.stringify([event, payload])}`),
    async wait(eventName, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = inbox.findIndex(([name]) => name === eventName);
        if (index >= 0) return inbox.splice(index, 1)[0][1];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventName}`);
        const response = await fetch(url(sid), { signal: AbortSignal.timeout(6000) });
        const packets = (await response.text()).split('\x1e');
        if (packets.includes('2')) await post('3');
        for (const packet of packets) {
          if (packet.startsWith('42')) inbox.push(JSON.parse(packet.slice(2)));
        }
      }
    },
    async request(event, payload, answer) {
      await session.emit(event, payload);
      return session.wait(answer);
    }
  };
  return session;
}

const countBy = (objects, key) => objects.reduce((out, o) => ({ ...out, [o[key]]: (out[o[key]] || 0) + 1 }), {});

test('the demo builds, loads and shows the village to both screens', { timeout: 60000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-demo-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(saveDir, { recursive: true, force: true });
  });

  // Refuses to overwrite a table unless forced.
  instance = await startDemo(saveDir);
  assert.throws(() => execFileSync(process.execPath, ['tools/build-demo.mjs', '--saves', saveDir],
    { cwd: repoRoot, stdio: 'pipe' }));
  const { port } = instance;
  const status = await (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();
  assert.equal(status.open, true);
  assert.equal(status.demo, true);

  const written = JSON.parse(fs.readFileSync(path.join(saveDir, 'map_state.json'), 'utf8')).maps;
  const writtenWorld = Object.values(written['@world'].objects);

  // The GM sees every object the builder wrote; the server kept them all.
  const gm = await connect(port);
  const gmLogin = await gm.request('login', { username: 'gm', campaignId: 'default', screen: 'gm' }, 'login-success');
  assert.equal(gmLogin.isGM, true);
  const joined = await gm.wait('campaign-joined');
  assert.equal(joined.name, 'The Emberfall Marches');
  assert.equal(joined.settings.world.home.x, joined.settings.spawn.x);
  assert.equal(joined.settings.vision.enabled, true);
  await gm.emit('join-map', { key: '@world' });
  const gmState = await gm.wait('map-state');
  const gmObjects = Object.values(gmState.objects);
  assert.equal(gmObjects.length, writtenWorld.length);
  const types = countBy(gmObjects, 'type');
  assert.equal(types.character, 4);
  assert.equal(types.token, 7);
  assert.equal(types.portal, 1);
  assert.ok(types.wall >= 8 && types.floor >= 6 && types.roof >= 6 && types.prop >= 10, JSON.stringify(types));
  for (const wall of gmObjects.filter(o => o.type === 'wall' && o.buildingId !== 'building-mage-gate')) {
    assert.equal(wall.segments.length, wall.ys.length, 'every wall cell has a baked height');
    assert.ok(wall.segments.includes('door'), 'every house has a door');
  }

  // The showcase shots are GM bookmarks, all on the village's tactical map.
  const marks = await gm.request('get-bookmarks', {}, 'bookmarks');
  assert.equal(marks.bookmarks.length, 5);
  assert.ok(marks.bookmarks.every(mark => mark.mapKey === marks.bookmarks[0].mapKey && mark.pose.pos && mark.pose.look));

  // The dungeon behind the portal was built and is reachable.
  const dungeons = await gm.request('get-dungeons', {}, 'dungeon-list');
  assert.equal(dungeons.dungeons.length, 1);
  assert.equal(dungeons.dungeons[0].name, 'The Sealed Undercroft');
  assert.ok(Object.keys(written[dungeons.dungeons[0].key].objects).length > 100);

  // `player` owns the party; fog shows them the hamlet's buildings.
  const player = await connect(port);
  await player.request('login', { username: 'player', campaignId: 'default', screen: 'player' }, 'login-success');
  await player.wait('campaign-joined');
  await player.emit('join-map', { key: '@world' });
  const playerObjects = Object.values((await player.wait('map-state')).objects);
  const own = playerObjects.filter(o => o.type === 'character');
  assert.equal(own.length, 4);
  assert.ok(own.every(o => o.characterData.owner === 'player'));
  assert.ok(playerObjects.some(o => o.type === 'roof'), 'the village is inside the revealed fog');
  const party = await player.request('get-party', {}, 'party');
  assert.deepEqual(party.members.map(m => m.level), [5, 5, 5, 5]);
});
