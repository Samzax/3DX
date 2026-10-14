// atmosphere.js — the sky and weather of the tabletop, shared by /gm and
// /player: time of day (sun, moon, stars, light and fog colours), clouds,
// rain, snow, weather fog, lightning and rainbows. weather.js decides WHAT the
// sky is doing (campaign settings.sky + the local climate); this module only
// renders it, so both screens agree without syncing anything per frame.
//
// One camera-centred dome draws the whole sky in a single shader (gradient,
// sun/moon discs, stars, cloud deck, rainbow). Its horizon colour is also the
// scene fog colour, so distant terrain still melts into the sky with no seam.

import * as THREE from 'three';
import { SUN_DIR } from './scene.js';
import {
    normalizeSky, hourAt, moonPhaseAt, sunDirection, moonDirection, resolveWeather,
    describeWeather, describeHour, formatHour, WEATHER_PRESETS
} from './weather.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// Sky palette keyframes (authored for the linear, un-tonemapped renderer).
// The day values ARE the pre-atmosphere look: a clear mid-morning is unchanged.
const C = (hex) => new THREE.Color(hex);
const PAL = {
    zenithDay: C(0x5b8ac4), zenithDusk: C(0x39477f), zenithNight: C(0x070b1d),
    horizonDay: C(0xbcd6ea), horizonDusk: C(0xf0a878), horizonNight: C(0x141c36),
    sunDay: C(0xffe8c4), sunDusk: C(0xffb066), moon: C(0x9db8ff),
    hemiSkyDay: C(0xcfe3f2), hemiSkyDusk: C(0xc9a9b4), hemiSkyNight: C(0x7088d0),
    hemiGroundDay: C(0x8f7f5f), hemiGroundNight: C(0x2c3350),
    greyZenith: C(0x67727e), greyHorizon: C(0x97a1aa), fog: C(0xbcc3c8),
    waterNight: C(0x39486f)
};
// The pocket-map look and the GM's "what does the clear morning look like".
const INDOOR_HOUR = 10;
const WEATHER_KEYS_NUM = ['cloud', 'rain', 'snow', 'fog', 'storm', 'wind', 'rainbow'];

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uZenith, uHorizon, uSunDir, uMoonDir, uSunColor, uCloudLit, uCloudDark;
uniform float uSunVis, uMoonVis, uMoonPhase, uStars, uCloud, uTime, uRainbow, uFlash, uFog;
uniform vec2 uWind;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p = p * 2.03 + 17.0; a *= 0.5; }
  return v / 0.9375;
}
vec3 spectrum(float t) {   // 0 violet (inner edge) .. 1 red (outer edge)
  float h = (1.0 - t) * 0.78;
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.6));

  // Stars: one per lit cell of a 3D lattice the view ray passes through.
  if (uStars > 0.01) {
    vec3 sp = d * 90.0, cell = floor(sp);
    float r = hash3(cell);
    if (r > 0.962) {
      float tw = 0.65 + 0.35 * sin(uTime * (1.0 + r * 3.0) + r * 90.0);
      col += smoothstep(0.3, 0.0, length(sp - cell - 0.5)) * tw * uStars * (0.5 + 12.0 * (r - 0.962));
    }
  }

  // Sun: a soft disc inside a warm glow that spreads along the horizon when low.
  float sd = dot(d, uSunDir);
  float glow = pow(max(sd, 0.0), 6.0) * 0.28 + pow(max(sd, 0.0), 48.0) * 0.4;
  col += uSunColor * glow * uSunVis * (1.0 - 0.7 * uCloud);
  col = mix(col, vec3(1.0, 0.97, 0.88), smoothstep(0.99905, 0.9994, sd) * uSunVis);

  // Moon: lit limb per phase (0 new .. 0.5 full), faint earthshine on the rest.
  float md = dot(d, uMoonDir);
  col += vec3(0.55, 0.65, 0.9) * pow(max(md, 0.0), 90.0) * 0.22 * uMoonVis;
  if (md > 0.9991) {
    vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
    vec3 mu = cross(uMoonDir, mr);
    vec2 mp = vec2(dot(d, mr), dot(d, mu)) / 0.0424;
    float inside = 1.0 - smoothstep(0.92, 1.0, length(mp));
    float limb = cos(6.2832 * uMoonPhase) * sqrt(max(0.0, 1.0 - mp.y * mp.y));
    float lit = smoothstep(limb - 0.08, limb + 0.08, mp.x);
    float mare = 0.86 + 0.14 * vnoise(mp * 2.6 + 4.0);
    col = mix(col, vec3(0.93, 0.95, 1.0) * mare * mix(0.07, 1.0, lit), inside * uMoonVis);
  }

  // Cloud deck: noise on a plane overhead, drifting with the wind.
  float cover = 0.0;
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.14) * 1.25 + uWind * uTime;
    float n = fbm(uv);
    float thr = mix(0.92, 0.12, uCloud);
    cover = smoothstep(thr, thr + 0.28, n) * smoothstep(0.0, 0.1, d.y);
    vec3 cc = mix(uCloudLit, uCloudDark, smoothstep(thr + 0.08, thr + 0.6, n));
    cc += uSunColor * pow(max(sd, 0.0), 10.0) * 0.25 * uSunVis;
    col = mix(col, cc, cover * 0.94);
  }
  col += vec3(0.55, 0.6, 0.8) * uFlash * (0.25 + 0.75 * cover);

  // Rainbow: the 42-degree circle around the antisolar point, above the horizon.
  if (uRainbow > 0.005) {
    float ang = degrees(acos(clamp(-sd, -1.0, 1.0)));
    float t = (ang - 39.6) / 3.0;
    float band = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.82, 1.0, t));
    col += spectrum(clamp(t, 0.0, 1.0)) * band * uRainbow * 0.4 * smoothstep(0.0, 0.07, d.y);
  }

  // Fog swallows the sky; below the horizon the dome is the fog colour
  // distant ground fades into.
  col = mix(uHorizon, col, smoothstep(-0.02, 0.01, d.y) * (1.0 - uFog));
  gl_FragColor = vec4(col, 1.0);
}`;

// Rain streaks and snowflakes share one trick: every particle owns a fixed
// slot in a wrapping box that follows the view, so the fall is seamless and
// costs nothing per particle on the CPU. `position` is the slot (0..1 cube).
const FALL_COMMON = `
uniform vec3 uCenter, uSize, uOffset;
uniform float uNear;
varying float vAlpha;
vec3 slot(out float edge) {
  vec3 rel = fract(position + uOffset) - 0.5;
  vec3 p = uCenter + rel * uSize;
  edge = (1.0 - smoothstep(0.36, 0.5, max(abs(rel.x), abs(rel.z)))) * (1.0 - smoothstep(0.4, 0.5, abs(rel.y)));
  // Nothing falls right in front of the lens: it would smear across the table.
  edge *= smoothstep(uNear * 0.5, uNear, distance(p, cameraPosition));
  return p;
}`;
const RAIN_VERT = `${FALL_COMMON}
uniform vec3 uStreak;
attribute float aEnd;
void main() {
  float edge;
  vec3 p = slot(edge) + uStreak * aEnd * (0.55 + 0.9 * position.x);
  vAlpha = edge * (1.0 - 0.7 * aEnd);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SNOW_VERT = `${FALL_COMMON}
uniform float uTime, uSway, uFlake, uViewH;
void main() {
  float edge;
  vec3 p = slot(edge);
  p.x += sin(uTime * 0.9 + position.y * 40.0) * uSway;
  p.z += cos(uTime * 0.7 + position.x * 40.0) * uSway;
  vAlpha = edge;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uFlake * projectionMatrix[1][1] * uViewH * 0.5 / max(0.001, -mv.z), 1.5, 7.0) * (0.6 + 0.8 * position.z);
  gl_Position = projectionMatrix * mv;
}`;
const RAIN_FRAG = `
uniform vec3 uColor; uniform float uOpacity; varying float vAlpha;
void main() { gl_FragColor = vec4(uColor, uOpacity * vAlpha); }`;
const SNOW_FRAG = `
uniform vec3 uColor; uniform float uOpacity; varying float vAlpha;
void main() {
  float a = smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor, uOpacity * vAlpha * a);
}`;

const RAIN_DROPS = 5000, SNOW_FLAKES = 3500;

function makeFall(count, perParticle, vertexShader, fragmentShader, extraUniforms) {
    const slots = new Float32Array(count * perParticle * 3);
    const ends = new Float32Array(count * perParticle);
    for (let i = 0; i < count; i++) {
        const x = Math.random(), y = Math.random(), z = Math.random();
        for (let v = 0; v < perParticle; v++) {
            slots.set([x, y, z], (i * perParticle + v) * 3);
            ends[i * perParticle + v] = v;
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(slots, 3));
    if (perParticle > 1) geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: {
            uCenter: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3(1, 1, 1) },
            uOffset: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(1, 1, 1) },
            uOpacity: { value: 0 }, uNear: { value: 1 }, ...extraUniforms
        },
        vertexShader, fragmentShader
    });
    const mesh = perParticle > 1 ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 900;
    return { mesh, uniforms: material.uniforms, offset: new THREE.Vector3(), count, perParticle };
}

