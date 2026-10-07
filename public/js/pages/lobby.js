// lobby.js — campaign browser: login, list campaigns, enter as GM/player, and
// the five-step new-campaign wizard (identity -> world -> biomes -> spawn ->
// party). All campaign text is user content: render only through escHtml.

import { setupLoginModal } from '../shared/login.js';
import { escHtml, pagePath, campaignStyleLabel } from '../shared/campaigns.js';
import { WORLD_PRESETS } from '../shared/worldgen.js';
import { createWorldSettings } from '../shared/worldsettings.js';
import { createWorldMap } from '../shared/worldmap.js';

const BIOME_OPTIONS = [
    { key: 'plains', label: 'Plains' },
    { key: 'forest', label: 'Forest' },
    { key: 'mountains', label: 'Mountains' },
    { key: 'desert', label: 'Desert' },
    { key: 'swamp', label: 'Swamp' },
    { key: 'coast', label: 'Coast' },
    { key: 'tundra', label: 'Tundra' },
    { key: 'taiga', label: 'Taiga' },
    { key: 'snow', label: 'Snowfield' }
];

let socket = null;
let username = null;
let campaigns = [];
let lastPartyCard = null;

const wizard = {
    step: 1,
    createdId: null,
    settings: {
        mapStyle: 'ladder',
        seed: 1337,
        biomes: BIOME_OPTIONS.map(option => option.key),
        spawn: { x: 0, z: 0 }
    }
};

const listEl = document.getElementById('lobby-campaign-list');
const newCampaignButton = document.getElementById('btn-new-campaign');
const userLabel = document.getElementById('lobby-user');
const wizardOverlay = document.getElementById('wizard-overlay');
const wizardError = document.getElementById('wizard-error');
const partyOverlay = document.getElementById('party-overlay');
const partyList = document.getElementById('party-list');
const partyError = document.getElementById('party-error');

function showError(el, message) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}

function isGlobalGM() {
    return !!username && username.toLowerCase() === 'gm';
}

// --- Campaign list ---

function renderCampaigns() {
    if (!Array.isArray(campaigns) || !campaigns.length) {
        listEl.innerHTML = '<p class="lobby-empty">No campaigns yet. Create the first one.</p>';
        newCampaignButton.disabled = false;
        return;
    }
    listEl.innerHTML = campaigns.map(campaign => {
        // Case-insensitive, matching the server's isCampaignGMFor.
        const isOwner = !!username && String(campaign.owner).toLowerCase() === username.toLowerCase();
        const canGM = isOwner || isGlobalGM();
        const style = campaignStyleLabel(campaign.settings);
        const styleClass = campaign.settings && campaign.settings.mapStyle === 'region' ? 'region' : '';
        const chars = Array.isArray(campaign.myCharacters) ? campaign.myCharacters : [];
        const charsAttr = escHtml(JSON.stringify(chars.map(char => ({ id: char.id, name: char.name }))));
        return `<article class="lobby-card" data-id="${escHtml(campaign.id)}">
            <header>
                <h3>${escHtml(campaign.name)}</h3>
                <span class="lobby-badge ${styleClass}">${escHtml(style)}</span>
            </header>
            ${campaign.description ? `<p class="lobby-desc">${escHtml(campaign.description)}</p>` : ''}
            <div class="lobby-meta">
                <span>GM: ${escHtml(campaign.owner)}</span>
                <span>Seed ${Number(campaign.settings && campaign.settings.seed) || 0}</span>
                <span>${Number(campaign.online) || 0} online</span>
            </div>
            <div class="lobby-actions-row">
                ${canGM ? '<button data-action="enter-gm">Enter as GM</button>' : ''}
                <button data-action="enter-player" data-characters="${charsAttr}">Enter as player</button>
                ${isOwner && campaign.id !== 'default'
                    ? '<button data-action="delete" class="danger">Delete</button>' : ''}
            </div>
        </article>`;
    }).join('');
    newCampaignButton.disabled = false;
}

listEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('.lobby-card');
    const campaignId = card && card.dataset.id;
    if (!campaignId) return;
    const action = button.dataset.action;
    if (action === 'enter-gm') {
        window.location.href = pagePath('/gm', campaignId);
    } else if (action === 'enter-player') {
        openPartyPicker(card, campaignId, button.dataset.characters);
    } else if (action === 'delete') {
        const campaign = campaigns.find(entry => entry.id === campaignId);
        const label = campaign ? `"${campaign.name}"` : 'this campaign';
        if (window.confirm(`Delete ${label}? Its maps, characters and files are removed for everyone.`)) {
            button.disabled = true;
            socket.emit('delete-campaign', { id: campaignId });
        }
    }
});

// --- Enter as player: pick characters, then deep-link into /player ---

function openPartyPicker(card, campaignId, charactersRaw) {
    lastPartyCard = { campaignId };
    let characters = [];
    try { characters = JSON.parse(charactersRaw || '[]'); } catch (_) { characters = []; }
    if (!characters.length) {
        window.location.href = pagePath('/player', campaignId);
        return;
    }
    if (characters.length === 1) {
        window.location.href = pagePath('/player', campaignId, { chars: characters[0].id });
        return;
    }
    showError(partyError, '');
    document.getElementById('party-sub').textContent =
        'These characters are yours in this campaign. Uncheck anyone you are not playing.';
    partyList.innerHTML = characters.map(char => `
        <label>
            <input type="checkbox" name="party-char" value="${escHtml(char.id)}" checked />
            <span>${escHtml(char.name)}</span>
        </label>`).join('');
    partyOverlay.classList.remove('hidden');
}

function enterFromParty(onlyChecked) {
    if (!lastPartyCard) return;
    const ids = onlyChecked
        ? [...partyList.querySelectorAll('input[name="party-char"]:checked')].map(input => input.value)
        : [...partyList.querySelectorAll('input[name="party-char"]')].map(input => input.value);
    partyOverlay.classList.add('hidden');
    window.location.href = pagePath('/player', lastPartyCard.campaignId,
        ids.length ? { chars: ids.join(',') } : {});
}

document.getElementById('party-enter').addEventListener('click', () => enterFromParty(true));
document.getElementById('party-all').addEventListener('click', () => enterFromParty(false));
partyOverlay.addEventListener('click', (event) => {
    if (event.target === partyOverlay) partyOverlay.classList.add('hidden');
});

// --- New-campaign wizard ---

const wizardBack = document.getElementById('wizard-back');
const wizardNext = document.getElementById('wizard-next');
const wizardCreate = document.getElementById('wizard-create');
const wizardEnter = document.getElementById('wizard-enter');

function renderBiomeOptions() {
    document.getElementById('wizard-biomes').innerHTML = BIOME_OPTIONS.map(option => `
        <label>
            <input type="checkbox" value="${option.key}"
                ${wizard.settings.biomes.includes(option.key) ? 'checked' : ''} />
            <span>${option.label}</span>
        </label>`).join('');
}

function gotoWizardStep(step) {
    wizard.step = step;
    wizardOverlay.querySelectorAll('.wizard-step').forEach(section => {
        section.classList.toggle('hidden', Number(section.dataset.step) !== step);
    });
    wizardOverlay.querySelectorAll('#wizard-steps li').forEach(item => {
        item.classList.toggle('active', Number(item.dataset.step) === step);
    });
    wizardBack.disabled = step === 1 || wizard.createdId != null;
    wizardNext.classList.toggle('hidden', step >= 4);
    wizardCreate.classList.toggle('hidden', step !== 4);
    wizardEnter.classList.toggle('hidden', step !== 5);
    showError(wizardError, '');
    if (step === 3) renderBiomeOptions();
    if (step === 5) renderPartyStep();
    // One map widget, shown on both the World and the Spawn step.
    const slot = wizardOverlay.querySelector(`.wizard-map-slot[data-slot="${step}"]`);
    if (slot) { slot.appendChild(document.getElementById('wizard-map')); wizardMap.render(); }
}

