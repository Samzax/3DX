// visionpanel.js — the DOM side of token vision, shared by /gm and /player:
// the "seeing as" chip, the campaign-panel rules, and the vision section of
// the selection inspector. The model is vision.js, the rendering visionfx.js.

import {
    SENSE_KEYS, SENSE_LABELS, SENSE_LIMIT, LIGHT_PRESETS, VISION_DEFAULTS,
    lightPresetKey, normalizeLight, normalizeVision, sensesOf, parseMonsterSenses
} from './vision.js';
import { describeSenses } from './visionfx.js';
import { escHtml } from './campaigns.js';

function lightOptions(current) {
    const custom = current === 'custom' ? '<option value="custom" selected>Custom light</option>' : '';
    return custom + Object.entries(LIGHT_PRESETS).map(([key, preset]) =>
        `<option value="${key}"${key === current ? ' selected' : ''}>${escHtml(preset.label)}</option>`).join('');
}
const presetLight = (key) => {
    const preset = LIGHT_PRESETS[key];
    return preset ? { bright: preset.bright, dim: preset.dim, dark: preset.dark } : null;
};

// The chip under the top bar: whose eyes the screen is using, what they see
// with, and the light that character carries. onLight(light) fires when the
// carried light changes; onStop() when a GM leaves "view as".
export function createVisionChip({ onLight, onStop } = {}) {
    const chip = document.createElement('div');
    chip.id = 'vision-chip';
    chip.className = 'hidden';
    chip.innerHTML = `<span class="vision-chip-name"></span>
        <span class="vision-chip-detail"></span>
        <select class="vision-chip-light" title="Light this character carries"></select>
        <button type="button" class="vision-chip-stop">Stop viewing</button>`;
    document.body.appendChild(chip);
    const name = chip.querySelector('.vision-chip-name');
    const detail = chip.querySelector('.vision-chip-detail');
    const light = chip.querySelector('.vision-chip-light');
    const stop = chip.querySelector('.vision-chip-stop');
    light.addEventListener('change', () => { if (onLight) onLight(presetLight(light.value)); });
    stop.addEventListener('click', () => { if (onStop) onStop(); });
    let shown = '';
    return {
        // state: null hides the chip. { name, senses, light, sightFeet, canLight, canStop, note }
        set(state) {
            const key = JSON.stringify(state || null);
            if (key === shown) return;
            shown = key;
            chip.classList.toggle('hidden', !state);
            if (!state) return;
            name.textContent = state.name || '';
            const bits = [];
            if (state.note) bits.push(state.note);
            else {
                bits.push(describeSenses(state.senses));
                if (state.sightFeet && state.sightFeet < 1000) bits.push(`sight ${state.sightFeet} ft in this weather`);
            }
            detail.textContent = bits.join(' · ');
            light.classList.toggle('hidden', !state.canLight);
            if (state.canLight && document.activeElement !== light) light.innerHTML = lightOptions(lightPresetKey(state.light));
            stop.classList.toggle('hidden', !state.canStop);
        }
    };
}

// Campaign-panel rules. onChange(patch) gets a partial `settings.vision`.
export function createVisionSettings(container, { onChange } = {}) {
    const option = (value, label) => `<option value="${value}">${label}</option>`;
    container.innerHTML = `<label class="vision-toggle"><input type="checkbox" data-vision="enabled">
            <span>Tokens see by line of sight</span></label>
        <p class="vision-note">Players only see the creatures their own character can: walls, closed doors, floors and
            roofs block sight, darkness needs a light or a sense. Double-click a door to open or close it
            (Alt + double-click locks it).</p>
        <div class="vision-grid">
            <label>Night outdoors<select data-vision="night">
                ${option('dim', 'Dim (moonlit)')}${option('dark', 'Dark')}</select></label>
            <label>Under a roof<select data-vision="indoors">
                ${option('auto', 'One step darker')}${option('bright', 'Bright')}${option('dim', 'Dim')}${option('dark', 'Dark')}</select></label>
            <label>Pocket maps<select data-vision="pockets">
                ${option('bright', 'Bright')}${option('dim', 'Dim')}${option('dark', 'Dark')}</select></label>
        </div>
        <label class="vision-toggle"><input type="checkbox" data-vision="memory">
            <span>Characters remember what they have seen</span></label>`;
    const fields = [...container.querySelectorAll('[data-vision]')];
    for (const field of fields) {
        field.addEventListener('change', () => {
            if (!onChange) return;
            onChange({ [field.dataset.vision]: field.type === 'checkbox' ? field.checked : field.value });
        });
    }
    return {
        set(raw) {
            const vision = normalizeVision(raw || VISION_DEFAULTS);
            for (const field of fields) {
                if (field.type === 'checkbox') field.checked = !!vision[field.dataset.vision];
                else field.value = vision[field.dataset.vision];
            }
        }
    };
}

