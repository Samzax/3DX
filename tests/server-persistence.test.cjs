const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
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
    env: {
      ...process.env,
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      PORT: String(port),
      THREEDX_DATA_DIR: dataDirectory,
      // Protocol tests log in by bare username; accounts are covered in auth.test.cjs.
      THREEDX_OPEN_LOGIN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => {
    if (code && code !== 0) process.stderr.write(`\n[server exited ${code}]\n${output}\n`);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server start timed out\n${output}`)), 5000);
    const inspect = () => {
      if (!output.includes('VTT Server Running')) return;
      clearTimeout(timeout);
      cleanup();
      resolve();
    };
    const exited = (code) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`server exited with ${code}\n${output}`));
    };
    const cleanup = () => {
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
      child.off('exit', exited);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('exit', exited);
    inspect();
  });
  return { child, port, output: () => output };
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode != null || instance.child.signalCode != null) return;
  instance.child.kill();
  await Promise.race([
    once(instance.child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('server did not stop')), 3000))
  ]);
}

function pollingUrl(session, includeSid = true) {
  const query = new URLSearchParams({
    EIO: '4',
    transport: 'polling',
    t: `${Date.now()}-${Math.random()}`
  });
  if (includeSid) query.set('sid', session.sid);
  return `http://127.0.0.1:${session.port}/socket.io/?${query}`;
}

async function connectPolling(port) {
  const session = { port, sid: null };
  const response = await fetch(pollingUrl(session, false));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.startsWith('0'), `unexpected Engine.IO handshake: ${body}`);
  session.sid = JSON.parse(body.slice(1)).sid;
  await postPacket(session, '40');
  const initialPackets = await pollPackets(session); // Socket.IO connect ack only.
  assert.equal(socketEvents(initialPackets).some(([name]) => name === 'map-state'), false,
    'the server must not send a role-blind map state before login');
  session.initialPackets = initialPackets;
  return session;
}

async function postPacket(session, packet) {
  const response = await fetch(pollingUrl(session), {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: packet
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
}

async function pollPackets(session) {
  const response = await fetch(pollingUrl(session), { signal: AbortSignal.timeout(4000) });
  assert.equal(response.status, 200);
  const packets = (await response.text()).split(packetSeparator);
  if (packets.includes('2')) await postPacket(session, '3');
  return packets;
}

async function emitEvent(session, event, payload) {
  await postPacket(session, `42${JSON.stringify([event, payload])}`);
}

function socketEvents(packets) {
  return packets
    .filter((packet) => packet.startsWith('42'))
    .map((packet) => JSON.parse(packet.slice(2)));
}

async function waitForSocketEvent(session, eventName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = socketEvents(await pollPackets(session)).find(([name]) => name === eventName);
    if (event) return event[1];
  }
  throw new Error(`timed out waiting for socket event ${eventName}`);
}

// Same as waitForSocketEvent but collects several events across batches —
// the server often queues them together, so draining for one would consume
// the others.
async function waitForSocketEvents(session, eventNames, timeoutMs = 5000) {
  const remaining = new Set(eventNames);
  const seen = {};
  const deadline = Date.now() + timeoutMs;
  while (remaining.size && Date.now() < deadline) {
    for (const [name, payload] of socketEvents(await pollPackets(session))) {
      if (remaining.has(name)) { seen[name] = payload; remaining.delete(name); }
    }
  }
  if (remaining.size) throw new Error(`timed out waiting for socket events ${[...remaining].join(', ')}`);
  return seen;
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

test('the real server saves sanitized structure data and reloads it after restart', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-persistence-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });

  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const firstSession = await connectPolling(instance.port);
  await emitEvent(firstSession, 'login', 'gm');
  await pollPackets(firstSession);

  const submittedId = 'client-controlled-id';
  await emitEvent(firstSession, 'add-object', {
    id: submittedId,
    name: 'Persistence wall',
    type: 'wall',
    level: 2,
    position: { x: 12, y: 4, z: -8 },
    path: [{ x: 0, z: 0 }, { x: 2.2, z: 1.8 }, { x: 100, z: 2 }],
    ys: [1, 'invalid', 3],
    segments: ['door', 'invalid', 'window']
  });

  const saveFile = path.join(saveDir, 'map_state.json');
  const savedObject = await waitFor(() => {
    if (!fs.existsSync(saveFile)) return null;
    const state = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    return Object.values(state.maps?.['@world']?.objects || {})
      .find((object) => object.name === 'Persistence wall') || null;
  }, 'map_state.json to contain the structure');

  assert.notEqual(savedObject.id, submittedId, 'map object ids are server-derived');
  assert.match(savedObject.structureId, /^structure-/);
  assert.deepEqual(savedObject.path, [
    { x: 0, z: 0 },
    { x: 2, z: 0 },
    { x: 2, z: 2 },
    { x: 46, z: 2 }
  ]);
  assert.equal(savedObject.bx, 46);
  assert.equal(savedObject.bz, 2);
  assert.equal(savedObject.ys.length, 48);
  assert.deepEqual(savedObject.ys.slice(0, 4), [1, 0, 3, 0]);
  assert.equal(savedObject.segments.length, 48);
  assert.deepEqual(savedObject.segments.slice(0, 4), ['door', null, 'window', null]);

  await stopServer(instance);
  instance = await startServer(saveDir);
  const secondSession = await connectPolling(instance.port);
  await emitEvent(secondSession, 'login', 'GM');
  const loginPackets = await pollPackets(secondSession);
  const loginEvents = socketEvents(loginPackets);
  const loginSuccessIndex = loginEvents.findIndex(([event]) => event === 'login-success');
  const mapStateIndex = loginEvents.findIndex(([event]) => event === 'map-state');
  assert.ok(loginSuccessIndex >= 0 && mapStateIndex > loginSuccessIndex,
    'the authenticated map state must follow login success');
  const mapStates = loginEvents
    .filter(([event]) => event === 'map-state')
    .map(([, state]) => state);
  assert.ok(mapStates.length > 0, 'GM login should re-send map-state');
  const reloaded = mapStates.at(-1).objects.find((object) => object.id === savedObject.id);
  assert.ok(reloaded, 'restarted server should return the persisted structure');
  assert.deepEqual(reloaded.path, savedObject.path);
  assert.deepEqual(reloaded.segments, savedObject.segments);
});

test('combat-only unified-lens migration persists across restart', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-combat-migration-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const saveFile = path.join(saveDir, 'map_state.json');
  const legacyCombat = {
    active: true, started: false, round: 0, activeId: null,
    order: [], combatants: {}, log: []
  };
  fs.writeFileSync(saveFile, JSON.stringify({ maps: {
    '@world': { objects: {}, rulers: {} },
    'world/1,0': { objects: {}, rulers: {}, combat: legacyCombat }
  } }, null, 2));
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  let gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  let state = await waitForSocketEvent(gm, 'map-state');
  assert.deepEqual(state.combat.combatants, {});
  let persisted = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  assert.ok(persisted.maps['@world'].combat);
  assert.equal(persisted.maps['world/1,0'].combat, undefined);

  await stopServer(instance);
  instance = await startServer(saveDir);
  gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  state = await waitForSocketEvent(gm, 'map-state');
  assert.deepEqual(state.combat.combatants, {});
  persisted = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  assert.equal(persisted.maps['world/1,0'].combat, undefined);
});

test('terrain reset is rejected without GM authority and commits a canonical province result', { timeout: 25000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-terrain-reset-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'reset-terrain', { requestId: 'terrain-reset-no-role' });
  const denied = await waitForSocketEvent(gm, 'terrain-reset-rejected');
  assert.equal(denied.requestId, 'terrain-reset-no-role');
  assert.equal(denied.reason, 'GM only');

  await emitEvent(gm, 'login', 'gm');
  await pollPackets(gm);
  const provinceKey = 'world/0,0/0,0/0,0';
  await emitEvent(gm, 'join-map', { key: provinceKey });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-terrain', {
    chunks: {
      '0,0': { heights: 'AAAA' },
      '100,100': { heights: 'BBBB' }
    },
    water: { bodies: [
      { id: 'inside-lake', kind: 'lake', seed: { x: 0, z: 0 }, level: 1, maxRadius: 20 },
      { id: 'corner-lake', kind: 'lake', seed: { x: 539, z: 328 }, level: 1, maxRadius: 20 },
      { id: 'outside-lake', kind: 'lake', seed: { x: 4000, z: 4000 }, level: 2, maxRadius: 20 },
      { id: 'edge-miss-lake', kind: 'lake', seed: { x: 550, z: 0 }, level: 2, maxRadius: 10 },
      { id: 'crossing-river', kind: 'river', points: [
        { x: -600, z: 0 }, { x: 600, z: 0 }
      ], width: 2, speed: 1 },
      { id: 'outside-river', kind: 'river', points: [
        { x: 600, z: -100 }, { x: 600, z: 100 }
      ], width: 2, speed: 1 },
      { id: 'curved-river', kind: 'river', points: [
        { x: 537.50, z: 341.83 }, { x: 486.05, z: 461.91 },
        { x: 549.51, z: 249.21 }, { x: 717.45, z: 382.05 }
      ], width: 2.5, speed: 1 }
    ] }
  });
  await emitEvent(gm, 'update-fog', { hexes: ['0,0'], revealed: true });
  await waitForSocketEvent(gm, 'fog-updated');

  const player = await connectPolling(instance.port);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);

  const saveFile = path.join(saveDir, 'map_state.json');
  await waitFor(() => {
    const terrain = JSON.parse(fs.readFileSync(saveFile, 'utf8')).maps?.['@world']?.terrain;
    return terrain?.chunks?.['0,0'] && terrain?.chunks?.['100,100'] && terrain.water?.bodies?.length === 7;
  }, 'both terrain chunks and water bodies to persist');

  await emitEvent(gm, 'reset-terrain', { requestId: 'terrain-reset-province-success' });
  const applied = await waitForSocketEvent(gm, 'terrain-reset-applied');
  assert.equal(applied.requestId, 'terrain-reset-province-success');
  assert.equal(applied.scope, 'province');
  assert.equal(applied.contextKey, provinceKey);
  assert.deepEqual(applied.chunks, { '0,0': null });
  assert.deepEqual(applied.water.bodies.map((body) => body.id),
    ['outside-lake', 'edge-miss-lake', 'outside-river']);

  const playerApplied = await waitForSocketEvent(player, 'terrain-reset-applied');
  assert.deepEqual(playerApplied.chunks, { '0,0': null });
  assert.deepEqual(playerApplied.water, applied.water);

  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8')).maps['@world'].terrain;
  assert.equal(saved.chunks['0,0'], undefined);
  assert.equal(saved.chunks['100,100'].heights, 'BBBB');
  assert.deepEqual(saved.water.bodies.map((body) => body.id),
    ['outside-lake', 'edge-miss-lake', 'outside-river']);

  await stopServer(instance);
  instance = await startServer(saveDir);
  const reloaded = await connectPolling(instance.port);
  await emitEvent(reloaded, 'login', 'gm');
  const state = await waitForSocketEvent(reloaded, 'map-state');
  assert.equal(state.terrain.chunks['0,0'], undefined);
  assert.equal(state.terrain.chunks['100,100'].heights, 'BBBB');
  assert.deepEqual(state.terrain.water.bodies.map((body) => body.id),
    ['outside-lake', 'edge-miss-lake', 'outside-river']);
});

test('pocket terrain clear is one canonical event for the GM and players', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-pocket-reset-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'gm');
  await pollPackets(gm);
  await emitEvent(gm, 'create-pocket-map', {
    name: 'Reset fixture', width: 24, height: 24, parentKey: 'world'
  });
  const pocket = await waitForSocketEvent(gm, 'pocket-created');
  await emitEvent(gm, 'join-map', { key: pocket.key });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-terrain', {
    chunks: { '0,0': { heights: 'AAAA', splat: 'BBBB' } },
    water: { bodies: [
      { id: 'pocket-lake', kind: 'lake', seed: { x: 0, z: 0 }, level: 1, maxRadius: 10 }
    ] }
  });

  const player = await connectPolling(instance.port);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);
  await emitEvent(player, 'join-map', { key: pocket.key });
  const pocketState = await waitForSocketEvent(player, 'map-state');
  assert.equal(pocketState.terrain.chunks['0,0'].heights, 'AAAA');
  assert.equal(pocketState.terrain.water.bodies[0].id, 'pocket-lake');

  await emitEvent(gm, 'reset-terrain', { requestId: 'terrain-reset-pocket-success' });
  const gmResult = await waitForSocketEvent(gm, 'terrain-reset-applied');
  const playerResult = await waitForSocketEvent(player, 'terrain-reset-applied');
  assert.equal(gmResult.scope, 'map');
  assert.equal(gmResult.contextKey, pocket.key);
  assert.equal(gmResult.clear, true);
  assert.deepEqual(gmResult.water, { bodies: [] });
  assert.deepEqual(playerResult, gmResult);

  const saved = JSON.parse(fs.readFileSync(path.join(saveDir, 'map_state.json'), 'utf8'));
  assert.deepEqual(saved.maps[pocket.key].terrain.chunks, {});
  assert.deepEqual(saved.maps[pocket.key].terrain.water, { bodies: [] });
});

test('non-GM sockets cannot author generic world objects', { timeout: 15000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-auth-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'alice');
  await pollPackets(session);
  await emitEvent(session, 'add-object', {
    type: 'cube', position: { x: 0, y: 0, z: 0 }, name: 'forbidden'
  });
  const error = await waitForSocketEvent(session, 'error');
  assert.equal(error, 'GM only');

  const saveFile = path.join(saveDir, 'map_state.json');
  if (fs.existsSync(saveFile)) {
    const state = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    assert.equal(Object.values(state.maps?.['@world']?.objects || {})
      .some((object) => object.name === 'forbidden'), false);
  }
});

test('malformed character deletion cannot terminate the server', { timeout: 15000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-delete-guard-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'alice');
  await pollPackets(session);
  await emitEvent(session, 'delete-character', null);
  assert.equal(await waitForSocketEvent(session, 'error'), 'Invalid character id');

  await emitEvent(session, 'get-characters', null);
  assert.deepEqual(await waitForSocketEvent(session, 'load-user-characters'), []);
  assert.equal(instance.child.exitCode, null);
});

test('non-GM navigation cannot materialize arbitrary world-lens saves', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-map-bound-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const player = await connectPolling(instance.port);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);
  const arbitraryLens = 'world/123,456';
  await emitEvent(player, 'join-map', { key: arbitraryLens });
  assert.equal((await waitForSocketEvent(player, 'map-state')).key, arbitraryLens);
  await emitEvent(player, 'add-ruler', {
    points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }]
  });
  await emitEvent(player, 'clear-rulers', null);

  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(gm, 'add-object', {
    type: 'cube', name: 'save-trigger', position: { x: 0, y: 0, z: 0 }
  });
  await waitForSocketEvent(gm, 'object-added');

  const saveFile = path.join(saveDir, 'map_state.json');
  const state = await waitFor(() => JSON.parse(fs.readFileSync(saveFile, 'utf8')), 'map_state.json');
  assert.equal(Object.prototype.hasOwnProperty.call(state.maps, arbitraryLens), false);
});

test('fog-hidden objects do not reveal their position through denied moves', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-fog-auth-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(gm, 'add-object', {
    type: 'floor', name: 'hidden-grouped-floor',
    buildingId: 'hidden-building', buildingDatumY: 0,
    structureId: 'hidden-structure', level: 0, levelHeight: 2,
    heightMode: 'flat', cols: 1, rows: 1,
    position: { x: 17, y: 0, z: 23 }
  });
  const hiddenObject = await waitForSocketEvent(gm, 'object-added');

  const player = await connectPolling(instance.port);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);
  await emitEvent(player, 'move-object', {
    id: hiddenObject.id, position: { x: 999, y: 999, z: 999 }
  });
  const events = socketEvents(await pollPackets(player));
  assert.equal(events.some(([name]) => name === 'object-moved'), false);
  assert.equal(events.find(([name]) => name === 'combat-denied')?.[1]?.reason,
    'You can only move your own character');
});

