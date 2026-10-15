// lobby.js — campaign browser: login, list campaigns, enter as GM/player, and
// the five-step new-campaign wizard (identity -> world -> biomes -> spawn ->
// party). All campaign text is user content: render only through escHtml.

import { setupLoginModal, logout } from '../shared/login.js';
import { escHtml, pagePath, campaignStyleLabel } from '../shared/campaigns.js';
import { WORLD_PRESETS } from '../shared/worldgen.js';
import { createWorldSettings } from '../shared/worldsettings.js';
import { createWorldMap } from '../shared/worldmap.js';
import { createAccessDialog } from '../shared/access.js';

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

let isHost = false;          // the host account: sees everything, approves requests
let users = [];              // account directory (host: admin detail; others: names)

const mainEl = document.getElementById('lobby-main');
const toastEl = document.getElementById('lobby-toast');
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

let toastTimer = null;
function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 6000);
}

// Privacy + invites: one shared dialog (shared/access.js); it binds its own
// socket listeners the first time it opens.
const accessDialog = createAccessDialog({
    getSocket: () => socket,
    onSaved: () => toast('Campaign access saved.')
});

// --- Tabs ---

function showTab(name) {
    document.querySelectorAll('#lobby-tabs [data-tab]').forEach(tab =>
        tab.classList.toggle('active', tab.dataset.tab === name));
    document.querySelectorAll('.lobby-panel').forEach(panel =>
        panel.classList.toggle('hidden', panel.dataset.panel !== name));
}

document.getElementById('lobby-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) showTab(tab.dataset.tab);
});

function setCount(id, count) {
    const el = document.getElementById(id);
    el.textContent = String(count);
    el.classList.toggle('hidden', !count);
}

// --- Campaign lists ---

// Case-insensitive, matching the server's isCampaignGMFor.
function ownsCampaign(campaign) {
    return !!username && String(campaign.owner).toLowerCase() === username.toLowerCase();
}

// place: 'mine' | 'public' | 'invited' | 'request' (host tab)
function campaignCard(campaign, place) {
    const canGM = ownsCampaign(campaign) || isHost;
    const pending = campaign.status === 'pending';
    const isPrivate = campaign.visibility === 'private';
    const style = campaignStyleLabel(campaign.settings);
    const styleClass = campaign.settings && campaign.settings.mapStyle === 'region' ? 'region' : '';
    const chars = Array.isArray(campaign.myCharacters) ? campaign.myCharacters : [];
    const charsAttr = escHtml(JSON.stringify(chars.map(char => ({ id: char.id, name: char.name }))));
    let actions;
    if (place === 'request') {
        actions = `<button data-action="approve">Approve</button>
            <button data-action="enter-gm">Preview</button>
            <button data-action="reject" class="danger">Reject</button>`;
    } else if (pending) {
        actions = '<button data-action="delete" class="danger">Cancel request</button>';
    } else {
        actions = `${canGM ? '<button data-action="enter-gm">Enter as GM</button>' : ''}
            <button data-action="enter-player" data-characters="${charsAttr}">Enter as player</button>
            ${canGM ? '<button data-action="access">Access</button>' : ''}
            ${canGM && campaign.id !== 'default' ? '<button data-action="delete" class="danger">Delete</button>' : ''}`;
    }
    return `<article class="lobby-card ${pending ? 'pending' : ''}" data-id="${escHtml(campaign.id)}">
        <header>
            <h3>${escHtml(campaign.name)}</h3>
            <span class="lobby-badges">
                ${pending ? '<span class="lobby-badge pending">Awaiting approval</span>' : ''}
                <span class="lobby-badge ${isPrivate ? 'private' : ''}">${isPrivate ? 'Private' : 'Public'}</span>
                <span class="lobby-badge ${styleClass}">${escHtml(style)}</span>
            </span>
        </header>
        ${campaign.description ? `<p class="lobby-desc">${escHtml(campaign.description)}</p>` : ''}
        <div class="lobby-meta">
            <span>GM: ${escHtml(campaign.owner)}</span>
            <span>Seed ${Number(campaign.settings && campaign.settings.seed) || 0}</span>
            ${pending ? '' : `<span>${Number(campaign.online) || 0} online</span>`}
        </div>
        <div class="lobby-actions-row">${actions}</div>
    </article>`;
}

