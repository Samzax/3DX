// skypanel.js — the DOM side of the sky: the GM's "Sky & weather" controls
// (campaign panel) and the small time/weather readout both screens show.
// Rendering lives in atmosphere.js, the rules in weather.js.

import { WEATHER_KEYS, WEATHER_LABELS, SKY_LIMITS, normalizeSky, hourAt, formatHour } from './weather.js';

const HOUR_CHIPS = [['Dawn', 6], ['Morning', 10], ['Noon', 12], ['Dusk', 18.5], ['Midnight', 0]];
const RAINBOW_LABELS = { auto: 'Natural', on: 'Always', off: 'Never' };

// createSkyPanel(container, { onChange(patch), onPreview(hour|null), getNow() })
//   onChange gets a settings.sky patch to send to the server; onPreview shows a
//   scrubbed hour locally while the slider is held. set(sky) reloads the
//   controls from the saved settings; setReadout(text) shows current conditions.
export function createSkyPanel(container, { onChange, onPreview } = {}) {
    container.classList.add('sky');
    container.innerHTML = `
        <div class="sky-now"></div>
        <label class="sky-row">
            <span class="sky-row-head"><span>Time of day</span><span class="sky-val" data-val="hour"></span></span>
            <input type="range" data-sky="hour" min="0" max="24" step="0.25">
        </label>
        <div class="sky-chips" data-group="hour">${HOUR_CHIPS.map(([label, hour]) =>
            `<button type="button" class="tp-chip" data-hour="${hour}">${label}</button>`).join('')}</div>
        <label class="tp-check tp-check-wide"><input type="checkbox" data-sky="cycle"> Time passes: one day every
            <input type="number" data-sky="dayMinutes" min="${SKY_LIMITS.dayMinutes[0]}" max="${SKY_LIMITS.dayMinutes[1]}" step="1"> min</label>
        <div class="tp-label">Weather</div>
        <div class="sky-chips" data-group="weather">${WEATHER_KEYS.map(key =>
            `<button type="button" class="tp-chip" data-weather="${key}">${WEATHER_LABELS[key]}</button>`).join('')}</div>
        <div class="tp-label">Rainbow</div>
        <div class="sky-chips" data-group="rainbow">${Object.keys(RAINBOW_LABELS).map(key =>
            `<button type="button" class="tp-chip" data-rainbow="${key}">${RAINBOW_LABELS[key]}</button>`).join('')}</div>`;
    const q = (sel) => container.querySelector(sel);
    const slider = q('[data-sky="hour"]'), cycle = q('[data-sky="cycle"]'), minutes = q('[data-sky="dayMinutes"]');
    let sky = normalizeSky(null);
    let scrubbing = false;

    const showHour = (hour) => { q('[data-val="hour"]').textContent = formatHour(hour); };
    function set(raw) {
        sky = normalizeSky(raw);
        if (!scrubbing) {
            const hour = hourAt(sky);
            slider.value = String(hour);
            showHour(hour);
        }
        cycle.checked = sky.clock === 'cycle';
        if (document.activeElement !== minutes) minutes.value = String(sky.dayMinutes);
        container.querySelectorAll('[data-weather]').forEach(b => b.classList.toggle('active', b.dataset.weather === sky.weather));
        container.querySelectorAll('[data-rainbow]').forEach(b => b.classList.toggle('active', b.dataset.rainbow === sky.rainbow));
    }
    // Every clock change carries the hour: the server restamps "now" with it,
    // so toggling the cycle or its speed never makes the time jump.
    const clockPatch = (hour) => ({
        hour, clock: cycle.checked ? 'cycle' : 'fixed',
        dayMinutes: Number(minutes.value) || sky.dayMinutes
    });
    const emit = (patch) => { if (onChange) onChange(patch); };

    slider.addEventListener('input', () => {
        scrubbing = true;
        showHour(Number(slider.value));
        if (onPreview) onPreview(Number(slider.value) % 24);
    });
    slider.addEventListener('change', () => {
        scrubbing = false;
        emit(clockPatch(Number(slider.value) % 24));
    });
    cycle.addEventListener('change', () => emit(clockPatch(hourAt(sky))));
    minutes.addEventListener('change', () => emit(clockPatch(hourAt(sky))));
    container.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.hour != null) emit(clockPatch(Number(button.dataset.hour)));
        else if (button.dataset.weather) emit({ weather: button.dataset.weather });
        else if (button.dataset.rainbow) emit({ rainbow: button.dataset.rainbow });
    });

    set(null);
    return {
        set,
        // Called about once a second: the readout, and the slider while time runs.
        tick(label) {
            q('.sky-now').textContent = label || '';
            if (sky.clock === 'cycle' && !scrubbing && document.activeElement !== slider) {
                const hour = hourAt(sky);
                slider.value = String(hour);
                showHour(hour);
            }
        }
    };
}

// The readout chip ("14:30 · Afternoon · Rain") both screens show: it sits in
// the workspace top bar beside the map breadcrumb (bottom-left without one).
// Returns a setter; an empty label (pocket maps: no sky) hides it.
export function createSkyChip() {
    const chip = document.createElement('span');
    chip.id = 'sky-chip';
    chip.title = 'Time and weather where you are looking';
    document.body.appendChild(chip);
    let shown = null, docked = false;
    return (label) => {
        if (!docked) {   // the workspace builds its top bar after the scene
            const host = document.querySelector('#workspace-topbar .workspace-context');
            if (host) { host.appendChild(chip); docked = true; }
        }
        if (label === shown) return;
        shown = label;
        chip.textContent = label || '';
        chip.classList.toggle('hidden', !label);
    };
}