function openWizard() {
    wizard.createdId = null;
    wizard.step = 1;
    wizard.settings = {
        mapStyle: 'ladder',
        seed: 1337,
        biomes: BIOME_OPTIONS.map(option => option.key),
        spawn: { x: 0, z: 0 }
    };
    document.getElementById('wizard-name').value = '';
    document.getElementById('wizard-description').value = '';
    document.getElementById('wizard-seed').value = String(Math.floor(Math.random() * 2147483647));
    document.getElementById('wizard-spawn-x').value = '0';
    document.getElementById('wizard-spawn-z').value = '0';
    document.getElementById('wizard-homeland').checked = true;
    wizardWorld.set(WORLD_PRESETS[0].world);
    const ladderRadio = wizardOverlay.querySelector('input[name="wizard-style"][value="ladder"]');
    if (ladderRadio) ladderRadio.checked = true;
    wizardOverlay.classList.remove('hidden');
    gotoWizardStep(1);
    document.getElementById('wizard-name').focus();
}

function closeWizard() {
    wizardOverlay.classList.add('hidden');
}

// World controls (preset chips + fine-tune sliders) and the live preview map.
const wizardWorld = createWorldSettings(document.getElementById('wizard-world'),
    { onChange: () => wizardMap.render() });
const wizardMap = createWorldMap(document.getElementById('wizard-map-canvas'), {
    zoomEl: document.getElementById('wizard-map-zoom'),
    getSettings: () => collectWizardSettings(),
    getSpawn: () => collectWizardSettings().spawn,
    onPick: (point) => {
        document.getElementById('wizard-spawn-x').value = String(point.x);
        document.getElementById('wizard-spawn-z').value = String(point.z);
    }
});

function collectWizardSettings() {
    const seedValue = Math.floor(Number(document.getElementById('wizard-seed').value));
    const spawnX = Number(document.getElementById('wizard-spawn-x').value) || 0;
    const spawnZ = Number(document.getElementById('wizard-spawn-z').value) || 0;
    const biomes = [...wizardOverlay.querySelectorAll('#wizard-biomes input:checked')]
        .map(input => input.value);
    const styleInput = wizardOverlay.querySelector('input[name="wizard-style"]:checked');
    return {
        mapStyle: styleInput ? styleInput.value : 'ladder',
        seed: Number.isFinite(seedValue) && seedValue >= 0 ? seedValue : 1337,
        biomes,
        spawn: { x: spawnX, z: spawnZ },
        world: {
            ...wizardWorld.get(),
            home: document.getElementById('wizard-homeland').checked ? { x: spawnX, z: spawnZ } : null
        }
    };
}

function validateWizardStep() {
    if (wizard.step === 1) {
        const name = document.getElementById('wizard-name').value.trim();
        if (!name) { showError(wizardError, 'Campaign name is required.'); return null; }
        return { name };
    }
    if (wizard.step === 3) {
        const settings = collectWizardSettings();
        if (!settings.biomes.length) {
            showError(wizardError, 'Pick at least one paintable biome.');
            return null;
        }
        return { settings };
    }
    if (wizard.step === 4) {
        const settings = collectWizardSettings();
        if (!settings.biomes.length) settings.biomes = BIOME_OPTIONS.map(option => option.key);
        return { settings };
    }
    return {};
}

function allOwnedCharacters() {
    const seen = new Set();
    const flat = [];
    for (const campaign of campaigns) {
        for (const char of (Array.isArray(campaign.myCharacters) ? campaign.myCharacters : [])) {
            if (seen.has(char.id)) continue;
            seen.add(char.id);
            flat.push({ id: char.id, name: char.name, fromCampaignId: campaign.id, fromName: campaign.name });
        }
    }
    return flat;
}

function renderPartyStep() {
    const container = document.getElementById('wizard-party-list');
    const owned = allOwnedCharacters();
    if (!owned.length) {
        container.innerHTML = '<p class="lobby-sub">No characters to copy yet &mdash; you can add them later from the studio.</p>';
        return;
    }
    container.innerHTML = owned.map(char => `
        <label>
            <input type="checkbox" name="wizard-party-char"
                value="${escHtml(char.id)}" data-from="${escHtml(char.fromCampaignId)}" />
            <span>${escHtml(char.name)}</span>
            <span class="party-source">${escHtml(char.fromName)}</span>
        </label>`).join('');
}

