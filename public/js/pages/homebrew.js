import * as srdModule from '../shared/srd.js';
import { setupLoginModal } from '../shared/login.js';
import { createRulesBuilder, RULE_TYPES } from './homebrew-rules.js';

const { loadSRD, loadSRDMonsters, ABILITIES, ABILITY_NAMES } = srdModule;
const ABILITY_FIELDS = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
let SRD = null, SRD_MONSTERS = [], socket = null, username = null, isHost = false;
const emptyHomebrew = () => ({ ...Object.fromEntries(RULE_TYPES.map(([, , collection]) => [collection, []])), monsters: [] });
let homebrew = emptyHomebrew();
let rulesBuilder = null;   // races, classes, feats… (homebrew-rules.js)
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let editingMonsterIndex = null;
let pendingHomebrewTarget = null;
let monsterFormExtras = emptyMonsterFormExtras();
let srdMonsterLoadPromise = null;

function cloneMonsterValue(value) {
  if (Array.isArray(value)) return value.map(cloneMonsterValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneMonsterValue(child)]));
  }
  return value;
}

function emptyMonsterFormExtras() {
  return {
    speed: {},
    proficiencies: [],
    condition_immunities: [],
    reactions: [],
    legendary_actions: []
  };
}

function numberValue(id, fallback) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(number) ? number : fallback)));
}

function commaList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function damageTypeReference(value) {
  const name = String(value || '').trim() || 'Untyped';
  const index = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untyped';
  return { index, name: name.replace(/\b\w/g, letter => letter.toUpperCase()) };
}

function challengeRatingValue(value) {
  const text = String(value || '').trim();
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  const rating = fraction && Number(fraction[2]) !== 0
    ? Number(fraction[1]) / Number(fraction[2])
    : Number(text);
  return Number.isFinite(rating) && rating >= 0 && rating <= 30 ? rating : null;
}

function challengeRatingLabel(value) {
  const number = Number(value);
  const labels = new Map([[0.125, '1/8'], [0.25, '1/4'], [0.5, '1/2']]);
  return labels.get(number) || (Number.isFinite(number) ? String(number) : '1');
}

function armorClassValue(monster) {
  const armor = monster && monster.armor_class;
  if (Array.isArray(armor)) return Number(armor[0] && armor[0].value) || 10;
  return Number(armor) || 10;
}

function walkSpeedValue(monster) {
  const walk = monster && monster.speed && monster.speed.walk;
  const match = String(walk == null ? '' : walk).match(/\d+/);
  return match ? Number(match[0]) : 30;
}

function sensesText(monster) {
  const senses = (monster && monster.senses) || {};
  if (senses.notes) return String(senses.notes);
  return Object.entries(senses)
    .filter(([key, value]) => key !== 'passive_perception' && value != null && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
    .join(', ');
}

function normalizedDamageEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const dice = String(entry.damage_dice || entry.dice || '').trim();
  if (!dice) return null;
  const rawType = entry.damage_type || entry.type || {};
  const type = typeof rawType === 'string' ? rawType : (rawType.name || rawType.index || '');
  return { damage_dice: dice, damage_type: damageTypeReference(type) };
}

// Each top-level damage entry is simultaneous. A choice entry contributes one
// selected alternative, not every option, so versatile/element choices do not
// turn into several damage rolls when a template is cloned.
function actionDamageComponents(action) {
  const rawDamage = Array.isArray(action && action.damage) ? action.damage : [action && action.damage];
  const components = [];
  for (const entry of rawDamage) {
    const direct = normalizedDamageEntry(entry);
    if (direct) {
      components.push(direct);
      continue;
    }
    const options = entry && entry.from && Array.isArray(entry.from.options) ? entry.from.options : [];
    const selected = options.map(option => normalizedDamageEntry(option && option.item ? option.item : option)).find(Boolean);
    if (selected) components.push(selected);
  }
  return components;
}

