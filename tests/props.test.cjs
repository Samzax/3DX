const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

test('server and client agree on the prop kinds', () => {
  const client = read('public', 'js', 'shared', 'props.js');
  const table = client.match(/export const PROP_KINDS = \{([\s\S]*?)\n\};/)[1];
  const kinds = [...table.matchAll(/^\s+([a-z]+):\s+\{/gm)].map(match => match[1]);
  const server = new Function(`return ${read('server.js').match(/const PROP_KINDS = (\[.*?\]);/)[1]};`)();
  assert.ok(kinds.length > 0);
  assert.deepEqual(server, kinds);
  // Every kind has a builder; nothing is built that cannot be placed.
  const builders = client.match(/const BUILDERS = \{([\s\S]*?)\n\};/)[1];
  const built = [...builders.matchAll(/^ {4}([a-z]+)\(k\) \{/gm)].map(match => match[1]);
  assert.deepEqual(built, kinds);
});