test('non-owners receive only public character render data on maps and reveals', { timeout: 25000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-character-projection-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);
  await emitEvent(gm, 'save-character', { charData: {
    name: 'Private Hero', race: 'elf', background: 'acolyte',
    classes: [{ class: 'wizard', level: 5 }],
    abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 9 },
    skills: ['arcana'], spells: ['magic-missile'], hp: { current: 17 },
    appearance: {
      height: 1.1, build: 0.9, headSize: 1, armLength: 1, legLength: 1,
      colors: { skin: '#abcdef', hair: '#112233', torso: '#445566', legs: '#778899', eyes: '#010203' }
    },
    equipment: { armor: 'leather', shield: true, weapons: ['longsword', 'shortbow'], items: ['backpack'] }
  } });
  const savedCharacter = await waitForSocketEvent(gm, 'character-saved-success');

  const assertPublicProjection = (object) => {
    const character = object.characterData;
    assert.equal(character.name, 'Private Hero');
    assert.equal(character.race, 'elf');
    assert.equal(character.owner, 'GM');
    assert.equal(character.appearance.colors.torso, '#445566');
    assert.deepEqual(character.equipment, {
      armor: 'leather', shield: true, weapons: ['longsword']
    });
    for (const privateField of [
      'id', 'classes', 'abilities', 'stats', 'skills', 'spells', 'hp', 'background', 'alignment'
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(character, privateField), false,
        `${privateField} must not be sent to a non-owner`);
    }
  };

  await emitEvent(gm, 'create-pocket-map', {
    name: 'Projection room', width: 20, height: 20, parentKey: 'world'
  });
  const pocket = await waitForSocketEvent(gm, 'pocket-created');
  await emitEvent(gm, 'join-map', { key: pocket.key });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(player, 'join-map', { key: pocket.key });
  await waitForSocketEvent(player, 'map-state');

  await emitEvent(gm, 'add-object', {
    type: 'character', characterData: { id: savedCharacter.id },
    position: { x: 1, y: 0, z: 1 }
  });
  const gmLiveObject = await waitForSocketEvent(gm, 'object-added');
  const playerLiveObject = await waitForSocketEvent(player, 'object-added');
  assert.equal(gmLiveObject.characterData.id, savedCharacter.id);
  assert.deepEqual(gmLiveObject.characterData.classes, savedCharacter.classes);
  assertPublicProjection(playerLiveObject);

  await emitEvent(gm, 'combat-start', null);
  const gmCombat = await waitForSocketEvent(gm, 'combat-updated');
  const playerCombat = await waitForSocketEvent(player, 'combat-updated');
  assert.equal(gmCombat.combatants[gmLiveObject.id].charId, savedCharacter.id);
  assert.ok(Array.isArray(gmCombat.combatants[gmLiveObject.id].attacks));
  for (const privateField of [
    'charId', 'attacks', 'spells', 'slots', 'saves', 'spellAtk', 'spellDC'
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(
      playerCombat.combatants[playerLiveObject.id], privateField
    ), false, `${privateField} must not be sent for another owner's combatant`);
  }

  await emitEvent(player, 'join-map', { key: pocket.key });
  const playerState = await waitForSocketEvent(player, 'map-state');
  assertPublicProjection(playerState.objects.find(object => object.id === playerLiveObject.id));
  assert.equal(Object.prototype.hasOwnProperty.call(
    playerState.combat.combatants[playerLiveObject.id], 'charId'
  ), false);

  const tacticalKey = 'world/0,0/0,0/0,0';
  await emitEvent(gm, 'join-map', { key: tacticalKey });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(player, 'join-map', { key: tacticalKey });
  await waitForSocketEvent(player, 'map-state');
  const anonymous = await connectPolling(instance.port);
  await emitEvent(gm, 'add-object', {
    type: 'character', characterData: { id: savedCharacter.id },
    position: { x: 0, y: 0, z: 0 }
  });
  await waitForSocketEvent(gm, 'object-added');
  await emitEvent(gm, 'update-fog', { hexes: ['0,0'], revealed: true });
  assertPublicProjection(await waitForSocketEvent(player, 'object-added'));
  // Nothing is globally broadcast any more (fog/objects stay campaign-scoped),
  // so an anonymous socket that hears nothing within a settle window is the
  // proof that no object/terrain data leaked to it.
  const anonymousEvents = socketEvents(await Promise.race([
    pollPackets(anonymous).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), 1500))
  ]));
  assert.equal(anonymousEvents.some(([name]) =>
    name === 'object-added' || name === 'terrain-updated'
  ), false);
});

test('the server duplicates a complete grouped storey in one canonical batch', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-storey-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'GM');
  await pollPackets(session);
  const buildingId = 'building-batch-test';
  const common = { buildingId, buildingDatumY: 5, levelHeight: 2, style: 'stone' };
  const sourceRecords = [
    {
      ...common, name: 'batch-floor', type: 'floor', structureId: 'structure-floor-source',
      level: 0, heightMode: 'terrain', position: { x: 10, y: 5.5, z: 20 },
      cols: 2, rows: 2, ys: [0.2, -0.1, 0.4, 0], tiles: [null, 'gap', null, null]
    },
    {
      ...common, name: 'batch-wall', type: 'wall', structureId: 'structure-wall-source',
      level: 0, heightMode: 'terrain', position: { x: 10, y: 5.2, z: 20 },
      path: [{ x: 0, z: 0 }, { x: 2, z: 0 }], ys: [0.2, -0.1], segments: ['door', 'window']
    },
    {
      ...common, name: 'batch-roof', type: 'roof', structureId: 'structure-roof-source',
      level: 1, coversLevel: 0, heightMode: 'flat', position: { x: 10, y: 7, z: 20 },
      cols: 2, rows: 2, roofShape: 'hip', pitch: 0.5
    }
  ];
  const canonicalSources = [];
  for (const source of sourceRecords) {
    await emitEvent(session, 'add-object', source);
    canonicalSources.push(await waitForSocketEvent(session, 'object-added'));
  }

  const sourceRoof = canonicalSources.find((object) => object.type === 'roof');
  await emitEvent(session, 'move-object', {
    id: sourceRoof.id,
    position: { ...sourceRoof.position, y: sourceRoof.position.y + 10 }
  });
  const rejectedMoveEvents = socketEvents(await pollPackets(session));
  assert.deepEqual(
    rejectedMoveEvents.find(([name]) => name === 'object-moved')?.[1]?.position,
    sourceRoof.position
  );
  assert.match(
    rejectedMoveEvents.find(([name]) => name === 'error')?.[1] || '',
    /stay aligned/
  );

  const requestId = 'structure-batch-request-1';
  await emitEvent(session, 'structure-batch', {
    requestId,
    action: 'duplicate-storey',
    buildingId,
    buildingDatumY: 5,
    sourceLevel: 0,
    destinationLevel: 1,
    expectedSourceIds: canonicalSources.map((object) => object.id).sort(),
    expectedDestinationIds: [],
    allowOccupiedDestination: false
  });
  const result = await waitForSocketEvent(session, 'structure-batch-applied');
  assert.equal(result.requestId, requestId);
  assert.equal(result.key, 'world');
  assert.equal(result.created.length, 3);
  assert.deepEqual(result.updated, []);

  const sourceStructureIds = new Set(canonicalSources.map((object) => object.structureId));
  assert.equal(new Set(result.created.map((object) => object.id)).size, 3);
  assert.equal(new Set(result.created.map((object) => object.structureId)).size, 3);
  assert.equal(result.created.some((object) => sourceStructureIds.has(object.structureId)), false);
  const floor = result.created.find((object) => object.type === 'floor');
  const wall = result.created.find((object) => object.type === 'wall');
  const roof = result.created.find((object) => object.type === 'roof');
  assert.deepEqual(floor.position, { x: 10, y: 7, z: 20 });
  assert.deepEqual(floor.ys, [0, 0, 0, 0]);
  assert.equal(floor.level, 1);
  assert.deepEqual(wall.ys, [0, 0]);
  assert.equal(wall.level, 1);
  assert.equal(roof.coversLevel, 1);
  assert.equal(roof.level, 2);
  assert.equal(roof.position.y, 9);

  const saveFile = path.join(saveDir, 'map_state.json');
  const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  const grouped = Object.values(saved.maps['@world'].objects)
    .filter((object) => object.buildingId === buildingId);
  assert.equal(grouped.length, 6);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(saveFile + '.bak', 'utf8')));
});

test('duplicate-storey rejects inconsistent grouped level heights and stair rise', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-storey-rise-reject-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  const inconsistentBuilding = 'building-duplicate-level-height-reject';
  const stairBuilding = 'building-duplicate-stair-rise-reject';
  const stairEndpointBuilding = 'building-duplicate-stair-endpoint-reject';
  const roofEndpointBuilding = 'building-duplicate-roof-endpoint-reject';
  const terrainStoreyBuilding = 'building-duplicate-upper-terrain-reject';
  const fixtureObjects = {
    'legacy-rise-source-a': {
      id: 'legacy-rise-source-a', type: 'floor', buildingId: inconsistentBuilding,
      buildingDatumY: 5, structureId: 'structure-inconsistent-source-0',
      level: 0, levelHeight: 2, heightMode: 'flat',
      position: { x: 0, y: 5, z: 0 }, cols: 1, rows: 1
    },
    'legacy-rise-source-b': {
      id: 'legacy-rise-source-b', type: 'floor', buildingId: inconsistentBuilding,
      buildingDatumY: 5, structureId: 'structure-inconsistent-source-1',
      level: 0, levelHeight: 3, heightMode: 'flat',
      position: { x: 2, y: 5, z: 0 }, cols: 1, rows: 1
    },
    'legacy-stair-source': {
      id: 'legacy-stair-source', type: 'floor', buildingId: stairBuilding,
      buildingDatumY: 5, structureId: 'structure-stair-rise-source',
      level: 0, levelHeight: 3, heightMode: 'flat',
      position: { x: 10, y: 5, z: 0 }, cols: 1, rows: 1
    },
    'legacy-stair-destination': {
      id: 'legacy-stair-destination', type: 'stair', buildingId: stairBuilding,
      buildingDatumY: 5, structureId: 'structure-bad-stair-rise',
      level: 1, toLevel: 2, levelHeight: 3, heightMode: 'flat',
      position: { x: 12, y: 8, z: 0 }, bx: 1, bz: 0, width: 0.9
    },
    'legacy-stair-endpoint-source': {
      id: 'legacy-stair-endpoint-source', type: 'floor', buildingId: stairEndpointBuilding,
      buildingDatumY: 5, structureId: 'structure-stair-endpoint-source',
      level: 0, levelHeight: 2, heightMode: 'flat',
      position: { x: 14, y: 5, z: 0 }, cols: 1, rows: 1
    },
    'legacy-stair-endpoint-destination': {
      id: 'legacy-stair-endpoint-destination', type: 'stair', buildingId: stairEndpointBuilding,
      buildingDatumY: 5, structureId: 'structure-bad-stair-endpoint',
      level: 1, toLevel: 5, levelHeight: 2, rise: 2, heightMode: 'flat',
      position: { x: 16, y: 7, z: 0 }, bx: 1, bz: 0, width: 0.9
    },
    'legacy-roof-endpoint-source': {
      id: 'legacy-roof-endpoint-source', type: 'roof', buildingId: roofEndpointBuilding,
      buildingDatumY: 5, structureId: 'structure-bad-roof-endpoint',
      level: 10, coversLevel: 0, levelHeight: 2, heightMode: 'flat',
      position: { x: 18, y: 25, z: 0 }, cols: 1, rows: 1
    },
    'legacy-upper-terrain-source': {
      id: 'legacy-upper-terrain-source', type: 'floor', buildingId: terrainStoreyBuilding,
      buildingDatumY: 5, structureId: 'structure-upper-terrain-source',
      level: 1, levelHeight: 2, heightMode: 'terrain',
      position: { x: 20, y: 7, z: 0 }, cols: 1, rows: 1, ys: [0.5]
    }
  };
  fs.writeFileSync(path.join(saveDir, 'map_state.json'), JSON.stringify({
    maps: { '@world': { objects: fixtureObjects, rulers: {} } }
  }, null, 2));

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'GM');
  await pollPackets(session);

  await emitEvent(session, 'structure-batch', {
    requestId: 'duplicate-inconsistent-level-height', action: 'duplicate-storey',
    buildingId: inconsistentBuilding, buildingDatumY: 5,
    sourceLevel: 0, destinationLevel: 1,
    expectedSourceIds: ['legacy-rise-source-a', 'legacy-rise-source-b'],
    expectedDestinationIds: [], allowOccupiedDestination: false
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /inconsistent storey rise/
  );

  await emitEvent(session, 'structure-batch', {
    requestId: 'duplicate-inconsistent-stair-rise', action: 'duplicate-storey',
    buildingId: stairBuilding, buildingDatumY: 5,
    sourceLevel: 0, destinationLevel: 1,
    expectedSourceIds: ['legacy-stair-source'],
    expectedDestinationIds: ['legacy-stair-destination'],
    allowOccupiedDestination: true
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /inconsistent stair rise/
  );

  await emitEvent(session, 'structure-batch', {
    requestId: 'duplicate-inconsistent-stair-endpoint', action: 'duplicate-storey',
    buildingId: stairEndpointBuilding, buildingDatumY: 5,
    sourceLevel: 0, destinationLevel: 1,
    expectedSourceIds: ['legacy-stair-endpoint-source'],
    expectedDestinationIds: ['legacy-stair-endpoint-destination'],
    allowOccupiedDestination: true
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /inconsistent stair rise/
  );

  await emitEvent(session, 'structure-batch', {
    requestId: 'duplicate-inconsistent-roof-endpoint', action: 'duplicate-storey',
    buildingId: roofEndpointBuilding, buildingDatumY: 5,
    sourceLevel: 0, destinationLevel: 1,
    expectedSourceIds: ['legacy-roof-endpoint-source'],
    expectedDestinationIds: [], allowOccupiedDestination: false
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /inconsistent roof level/
  );

  await emitEvent(session, 'structure-batch', {
    requestId: 'duplicate-upper-terrain-storey', action: 'duplicate-storey',
    buildingId: terrainStoreyBuilding, buildingDatumY: 5,
    sourceLevel: 1, destinationLevel: 2,
    expectedSourceIds: ['legacy-upper-terrain-source'],
    expectedDestinationIds: [], allowOccupiedDestination: false
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /invalid terrain-following storey/
  );

  const liveBuilding = 'building-add-invariant-reject';
  await emitEvent(session, 'add-object', {
    type: 'floor', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-valid', level: 0, levelHeight: 2,
    heightMode: 'flat', position: { x: 20, y: 5, z: 0 }, cols: 1, rows: 1
  });
  await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'add-object', {
    type: 'floor', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-bad-level-height', level: 0, levelHeight: 3,
    heightMode: 'flat', position: { x: 22, y: 5, z: 0 }, cols: 1, rows: 1
  });
  assert.match(await waitForSocketEvent(session, 'error'), /inconsistent storey rise/);
  await emitEvent(session, 'add-object', {
    type: 'stair', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-bad-stair-rise', level: 0, toLevel: 1,
    levelHeight: 2, rise: 3, heightMode: 'flat',
    position: { x: 24, y: 5, z: 0 }, bx: 1, bz: 0, width: 0.9
  });
  assert.match(await waitForSocketEvent(session, 'error'), /inconsistent stair rise/);
  await emitEvent(session, 'add-object', {
    type: 'stair', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-bad-stair-endpoint', level: 0, toLevel: 5,
    levelHeight: 2, rise: 2, heightMode: 'flat',
    position: { x: 25, y: 5, z: 0 }, bx: 1, bz: 0, width: 0.9
  });
  assert.match(await waitForSocketEvent(session, 'error'), /inconsistent stair rise/);
  await emitEvent(session, 'add-object', {
    type: 'roof', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-bad-roof-endpoint', level: 10, coversLevel: 0,
    levelHeight: 2, heightMode: 'flat', position: { x: 26, y: 25, z: 0 },
    cols: 1, rows: 1
  });
  assert.match(await waitForSocketEvent(session, 'error'), /inconsistent roof level/);
  await emitEvent(session, 'add-object', {
    type: 'floor', buildingId: liveBuilding, buildingDatumY: 5,
    structureId: 'structure-live-upper-terrain', level: 1, levelHeight: 2,
    heightMode: 'terrain', position: { x: 27, y: 7, z: 0 },
    cols: 1, rows: 1, ys: [0.5]
  });
  assert.match(await waitForSocketEvent(session, 'error'), /invalid terrain-following storey/);

  const saved = JSON.parse(fs.readFileSync(path.join(saveDir, 'map_state.json'), 'utf8'));
  const grouped = Object.values(saved.maps['@world'].objects);
  assert.equal(grouped.filter((object) => object.buildingId === inconsistentBuilding).length, 2);
  assert.equal(grouped.filter((object) => object.buildingId === stairBuilding).length, 2);
  assert.equal(grouped.filter((object) => object.buildingId === stairEndpointBuilding).length, 2);
  assert.equal(grouped.filter((object) => object.buildingId === roofEndpointBuilding).length, 1);
  assert.equal(grouped.filter((object) => object.buildingId === terrainStoreyBuilding).length, 1);
  assert.equal(grouped.filter((object) => object.buildingId === liveBuilding).length, 1);
});

test('the server rejects adopting pieces with an incompatible rise or datum', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-adopt-reject-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'GM');
  await pollPackets(session);
  const buildingId = 'building-adopt-reject';
  await emitEvent(session, 'add-object', {
    type: 'floor', buildingId, buildingDatumY: 5, structureId: 'structure-existing',
    level: 0, levelHeight: 2, heightMode: 'flat', position: { x: 0, y: 5, z: 0 },
    cols: 1, rows: 1
  });
  await waitForSocketEvent(session, 'object-added');

  await emitEvent(session, 'add-object', {
    type: 'floor', structureId: 'structure-wrong-rise', level: 0, levelHeight: 3,
    heightMode: 'terrain', position: { x: 2, y: 6, z: 0 }, cols: 1, rows: 1
  });
  const wrongRise = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-rise', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongRise.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /incompatible storey rise/
  );

  await emitEvent(session, 'add-object', {
    type: 'stair', structureId: 'structure-wrong-stair-rise',
    level: 0, toLevel: 1, levelHeight: 2, rise: 3,
    heightMode: 'flat', position: { x: 3, y: 5, z: 0 }, bx: 1, bz: 0, width: 0.9
  });
  const wrongStairRise = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-stair-rise', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongStairRise.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /incompatible rise/
  );

  await emitEvent(session, 'add-object', {
    type: 'stair', structureId: 'structure-wrong-stair-endpoint',
    level: 0, toLevel: 5, levelHeight: 2, rise: 2,
    heightMode: 'flat', position: { x: 3.5, y: 5, z: 0 }, bx: 1, bz: 0, width: 0.9
  });
  const wrongStairEndpoint = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-stair-endpoint', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongStairEndpoint.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /incompatible rise/
  );

  await emitEvent(session, 'add-object', {
    type: 'roof', structureId: 'structure-wrong-roof-endpoint',
    level: 10, coversLevel: 0, levelHeight: 2,
    heightMode: 'flat', position: { x: 3.75, y: 25, z: 0 }, cols: 1, rows: 1
  });
  const wrongRoofEndpoint = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-roof-endpoint', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongRoofEndpoint.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /roof covers an incompatible storey/
  );

  await emitEvent(session, 'add-object', {
    type: 'floor', structureId: 'structure-wrong-height-mode',
    level: 1, levelHeight: 2, heightMode: 'terrain',
    position: { x: 3.9, y: 7, z: 0 }, cols: 1, rows: 1, ys: [0.5]
  });
  const wrongHeightMode = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-height-mode', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongHeightMode.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /invalid terrain-following storey/
  );

  await emitEvent(session, 'add-object', {
    type: 'floor', structureId: 'structure-wrong-datum', level: 1, levelHeight: 2,
    heightMode: 'flat', position: { x: 4, y: 9, z: 0 }, cols: 1, rows: 1
  });
  const wrongDatum = await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-wrong-datum', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [wrongDatum.id]
  });
  assert.match(
    (await waitForSocketEvent(session, 'structure-batch-rejected')).reason,
    /incompatible building datum/
  );

  const saved = JSON.parse(fs.readFileSync(path.join(saveDir, 'map_state.json'), 'utf8'));
  assert.equal(saved.maps['@world'].objects[wrongRise.id].buildingId, undefined);
  assert.equal(saved.maps['@world'].objects[wrongStairRise.id].buildingId, undefined);
  assert.equal(saved.maps['@world'].objects[wrongStairEndpoint.id].buildingId, undefined);
  assert.equal(saved.maps['@world'].objects[wrongRoofEndpoint.id].buildingId, undefined);
  assert.equal(saved.maps['@world'].objects[wrongHeightMode.id].buildingId, undefined);
  assert.equal(saved.maps['@world'].objects[wrongDatum.id].buildingId, undefined);
});

