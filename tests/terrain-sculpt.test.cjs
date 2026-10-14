const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const { loadTerrainModule } = require('./helpers/load-browser-module.cjs');

const repoRoot = path.resolve(__dirname, '..');
let terrainMod;

before(async () => {
  terrainMod = await loadTerrainModule(repoRoot);
});

test('Terrain instantiates headlessly with default generatorOn and forwards fogAltitude', () => {
  const { Terrain } = terrainMod;
  const t = new Terrain();
  assert.equal(t.generatorOn, true, 'generatorOn must default to true');
  assert.equal(typeof t.fogAltitude, 'number');
  assert.equal(t.fogAltitude, t.gen.fogAltitude, 'terrain.fogAltitude forwards gen.fogAltitude');
});

test('GM sculpt height is unclamped: stores large positive and deep negative heights', () => {
  const { Terrain } = terrainMod;
  const t = new Terrain();

  // Positive sculpt beyond old HEIGHT_LIMIT = 50
  t.setH(0, 0, 450);
  assert.equal(t.getH(0, 0), 450, 'setH stores 450 without clamping at 50');

  // Deep negative sculpt beyond old -HEIGHT_LIMIT = -50
  t.setH(1, 1, -320);
  assert.equal(t.getH(1, 1), -320, 'setH stores -320 without clamping at -50');
});