function fillGrid(id, list, place, emptyText) {
    document.getElementById(id).innerHTML = list.length
        ? list.map(campaign => campaignCard(campaign, place)).join('')
        : `<p class="lobby-empty">${emptyText}</p>`;
}

function renderCampaigns() {
    const list = Array.isArray(campaigns) ? campaigns : [];
    const mine = list.filter(ownsCampaign);
    const others = list.filter(campaign => !ownsCampaign(campaign) && campaign.status === 'active');
    const invited = others.filter(campaign => campaign.invited);
    const requests = isHost ? list.filter(campaign => campaign.status === 'pending') : [];
    fillGrid('lobby-mine', mine, 'mine', 'You are not running a campaign yet.');
    fillGrid('lobby-public', others.filter(campaign => !campaign.invited), 'public',
        isHost ? 'No other campaigns on this server.' : 'No public campaigns right now.');
    fillGrid('lobby-invited', invited, 'invited', 'No invitations yet. A GM can invite you to a private campaign.');
    fillGrid('host-requests', requests, 'request', 'No campaign requests waiting.');
    // The host sees every table, private ones included.
    document.getElementById('lobby-public-title').textContent = isHost ? 'Other campaigns' : 'Public campaigns';
    document.getElementById('lobby-public-sub').textContent = isHost
        ? 'Every other table on this server, private ones included.'
        : 'Open tables anyone on this server can join.';
    setCount('invited-count', invited.length);
    setCount('host-count', requests.length);
    newCampaignButton.disabled = false;
    if (accessDialog.isOpen() && !list.some(campaign => campaign.id === accessDialog.openId())) {
        accessDialog.close();
    }
}

mainEl.addEventListener('click', (event) => {
    const button = event.target.closest('.lobby-card button[data-action]');
    if (!button) return;
    const card = button.closest('.lobby-card');
    const campaignId = card && card.dataset.id;
    if (!campaignId) return;
    const campaign = campaigns.find(entry => entry.id === campaignId);
    const label = campaign ? `"${campaign.name}"` : 'this campaign';
    const action = button.dataset.action;
    if (action === 'enter-gm') {
        window.location.href = pagePath('/gm', campaignId);
    } else if (action === 'enter-player') {
        openPartyPicker(card, campaignId, button.dataset.characters);
    } else if (action === 'access') {
        accessDialog.open(campaign, users);
    } else if (action === 'approve') {
        button.disabled = true;
        socket.emit('review-campaign', { id: campaignId, approve: true });
    } else if (action === 'reject') {
        if (window.confirm(`Reject ${label}? The request and its world settings are deleted.`)) {
            button.disabled = true;
            socket.emit('review-campaign', { id: campaignId, approve: false });
        }
    } else if (action === 'delete') {
        if (window.confirm(`Delete ${label}? Its maps, characters and files are removed for everyone.`)) {
            button.disabled = true;
            socket.emit('delete-campaign', { id: campaignId });
        }
    }
});

// --- Campaign access: privacy + invites — owned by shared/access.js ---

// --- Host tab: accounts ---

function renderUsers() {
    const container = document.getElementById('host-users');
    if (!isHost) { container.innerHTML = ''; return; }
    container.innerHTML = users.map(user => {
        const host = user.role === 'host';
        return `<div class="host-user ${user.disabled ? 'disabled' : ''}" data-user="${escHtml(user.username)}">
            <span class="host-user-dot ${user.online ? 'online' : ''}" title="${user.online ? 'Online' : 'Offline'}"></span>
            <span class="host-user-name">${escHtml(user.username)}</span>
            ${host ? '<span class="lobby-badge">Host</span>' : ''}
            ${user.disabled ? '<span class="lobby-badge private">Disabled</span>' : ''}
            <span class="host-user-actions">
                ${host ? '' : `<label class="host-check" title="Creates campaigns without approval">
                    <input type="checkbox" data-action="trust" ${user.trusted ? 'checked' : ''} /> Trusted</label>`}
                <button data-action="reset">New password</button>
                ${host ? '' : `<button data-action="toggle">${user.disabled ? 'Enable' : 'Disable'}</button>`}
            </span>
        </div>`;
    }).join('');
}

