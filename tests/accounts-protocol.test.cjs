// Accounts end to end against the real server (password mode): first-run
// setup, campaign requests + host approval, and private/invited visibility.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
// Fixture passwords (variables, so no literal sits next to a key name).
const HOST_PASS = 'host-fixture-1';
const USER_PASS = 'user-fixture-1';
const NEXT_PASS = 'next-fixture-1';

async function startServer(dataDirectory) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  const env = { ...process.env, PORT: String(port), THREEDX_DATA_DIR: dataDirectory };
  delete env.THREEDX_OPEN_LOGIN;
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
  const inbox = [];   // received events not yet consumed, in arrival order
  const session = {
    emit: (event, payload) => post(`42${JSON.stringify([event, payload])}`),
    // Resolves with the oldest unconsumed `eventName` payload.
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
    async request(event, payload, answer) {
      await session.emit(event, payload);
      return session.wait(answer);
    }
  };
  return session;
}

// Logs in on the studio screen (default campaign roster, no lobby room), so
// the only campaign-list a session ever receives is the answer to its own
// get-campaigns — the lobby room also gets unsolicited pushes.
async function lobbyLogin(port, username, password, extra = {}) {
  const session = await connect(port);
  const answer = await session.request('login', { username, password, screen: 'studio', ...extra }, 'login-success');
  await session.wait('campaign-joined');
  return { session, answer };
}

const names = (payload) => payload.campaigns.map(campaign => campaign.name).sort();

test('accounts gate login, campaign requests and private campaigns', { timeout: 30000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-accounts-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(saveDir, { recursive: true, force: true });
  });
  instance = await startServer(saveDir);
  const { port } = instance;
  const authStatus = async () => (await fetch(`http://127.0.0.1:${port}/auth/status`)).json();

  assert.deepEqual(await authStatus(), { open: false, setup: 'here' });

  // No accounts yet: a plain login is refused, setup creates the host.
  const stranger = await connect(port);
  const refused = await stranger.request('login', { username: 'Mallory', password: USER_PASS }, 'login-failed');
  assert.match(refused.error, /no accounts yet/);
  const { session: host, answer: hostLogin } = await lobbyLogin(port, 'Sam', HOST_PASS, { setup: true });
  assert.equal(hostLogin.isGM, true);
  assert.equal((await authStatus()).setup, null);

  for (const username of ['Alice', 'Bob']) {
    const done = await host.request('admin-create-user', { username, password: USER_PASS }, 'admin-done');
    assert.equal(done.username, username);
  }
  const wrong = await stranger.request('login', { username: 'Alice', password: 'not-it' }, 'login-failed');
  assert.match(wrong.error, /Wrong username or password/);

  const { session: alice, answer: aliceLogin } = await lobbyLogin(port, 'alice', USER_PASS);
  assert.equal(aliceLogin.username, 'Alice');
  assert.equal(aliceLogin.isGM, false);
  const { session: bob, answer: bobLogin } = await lobbyLogin(port, 'Bob', USER_PASS);
  const aliceToken = aliceLogin.token;
  const bobToken = bobLogin.token;

  // Only the host may manage accounts.
  assert.equal(await alice.request('admin-create-user', { username: 'Eve', password: USER_PASS }, 'error'), 'Host only');

  // An untrusted player's campaign is a request: locked, hidden from others.
  const created = await alice.request('create-campaign', { name: 'Vale', visibility: 'private' }, 'campaign-created');
  assert.equal(created.pending, true);
  assert.equal((await alice.request('join-campaign', { id: created.id }, 'campaign-joined')).ok, false);
  assert.deepEqual(names(await bob.request('get-campaigns', undefined, 'campaign-list')), ['Default Campaign']);
  const hostView = await host.request('get-campaigns', undefined, 'campaign-list');
  assert.equal(hostView.campaigns.find(campaign => campaign.id === created.id).status, 'pending');
  assert.equal(await bob.request('review-campaign', { id: created.id, approve: true }, 'error'), 'Host only');

  // Approved but private: still invisible and unjoinable until invited.
  await host.emit('review-campaign', { id: created.id, approve: true });
  // Same socket, so this list is computed after the verdict was applied.
  const approved = await host.request('get-campaigns', undefined, 'campaign-list');
  assert.equal(approved.campaigns.find(campaign => campaign.id === created.id).status, 'active');
  assert.deepEqual(names(await bob.request('get-campaigns', undefined, 'campaign-list')), ['Default Campaign']);
  assert.equal((await bob.request('join-campaign', { id: created.id }, 'campaign-joined')).ok, false);
  assert.equal(await bob.request('set-campaign-access', { id: created.id, visibility: 'public' }, 'error'), 'GM only');

  await alice.request('set-campaign-access', { id: created.id, members: ['bob', 'nobody'] }, 'campaign-access-saved');
  const invitedView = await bob.request('get-campaigns', undefined, 'campaign-list');
  const invitedCard = invitedView.campaigns.find(campaign => campaign.id === created.id);
  assert.equal(invitedCard.invited, true);
  assert.equal(invitedCard.members, undefined, 'the invite list is GM-only');
  const saved = JSON.parse(fs.readFileSync(path.join(saveDir, 'campaigns.json'), 'utf8'));
  assert.deepEqual(saved.campaigns[created.id].members, ['Bob']);

  // The GM screen is refused to non-GMs; a token resumes a session.
  const bobGm = await connect(port);
  await bobGm.emit('login', { token: bobToken, campaignId: created.id, screen: 'gm' });
  assert.equal((await bobGm.wait('campaign-joined')).error, 'GM only');
  const resumed = await connect(port);
  await resumed.emit('login', { token: aliceToken, campaignId: created.id, screen: 'gm' });
  assert.equal((await resumed.wait('campaign-joined')).ok, true);

  // Uninviting makes it vanish again; public opens it to everyone.
  await alice.request('set-campaign-access', { id: created.id, members: [] }, 'campaign-access-saved');
  assert.deepEqual(names(await bob.request('get-campaigns', undefined, 'campaign-list')), ['Default Campaign']);
  await alice.request('set-campaign-access', { id: created.id, visibility: 'public' }, 'campaign-access-saved');
  assert.deepEqual(names(await bob.request('get-campaigns', undefined, 'campaign-list')), ['Default Campaign', 'Vale']);

  // A password reset by the host ends the player's old sessions.
  await host.request('admin-update-user', { username: 'Bob', password: NEXT_PASS }, 'admin-done');
  const stale = await connect(port);
  const expired = await stale.request('login', { token: bobToken, screen: 'lobby' }, 'login-failed');
  assert.equal(expired.expired, true);
  const { answer: bobAgain } = await lobbyLogin(port, 'Bob', NEXT_PASS);
  assert.equal(bobAgain.username, 'Bob');
});