test('the server allows adopting a terrain-following legacy level-0 piece', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-adopt-legacy-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'GM');
  await pollPackets(session);
  const buildingId = 'building-adopt-legacy';
  await emitEvent(session, 'add-object', {
    type: 'floor', buildingId, buildingDatumY: 5, structureId: 'structure-existing-legacy-test',
    level: 0, levelHeight: 2, heightMode: 'flat', position: { x: 0, y: 5, z: 0 },
    cols: 1, rows: 1
  });
  await waitForSocketEvent(session, 'object-added');
  await emitEvent(session, 'add-object', {
    type: 'floor', structureId: 'structure-legacy-terrain', level: 0, levelHeight: 2,
    heightMode: 'terrain', position: { x: 2, y: 6.25, z: 0 },
    cols: 2, rows: 1, ys: [1.25, 0.75]
  });
  const legacy = await waitForSocketEvent(session, 'object-added');

  await emitEvent(session, 'structure-batch', {
    requestId: 'adopt-legacy-terrain', action: 'adopt', buildingId, buildingDatumY: 5,
    objectIds: [legacy.id]
  });
  const applied = await waitForSocketEvent(session, 'structure-batch-applied');
  assert.equal(applied.requestId, 'adopt-legacy-terrain');
  assert.deepEqual(applied.updated, [{ id: legacy.id, patch: {
    buildingId,
    buildingDatumY: 5,
    structureId: 'structure-legacy-terrain'
  } }]);

  const saved = JSON.parse(fs.readFileSync(path.join(saveDir, 'map_state.json'), 'utf8'));
  const adopted = saved.maps['@world'].objects[legacy.id];
  assert.equal(adopted.buildingId, buildingId);
  assert.equal(adopted.buildingDatumY, 5);
  assert.equal(adopted.heightMode, 'terrain');
  assert.equal(adopted.position.y, 6.25);
  assert.deepEqual(adopted.ys, [1.25, 0.75]);
});

test('a syntactically or semantically corrupt primary recovers from a valid backup', { timeout: 25000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-recovery-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const saveFile = path.join(saveDir, 'map_state.json');
  fs.writeFileSync(saveFile, JSON.stringify({ maps: {
    '@world': { objects: {
      safe: { id: 'safe', type: 'cube', name: 'backup-marker', position: { x: 0, y: 0, z: 0 } }
    }, rulers: {}, fog: {} },
    world: { objects: {}, rulers: {} }
  } }, null, 2));
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const firstSession = await connectPolling(instance.port);
  await emitEvent(firstSession, 'login', 'GM');
  await pollPackets(firstSession);
  await emitEvent(firstSession, 'add-object', {
    type: 'cube', name: 'new-primary-only', position: { x: 2, y: 0, z: 2 }
  });
  await waitForSocketEvent(firstSession, 'object-added');
  // A parseable but structurally invalid primary must not replace the valid
  // backup if another save happens before the process restarts.
  fs.writeFileSync(saveFile, '{"maps":[]}');
  await emitEvent(firstSession, 'add-object', {
    type: 'cube', name: 'after-semantic-corruption', position: { x: 3, y: 0, z: 3 }
  });
  await waitForSocketEvent(firstSession, 'object-added');
  const preservedBackup = JSON.parse(fs.readFileSync(saveFile + '.bak', 'utf8'));
  assert.equal(Array.isArray(preservedBackup.maps), false);
  assert.ok(preservedBackup.maps['@world'].objects.safe);
  await stopServer(instance);
  assert.ok(fs.existsSync(saveFile + '.bak'));
  fs.writeFileSync(saveFile, '{corrupt');

  instance = await startServer(saveDir);
  const recoveredSession = await connectPolling(instance.port);
  await emitEvent(recoveredSession, 'login', 'GM');
  const recoveredState = await waitForSocketEvent(recoveredSession, 'map-state');
  assert.ok(recoveredState.objects.some((object) => object.name === 'backup-marker'));
  assert.equal(recoveredState.objects.some((object) => object.name === 'new-primary-only'), false);
  assert.equal(recoveredState.objects.some((object) => object.name === 'after-semantic-corruption'), false);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(saveFile, 'utf8')));

  await stopServer(instance);
  fs.writeFileSync(saveFile, '{"maps":[]}');
  instance = await startServer(saveDir);
  const semanticSession = await connectPolling(instance.port);
  await emitEvent(semanticSession, 'login', 'GM');
  const semanticState = await waitForSocketEvent(semanticSession, 'map-state');
  assert.ok(semanticState.objects.some((object) => object.name === 'backup-marker'));
  const restored = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  assert.equal(Array.isArray(restored.maps), false);
  assert.ok(restored.maps['@world']);
});

test('legacy malformed combats normalize before state delivery or rule execution', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-legacy-combat-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, 'map_state.json'), JSON.stringify({ maps: {
    '@world': {
      objects: {}, rulers: {},
      combat: {
        active: true, started: false, round: '<img src=x onerror=alert(1)>',
        activeId: null, order: { malformed: true }, log: { malformed: true },
        combatants: {
          legacy: {
            id: 'legacy', kind: 'character', owner: 'GM', charId: 'private-id',
            name: 'Legacy Hero', color: '#fff" onmouseover="alert(1)',
            effects: [null, { key: 'poisoned' }, { key: 'not-a-condition' }],
            attacks: [{ name: 'Claw', attack: '5" title="owned', damage: '1d6' }],
            spells: [{ name: 'Bolt', level: '2" onclick="owned', damage: '1d4' }],
            saves: null, slots: null, privateSentinel: 'never-send-me'
          }
        }
      }
    }
  } }, null, 2));
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  const gmState = await waitForSocketEvent(gm, 'map-state');
  const gmCombatant = gmState.combat.combatants.legacy;
  assert.deepEqual(gmState.combat.order, []);
  assert.deepEqual(gmState.combat.log, []);
  assert.deepEqual(gmCombatant.effects, [
    { key: 'poisoned', label: 'Poisoned', auto: false }
  ]);
  assert.equal(gmCombatant.color, '#dd4444');
  assert.equal(gmCombatant.attacks[0].attack, 0);
  assert.equal(gmCombatant.spells[0].level, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(gmCombatant, 'privateSentinel'), false);

  const player = await connectPolling(instance.port);
  await emitEvent(player, 'login', 'alice');
  const playerState = await waitForSocketEvent(player, 'map-state');
  const publicCombatant = playerState.combat.combatants.legacy;
  for (const privateField of ['charId', 'attacks', 'spells', 'privateSentinel']) {
    assert.equal(Object.prototype.hasOwnProperty.call(publicCombatant, privateField), false);
  }

  await emitEvent(gm, 'combat-begin', null);
  const begun = await waitForSocketEvent(gm, 'combat-updated');
  assert.equal(begun.started, true);
  assert.equal(begun.combatants.legacy.effects[0].key, 'poisoned');
});