function firstActionDamage(action, components = actionDamageComponents(action)) {
  const damage = components[0];
  if (!damage) {
    const match = String((action && action.desc) || '').match(/Hit:[\s\S]*?\((\d+\s*d\s*\d+(?:\s*[+-]\s*\d+)?)\)\s+([a-z]+)\s+damage/i);
    return match ? { dice: match[1], type: match[2] } : { dice: '', type: '' };
  }
  const damageType = damage.damage_type || damage.type || {};
  return {
    dice: damage.damage_dice || damage.dice || '',
    type: typeof damageType === 'string' ? damageType : (damageType.name || damageType.index || '')
  };
}

function actionRange(action) {
  if (action && Number.isFinite(Number(action.range_ft))) return Number(action.range_ft);
  const match = String((action && action.desc) || '').match(/(?:reach|range)\s+(\d+)\s*ft\.?/i);
  return match ? Number(match[1]) : 5;
}

function actionAttackType(action) {
  if (action && (action.attack_type === 'melee' || action.attack_type === 'ranged')) return action.attack_type;
  return /ranged/i.test(String((action && action.desc) || '')) ? 'ranged' : 'melee';
}

function addMonsterTraitRow(name = '', desc = '') {
  const div = document.createElement('div');
  div.className = 'monster-trait-row';
  div.innerHTML = `<input type="text" class="mt-name" placeholder="Trait name"/>
    <textarea class="mt-desc trait-desc" placeholder="Trait description"></textarea>
    <button class="btn btn-danger btn-sm trait-delete" type="button" aria-label="Remove trait">×</button>`;
  div.querySelector('.mt-name').value = name || '';
  div.querySelector('.mt-desc').value = Array.isArray(desc) ? desc.join(' ') : (desc || '');
  div.querySelector('.trait-delete').onclick = () => div.remove();
  $('m-traits').appendChild(div);
}

function addMonsterActionRow(action = {}) {
  const damageComponents = actionDamageComponents(action);
  const damage = firstActionDamage(action, damageComponents);
  const div = document.createElement('div');
  div.className = 'monster-action-row';
  div._extraDamage = cloneMonsterValue(damageComponents.slice(1));
  div._actionDC = cloneMonsterValue(action.dc || null);
  div.innerHTML = `<div class="monster-action-main">
      <div><label>Name</label><input type="text" class="ma-name" placeholder="e.g. Claw"/></div>
      <div><label>Attack bonus</label><input type="number" class="ma-attack" placeholder="optional" min="-10" max="30"/></div>
      <div><label>Damage dice</label><input type="text" class="ma-dice" placeholder="2d6+3"/></div>
      <div><label>Damage type</label><input type="text" class="ma-damage-type" placeholder="slashing"/></div>
    </div>
    <div class="monster-action-extra">
      <div><label>Attack type</label><select class="ma-type"><option value="melee">Melee</option><option value="ranged">Ranged</option></select></div>
      <div><label>Range / reach (ft)</label><input type="number" class="ma-range" value="5" min="5" max="600"/></div>
      <div><label>Description</label><textarea class="ma-desc" placeholder="What the action does"></textarea></div>
    </div>
    <button class="btn btn-danger btn-sm action-delete" type="button" aria-label="Remove action">×</button>`;
  div.querySelector('.ma-name').value = action.name || '';
  div.querySelector('.ma-attack').value = action.attack_bonus == null ? '' : action.attack_bonus;
  div.querySelector('.ma-dice').value = damage.dice;
  div.querySelector('.ma-damage-type').value = damage.type;
  div.querySelector('.ma-type').value = actionAttackType(action);
  div.querySelector('.ma-range').value = String(actionRange(action));
  div.querySelector('.ma-desc').value = Array.isArray(action.desc) ? action.desc.join(' ') : (action.desc || '');
  div.querySelector('.action-delete').onclick = () => div.remove();
  $('m-actions').appendChild(div);
}

