const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { loadStructuresModule } = require('./helpers/load-browser-module.cjs');

const repoRoot = path.resolve(__dirname, '..');
const load = () => import(pathToFileURL(path.join(repoRoot, 'public', 'js', 'shared', 'vision.js')).href);

// A 6-cell wall along x at z = 0, from x = -3 to 3, with a door in cell 3 (x 0..1).
const wall = (extra = {}) => ({
  id: 'wall', type: 'wall', position: { x: -3, y: 0, z: 0 }, bx: 6, bz: 0, wallHeight: 2,
  segments: [null, null, null, 'door', 'window', null], ...extra
});
const eye = (x, z, senses = {}) => ({ x, y: 1.05, z, senses });
const body = (x, z, extra = {}) => ({ x, y: 0.6, z, ...extra });

test('server and client agree on the vision settings', async () => {
  const { VISION_NIGHT, VISION_INDOORS, VISION_POCKETS, VISION_DEFAULTS } = await load();
  const server = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const literal = (name) => new Function(`return ${server.match(new RegExp(`const ${name} = (\\[.*?\\]);`))[1]};`)();
  assert.deepEqual(literal('VISION_NIGHT'), VISION_NIGHT);
  assert.deepEqual(literal('VISION_INDOORS'), VISION_INDOORS);
  assert.deepEqual(literal('VISION_POCKETS'), VISION_POCKETS);
  const defaults = new Function(`return ${server.match(/vision: (\{ enabled: .*?\}),/)[1]};`)();
  assert.deepEqual(defaults, VISION_DEFAULTS);
});

test('wall cells and ruin randomness match the structure builder', async () => {
  const vision = await load();
  const structures = await loadStructuresModule(repoRoot);
  for (const [seed, i, k] of [[1, 0, 1], [77, 5, 2], [-4, 12, 11]]) {
    assert.equal(vision.buildRand(seed, i, k), structures.buildRand(seed, i, k));
  }
  for (const data of [{ bx: 5, bz: 0 }, { bx: 0, bz: -3 }, { path: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }] }]) {
    assert.equal(vision.wallCellsOf(data).length, structures.wallSegmentCount(data));
  }
});

test('walls, doors, windows and height decide line of sight', async () => {
  const { buildOccluders, sightBlocked } = await load();
  const occ = buildOccluders([wall()]);
  assert.equal(sightBlocked(occ, -2.5, 1, -2, -2.5, 1, 2), true, 'solid cell');
  assert.equal(sightBlocked(occ, 0.5, 1, -2, 0.5, 1, 2), true, 'closed door');
  assert.equal(sightBlocked(occ, 1.5, 1, -2, 1.5, 1, 2), false, 'window');
  assert.equal(sightBlocked(occ, -2.5, 3, -2, -2.5, 3, 2), false, 'over the top');
  assert.equal(sightBlocked(occ, -2.5, 1, -2, 2.5, 1, -2), false, 'along the wall');
  const open = buildOccluders([wall({ doors: [null, null, null, 'open'] })]);
  assert.equal(sightBlocked(open, 0.5, 1, -2, 0.5, 1, 2), false, 'open door');
  const locked = buildOccluders([wall({ doors: [null, null, null, 'locked'] })]);
  assert.equal(sightBlocked(locked, 0.5, 1, -2, 0.5, 1, 2), true, 'locked door');
});

test('floors and roofs block sight between storeys and make an indoors', async () => {
  const { buildOccluders, sightBlocked, coverAbove, visionContext, ambientAt, LIGHT_BRIGHT, LIGHT_DIM } = await load();
  const roof = { id: 'roof', type: 'roof', position: { x: 0, y: 2, z: 0 }, cols: 4, rows: 4, tiles: ['gap'] };
  const occ = buildOccluders([roof]);
  assert.equal(sightBlocked(occ, 2.5, 1, 2.5, 2.5, 4, 2.5), true, 'through the roof');
  assert.equal(sightBlocked(occ, 0.5, 1, 0.5, 0.5, 4, 0.5), false, 'through the cut-out tile');
  assert.equal(sightBlocked(occ, 2.5, 1, 2.5, 3.5, 1.5, 3.5), false, 'under the roof');
  assert.ok(coverAbove(occ, 2.5, 0, 2.5) < Infinity);
  assert.equal(coverAbove(occ, 8, 0, 8), Infinity);
  const noon = visionContext({ enabled: true }, { hour: 12 });
  assert.equal(ambientAt(occ, noon, 8, 0, 8), LIGHT_BRIGHT);
  assert.equal(ambientAt(occ, noon, 2.5, 0, 2.5), LIGHT_DIM, 'one step darker under a roof');
});

