const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createAuth, USERS_FILE } = require('../lib/auth.cjs');

// A store on a real temp dir with the same (filename, data, dir) contract as
// server.js loadJSON/saveJSON.
function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-auth-'));
  t.after(() => {
    fs.unwatchFile(path.join(dir, USERS_FILE));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, USERS_FILE);
  return {
    dir,
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    options: (extra = {}) => ({
      dataDir: dir,
      loadJSON: (name, fallback, validate, where) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(where, name), 'utf8'));
          return validate(data) ? data : fallback;
        } catch (_) { return fallback; }
      },
      saveJSON: (name, data, where) => {
        fs.writeFileSync(path.join(where, name), JSON.stringify(data, null, 2));
        return true;
      },
      ...extra
    })
  };
}

const LOCAL = { ip: '127.0.0.1', loopback: true };
const REMOTE = { ip: '10.0.0.7', loopback: false };
// Fixture passwords (kept in variables so no literal sits next to a key name).
const HOST_PASS = 'hunter22';
const USER_PASS = 'correct horse';
const NEXT_PASS = 'brand new one';

test('first run only lets the host computer create the host account', (t) => {
  const store = makeStore(t);
  const auth = createAuth(store.options());
  assert.equal(auth.needsSetup(), true);

  assert.equal(auth.login({ username: 'Sam', password: HOST_PASS }, LOCAL).ok, false);
  assert.equal(auth.login({ username: 'Sam', password: HOST_PASS, setup: true }, REMOTE).ok, false);
  assert.equal(auth.needsSetup(), true);

  const created = auth.login({ username: 'Sam', password: HOST_PASS, setup: true }, LOCAL);
  assert.equal(created.ok, true);
  assert.equal(auth.needsSetup(), false);
  assert.equal(auth.isHost('sam'), true);
  assert.equal(auth.isTrusted('SAM'), true);
  // Setup is a one-shot: a second attempt is an ordinary (failing) login.
  assert.equal(auth.login({ username: 'Eve', password: HOST_PASS, setup: true }, LOCAL).ok, false);
  assert.equal(auth.isHost('Eve'), false);

  const saved = store.read();
  assert.equal(saved.users.sam.role, 'host');
  assert.equal(JSON.stringify(saved).includes(HOST_PASS), false, 'no plaintext password on disk');
});

test('logins are case-insensitive, canonical, and resumable by token', (t) => {
  const store = makeStore(t);
  const auth = createAuth(store.options());
  auth.login({ username: 'Sam', password: HOST_PASS, setup: true }, LOCAL);
  assert.equal(auth.createUser({ username: 'Alice', password: USER_PASS }).ok, true);
  assert.equal(auth.createUser({ username: 'alice', password: USER_PASS }).ok, false, 'duplicate name');
  assert.equal(auth.createUser({ username: 'Bo', password: 'abc' }).ok, false, 'short password');

  assert.equal(auth.login({ username: 'alice', password: 'nope' }, REMOTE).ok, false);
  const session = auth.login({ username: 'ALICE', password: USER_PASS }, REMOTE);
  assert.equal(session.ok, true);
  assert.equal(session.username, 'Alice');
  assert.equal(auth.isHost('Alice'), false);
  assert.equal(auth.isTrusted('Alice'), false);

  const tampered = session.token + 'x';
  const forged = ['QWxpY2U', '9999999999999', 'deadbeef'].join('.');
  assert.equal(auth.login({ token: session.token }, REMOTE).username, 'Alice');
  assert.equal(auth.login({ token: tampered }, REMOTE).ok, false);
  assert.equal(auth.login({ token: forged }, REMOTE).ok, false);

  // Sessions survive a restart (same file), not a password reset or a disable.
  const restarted = createAuth(store.options());
  assert.equal(restarted.verifyToken(session.token), 'Alice');
  const reset = restarted.updateUser('alice', { password: NEXT_PASS });
  assert.equal(reset.ok && reset.revoked, true);
  assert.equal(restarted.verifyToken(session.token), null);
  const fresh = restarted.login({ username: 'Alice', password: NEXT_PASS }, REMOTE);
  assert.equal(fresh.ok, true);
  assert.equal(restarted.updateUser('Alice', { disabled: true }).revoked, true);
  assert.equal(restarted.verifyToken(fresh.token), null);
  assert.equal(restarted.login({ username: 'Alice', password: NEXT_PASS }, REMOTE).ok, false);
  assert.equal(restarted.canonical('alice'), null);
  assert.equal(restarted.updateUser('Sam', { disabled: true }).ok, false, 'host cannot be disabled');
});

test('repeated wrong passwords lock the address out', (t) => {
  const store = makeStore(t);
  const auth = createAuth(store.options());
  auth.login({ username: 'Sam', password: HOST_PASS, setup: true }, LOCAL);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(auth.login({ username: 'Sam', password: 'wrong' }, REMOTE).ok, false);
  }
  const locked = auth.login({ username: 'Sam', password: HOST_PASS }, REMOTE);
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Too many attempts/);
  // Another address is unaffected.
  assert.equal(auth.login({ username: 'Sam', password: HOST_PASS }, LOCAL).ok, true);
});

test('hand-written accounts are hashed on load', (t) => {
  const store = makeStore(t);
  fs.writeFileSync(store.file, JSON.stringify({
    users: {
      boss: { username: 'Boss', role: 'host', password: USER_PASS },
      nina: { password: USER_PASS, trusted: true }
    }
  }));
  const auth = createAuth(store.options());
  assert.equal(auth.needsSetup(), false);
  assert.equal(auth.login({ username: 'boss', password: USER_PASS }, REMOTE).username, 'Boss');
  assert.equal(auth.login({ username: 'Nina', password: USER_PASS }, REMOTE).ok, true);
  assert.equal(auth.isHost('Boss'), true);
  assert.equal(auth.isTrusted('nina'), true);
  const saved = store.read();
  assert.equal(JSON.stringify(saved).includes(USER_PASS), false, 'plaintext removed from the file');
  assert.ok(saved.users.nina.hash && saved.users.nina.salt);
  assert.deepEqual(auth.list().map(user => user.username), ['Boss', 'nina']);
});

test('open-login mode keeps the legacy trusted table', (t) => {
  const store = makeStore(t);
  const auth = createAuth(store.options({ open: true }));
  assert.equal(auth.needsSetup(), false);
  const session = auth.login({ username: 'GM' }, REMOTE);
  assert.equal(session.ok, true);
  assert.equal(auth.isHost('gm'), true);
  assert.equal(auth.isHost('alice'), false);
  assert.equal(auth.isTrusted('alice'), true);
  assert.equal(auth.verifyToken(session.token), 'GM');
  assert.equal(fs.existsSync(store.file), false, 'open mode never writes accounts');
});
