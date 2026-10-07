const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'shared', 'worldgen.js')).href);

// Heights captured from the generator before world settings existed:
// [x, z, height, height at lod 3]. The default world must never drift.
const LEGACY = {
  1337: [
    [0, 0, -3.843334116609187, -5.5306818426889],
    [3000, 2000, -3.100239713996684, -4.149820270227898],
    [-70000, -60000, -0.3780831595860458, -0.9879291694744725],
    [150000, 90000, -9.263011473833267, -8.652704862651099]
  ],
  42: [
    [-62769, 12491, 0.75903229748743, 0.6453072581604193],
    [12345.5, -6789.5, -9.36084910214685, -9.665433043811175],
    [512, 512, -6.742531181801757, -7.844513621560752]
  ]
};

function landShare(gen, span = 1200000, n = 60) {
  let land = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = (i / n - 0.5) * span, z = (j / n - 0.5) * span;
    const e = gen.elev(x, z), mo = gen.moisture(x, z);
    if (gen.height(e, mo, x, z, 3) >= -0.6) land++;
  }
  return land / (n * n);
}

test('default world settings reproduce the original generator exactly', async () => {
  const { WorldGen } = await load();
  for (const seed of Object.keys(LEGACY)) {
    const gen = new WorldGen();
    gen.set(Number(seed), undefined);
    for (const [x, z, h, h3] of LEGACY[seed]) {
      const e = gen.elev(x, z), mo = gen.moisture(x, z);
      assert.equal(gen.height(e, mo, x, z, 0), h);
      assert.equal(gen.height(e, mo, x, z, 3), h3);
    }
  }
});

test('world knobs steer the generator', async () => {
  const { WorldGen, WORLD_PRESETS, SNOW_T } = await load();
  const gen = new WorldGen();
  assert.equal(gen.set(7, {}), true);
  assert.equal(gen.set(7, {}), false, 'unchanged settings report no change');

  // Less ocean means more land.
  gen.set(7, { ocean: 85 }); const wet = landShare(gen);
  gen.set(7, { ocean: 30 }); const dry = landShare(gen);
  assert.ok(dry > wet + 0.2, `land share ${wet} -> ${dry}`);

  // A homeland guarantees land at a point that is otherwise deep ocean.
  gen.set(1856312005, {});
  assert.ok(gen.height(gen.elev(0, 0), gen.moisture(0, 0), 0, 0) < -0.6);
  gen.set(1856312005, { home: { x: 0, z: 0 } });
  let land = 0;
  for (let x = -6000; x <= 6000; x += 1000) for (let z = -6000; z <= 6000; z += 1000) {
    if (gen.height(gen.elev(x, z), gen.moisture(x, z), x, z) >= -0.6) land++;
  }
  assert.ok(land / 169 > 0.8, `homeland land share ${land / 169}`);
  assert.ok(gen.height(gen.elev(0, 0), gen.moisture(0, 0), 0, 0) > 0, 'the home point itself is dry land');

  // Temperature: the frozen preset is cold at sea level, the default is not,
  // and altitude always cools.
  const frozen = WORLD_PRESETS.find(p => p.key === 'frozen').world;
  gen.set(7, frozen);
  assert.ok(gen.temp(0, 0, 0) < 0.42);
  assert.ok(gen.temp(0, 0, 12) < SNOW_T);
  assert.ok(['tundra', 'taiga', 'snow'].includes(gen.biome(0.55, 0.5, gen.temp(0, 0, 1))));
  gen.set(7, {});
  assert.ok(gen.temp(0, 0, 0) > 0.45);
  assert.ok(gen.temp(0, 0, 30) < gen.temp(0, 0, 0));
  assert.equal(gen.biome(0.55, 0.5, gen.temp(0, 0, 1)), 'plains');

  // Latitude bands: north (-z) is colder than south.
  gen.set(7, { latitude: 100 });
  assert.ok(gen.temp(0, -180000, 0) < gen.temp(0, 180000, 0) - 0.3);
});

test('server and client agree on world limits, seasons and biomes', async () => {
  const { WORLD_LIMITS, WORLD_DEFAULTS, SEASON_KEYS, WORLD_PRESETS, normalizeWorld } = await load();
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const limits = new Function(`return (${server.match(/const WORLD_LIMITS = (\{[\s\S]*?\});/)[1]});`)();
  assert.deepEqual(limits, WORLD_LIMITS);
  const seasons = new Function(`return ${server.match(/const SEASON_KEYS = (\[.*?\]);/)[1]};`)();
  assert.deepEqual([...seasons].sort(), [...SEASON_KEYS].sort());
  const defaults = new Function(`return (${server.match(/world: (\{ ocean: 80[^}]*\})/)[1]});`)();
  assert.deepEqual(defaults, WORLD_DEFAULTS);
  // Every preset is already inside the limits (so the server stores it as-is).
  for (const preset of WORLD_PRESETS) {
    assert.deepEqual(normalizeWorld(preset.world), { ...preset.world, home: null }, preset.key);
  }
  // Every server biome has a generator field target and a GM swatch.
  const biomes = new Function(`return ${server.match(/const BIOME_KEYS = (\[.*?\]);/)[1]};`)();
  const terrain = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared', 'terrain.js'), 'utf8');
  const gm = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pages', 'gm.js'), 'utf8');
  const fields = terrain.slice(terrain.indexOf('const BIOME_FIELDS'), terrain.indexOf('const BIOME_FEATHER'));
  const swatches = gm.slice(gm.indexOf('const BIOMES = {'), gm.indexOf('let currentBiome'));
  for (const biome of biomes) {
    assert.ok(fields.includes(` ${biome}:`), `terrain BIOME_FIELDS.${biome}`);
    assert.ok(swatches.includes(` ${biome}:`), `gm BIOMES.${biome}`);
  }
});