function resetMonsterForm() {
  editingMonsterIndex = null;
  monsterFormExtras = emptyMonsterFormExtras();
  if ($('m-template')) $('m-template').value = '';
  $('monster-edit-badge').textContent = 'new';
  $('save-monster').textContent = 'Save monster';
  $('m-name').value = '';
  $('m-size').value = 'Medium';
  $('m-type').value = 'monstrosity';
  $('m-alignment').value = 'unaligned';
  $('m-cr').value = '1';
  $('m-color').value = '#ef4444';
  $('m-ac').value = '12';
  $('m-hp').value = '10';
  $('m-hit-dice').value = '2d8';
  $('m-speed').value = '30';
  $('m-passive').value = '10';
  $('m-vulnerabilities').value = '';
  $('m-resistances').value = '';
  $('m-immunities').value = '';
  $('m-senses').value = '';
  $('m-languages').value = '';
  document.querySelectorAll('.m-ab').forEach(input => { input.value = '10'; });
  document.querySelectorAll('.m-save').forEach(input => { input.value = ''; });
  $('m-traits').innerHTML = '';
  $('m-actions').innerHTML = '';
  addMonsterTraitRow();
  addMonsterActionRow();
}

function loadMonsterIntoForm(monster, asTemplate = false) {
  editingMonsterIndex = asTemplate ? null : monster.index;
  const rawSpeed = monster.speed && typeof monster.speed === 'object' && !Array.isArray(monster.speed)
    ? monster.speed : {};
  monsterFormExtras = {
    speed: cloneMonsterValue(Object.fromEntries(Object.entries(rawSpeed).filter(([kind]) => kind !== 'walk'))),
    proficiencies: cloneMonsterValue((monster.proficiencies || []).filter(item => {
      const index = item && item.proficiency && item.proficiency.index;
      return !String(index || '').startsWith('saving-throw-');
    })),
    condition_immunities: cloneMonsterValue(monster.condition_immunities || []),
    reactions: cloneMonsterValue(monster.reactions || []),
    legendary_actions: cloneMonsterValue(monster.legendary_actions || [])
  };
  $('monster-edit-badge').textContent = asTemplate ? 'new from SRD' : 'editing';
  $('save-monster').textContent = asTemplate ? 'Save monster' : 'Update monster';
  $('m-name').value = monster.name || '';
  $('m-size').value = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'].includes(monster.size) ? monster.size : 'Medium';
  $('m-type').value = monster.type || 'monstrosity';
  $('m-alignment').value = monster.alignment || 'unaligned';
  $('m-cr').value = challengeRatingLabel(monster.challenge_rating);
  $('m-color').value = /^#[0-9a-f]{6}$/i.test(monster.color || '') ? monster.color : '#ef4444';
  $('m-ac').value = String(armorClassValue(monster));
  $('m-hp').value = String(Number(monster.hit_points) || 1);
  $('m-hit-dice').value = monster.hit_dice || '1d8';
  $('m-speed').value = String(walkSpeedValue(monster));
  $('m-passive').value = String(Number(monster.senses && monster.senses.passive_perception) || 10);
  $('m-vulnerabilities').value = (monster.damage_vulnerabilities || []).join(', ');
  $('m-resistances').value = (monster.damage_resistances || []).join(', ');
  $('m-immunities').value = (monster.damage_immunities || []).join(', ');
  $('m-senses').value = sensesText(monster);
  $('m-languages').value = monster.languages || '';
  document.querySelectorAll('.m-ab').forEach(input => {
    input.value = String(Number(monster[ABILITY_FIELDS[input.dataset.a]]) || 10);
  });
  const saves = new Map((monster.proficiencies || [])
    .filter(item => item.proficiency && String(item.proficiency.index || '').startsWith('saving-throw-'))
    .map(item => [item.proficiency.index.slice('saving-throw-'.length), item.value]));
  document.querySelectorAll('.m-save').forEach(input => {
    input.value = saves.has(input.dataset.a) ? saves.get(input.dataset.a) : '';
  });
  $('m-traits').innerHTML = '';
  for (const trait of monster.special_abilities || []) addMonsterTraitRow(trait.name, trait.desc);
  if (!(monster.special_abilities || []).length) addMonsterTraitRow();
  $('m-actions').innerHTML = '';
  for (const action of monster.actions || []) addMonsterActionRow(action);
  if (!(monster.actions || []).length) addMonsterActionRow();
  $('monster-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function startApp() {
  try { SRD = await loadSRD(); }
  catch (e) { $('boot').textContent = 'Failed to load SRD: ' + e.message; return; }
  $('boot').classList.add('hidden'); $('app').classList.remove('hidden');
  // The rules builder reads the merged tables (SRD + everyone's homebrew), so
  // a homebrew class can be a subclass's parent or a template.
  SRD.setHomebrew(homebrew);
  buildForms();
  rulesBuilder = createRulesBuilder({
    root: $('rules-builder'), SRD,
    getSocket: () => socket,
    getHomebrew: () => homebrew,
    onNotify: (_state, type) => { pendingHomebrewTarget = type; }
  });
  renderList();
}

function populateMonsterTemplates() {
  const select = $('m-template');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = SRD_MONSTERS.length ? 'Choose a monster…' : 'SRD templates unavailable';
  select.replaceChildren(placeholder);
  SRD_MONSTERS.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).forEach((monster, position) => {
    const option = document.createElement('option');
    option.value = String(position);
    option.textContent = `${monster.name || 'Unnamed monster'} (CR ${challengeRatingLabel(monster.challenge_rating)})`;
    option._monster = monster;
    select.appendChild(option);
  });
}