test('failed map saves roll back core mutations and do not broadcast them', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-save-failure-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const observer = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(observer, 'login', 'GM');
  await pollPackets(observer);

  await emitEvent(gm, 'add-object', {
    type: 'cube', name: 'persisted-object', position: { x: 1, y: 0, z: 1 }
  });
  const persistedObject = await waitForSocketEvent(gm, 'object-added');
  await waitForSocketEvent(observer, 'object-added');

  await emitEvent(gm, 'add-ruler', {
    points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }]
  });
  const persistedRuler = await waitForSocketEvent(gm, 'ruler-added');
  await waitForSocketEvent(observer, 'ruler-added');

  await emitEvent(gm, 'join-map', { key: 'world/0,0/0,0/0,0' });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-terrain', {
    chunks: { '0,0': { heights: 'AAAA' } }
  });
  await emitEvent(gm, 'update-fog', { hexes: ['0,0'], revealed: true });
  await waitForSocketEvent(gm, 'fog-updated');
  await waitForSocketEvent(observer, 'fog-updated');
  await emitEvent(gm, 'join-map', { key: 'world' });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-hex', { q: 0, r: 0, biome: 'forest' });
  await waitForSocketEvent(gm, 'hex-updated');
  await waitForSocketEvent(observer, 'hex-updated');

  const saveFile = path.join(saveDir, 'map_state.json');
  await waitFor(() => fs.existsSync(saveFile), 'the initial map save');
  fs.rmSync(saveFile, { force: true });
  fs.mkdirSync(saveFile);

  await emitEvent(gm, 'add-object', {
    type: 'cube', name: 'failed-add', position: { x: 2, y: 0, z: 2 }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object');

  await emitEvent(gm, 'update-object', {
    id: persistedObject.id, patch: { name: 'failed-rename' }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object update');

  await emitEvent(gm, 'move-object', {
    id: persistedObject.id, position: { x: 99, y: 0, z: 99 }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object move');

  await emitEvent(gm, 'delete-object', { id: persistedObject.id });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object deletion');

  await emitEvent(gm, 'clear-rulers', null);
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not clear the rulers');
  await emitEvent(gm, 'join-map', { key: 'world/0,0/0,0/0,0' });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-terrain', {
    chunks: { '0,0': { heights: 'BBBB' } }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the terrain update');
  await emitEvent(gm, 'reset-terrain', { requestId: 'terrain-reset-save-failure' });
  const resetFailure = await waitForSocketEvent(gm, 'terrain-reset-rejected');
  assert.equal(resetFailure.requestId, 'terrain-reset-save-failure');
  assert.equal(resetFailure.reason, 'Could not save the terrain reset');
  await emitEvent(gm, 'update-fog', { hexes: ['0,0'], revealed: false });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the fog update');
  await emitEvent(gm, 'join-map', { key: 'world' });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(gm, 'update-hex', { q: 0, r: 0, biome: 'desert' });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the hex update');

  await emitEvent(gm, 'join-map', { key: 'world' });
  const state = await waitForSocketEvent(gm, 'map-state');
  const object = state.objects.find((entry) => entry.id === persistedObject.id);
  assert.equal(object.name, 'persisted-object');
  assert.deepEqual(object.position, { x: 1, y: 0, z: 1 });
  assert.equal(state.objects.some((entry) => entry.name === 'failed-add'), false);
  assert.ok(state.rulers.some((entry) => entry.id === persistedRuler.id));
  assert.equal(state.terrain.chunks['0,0'].heights, 'AAAA');
  assert.ok(state.fog.includes('0,0'));
  assert.equal(state.hexes['0,0'].biome, 'forest');

  const observerEvents = socketEvents(await pollPackets(observer));
  const forbidden = new Set([
    'object-added', 'object-updated', 'object-moved', 'object-deleted',
    'rulers-cleared', 'terrain-updated', 'terrain-reset-applied', 'fog-updated', 'hex-updated'
  ]);
  assert.equal(observerEvents.some(([name]) => forbidden.has(name)), false);
  assert.equal(instance.child.exitCode, null);
});

test('failed combat saves restore combat state and discard queued logs', { timeout: 25000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-combat-failure-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const observer = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(observer, 'login', 'GM');
  await pollPackets(observer);

  await emitEvent(gm, 'add-object', {
    type: 'token', name: 'transaction-fighter', color: '#8844cc',
    position: { x: 1, y: 0, z: 1 }
  });
  const fighter = await waitForSocketEvent(gm, 'object-added');
  await waitForSocketEvent(observer, 'object-added');
  await emitEvent(gm, 'combat-start', null);
  const baselineCombat = structuredClone(await waitForSocketEvent(gm, 'combat-updated'));
  await waitForSocketEvent(observer, 'combat-updated');
  assert.equal(baselineCombat.combatants[fighter.id].initiative, null);
  assert.equal(baselineCombat.log.length, 1);

  const saveFile = path.join(saveDir, 'map_state.json');
  fs.rmSync(saveFile, { force: true });
  fs.mkdirSync(saveFile);

  await emitEvent(gm, 'combat-roll-initiative', { combatantId: fighter.id });
  assert.equal((await waitForSocketEvent(gm, 'combat-denied')).reason,
    'Could not save the combat update');

  await emitEvent(gm, 'add-object', {
    type: 'token', name: 'failed-combatant', position: { x: 2, y: 0, z: 2 }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object');
  await emitEvent(gm, 'update-object', {
    id: fighter.id, patch: { name: 'failed-fighter-rename' }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object update');
  await emitEvent(gm, 'delete-object', { id: fighter.id });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not save the object deletion');

  await emitEvent(gm, 'join-map', { key: 'world' });
  const state = await waitForSocketEvent(gm, 'map-state');
  assert.deepEqual(state.combat, baselineCombat);
  assert.equal(state.objects.find((object) => object.id === fighter.id).name,
    'transaction-fighter');
  assert.equal(state.objects.some((object) => object.name === 'failed-combatant'), false);

  const observerEvents = socketEvents(await pollPackets(observer));
  assert.equal(observerEvents.some(([name]) =>
    ['combat-log', 'combat-updated', 'object-added', 'object-updated', 'object-deleted'].includes(name)
  ), false);
  assert.equal(instance.child.exitCode, null);
});

test('failed combat-map saves compensate staged and direct character HP writes', { timeout: 25000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-hp-failure-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const characterFile = path.join(saveDir, 'characters.json');
  fs.writeFileSync(characterFile, JSON.stringify({
    'hp-hero': {
      id: 'hp-hero', owner: 'GM', name: 'HP Hero', hp: { current: 10 }
    }
  }, null, 2));
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const observer = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(observer, 'login', 'GM');
  await pollPackets(observer);
  await emitEvent(gm, 'add-object', {
    type: 'character', characterData: { id: 'hp-hero' },
    position: { x: 1, y: 0, z: 1 }
  });
  const heroToken = await waitForSocketEvent(gm, 'object-added');
  await waitForSocketEvent(observer, 'object-added');
  await emitEvent(gm, 'combat-start', null);
  const baselineCombat = structuredClone(await waitForSocketEvent(gm, 'combat-updated'));
  await waitForSocketEvent(observer, 'combat-updated');
  assert.equal(baselineCombat.combatants[heroToken.id].hp.current, 10);

  const saveFile = path.join(saveDir, 'map_state.json');
  fs.rmSync(saveFile, { force: true });
  fs.mkdirSync(saveFile);

  await emitEvent(gm, 'combat-update-combatant', {
    combatantId: heroToken.id, patch: { hpCurrent: 3 }
  });
  assert.equal((await waitForSocketEvent(gm, 'combat-denied')).reason,
    'Could not save the combat update');
  assert.equal(JSON.parse(fs.readFileSync(characterFile, 'utf8'))['hp-hero'].hp.current, 10);

  await emitEvent(gm, 'update-hp', { id: 'hp-hero', current: 2 });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Could not update character HP');
  assert.equal(JSON.parse(fs.readFileSync(characterFile, 'utf8'))['hp-hero'].hp.current, 10);

  await emitEvent(gm, 'join-map', { key: 'world' });
  const state = await waitForSocketEvent(gm, 'map-state');
  assert.deepEqual(state.combat, baselineCombat);
  await emitEvent(gm, 'get-characters', null);
  const characters = await waitForSocketEvent(gm, 'load-user-characters');
  assert.equal(characters.find((character) => character.id === 'hp-hero').hp.current, 10);

  const observerEvents = socketEvents(await pollPackets(observer));
  assert.equal(observerEvents.some(([name]) =>
    ['hp-updated', 'combat-log', 'combat-updated'].includes(name)
  ), false);
  assert.equal(instance.child.exitCode, null);

  const characterBackup = characterFile + '.bak';
  assert.equal(JSON.parse(fs.readFileSync(characterBackup, 'utf8'))['hp-hero'].hp.current, 10);
  await stopServer(instance);
  fs.rmSync(saveFile, { recursive: true, force: true });
  fs.writeFileSync(characterFile, '{corrupt');

  instance = await startServer(saveDir);
  const recovered = await connectPolling(instance.port);
  await emitEvent(recovered, 'login', 'GM');
  await pollPackets(recovered);
  await emitEvent(recovered, 'get-characters', null);
  const recoveredCharacters = await waitForSocketEvent(recovered, 'load-user-characters');
  assert.equal(recoveredCharacters.find((character) => character.id === 'hp-hero').hp.current, 10);
});

test('staged combat HP commits and rolls back every active combat mirror', { timeout: 35000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-hp-mirrors-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const characterFile = path.join(saveDir, 'characters.json');
  const mapFile = path.join(saveDir, 'map_state.json');
  fs.writeFileSync(characterFile, JSON.stringify({
    'mirror-hero': {
      id: 'mirror-hero', owner: 'GM', name: 'Mirror Hero', hp: { current: 10 }
    }
  }, null, 2));
  const combatFor = (tokenId) => ({
    active: true, started: false, round: 0, activeId: null, order: [], log: [],
    combatants: {
      [tokenId]: {
        id: tokenId, kind: 'character', charId: 'mirror-hero', owner: 'GM',
        name: 'Mirror Hero', hp: { current: 10 }, maxHP: 10,
        effects: [], statsPending: false
      }
    }
  });
  const pocketFor = (tokenId, name) => ({
    objects: {
      [tokenId]: {
        id: tokenId, type: 'character', position: { x: 0, y: 0, z: 0 },
        characterData: { id: 'mirror-hero', owner: 'GM', name: 'Mirror Hero' }
      }
    },
    rulers: {},
    meta: { kind: 'pocket', name, width: 16, height: 16, parentKey: 'world' },
    combat: combatFor(tokenId)
  });
  fs.writeFileSync(mapFile, JSON.stringify({ maps: {
    world: { objects: {}, rulers: {} },
    'pocket/a': pocketFor('token-a', 'Pocket A'),
    'pocket/b': pocketFor('token-b', 'Pocket B')
  } }, null, 2));

  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  let socketA = await connectPolling(instance.port);
  let socketB = await connectPolling(instance.port);
  const unrelated = await connectPolling(instance.port);
  const anonymous = await connectPolling(instance.port);
  await emitEvent(socketA, 'login', 'GM');
  await pollPackets(socketA);
  await emitEvent(socketB, 'login', 'GM');
  await pollPackets(socketB);
  await emitEvent(unrelated, 'login', 'alice');
  await pollPackets(unrelated);
  await emitEvent(socketA, 'join-map', { key: 'pocket/a' });
  await waitForSocketEvent(socketA, 'map-state');
  await emitEvent(socketB, 'join-map', { key: 'pocket/b' });
  await waitForSocketEvent(socketB, 'map-state');
  await pollPackets(unrelated);

  await emitEvent(socketA, 'combat-update-combatant', {
    combatantId: 'token-a', patch: { hpCurrent: 6 }
  });
  const committedA = await waitForSocketEvent(socketA, 'combat-updated');
  const committedB = await waitForSocketEvent(socketB, 'combat-updated');
  assert.equal(committedA.combatants['token-a'].hp.current, 6);
  assert.equal(committedB.combatants['token-b'].hp.current, 6);
  await emitEvent(socketA, 'join-map', { key: 'pocket/a' });
  await waitForSocketEvent(socketA, 'map-state');
  // A logged-out socket is sent nothing at all (not even the lobby list), so
  // silence within a settle window is its proof of privacy.
  for (const privacySession of [unrelated, anonymous]) {
    const privacyEvents = socketEvents(await Promise.race([
      pollPackets(privacySession).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 1500))
    ]));
    assert.equal(privacyEvents.some(([name]) => name === 'hp-updated'), false);
  }
  let persisted = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  assert.equal(persisted.maps['pocket/a'].combat.combatants['token-a'].hp.current, 6);
  assert.equal(persisted.maps['pocket/b'].combat.combatants['token-b'].hp.current, 6);
  assert.equal(JSON.parse(fs.readFileSync(characterFile, 'utf8'))['mirror-hero'].hp.current, 6);
  const recoveryCharacters = JSON.parse(fs.readFileSync(characterFile + '.bak', 'utf8'));
  const recoveryMaps = JSON.parse(fs.readFileSync(mapFile + '.bak', 'utf8'));
  assert.equal(recoveryCharacters['mirror-hero'].hp.current, 6);
  assert.equal(recoveryMaps.maps['pocket/a'].combat.combatants['token-a'].hp.current, 6);
  assert.equal(recoveryMaps.maps['pocket/b'].combat.combatants['token-b'].hp.current, 6);

  await stopServer(instance);
  fs.writeFileSync(characterFile, '{corrupt');
  instance = await startServer(saveDir);
  socketA = await connectPolling(instance.port);
  socketB = await connectPolling(instance.port);
  await emitEvent(socketA, 'login', 'GM');
  await pollPackets(socketA);
  await emitEvent(socketB, 'login', 'GM');
  await pollPackets(socketB);
  await emitEvent(socketA, 'join-map', { key: 'pocket/a' });
  const reloadedA = await waitForSocketEvent(socketA, 'map-state');
  await emitEvent(socketB, 'join-map', { key: 'pocket/b' });
  const reloadedB = await waitForSocketEvent(socketB, 'map-state');
  assert.equal(reloadedA.combat.combatants['token-a'].hp.current, 6);
  assert.equal(reloadedB.combat.combatants['token-b'].hp.current, 6);
  await emitEvent(socketA, 'get-characters', null);
  let recoveredCharacters = await waitForSocketEvent(socketA, 'load-user-characters');
  assert.equal(recoveredCharacters.find(character => character.id === 'mirror-hero').hp.current, 6);

  // The matched post-commit map backup must independently recover the same
  // logical HP/action state while the character primary remains current.
  await stopServer(instance);
  fs.writeFileSync(mapFile, '{corrupt');
  instance = await startServer(saveDir);
  socketA = await connectPolling(instance.port);
  socketB = await connectPolling(instance.port);
  await emitEvent(socketA, 'login', 'GM');
  await pollPackets(socketA);
  await emitEvent(socketB, 'login', 'GM');
  await pollPackets(socketB);
  await emitEvent(socketA, 'join-map', { key: 'pocket/a' });
  const mapRecoveredA = await waitForSocketEvent(socketA, 'map-state');
  await emitEvent(socketB, 'join-map', { key: 'pocket/b' });
  const mapRecoveredB = await waitForSocketEvent(socketB, 'map-state');
  assert.equal(mapRecoveredA.combat.combatants['token-a'].hp.current, 6);
  assert.equal(mapRecoveredB.combat.combatants['token-b'].hp.current, 6);
  await emitEvent(socketA, 'get-characters', null);
  recoveredCharacters = await waitForSocketEvent(socketA, 'load-user-characters');
  assert.equal(recoveredCharacters.find(character => character.id === 'mirror-hero').hp.current, 6);

  fs.rmSync(mapFile, { force: true });
  fs.mkdirSync(mapFile);
  await emitEvent(socketA, 'combat-update-combatant', {
    combatantId: 'token-a', patch: { hpCurrent: 2 }
  });
  assert.equal((await waitForSocketEvent(socketA, 'combat-denied')).reason,
    'Could not save the combat update');
  await emitEvent(socketA, 'join-map', { key: 'pocket/a' });
  const rolledBackA = await waitForSocketEvent(socketA, 'map-state');
  const observerEvents = socketEvents(await pollPackets(socketB));
  assert.equal(observerEvents.some(([name]) =>
    ['hp-updated', 'combat-updated'].includes(name)
  ), false);
  await emitEvent(socketB, 'join-map', { key: 'pocket/b' });
  const rolledBackB = await waitForSocketEvent(socketB, 'map-state');
  assert.equal(rolledBackA.combat.combatants['token-a'].hp.current, 6);
  assert.equal(rolledBackB.combat.combatants['token-b'].hp.current, 6);
  assert.equal(JSON.parse(fs.readFileSync(characterFile, 'utf8'))['mirror-hero'].hp.current, 6);
});

test('creating and ending a character combat refresh matched recovery snapshots', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-combat-recovery-generation-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  const characterFile = path.join(saveDir, 'characters.json');
  const mapFile = path.join(saveDir, 'map_state.json');
  fs.writeFileSync(characterFile, JSON.stringify({
    'recovery-hero': {
      id: 'recovery-hero', owner: 'GM', name: 'Recovery Hero', hp: { current: 10 }
    }
  }, null, 2));
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  let gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(gm, 'update-hp', { id: 'recovery-hero', current: 6 });
  assert.equal((await waitForSocketEvent(gm, 'hp-updated')).current, 6);
  // This single-file update deliberately leaves the previous HP (10) in its
  // normal backup until a combat creates a cross-file dependency.
  assert.equal(JSON.parse(fs.readFileSync(characterFile + '.bak', 'utf8'))['recovery-hero'].hp.current, 10);

  await emitEvent(gm, 'add-object', {
    type: 'character', characterData: { id: 'recovery-hero' },
    position: { x: 0, y: 0, z: 0 }
  });
  const token = await waitForSocketEvent(gm, 'object-added');
  await emitEvent(gm, 'combat-start', null);
  const combat = await waitForSocketEvent(gm, 'combat-updated');
  assert.equal(combat.combatants[token.id].hp.current, 6);

  // A stale or crafted creator save cannot bypass the transactional HP path
  // and diverge the saved sheet from its active combat mirror.
  await emitEvent(gm, 'save-character', { charData: {
    id: 'recovery-hero', name: 'Recovery Hero Renamed', hp: { current: 1 }
  } });
  const editedSheet = await waitForSocketEvent(gm, 'character-saved-success');
  assert.equal(editedSheet.hp.current, 6);
  await emitEvent(gm, 'join-map', { key: 'world' });
  const afterSheetEdit = await waitForSocketEvent(gm, 'map-state');
  assert.equal(afterSheetEdit.combat.combatants[token.id].hp.current, 6);

  const characterRecovery = JSON.parse(fs.readFileSync(characterFile + '.bak', 'utf8'));
  const mapRecovery = JSON.parse(fs.readFileSync(mapFile + '.bak', 'utf8'));
  assert.equal(characterRecovery['recovery-hero'].hp.current, 6);
  assert.equal(mapRecovery.maps['@world'].combat.combatants[token.id].hp.current, 6);

  await stopServer(instance);
  fs.writeFileSync(characterFile, '{corrupt');
  instance = await startServer(saveDir);
  gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  const state = await waitForSocketEvent(gm, 'map-state');
  assert.equal(state.combat.combatants[token.id].hp.current, 6);
  await emitEvent(gm, 'get-characters', null);
  let characters = await waitForSocketEvent(gm, 'load-user-characters');
  assert.equal(characters.find(character => character.id === 'recovery-hero').hp.current, 6);

  // Removing the last character mirror must also replace the recovery map.
  // Otherwise a later map-primary recovery can resurrect an obsolete combat.
  await emitEvent(gm, 'combat-end', null);
  assert.equal(await waitForSocketEvent(gm, 'combat-updated'), null);
  assert.equal(JSON.parse(fs.readFileSync(mapFile + '.bak', 'utf8')).maps['@world'].combat, undefined);
  await emitEvent(gm, 'update-hp', { id: 'recovery-hero', current: 4 });
  assert.equal((await waitForSocketEvent(gm, 'hp-updated')).current, 4);

  await stopServer(instance);
  fs.writeFileSync(mapFile, '{corrupt');
  instance = await startServer(saveDir);
  gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  const noResurrectedCombat = await waitForSocketEvent(gm, 'map-state');
  assert.equal(noResurrectedCombat.combat, null);
  await emitEvent(gm, 'get-characters', null);
  characters = await waitForSocketEvent(gm, 'load-user-characters');
  assert.equal(characters.find(character => character.id === 'recovery-hero').hp.current, 4);
});

// Character and homebrew persistence coverage follows the map/combat
// transaction tests so all real-server fixtures remain serialized.
test('character saves canonicalize malicious nested values without breaking the creator schema', { timeout: 20000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-character-shape-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const session = await connectPolling(instance.port);
  await emitEvent(session, 'login', 'alice');
  await pollPackets(session);
  await emitEvent(session, 'save-character', { charData: {
    id: 'client-selected-id',
    name: '<img src=x onerror=alert(1)>',
    schemaVersion: { malicious: true },
    race: { toString: '<svg onload=alert(1)>' },
    background: 'acolyte',
    classes: [
      { class: 'wizard', level: '<img src=x>' },
      { class: 'fighter', subclass: { evil: true }, level: 999 },
      { class: '"><svg-onload>', level: 4 },
      null
    ],
    abilityMethod: ['manual'],
    abilities: {
      str: '<script>alert(1)</script>', dex: '18', con: {}, int: null, wis: -999, cha: 40
    },
    racialChoice: ['str', { evil: true }, '<img>', 'str', 'dex'],
    skills: { 0: 'perception' },
    appearance: {
      height: '<img>', build: '1.25', headSize: {}, armLength: -10, legLength: 99,
      colors: { skin: '"><img src=x>', hair: '#abcdef', torso: '#123456', legs: [], eyes: null }
    },
    equipment: {
      armor: { evil: true }, shield: 'false',
      weapons: ['longsword', { evil: true }, '<img>', 'longsword'],
      items: 'backpack'
    },
    spells: [{ evil: true }, 'magic-missile', '<svg-onload>'],
    hp: { current: '<img>' },
    unexpected: { markup: '<script>alert(1)</script>' }
  } });
  const events = socketEvents(await pollPackets(session));
  const saved = events.find(([name]) => name === 'character-saved-success')?.[1];
  assert.ok(saved, `expected save success, got ${JSON.stringify(events)}`);
  assert.notEqual(saved.id, 'client-selected-id');
  assert.equal(saved.owner, 'alice');
  assert.equal(saved.name, '<img src=x onerror=alert(1)>');
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.race, 'human');
  assert.deepEqual(saved.classes, [
    { class: 'wizard', subclass: null, level: 1 },
    { class: 'fighter', subclass: null, level: 20 }
  ]);
  assert.deepEqual(saved.abilities, { str: 8, dex: 18, con: 8, int: 8, wis: 1, cha: 30 });
  assert.deepEqual(saved.stats, saved.abilities);
  assert.deepEqual(saved.racialChoice, ['str', 'dex']);
  assert.deepEqual(saved.skills, []);
  assert.deepEqual(saved.appearance, {
    height: 1, build: 1.25, headSize: 1, armLength: 0.5, legLength: 2,
    colors: {
      skin: '#c68642', hair: '#abcdef', torso: '#123456', legs: '#3a3f4a', eyes: '#1a1a1a'
    }
  });
  assert.deepEqual(saved.equipment, {
    armor: null, shield: false, weapons: ['longsword'], items: []
  });
  assert.deepEqual(saved.spells, ['magic-missile']);
  assert.equal(saved.color, '#123456');
  assert.equal(saved.hp, undefined);
  assert.equal(saved.unexpected, undefined);
  const { name, ...nonDisplayFields } = saved;
  assert.doesNotMatch(JSON.stringify(nonDisplayFields), /[<>]/);

  const persisted = JSON.parse(fs.readFileSync(path.join(saveDir, 'characters.json'), 'utf8'));
  assert.deepEqual(persisted[saved.id], saved);
});

test('failed character and homebrew saves roll back and emit no success or shared change', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-private-save-failure-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const owner = await connectPolling(instance.port);
  const observer = await connectPolling(instance.port);
  await emitEvent(owner, 'login', 'alice');
  await pollPackets(owner);
  await emitEvent(observer, 'login', 'GM');
  await pollPackets(observer);

  await emitEvent(owner, 'save-character', { charData: {
    name: 'Persisted hero', race: 'human', classes: [{ class: 'fighter', level: 1 }],
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hp: { current: 7 }
  } });
  let ownerEvents = socketEvents(await pollPackets(owner));
  const character = ownerEvents.find(([name]) => name === 'character-saved-success')?.[1];
  assert.ok(character);

  await emitEvent(owner, 'save-homebrew', { type: 'race', data: {
    name: 'Persisted ancestry', size: 'Medium', speed: 30,
    ability_bonuses: [], traits: [{ name: 'Careful' }]
  } });
  ownerEvents = socketEvents(await pollPackets(owner));
  const homebrew = ownerEvents.find(([name]) => name === 'homebrew-saved-success')?.[1]?.data;
  assert.ok(homebrew);

  // Drain the observer's two successful shared-change notifications.
  await emitEvent(observer, 'get-characters', null);
  await emitEvent(observer, 'get-homebrew', null);
  await pollPackets(observer);

  const characterFile = path.join(saveDir, 'characters.json');
  fs.rmSync(characterFile, { force: true });
  fs.mkdirSync(characterFile);

  await emitEvent(owner, 'save-character', { charData: {
    ...character, name: 'Failed rename'
  } });
  ownerEvents = socketEvents(await pollPackets(owner));
  assert.equal(ownerEvents.find(([name]) => name === 'error')?.[1], 'Could not save the character');
  assert.equal(ownerEvents.some(([name]) => name === 'character-saved-success'), false);
  await emitEvent(observer, 'get-characters', null);
  let observerEvents = socketEvents(await pollPackets(observer));
  assert.equal(observerEvents.some(([name]) => name === 'character-updated'), false);
  let roster = observerEvents.find(([name]) => name === 'load-user-characters')?.[1];
  assert.equal(roster.find(entry => entry.id === character.id).name, 'Persisted hero');

  await emitEvent(owner, 'update-hp', { id: character.id, current: 1 });
  ownerEvents = socketEvents(await pollPackets(owner));
  assert.equal(ownerEvents.find(([name]) => name === 'error')?.[1], 'Could not update character HP');
  assert.equal(ownerEvents.some(([name]) => name === 'hp-updated'), false);
  await emitEvent(observer, 'get-characters', null);
  observerEvents = socketEvents(await pollPackets(observer));
  assert.equal(observerEvents.some(([name]) => name === 'hp-updated'), false);
  roster = observerEvents.find(([name]) => name === 'load-user-characters')?.[1];
  assert.equal(roster.find(entry => entry.id === character.id).hp.current, 7);

  await emitEvent(owner, 'delete-character', character.id);
  ownerEvents = socketEvents(await pollPackets(owner));
  assert.equal(ownerEvents.find(([name]) => name === 'error')?.[1], 'Could not delete the character');
  await emitEvent(observer, 'get-characters', null);
  observerEvents = socketEvents(await pollPackets(observer));
  assert.equal(observerEvents.some(([name]) => name === 'character-deleted'), false);
  roster = observerEvents.find(([name]) => name === 'load-user-characters')?.[1];
  assert.ok(roster.some(entry => entry.id === character.id));

  const homebrewFile = path.join(saveDir, 'homebrew.json');
  fs.rmSync(homebrewFile, { force: true });
  fs.mkdirSync(homebrewFile);

  await emitEvent(owner, 'save-homebrew', { type: 'race', data: {
    ...homebrew, name: 'Failed ancestry rename'
  } });
  ownerEvents = socketEvents(await pollPackets(owner));
  assert.equal(ownerEvents.find(([name]) => name === 'error')?.[1], 'Could not save homebrew');
  assert.equal(ownerEvents.some(([name]) => name === 'homebrew-saved-success'), false);
  await emitEvent(observer, 'get-homebrew', null);
  observerEvents = socketEvents(await pollPackets(observer));
  let homebrewLoads = observerEvents.filter(([name]) => name === 'load-homebrew');
  assert.equal(homebrewLoads.length, 1, 'a failed edit must not broadcast homebrew');
  let races = homebrewLoads[0][1].races;
  assert.equal(races.find(entry => entry.index === homebrew.index).name, 'Persisted ancestry');

  await emitEvent(owner, 'delete-homebrew', { type: 'race', index: homebrew.index });
  ownerEvents = socketEvents(await pollPackets(owner));
  assert.equal(ownerEvents.find(([name]) => name === 'error')?.[1], 'Could not delete homebrew');
  await emitEvent(observer, 'get-homebrew', null);
  observerEvents = socketEvents(await pollPackets(observer));
  homebrewLoads = observerEvents.filter(([name]) => name === 'load-homebrew');
  assert.equal(homebrewLoads.length, 1, 'a failed delete must not broadcast homebrew');
  races = homebrewLoads[0][1].races;
  assert.ok(races.some(entry => entry.index === homebrew.index));
  assert.equal(instance.child.exitCode, null);
});

test('custom monsters canonicalize, seed combat, enforce GM placement, and survive restart', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-monster-feature-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);

  await emitEvent(gm, 'create-pocket-map', {
    name: 'Monster fixture', width: 24, height: 24, parentKey: 'world'
  });
  const pocket = await waitForSocketEvent(gm, 'pocket-created');
  await emitEvent(gm, 'join-map', { key: pocket.key });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(player, 'join-map', { key: pocket.key });
  await waitForSocketEvent(player, 'map-state');

  const submittedMonster = {
    index: 'client-selected-monster-id',
    name: '  Embermaw\u0000  ',
    size: 'Large',
    type: 'dragon',
    alignment: 'chaotic evil',
    color: 'javascript:alert(1)',
    armor_class: [{ type: 'natural', value: 17 }],
    hit_points: 123,
    hit_dice: '11d10+33',
    speed: { walk: '45 ft.', fly: '90 ft.', 'bad key': '9999 ft.' },
    challenge_rating: '7',
    xp: { malicious: true },
    strength: 16,
    dexterity: 18,
    constitution: 14,
    intelligence: 8,
    wisdom: 12,
    charisma: 6,
    proficiencies: [
      { value: 9, proficiency: { index: 'saving-throw-dex', name: 'Saving Throw: DEX' } },
      { value: 30, proficiency: { index: 'saving-throw-int', name: 'Saving Throw: INT' } },
      { value: { malicious: true }, proficiency: { index: 'saving-throw-wis' } }
    ],
    damage_resistances: ['fire', { malicious: true }, 'poison'],
    senses: { darkvision: '120 ft.', passive_perception: 16, invalid: { malicious: true } },
    special_abilities: [{ name: 'Heat Haze', desc: 'Attack rolls against Embermaw have disadvantage.' }],
    actions: [
      {
        name: 'Claw',
        desc: 'Melee Weapon Attack: reach 10 ft.',
        attack_bonus: 8,
        attack_type: 'melee',
        range_ft: 10,
        damage: [
          {
            damage_dice: ' 2d6 + 4 ',
            damage_type: { index: 'slashing', name: 'Slashing' }
          },
          {
            damage_dice: '1d4',
            damage_type: { index: 'fire', name: 'Fire' }
          }
        ],
        unexpected: '<img src=x onerror=alert(1)>'
      },
      { name: { malicious: true }, attack_bonus: 99 }
    ],
    source: 'untrusted',
    owner: 'mallory',
    custom: false,
    unexpected: '<svg onload=alert(1)>'
  };

  await emitEvent(gm, 'save-homebrew', { type: 'monster', data: submittedMonster });
  const saved = (await waitForSocketEvent(gm, 'homebrew-saved-success')).data;
  assert.match(saved.index, /^hb-monster-[a-f0-9]{8}$/);
  assert.equal(saved.name, 'Embermaw');
  assert.equal(saved.owner, 'GM');
  assert.equal(saved.custom, true);
  assert.equal(saved.source, 'homebrew');
  assert.equal(saved.color, '#b45309');
  assert.deepEqual(saved.armor_class, [{ type: 'natural', value: 17 }]);
  assert.equal(saved.hit_points, 123);
  assert.equal(saved.challenge_rating, 7);
  assert.equal(saved.xp, 0);
  assert.deepEqual(saved.speed, { walk: '45 ft.', fly: '90 ft.' });
  assert.deepEqual(saved.damage_resistances, ['fire', 'poison']);
  assert.deepEqual(saved.proficiencies, [
    { value: 9, proficiency: { index: 'saving-throw-dex', name: 'Saving Throw: DEX' } },
    { value: 30, proficiency: { index: 'saving-throw-int', name: 'Saving Throw: INT' } }
  ]);
  assert.deepEqual(saved.actions, [{
    name: 'Claw',
    desc: 'Melee Weapon Attack: reach 10 ft.',
    attack_bonus: 8,
    attack_type: 'melee',
    range_ft: 10,
    damage: [
      { damage_dice: '2d6+4', damage_type: { index: 'slashing', name: 'Slashing' } },
      { damage_dice: '1d4', damage_type: { index: 'fire', name: 'Fire' } }
    ]
  }]);
  assert.equal(saved.unexpected, undefined);

  await emitEvent(gm, 'get-homebrew', null);
  const homebrew = await waitForSocketEvent(gm, 'load-homebrew');
  assert.deepEqual(homebrew.monsters, [saved]);
  await emitEvent(player, 'get-homebrew', null);
  const playerHomebrew = await waitForSocketEvent(player, 'load-homebrew');
  assert.deepEqual(playerHomebrew.monsters, [], 'players must not receive the GM monster library');

  await emitEvent(player, 'add-object', {
    type: 'token', position: { x: 1, y: 0, z: 1 }, monsterData: saved
  });
  assert.equal(await waitForSocketEvent(player, 'error'), 'GM only');

  await emitEvent(gm, 'add-object', {
    type: 'token', position: { x: 2, y: 0.1, z: 2 },
    monsterData: { index: 'not-in-the-srd', name: 'Forged SRD record', source: 'srd-5.1' }
  });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Unknown SRD monster');

  await emitEvent(gm, 'add-object', {
    type: 'token', position: { x: 2, y: 0.1, z: 2 },
    monsterData: { index: 'owlbear', name: 'Forged Owlbear', hit_points: 1, source: 'srd-5.1' }
  });
  const official = await waitForSocketEvent(gm, 'object-added');
  assert.equal(official.monsterData.name, 'Owlbear');
  assert.equal(official.monsterData.hit_points, 59,
    'SRD placement must resolve to the server-owned licensed record');
  await waitForSocketEvent(player, 'object-added');
  await emitEvent(gm, 'delete-object', { id: official.id });
  await waitForSocketEvent(gm, 'object-deleted');
  await waitForSocketEvent(player, 'object-deleted');

  await emitEvent(gm, 'add-object', {
    type: 'token',
    position: { x: 4, y: 0.1, z: -3 },
    monsterData: { ...saved, name: 'Forged copy', hit_points: 1, armor_class: [{ value: 5 }] }
  });
  const placed = await waitForSocketEvent(gm, 'object-added');
  assert.equal(placed.type, 'token');
  assert.equal(placed.name, 'Embermaw');
  assert.equal(placed.color, '#b45309');
  assert.equal(placed.addedBy, 'GM');
  assert.equal(placed.monsterData.index, saved.index);
  assert.equal(placed.monsterData.name, 'Embermaw');
  assert.equal(placed.monsterData.hit_points, 123,
    'placed custom monsters snapshot the server-saved definition');
  assert.deepEqual(placed.monsterData.armor_class, [{ type: 'natural', value: 17 }]);
  const playerPlaced = await waitForSocketEvent(player, 'object-added');
  assert.deepEqual(playerPlaced.monsterData, {
    name: 'Embermaw', size: 'Large', type: 'dragon', color: '#b45309',
    custom: true, source: 'homebrew', public: true
  });

  await emitEvent(gm, 'combat-start', null);
  const combat = await waitForSocketEvent(gm, 'combat-updated');
  const combatant = combat.combatants[placed.id];
  assert.ok(combatant);
  assert.equal(combatant.kind, 'token');
  assert.equal(combatant.name, 'Embermaw');
  assert.equal(combatant.ac, 17);
  assert.equal(combatant.maxHP, 123);
  assert.deepEqual(combatant.hp, { current: 123 });
  assert.equal(combatant.speedFeet, 45);
  assert.equal(combatant.initMod, 4);
  assert.deepEqual(combatant.saves, { str: 3, dex: 9, con: 2, int: 30, wis: 1, cha: -2 });
  assert.deepEqual(combatant.attacks, [{
    name: 'Claw', attack: 8, damage: '2d6+4', damageType: 'slashing',
    ranged: false, rangeFt: 10,
    damageParts: [
      { damage: '2d6+4', damageType: 'slashing' },
      { damage: '1d4', damageType: 'fire' }
    ]
  }]);
  const playerCombat = await waitForSocketEvent(player, 'combat-updated');
  const publicCombatant = playerCombat.combatants[placed.id];
  assert.equal(Object.hasOwn(publicCombatant, 'attacks'), false);
  assert.equal(Object.hasOwn(publicCombatant, 'saves'), false);

  const persisted = JSON.parse(fs.readFileSync(path.join(saveDir, 'homebrew.json'), 'utf8'));
  assert.deepEqual(persisted.monsters[saved.index], saved);

  await stopServer(instance);
  instance = await startServer(saveDir);
  const reloadedGM = await connectPolling(instance.port);
  await emitEvent(reloadedGM, 'login', 'gm');
  await waitForSocketEvent(reloadedGM, 'login-success');
  await emitEvent(reloadedGM, 'join-map', { key: pocket.key });
  const reloadedState = await waitForSocketEvent(reloadedGM, 'map-state');
  const reloadedCombatant = reloadedState.combat.combatants[placed.id];
  assert.equal(reloadedCombatant.saves.int, 30,
    'monster save modifiers must not narrow after a restart');
  assert.deepEqual(reloadedCombatant.attacks[0].damageParts, combatant.attacks[0].damageParts);
  await emitEvent(reloadedGM, 'get-homebrew', null);
  const reloadedHomebrew = await waitForSocketEvent(reloadedGM, 'load-homebrew');
  assert.deepEqual(reloadedHomebrew.monsters, [saved]);
});

test('Ape model variants canonicalize, project publicly, and survive restart', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-ape-variants-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await pollPackets(gm);
  await emitEvent(player, 'login', 'alice');
  await pollPackets(player);

  await emitEvent(gm, 'create-pocket-map', {
    name: 'Ape variant fixture', width: 20, height: 20, parentKey: 'world'
  });
  const pocket = await waitForSocketEvent(gm, 'pocket-created');
  await emitEvent(gm, 'join-map', { key: pocket.key });
  await waitForSocketEvent(gm, 'map-state');
  await emitEvent(player, 'join-map', { key: pocket.key });
  await waitForSocketEvent(player, 'map-state');

  async function placeSRDMonster(index, x, monsterVariant) {
    const data = {
      type: 'token',
      position: { x, y: 0.1, z: 0 },
      monsterData: { index, name: 'Client-forged name', source: 'srd-5.1' }
    };
    if (monsterVariant !== undefined) data.monsterVariant = monsterVariant;
    await emitEvent(gm, 'add-object', data);
    return {
      gm: await waitForSocketEvent(gm, 'object-added'),
      player: await waitForSocketEvent(player, 'object-added')
    };
  }

  const highland = await placeSRDMonster('ape', 1, 'highland');
  assert.equal(highland.gm.monsterData.index, 'ape');
  assert.equal(highland.gm.monsterData.name, 'Ape',
    'the visual variant must not bypass canonical SRD monster resolution');
  assert.equal(highland.gm.monsterVariant, 'highland');
  assert.equal(highland.player.monsterVariant, 'highland');
  assert.equal(highland.player.monsterData.index, 'ape',
    'players need the canonical index to select the Ape renderer');
  assert.equal(highland.player.monsterData.name, 'Ape');
  assert.equal(highland.player.monsterData.source, 'srd-5.1');
  assert.equal(highland.player.monsterData.public, true);
  for (const privateField of [
    'alignment', 'armor_class', 'hit_points', 'hit_dice', 'speed',
    'challenge_rating', 'xp', 'strength', 'dexterity', 'constitution',
    'intelligence', 'wisdom', 'charisma', 'proficiencies', 'senses',
    'special_abilities', 'actions', 'reactions', 'legendary_actions'
  ]) {
    assert.equal(Object.hasOwn(highland.player.monsterData, privateField), false,
      `${privateField} must not leak through the public Ape projection`);
  }

  const invalid = await placeSRDMonster('ape', 2, '../../not-a-variant');
  assert.equal(invalid.gm.monsterVariant, 'silverback');
  assert.equal(invalid.player.monsterVariant, 'silverback');

  const missing = await placeSRDMonster('ape', 3);
  assert.equal(missing.gm.monsterVariant, 'silverback');
  assert.equal(missing.player.monsterVariant, 'silverback');

  const nonApe = await placeSRDMonster('baboon', 4, 'albino');
  assert.equal(nonApe.gm.monsterData.index, 'baboon');
  assert.equal(Object.hasOwn(nonApe.gm, 'monsterVariant'), false,
    'unsupported creatures must not persist an Ape appearance field');
  assert.equal(Object.hasOwn(nonApe.player, 'monsterVariant'), false);

  const saveFile = path.join(saveDir, 'map_state.json');
  const persisted = await waitFor(() => {
    if (!fs.existsSync(saveFile)) return null;
    const state = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    const objects = state.maps?.[pocket.key]?.objects;
    return objects && Object.keys(objects).length >= 5 ? objects : null;
  }, 'Ape variants to persist in map_state.json');
  assert.equal(persisted[highland.gm.id].monsterVariant, 'highland');
  assert.equal(persisted[invalid.gm.id].monsterVariant, 'silverback');
  assert.equal(persisted[missing.gm.id].monsterVariant, 'silverback');
  assert.equal(Object.hasOwn(persisted[nonApe.gm.id], 'monsterVariant'), false);

  await stopServer(instance);
  instance = await startServer(saveDir);

  const reloadedGM = await connectPolling(instance.port);
  await emitEvent(reloadedGM, 'login', 'GM');
  await pollPackets(reloadedGM);
  await emitEvent(reloadedGM, 'join-map', { key: pocket.key });
  const gmState = await waitForSocketEvent(reloadedGM, 'map-state');
  const reloadedHighland = gmState.objects.find(object => object.id === highland.gm.id);
  const reloadedInvalid = gmState.objects.find(object => object.id === invalid.gm.id);
  const reloadedMissing = gmState.objects.find(object => object.id === missing.gm.id);
  const reloadedNonApe = gmState.objects.find(object => object.id === nonApe.gm.id);
  assert.equal(reloadedHighland.monsterVariant, 'highland');
  assert.equal(reloadedInvalid.monsterVariant, 'silverback');
  assert.equal(reloadedMissing.monsterVariant, 'silverback');
  assert.equal(Object.hasOwn(reloadedNonApe, 'monsterVariant'), false);

  const reloadedPlayer = await connectPolling(instance.port);
  await emitEvent(reloadedPlayer, 'login', 'alice');
  await pollPackets(reloadedPlayer);
  await emitEvent(reloadedPlayer, 'join-map', { key: pocket.key });
  const playerState = await waitForSocketEvent(reloadedPlayer, 'map-state');
  const publicHighland = playerState.objects.find(object => object.id === highland.gm.id);
  assert.equal(publicHighland.monsterVariant, 'highland');
  assert.equal(publicHighland.monsterData.index, 'ape');
  assert.equal(Object.hasOwn(publicHighland.monsterData, 'hit_points'), false);
  assert.equal(Object.hasOwn(publicHighland.monsterData, 'actions'), false);
});