function waitForEvent(eventName, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(eventName, onEvent);
            reject(new Error(`Timed out waiting for ${eventName}`));
        }, timeoutMs);
        function onEvent(payload) {
            clearTimeout(timer);
            resolve(payload);
        }
        socket.once(eventName, onEvent);
    });
}

async function copySelectedParty() {
    const selected = [...wizardOverlay.querySelectorAll('input[name="wizard-party-char"]:checked')];
    for (const input of selected) {
        const done = waitForEvent('character-saved-success');
        socket.emit('copy-character', {
            fromCampaignId: input.dataset.from,
            charId: input.value,
            toCampaignId: wizard.createdId
        });
        try { await done; }
        catch (error) { showError(wizardError, error.message); return false; }
    }
    return true;
}

async function createCampaign() {
    const name = document.getElementById('wizard-name').value.trim();
    if (!name) { gotoWizardStep(1); showError(wizardError, 'Campaign name is required.'); return; }
    const settings = collectWizardSettings();
    if (!settings.biomes.length) settings.biomes = BIOME_OPTIONS.map(option => option.key);
    const created = waitForEvent('campaign-created');
    socket.emit('create-campaign', {
        name,
        description: document.getElementById('wizard-description').value.trim(),
        settings
    });
    try { await created; }
    catch (error) { showError(wizardError, error.message); return; }
    // campaign-created handler sets wizard.createdId and advances the step.
}

wizardNext.addEventListener('click', () => {
    const result = validateWizardStep();
    if (!result) return;
    if (result.settings) wizard.settings = result.settings;
    gotoWizardStep(wizard.step + 1);
});

wizardBack.addEventListener('click', () => {
    if (wizard.step > 1 && wizard.createdId == null) gotoWizardStep(wizard.step - 1);
});

wizardCreate.addEventListener('click', () => {
    const result = validateWizardStep();
    if (!result) return;
    if (result.settings) wizard.settings = result.settings;
    createCampaign();
});

wizardEnter.addEventListener('click', async () => {
    if (!wizard.createdId) return;
    wizardEnter.disabled = true;
    const ok = await copySelectedParty();
    wizardEnter.disabled = false;
    if (ok) window.location.href = pagePath('/gm', wizard.createdId);
});

['wizard-seed', 'wizard-spawn-x', 'wizard-spawn-z', 'wizard-homeland'].forEach(id =>
    document.getElementById(id).addEventListener('input', () => wizardMap.render()));

document.getElementById('wizard-seed-roll').addEventListener('click', () => {
    document.getElementById('wizard-seed').value = String(Math.floor(Math.random() * 2147483647));
    wizardMap.render();
});

wizardOverlay.addEventListener('click', (event) => {
    // Close only on backdrop clicks before the campaign exists.
    if (event.target === wizardOverlay && wizard.createdId == null) closeWizard();
});

newCampaignButton.addEventListener('click', openWizard);

// --- Socket / login ---

const login = setupLoginModal((name) => {
    socket = io();
    socket.on('connect', () => {
        socket.emit('login', { username: name, screen: 'lobby' });
    });

    socket.on('login-success', (data) => {
        username = data.username;
        login.hide();
        if (userLabel) userLabel.textContent = username;
        document.title = `3D VTT - Campaigns (${username})`;
        socket.emit('get-campaigns');
    });

    socket.on('campaign-list', (payload) => {
        campaigns = (payload && Array.isArray(payload.campaigns)) ? payload.campaigns : [];
        renderCampaigns();
    });

    socket.on('campaign-created', (payload) => {
        wizard.createdId = payload && payload.id;
        // Refresh so later party lists include the new (empty) campaign entry.
        socket.emit('get-campaigns');
        if (wizardOverlay && !wizardOverlay.classList.contains('hidden')) gotoWizardStep(5);
    });

    socket.on('campaign-deleted', () => {
        socket.emit('get-campaigns');
    });

    socket.on('error', (message) => {
        const target = wizardOverlay && !wizardOverlay.classList.contains('hidden')
            ? wizardError
            : (partyOverlay && !partyOverlay.classList.contains('hidden') ? partyError : null);
        if (target) showError(target, String(message));
        else login.showError(String(message));
    });

    socket.on('disconnect', () => {
        // Reconnect re-runs 'connect' -> login -> campaign-list.
    });
});
