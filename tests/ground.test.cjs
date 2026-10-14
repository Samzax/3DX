const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { loadTerrainModule } = require('./helpers/load-browser-module.cjs');

const repoRoot = path.resolve(__dirname, '..');
const shared = (name) => path.join(repoRoot, 'public', 'js', 'shared', name);
const load = () => import(pathToFileURL(shared('ground.js')).href);

// A ground of plain functions: height(x, z), optional water level and snow.
const flatGround = (height, { water = -Infinity, snow = false } = {}) => ({
  height,
  waterDepth: (x, z, h) => Math.max(0, water - h),
  snow: () => snow
});

test('lattice constants and move modes mirror terrain.js and server.js', async () => {
  const ground = await load();
  const terrain = fs.readFileSync(shared('terrain.js'), 'utf8');
  const constant = (name) => Number(terrain.match(new RegExp(`const ${name} = ([\\d.]+);`))[1]);
  assert.equal(ground.VSPACE, constant('VSPACE'));
  assert.equal(ground.CHUNK_VERTS, constant('CHUNK_VERTS'));
  assert.equal(ground.HEIGHT_QUANT, constant('HEIGHT_QUANT'));
  const server = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const modes = new Function(`return ${server.match(/const MOVE_MODES = (\[.*?\]);/)[1]};`)();
  assert.deepEqual(modes, [...ground.MOVE_MODES]);
  assert.match(server, /movement: \{ terrain: true, snow: true, walls: true \}/);
  assert.deepEqual(ground.normalizeMovement(null), { terrain: true, snow: true, walls: true });
});

test('createGround reproduces the client terrain: generator, painted hexes and stored edits', async () => {
  const ground = await load();
  const { Terrain } = await loadTerrainModule(repoRoot);
  const settings = { seed: 1856312005, world: { ocean: 25, landSize: 230, wetness: 20, temperature: -30, latitude: 60, rugged: 30, zones: 100 }, season: 'winter' };
  const hexTree = { world: { '-2,5': { biome: 'mountains' } } };
  const terrain = new Terrain();
  terrain.applyWorldSettings(settings);
  terrain.setBiomeOverrides(hexTree);
  const model = ground.createGround({ ...settings, hexTree });
  for (const [x, z] of [[-136973.5, 339519.5], [-136751.3, 339289.9], [12.25, -40.75], [-139387.5, 340220.5]]) {
    const want = terrain.sampleHeight(x, z);
    assert.ok(Math.abs(model.height(x, z) - want) < 1e-6, `height at ${x},${z}`);
    assert.equal(model.snow(x, z, want), terrain.snowAt(x, z, want), `snow at ${x},${z}`);
  }

  // A stored chunk edit wins over the generator, at the sync quantization.
  const q = new Int16Array(ground.CHUNK_VERTS * ground.CHUNK_VERTS);
  for (let i = 0; i < q.length; i++) q[i] = (i % ground.CHUNK_VERTS) * 4; // 0.2 per vertex along x
  const chunks = { '0,0': { heights: Buffer.from(q.buffer).toString('base64') } };
  const edited = ground.createGround({ ...settings, chunks });
  assert.ok(Math.abs(edited.height(5, 3) - 10 * 0.2) < 1e-9);
  assert.ok(Math.abs(edited.height(5.25, 3) - 10.5 * 0.2) < 1e-9);
  // Pocket maps: no generator, flat where nothing is stored, never snow.
  const pocket = ground.createGround({ ...settings, generator: false, chunks });
  assert.equal(pocket.height(-200, 900), 0);
  assert.equal(pocket.snow(-200, 900, 0), false);
});