// Silence probe: nothing may arrive for a socket, or only unrelated chatter �
// never the named events. Used for cross-campaign leak checks.
async function assertNoEvents(session, forbidden, ms = 1200) {
  const packets = await Promise.race([
    pollPackets(session).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), ms))
  ]);
  const seen = socketEvents(packets).map(([name]) => name);
  for (const name of forbidden) {
    assert.equal(seen.includes(name), false, `${name} must not reach this socket`);
  }
}

test('campaigns isolate rooms, rosters, and settings authority', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-campaigns-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);

  // A legacy plain-string login auto-joins the default campaign and gets the
  // campaign stamp before the first snapshot.
  await emitEvent(gm, 'login', 'GM');
  const gmBoot = await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  assert.equal(gmBoot['campaign-joined'].ok, true);
  assert.equal(gmBoot['campaign-joined'].id, 'default');
  assert.equal(gmBoot['map-state'].campaign.id, 'default');

  await emitEvent(player, 'login', { username: 'alice' });
  const aliceBoot = await waitForSocketEvents(player, ['campaign-joined', 'map-state']);
  assert.equal(aliceBoot['campaign-joined'].id, 'default');
  assert.equal(aliceBoot['map-state'].campaign.id, 'default');

  // The GM creates a region-style campaign; the server derives the region key.
  await emitEvent(gm, 'create-campaign', {
    name: 'Second Age',
    settings: { seed: 42, mapStyle: 'region', spawn: { x: 6400, z: -12800 } }
  });
  const created = await waitForSocketEvent(gm, 'campaign-created');
  assert.match(created.id, /^[0-9a-f]{8}$/);

  await emitEvent(gm, 'join-campaign', { id: created.id });
  const gmJoin = await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  const settings = gmJoin['campaign-joined'].settings;
  assert.equal(gmJoin['campaign-joined'].id, created.id);
  assert.equal(gmJoin['campaign-joined'].name, 'Second Age');
  assert.equal(gmJoin['campaign-joined'].owner, 'GM');
  assert.equal(settings.seed, 42);
  assert.equal(settings.mapStyle, 'region');
  assert.match(settings.regionKey, /^world\/-?\d+,-?\d+\/-?\d+,-?\d+$/);
  // World shape defaults to the original generator when not specified.
  assert.deepEqual(settings.world, {
    ocean: 80, landSize: 100, wetness: 0, temperature: 0, latitude: 0, rugged: 0, zones: 0, relief: 0, home: null
  });
  assert.equal(settings.season, 'summer');
  // A new table starts on a clear-headed morning with natural weather.
  assert.deepEqual(settings.sky, {
    clock: 'fixed', hour: 10, dayMinutes: 24, at: 0, weather: 'auto', rainbow: 'auto'
  });
  assert.equal(gmJoin['campaign-joined'].startKey, settings.regionKey);
  assert.equal(gmJoin['map-state'].campaign.id, created.id);
  assert.equal(gmJoin['map-state'].key, settings.regionKey);

  // Region campaigns confine navigation to the region lens.
  await emitEvent(gm, 'join-map', { key: 'world/0,0' });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Unknown map');
  await emitEvent(gm, 'join-map', { key: settings.regionKey });
  assert.equal((await waitForSocketEvent(gm, 'map-state')).key, settings.regionKey);
  const tactical = `${settings.regionKey}/0,0`;
  await emitEvent(gm, 'join-map', { key: tactical });
  assert.equal((await waitForSocketEvent(gm, 'map-state')).key, tactical);

  // An object dropped in campaign B never reaches the default campaign.
  await emitEvent(gm, 'join-campaign', { id: created.id });
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  await emitEvent(gm, 'add-object', {
    type: 'token', position: { x: 2, y: 0, z: -2 }, label: 'B-only'
  });
  const gmToken = await waitForSocketEvent(gm, 'object-added');
  assert.equal(gmToken.label, 'B-only');
  await assertNoEvents(player, ['object-added', 'map-state']);

  // Players cannot rewrite another campaign's worldbuilding.
  await emitEvent(player, 'update-campaign-settings', { id: created.id, settings: { seed: 999 } });
  assert.equal(await waitForSocketEvent(player, 'error'), 'GM only');

  // The owner updates the spawn; the region key is re-derived server-side.
  const previousRegionKey = settings.regionKey;
  await emitEvent(gm, 'update-campaign-settings', {
    id: created.id, settings: {
      seed: 43, spawn: { x: 126720, z: 0 },
      world: { ocean: 999, landSize: 150, wetness: -30, temperature: -70, zones: 60, home: { x: 5, z: 6 } },
      season: 'winter',
      sky: { clock: 'cycle', hour: 30.5, dayMinutes: 99999, weather: 'storm', rainbow: 'sideways', at: 5 }
    }
  });
  const updated = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(updated.settings.seed, 43);
  // World shape is clamped server-side; the region lens is the kingdom hex
  // around the spawn (two continent hexes east of the origin).
  assert.deepEqual(updated.settings.world, {
    ocean: 90, landSize: 150, wetness: -30, temperature: -70, latitude: 0, rugged: 0, zones: 60, relief: 0, home: { x: 5, z: 6 }
  });
  assert.equal(updated.settings.season, 'winter');
  // The sky is clamped, and the clock is stamped by the server, never the client.
  const stampedAt = updated.settings.sky.at;
  assert.ok(Math.abs(stampedAt - Date.now()) < 60000);
  assert.deepEqual(updated.settings.sky, {
    clock: 'cycle', hour: 6.5, dayMinutes: 1440, at: stampedAt, weather: 'storm', rainbow: 'auto'
  });
  // A weather-only patch keeps the running clock (and its stamp) untouched.
  await emitEvent(gm, 'update-campaign-settings', { id: created.id, settings: { sky: { weather: 'fog' } } });
  assert.deepEqual((await waitForSocketEvent(gm, 'campaign-updated')).settings.sky, {
    clock: 'cycle', hour: 6.5, dayMinutes: 1440, at: stampedAt, weather: 'fog', rainbow: 'auto'
  });
  // Campaign hall: identity, the recap and the table state ride at the top
  // level; a patch that names none of them leaves all of them alone.
  assert.equal(updated.recap, '');
  assert.equal(updated.session, 'open');
  await emitEvent(gm, 'update-campaign-settings', {
    id: created.id, name: 'Hall Test', description: 'A premise.',
    recap: 'The party fled.\nThe bridge burned.', session: 'closed'
  });
  const briefed = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(briefed.name, 'Hall Test');
  assert.equal(briefed.description, 'A premise.');
  assert.equal(briefed.recap, 'The party fled.\nThe bridge burned.');
  assert.equal(briefed.session, 'closed');
  await emitEvent(gm, 'update-campaign-settings', { id: created.id, session: 'ajar' });
  const reopened = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(reopened.session, 'closed');
  assert.equal(reopened.recap, 'The party fled.\nThe bridge burned.');
  await emitEvent(gm, 'update-campaign-settings', { id: created.id, session: 'open' });
  assert.equal((await waitForSocketEvent(gm, 'campaign-updated')).session, 'open');
  assert.equal(updated.settings.regionKey, 'world/2,0/0,0');
  assert.notEqual(updated.settings.regionKey, previousRegionKey);
  assert.match(updated.settings.regionKey, /^world\/-?\d+,-?\d+\/-?\d+,-?\d+\/?$/);

  // Rosters are per campaign: this character lives only in B.
  await emitEvent(gm, 'save-character', { charData: {
    name: 'Region Bard', race: 'human', background: 'entertainer',
    classes: [{ class: 'bard', level: 3 }],
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 16 },
    hp: { current: 24 }
  } });
  const bard = await waitForSocketEvent(gm, 'character-saved-success');
  assert.equal(bard.name, 'Region Bard');

  // Back in default the roster must not carry B's characters.
  await emitEvent(gm, 'join-campaign', { id: 'default' });
  const backHome = await waitForSocketEvents(gm, ['campaign-joined', 'load-user-characters', 'map-state']);
  assert.equal(backHome['map-state'].campaign.id, 'default');
  assert.equal(
    backHome['load-user-characters'].some((char) => char.name === 'Region Bard'),
    false
  );
  assert.equal(
    backHome['load-user-characters'].some((char) => char.id === bard.id),
    false
  );

  // Non-owners may not delete the campaign.
  await emitEvent(player, 'delete-campaign', { id: created.id });
  assert.equal(await waitForSocketEvent(player, 'error'), 'GM only');

  // Rejoining B confirms its roster persisted there, then the owner deletes
  // it and is kicked back to the lobby.
  await emitEvent(gm, 'join-campaign', { id: created.id });
  const rejoin = await waitForSocketEvents(gm, ['campaign-joined', 'load-user-characters', 'map-state']);
  assert.equal(rejoin['map-state'].campaign.id, created.id);
  assert.equal(
    rejoin['load-user-characters'].some((char) => char.name === 'Region Bard'),
    true
  );

  await emitEvent(gm, 'delete-campaign', { id: created.id });
  const kicked = await waitForSocketEvents(gm, ['campaign-deleted']);
  assert.equal(kicked['campaign-deleted'].id, created.id);
  assert.equal(fs.existsSync(path.join(saveDir, 'campaigns', created.id)), false);

  await emitEvent(gm, 'get-campaigns', null);
  const listed = await waitForSocketEvent(gm, 'campaign-list');
  assert.deepEqual(listed.campaigns.map((campaign) => campaign.id), ['default']);

  // The default campaign still holds its own roster (the region bard did not
  // leak in on either side).
  await emitEvent(gm, 'join-campaign', { id: 'default' });
  const finalHome = await waitForSocketEvents(gm, ['campaign-joined', 'load-user-characters', 'map-state']);
  assert.equal(
    finalHome['load-user-characters'].some((char) => char.name === 'Region Bard'),
    false
  );
});