async function ensureMonsterTemplates() {
  if (SRD_MONSTERS.length) return SRD_MONSTERS;
  if (srdMonsterLoadPromise) return srdMonsterLoadPromise;
  const select = $('m-template');
  select.replaceChildren(new Option('Loading SRD templates…', ''));
  srdMonsterLoadPromise = (typeof loadSRDMonsters === 'function' ? loadSRDMonsters() : Promise.resolve([]))
    .then(loaded => {
      SRD_MONSTERS = Array.isArray(loaded) ? loaded : ((loaded && loaded.monsters) || []);
      populateMonsterTemplates();
      return SRD_MONSTERS;
    })
    .catch(error => {
      console.warn('SRD monster templates are unavailable:', error);
      populateMonsterTemplates();
      msg('monster-msg', 'SRD monster templates could not be loaded', true);
      return [];
    });
  return srdMonsterLoadPromise;
}

function buildForms() {
  // Monster ability scores + optional saving throw bonuses
  $('m-abilities').innerHTML = ABILITIES.map(a => `<div><label>${a.toUpperCase()}</label><input type="number" class="m-ab" data-a="${a}" value="10" min="1" max="30"/></div>`).join('');
  $('m-saves').innerHTML = ABILITIES.map(a => `<div><label>${a.toUpperCase()}</label><input type="number" class="m-save" data-a="${a}" placeholder="—" min="-20" max="30"/></div>`).join('');
  $('add-monster-trait').onclick = () => addMonsterTraitRow();
  $('add-monster-action').onclick = () => addMonsterActionRow();
  $('reset-monster').onclick = resetMonsterForm;

  {
    const select = $('m-template');
    select.replaceChildren(new Option('Open to load SRD templates…', ''));
    $('m-template-row').classList.remove('hidden');
    select.addEventListener('focus', () => { void ensureMonsterTemplates(); });
    select.addEventListener('pointerdown', () => { void ensureMonsterTemplates(); });
    $('clone-srd-monster').onclick = async () => {
      await ensureMonsterTemplates();
      const option = select.selectedOptions[0];
      if (!option || !option._monster) return msg('monster-msg', 'Choose an SRD monster first', true);
      loadMonsterIntoForm(option._monster, true);
      msg('monster-msg', `Loaded ${option._monster.name} as a new monster`);
    };
  }
  resetMonsterForm();

}

