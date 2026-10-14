const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'shared', 'weather.js')).href);

test('server and client agree on sky keys, bounds and defaults', async () => {
  const { WEATHER_KEYS, RAINBOW_KEYS, SKY_CLOCKS, SKY_LIMITS, SKY_DEFAULTS, WEATHER_PRESETS, WEATHER_LABELS } = await load();
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const literal = (name) => new Function(`return ${server.match(new RegExp(`const ${name} = (\\[.*?\\]);`))[1]};`)();
  assert.deepEqual(literal('WEATHER_KEYS'), WEATHER_KEYS);
  assert.deepEqual(literal('RAINBOW_KEYS'), RAINBOW_KEYS);
  assert.deepEqual(literal('SKY_CLOCKS'), SKY_CLOCKS);
  assert.deepEqual(literal('SKY_DAY_MINUTES'), SKY_LIMITS.dayMinutes);
  const defaults = new Function(`return ${server.match(/sky: (\{ clock: .*?\}),/)[1]};`)();
  assert.deepEqual(defaults, SKY_DEFAULTS);
  // Every pinned weather has a preset and a label; "auto" is the natural one.
  for (const key of WEATHER_KEYS) {
    assert.ok(WEATHER_LABELS[key], key);
    assert.equal(!!WEATHER_PRESETS[key], key !== 'auto', key);
  }
});

test('the clock holds when fixed and runs when cycling', async () => {
  const { normalizeSky, hourAt, moonPhaseAt, formatHour } = await load();
  const fixed = normalizeSky({ hour: 21.5, at: 1000 });
  assert.equal(hourAt(fixed, 1000), 21.5);
  assert.equal(hourAt(fixed, 1000 + 86400000), 21.5);

  // One game day every 24 real minutes: an hour a minute.
  const cycle = normalizeSky({ clock: 'cycle', hour: 22, dayMinutes: 24, at: 5000 });
  assert.equal(hourAt(cycle, 5000), 22);
  assert.ok(Math.abs(hourAt(cycle, 5000 + 3 * 60000) - 1) < 1e-9);       // wraps past midnight
  assert.equal(hourAt(cycle, 4000), 22);                                  // a slow client clock never rewinds
  assert.notEqual(moonPhaseAt(cycle, 5000), moonPhaseAt(cycle, 5000 + 5 * 24 * 60000));

  assert.equal(formatHour(6.25), '06:15');
  assert.equal(formatHour(23.999), '00:00');
  assert.deepEqual(normalizeSky({ clock: 'warp', hour: 'x', dayMinutes: 0, weather: 'frogs', rainbow: 1 }),
    { clock: 'fixed', hour: 10, dayMinutes: 2, at: 0, weather: 'auto', rainbow: 'auto' });
});

test('the sun is up by day, the moon by night', async () => {
  const { sunDirection, moonDirection } = await load();
  for (const hour of [0, 3, 6, 10, 12, 15, 18, 21]) {
    const sun = sunDirection(hour), moon = moonDirection(hour);
    assert.ok(Math.abs(Math.hypot(sun.x, sun.y, sun.z) - 1) < 1e-9);
    assert.equal(sun.y > 0.01, hour > 6 && hour < 18, `sun at ${hour}`);
    assert.equal(moon.y > 0.01, hour < 6 || hour > 18, `moon at ${hour}`);
  }
  assert.ok(sunDirection(7).x > 0 && sunDirection(17).x < 0);   // east to west
  assert.ok(sunDirection(12).y < 0.9);                          // never overhead: relief stays readable
});

test('natural weather is deterministic and follows the climate', async () => {
  const { naturalWeather, resolveWeather, normalizeSky } = await load();
  const base = { seed: 1337, x: 1200, z: -800, temp: 0.55, moisture: 0.5, hour: 12, now: 1.7e12 };
  assert.deepEqual(naturalWeather(base), naturalWeather({ ...base }));

  // Sample many places and times: deserts stay drier than rainforest, cold
  // air snows instead of raining, and every value stays in 0..1.
  const mean = (ctx) => {
    const sum = { cloud: 0, rain: 0, snow: 0, fog: 0 };
    let n = 0;
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
      const w = naturalWeather({ ...ctx, x: i * 7000, z: j * 7000, now: 1.7e12 + (i * 40 + j) * 2.1e6 });
      for (const key of Object.keys(w)) assert.ok(w[key] >= 0 && w[key] <= 1, `${key}=${w[key]}`);
      for (const key of Object.keys(sum)) sum[key] += w[key];
      n++;
    }
    for (const key of Object.keys(sum)) sum[key] /= n;
    return sum;
  };
  const desert = mean({ ...base, moisture: 0.2 });
  const jungle = mean({ ...base, moisture: 0.75 });
  const tundra = mean({ ...base, moisture: 0.6, temp: 0.15 });
  assert.ok(desert.cloud < jungle.cloud - 0.2, `${desert.cloud} vs ${jungle.cloud}`);
  assert.ok(desert.rain < 0.03 && jungle.rain > 0.08, `${desert.rain} / ${jungle.rain}`);
  assert.equal(tundra.rain, 0);
  assert.ok(tundra.snow > 0.03, String(tundra.snow));
  assert.ok(mean({ ...base, hour: 6.5, moisture: 0.6 }).fog > mean({ ...base, hour: 14, moisture: 0.6 }).fog);

  // Pinned weather ignores the climate, except that rain freezes into snow.
  const rain = resolveWeather(normalizeSky({ weather: 'rain' }), { ...base, moisture: 0.1 });
  assert.ok(rain.rain > 0.5 && rain.snow === 0);
  const frozen = resolveWeather(normalizeSky({ weather: 'rain' }), { ...base, temp: 0.1 });
  assert.ok(frozen.snow > 0.5 && frozen.rain === 0);
  assert.ok(resolveWeather(normalizeSky({ weather: 'snow' }), base).snow > 0.5);
});

test('rainbows need sun and light rain unless the GM says otherwise', async () => {
  const { resolveWeather, normalizeSky, WEATHER_PRESETS } = await load();
  const ctx = { seed: 1, x: 0, z: 0, temp: 0.55, moisture: 0.5, hour: 17, now: 1.7e12, sunY: 0.3 };
  assert.equal(resolveWeather(normalizeSky({ weather: 'clear' }), ctx).rainbow, 0);
  assert.equal(resolveWeather(normalizeSky({ weather: 'clear', rainbow: 'on' }), ctx).rainbow, 1);
  assert.equal(resolveWeather(normalizeSky({ weather: 'rain', rainbow: 'off' }), ctx).rainbow, 0);
  assert.ok(WEATHER_PRESETS.rain.rain > 0.45);
  const shower = resolveWeather(normalizeSky({ weather: 'rain' }), ctx).rainbow;
  assert.ok(shower > 0.1 && shower < 1, String(shower));                 // a pinned rain shows a faint bow
  assert.equal(resolveWeather(normalizeSky({ weather: 'rain' }), { ...ctx, sunY: -0.4 }).rainbow, 0);   // not at night
});
