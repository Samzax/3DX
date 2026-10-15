// The Reference browser: SRD spells, monsters and items on both tabletop
// screens. Data is local (shared/srd.js caches — the page's own loadSRD and
// homebrew merge are reused), so the panel never talks to the server; the only
// live wire is `roll`, so a stat block's save/check dice still go through the
// table (shared/rolllog.js, server-rolled).
// createReferencePanel({ roll, getActor }) → { open(tab?), close(), toggle(), isOpen() }

import { loadSRD, loadSRDMonsters } from './srd.js';
import { spellDetailHTML } from './spellinfo.js';
import { monsterStatBlockHTML, monsterChallengeLabel } from './monsters.js';

function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Items keep their own card: cost, weight, armoury facts and the SRD blurb.
function itemDetailHTML(item) {
    const facts = [];
    if (item.equipment_category) facts.push(['Category', item.equipment_category.name]);
    if (item.cost) facts.push(['Cost', `${item.cost.quantity} ${item.cost.unit}`]);
    if (item.weight) facts.push(['Weight', `${item.weight} lb`]);
    if (item.armor_class) facts.push(['Armour class', `${item.armor_class.base}${item.armor_class.dex_bonus ? ' + DEX' : ''}${item.armor_class.max_bonus ? ` (max ${item.armor_class.max_bonus})` : ''}`]);
    if (item.armor_category) facts.push(['Armour', item.armor_category]);
    if (item.damage && item.damage.damage_dice) facts.push(['Damage', `${item.damage.damage_dice}${item.damage.damage_type ? ` ${item.damage.damage_type.name}` : ''}`]);
    if (item.weapon_range) facts.push(['Reach', item.weapon_range]);
    if (item.range && item.range.normal) facts.push(['Range', item.range.long ? `${item.range.normal}/${item.range.long} ft` : `${item.range.normal} ft`]);
    if (item.speed && item.speed.quantity) facts.push(['Speed', `${item.speed.quantity} ${item.speed.unit || 'ft'}`]);
    if (item.properties && item.properties.length) facts.push(['Properties', item.properties.map(prop => prop && prop.name).filter(Boolean).join(', ')]);
    const paragraphs = (Array.isArray(item.desc) ? item.desc : []).filter(Boolean)
        .map(text => `<p>${esc(text)}</p>`).join('');
    return `<div class="spell-detail">
        <div class="spell-detail-head">${esc(item.name)}</div>
        <div class="spell-facts">${facts.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div>
        <div class="spell-text">${paragraphs || '<p>No description.</p>'}</div>
    </div>`;
}

