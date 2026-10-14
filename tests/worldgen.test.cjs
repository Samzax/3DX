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
    assert.ok('relief' in preset.world, `preset ${preset.key} defines relief`);
    assert.equal(typeof preset.world.relief, 'number', `preset ${preset.key} relief is a number`);
    assert.deepEqual(normalizeWorld(preset.world), { ...preset.world, home: null }, preset.key);
  }
  // Every server biome has a generator field target and a GM swatch.
  const biomes = new Function(`return ${server.match(/const BIOME_KEYS = (\[.*?\]);/)[1]};`)();
  const terrain = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared', 'ground.js'), 'utf8');
  const gm = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pages', 'gm.js'), 'utf8');
  const fields = terrain.slice(terrain.indexOf('const BIOME_FIELDS'), terrain.indexOf('const BIOME_FEATHER'));
  const swatches = gm.slice(gm.indexOf('const BIOMES = {'), gm.indexOf('let currentBiome'));
  for (const biome of biomes) {
    assert.ok(fields.includes(` ${biome}:`), `ground BIOME_FIELDS.${biome}`);
    assert.ok(swatches.includes(` ${biome}:`), `gm BIOMES.${biome}`);
  }
});

test('relief world knob normalizes, scales vertical heights, and shifts snowline', async () => {
  const { WorldGen, WORLD_DEFAULTS, normalizeWorld, SNOW_T, presetKeyOf, WORLD_PRESETS } = await load();

  // 1. Normalization bounds
  assert.equal(normalizeWorld({ relief: 150 }).relief, 100);
  assert.equal(normalizeWorld({ relief: -5 }).relief, 0);
  assert.equal(normalizeWorld({}).relief, 0);
  assert.equal(normalizeWorld({ relief: '45' }).relief, 45);

  // Preset chip resolution
  assert.equal(presetKeyOf(WORLD_PRESETS.find(p => p.key === 'continents').world), 'continents');
  assert.equal(presetKeyOf(WORLD_PRESETS.find(p => p.key === 'highlands').world), 'highlands');
  assert.equal(presetKeyOf(WORLD_PRESETS.find(p => p.key === 'classic').world), 'classic');

  // 2. Vertical height scaling and relief monotonicity (0 < 30 < 60 < 100, same seed/home)
  const reliefs = [0, 30, 60, 100];
  const gens = reliefs.map(r => {
    const g = new WorldGen();
    g.set(1337, { home: { x: 0, z: 0 }, relief: r });
    return g;
  });
  const maxHeights = reliefs.map(() => -Infinity);
  for (let z = -6000; z <= 6000; z += 96) {
    for (let x = -6000; x <= 6000; x += 96) {
      for (let i = 0; i < gens.length; i++) {
        const e = gens[i].elev(x, z), mo = gens[i].moisture(x, z);
        const h = gens[i].height(e, mo, x, z, 0);
        if (h > maxHeights[i]) maxHeights[i] = h;
      }
    }
  }
  const [max0, max30, max60, max100] = maxHeights;
  assert.ok(max0 < max30, `relief 0 max (${max0}) < relief 30 max (${max30})`);
  assert.ok(max30 < max60, `relief 30 max (${max30}) < relief 60 max (${max60})`);
  assert.ok(max60 < max100, `relief 60 max (${max60}) < relief 100 max (${max100})`);
  assert.ok(max100 > max0 + 250, `relief 100 max (${max100}) should dwarf relief 0 max (${max0})`);
  assert.ok(max100 > 300, `relief 100 max (${max100}) must exceed 300 units`);

  // 3. Snowline retuning via lapse
  const g0 = gens[0];
  const g1 = gens[3];
  const tLowRelief = g0.temp(0, 0, 100);
  const tHighRelief = g1.temp(0, 0, 100);
  assert.ok(tLowRelief < SNOW_T, `relief 0 at h=100 (${tLowRelief}) must be below snowline (${SNOW_T})`);
  assert.ok(tHighRelief > SNOW_T, `relief 100 at h=100 (${tHighRelief}) must stay above snowline (${SNOW_T})`);

  // 4. Fog altitude deck headroom
  assert.equal(g0.fogAltitude, 80, 'classic world fog deck stays at 80');
  assert.ok(g1.fogAltitude > max100, 'relief 100 fog deck must sit above maximum sampled peak');

});

