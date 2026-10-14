// visionfx.js — draws what one token can see, on both tabletop screens.
//
// vision.js decides (pure, shared with the server); this module shows it:
//  * the scene renders into a target with a depth texture, and one screen pass
//    rebuilds every pixel's world position and asks "can the viewer see this
//    spot, and is it lit?". That covers terrain, structures, props and tokens
//    without touching a single material.
//  * sight is a polar table: for 2048 directions around the viewer's eye, the
//    distance to the nearest wall standing across eye height and that wall's
//    top (so roofs and towers beyond a wall still show over it). Each light
//    gets a row of its own, so a torch does not shine through walls either.
//  * creatures the viewer cannot perceive are hidden; ones known only by
//    tremorsense show as a ping.
//  * what a character has seen stays as a dimmed memory (per character, kept
//    in this browser).
//
// Pages call update() once per frame and render() instead of
// renderer.render(). With vision off or no viewer it is a plain render.

import * as THREE from 'three';
import {
    FEET_PER_UNIT, SENSE_KEYS, SENSE_LABELS, POLAR_FAR, LIGHT_DARK,
    normalizeVision, buildOccluders, visionContext, viewerOf, targetOf, isCreature,
    canSee, polarRow, polarDistance, normalizeLight
} from './vision.js';

const BINS = 2048;
const MAX_LIGHTS = 16;
const ROWS = 1 + MAX_LIGHTS;
const WINDOW = 256;             // cells of cover + memory around the viewer
const WINDOW_SNAP = 32;
const MEMORY_REACH = 48;        // cells a single look can commit to memory
const MEMORY_CHUNK = 64;
const FADE_NEAR = 700, FADE_FAR = 1800;   // camera distance where the effect lets go (survey zoom)

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tPolar;
uniform sampler2D tCover;
uniform sampler2D tMemory;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uViewer;
uniform vec4 uSense;        // darkvision, blindsight, truesight, devil's sight (world units)
uniform float uSightCap;
uniform float uBlind;
uniform vec2 uAmbient;      // outdoors, under a roof (0 dark, 0.5 dim, 1 bright)
uniform vec4 uLightPos[${MAX_LIGHTS}];   // xyz, bright radius
uniform vec4 uLightAux[${MAX_LIGHTS}];   // reach, magical-darkness radius, polar row
uniform int uLightCount;
uniform vec3 uWindow;       // x0, z0 (scene space), size
uniform float uMemory;
uniform float uStrength;
varying vec2 vUv;

const float PI = 3.141592653589793;
const float BIN = 1.0 / ${BINS}.0;

float angleU(vec2 d) { return (atan(d.y, d.x) + PI) / (2.0 * PI); }

// 1 where the viewer has a line to this point.
float lineOfSight(vec3 p) {
    vec2 d = p.xz - uViewer.xz;
    float r = length(d);
    float u = angleU(d);
    float acc = 0.0;
    for (int k = -1; k <= 1; k++) {
        vec4 s = texture2D(tPolar, vec2(u + float(k) * BIN, 0.5 / ${ROWS}.0));
        float clear = step(r, s.r + 0.22);
        // Past the wall, but the line from the eye passes over its top.
        float yAtWall = uViewer.y + (p.y - uViewer.y) * s.r / max(r, 0.001);
        acc += max(clear, step(s.g + 0.05, yAtWall));
    }
    return acc / 3.0;
}

float lightAt(vec3 p, out float magical) {
    vec2 w = (p.xz - uWindow.xy) / uWindow.z;
    float level = uAmbient.x;
    if (w.x > 0.0 && w.x < 1.0 && w.y > 0.0 && w.y < 1.0) {
        float cover = texture2D(tCover, w).r;
        if (p.y < cover - 0.05) level = uAmbient.y;
    }
    magical = 0.0;
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec3 lp = uLightPos[i].xyz;
        float r3 = distance(p, lp);
        if (uLightAux[i].y > 0.0) {
            if (r3 < uLightAux[i].y) magical = 1.0;
            continue;
        }
        float reach = uLightAux[i].x;
        if (r3 > reach) continue;
        vec2 d = p.xz - lp.xz;
        float r = length(d);
        float wall = texture2D(tPolar, vec2(angleU(d), uLightAux[i].z)).r;
        if (r > 0.3 && r > wall + 0.02) continue;
        float bright = uLightPos[i].w;
        float lit = mix(1.0, 0.5, smoothstep(bright * 0.9, bright * 1.05 + 0.01, r3));
        lit *= 1.0 - smoothstep(reach * 0.9, reach, r3);
        level = max(level, lit);
    }
    return level;
}