// --- Save monster ---
$('save-monster').onclick = () => {
  if (!socket || !socket.connected || !username) return msg('monster-msg', 'Not connected', true);
  const name = $('m-name').value.trim();
  if (!name) return msg('monster-msg', 'Enter a name', true);
  const challenge_rating = challengeRatingValue($('m-cr').value);
  if (challenge_rating == null) return msg('monster-msg', 'Challenge rating must be between 0 and 30 (fractions such as 1/4 are allowed)', true);

  const savingThrowProficiencies = [...document.querySelectorAll('.m-save')]
    .filter(input => input.value.trim() !== '')
    .map(input => ({
      value: clampNumber(input.value, -20, 30, 0),
      proficiency: {
        index: `saving-throw-${input.dataset.a}`,
        name: `Saving Throw: ${input.dataset.a.toUpperCase()}`
      }
    }))
    .filter(item => Number.isFinite(item.value));
  const proficiencies = [
    ...cloneMonsterValue(monsterFormExtras.proficiencies),
    ...savingThrowProficiencies
  ];

  const special_abilities = [...document.querySelectorAll('#m-traits .monster-trait-row')]
    .map(row => ({
      name: row.querySelector('.mt-name').value.trim(),
      desc: row.querySelector('.mt-desc').value.trim()
    }))
    .filter(trait => trait.name);

  const actions = [...document.querySelectorAll('#m-actions .monster-action-row')]
    .map(row => {
      const actionName = row.querySelector('.ma-name').value.trim();
      const attackValue = row.querySelector('.ma-attack').value.trim();
      const damageDice = row.querySelector('.ma-dice').value.trim();
      const damageType = row.querySelector('.ma-damage-type').value.trim();
      const extraDamage = Array.isArray(row._extraDamage) ? cloneMonsterValue(row._extraDamage) : [];
      const action = {
        name: actionName,
        damage: [
          ...(damageDice ? [{ damage_dice: damageDice, damage_type: damageTypeReference(damageType) }] : []),
          ...extraDamage
        ],
        range_ft: clampNumber(row.querySelector('.ma-range').value, 5, 600, 5),
        attack_type: row.querySelector('.ma-type').value,
        desc: row.querySelector('.ma-desc').value.trim()
      };
      if (attackValue !== '' && Number.isFinite(Number(attackValue))) {
        action.attack_bonus = clampNumber(attackValue, -10, 30, 0);
      }
      if (row._actionDC) action.dc = cloneMonsterValue(row._actionDC);
      return action;
    })
    .filter(action => action.name);

  const data = {
    name,
    size: $('m-size').value,
    type: $('m-type').value.trim() || 'monstrosity',
    alignment: $('m-alignment').value.trim() || 'unaligned',
    armor_class: [{ type: 'natural', value: clampNumber(numberValue('m-ac', 10), 1, 30, 10) }],
    hit_points: clampNumber(numberValue('m-hp', 1), 1, 999, 1),
    hit_dice: $('m-hit-dice').value.trim() || '1d8',
    speed: {
      ...cloneMonsterValue(monsterFormExtras.speed),
      walk: `${clampNumber(numberValue('m-speed', 30), 0, 120, 30)} ft.`
    },
    challenge_rating,
    proficiencies,
    damage_vulnerabilities: commaList($('m-vulnerabilities').value),
    damage_resistances: commaList($('m-resistances').value),
    damage_immunities: commaList($('m-immunities').value),
    condition_immunities: cloneMonsterValue(monsterFormExtras.condition_immunities),
    senses: {
      notes: $('m-senses').value.trim(),
      passive_perception: Math.max(0, Math.trunc(numberValue('m-passive', 10)))
    },
    languages: $('m-languages').value.trim(),
    special_abilities,
    actions,
    reactions: cloneMonsterValue(monsterFormExtras.reactions),
    legendary_actions: cloneMonsterValue(monsterFormExtras.legendary_actions),
    color: $('m-color').value
  };
  document.querySelectorAll('.m-ab').forEach(input => {
    data[ABILITY_FIELDS[input.dataset.a]] = Math.max(1, Math.min(30, Math.trunc(Number(input.value) || 10)));
  });
  if (editingMonsterIndex) data.index = editingMonsterIndex;
  pendingHomebrewTarget = 'monster';
  socket.emit('save-homebrew', { type: 'monster', data });
};