// createAtmosphere({ scene, camera, renderer, dirLight }) -> {
//   setSky(settings.sky), setSeed(seed), previewHour(hour|null),
//   update({ target, dist, terrain, outdoors }), info }
// Call update() once per frame AFTER the page set scene.fog near/far.
export function createAtmosphere({ scene, camera, renderer, dirLight }) {
    let hemiLight = null;
    scene.traverse((o) => { if (o.isHemisphereLight) hemiLight = o; });

    const skyUniforms = {
        uZenith: { value: PAL.zenithDay.clone() }, uHorizon: { value: PAL.horizonDay.clone() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunColor: { value: PAL.sunDay.clone() },
        uCloudLit: { value: new THREE.Color(1, 1, 1) }, uCloudDark: { value: new THREE.Color(0.6, 0.6, 0.6) },
        uSunVis: { value: 1 }, uMoonVis: { value: 0 }, uMoonPhase: { value: 0.4 }, uStars: { value: 0 },
        uCloud: { value: 0 }, uTime: { value: 0 }, uRainbow: { value: 0 }, uFlash: { value: 0 }, uFog: { value: 0 },
        uWind: { value: new THREE.Vector2(0.012, 0.005) }
    };
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 16),
        new THREE.ShaderMaterial({
            uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
            side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false
        }));
    dome.name = 'sky-dome';
    dome.frustumCulled = false;
    dome.renderOrder = -1000;       // first thing drawn; everything else paints over it
    scene.add(dome);
    // The dome replaces the old gradient texture; keep a plain colour behind it.
    if (scene.background && scene.background.isTexture) scene.background.dispose();
    scene.background = PAL.horizonDay.clone();

    const rain = makeFall(RAIN_DROPS, 2, RAIN_VERT, RAIN_FRAG, { uStreak: { value: new THREE.Vector3() } });
    const snow = makeFall(SNOW_FLAKES, 1, SNOW_VERT, SNOW_FRAG, {
        uTime: skyUniforms.uTime, uSway: { value: 0.3 }, uFlake: { value: 0.2 }, uViewH: { value: 800 }
    });
    scene.add(rain.mesh, snow.mesh);

    let sky = normalizeSky(null);
    let seed = 1337;
    let hourOverride = null;
    let weather = null;                 // eased state actually rendered
    let target = { ...WEATHER_PRESETS.clear, rainbow: 0 };
    let climate = { temp: 0.55, moisture: 0.47 };
    let climateAt = -1e9, lastFrame = 0, flash = 0, nextStrike = 0, strikeAt = -1e9;
    const info = { hour: INDOOR_HOUR, weather: target, label: '', outdoors: true };
    const tmp = { zenith: new THREE.Color(), horizon: new THREE.Color(), grey: new THREE.Color(), a: new THREE.Color() };

    function sampleClimate(terrain, wx, wz) {
        if (!terrain || !terrain.gen) return;
        const h = Math.max(0, terrain.genHeightAt(wx, wz, 3));
        climate = {
            temp: terrain.tempAt(wx, wz, h) + (terrain.seasonOffset || 0),
            moisture: terrain.gen.moisture(wx, wz)
        };
    }

    function advanceFall(fall, velocity, size, dt) {
        fall.offset.x = (fall.offset.x + velocity.x * dt / size.x) % 1;
        fall.offset.y = (fall.offset.y + velocity.y * dt / size.y) % 1;
        fall.offset.z = (fall.offset.z + velocity.z * dt / size.z) % 1;
        const c = fall.uniforms.uCenter.value, o = fall.uniforms.uOffset.value;
        // Slots are anchored to the scene, not the box, so panning the view
        // walks through the rain instead of dragging it along.
        o.set(fall.offset.x - c.x / size.x, fall.offset.y - c.y / size.y, fall.offset.z - c.z / size.z);
        o.set(o.x - Math.floor(o.x), o.y - Math.floor(o.y), o.z - Math.floor(o.z));
        fall.uniforms.uSize.value.copy(size);
    }
    const fallSize = new THREE.Vector3(), fallVel = new THREE.Vector3();

    function update({ target: view, dist, terrain, outdoors = true }) {
        const nowMs = Date.now(), perf = performance.now() / 1000;
        const elapsed = lastFrame ? perf - lastFrame : 0.016;
        const dt = Math.min(0.1, elapsed);          // particle motion: never leap after a stall
        lastFrame = perf;
        const origin = (terrain && terrain.worldOrigin) || { x: 0, z: 0 };

        // --- what the sky is doing ---
        const hour = !outdoors ? INDOOR_HOUR : (hourOverride != null ? hourOverride : hourAt(sky, nowMs));
        const sun = sunDirection(hour), moon = moonDirection(hour);
        if (outdoors && perf - climateAt > 0.5) {
            climateAt = perf;
            sampleClimate(terrain, view.x + origin.x, view.z + origin.z);
        }
        target = outdoors
            ? resolveWeather(sky, { seed, x: view.x + origin.x, z: view.z + origin.z,
                temp: climate.temp, moisture: climate.moisture, hour, now: nowMs, sunY: sun.y })
            : { ...WEATHER_PRESETS.clear, rainbow: 0 };
        if (!weather) weather = { ...target };
        const ease = 1 - Math.exp(-elapsed / 2.5);  // weather turns over a few seconds (real time)
        for (const k of WEATHER_KEYS_NUM) weather[k] = lerp(weather[k], target[k], ease);
        const w = weather;

        // --- light ---
        const day = sstep(-0.1, 0.16, sun.y);                                  // 0 night .. 1 day
        const dusk = (1 - sstep(0.05, 0.42, sun.y)) * sstep(-0.2, 0.0, sun.y); // warm low sun
        const dim = 1 - 0.22 * w.rain;                                         // rain darkens everything
        const greyK = 0.14 + 0.86 * day;                                       // how bright "grey" is now

        tmp.zenith.copy(PAL.zenithNight).lerp(PAL.zenithDay, day).lerp(PAL.zenithDusk, dusk * 0.7);
        tmp.horizon.copy(PAL.horizonNight).lerp(PAL.horizonDay, day).lerp(PAL.horizonDusk, dusk * 0.8);
        tmp.zenith.lerp(tmp.grey.copy(PAL.greyZenith).multiplyScalar(greyK), w.cloud * 0.85);
        tmp.horizon.lerp(tmp.grey.copy(PAL.greyHorizon).multiplyScalar(greyK), w.cloud * 0.8);
        tmp.grey.copy(PAL.fog).multiplyScalar(greyK);
        tmp.zenith.lerp(tmp.grey, w.fog * 0.6).multiplyScalar(dim);
        tmp.horizon.lerp(tmp.grey, w.fog * 0.85).multiplyScalar(dim);

        const phase = moonPhaseAt(sky, nowMs);
        const moonLit = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
        const sunI = 0.9 * sstep(-0.02, 0.2, sun.y) * (1 - 0.7 * w.cloud) * dim;
        const moonI = 0.46 * sstep(0.0, 0.2, moon.y) * (1 - day) * moonLit * (1 - 0.6 * w.cloud) * dim;
        const lit = sunI >= moonI ? sun : moon;
        SUN_DIR.set(lit.x, Math.max(0.12, lit.y), lit.z).normalize();          // updateWorldFollow aims the light
        if (dirLight) {
            if (sunI >= moonI) tmp.a.copy(PAL.sunDay).lerp(PAL.sunDusk, dusk);
            else tmp.a.copy(PAL.moon);
            dirLight.color.copy(tmp.a);
            dirLight.intensity = Math.max(sunI, moonI);
        }

        // --- lightning ---
        if (w.storm > 0.3 && outdoors) {
            if (perf > nextStrike) {
                strikeAt = perf;
                nextStrike = perf + (3 + Math.random() * 11) / w.storm;
            }
        } else nextStrike = perf + 2 + Math.random() * 4;
        const since = perf - strikeAt;
        flash = since < 0.6
            ? (Math.exp(-since * 14) + 0.7 * Math.exp(-Math.abs(since - 0.16) * 22)) * w.storm
            : 0;

        if (hemiLight) {
            hemiLight.color.copy(PAL.hemiSkyNight).lerp(PAL.hemiSkyDay, day).lerp(PAL.hemiSkyDusk, dusk * 0.5);
            hemiLight.color.lerp(tmp.grey.copy(PAL.greyHorizon).multiplyScalar(0.5 + 0.5 * day), w.cloud * 0.6);
            hemiLight.groundColor.copy(PAL.hemiGroundNight).lerp(PAL.hemiGroundDay, day);
            hemiLight.intensity = lerp(0.82, 0.55, day) * (1 - 0.18 * w.cloud) * dim + flash * 0.9;
        }
        if (scene.fog) scene.fog.color.copy(tmp.horizon);
        scene.background.copy(tmp.horizon);
        // The water shader is unlit: hand it the daylight so seas darken at night.
        const waterLight = terrain && terrain.waterMaterial && terrain.waterMaterial.uniforms.uLight;
        if (waterLight) {
            waterLight.value.copy(PAL.waterNight).lerp(tmp.a.setRGB(1, 1, 1), day)
                .multiplyScalar((1 - 0.22 * w.cloud) * dim);
        }

        // --- sky dome ---
        const u = skyUniforms;
        u.uZenith.value.copy(tmp.zenith); u.uHorizon.value.copy(tmp.horizon);
        u.uSunDir.value.set(sun.x, sun.y, sun.z); u.uMoonDir.value.set(moon.x, moon.y, moon.z);
        u.uSunColor.value.copy(PAL.sunDay).lerp(PAL.sunDusk, dusk);
        u.uSunVis.value = sstep(-0.06, 0.02, sun.y) * (1 - w.fog * 0.7);
        u.uMoonVis.value = sstep(-0.04, 0.03, moon.y) * (1 - 0.8 * day) * (1 - w.fog * 0.7);
        u.uMoonPhase.value = phase;
        u.uStars.value = (1 - day) * (1 - w.fog);
        u.uCloud.value = w.cloud;
        u.uRainbow.value = outdoors ? w.rainbow * (0.25 + 0.75 * day) : 0;
        u.uFlash.value = flash;
        u.uFog.value = w.fog * 0.8;
        u.uTime.value = perf;
        const windK = 0.006 + 0.03 * w.wind;
        u.uWind.value.set(windK, windK * 0.4);
        const cloudBright = lerp(0.2, 1, day) * (1 - 0.3 * w.cloud) * dim;
        u.uCloudLit.value.setRGB(cloudBright, cloudBright * 0.99, cloudBright * 0.97)
            .lerp(PAL.horizonDusk, dusk * 0.45 * (1 - w.cloud));
        u.uCloudDark.value.copy(u.uCloudLit.value).multiplyScalar(lerp(0.78, 0.6, w.cloud));
        dome.position.copy(camera.position);
        dome.scale.setScalar(camera.far * 0.5);

        // --- weather fog: closes in around the view, never over the table ---
        const closeUp = 1 - sstep(400, 1500, dist);      // survey altitudes see no local weather
        const haze = Math.max(w.fog, w.rain * 0.35, w.snow * 0.45) * closeUp;
        if (scene.fog && haze > 0.002) {
            scene.fog.near = lerp(scene.fog.near, dist * 0.25, haze);
            scene.fog.far = lerp(scene.fog.far, dist * 1.6 + 50, haze);
        }

        // --- precipitation ---
        const rainAmt = outdoors ? w.rain * closeUp : 0, snowAmt = outdoors ? w.snow * closeUp : 0;
        rain.mesh.visible = rainAmt > 0.01;
        snow.mesh.visible = snowAmt > 0.01;
        if (rain.mesh.visible || snow.mesh.visible) {
            // The box grows with zoom in coarse steps (a resize reshuffles slots).
            const span = 30 * Math.pow(1.5, Math.round(Math.log(Math.max(1, dist * 1.6 / 30)) / Math.log(1.5)));
            const height = span * 0.7;
            const light = lerp(0.4, 1, day) * (1 - 0.2 * w.cloud);
            const cx = lerp(view.x, camera.position.x, 0.3), cy = lerp(view.y, camera.position.y, 0.3) + height * 0.1;
            const cz = lerp(view.z, camera.position.z, 0.3);
            fallSize.set(span, height, span);
            rain.uniforms.uNear.value = snow.uniforms.uNear.value = dist * 0.45;
            const gust = span * 0.5 * w.wind;
            if (rain.mesh.visible) {
                rain.uniforms.uCenter.value.set(cx, cy, cz);
                fallVel.set(gust, -height / 0.7, gust * 0.4);
                advanceFall(rain, fallVel, fallSize, dt);
                rain.uniforms.uStreak.value.copy(fallVel).normalize().multiplyScalar(-height * 0.05);
                rain.uniforms.uColor.value.setRGB(0.62 * light, 0.69 * light, 0.8 * light);
                // Seen from straight above the streaks stack up over the board: thin them out.
                const down = clamp01((camera.position.y - view.y) / Math.max(1, dist));
                rain.uniforms.uOpacity.value = (0.14 + 0.2 * rainAmt) * lerp(1, 0.4, down * down) + flash * 0.12;
                rain.mesh.geometry.setDrawRange(0, Math.ceil(RAIN_DROPS * clamp01(rainAmt * 1.15)) * 2);
            }
            if (snow.mesh.visible) {
                snow.uniforms.uCenter.value.set(cx, cy, cz);
                fallVel.set(gust * 0.25, -height / 7, gust * 0.1);
                advanceFall(snow, fallVel, fallSize, dt);
                snow.uniforms.uSway.value = span * 0.008;
                snow.uniforms.uFlake.value = span * 0.007;
                snow.uniforms.uViewH.value = renderer.domElement.height;
                snow.uniforms.uColor.value.setRGB(light, light, light);
                snow.uniforms.uOpacity.value = 0.9;
                snow.mesh.geometry.setDrawRange(0, Math.ceil(SNOW_FLAKES * clamp01(snowAmt * 1.15)));
            }
        }

        info.hour = hour;
        info.weather = w;
        info.outdoors = outdoors;
        info.label = outdoors
            ? `${formatHour(hour)} · ${describeHour(hour)} · ${describeWeather(target)}`
            : '';
    }

    return {
        update, info,
        setSky(raw) { sky = normalizeSky(raw); hourOverride = null; },
        setSeed(value) { if (Number.isFinite(Number(value))) seed = Number(value); },
        // GM scrubbing the time slider: shown locally until the saved sky lands.
        previewHour(hour) { hourOverride = hour == null ? null : Number(hour); },
        get sky() { return sky; }
    };
}