test('mountain heights on default and rugged worlds match manager-frozen goldens', async () => {
  const { WorldGen, WORLD_DEFAULTS } = await load();
  const defaultGoldens = [
    [-7944, -13835, 17.84051804380811, 13.340554850237865],
    [ -272, -12876, 17.10644380130454, 11.143081919294376],
    [ 6441, -12876, 17.493792347948766, 22.91999778125563],
    [-4382, -11780, 17.569870974398174, 19.561989348683188],
  ];
  const g1 = new WorldGen();
  g1.set(1337, { ...WORLD_DEFAULTS, home: { x: 0, z: 0 } });
  for (const [x, z, lod0, lod3] of defaultGoldens) {
    const e = g1.elev(x, z), mo = g1.moisture(x, z);
    assert.equal(g1.height(e, mo, x, z, 0), lod0);
    assert.equal(g1.height(e, mo, x, z, 3), lod3);
  }

  const ruggedGoldens = [
    [ -272, -14657, 20.5021016891563, 31.121150940496136],
    [-4930, -13972, 24.040507364686523, 13.92864444143328],
    [-9725, -13561, 29.904532445159337, 25.24579433192627],
    [ 6441, -12876, 26.24011062685688, 31.566737198424182],
  ];
  const g2 = new WorldGen();
  g2.set(1337, { ...WORLD_DEFAULTS, home: { x: 0, z: 0 }, rugged: 40 });
  for (const [x, z, lod0, lod3] of ruggedGoldens) {
    const e = g2.elev(x, z), mo = g2.moisture(x, z);
    assert.equal(g2.height(e, mo, x, z, 0), lod0);
    assert.equal(g2.height(e, mo, x, z, 3), lod3);
  }
});

test('far-ring parity: normalisation keeps lod3 mountain heights close to lod0', async () => {
  const { WorldGen } = await load();
  const g = new WorldGen();
  g.set(1337, { ocean: 60, landSize: 100, wetness: 0, temperature: 0, latitude: 50, rugged: 0, zones: 60, relief: 100 });
  let n = 0, sumAbs = 0;
  for (let z = -20000; z <= 20000; z += 40) {
    for (let x = -20000; x <= 20000; x += 40) {
      const e = g.elev(x, z);
      if (e < 0.72) continue;
      const mo = g.moisture(x, z);
      const h0 = g.height(e, mo, x, z, 0);
      const h3 = g.height(e, mo, x, z, 3);
      n++;
      sumAbs += Math.abs(h3 - h0);
    }
  }
  const meanAbs = sumAbs / n;
  // Measured post-fix mean |lod3 - lod0| is 65.36u.
  // With ~1.5x margin (65.36 * 1.5 = 98.04u), threshold is set to 100u.
  assert.ok(meanAbs < 100, `mean |lod3 - lod0| was ${meanAbs.toFixed(2)}u, expected < 100u`);
});

test('fog-headroom worst case: relief 100 and rugged 100 world', async () => {
  const { WorldGen, WORLD_DEFAULTS } = await load();
  const g = new WorldGen();
  g.set(1337, { ...WORLD_DEFAULTS, home: { x: 0, z: 0 }, relief: 100, rugged: 100 });
  let maxH = -Infinity;
  for (let z = -20000; z <= 20000; z += 250) {
    for (let x = -20000; x <= 20000; x += 250) {
      const e = g.elev(x, z);
      const mo = g.moisture(x, z);
      const h = g.height(e, mo, x, z, 0);
      if (h > maxH) maxH = h;
    }
  }
  assert.ok(g.fogAltitude > maxH, `fogAltitude (${g.fogAltitude}) must exceed max sampled height (${maxH.toFixed(1)})`);
});