test('light and senses decide what a clear line shows', async () => {
  const { buildOccluders, visionContext, canSee } = await load();
  const open = buildOccluders([]);
  const day = visionContext({}, { hour: 12 });
  const night = visionContext({ night: 'dark' }, { hour: 23 });
  assert.equal(canSee(open, day, eye(0, 0), body(10, 0)), 'sight');
  assert.equal(canSee(open, night, eye(0, 0), body(10, 0)), null, 'darkness');
  assert.equal(canSee(open, night, eye(0, 0, { darkvision: 60 }), body(10, 0)), 'darkvision');
  assert.equal(canSee(open, night, eye(0, 0, { darkvision: 60 }), body(14, 0)), null, 'beyond darkvision');
  assert.equal(canSee(open, night, eye(0, 0), body(0.8, 0)), 'sight', 'adjacent');
  // A torch lights its bearer for everyone with a line to it.
  const torch = buildOccluders([{ id: 't', type: 'cube', position: { x: 10, y: 0, z: 0 }, light: { bright: 20, dim: 20 } }]);
  assert.equal(canSee(torch, night, eye(0, 0), body(10, 1)), 'sight');
  // Magical darkness beats light and darkvision, not Devil's Sight or truesight.
  const murk = buildOccluders([
    { id: 't', type: 'cube', position: { x: 10, y: 0, z: 0 }, light: { bright: 20, dim: 20 } },
    { id: 'd', type: 'cube', position: { x: 10, y: 0, z: 1 }, light: { dark: 15 } }
  ]);
  assert.equal(canSee(murk, night, eye(0, 0, { darkvision: 60 }), body(10, 1)), null);
  assert.equal(canSee(murk, night, eye(0, 0, { devilsSight: 120 }), body(10, 1)), 'sight');
  assert.equal(canSee(murk, night, eye(0, 0, { truesight: 60 }), body(10, 1)), 'truesight');
  // Invisible: only blindsight, truesight and tremorsense find it.
  const unseen = body(4, 0, { invisible: true });
  assert.equal(canSee(open, day, eye(0, 0), unseen), null);
  assert.equal(canSee(open, day, eye(0, 0, { blindsight: 30 }), unseen), 'blindsight');
  assert.equal(canSee(open, day, eye(0, 0, { tremorsense: 30 }), unseen), 'tremor');
  // Tremorsense feels through a wall; blindsight does not see through one.
  const walled = buildOccluders([wall()]);
  assert.equal(canSee(walled, day, eye(-2.5, -2, { blindsight: 60 }), body(-2.5, 2)), null);
  assert.equal(canSee(walled, day, eye(-2.5, -2, { tremorsense: 60 }), body(-2.5, 2)), 'tremor');
  // Weather shortens ordinary sight.
  const fog = visionContext({}, { hour: 12, weather: { fog: 1, rain: 0, snow: 0, storm: 0 } });
  assert.equal(fog.sightFeet, 60);
  assert.equal(canSee(open, fog, eye(0, 0), body(20, 0)), null);
  assert.equal(canSee(open, fog, eye(0, 0), body(8, 0)), 'sight');
});

test('monster senses are read off the stat block', async () => {
  const { parseMonsterSenses, sensesOf, normalizeLight, lightPresetKey } = await load();
  assert.deepEqual(parseMonsterSenses({ darkvision: '60 ft.', passive_perception: 12 }), { darkvision: 60 });
  assert.deepEqual(parseMonsterSenses({ blindsight: '30 ft. (blind beyond this radius)' }), { blindsight: 30, blind: true });
  assert.deepEqual(parseMonsterSenses({ notes: 'darkvision 120 ft., tremorsense 60 ft., passive Perception 14' }),
    { darkvision: 120, tremorsense: 60 });
  assert.deepEqual(sensesOf({ monsterData: { senses: { truesight: '120 ft.' } } }), { truesight: 120 });
  assert.deepEqual(sensesOf({ senses: { darkvision: 90 }, monsterData: { senses: { truesight: '120 ft.' } } }), { darkvision: 90 });
  assert.equal(normalizeLight({ bright: 0, dim: 0 }), null);
  assert.equal(lightPresetKey({ bright: 20, dim: 20 }), 'torch');
});