test('copy-character moves sheets across campaigns from the lobby', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-copy-char-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);

  // A character in the default campaign, HP included.
  await emitEvent(gm, 'save-character', { charData: {
    name: 'Copy Rogue', race: 'elf', background: 'criminal',
    classes: [{ class: 'rogue', level: 4 }],
    abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 10 },
    hp: { current: 7 }
  } });
  const rogue = await waitForSocketEvent(gm, 'character-saved-success');
  assert.equal(rogue.hp.current, 7);

  await emitEvent(gm, 'create-campaign', { name: 'Copy Cats' });
  const created = await waitForSocketEvent(gm, 'campaign-created');

  // A lobby socket (the wizard's vantage point) copies into the new campaign.
  const gmLobby = await connectPolling(instance.port);
  await emitEvent(gmLobby, 'login', { username: 'GM', screen: 'lobby' });
  await waitForSocketEvents(gmLobby, ['login-success', 'campaign-list']);

  // No explicit target and no joined campaign: refused.
  await emitEvent(gmLobby, 'copy-character', { fromCampaignId: 'default', charId: rogue.id });
  assert.equal(await waitForSocketEvent(gmLobby, 'error'), 'No target campaign');

  await emitEvent(gmLobby, 'copy-character', {
    fromCampaignId: 'default', charId: rogue.id, toCampaignId: created.id
  });
  const copied = await waitForSocketEvent(gmLobby, 'character-saved-success');
  assert.notEqual(copied.id, rogue.id);
  assert.equal(copied.name, 'Copy Rogue');
  assert.equal(copied.owner, 'GM');
  assert.equal(copied.hp.current, 7);
  assert.equal(copied.classes[0].level, 4);

  // Another user without authority over the source may not copy.
  const bob = await connectPolling(instance.port);
  await emitEvent(bob, 'login', { username: 'bob', screen: 'lobby' });
  await waitForSocketEvents(bob, ['login-success', 'campaign-list']);
  await emitEvent(bob, 'copy-character', {
    fromCampaignId: 'default', charId: rogue.id, toCampaignId: created.id
  });
  assert.equal(await waitForSocketEvent(bob, 'error'), 'Permission denied');

  // A player brings their own character into a campaign they may enter.
  const bobHome = await connectPolling(instance.port);
  await emitEvent(bobHome, 'login', 'bob');
  await waitForSocketEvents(bobHome, ['campaign-joined', 'map-state']);
  await emitEvent(bobHome, 'save-character', { charData: {
    name: 'Bob Bard', race: 'human', background: 'acolyte',
    classes: [{ class: 'bard', level: 2 }],
    abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 16 }
  } });
  const bard = await waitForSocketEvent(bobHome, 'character-saved-success');
  await emitEvent(bob, 'copy-character', {
    fromCampaignId: 'default', charId: bard.id, toCampaignId: created.id
  });
  const brought = await waitForSocketEvent(bob, 'character-saved-success');
  assert.notEqual(brought.id, bard.id);
  assert.equal(brought.owner, 'bob');

  // ...but not into a private one they were not invited to.
  await emitEvent(gmLobby, 'set-campaign-access', { id: created.id, visibility: 'private', members: [] });
  await waitForSocketEvent(gmLobby, 'campaign-access-saved');
  await emitEvent(bob, 'copy-character', {
    fromCampaignId: 'default', charId: bard.id, toCampaignId: created.id
  });
  assert.equal(await waitForSocketEvent(bob, 'error'), 'Permission denied');

  // The copy lives only in the new campaign; the original stays in default.
  await emitEvent(gm, 'join-campaign', { id: created.id });
  const inCopy = await waitForSocketEvents(gm, ['campaign-joined', 'load-user-characters']);
  assert.equal(inCopy['load-user-characters'].some((char) => char.id === copied.id), true);
  assert.equal(inCopy['load-user-characters'].some((char) => char.id === rogue.id), false);

  await emitEvent(gm, 'join-campaign', { id: 'default' });
  const inDefault = await waitForSocketEvents(gm, ['campaign-joined', 'load-user-characters']);
  assert.equal(inDefault['load-user-characters'].some((char) => char.id === rogue.id), true);
  assert.equal(inDefault['load-user-characters'].some((char) => char.id === copied.id), false);
});


