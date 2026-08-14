const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');

let AuthenticatedMapReload;

before(async () => {
  const filename = path.resolve(__dirname, '..', 'public', 'js', 'shared', 'sync-state.js');
  const source = fs.readFileSync(filename, 'utf8');
  const encoded = Buffer.from(source).toString('base64');
  ({ AuthenticatedMapReload } = await import(`data:text/javascript;base64,${encoded}`));
});

test('anonymous pre-login map states cannot satisfy reconnect recovery', () => {
  const gate = new AuthenticatedMapReload();
  gate.onConnect();
  assert.equal(gate.acceptsMapState('world', 'world'), false);
  assert.equal(gate.reloadNeeded, true);

  gate.onAuthenticated();
  assert.equal(gate.acceptsMapState(undefined, 'world'), false);
  assert.equal(gate.acceptsMapState('world', 'world'), true);
  assert.equal(gate.shouldReplaceUnified(true), true);
  assert.equal(gate.onMapStateApplied(), true);
  assert.equal(gate.reloadNeeded, false);
  assert.equal(gate.shouldReplaceUnified(true), false);
});

test('disconnect waits for a matching authenticated state before clearing reload', () => {
  const gate = new AuthenticatedMapReload();
  gate.onAuthenticated();
  gate.onMapStateApplied();
  gate.onDisconnect();
  gate.onConnect();

  assert.equal(gate.acceptsMapState('world', 'world'), false);
  gate.onAuthenticated();
  assert.equal(gate.acceptsMapState('world', 'pocket/one'), false);
  assert.equal(gate.reloadNeeded, true);
  assert.equal(gate.acceptsMapState('pocket/one', 'pocket/one'), true);
  gate.onMapStateApplied();
  assert.equal(gate.reloadNeeded, false);
});