export function createReferencePanel({ roll, getActor, getExtraMonsters } = {}) {
    const button = document.createElement('button');
    button.id = 'btn-workspace-reference';
    button.className = 'workspace-top-button';
    button.title = 'SRD reference: spells, monsters, items';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = 'Reference';
    const actions = document.querySelector('#workspace-topbar .workspace-actions');
    const help = document.getElementById('btn-workspace-help');
    if (actions) actions.insertBefore(button, help && help.parentNode === actions ? help : null);

    const overlay = document.createElement('div');
    overlay.id = 'reference-overlay';
    overlay.className = 'hidden';
    overlay.innerHTML = `
        <div class="reference-shell" role="dialog" aria-label="SRD reference">
            <div class="roll-log-bar">
                <span>Reference</span>
                <button type="button" class="roll-log-close" aria-label="Close reference">&times;</button>
            </div>
            <div class="reference-tabs">
                <button type="button" class="reference-tab active" data-ref-tab="spells">Spells</button>
                <button type="button" class="reference-tab" data-ref-tab="monsters">Monsters</button>
                <button type="button" class="reference-tab" data-ref-tab="items">Items</button>
                <input type="search" class="reference-search" placeholder="Search…" autocomplete="off" aria-label="Search reference">
            </div>
            <div class="reference-body">
                <div class="reference-list" data-ref-list></div>
                <div class="reference-detail" data-ref-detail><p class="reference-hint">Pick something on the left to read it here.</p></div>
            </div>
        </div>`;
    document.body.append(overlay);

    const listEl = overlay.querySelector('[data-ref-list]');
    const detailEl = overlay.querySelector('[data-ref-detail]');
    const searchEl = overlay.querySelector('.reference-search');
    const state = { tab: 'spells', query: '', detail: null, srd: null, srdLoading: false, srdError: '', monsters: null, monstersLoading: false, monstersError: '', extraMonsters: getExtraMonsters };

    const isOpen = () => !overlay.classList.contains('hidden');
    function close() {
        overlay.classList.add('hidden');
        button.setAttribute('aria-expanded', 'false');
    }
    function open(tab) {
        if (tab && tab !== state.tab) { state.tab = tab; state.detail = null; state.query = ''; searchEl.value = ''; setTabChrome(); }
        overlay.classList.remove('hidden');
        button.setAttribute('aria-expanded', 'true');
        render();
        ensureTab();
    }
    function setTabChrome() {
        overlay.querySelectorAll('.reference-tab').forEach(el =>
            el.classList.toggle('active', el.dataset.refTab === state.tab));
    }
    function ensureTab() {
        if (state.tab === 'spells' || state.tab === 'items') {
            if (!state.srd && !state.srdLoading) {
                state.srdLoading = true;
                loadSRD().then(srd => { state.srd = srd; state.srdLoading = false; state.srdError = ''; render(); })
                    .catch(error => { state.srdLoading = false; state.srdError = error?.message || 'load failed'; render(); });
            }
            return;
        }
        if (state.tab === 'monsters' && state.monsters === null && !state.monstersLoading) {
            state.monstersLoading = true;
            loadSRDMonsters().then(monsters => { state.monsters = monsters; state.monstersLoading = false; state.monstersError = ''; render(); })
                .catch(error => { state.monstersLoading = false; state.monstersError = error?.message || 'load failed'; render(); });
        }
    }
    function rowsFor() {
        const query = state.query.toLowerCase();
        const match = (...parts) => !query || parts.filter(Boolean).join(' ').toLowerCase().includes(query);
        if (state.tab === 'spells') {
            if (!state.srd) return null;
            return state.srd.spells
                .filter(spell => match(spell.name, spell.school && spell.school.name, (spell.classes || []).map(c => c.name).join(' ')))
                .sort((a, b) => (Number(a.level) - Number(b.level)) || String(a.name).localeCompare(String(b.name)))
                .map(spell => ({ key: spell.index, title: spell.name, meta: `Lv ${spell.level} · ${spell.school ? spell.school.name : ''}`, record: spell }));
        }
        if (state.tab === 'items') {
            if (!state.srd) return null;
            return state.srd.equipment
                .filter(item => match(item.name, item.equipment_category && item.equipment_category.name))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                .map(item => ({ key: item.index, title: item.name, meta: item.equipment_category ? item.equipment_category.name : '', record: item }));
        }
        if (state.monsters === null || state.monstersLoading) return null;
        const extra = typeof state.extraMonsters === 'function' ? state.extraMonsters() : [];
        return [...extra, ...state.monsters]
            .filter(monster => monster && monster.name && match(monster.name, monster.type, monsterChallengeLabel(monster.challenge_rating)))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.index).localeCompare(String(b.index)))
            .map(monster => ({ key: monster.index || monster.name, title: monster.name, meta: `${monster.type || ''} · CR ${monsterChallengeLabel(monster.challenge_rating)}`, record: monster }));
    }
    function detailHTML() {
        const detail = state.detail;
        if (!detail) return '<p class="reference-hint">Pick something on the left to read it here.</p>';
        if (state.tab === 'spells') return spellDetailHTML(detail);
        if (state.tab === 'monsters') return monsterStatBlockHTML(detail);
        return itemDetailHTML(detail);
    }
    function render() {
        setTabChrome();
        if (state.tab === 'monsters' && state.monstersLoading) {
            listEl.innerHTML = '<p class="reference-hint">Loading monsters…</p>';
        } else if (state.tab === 'monsters' && state.monstersError) {
            listEl.innerHTML = `<p class="reference-hint">Could not load monsters: ${esc(state.monstersError)} <button type="button" class="reference-retry" data-ref-retry>Retry</button></p>`;
        } else if ((state.tab === 'spells' || state.tab === 'items') && state.srdError) {
            listEl.innerHTML = `<p class="reference-hint">Could not load the SRD: ${esc(state.srdError)}</p>`;
        } else if ((state.tab === 'spells' || state.tab === 'items') && !state.srd) {
            listEl.innerHTML = '<p class="reference-hint">Loading…</p>';
        } else {
            const rows = rowsFor() || [];
            listEl.innerHTML = rows.length
                ? rows.map(row => `<button type="button" class="reference-row${state.detail === row.record ? ' active' : ''}" data-ref-key="${esc(row.key)}" title="${esc(row.title)}">
                    <span>${esc(row.title)}</span><small>${esc(row.meta)}</small></button>`).join('')
                : '<p class="reference-hint">Nothing matches that search.</p>';
        }
        detailEl.innerHTML = detailHTML();
    }

    button.addEventListener('click', () => (isOpen() ? close() : open()));
    overlay.querySelector('.roll-log-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
    overlay.querySelector('.reference-tabs').addEventListener('click', (event) => {
        const tab = event.target.closest('[data-ref-tab]');
        if (!tab || tab.dataset.refTab === state.tab) return;
        state.tab = tab.dataset.refTab;
        state.detail = null;
        state.query = '';
        searchEl.value = '';
        render();
        ensureTab();
    });
    searchEl.addEventListener('input', () => { state.query = searchEl.value.trim(); state.detail = null; render(); });
    listEl.addEventListener('click', (event) => {
        if (event.target.closest('[data-ref-retry]')) { state.monsters = null; state.monstersError = ''; state.monstersLoading = false; ensureTab(); render(); return; }
        const row = event.target.closest('[data-ref-key]');
        if (!row) return;
        const rows = rowsFor() || [];
        const found = rows.find(entry => String(entry.key) === row.dataset.refKey);
        if (found) { state.detail = found.record; render(); }
    });
    // Stat-block saves and checks roll at the table like anywhere else.
    detailEl.addEventListener('click', (event) => {
        const rollable = event.target.closest('[data-roll]');
        if (!rollable || !roll) return;
        roll({ actor: (getActor && getActor()) || 'Reference', label: rollable.dataset.roll, d20: { bonus: Number(rollable.dataset.rollBonus) || 0 } });
    });

    return {
        open,
        close,
        toggle: () => (isOpen() ? close() : open()),
        isOpen
    };
}