test('campaign palette gates hex painting and survives an empty request', { timeout: 30000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-hex-palette-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);

  // Narrow the default campaign's palette to a single biome.
  await emitEvent(gm, 'update-campaign-settings', {
    id: 'default', settings: { biomes: ['plains'] }
  });
  const narrowed = await waitForSocketEvent(gm, 'campaign-updated');
  assert.deepEqual(narrowed.settings.biomes, ['plains']);

  // An empty biome list means "not specified": the palette must not reset.
  await emitEvent(gm, 'update-campaign-settings', {
    id: 'default', settings: { biomes: [] }
  });
  const stillPlains = await waitForSocketEvent(gm, 'campaign-updated');
  assert.deepEqual(stillPlains.settings.biomes, ['plains']);

  // Hex tags only exist on hex-tier layers.
  await emitEvent(gm, 'join-map', { key: 'world/0,0' });
  const hexState = await waitForSocketEvents(gm, ['map-state']);
  assert.equal(hexState['map-state'].key, 'world/0,0');

  await emitEvent(gm, 'update-hex', { q: 0, r: 0, biome: 'desert' });
  assert.equal(await waitForSocketEvent(gm, 'error'), 'Biome is not in this campaign palette');

  await emitEvent(gm, 'update-hex', { q: 0, r: 0, biome: 'plains' });
  const painted = await waitForSocketEvent(gm, 'hex-updated');
  assert.equal(painted.key, 'world/0,0');
  assert.equal(painted.hex, '0,0');
  assert.equal(painted.biome, 'plains');
});


// Collects one payload per requested event (each with its own predicate)
// across polls, so a batch carrying several answers loses none of them:
// `wants` maps event name -> payload predicate.
async function waitForAnswers(session, wants, timeoutMs = 5000) {
  const pending = new Map(Object.entries(wants));
  const seen = {};
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline) {
    for (const [name, payload] of socketEvents(await pollPackets(session))) {
      const predicate = pending.get(name);
      if (!predicate) continue;
      if (predicate(payload)) { seen[name] = payload; pending.delete(name); }
    }
  }
  if (pending.size) throw new Error(`timed out waiting for ${[...pending.keys()].join(', ')}`);
  return seen;
}

test('campaign arc: session history, access payloads, and the export bundle', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-arc-sessions-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  const gmBoot = await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  await emitEvent(player, 'login', { username: 'alice' });
  const playerBoot = await waitForSocketEvents(player, ['campaign-joined', 'map-state']);

  // The join brief carries visibility for everyone, the invite list only for
  // the campaign GM.
  assert.equal(gmBoot['campaign-joined'].visibility, 'public');
  assert.deepEqual(gmBoot['campaign-joined'].members, []);
  assert.equal(playerBoot['campaign-joined'].visibility, 'public');
  assert.equal('members' in playerBoot['campaign-joined'], false);

  // Posting a session archives the previous recap; the newest sits first.
  await emitEvent(gm, 'update-campaign-settings', {
    id: 'default', recap: 'The bridge burned.', postSession: true
  });
  let updated = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(updated.recap, 'The bridge burned.');
  assert.equal(updated.sessions.length, 1);
  assert.equal(updated.sessions[0].n, 1);
  assert.equal(updated.sessions[0].text, 'The bridge burned.');
  assert.ok(updated.sessions[0].at > 0);

  await emitEvent(gm, 'update-campaign-settings', {
    id: 'default', recap: 'They sailed east.', postSession: true
  });
  updated = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(updated.recap, 'They sailed east.');
  assert.deepEqual(updated.sessions.map((s) => s.n), [2, 1]);

  // A plain recap save is not a session; deleting the newest falls back to
  // the remaining archive so the hall always has a "last time".
  await emitEvent(gm, 'update-campaign-settings', { id: 'default', recap: 'Notes for next time.' });
  updated = await waitForSocketEvent(gm, 'campaign-updated');
  assert.equal(updated.sessions.length, 2);
  assert.equal(updated.recap, 'Notes for next time.');
  await emitEvent(gm, 'update-campaign-settings', { id: 'default', deleteSession: 2 });
  updated = await waitForSocketEvent(gm, 'campaign-updated');
  assert.deepEqual(updated.sessions.map((s) => s.n), [1]);
  assert.equal(updated.recap, 'The bridge burned.');

  // A fresh join carries the same history in its brief.
  await emitEvent(gm, 'join-campaign', { id: 'default' });
  const rejoin = await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  assert.equal(rejoin['campaign-joined'].sessions.length, 1);
  assert.equal(rejoin['campaign-joined'].sessions[0].n, 1);
  assert.equal(rejoin['campaign-joined'].recap, 'The bridge burned.');

  // Access: a player may not touch it; the GM's answer carries the saved
  // state, and nobody else is told the invite list.
  await emitEvent(player, 'set-campaign-access', { id: 'default', visibility: 'private' });
  assert.equal(await waitForSocketEvent(player, 'error'), 'GM only');
  await emitEvent(gm, 'set-campaign-access', { id: 'default', visibility: 'private', members: ['alice'] });
  const access = await waitForSocketEvent(gm, 'campaign-access-saved');
  assert.equal(access.id, 'default');
  assert.equal(access.visibility, 'private');
  assert.deepEqual(access.members, ['alice']);
  // The answer went only to the asking GM; alice's own list shows she is
  // invited without ever being shown who else is on the invite list.
  await emitEvent(player, 'get-campaigns', null);
  const playerList = await waitForSocketEvent(player, 'campaign-list');
  const playerEntry = playerList.campaigns.find((campaign) => campaign.id === 'default');
  assert.equal(playerEntry.visibility, 'private');
  assert.equal(playerEntry.invited, true);
  assert.equal(playerEntry.members, undefined);


  // Invited, alice still enters the now-private campaign; her brief never
  // carries the member list.
  await emitEvent(player, 'join-campaign', { id: 'default' });
  const playerJoin = await waitForSocketEvents(player, ['campaign-joined', 'map-state']);
  assert.equal(playerJoin['campaign-joined'].visibility, 'private');
  assert.equal('members' in playerJoin['campaign-joined'], false);
  await emitEvent(gm, 'join-campaign', { id: 'default' });
  const gmPrivate = await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  assert.equal(gmPrivate['campaign-joined'].visibility, 'private');
  assert.deepEqual(gmPrivate['campaign-joined'].members, ['alice']);

  // Export: only the GM may ask, and the bundle is the store's contents.
  await emitEvent(player, 'export-campaign', { id: 'default' });
  assert.equal(await waitForSocketEvent(player, 'error'), 'GM only');

  await emitEvent(gm, 'save-character', { charData: {
    name: 'Export Rogue', race: 'human', background: 'urchin',
    classes: [{ class: 'rogue', level: 2 }],
    abilities: { str: 8, dex: 16, con: 12, int: 12, wis: 10, cha: 10 },
    hp: { current: 15 }
  } });
  await waitForSocketEvent(gm, 'character-saved-success');
  await emitEvent(gm, 'add-object', { type: 'token', position: { x: 1, y: 0, z: 1 }, label: 'Export Token' });
  await waitForSocketEvent(gm, 'object-added');

  await emitEvent(gm, 'export-campaign', { id: 'default' });
  const bundle = await waitForSocketEvent(gm, 'campaign-export');
  assert.equal(bundle.id, 'default');
  assert.equal(bundle.data.format, '3dx-campaign');
  assert.equal(bundle.data.version, 1);
  assert.ok(Number.isFinite(Date.parse(bundle.data.exportedAt)));
  assert.equal(bundle.data.campaign.name, 'Default Campaign');
  assert.equal(bundle.data.campaign.visibility, 'private');
  assert.ok(Object.values(bundle.data.characters).some((char) => char.name === 'Export Rogue'));
  assert.equal(bundle.data.journal.entries.length, 0);
  assert.equal(typeof bundle.data.pools.chars, 'object');
    assert.ok(Array.isArray(bundle.data.rolls));
    assert.ok(Array.isArray(bundle.data.chat));
  assert.ok(Object.values(bundle.data.maps).some((map) => map && map.objects &&
    Object.values(map.objects).some((object) => object.label === 'Export Token')));
});

test('campaign arc: journal, treasury, XP awards and the identity-only party view', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-arc-journal-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const player = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  await emitEvent(player, 'login', { username: 'alice' });
  await waitForSocketEvents(player, ['campaign-joined', 'map-state']);

  // The journal belongs to the GM.
  await emitEvent(player, 'save-journal-entry', { entry: { text: 'Let me in.' } });
  assert.equal((await waitForSocketEvent(player, 'journal-denied')).error, 'GM only');

  // Party-visible notes reach the table, GM-only notes never leave the GM.
  await emitEvent(gm, 'save-journal-entry', { entry: {
    title: 'The gem', text: 'Find the blue gem.', kind: 'quest', visible: 'party'
  } });
  await waitForAnswers(gm, { journal: (j) => j.entries.some((e) => e.title === 'The gem') });
  await waitForAnswers(player, { journal: (j) => j.entries.some((e) => e.title === 'The gem') });

  await emitEvent(gm, 'save-journal-entry', { entry: {
    title: 'The duke', text: 'The duke is the villain.', kind: 'npc', visible: 'gm'
  } });
  await waitForAnswers(gm, { journal: (j) => j.entries.some((e) => e.title === 'The duke') });
  const filtered = await waitForAnswers(player, {
    journal: (j) => j.entries.length === 1 && j.entries[0].title === 'The gem'
  });
  assert.equal(filtered.journal.entries.some((e) => e.title === 'The duke'), false);

  // The same filter holds for an explicit fetch.
  await emitEvent(player, 'get-journal', null);
  const fetched = await waitForAnswers(player, {
    journal: (j) => j.entries.length === 1 && j.entries[0].title === 'The gem'
  });
  assert.equal(Object.keys(fetched.journal.treasury).length, 0);
  assert.equal(fetched.journal.xp.mode, 'milestone');
  assert.ok(Array.isArray(fetched.journal.xp.awards));

  // Treasury and the XP mode are party information.
  await emitEvent(gm, 'update-treasury', { treasury: { gp: 50, cp: 12 } });
  await waitForAnswers(gm, { journal: (j) => j.treasury.gp === 50 });
  const treasury = await waitForAnswers(player, { journal: (j) => j.treasury.gp === 50 });
  assert.equal(treasury.journal.treasury.cp, 12);

  await emitEvent(gm, 'set-xp-mode', { mode: 'xp' });
  await waitForAnswers(gm, { journal: (j) => j.xp.mode === 'xp' });
  await waitForAnswers(player, { journal: (j) => j.xp.mode === 'xp' });

  // An award lands on each named sheet as char.xp and in the party log.
  await emitEvent(gm, 'save-character', { charData: {
    name: 'Arc Wizard', race: 'human', background: 'sage',
    classes: [{ class: 'wizard', level: 5 }],
    abilities: { str: 8, dex: 12, con: 14, int: 16, wis: 12, cha: 10 },
    hp: { current: 32 }
  } });
  const wizard = await waitForSocketEvent(gm, 'character-saved-success');
  await emitEvent(gm, 'award-xp', { text: 'The blue gem', xp: 300, charIds: [wizard.id] });
  const awarded = await waitForAnswers(gm, {
    journal: (j) => j.xp.awards.some((a) => a.xp === 300 && a.text === 'The blue gem'),
    'character-updated': (char) => char.id === wizard.id && char.xp === 300
  });
  assert.deepEqual(awarded.journal.xp.awards[0].charIds, [wizard.id]);
  assert.equal(awarded['character-updated'].xp, 300);
  // The award is party information too.
  const seenByPlayer = await waitForAnswers(player, {
    journal: (j) => j.xp.awards.some((a) => a.xp === 300)
  });
  assert.equal(seenByPlayer.journal.xp.mode, 'xp');

  // Party view: identity ONLY for every member, whoever asks.
  await emitEvent(player, 'save-character', { charData: {
    name: 'Lyra', race: 'elf', background: 'folk-hero',
    classes: [{ class: 'ranger', level: 3 }],
    abilities: { str: 12, dex: 16, con: 12, int: 10, wis: 14, cha: 8 },
    hp: { current: 26 }
  } });
  const lyra = await waitForSocketEvent(player, 'character-saved-success');
  await emitEvent(player, 'get-party', null);
  const party = await waitForSocketEvent(player, 'party');
  const arc = party.members.find((member) => member.name === 'Arc Wizard');
  const mine = party.members.find((member) => member.id === lyra.id);
  assert.ok(arc, 'the GM sheet is in the party list');
  assert.ok(mine, 'the asking player sheet is in the party list');
  for (const member of party.members) {
    assert.deepEqual(Object.keys(member).sort(), ['cls', 'id', 'level', 'name', 'owner', 'race']);
  }
  assert.equal(arc.owner, 'GM');
  assert.equal(arc.cls, 'wizard');
  assert.equal(arc.level, 5);
  assert.equal(mine.owner, 'alice');
  assert.equal(mine.cls, 'ranger');
  assert.equal(party.members.some((member) => 'hp' in member || 'ac' in member), false);
});