void main() {
    vec3 col = texture2D(tColor, vUv).rgb;
    float depth = texture2D(tDepth, vUv).r;
    if (depth >= 1.0 || uStrength <= 0.0) { gl_FragColor = vec4(col, 1.0); return; }
    vec4 view = uInvProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    view /= view.w;
    vec3 p = (uCamWorld * view).xyz;

    float los = lineOfSight(p);
    float r = distance(p, uViewer);
    float magical;
    float light = lightAt(p, magical);
    if (magical > 0.5) light = 0.0;

    // What the viewer's senses make of that light.
    float eff = light * (1.0 - uBlind) * step(r, uSightCap);
    float grey = 0.0;
    float dv = (1.0 - smoothstep(uSense.x * 0.93, uSense.x, r)) * step(0.001, uSense.x)
        * (1.0 - magical) * (1.0 - uBlind);
    if (dv > 0.0) {
        float lifted = eff < 0.25 ? 0.5 : 1.0;      // dark reads as dim, dim as bright
        grey = eff < 0.25 ? dv : 0.0;
        eff = mix(eff, lifted, dv);
    }
    if (uSense.w > 0.0 && r <= uSense.w && uBlind < 0.5) { eff = 1.0; grey = 0.0; }
    if (uSense.y > 0.0 && r <= uSense.y) { if (eff < 0.75) { eff = 0.75; grey = 1.0; } }
    if (uSense.z > 0.0 && r <= uSense.z) { eff = 1.0; grey = 0.0; }

    float seen = los * smoothstep(0.05, 0.3, eff);
    // You can always make out the spot you stand on.
    seen = max(seen, 1.0 - smoothstep(0.7, 1.1, length(p.xz - uViewer.xz)));
    eff = max(eff, 0.5 * (1.0 - smoothstep(0.7, 1.1, length(p.xz - uViewer.xz))));

    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 lit = mix(vec3(lum), col, mix(0.72, 1.0, smoothstep(0.5, 1.0, eff)));
    lit *= mix(0.7, 1.0, smoothstep(0.5, 1.0, eff));
    lit = mix(lit, vec3(lum) * 0.82, grey);

    // Out of sight: a dim memory of what was seen, or the dark.
    vec2 w = (p.xz - uWindow.xy) / uWindow.z;
    float known = 1.0;
    if (w.x > 0.0 && w.x < 1.0 && w.y > 0.0 && w.y < 1.0) known = texture2D(tMemory, w).r * uMemory;
    vec3 memory = mix(vec3(lum), col, 0.25) * vec3(0.34, 0.37, 0.43);
    vec3 unknown = vec3(lum) * vec3(0.075, 0.082, 0.1);
    vec3 unseen = mix(unknown, memory, smoothstep(0.35, 0.65, known));

    gl_FragColor = vec4(mix(col, mix(unseen, lit, seen), uStrength), 1.0);
}`;

function makePingTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    for (const [radius, alpha, width] of [[54, 0.9, 5], [36, 0.55, 4], [16, 0.9, 6]]) {
        g.strokeStyle = `rgba(255, 196, 92, ${alpha})`;
        g.lineWidth = width;
        g.beginPath();
        g.arc(64, 64, radius, 0, Math.PI * 2);
        g.stroke();
    }
    return new THREE.CanvasTexture(c);
}

// The per-character explored set: sparse 64x64 cell chunks, bit-packed into
// localStorage under one key per (campaign, character, map).
class ExploredMemory {
    constructor() { this.key = null; this.chunks = new Map(); this.timer = 0; this.rev = 0; }
    open(key) {
        if (key === this.key) return;
        this.flush();
        this.key = key;
        this.chunks = new Map();
        this.rev++;
        if (!key) return;
        try {
            const stored = JSON.parse(localStorage.getItem(key) || '{}');
            for (const [k, b64] of Object.entries(stored)) {
                const bits = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
                const cells = new Uint8Array(MEMORY_CHUNK * MEMORY_CHUNK);
                for (let i = 0; i < cells.length; i++) cells[i] = (bits[i >> 3] >> (i & 7)) & 1;
                this.chunks.set(k, cells);
            }
        } catch (_) { /* unreadable or blocked storage: start with a blank memory */ }
    }
    has(cx, cz) {
        const chunk = this.chunks.get(Math.floor(cx / MEMORY_CHUNK) + ',' + Math.floor(cz / MEMORY_CHUNK));
        return !!chunk && chunk[(((cz % MEMORY_CHUNK) + MEMORY_CHUNK) % MEMORY_CHUNK) * MEMORY_CHUNK +
            (((cx % MEMORY_CHUNK) + MEMORY_CHUNK) % MEMORY_CHUNK)] === 1;
    }
    mark(cx, cz) {
        const k = Math.floor(cx / MEMORY_CHUNK) + ',' + Math.floor(cz / MEMORY_CHUNK);
        let chunk = this.chunks.get(k);
        if (!chunk) this.chunks.set(k, chunk = new Uint8Array(MEMORY_CHUNK * MEMORY_CHUNK));
        const i = (((cz % MEMORY_CHUNK) + MEMORY_CHUNK) % MEMORY_CHUNK) * MEMORY_CHUNK +
            (((cx % MEMORY_CHUNK) + MEMORY_CHUNK) % MEMORY_CHUNK);
        if (chunk[i]) return false;
        chunk[i] = 1;
        return true;
    }
    touch() {
        this.rev++;
        if (!this.key || this.timer) return;
        this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, 2500);
    }
    flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
        if (!this.key) return;
        const out = {};
        for (const [k, cells] of this.chunks) {
            const bits = new Uint8Array(cells.length >> 3);
            for (let i = 0; i < cells.length; i++) if (cells[i]) bits[i >> 3] |= 1 << (i & 7);
            let text = '';
            for (const b of bits) text += String.fromCharCode(b);
            out[k] = btoa(text);
        }
        try { localStorage.setItem(this.key, JSON.stringify(out)); } catch (_) { /* quota: memory stays for this visit */ }
    }
}

// source: {
//   objects()   -> the page's synced three.js objects
//   origin()    -> { x, z } floating world origin
//   settings()  -> campaign settings.vision (raw is fine)
//   viewer()    -> the object whose eyes to use, or null (no vision effect)
//   sky()       -> { hour, weather, pocket }
//   keepVisible(object) -> true for tokens never hidden here (the player's own)
//   memoryKey(viewer)   -> storage key for explored memory, or null for none
//   cameraDistance()
// }
export function createVisionFx({ renderer, scene, camera, source }) {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat
    });
    target.depthTexture = new THREE.DepthTexture(size.x, size.y);
    target.depthTexture.type = THREE.UnsignedIntType;

    const polarData = new Float32Array(BINS * ROWS * 4);
    const polarTex = new THREE.DataTexture(polarData, BINS, ROWS, THREE.RGBAFormat, THREE.FloatType);
    polarTex.minFilter = polarTex.magFilter = THREE.NearestFilter;
    polarTex.wrapS = THREE.RepeatWrapping;
    const coverData = new Float32Array(WINDOW * WINDOW * 4);
    const coverTex = new THREE.DataTexture(coverData, WINDOW, WINDOW, THREE.RGBAFormat, THREE.FloatType);
    coverTex.minFilter = coverTex.magFilter = THREE.NearestFilter;
    const memoryData = new Uint8Array(WINDOW * WINDOW * 4);
    const memoryTex = new THREE.DataTexture(memoryData, WINDOW, WINDOW, THREE.RGBAFormat, THREE.UnsignedByteType);
    memoryTex.minFilter = memoryTex.magFilter = THREE.LinearFilter;

    const uniforms = {
        tColor: { value: target.texture }, tDepth: { value: target.depthTexture },
        tPolar: { value: polarTex }, tCover: { value: coverTex }, tMemory: { value: memoryTex },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uViewer: { value: new THREE.Vector3() },
        uSense: { value: new THREE.Vector4() }, uSightCap: { value: POLAR_FAR }, uBlind: { value: 0 },
        uAmbient: { value: new THREE.Vector2(1, 1) },
        uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
        uLightAux: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
        uLightCount: { value: 0 },
        uWindow: { value: new THREE.Vector3(0, 0, WINDOW) },
        uMemory: { value: 1 }, uStrength: { value: 0 }
    };
    const quadScene = new THREE.Scene();
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false
    }));
    quad.frustumCulled = false;
    quadScene.add(quad);

    // Tremorsense pings draw after the screen pass, so the dark never hides them.
    const overlayScene = new THREE.Scene();
    const pingMaterial = new THREE.SpriteMaterial({
        map: makePingTexture(), transparent: true, depthTest: false, depthWrite: false
    });
    const pings = [];

    const memory = new ExploredMemory();
    window.addEventListener('pagehide', () => memory.flush());

    const stamps = new WeakMap();
    let stampCounter = 0;
    const stampOf = (data) => {
        if (!data) return 0;
        let id = stamps.get(data);
        if (!id) stamps.set(data, id = ++stampCounter);
        return id;
    };

    const state = {
        active: false, signature: '', checkedAt: 0,
        viewer: null, lights: [], windowX: 0, windowZ: 0, memoryRev: -1, memoryWindow: '',
        hidden: new Set(), info: null
    };
    const levelValue = (level) => level / 2;

    function recordOf(object) {
        const data = object.userData.objectData || {};
        return {
            ...data,
            id: object.userData.syncId,
            type: object.userData.characterData ? 'character' : (object.userData.objectType || data.type),
            position: { x: object.position.x, y: object.position.y, z: object.position.z }
        };
    }

    function restoreHidden() {
        for (const object of state.hidden) object.visible = true;
        state.hidden.clear();
        for (const ping of pings) ping.visible = false;
    }

    function signatureOf(objects, viewerObject, settings, sky) {
        let h = objects.length | 0;
        for (const object of objects) {
            const p = object.position;
            h = (Math.imul(h, 31) + ((p.x * 64) | 0)) | 0;
            h = (Math.imul(h, 31) + ((p.y * 64) | 0)) | 0;
            h = (Math.imul(h, 31) + ((p.z * 64) | 0)) | 0;
            h = (Math.imul(h, 31) + stampOf(object.userData.objectData)) | 0;
        }
        const weather = sky.weather || {};
        return [h, viewerObject.userData.syncId, JSON.stringify(settings), Math.round((sky.hour || 0) * 4),
            sky.pocket ? 1 : 0, Math.round((weather.fog || 0) * 10), Math.round((weather.rain || 0) * 10),
            Math.round((weather.snow || 0) * 10), Math.round((weather.storm || 0) * 10), memory.key].join('|');
    }

    function fillWindow(occ, viewer) {
        const x0 = Math.round(viewer.x / WINDOW_SNAP) * WINDOW_SNAP - WINDOW / 2;
        const z0 = Math.round(viewer.z / WINDOW_SNAP) * WINDOW_SNAP - WINDOW / 2;
        state.windowX = x0; state.windowZ = z0;
        for (let i = 0; i < WINDOW * WINDOW; i++) coverData[i * 4] = POLAR_FAR;
        for (const slab of occ.slabs) {
            for (let tz = 0; tz < slab.rows; tz++) {
                const cz = Math.floor(slab.z0 + tz + 0.5 - z0);
                if (cz < 0 || cz >= WINDOW) continue;
                for (let tx = 0; tx < slab.cols; tx++) {
                    const cx = Math.floor(slab.x0 + tx + 0.5 - x0);
                    if (cx < 0 || cx >= WINDOW) continue;
                    if (slab.open && slab.open.has(tz * slab.cols + tx)) continue;
                    // The lowest ceiling above the viewer's feet is the one that matters.
                    if (slab.y < viewer.ground + 0.3) continue;
                    const i = (cz * WINDOW + cx) * 4;
                    if (slab.y < coverData[i]) coverData[i] = slab.y;
                }
            }
        }
        coverTex.needsUpdate = true;
    }

    function remember(occ, ctx, viewer, capUnits) {
        const senses = viewer.senses || {};
        const senseReach = Math.max(senses.darkvision || 0, senses.blindsight || 0,
            senses.truesight || 0, senses.devilsSight || 0) / FEET_PER_UNIT;
        const reach = Math.min(MEMORY_REACH, capUnits);
        const vx = Math.floor(viewer.x), vz = Math.floor(viewer.z);
        let changed = false;
        for (let cz = vz - reach; cz <= vz + reach; cz++) {
            for (let cx = vx - reach; cx <= vx + reach; cx++) {
                const dx = cx + 0.5 - viewer.x, dz = cz + 0.5 - viewer.z;
                const r = Math.hypot(dx, dz);
                if (r > reach) continue;
                if (r > 1 && r > polarDistance(polarData, BINS, 0, dx, dz, 4) + 0.3) continue;
                let lit = r <= Math.max(1, senseReach);
                if (!lit) {
                    const wx = cx - state.windowX, wz = cz - state.windowZ;
                    const cover = wx >= 0 && wz >= 0 && wx < WINDOW && wz < WINDOW
                        ? coverData[(wz * WINDOW + wx) * 4] : POLAR_FAR;
                    lit = (cover < POLAR_FAR ? ctx.indoor : ctx.outdoor) > LIGHT_DARK;
                }
                if (!lit) {
                    for (let i = 0; i < state.lights.length && !lit; i++) {
                        const l = state.lights[i];
                        if (l.dark > 0) continue;
                        const lx = cx + 0.5 - l.x, lz = cz + 0.5 - l.z;
                        const lr = Math.hypot(lx, lz);
                        lit = lr <= l.bright + l.dim &&
                            lr <= polarDistance(polarData, BINS, (i + 1) * BINS * 4, lx, lz, 4) + 0.3;
                    }
                }
                if (lit && memory.mark(cx, cz)) changed = true;
            }
        }
        if (changed) memory.touch();
    }

    function uploadMemory() {
        const windowKey = state.windowX + ',' + state.windowZ;
        if (state.memoryRev === memory.rev && state.memoryWindow === windowKey) return;
        state.memoryRev = memory.rev;
        state.memoryWindow = windowKey;
        for (let cz = 0; cz < WINDOW; cz++) {
            for (let cx = 0; cx < WINDOW; cx++) {
                memoryData[(cz * WINDOW + cx) * 4] = memory.has(state.windowX + cx, state.windowZ + cz) ? 255 : 0;
            }
        }
        memoryTex.needsUpdate = true;
    }

    function recompute(objects, viewerObject, settings, sky) {
        const records = objects.map(recordOf);
        const byId = new Map(records.map((record, i) => [record.id, objects[i]]));
        const occ = buildOccluders(records);
        const ctx = visionContext(settings, sky);
        const viewerRecord = records[objects.indexOf(viewerObject)];
        const viewer = viewerOf(viewerRecord);
        state.viewer = viewer;
        const capUnits = ctx.sightFeet / FEET_PER_UNIT;

        // Sight row, then one row per light (nearest lights first).
        polarRow(occ, viewer.x, viewer.y, viewer.z, BINS, polarData, 0);
        const lights = occ.lights
            .map(l => ({ ...l, d: Math.hypot(l.x - viewer.x, l.z - viewer.z) }))
            .sort((a, b) => a.d - b.d).slice(0, MAX_LIGHTS);
        lights.forEach((l, i) => polarRow(occ, l.x, l.y, l.z, BINS, polarData, (i + 1) * BINS * 4, l.bright + l.dim));
        // polarRow writes (distance, top) pairs; the texture is RGBA.
        for (let row = lights.length; row >= 0; row--) {
            const base = row * BINS * 4;
            for (let i = BINS - 1; i >= 0; i--) {
                polarData[base + i * 4 + 1] = polarData[base + i * 2 + 1];
                polarData[base + i * 4] = polarData[base + i * 2];
            }
        }
        polarTex.needsUpdate = true;
        state.lights = lights;

        fillWindow(occ, viewer);
        memory.open(settings.memory ? source.memoryKey(viewerObject) : null);
        if (settings.memory) remember(occ, ctx, viewer, capUnits);

        // Creatures: hide what this viewer cannot perceive, ping what it only feels.
        const stillHidden = new Set();
        let pingCount = 0;
        for (const record of records) {
            if (!isCreature(record) || record.id === viewer.id) continue;
            const object = byId.get(record.id);
            const how = source.keepVisible(object) ? 'sight' : canSee(occ, ctx, viewer, targetOf(record));
            if (how && how !== 'tremor') continue;
            stillHidden.add(object);
            if (how === 'tremor') {
                let ping = pings[pingCount];
                if (!ping) { pings.push(ping = new THREE.Sprite(pingMaterial)); overlayScene.add(ping); }
                ping.userData.world = { x: record.position.x, y: record.position.y + 0.2, z: record.position.z };
                ping.visible = true;
                pingCount++;
            }
        }
        for (let i = pingCount; i < pings.length; i++) pings[i].visible = false;
        for (const object of state.hidden) if (!stillHidden.has(object)) object.visible = true;
        for (const object of stillHidden) object.visible = false;
        state.hidden = stillHidden;

        const senses = viewer.senses || {};
        uniforms.uSense.value.set(
            (senses.darkvision || 0) / FEET_PER_UNIT, (senses.blindsight || 0) / FEET_PER_UNIT,
            (senses.truesight || 0) / FEET_PER_UNIT, (senses.devilsSight || 0) / FEET_PER_UNIT);
        uniforms.uBlind.value = senses.blind ? 1 : 0;
        uniforms.uSightCap.value = capUnits;
        uniforms.uAmbient.value.set(levelValue(ctx.outdoor), levelValue(ctx.indoor));
        uniforms.uMemory.value = settings.memory ? 1 : 0;
        uniforms.uLightCount.value = lights.length;
        state.info = {
            senses, light: normalizeLight(viewerRecord.light), sightFeet: ctx.sightFeet,
            outdoor: ctx.outdoor, indoor: ctx.indoor
        };
    }

    function update() {
        const settings = normalizeVision(source.settings());
        const viewerObject = settings.enabled ? source.viewer() : null;
        const distance = source.cameraDistance();
        const strength = 1 - Math.max(0, Math.min(1, (distance - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
        const objects = viewerObject ? source.objects() : null;
        if (!viewerObject || strength <= 0 || !objects.includes(viewerObject)) {
            if (state.active) { state.active = false; state.signature = ''; restoreHidden(); memory.flush(); }
            uniforms.uStrength.value = 0;
            return;
        }
        state.active = true;
        const now = performance.now();
        if (now - state.checkedAt > 120) {
            state.checkedAt = now;
            const sky = source.sky();
            const signature = signatureOf(objects, viewerObject, settings, sky);
            if (signature !== state.signature) {
                state.signature = signature;
                recompute(objects, viewerObject, settings, sky);
            }
        }
        uploadMemory();

        // Everything the shader compares against is in scene space.
        const origin = source.origin();
        const viewer = state.viewer;
        uniforms.uViewer.value.set(viewer.x - origin.x, viewer.y, viewer.z - origin.z);
        uniforms.uWindow.value.set(state.windowX - origin.x, state.windowZ - origin.z, WINDOW);
        state.lights.forEach((l, i) => {
            uniforms.uLightPos.value[i].set(l.x - origin.x, l.y, l.z - origin.z, l.bright);
            uniforms.uLightAux.value[i].set(l.bright + l.dim, l.dark, (i + 1.5) / ROWS, 0);
        });
        uniforms.uStrength.value = strength;
        const pulse = 1.1 + 0.25 * Math.sin(now / 260);
        for (const ping of pings) {
            if (!ping.visible) continue;
            const w = ping.userData.world;
            ping.position.set(w.x - origin.x, w.y, w.z - origin.z);
            ping.scale.setScalar(pulse);
        }
    }

    function render() {
        if (!state.active || uniforms.uStrength.value <= 0) {
            renderer.render(scene, camera);
            return;
        }
        renderer.getDrawingBufferSize(size);
        if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
        uniforms.uCamWorld.value.copy(camera.matrixWorld);
        renderer.render(quadScene, quadCamera);
        if (pings.some(ping => ping.visible)) {
            const autoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(overlayScene, camera);
            renderer.autoClear = autoClear;
        }
    }

    return {
        update, render,
        get active() { return state.active; },
        // { senses, light, sightFeet, outdoor, indoor } of the current viewer, or null.
        get info() { return state.active ? state.info : null; },
        refresh() { state.signature = ''; state.checkedAt = 0; },
        forget() { memory.chunks = new Map(); memory.touch(); memory.flush(); state.signature = ''; }
    };
}

// "Darkvision 60 ft · Blindsight 10 ft" for chips and inspectors.
export function describeSenses(senses) {
    const parts = SENSE_KEYS.filter(key => senses && senses[key]).map(key => `${SENSE_LABELS[key]} ${senses[key]} ft`);
    if (senses && senses.blind) parts.push('Blind beyond that');
    return parts.join(' · ') || 'Normal vision';
}