test('pathCost prices slopes, water and snow the 5e way', async () => {
  const { pathCost, describeCost } = await load();
  const from = { x: 0, z: 0 }, to = { x: 6, z: 0 }; // 30 ft
  const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual}`);

  const level = pathCost(from, to, flatGround(() => 0));
  close(level.feet, 30, 'flat feet'); close(level.cost, 30, 'flat cost');
  assert.deepEqual(level.kinds, {});

  // A gentle rise is free; ~35° is difficult terrain; a 60° face is a climb.
  close(pathCost(from, to, flatGround(x => x * 0.3)).cost, 30, 'gentle');
  const steep = pathCost(from, to, flatGround(x => x * 0.7));
  close(steep.cost, 60, 'steep'); assert.equal(describeCost(steep), 'steep ground');
  // ...whichever way it is crossed, and not for a climber.
  close(pathCost(from, to, flatGround((x, z) => z * 0.7)).cost, 60, 'traverse');
  close(pathCost(from, to, flatGround(x => x * 0.7), { modes: ['climb'] }).cost, 30, 'steep climber');
  const cliff = pathCost(from, to, flatGround(x => x * Math.sqrt(3)));
  close(cliff.cost, 30 * 2 * 2, 'climb: the slope length, doubled');
  assert.equal(describeCost(cliff), 'climbing');
  close(pathCost(from, to, flatGround(x => x * Math.sqrt(3)), { modes: ['climb'] }).cost, 60, 'climb speed');

  // Water: wading is difficult, deep water is swum.
  close(pathCost(from, to, flatGround(() => 0, { water: 0.3 })).cost, 60, 'wade');
  close(pathCost(from, to, flatGround(() => 0, { water: 2 })).cost, 60, 'swim');
  close(pathCost(from, to, flatGround(() => 0, { water: 2 }), { modes: ['swim'] }).cost, 30, 'swimmer');

  // Snow is difficult terrain, does not stack with a steep slope, can be off.
  close(pathCost(from, to, flatGround(() => 0, { snow: true })).cost, 60, 'snow');
  close(pathCost(from, to, flatGround(x => x * 0.7, { snow: true })).cost, 60, 'snow + steep');
  close(pathCost(from, to, flatGround(() => 0, { snow: true }), { snow: false }).cost, 30, 'snow off');
  close(pathCost(from, to, flatGround(x => x * Math.sqrt(3), { snow: true })).cost, 30 * 2 * 3, 'climbing in snow');

  // Off the ground (flying, a floor, a bridge) pays the plain distance.
  const air = pathCost({ ...from, y: 4 }, { ...to, y: 4 }, flatGround(() => 0, { snow: true }));
  close(air.cost, 30, 'airborne');
  // Both ends on the ground: the mover follows it through the dip between.
  const dip = pathCost({ ...from, y: 0 }, { ...to, y: 0 }, flatGround(x => -Math.sin(x / 6 * Math.PI) * 4));
  assert.ok(dip.cost > 45, `a ravine is not flown over: ${dip.cost}`);
});

test('waterDepthAt reads the sea and authored bodies', async () => {
  const { waterDepthAt, RIVER_DEPTH } = await load();
  assert.ok(waterDepthAt([], 0, 0, -2) > 1, 'sea');
  assert.equal(waterDepthAt([], 0, 0, -2, false), 0, 'no sea in a pocket');
  const lake = { kind: 'lake', seed: { x: 10, z: 10 }, level: 5, maxRadius: 20 };
  const basin = (x) => (x > 18 && x < 20 ? 9 : 3); // a ridge east of the lake
  assert.equal(waterDepthAt([lake], 12, 8, 3, true, basin), 2);
  assert.equal(waterDepthAt([lake], 12, 8, 6, true, basin), 0, 'shore above the level');
  assert.equal(waterDepthAt([lake], 25, 10, 3, true, basin), 0, 'low ground beyond the ridge is dry');
  assert.equal(waterDepthAt([lake], 80, 8, 3, true, basin), 0, 'outside its reach');
  const river = { kind: 'river', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], width: 3 };
  assert.equal(waterDepthAt([river], 5, 1, 4), RIVER_DEPTH);
  // Ice carries: water whose surface is cold enough for snow is walked on.
  const { pathCost } = await load();
  const frozen = { height: () => 0, waterDepth: () => 2, snow: () => true };
  assert.equal(Math.round(pathCost({ x: 0, z: 0 }, { x: 6, z: 0 }, frozen).cost), 60, 'ice is snow-covered ground');
  assert.equal(Math.round(pathCost({ x: 0, z: 0 }, { x: 6, z: 0 }, frozen, { snow: false }).cost), 30);
  assert.equal(waterDepthAt([river], 5, 3, 4), 0);
});