test('table chat: OOC delivery, private whispers, bounds and persistence', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-chat-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const alice = await connectPolling(instance.port);
  const bob = await connectPolling(instance.port);
  const eve = await connectPolling(instance.port);
  for (const [session, name] of [[gm, 'GM'], [alice, 'alice'], [bob, 'bob'], [eve, 'eve']]) {
    await emitEvent(session, 'login', name);
    await waitForSocketEvents(session, ['campaign-joined', 'map-state']);
  }

  async function chatHistory(session) {
    await emitEvent(session, 'get-chat', null);
    const seen = await waitForAnswers(session, { 'chat-log': () => true });
    return seen['chat-log'].messages;
  }

  // OOC reaches the whole table, sender included, under one id.
  await emitEvent(alice, 'chat-send', { text: 'Anyone here?' });
  const mine = await waitForAnswers(alice, { 'chat-message': (m) => m.from === 'alice' && !m.to });
  assert.equal(mine['chat-message'].text, 'Anyone here?');
  const heard = await waitForAnswers(eve, { 'chat-message': (m) => m.from === 'alice' && !m.to });
  assert.equal(heard['chat-message'].id, mine['chat-message'].id);

  // Long text is bounded, empty text is refused.
  await emitEvent(eve, 'chat-send', { text: 'x'.repeat(600) });
  const oversize = await waitForAnswers(eve, { 'chat-message': (m) => m.from === 'eve' });
  assert.equal(oversize['chat-message'].text.length, 500);
  await emitEvent(bob, 'chat-send', { text: '   ' });
  const empty = await waitForAnswers(bob, { 'chat-denied': () => true });
  assert.equal(empty['chat-denied'].error, 'A message needs some text');

  // A second message inside the cooldown is refused and never stored.
  await emitEvent(bob, 'chat-send', { text: 'Hey all' });
  await emitEvent(bob, 'chat-send', { text: 'spam spam' });
  const paced = await waitForAnswers(bob, {
    'chat-message': (m) => m.text === 'Hey all',
    'chat-denied': () => true
  });
  assert.equal(paced['chat-denied'].error, 'Slow down a moment');

  // A whisper reaches its two speakers — nobody else, not even the GM.
  await new Promise((resolve) => setTimeout(resolve, 450));
  await emitEvent(alice, 'chat-send', { text: 'psst, bring potions', to: 'bob' });
  const whispered = await waitForAnswers(alice, { 'chat-message': (m) => m.to === 'bob' });
  assert.equal(whispered['chat-message'].from, 'alice');
  const toBob = await waitForAnswers(bob, { 'chat-message': (m) => m.to === 'bob' });
  assert.equal(toBob['chat-message'].text, 'psst, bring potions');

  // A third socket is told nothing about it live: the whisper (if it leaked)
  // would be queued before eve's roll-log round trip completes.
  await emitEvent(eve, 'get-roll-log', null);
  const eveLive = [];
  {
    let done = false;
    const deadline = Date.now() + 5000;
    while (!done && Date.now() < deadline) {
      for (const [name, payload] of socketEvents(await pollPackets(eve))) {
        if (name === 'roll-log') { done = true; break; }
        if (name === 'chat-message') eveLive.push(payload);
      }
    }
    assert.ok(done, 'eve should get the roll-log round trip');
  }
  assert.equal(eveLive.some((m) => m && m.to), false, 'a whisper must not reach a third socket live');

  // The history confirms it: each speaker sees their own conversation.
  const eveHistory = await chatHistory(eve);
  assert.equal(eveHistory.some((m) => m.to), false, 'Eve never sees a whisper');
  assert.equal(eveHistory.some((m) => m.text === 'psst, bring potions'), false);
  assert.equal(eveHistory.some((m) => m.text === 'spam spam'), false, 'rate-limited text is never stored');
  assert.ok(eveHistory.some((m) => m.text === 'Anyone here?'));
  assert.ok(eveHistory.some((m) => m.text === 'Hey all'));

  const gmHistory = await chatHistory(gm);
  assert.equal(gmHistory.some((m) => m.text === 'psst, bring potions'), false, 'the GM does not read whispers');
  assert.ok(gmHistory.some((m) => m.text === 'Hey all'));

  const aliceHistory = await chatHistory(alice);
  assert.ok(aliceHistory.some((m) => m.to === 'bob' && m.text === 'psst, bring potions'));
  const bobHistory = await chatHistory(bob);
  assert.ok(bobHistory.some((m) => m.to === 'bob' && m.text === 'psst, bring potions'));

  // The history outlives the server: chat.json round-trips through a restart.
  await stopServer(instance);
  instance = await startServer(saveDir);
  const again = await connectPolling(instance.port);
  await emitEvent(again, 'login', 'bob');
  await waitForSocketEvents(again, ['campaign-joined', 'map-state']);
  const reloaded = await chatHistory(again);
  assert.ok(reloaded.some((m) => m.text === 'psst, bring potions' && m.to === 'bob'));
  assert.ok(reloaded.some((m) => m.text === 'Anyone here?'));
  assert.equal(reloaded.some((m) => m.text === 'spam spam'), false);
});


test('dice macros stay personal and the GM can drop a single log entry', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-macros-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const alice = await connectPolling(instance.port);
  const eve = await connectPolling(instance.port);
  for (const [session, name] of [[gm, 'GM'], [alice, 'alice'], [eve, 'eve']]) {
    await emitEvent(session, 'login', name);
    await waitForSocketEvents(session, ['campaign-joined', 'map-state']);
  }
  async function macroList(session) {
    await emitEvent(session, 'get-macros', null);
    const seen = await waitForAnswers(session, { macros: () => true });
    return seen.macros.macros;
  }

  // A macro without dice is refused; the cooldown only counts saved macros.
  await emitEvent(alice, 'save-macro', { macro: { name: 'Nonsense' } });
  const noDice = await waitForAnswers(alice, { 'macro-denied': () => true });
  assert.equal(noDice['macro-denied'].error, 'A macro needs dice, like d20+5 or 2d6');

  // Saving works and answers the owner with their own list.
  await emitEvent(alice, 'save-macro', { macro: { name: 'Stealth', label: 'Stealth', d20: { bonus: 7 } } });
  const mine = await waitForAnswers(alice, { macros: () => true });
  assert.equal(mine.macros.macros.length, 1);
  assert.equal(mine.macros.macros[0].name, 'Stealth');
  assert.equal(mine.macros.macros[0].owner, 'alice');
  assert.equal(typeof mine.macros.macros[0].id, 'string');

  // Another player's list never shows it, and a save inside the cooldown is refused.
  await emitEvent(eve, 'save-macro', { macro: { name: 'Frostbolt', label: 'Frostbolt', dice: [{ expr: '2d8', type: 'cold' }] } });
  await emitEvent(eve, 'save-macro', { macro: { name: 'Haste', d20: { bonus: 1 } } });
  const evew = await waitForAnswers(eve, { macros: () => true, 'macro-denied': () => true });
  assert.equal(evew.macros.macros.length, 1);
  assert.equal(evew.macros.macros[0].name, 'Frostbolt');
  assert.equal(evew['macro-denied'].error, 'Slow down a moment');
  assert.deepEqual(await macroList(alice), mine.macros.macros, 'a second socket keeps the same list');
  assert.deepEqual(await macroList(gm), [], 'the GM sees no one else\'s macros');
  assert.equal((await macroList(eve)).some((macro) => macro.name === 'Stealth'), false);

  // Two table rolls; the GM drops one single entry for everyone.
  await emitEvent(alice, 'roll', { label: 'Arcana', d20: { bonus: 3 } });
  await waitForAnswers(alice, { 'roll-logged': (entry) => entry.user === 'alice' });
  await emitEvent(eve, 'roll', { label: 'Perception', d20: { bonus: 4 } });
  await waitForAnswers(eve, { 'roll-logged': (entry) => entry.user === 'eve' });
  await emitEvent(gm, 'get-roll-log', null);
  const before = await waitForAnswers(gm, { 'roll-log': (data) => data.entries.length === 2 });
  const eveEntry = before['roll-log'].entries.find((entry) => entry.user === 'eve');
  const aliceEntry = before['roll-log'].entries.find((entry) => entry.user === 'alice');
  assert.ok(eveEntry && aliceEntry);

  await emitEvent(gm, 'delete-roll-log-entry', { id: eveEntry.id });
  const gmAfter = await waitForAnswers(gm, { 'roll-log': (data) => data.entries.length === 1 });
  assert.equal(gmAfter['roll-log'].entries[0].id, aliceEntry.id);
  const aliceAfter = await waitForAnswers(alice, { 'roll-log': (data) => data.entries.length === 1 });
  assert.equal(aliceAfter['roll-log'].entries[0].id, aliceEntry.id);

  // Only the GM may delete.
  await emitEvent(alice, 'delete-roll-log-entry', { id: aliceEntry.id });
  const denied = await waitForAnswers(alice, { 'combat-denied': () => true });
  assert.equal(denied['combat-denied'].reason, 'GM only');

  // Macros outlive the server.
  await stopServer(instance);
  instance = await startServer(saveDir);
  const again = await connectPolling(instance.port);
  await emitEvent(again, 'login', 'alice');
  await waitForSocketEvents(again, ['campaign-joined', 'map-state']);
  const reloaded = await macroList(again);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].name, 'Stealth');
  assert.equal(reloaded[0].d20.bonus, 7);
});


test('GM bookmarks are GM-only, keep their pose and survive a restart', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-bookmarks-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const alice = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  await emitEvent(alice, 'login', 'alice');
  await waitForSocketEvents(alice, ['campaign-joined', 'map-state']);

  // A player may neither read nor write bookmarks, and never receives the list.
  await emitEvent(alice, 'get-bookmarks', null);
  const refused = await waitForAnswers(alice, { 'bookmark-denied': () => true });
  assert.equal(refused['bookmark-denied'].error, 'GM only');
  await emitEvent(alice, 'save-bookmark', { name: 'Sneaky', mapKey: 'world', pose: { pos: { x: 0, y: 1, z: 0 }, look: { x: 0, y: 0, z: 0 } } });
  const deniedWrite = await waitForAnswers(alice, { 'bookmark-denied': () => true });
  assert.equal(deniedWrite['bookmark-denied'].error, 'GM only');

  // The GM saves a spot with its pose; the push carries it to GM sockets only.
  await emitEvent(gm, 'save-bookmark', {
    name: 'Camp on the ridge', mapKey: 'world/0,0',
    pose: { pos: { x: 120.5, y: 42, z: -80.25 }, look: { x: 118, y: 0.5, z: -77 } }
  });
  const saved = await waitForAnswers(gm, { bookmarks: (data) => data.bookmarks.length === 1 });
  const mark = saved.bookmarks.bookmarks[0];
  assert.equal(mark.name, 'Camp on the ridge');
  assert.equal(mark.mapKey, 'world/0,0');
  assert.deepEqual(mark.pose, { pos: { x: 120.5, y: 42, z: -80.25 }, look: { x: 118, y: 0.5, z: -77 } });

  // A bookmark without a view is refused.
  await emitEvent(gm, 'save-bookmark', { name: 'Nothing', mapKey: 'world', pose: null });
  const badPose = await waitForAnswers(gm, { 'bookmark-denied': () => true });
  assert.equal(badPose['bookmark-denied'].error, 'A bookmark needs a name and a view to remember');

  // The player socket never sees a 'bookmarks' event: reading the queue up to
  // the roll-log round trip (which the server answers last) must turn up none.
  await emitEvent(alice, 'get-roll-log', null);
  const aliceSeen = [];
  {
    let done = false;
    const deadline = Date.now() + 4000;
    while (!done && Date.now() < deadline) {
      for (const [name, payload] of socketEvents(await pollPackets(alice))) {
        if (name === 'roll-log') { done = true; break; }
        aliceSeen.push(name);
      }
    }
    assert.ok(done, 'alice should get the roll-log round trip');
  }
  assert.equal(aliceSeen.includes('bookmarks'), false, 'a player must never receive the bookmark list');

  // The GM deletes one; the list round-trips through a restart.
  await emitEvent(gm, 'save-bookmark', { name: 'Second spot', mapKey: 'pocket/abcd1234', pose: { pos: { x: 1, y: 2, z: 3 }, look: { x: 4, y: 5, z: 6 } } });
  const two = await waitForAnswers(gm, { bookmarks: (data) => data.bookmarks.length === 2 });
  const second = two.bookmarks.bookmarks.find((entry) => entry.name === 'Second spot');
  await emitEvent(gm, 'delete-bookmark', { id: second.id });
  const one = await waitForAnswers(gm, { bookmarks: (data) => data.bookmarks.length === 1 });
  assert.equal(one.bookmarks.bookmarks[0].id, mark.id);

  await stopServer(instance);
  instance = await startServer(saveDir);
  const again = await connectPolling(instance.port);
  await emitEvent(again, 'login', 'GM');
  await waitForSocketEvents(again, ['campaign-joined', 'map-state']);
  await emitEvent(again, 'get-bookmarks', null);
  const reloaded = await waitForAnswers(again, { bookmarks: () => true });
  assert.equal(reloaded.bookmarks.bookmarks.length, 1);
  assert.deepEqual(reloaded.bookmarks.bookmarks[0].pose, mark.pose);
});


test('GM encounter library is GM-only, keeps member groups and survives a restart', { timeout: 40000 }, async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-encounters-'));
  const saveDir = path.join(fixtureDir, 'saves');
  fs.mkdirSync(saveDir, { recursive: true });
  let instance;
  t.after(async () => {
    await stopServer(instance);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  instance = await startServer(saveDir);
  const gm = await connectPolling(instance.port);
  const alice = await connectPolling(instance.port);
  await emitEvent(gm, 'login', 'GM');
  await waitForSocketEvents(gm, ['campaign-joined', 'map-state']);
  await emitEvent(alice, 'login', 'alice');
  await waitForSocketEvents(alice, ['campaign-joined', 'map-state']);

  // A player may neither read nor write the library, and never receives it.
  await emitEvent(alice, 'get-encounters', null);
  const refused = await waitForAnswers(alice, { 'encounter-denied': () => true });
  assert.equal(refused['encounter-denied'].error, 'GM only');
  await emitEvent(alice, 'save-encounter', { name: 'Nope', members: [{ index: 'orc', count: 1 }] });
  const deniedWrite = await waitForAnswers(alice, { 'encounter-denied': () => true });
  assert.equal(deniedWrite['encounter-denied'].error, 'GM only');

  // The GM saves a group; the push carries it to GM sockets only.
  await emitEvent(gm, 'save-encounter', { name: 'Orc ambush', members: [{ index: 'orc', count: 3 }, { index: 'wolf', count: 2 }] });
  const saved = await waitForAnswers(gm, { encounters: (data) => data.encounters.length === 1 });
  assert.deepEqual(saved.encounters.encounters[0].members, [{ index: 'orc', count: 3 }, { index: 'wolf', count: 2 }]);
  assert.equal(saved.encounters.encounters[0].name, 'Orc ambush');

  // A group with no monsters is refused.
  await emitEvent(gm, 'save-encounter', { name: 'Empty', members: [] });
  const bad = await waitForAnswers(gm, { 'encounter-denied': () => true });
  assert.equal(bad['encounter-denied'].error, 'An encounter needs a name and at least one monster');

  // The player socket never sees an 'encounters' event: read its queue up to
  // the roll-log round trip the server answers last.
  await emitEvent(alice, 'get-roll-log', null);
  const aliceSeen = [];
  {
    let done = false;
    const deadline = Date.now() + 4000;
    while (!done && Date.now() < deadline) {
      for (const [name] of socketEvents(await pollPackets(alice))) {
        if (name === 'roll-log') { done = true; break; }
        aliceSeen.push(name);
      }
    }
    assert.ok(done, 'alice should get the roll-log round trip');
  }
  assert.equal(aliceSeen.includes('encounters'), false, 'a player must never receive the encounter library');

  // Counts are clamped server-side: 12 per row, nothing outside 1..12.
  await emitEvent(gm, 'save-encounter', { name: 'Clamped', members: [{ index: 'goblin', count: 99 }, { index: '', count: 2 }] });
  const clamped = await waitForAnswers(gm, { encounters: (data) => data.encounters.length === 2 });
  assert.deepEqual(clamped.encounters.encounters.find((entry) => entry.name === 'Clamped').members, [{ index: 'goblin', count: 12 }]);

  // The library round-trips through a restart, then the GM deletes one.
  await stopServer(instance);
  instance = await startServer(saveDir);
  const again = await connectPolling(instance.port);
  await emitEvent(again, 'login', 'GM');
  await waitForSocketEvents(again, ['campaign-joined', 'map-state']);
  await emitEvent(again, 'get-encounters', null);
  const reloaded = await waitForAnswers(again, { encounters: () => true });
  assert.equal(reloaded.encounters.encounters.length, 2);
  const orc = reloaded.encounters.encounters.find((entry) => entry.name === 'Orc ambush');
  assert.ok(orc, 'the saved encounter should survive the restart');
  assert.deepEqual(orc.members, [{ index: 'orc', count: 3 }, { index: 'wolf', count: 2 }]);
  await emitEvent(again, 'delete-encounter', { id: orc.id });
  const afterDelete = await waitForAnswers(again, { encounters: (data) => data.encounters.length === 1 });
  assert.equal(afterDelete.encounters.encounters[0].name, 'Clamped');
});
