// weather.js — the pure sky clock + weather model (no three.js and no DOM, so
// Node tests import it). A campaign's `settings.sky` says what the GM pinned;
// everything left on "natural" is a pure function of (seed, place, climate,
// wall-clock time), so every screen computes the same sky and nothing but the
// settings is ever synced. atmosphere.js turns the result into light and
// particles; server.js mirrors the keys and bounds below.

import { fbm, SNOW_T } from './worldgen.js';

export const WEATHER_KEYS = ['auto', 'clear', 'cloudy', 'overcast', 'rain', 'storm', 'snow', 'fog'];
export const RAINBOW_KEYS = ['auto', 'on', 'off'];
export const SKY_CLOCKS = ['fixed', 'cycle'];
export const SKY_LIMITS = { dayMinutes: [2, 1440] };
// hour: the game hour at `at` (a server-stamped epoch ms). A fixed clock stays
// on `hour`; a cycling clock runs one game day per `dayMinutes` real minutes.
export const SKY_DEFAULTS = { clock: 'fixed', hour: 10, dayMinutes: 24, at: 0, weather: 'auto', rainbow: 'auto' };

export const WEATHER_LABELS = {
  auto: 'Natural', clear: 'Clear', cloudy: 'Cloudy', overcast: 'Overcast',
  rain: 'Rain', storm: 'Storm', snow: 'Snow', fog: 'Fog'
};
// What each pinned weather means. cloud/rain/snow/fog/storm/wind are all 0..1.
export const WEATHER_PRESETS = {
  clear:    { cloud: 0.06, rain: 0,    snow: 0,   fog: 0,    storm: 0, wind: 0.2 },
  cloudy:   { cloud: 0.5,  rain: 0,    snow: 0,   fog: 0,    storm: 0, wind: 0.35 },
  overcast: { cloud: 0.95, rain: 0,    snow: 0,   fog: 0.1,  storm: 0, wind: 0.35 },
  rain:     { cloud: 0.9,  rain: 0.65, snow: 0,   fog: 0.15, storm: 0, wind: 0.45 },
  storm:    { cloud: 1,    rain: 1,    snow: 0,   fog: 0.2,  storm: 1, wind: 1 },
  snow:     { cloud: 0.85, rain: 0,    snow: 0.8, fog: 0.2,  storm: 0, wind: 0.3 },
  fog:      { cloud: 0.55, rain: 0,    snow: 0,   fog: 1,    storm: 0, wind: 0.1 }
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const wrapHour = (h) => ((h % 24) + 24) % 24;

export function normalizeSky(raw) {
  const s = raw || {}, out = { ...SKY_DEFAULTS };
  if (SKY_CLOCKS.includes(s.clock)) out.clock = s.clock;
  if (Number.isFinite(Number(s.hour)) && s.hour != null) out.hour = wrapHour(Number(s.hour));
  if (Number.isFinite(Number(s.dayMinutes)) && s.dayMinutes != null) {
    out.dayMinutes = Math.max(SKY_LIMITS.dayMinutes[0], Math.min(SKY_LIMITS.dayMinutes[1], Number(s.dayMinutes)));
  }
  if (Number.isFinite(Number(s.at)) && Number(s.at) > 0) out.at = Number(s.at);
  if (WEATHER_KEYS.includes(s.weather)) out.weather = s.weather;
  if (RAINBOW_KEYS.includes(s.rainbow)) out.rainbow = s.rainbow;
  return out;
}

// Game days elapsed since the clock was last set (fractional; 0 when fixed).
function daysSince(sky, now) {
  if (sky.clock !== 'cycle' || !sky.at) return 0;
  return Math.max(0, now - sky.at) / (sky.dayMinutes * 60000);
}
// The current game hour, 0..24.
export function hourAt(sky, now = Date.now()) {
  return wrapHour(sky.hour + daysSince(sky, now) * 24);
}
// Moon phase 0..1 (0 new, 0.5 full): a 28-day month that only advances while
// the clock cycles. A fixed clock keeps a bright gibbous moon.
export function moonPhaseAt(sky, now = Date.now()) {
  const days = Math.floor((sky.hour + daysSince(sky, now) * 24) / 24);
  return ((0.4 + days / 28) % 1 + 1) % 1;
}

export function formatHour(hour) {
  const total = Math.round(wrapHour(hour) * 60) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Unit vectors TOWARD the sun / moon. The sun rises in the east (+x) at 06:00,
// stands to the south at noon and never passes overhead, so slopes and props
// always throw readable relief. The moon keeps the opposite side of the sky.
function arcDirection(theta) {
  const s = Math.sin(theta);
  const x = Math.cos(theta), y = s * 0.8, z = 0.35 + 0.2 * s;
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
}
export function sunDirection(hour) { return arcDirection((wrapHour(hour) - 6) / 12 * Math.PI); }
export function moonDirection(hour) { return arcDirection((wrapHour(hour) - 18) / 12 * Math.PI); }

// --- natural weather ---
// Weather fronts are slow noise drifting over the map; the local climate
// decides what a front becomes there: wet country clouds over and rains,
// deserts stay clear, cold air turns rain to snow, damp dawns bring fog.
const FRONT_SCALE = 1 / 9000;         // a front spans a few miles
const FRONT_PERIOD_MS = 15 * 60000;   // real minutes for a front to move on
// fbm() is a sum of uniform lattices: recentre it to a rough -1..1.
const centered = (v, octaves) => {
  const mean = octaves === 2 ? 0.375 : 0.4375;
  return Math.max(-1, Math.min(1, (v - mean) / 0.22));
};

// ctx: { seed, x, z (true world coords), temp (season included, 0..1),
// moisture (0..1), hour, now }.
export function naturalWeather(ctx) {
  const seed = (ctx.seed | 0) || 0;
  const t = (ctx.now != null ? ctx.now : Date.now()) / FRONT_PERIOD_MS;
  // Keep the drift small: fbm loses precision on huge lattice coordinates.
  const drift = t % 4096;
  const px = ctx.x * FRONT_SCALE, pz = ctx.z * FRONT_SCALE;
  const front = centered(fbm(seed + 900, px + drift * 0.35, pz + drift * 0.12, 3), 3) * 0.75 +
    centered(fbm(seed + 950, px * 0.5 - drift * 0.1, pz * 0.5 + drift * 0.2, 2), 2) * 0.25;
  const humid = clamp01(((ctx.moisture != null ? ctx.moisture : 0.47) - 0.25) / 0.5);
  const temp = ctx.temp != null ? ctx.temp : 0.55;

  const cloud = clamp01(0.4 + front * 0.55 + (humid - 0.5) * 0.6);
  const precip = sstep(0.7, 1, cloud) * (0.35 + 0.65 * humid);
  const freezing = sstep(SNOW_T + 0.07, SNOW_T + 0.01, temp);    // 1 = snow, 0 = rain
  const rain = precip * (1 - freezing), snow = precip * freezing;
  const storm = sstep(0.86, 1, rain) * sstep(0.42, 0.52, temp);

  const hour = ctx.hour != null ? ctx.hour : 12;
  const dawn = Math.max(0, 1 - Math.abs(hour - 6.5) / 2.5);
  const mist = centered(fbm(seed + 990, px * 1.7 + drift * 0.05, pz * 1.7 - drift * 0.03, 2), 2);
  const fog = clamp01((mist * 0.5 + (humid - 0.5) * 0.7 + dawn * 0.45 - 0.4) / 0.4) * (1 - precip * 0.6);

  const gust = centered(fbm(seed + 970, px * 0.8 + drift * 0.3, pz * 0.8, 2), 2);
  const wind = clamp01(0.3 + gust * 0.3 + storm * 0.5 + precip * 0.15);
  return { cloud, rain, snow, fog, storm, wind };
}

// The weather to render: the GM's pinned preset, or the natural one. Adds
// `rainbow` (0..1): sun behind you, rain in front — a low sun and light rain.
// ctx as naturalWeather, plus sunY (the sun direction's y) for the rainbow.
export function resolveWeather(sky, ctx) {
  const pinned = WEATHER_PRESETS[sky.weather];
  const w = pinned ? { ...pinned } : naturalWeather(ctx);
  if (pinned && pinned.rain > 0 && ctx.temp != null && ctx.temp < SNOW_T) {
    // A pinned rain over frozen ground falls as snow; "Snow" always snows.
    w.snow = w.rain; w.rain = 0; w.storm = 0;
  }
  const sunY = ctx.sunY != null ? ctx.sunY : 0.6;
  const sunLow = sstep(0.02, 0.12, sunY) * (1 - sstep(0.55, 0.68, sunY));
  if (sky.rainbow === 'off') w.rainbow = 0;
  else if (sky.rainbow === 'on') w.rainbow = Math.max(0.3, sstep(-0.05, 0.1, sunY));
  else w.rainbow = sunLow * sstep(0.02, 0.15, w.rain) * (1 - sstep(0.45, 0.85, w.rain));
  return w;
}

// A short human label for a weather state (HUD chip / GM panel readout).
export function describeWeather(w) {
  if (w.storm > 0.4) return 'Thunderstorm';
  if (w.snow > 0.88) return 'Heavy snow';
  if (w.snow > 0.05) return 'Snow';
  if (w.rain > 0.8) return 'Heavy rain';
  if (w.rain > 0.05) return w.rainbow > 0.3 ? 'Rain and a rainbow' : 'Rain';
  if (w.fog > 0.6) return 'Thick fog';
  if (w.fog > 0.25) return 'Mist';
  if (w.cloud > 0.8) return 'Overcast';
  if (w.cloud > 0.35) return 'Cloudy';
  return w.rainbow > 0.3 ? 'Clear, rainbow' : 'Clear';
}

export function describeHour(hour) {
  const h = wrapHour(hour);
  if (h < 4.5) return 'Night';
  if (h < 7) return 'Dawn';
  if (h < 11.5) return 'Morning';
  if (h < 13.5) return 'Midday';
  if (h < 17) return 'Afternoon';
  if (h < 19.5) return 'Dusk';
  return h < 21.5 ? 'Evening' : 'Night';
}