test('the polar sight row matches the exact line test', async () => {
  const { buildOccluders, polarRow, polarDistance, sightBlocked, POLAR_FAR } = await load();
  const occ = buildOccluders([wall()]);
  const bins = 512, row = new Float32Array(bins * 2);
  const ox = 0.5, oy = 1.05, oz = -2;
  polarRow(occ, ox, oy, oz, bins, row);
  assert.ok(Math.abs(polarDistance(row, bins, 0, 0, 1) - 2) < 0.05, 'the door straight ahead');
  assert.equal(polarDistance(row, bins, 0, 0, -1), POLAR_FAR, 'open country behind');
  // Points a little beyond the wall line: hidden exactly where the line test says.
  let agree = 0, total = 0;
  for (let x = -6; x <= 6; x += 0.37) {
    const dx = x - ox, dz = 3;
    const visible = Math.hypot(dx, dz) <= polarDistance(row, bins, 0, dx, dz);
    if (visible === !sightBlocked(occ, ox, oy, oz, x, oy, oz + dz)) agree++;
    total++;
  }
  assert.ok(agree >= total - 2, `${agree}/${total} agree (bin edges may differ)`);
});

// ---- the real server: who is sent what ----

const packetSeparator = '\x1e';
async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}
async function startServer(dataDirectory) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), THREEDX_DATA_DIR: dataDirectory, THREEDX_OPEN_LOGIN: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (!output.includes('VTT Server Running')) {
    if (child.exitCode != null || Date.now() > deadline) throw new Error(`server did not start\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, port };
}
const pollingUrl = (session, sid = true) =>
  `http://127.0.0.1:${session.port}/socket.io/?EIO=4&transport=polling&t=${Date.now()}-${Math.random()}${sid ? `&sid=${session.sid}` : ''}`;
async function post(session, packet) {
  const response = await fetch(pollingUrl(session), { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: packet });
  assert.equal(response.status, 200);
  await response.text();
}
async function poll(session) {
  const response = await fetch(pollingUrl(session), { signal: AbortSignal.timeout(6000) });
  const packets = (await response.text()).split(packetSeparator);
  if (packets.includes('2')) await post(session, '3');
  return packets.filter((packet) => packet.startsWith('42')).map((packet) => JSON.parse(packet.slice(2)));
}
async function connect(port, username) {
  const session = { port, sid: null };
  const body = await (await fetch(pollingUrl(session, false))).text();
  session.sid = JSON.parse(body.slice(1)).sid;
  await post(session, '40');
  await poll(session);
  await post(session, `42${JSON.stringify(['login', username])}`);
  return session;
}
const emit = (session, event, payload) => post(session, `42${JSON.stringify([event, payload])}`);
// Everything the server sent up to (and including) the answer to a marker
// request, so "nothing arrived" can be asserted without racing the socket.
async function settle(session) {
  await emit(session, 'get-character-instances', null);
  const events = [];
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const batch = await poll(session);
    events.push(...batch);
    if (batch.some(([name]) => name === 'character-instances')) return events;
  }
  throw new Error('the server never answered the marker request');
}
const named = (events, name) => events.filter(([event]) => event === name).map(([, payload]) => payload);

test('players are only sent the creatures their character can see', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-vision-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
  instance = await startServer(fixtureDir);
  const gm = await connect(instance.port, 'gm');
  await settle(gm);
  const ana = await connect(instance.port, 'ana');
  await settle(ana);

  await emit(gm, 'update-fog', { hexes: ['0,0'], revealed: true });
  await emit(gm, 'update-campaign-settings', { id: 'default', settings: { vision: { enabled: true } } });
  const settled = await settle(gm);
  assert.equal(named(settled, 'campaign-updated').pop().settings.vision.enabled, true);

  await emit(ana, 'save-character', { charData: {
    name: 'Ana the Scout', race: 'human', background: 'acolyte',
    classes: [{ class: 'fighter', level: 1 }], abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
  } });
  const saved = named(await settle(ana), 'character-saved-success')[0];
  await emit(ana, 'add-object', { type: 'character', characterData: { id: saved.id }, position: { x: 0.5, y: 0.38, z: 0.5 } });
  const scout = named(await settle(ana), 'object-added')[0];
  assert.equal(scout.characterData.owner, 'ana');

  // A wall 3 cells north of the scout with a (closed) door in line, a goblin behind it.
  await emit(gm, 'add-object', {
    type: 'wall', position: { x: -3, y: 0, z: 3 }, path: [{ x: 0, z: 0 }, { x: 6, z: 0 }], wallHeight: 2,
    segments: [null, null, null, 'door', null, null]
  });
  await emit(gm, 'add-object', { type: 'token', name: 'Goblin', position: { x: 0.5, y: 0.1, z: 6.5 } });
  const gmEvents = await settle(gm);
  const wallObject = named(gmEvents, 'object-added').find((o) => o.type === 'wall');
  const goblin = named(gmEvents, 'object-added').find((o) => o.name === 'Goblin');
  let events = await settle(ana);
  assert.ok(named(events, 'object-added').some((o) => o.type === 'wall'), 'the wall itself is not a secret');
  assert.equal(named(events, 'object-added').some((o) => o.name === 'Goblin'), false, 'the goblin behind the wall is');

  // Too far to work the door; the GM opens it and the goblin comes into view.
  await emit(ana, 'toggle-door', { id: wallObject.id, index: 3 });
  events = await settle(ana);
  assert.match(named(events, 'combat-denied')[0].reason, /next to the door/);
  await emit(gm, 'toggle-door', { id: wallObject.id, index: 3 });
  events = await settle(ana);
  assert.deepEqual(named(events, 'object-updated')[0].patch.doors.slice(0, 4), [null, null, null, 'open']);
  assert.ok(named(events, 'object-added').some((o) => o.id === goblin.id), 'seen through the open door');

  // A rejoin lists the goblin while it is in view.
  await emit(ana, 'join-map', { key: 'world' });
  events = await settle(ana);
  assert.ok(named(events, 'map-state')[0].objects.some((o) => o.id === goblin.id));

  // Moving out of the doorway's line loses it; moving back finds it again.
  await emit(gm, 'move-object', { id: goblin.id, position: { x: -2.5, y: 0.1, z: 6.5 } });
  events = await settle(ana);
  assert.ok(named(events, 'object-deleted').some((o) => o.id === goblin.id), 'stepped out of the doorway');
  await emit(gm, 'move-object', { id: goblin.id, position: { x: 0.5, y: 0.1, z: 6.5 } });
  events = await settle(ana);
  assert.ok(named(events, 'object-added').some((o) => o.id === goblin.id));

  // Invisible: gone, until the scout gets a sense that beats it.
  await emit(gm, 'set-vision', { id: goblin.id, invisible: true });
  events = await settle(ana);
  assert.ok(named(events, 'object-deleted').some((o) => o.id === goblin.id), 'invisible');
  await emit(ana, 'set-vision', { id: scout.id, senses: { blindsight: 60 }, invisible: true, hidden: true });
  events = await settle(ana);
  assert.ok(named(events, 'object-added').some((o) => o.id === goblin.id), 'blindsight finds it');
  await emit(gm, 'set-vision', { id: goblin.id, invisible: false });
  await emit(ana, 'set-vision', { id: scout.id, senses: {} });

  // A dark night hides it; darkvision or a torch on the goblin brings it back.
  await emit(gm, 'update-campaign-settings', { id: 'default', settings: { sky: { hour: 23 }, vision: { night: 'dark' } } });
  await settle(gm);
  events = await settle(ana);
  assert.ok(named(events, 'object-deleted').some((o) => o.id === goblin.id), 'night');
  await emit(ana, 'set-vision', { id: scout.id, senses: { darkvision: 60 } });
  events = await settle(ana);
  assert.ok(named(events, 'object-added').some((o) => o.id === goblin.id), 'darkvision');
  await emit(ana, 'set-vision', { id: scout.id, senses: {} });
  events = await settle(ana);
  assert.ok(named(events, 'object-deleted').some((o) => o.id === goblin.id));
  await emit(gm, 'set-vision', { id: goblin.id, light: { bright: 20, dim: 20 } });
  await settle(gm);
  events = await settle(ana);
  assert.ok(named(events, 'object-added').some((o) => o.id === goblin.id), 'torchlight');

  // GM-hidden creatures are never sent, whatever the light.
  await emit(gm, 'set-vision', { id: goblin.id, hidden: true });
  await settle(gm);
  events = await settle(ana);
  assert.ok(named(events, 'object-deleted').some((o) => o.id === goblin.id), 'hidden by the GM');

  // The player's attempt to flag their own token was ignored; state persisted cleanly.
  const state = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'map_state.json'), 'utf8'));
  const stored = state.maps['@world'].objects;
  assert.equal(stored[scout.id].invisible, undefined);
  assert.equal(stored[scout.id].hidden, undefined);
  assert.equal(stored[goblin.id].hidden, true);
  assert.deepEqual(stored[goblin.id].light, { bright: 20, dim: 20, dark: 0 });
  assert.deepEqual(stored[wallObject.id].doors.slice(0, 4), [null, null, null, 'open']);
});
