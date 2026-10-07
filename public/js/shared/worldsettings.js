// worldsettings.js — the world-shape controls shared by the lobby wizard and
// the GM campaign panel: preset chips on top (how a GM thinks about a world),
// the individual generator knobs folded under "Fine-tune". Values are the
// settings.world numbers from worldgen.js (minus `home`, which the pages own).

import { WORLD_DEFAULTS, WORLD_LIMITS, WORLD_PRESETS, presetKeyOf } from './worldgen.js';

const signed = (v) => (v > 0 ? `+${v}` : String(v));
const KNOBS = [
    { key: 'ocean', label: 'Ocean coverage', step: 5, fmt: v => `${v}%` },
    { key: 'landSize', label: 'Landmass size', step: 10, fmt: v => `${v}%` },
    { key: 'rugged', label: 'Ruggedness', step: 10,
      fmt: v => (v === 0 ? 'rolling' : v > 0 ? `alpine ${signed(v)}` : `gentle ${signed(v)}`) },
    { key: 'wetness', label: 'Rainfall', step: 10,
      fmt: v => (v === 0 ? 'balanced' : v > 0 ? `lush ${signed(v)}` : `arid ${signed(v)}`) },
    { key: 'temperature', label: 'Temperature', step: 10,
      fmt: v => (v === 0 ? 'temperate' : v > 0 ? `hot ${signed(v)}` : `cold ${signed(v)}`) },
    { key: 'latitude', label: 'Climate bands', step: 10,
      fmt: v => (v === 0 ? 'uniform' : `cold north, warm south ${v}%`) },
    { key: 'zones', label: 'Region size', step: 10,
      fmt: v => (v === 0 ? 'fine patchwork' : v < 50 ? `mixed ${v}%` : `broad regions ${v}%`) }
];

export function createWorldSettings(container, { onChange } = {}) {
    container.classList.add('ws');
    container.innerHTML = `
        <div class="ws-presets">${WORLD_PRESETS.map(p =>
            `<button type="button" class="ws-preset" data-preset="${p.key}">${p.label}</button>`).join('')}</div>
        <div class="ws-hint"></div>
        <details class="ws-advanced">
            <summary>Fine-tune</summary>
            ${KNOBS.map(k => `
            <label class="ws-row">
                <span class="ws-row-head"><span>${k.label}</span><span class="ws-val" data-val="${k.key}"></span></span>
                <input type="range" data-knob="${k.key}" min="${WORLD_LIMITS[k.key][0]}" max="${WORLD_LIMITS[k.key][1]}" step="${k.step}">
            </label>`).join('')}
        </details>`;
    const input = (key) => container.querySelector(`[data-knob="${key}"]`);
    const hint = container.querySelector('.ws-hint');

    function get() {
        const world = {};
        for (const k of KNOBS) world[k.key] = Number(input(k.key).value);
        return world;
    }
    function sync() {
        for (const k of KNOBS) {
            container.querySelector(`[data-val="${k.key}"]`).textContent = k.fmt(Number(input(k.key).value));
        }
        const active = presetKeyOf(get());
        container.querySelectorAll('.ws-preset').forEach(b =>
            b.classList.toggle('active', b.dataset.preset === active));
        const preset = WORLD_PRESETS.find(p => p.key === active);
        hint.textContent = preset ? preset.hint : 'Custom world.';
    }
    function set(world) {
        const w = world || {};
        for (const k of KNOBS) input(k.key).value = String(w[k.key] != null ? w[k.key] : WORLD_DEFAULTS[k.key]);
        sync();
    }

    container.addEventListener('input', (event) => {
        if (!event.target.matches('[data-knob]')) return;
        sync();
        if (onChange) onChange();
    });
    container.addEventListener('click', (event) => {
        const button = event.target.closest('.ws-preset');
        if (!button) return;
        const preset = WORLD_PRESETS.find(p => p.key === button.dataset.preset);
        if (!preset) return;
        set(preset.world);
        if (onChange) onChange();
    });

    set(WORLD_DEFAULTS);
    return { get, set };
}