document.getElementById('host-users').addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    const row = event.target.closest('.host-user');
    if (!control || !row) return;
    const target = users.find(user => user.username === row.dataset.user);
    if (!target) return;
    const action = control.dataset.action;
    if (action === 'trust') {
        socket.emit('admin-update-user', { username: target.username, trusted: control.checked });
    } else if (action === 'toggle') {
        const disabling = !target.disabled;
        if (disabling && !window.confirm(`Disable ${target.username}? They are signed out and cannot log in until re-enabled.`)) return;
        socket.emit('admin-update-user', { username: target.username, disabled: disabling });
    } else if (action === 'reset') {
        const typed = window.prompt(`New password for ${target.username} (they are signed out everywhere):`);
        if (typed) socket.emit('admin-update-user', { username: target.username, password: typed });
    }
});

document.getElementById('host-create-user').addEventListener('submit', (event) => {
    event.preventDefault();
    const field = (id) => document.getElementById(id);
    const typed = field('host-new-password').value;
    socket.emit('admin-create-user', {
        username: field('host-new-username').value.trim(),
        password: typed,
        trusted: field('host-new-trusted').checked
    });
});

document.getElementById('btn-logout').addEventListener('click', logout);

// --- Enter as player: pick characters, then deep-link into /player ---

function openPartyPicker(card, campaignId, charactersRaw) {
    lastPartyCard = { campaignId };
    let characters = [];
    try { characters = JSON.parse(charactersRaw || '[]'); } catch (_) { characters = []; }
    // Characters from the player's other campaigns can be brought along (a
    // copy); one whose name is already here was most likely brought before.
    const here = new Set(characters.map(char => String(char.name).toLowerCase()));
    const elsewhere = allOwnedCharacters().filter(char =>
        char.fromCampaignId !== campaignId && !here.has(String(char.name).toLowerCase()));
    if (!elsewhere.length && characters.length <= 1) {
        window.location.href = pagePath('/player', campaignId,
            characters.length ? { chars: characters[0].id } : {});
        return;
    }
    showError(partyError, '');
    document.getElementById('party-sub').textContent = characters.length
        ? 'These characters are yours in this campaign. Uncheck anyone you are not playing.'
        : 'You have no characters in this campaign yet.';
    const mine = characters.map(char => `
        <label>
            <input type="checkbox" name="party-char" value="${escHtml(char.id)}" checked />
            <span>${escHtml(char.name)}</span>
        </label>`).join('');
    const bring = elsewhere.map(char => `
        <label>
            <input type="checkbox" name="party-bring"
                value="${escHtml(char.id)}" data-from="${escHtml(char.fromCampaignId)}" />
            <span>${escHtml(char.name)}</span>
            <span class="party-source">${escHtml(char.fromName)}</span>
        </label>`).join('');
    partyList.innerHTML = `${mine ? `<div class="wizard-party">${mine}</div>` : ''}
        ${bring ? `<h3 class="access-heading">Add existing characters to this campaign?</h3>
            <p class="lobby-sub">A copy joins this campaign; the original stays where it is.</p>
            <div class="wizard-party">${bring}</div>` : ''}`;
    document.getElementById('party-all').classList.toggle('hidden', characters.length < 2);
    partyOverlay.classList.remove('hidden');
}