function renderList() {
  const el = $('hb-list');
  const groups = [...RULE_TYPES.map(([type, label, collection]) => [type, label, homebrew[collection] || []]),
    ['monster', 'Monster', homebrew.monsters || []]];
  const total = groups.reduce((n, [, , list]) => n + list.length, 0);
  if (!total) { el.innerHTML = '<p style="color:var(--muted); font-size:13px;">None yet.</p>'; return; }
  el.innerHTML = groups.filter(([, , list]) => list.length).map(([type, label, list]) =>
    `<div class="hb-group">${esc(label)}${label.endsWith('s') ? 'es' : 's'}</div>` + list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(it => {
      const owned = it.owner === username || isHost;
      const parent = (it.race && it.race.name) || (it.class && it.class.name) || '';
      return `<div class="hb-item"><span><b>${esc(it.name)}</b>${parent ? ` <span class="pill">${esc(parent)}</span>` : ''}${it.owner && it.owner!==username ? ` <span class="pill">${esc(it.owner)}</span>` : ''}</span>${owned ? `<span><button class="edit" data-type="${esc(type)}" data-index="${esc(it.index)}">edit</button> <button class="del" data-type="${esc(type)}" data-index="${esc(it.index)}">delete</button></span>` : ''}</div>`;
    }).join('')
  ).join('');
  el.querySelectorAll('.del').forEach(b => b.onclick = () => {
    if (confirm('Delete this homebrew?')) {
      pendingHomebrewTarget = 'list';
      socket.emit('delete-homebrew', { type: b.dataset.type, index: b.dataset.index });
    }
  });
  el.querySelectorAll('.edit').forEach(b => b.onclick = () => {
    const group = groups.find(([type]) => type === b.dataset.type);
    const item = group && group[2].find(x => x.index === b.dataset.index);
    if (!item) return;
    if (b.dataset.type === 'monster') loadMonsterIntoForm(item);
    else if (rulesBuilder) rulesBuilder.edit(b.dataset.type, item);
  });
}

function msg(id, t, err = false) { const m = $(id); m.textContent = t; m.style.color = err ? '#f87171' : '#34d399'; setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 3000); }

// --- Login + socket ---
const login = setupLoginModal(() => {
  socket = io();
  login.attach(socket);
  socket.on('connect', () => socket.emit('login', login.payload()));
  socket.on('login-success', (d) => { username = d.username; isHost = !!d.isGM; startApp(); });
  socket.on('load-homebrew', (hb = {}) => {
    homebrew = { ...emptyHomebrew(), ...hb };
    if (SRD) SRD.setHomebrew(homebrew);
    renderList();
    if (pendingHomebrewTarget === 'list') {
      msg('homebrew-msg', 'Homebrew deleted');
      pendingHomebrewTarget = null;
    }
  });
  socket.on('homebrew-saved-success', (payload = {}) => {
    const name = payload.data && payload.data.name ? payload.data.name : 'homebrew';
    if (payload.type === 'monster') {
      msg('monster-msg', `Saved "${name}"`);
      resetMonsterForm();
    } else if (rulesBuilder) {
      rulesBuilder.saved(payload.type, name);
    }
    pendingHomebrewTarget = null;
  });
  socket.on('error', (error) => {
    const message = error && error.message ? error.message : String(error || 'Something went wrong');
    if (!username) { login.showError(message); login.reset(); return; }
    if (rulesBuilder && rulesBuilder.handles(pendingHomebrewTarget)) rulesBuilder.error(message);
    else msg(pendingHomebrewTarget === 'monster' ? 'monster-msg' : 'homebrew-msg', message, true);
    pendingHomebrewTarget = null;
  });
});