// The GM inspector's vision section for one map object record.
export function visionInspectorHTML(data, { viewing = false } = {}) {
    const creature = data.type === 'token' || data.type === 'character';
    const senses = sensesOf(data);
    const fromBlock = data.monsterData ? parseMonsterSenses(data.monsterData.senses) : null;
    const overridden = !!data.senses && !!data.monsterData;
    const sensesHTML = creature ? `<form id="selection-senses-form" class="selection-form">
            ${SENSE_KEYS.map(key => `<label class="selection-field">${escHtml(SENSE_LABELS[key])} (ft)
                <input name="${key}" type="number" min="0" max="${SENSE_LIMIT}" step="5" value="${senses[key] || 0}"></label>`).join('')}
            <label class="selection-field selection-check"><input name="blind" type="checkbox"${senses.blind ? ' checked' : ''}> Blind beyond these</label>
            <button class="selection-button primary" type="submit">Set senses</button>
            ${overridden ? '<button class="selection-button" type="button" data-vision-act="reset-senses">Use stat block</button>' : ''}
        </form>
        ${fromBlock && !overridden ? `<div class="selection-readonly">From the stat block: ${escHtml(describeSenses(fromBlock))}</div>` : ''}
        ${data.type === 'character' && !data.senses ? '<div class="selection-readonly">Filled in from the sheet when its player is at the table.</div>' : ''}` : '';
    const flagsHTML = `<div class="selection-effects" style="margin-top:8px">
            <button type="button" class="selection-effect${data.hidden ? ' active' : ''}" data-vision-flag="hidden" title="Only the GM sees it">Hidden from players</button>
            ${creature ? `<button type="button" class="selection-effect${data.invisible ? ' active' : ''}" data-vision-flag="invisible" title="Seen only by blindsight, truesight or tremorsense">Invisible</button>` : ''}
        </div>`;
    return `<div class="selection-section">
        <div class="selection-section-title"><span>Vision</span><span>${creature ? escHtml(describeSenses(senses)) : 'Light source'}</span></div>
        <label class="selection-field">Light it sheds<select id="selection-light">${lightOptions(lightPresetKey(data.light))}</select></label>
        ${sensesHTML}
        ${flagsHTML}
        ${creature ? `<div class="selection-actions"><button type="button" class="selection-button wide${viewing ? ' primary' : ''}" data-vision-act="view-as">${viewing ? 'Stop viewing as this token' : 'View the map as this token'}</button></div>` : ''}
    </div>`;
}

// emit(patch) sends `set-vision` for the inspected object; onViewAs() toggles
// the GM's view-as.
export function wireVisionInspector(content, data, { emit, onViewAs }) {
    content.querySelector('#selection-light')?.addEventListener('change', (event) => {
        emit({ light: presetLight(event.target.value) || normalizeLight(data.light) });
    });
    content.querySelector('#selection-senses-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const senses = {};
        for (const key of SENSE_KEYS) senses[key] = Number(form.get(key)) || 0;
        senses.blind = form.get('blind') === 'on';
        emit({ senses });
    });
    content.querySelectorAll('[data-vision-flag]').forEach(button => button.addEventListener('click', () => {
        emit({ [button.dataset.visionFlag]: !button.classList.contains('active') });
    }));
    content.querySelectorAll('[data-vision-act]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.visionAct === 'reset-senses') emit({ senses: null });
        else if (onViewAs) onViewAs();
    }));
}