async function enterFromParty(onlyChecked) {
    if (!lastPartyCard) return;
    const { campaignId } = lastPartyCard;
    const ids = onlyChecked
        ? [...partyList.querySelectorAll('input[name="party-char"]:checked')].map(input => input.value)
        : [...partyList.querySelectorAll('input[name="party-char"]')].map(input => input.value);
    const brought = await copyCharacters(
        [...partyList.querySelectorAll('input[name="party-bring"]:checked')], campaignId, partyError);
    if (!brought) return;
    ids.push(...brought);
    partyOverlay.classList.add('hidden');
    window.location.href = pagePath('/player', campaignId,
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
    // An approved campaign is entered right away; a request just closes.
    wizardEnter.textContent = wizard.pending ? 'Done' : 'Enter campaign';
    document.getElementById('wizard-pending-note').classList.toggle('hidden', !wizard.pending);
    showError(wizardError, '');
    if (step === 3) renderBiomeOptions();
    if (step === 5) renderPartyStep();
    // One map widget, shown on both the World and the Spawn step.
    const slot = wizardOverlay.querySelector(`.wizard-map-slot[data-slot="${step}"]`);
    if (slot) { slot.appendChild(document.getElementById('wizard-map')); wizardMap.render(); }
}

function openWizard() {
    wizard.createdId = null;
    wizard.pending = false;
    const privateRadio = wizardOverlay.querySelector('input[name="wizard-visibility"][value="private"]');
    if (privateRadio) privateRadio.checked = true;
    // Trusted players and the host skip approval (the server decides).
    const me = users.find(user => user.username === username);
    document.getElementById('wizard-approval-note').classList.toggle('hidden',
        isHost || !!(me && me.trusted));
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

// Copies each ticked character (value = id, data-from = its campaign) into a
// campaign; resolves to the new ids, or null once one copy fails.
async function copyCharacters(inputs, toCampaignId, errorEl) {
    const ids = [];
    for (const input of inputs) {
        const done = waitForEvent('character-saved-success');
        socket.emit('copy-character', {
            fromCampaignId: input.dataset.from,
            charId: input.value,
            toCampaignId
        });
        try { ids.push((await done).id); }
        catch (error) { showError(errorEl, 'Could not copy a character. Try again.'); return null; }
    }
    return ids;
}

async function copySelectedParty() {
    const selected = [...wizardOverlay.querySelectorAll('input[name="wizard-party-char"]:checked')];
    return !!(await copyCharacters(selected, wizard.createdId, wizardError));
}

async function createCampaign() {
    const name = document.getElementById('wizard-name').value.trim();
    if (!name) { gotoWizardStep(1); showError(wizardError, 'Campaign name is required.'); return; }
    const settings = collectWizardSettings();
    if (!settings.biomes.length) settings.biomes = BIOME_OPTIONS.map(option => option.key);
    const created = waitForEvent('campaign-created');
    const visibility = wizardOverlay.querySelector('input[name="wizard-visibility"]:checked');
    socket.emit('create-campaign', {
        name,
        description: document.getElementById('wizard-description').value.trim(),
        visibility: visibility ? visibility.value : 'private',
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
    if (!ok) return;
    if (wizard.pending) {
        closeWizard();
        toast('Campaign request sent. It opens as soon as the host approves it.');
        socket.emit('get-campaigns');
    } else {
        window.location.href = pagePath('/gm', wizard.createdId);
    }
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

const login = setupLoginModal(() => {
    socket = io();
    login.attach(socket);
    socket.on('connect', () => {
        socket.emit('login', login.payload({ screen: 'lobby' }));
    });

    // The server pushes campaign-list and user-list right after a lobby login.
    socket.on('login-success', (data) => {
        username = data.username;
        isHost = !!data.isGM;
        if (userLabel) userLabel.textContent = isHost ? `${username} (host)` : username;
        document.title = `3D VTT - Campaigns (${username})`;
        document.getElementById('tab-button-host').classList.toggle('hidden', !isHost);
        if (!isHost && !document.querySelector('.lobby-panel[data-panel="host"]').classList.contains('hidden')) {
            showTab('campaigns');
        }
    });

    socket.on('campaign-list', (payload) => {
        campaigns = (payload && Array.isArray(payload.campaigns)) ? payload.campaigns : [];
        renderCampaigns();
    });

    socket.on('user-list', (payload) => {
        users = (payload && Array.isArray(payload.users)) ? payload.users : [];
        renderUsers();
    });

    // campaign-access-saved is handled by shared/access.js (close + toast).

    socket.on('admin-done', (payload) => {
        if (payload && payload.action === 'create') {
            document.getElementById('host-create-user').reset();
            toast(`Account "${payload.username}" created.`);
        } else {
            toast(`Account "${payload && payload.username}" updated.`);
        }
    });

    socket.on('campaign-created', (payload) => {
        wizard.createdId = payload && payload.id;
        wizard.pending = !!(payload && payload.pending);
        // Refresh so later party lists include the new (empty) campaign entry.
        socket.emit('get-campaigns');
        if (wizardOverlay && !wizardOverlay.classList.contains('hidden')) gotoWizardStep(5);
    });

    socket.on('campaign-deleted', () => {
        socket.emit('get-campaigns');
    });

    socket.on('error', (message) => {
        // The access dialog shows its own refusals while it is open.
        if (accessDialog.isOpen()) return;
        const open = (overlay) => overlay && !overlay.classList.contains('hidden');
        const target = open(wizardOverlay) ? wizardError
            : open(partyOverlay) ? partyError : null;
        if (target) showError(target, String(message));
        else toast(String(message), true);
        // A refused action leaves its button disabled; redraw from server truth.
        if (username) socket.emit('get-campaigns');
    });

    socket.on('disconnect', () => {
        // Reconnect re-runs 'connect' -> login -> campaign-list.
    });
});
