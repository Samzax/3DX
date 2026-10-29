import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadSRD, ABILITIES, ABILITY_NAMES, STANDARD_ARRAY, POINT_BUY_COST, POINT_BUY_BUDGET,
  abilityMod, fmtMod, proficiencyBonus
} from '../shared/srd.js';
import { buildSheet, weaponProfile, meetsPrereq } from '../shared/rules.js';
import { parseAuroraCharacter, matchAurora } from '../shared/aurora.js';
import { setupLoginModal } from '../shared/login.js';
import { readCampaignId } from '../shared/campaigns.js';
import { spellDetailHTML } from '../shared/spellinfo.js';
import { createCharacterModel, disposeModel } from '../shared/models.js';
import {
  createRigCharacter, releaseRigCharacter, tickRigCharacters, loadCharacterLooks, characterLooks,
  configureCharacterRendering, loadCharacterKit, resolveCharacter, raceTraits, raceForm,
  BODY_TYPES, TRAITS, FORM_KEYS, WEAR_SLOTS, EYE_COLORS
} from '../shared/charmesh.js';

// The Studio keeps campaign context via ?campaign=<id> (workspace append);
// without it the login lands in the default campaign roster.
const campaignId = readCampaignId();
let activeCampaign = null;   // { id, name, ... } from campaign-joined

let SRD = null;
let KIT = null;              // the character kit (shared/mhbody.js): sliders, wearable assets, skins
let pendingHomebrew = null;
let socket = null;
let username = null;
let activeTab = 'identity';
const requestedCharacterId = new URLSearchParams(window.location.search).get('character');
let requestedCharacterLoaded = false;
const ALL_TABS = [
  ['identity','Identity'], ['class','Class'], ['background','Background'], ['features','Features'], ['abilities','Abilities'],
  ['skills','Skills'], ['spells','Spells'], ['equipment','Equipment'],
  ['appearance','Appearance'], ['review','Review']
];
function anyCaster() { return char.classes.some(c => SRD.isCaster(c.class)); }
function TABS() { return ALL_TABS.filter(t => t[0] !== 'spells' || anyCaster()); }
function normalizeTab() { if (activeTab === 'spells' && !anyCaster()) activeTab = 'class'; }

const DEFAULT_COLORS = { skin:'#d2a184', hair:'#3b2716', torso:'#2f6e56', legs:'#3a3f4a', eyes:'#1a1a1a' };
// Race coloring (the body itself comes from charmesh.js RACE_FORMS).
const RACE_COLORS = {
  dwarf:{ skin:'#cfa583', hair:'#6b4423' }, gnome:{ hair:'#b34d3a' }, elf:{ hair:'#d9c39a', skin:'#e2c1a8' },
  'half-orc':{ skin:'#7f9e6a', hair:'#1a1a1a' }, dragonborn:{ skin:'#9a5b3b' }, tiefling:{ skin:'#b0563f', hair:'#1a1a22' }
};
const raceColors = (race) => RACE_COLORS[race] || RACE_COLORS[Object.keys(RACE_COLORS).find(k => String(race).includes(k))] || {};
// What a class wears before the player dresses the character themselves.
const CLASS_WEAR = {
  wizard:{ outfit:'robe' }, sorcerer:{ outfit:'robe' }, warlock:{ outfit:'robe', head:'hood' }, cleric:{ outfit:'robe' },
  druid:{ outfit:'robe', head:'hood' }, monk:{ outfit:'robe' }, barbarian:{ top:'', bottom:'wool-pants', feet:'boots' },
  fighter:{ top:'tunic', bottom:'trousers', feet:'boots-tall' }, paladin:{ top:'tunic', bottom:'trousers', feet:'boots-tall' },
  ranger:{ top:'tunic', bottom:'wool-pants', feet:'boots', hands:'gloves' }, rogue:{ top:'shirt', bottom:'wool-pants', feet:'boots-ankle', hands:'gloves' },
  bard:{ top:'sweater', bottom:'harem-pants', feet:'boots-cuffed' }
};
const BASE_WEAR = { bodyform:'', headform:'', hair:'hair-short', beard:'', eyebrows:'brows-soft', horns:'', outfit:'', top:'tunic', bottom:'trousers', feet:'boots', hands:'', head:'' };
const TRAIT_LABELS = { 'pointed-ears':'Pointed ears', horns:'Horns', tail:'Tail' };
const SHOWN_TRAITS = TRAITS.filter(t => TRAIT_LABELS[t]); // tusks and snouts have no model yet
const SLOT_LABELS = { bodyform:'Body type', hair:'Hair', beard:'Beard', eyebrows:'Eyebrows', horns:'Horns', outfit:'Full outfit', top:'Top', bottom:'Legs', feet:'Feet', hands:'Hands', head:'Head' };
const FORM_LABELS = { age:['Age','young','old'], muscle:['Muscle','lean','powerful'], weight:['Weight','slight','heavy'], stature:['Stature','short','tall'] };
const DETAIL_GROUP_LABELS = { head:'Head shape', forehead:'Forehead', eyebrows:'Brow', eyes:'Eyes', nose:'Nose', mouth:'Mouth', cheek:'Cheeks', chin:'Chin & jaw', ears:'Ears', neck:'Neck', torso:'Torso', breast:'Chest', stomach:'Stomach', hip:'Hips', pelvis:'Pelvis', buttocks:'Seat', arms:'Arms', legs:'Legs', hands:'Hands', feet:'Feet' };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const sliderLabel = (id, group) => cap(id.replace(new RegExp('^' + group + '-'), '').replace(/^(l|r)-/, '').replace(/-/g, ' '));
// Random-look palettes (natural tones; fantasy races keep their own skin).
const SKIN_TONES = ['#f1d3bd', '#e4bc9f', '#d2a184', '#b98562', '#9a6a48', '#7a4f33', '#573623'];
const HAIR_TONES = ['#1a1a1a', '#3b2716', '#6b4423', '#a4532a', '#d9c39a', '#b34d3a', '#8a8a8a', '#e8e4dc'];
const CLOTH_TONES = ['#2f6e56', '#7a2e2e', '#2c4d7a', '#5b3a8c', '#b8862c', '#3d5a2a', '#6a6f7a', '#8a3b1e', '#1f5a66', '#4a2f4a'];
const LEG_TONES = ['#3a3f4a', '#4a3a2a', '#2a2f3a', '#5a4a3a', '#2f3a2f', '#3a2a2a'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function defaultChar() {
  return {
    id:null, name:'',
    race:'human', subrace:null, background:'acolyte', alignment:null,
    classes:[{ class:'fighter', subclass:null, level:1 }],
    abilityMethod:'point-buy',
    baseAbilities:{ str:8, dex:8, con:8, int:8, wis:8, cha:8 },
    racialChoice:[], racialSpread:null,
    skills:[],
    appearance:{ height:1, colors:{ ...DEFAULT_COLORS }, body:'male',
      form:{ age:0, muscle:0.5, weight:0.5, stature:0.5 }, details:{}, wear:{ ...BASE_WEAR },
      skin:'', eyeColor:'brown', traits:[], look:null },
    equipment:{ armor:null, shield:false, weapons:[], items:[] },
    spells:[],
    feats:[], expertise:[], languages:[], choices:{}, notes:'', xp:0,
    asi:{}, personality:{ traits:'', ideals:'', bonds:'', flaws:'', specialty:'' }
  };
}
let char = defaultChar();

/* ---------- Derived stats ---------- */
// One derivation for every screen (rules.js): race/class/background features,
// feats, item grants and pick-N choices all flow through buildSheet.
function derive() {
  const sheet = buildSheet({ ...char, abilities: char.baseAbilities }, SRD);
  return { ...sheet, hp: sheet.maxHP };
}
function grantedSkills() { return derive().granted; }

/* ---------- Rendering ---------- */
const $ = (id) => document.getElementById(id);
// Escape user/homebrew text before it goes into innerHTML (shared homebrew = stored-XSS surface).
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function renderTabs() {
  normalizeTab();
  $('tabs').innerHTML = TABS().map((t,i) =>
    `<div class="tab ${t[0]===activeTab?'active':''}" data-tab="${t[0]}"><span class="num">${i+1}</span>${t[1]}</div>`
  ).join('');
  $('tabs').querySelectorAll('.tab').forEach(el =>
    el.onclick = () => { activeTab = el.dataset.tab; renderTabs(); renderTab(); });
}

function opt(list, sel) {
  return list.map(o => `<option value="${esc(o.index)}" ${o.index===sel?'selected':''}>${esc(o.name)}</option>`).join('');
}

function renderTab() {
  normalizeTab();
  const b = $('tab-body');
  if (activeTab === 'identity') b.innerHTML = tabIdentity();
  else if (activeTab === 'class') b.innerHTML = tabClass();
  else if (activeTab === 'background') b.innerHTML = tabBackground();
  else if (activeTab === 'features') b.innerHTML = tabFeatures();
  else if (activeTab === 'abilities') b.innerHTML = tabAbilities();
  else if (activeTab === 'skills') b.innerHTML = tabSkills();
  else if (activeTab === 'spells') b.innerHTML = tabSpells();
  else if (activeTab === 'equipment') b.innerHTML = tabEquipment();
  else if (activeTab === 'appearance') b.innerHTML = tabAppearance();
  else if (activeTab === 'review') b.innerHTML = tabReview();
  wireTab();
}

function tabIdentity() {
  const race = SRD.get('races', char.race);
  const subraces = SRD.subracesForRace(char.race);
  const rb = SRD.racialAbilityBonuses(char.race, char.subrace);
  const bonusText = Object.entries(rb.fixed).map(([a,v]) => `${a.toUpperCase()} ${fmtMod(v)}`).join(', ') || '—';
  let racialChoiceUI = '';
  if (rb.spreads) {
    // Monsters-of-the-Multiverse boost: pick one spread, then one ability per
    // slot — slots must land on different scores, so used ones are disabled.
    const stored = typeof char.racialSpread === 'number' && rb.spreads[char.racialSpread] ? char.racialSpread : null;
    const legacy = rb.spreads.findIndex(sp => sp.bonuses.every(b => b === 1) && sp.bonuses.length === char.racialChoice.filter(Boolean).length);
    const shown = stored != null ? stored : (legacy >= 0 ? legacy : 0);
    const spread = rb.spreads[shown];
    const pick = slot => char.racialChoice[slot] || '';
    racialChoiceUI = `<div class="row"><label class="fld">Racial ability boost — spread</label>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">${rb.spreads.map((sp, i) =>
        `<label class="pill" style="cursor:pointer; padding:6px 10px;"><input type="radio" name="rspread" class="rsp" data-i="${i}" ${i===shown?'checked':''}/> ${esc(sp.bonuses.map(b=>'+'+b).join(' / '))}</label>`).join('')}</div></div>
    <div class="row"><label class="fld">Assign — each score at most once</label>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">${spread.bonuses.map((b, slot) =>
        `<label class="pill" style="padding:4px 8px 4px 10px;">+${b} <select class="rslot" data-slot="${slot}"><option value="">—</option>${ABILITIES.map(a =>
          `<option value="${a}" ${pick(slot)===a?'selected':''} ${pick(slot)!==a && char.racialChoice.includes(a)?'disabled':''}>${esc(ABILITY_NAMES[a])}</option>`).join('')}</select></label>`).join('')}</div></div>`;
  } else if (rb.options) {
    racialChoiceUI = `<div class="row"><label class="fld">Racial ability boost — choose ${rb.options.choose} (${'+1'} each)</label>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">${rb.options.from.map(a =>
        `<label class="pill" style="cursor:pointer; padding:6px 10px;"><input type="checkbox" class="rc" value="${esc(a)}" ${char.racialChoice.includes(a)?'checked':''}/> ${esc(a.toUpperCase())}</label>`).join('')}</div></div>`;
  }
  return `<h2>Identity</h2>
    <div class="row"><label class="fld">Character name</label><input type="text" id="f-name" value="${esc(char.name)}" placeholder="e.g. Thorin"/></div>
    <div class="grid2">
      <div class="row"><label class="fld">Race</label><select id="f-race">${opt(SRD.races, char.race)}</select></div>
      <div class="row"><label class="fld">Subrace</label><select id="f-subrace" ${subraces.length?'':'disabled'}>
        <option value="">${subraces.length?'— none —':'(no subraces)'}</option>${opt(subraces, char.subrace)}</select></div>
    </div>
    <div class="row"><label class="fld">Experience points</label><input type="number" id="f-xp" min="0" max="100000000" value="${Number.isFinite(char.xp)?char.xp:0}"/></div>
    ${racialChoiceUI}
    <div class="info"><strong>${esc(race?race.name:'')}</strong> — speed ${esc(race?race.speed:'?')} ft, size ${esc(race?race.size:'')}. Ability bonuses: ${esc(bonusText)}.
      <div style="margin-top:6px;">${race && race.traits ? race.traits.map(t=>esc(t.name)).join(' · ') : ''}</div></div>
    <p style="color:var(--muted); font-size:13px; margin-top:12px;">Background, alignment, personality, languages and backstory are on the Background tab.</p>
    ${stepNav()}`;
}

/* ---------- Background: where the character comes from and who they are ---------- */
// `specialty` holds picks from a background's own tables (a charlatan's scam).
const PERSONALITY_FIELDS = [['traits','Personality traits'], ['ideals','Ideals'], ['bonds','Bonds'], ['flaws','Flaws'], ['specialty','Background details']];
const PERSONALITY_MAX = 600;
// Background suggestion tables (SRD and imported backgrounds carry them; homebrew may not).
function personalityTable(key) {
  const bg = SRD.get('backgrounds', char.background);
  const table = bg && bg[key === 'traits' ? 'personality_traits' : key];
  const options = table && table.from && Array.isArray(table.from.options) ? table.from.options : [];
  return { choose: (table && table.choose) || 1, options: options.map(o => o.string || o.desc).filter(t => typeof t === 'string' && t) };
}
const personalityOptions = (key) => personalityTable(key).options;
const personalityLines = (key) => String(char.personality[key] || '').split('\n').map(l => l.trim()).filter(Boolean);
// Clicking a suggestion adds it as its own line; clicking it again takes it back out.
function togglePersonalityLine(key, text) {
  const lines = personalityLines(key);
  const next = lines.includes(text) ? lines.filter(l => l !== text) : [...lines, text];
  if (next.join('\n').length <= PERSONALITY_MAX) char.personality[key] = next.join('\n');
  else msg('That field is full — remove something first', true);
}
function suggestionList(key, options, textOf = (o) => o) {
  const lines = personalityLines(key);
  return `<div class="sugg-list">${options.map((o, i) =>
    `<button type="button" class="sugg ${lines.includes(textOf(o))?'on':''}" data-k="${esc(key)}" data-text="${esc(textOf(o))}"><span class="num">${i+1}</span>${esc(o)}</button>`).join('')}</div>`;
}
function personalityUI() {
  return PERSONALITY_FIELDS.slice(0, 4).map(([key, label]) => {
    const { choose, options } = personalityTable(key);
    return `<div class="row"><div class="pers-head"><label class="fld">${label}${options.length ? ` <span class="pill">pick ${choose} or write your own</span>` : ''}</label>
        ${options.length ? `<button class="btn btn-ghost btn-sm pers-roll" data-k="${key}" title="Roll one from the background's table">Roll</button>` : ''}</div>
      <textarea class="pers" data-k="${key}" rows="2" maxlength="${PERSONALITY_MAX}">${esc(char.personality[key]||'')}</textarea>
      ${options.length ? `<details class="sugg-box" data-k="${key}" ${openSuggestions.has(key)?'open':''}><summary>${options.length} suggestions from ${esc(SRD.get('backgrounds', char.background)?.name || 'the background')}</summary>${suggestionList(key, options)}</details>` : ''}</div>`;
  }).join('');
}
const openSuggestions = new Set(['traits']);
// Backgrounds grouped by the book they come from: the SRD's first, then imports
// and homebrew by source.
function backgroundPicker() {
  const groups = new Map();
  for (const b of SRD.backgrounds) {
    const label = b.custom ? (b.source || 'Homebrew') : 'SRD 5.1';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(b);
  }
  const rank = (label) => label === 'SRD 5.1' ? 0 : label === 'Homebrew' ? 2 : 1;
  const labels = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (labels.length === 1) return opt(groups.get(labels[0]), char.background);
  return labels.map(label => `<optgroup label="${esc(label)}">${opt(groups.get(label).slice().sort((a, b) => a.name.localeCompare(b.name)), char.background)}</optgroup>`).join('');
}
function tabBackground() {
  const d = derive();
  const bg = SRD.get('backgrounds', char.background) || {};
  const skills = SRD.backgroundSkillGrants(char.background).map(s => SRD.get('skills', s)?.name || s);
  const languages = (bg.languages || []).map(l => l.name || l.index).filter(Boolean);
  const languagePicks = bg.languageChoice || (bg.language_options && bg.language_options.choose) || 0;
  const kit = (bg.starting_equipment || []).map(e => SRD.get('equipment', e.equipment && e.equipment.index)).filter(Boolean);
  const gold = bg.starting_gold && bg.starting_gold.quantity;
  const equipmentText = bg.equipment || [...kit.map(i => i.name), ...(bg.starting_equipment_options || []).map(o => `${o.choose || 1} × ${o.from?.equipment_category?.name || 'an item of your choice'}`), gold ? `${gold} gp` : ''].filter(Boolean).join(', ');
  const fact = (label, value) => value ? `<div><strong>${label}:</strong> ${esc(value)}</div>` : '';
  const features = (bg.features || (bg.feature ? [bg.feature] : [])).filter(f => !f.choice);
  const choices = d.choices.filter(c => c.key.startsWith('background:'));
  const desc = Array.isArray(bg.desc) ? bg.desc.join('\n\n') : (bg.desc || '');
  const tables = Array.isArray(bg.tables) ? bg.tables : [];
  return `<h2>Background</h2>
    <div class="grid2">
      <div class="row"><label class="fld">Background</label><select id="f-bg">${backgroundPicker()}</select></div>
      <div class="row"><label class="fld">Alignment</label><select id="f-align"><option value="">— none —</option>${opt(SRD.alignments, char.alignment)}</select></div>
    </div>
    <div class="info" style="margin-bottom:14px;">
      <strong>${esc(bg.name || '')}</strong>${bg.custom ? ` <span class="pill">${esc(bg.source || 'homebrew')}</span>` : ''}
      ${desc ? `<details class="bg-desc"><summary>About this background</summary><div style="white-space:pre-wrap; margin-top:6px;">${esc(desc)}</div></details>` : ''}
      <div style="margin-top:8px; line-height:1.7;">
        ${fact('Skills', skills.join(', '))}${fact('Tools', (bg.tools || []).join(', '))}
        ${fact('Languages', [...languages, languagePicks ? `${languagePicks} of your choice` : ''].filter(Boolean).join(', '))}
        ${fact('Equipment', equipmentText)}
      </div>
      ${kit.length ? `<button class="btn btn-sm" id="bg-kit" style="margin-top:8px;" title="Adds ${esc(kit.map(i => i.name).join(', '))} to the Equipment tab">Pack the background's equipment</button>` : ''}
    </div>
    ${features.map(f => `<div class="info" style="margin-bottom:10px;"><strong>${esc(f.name)}</strong> <span class="pill">feature</span><div style="white-space:pre-wrap; margin-top:4px;">${esc(Array.isArray(f.desc) ? f.desc.join('\n\n') : (f.desc || ''))}</div></div>`).join('')}
    ${choices.map(choiceBlock).join('')}
    ${tables.map(t => `<div class="row"><label class="fld">${esc(t.name)} <span class="pill">optional</span></label>${suggestionList('specialty', t.options, (o) => `${t.name}: ${o}`.slice(0, 400))}</div>`).join('')}
    ${tables.length || char.personality.specialty ? `<div class="row"><label class="fld">Background details</label><textarea class="pers" data-k="specialty" rows="2" maxlength="${PERSONALITY_MAX}" placeholder="Specialty, origin, defining event…">${esc(char.personality.specialty||'')}</textarea></div>` : ''}
    <h3 class="ap-h">Personality</h3>
    ${personalityUI()}
    <h3 class="ap-h">Languages</h3>
    ${languagesUI()}
    <div class="row"><label class="fld">Notes &amp; backstory</label><textarea id="f-notes" rows="5" maxlength="8000" placeholder="Backstory, appearance, allies and enemies…">${esc(char.notes||'')}</textarea></div>
    ${stepNav()}`;
}

function languagesUI() {
  const d = derive();
  const fixed = d.languages.filter(l => !char.languages.includes(l));
  const options = SRD.languages.filter(l => !fixed.includes(l.name));
  const picks = char.languages.map((l,i) => `<span class="pill">${esc(l)} <button class="lang-rm" data-i="${i}" title="Remove" style="background:none;border:0;color:inherit;cursor:pointer;">✕</button></span>`).join(' ');
  return `<div class="row"><label class="fld">Languages${d.languageChoice ? ` — ${d.languageChoice} of your choice from the background and features` : ''}</label>
    <div class="info" style="margin-bottom:6px;">${fixed.length ? esc(fixed.join(', ')) : '—'} ${picks}</div>
    <div style="display:flex; gap:8px;"><select id="f-lang" style="flex:1;"><option value="">Add a language…</option>${options.map(l=>`<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</select>
      <input type="text" id="f-lang-custom" placeholder="or type one" style="flex:1;" maxlength="40"/><button class="btn btn-sm" id="add-lang">Add</button></div></div>`;
}

// Pick-N feature choices (dragon ancestry, fighting style, homebrew options),
// feats, and the full feature list with rules text.
function choiceBlock(c) {
  const left = c.choose - c.picked.length;
  return `<div class="info" style="margin-bottom:10px;"><b>${esc(c.name)}</b> <span class="pill">${esc(c.sourceLabel)}</span> — choose ${c.choose}${left>0?` <span class="red">(${left} left)</span>`:''}
    <div class="spell-grid" style="margin-top:6px;">${c.options.map(o => {
      const on = c.picked.includes(o.name);
      return `<label class="spell ${on?'on':''}" title="${esc(o.desc||'')}"><input type="checkbox" class="choice" data-key="${esc(c.key)}" data-max="${c.choose}" value="${esc(o.name)}" ${on?'checked':''} ${!on&&left<=0?'disabled':''}/> ${esc(o.name)}</label>`;
    }).join('')}</div></div>`;
}
function wireChoices(b) {
  b.querySelectorAll('.choice').forEach(cb => cb.onchange = () => {
    const key = cb.dataset.key, max = +cb.dataset.max || 1;
    const picked = [...b.querySelectorAll('.choice:checked')].filter(x => x.dataset.key === key).map(x => x.value);
    // A single-pick choice swaps instead of forcing an uncheck first.
    if (picked.length > max) char.choices[key] = max === 1 ? [cb.value] : picked.slice(0, max);
    else if (picked.length) char.choices[key] = picked;
    else delete char.choices[key];
    refresh();
  });
}
function tabFeatures() {
  const d = derive();
  const choiceHTML = d.choices.map(choiceBlock).join('') || '<p style="color:var(--muted); font-size:13px;">No choices to make for this build.</p>';
  const featHTML = SRD.feats.length ? SRD.feats.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(f => {
    const on = char.feats.includes(f.index);
    const req = meetsPrereq(f.prereq, d);
    const text = Array.isArray(f.desc) ? f.desc.join(' ') : (f.desc||'');
    return `<label class="feat" style="cursor:pointer;"><input type="checkbox" class="feat-pick" value="${esc(f.index)}" ${on?'checked':''}/>
      <div><b>${esc(f.name)}</b>${f.custom?' <span class="pill">homebrew</span>':''}${req.reason?` <span class="pill ${req.ok?'':'red'}">${esc(req.reason)}</span>`:''}
      <div style="color:var(--muted); margin-top:2px;">${esc(text.slice(0,220))}${text.length>220?'…':''}</div></div></label>`;
  }).join('') : '<p style="color:var(--muted); font-size:13px;">No feats available. Add some in the Homebrew builder.</p>';
  const allHTML = d.features.map(f =>
    `<details class="feat-detail"><summary><b>${esc(f.name)}</b> <span class="pill">${esc(f.sourceLabel||'')}</span>${f.classIdx?` <span class="pill">L${esc(f.level)}</span>`:''}${f.actions.length||f.rider||f.resource?' <span class="pill">combat</span>':''}</summary><div style="color:var(--muted); margin:4px 0 8px; white-space:pre-wrap;">${esc(f.desc||'No description.')}</div></details>`
  ).join('') || '<p style="color:var(--muted);">No features yet.</p>';
  return `<h2>Features</h2>
    <h3 style="font-size:14px; color:var(--muted); margin-bottom:8px;">Choices</h3>${choiceHTML}
    <h3 style="font-size:14px; color:var(--muted); margin:14px 0 8px;">Feats${featBudgetNote()}</h3>${featHTML}
    <h3 style="font-size:14px; color:var(--muted); margin:14px 0 8px;">Everything this character has</h3>${allHTML}
    ${stepNav()}`;
}

function featBudgetNote() {
  const { slots, feats, spent } = asiBudget();
  if (!slots && !feats) return '';
  const free = slots - feats - Math.ceil(spent / 2);
  return ` <span class="pill ${free<0?'red':''}">${feats} taken · ${Math.max(0, free)} improvement${free===1?'':'s'} free${free<0?' — over budget':''}</span>`;
}

function tabClass() {
  const total = SRD.totalLevel(char.classes);
  const rows = char.classes.map((c,i) => {
    const subs = SRD.subclassesForClass(c.class);
    const choiceLvl = SRD.subclassChoiceLevel(c.class);
    const canSub = c.level >= choiceLvl && subs.length;
    return `<div class="class-row" data-i="${i}">
      <select class="c-class">${opt(SRD.classes, c.class)}</select>
      <input type="number" class="c-level" value="${esc(c.level)}" min="1" max="20"/>
      <select class="c-sub" ${canSub?'':'disabled'}>
        <option value="">${canSub?'— subclass —':`subclass @ ${choiceLvl}`}</option>${opt(subs, c.subclass)}</select>
      <button class="btn btn-danger c-del" ${char.classes.length>1?'':'disabled'}>✕</button>
    </div>`;
  }).join('');
  const feats = SRD.classFeatures(char.classes);
  const featHTML = feats.length ? feats.map(f =>
    `<div class="feat"><span class="lvl">L${f.level}</span><div><b>${esc(f.name)}</b><div style="color:var(--muted); margin-top:2px;">${esc((f.desc||'').slice(0,160))}${(f.desc||'').length>160?'…':''}</div></div></div>`
  ).join('') : '<p style="color:var(--muted);">Pick a class to see features.</p>';
  return `<h2>Class <span style="float:right; font-size:13px; color:var(--muted); font-weight:400;">Total level ${total} · proficiency ${fmtMod(proficiencyBonus(total))}</span></h2>
    <div id="class-list">${rows}</div>
    <button class="btn btn-sm" id="add-class" ${char.classes.length<3?'':'disabled'} style="margin:6px 0 16px;">+ Add class (multiclass)</button>
    <h3 style="font-size:14px; color:var(--muted); margin-bottom:8px;">Features gained</h3>
    ${featHTML}
    ${stepNav()}`;
}

function tabAbilities() {
  const finals = derive().finals;
  const method = char.abilityMethod;
  let body = '';
  if (method === 'point-buy') {
    const used = ABILITIES.reduce((s,a)=> s + (POINT_BUY_COST[char.baseAbilities[a]] ?? 0), 0);
    body = `<div class="pool">Points remaining: <b>${POINT_BUY_BUDGET - used}</b> / ${POINT_BUY_BUDGET}</div>` +
      ABILITIES.map(a => abilityRow(a, finals[a], true)).join('');
  } else if (method === 'standard-array') {
    body = `<div class="pool">Assign ${STANDARD_ARRAY.join(', ')} — each once</div>` +
      ABILITIES.map(a => {
        const used = ABILITIES.filter(x=>x!==a).map(x=>char.baseAbilities[x]);
        const opts = STANDARD_ARRAY.map(v => `<option value="${v}" ${char.baseAbilities[a]===v?'selected':''} ${used.includes(v)&&char.baseAbilities[a]!==v?'disabled':''}>${v}</option>`).join('');
        return `<div class="ability-row"><label>${ABILITY_NAMES[a]}</label><span></span>
          <select class="sa" data-a="${a}" style="width:64px;">${opts}</select><span></span>
          <div class="final"><b>${finals[a]}</b> (${fmtMod(abilityMod(finals[a]))})</div></div>`;
      }).join('');
  } else {
    body = ABILITIES.map(a =>
      `<div class="ability-row"><label>${ABILITY_NAMES[a]}</label><span></span>
        <input type="number" class="man" data-a="${a}" min="1" max="30" value="${esc(char.baseAbilities[a])}" style="width:64px; text-align:center;"/><span></span>
        <div class="final"><b>${finals[a]}</b> (${fmtMod(abilityMod(finals[a]))})</div></div>`).join('');
  }
  return `<h2>Abilities</h2>
    <div class="seg">
      <button data-m="point-buy" class="${method==='point-buy'?'on':''}">Point buy</button>
      <button data-m="standard-array" class="${method==='standard-array'?'on':''}">Standard array</button>
      <button data-m="manual" class="${method==='manual'?'on':''}">Manual</button>
    </div>
    ${body}
    ${asiUI()}
    <div class="info" style="margin-top:12px;">Final scores include racial bonuses, improvements and feature grants. Base values shown are pre-racial.</div>
    ${stepNav()}`;
}
// Ability Score Improvements: each one a class grants is +2 points or a feat.
function asiBudget() {
  const slots = SRD.classFeatures(char.classes).filter(f => f.name === 'Ability Score Improvement').length;
  const spent = ABILITIES.reduce((n, a) => n + (char.asi[a] || 0), 0);
  const feats = char.feats.length;
  return { slots, spent, feats, points: Math.max(0, (slots - feats) * 2) };
}
function asiUI() {
  const { slots, spent, feats, points } = asiBudget();
  if (!slots && !spent) return '<div class="pool" style="margin-top:14px; font-size:13px;">Ability Score Improvements arrive with class levels (the first at level 4).</div>';
  const over = spent > points;
  return `<h3 style="font-size:14px; margin:16px 0 6px;">Improvements</h3>
    <div class="pool">Points spent: <b class="${over?'red':''}">${spent}</b> / ${points}
      <span style="font-size:13px;"> · ${slots} improvement${slots===1?'':'s'} earned${feats?`, ${feats} taken as feat${feats===1?'':'s'}`:''}${over?' — over budget':''}</span></div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">${ABILITIES.map(a => `<div class="asi-row" data-a="${a}" style="display:flex; align-items:center; gap:8px; font-size:13px;">
      <span style="width:34px; color:var(--muted);">${a.toUpperCase()}</span>
      <button class="stepper asi-dec" ${(char.asi[a]||0)<=0?'disabled':''}>−</button>
      <b style="min-width:22px; text-align:center;">+${char.asi[a]||0}</b>
      <button class="stepper asi-inc" ${spent>=points?'disabled':''}>+</button></div>`).join('')}</div>`;
}
function abilityRow(a, finalVal, buy) {
  const base = char.baseAbilities[a];
  return `<div class="ability-row" data-a="${a}">
    <label>${ABILITY_NAMES[a]}</label>
    <button class="stepper dec" ${base<=8?'disabled':''}>−</button>
    <div class="score">${esc(base)}</div>
    <button class="stepper inc" ${base>=15?'disabled':''}>+</button>
    <div class="final"><b>${finalVal}</b> (${fmtMod(abilityMod(finalVal))})</div></div>`;
}

function tabSkills() {
  const d = derive();
  const granted = d.granted;
  const classChoice = SRD.classSkillChoice(char.classes[0] && char.classes[0].class);
  // Features can add picks of their own (Skill Versatility, homebrew grants);
  // an empty pool means "any skill".
  const extra = d.grants.skillChoices;
  const anySkill = extra.some(x => !x.from || !x.from.length);
  const allowed = new Set([...(classChoice ? classChoice.options : []), ...extra.flatMap(x => x.from || [])]);
  const inPoolOf = (s) => anySkill || allowed.has(s);
  const budget = (classChoice ? classChoice.choose : 0) + extra.reduce((n, x) => n + x.choose, 0);
  const chosenInPool = char.skills.filter(s => inPoolOf(s) && !granted.has(s)).length;
  const remaining = budget - chosenInPool;
  const expertiseLeft = d.grants.expertiseChoice - char.expertise.filter(s => d.proficient.has(s)).length;
  const items = SRD.skills.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(sk => {
    const ab = sk.ability_score.index;
    const isGranted = granted.has(sk.index);
    const inPool = inPoolOf(sk.index);
    const checked = isGranted || char.skills.includes(sk.index);
    const disabled = isGranted || (!inPool && !checked) || (!checked && remaining<=0);
    const isExpert = d.expertise.has(sk.index);
    const expertBox = d.grants.expertiseChoice && checked
      ? `<label class="pill" style="cursor:pointer;" title="Expertise: double proficiency"><input type="checkbox" class="sk-exp" value="${sk.index}" ${char.expertise.includes(sk.index)?'checked':''} ${!char.expertise.includes(sk.index)&&expertiseLeft<=0?'disabled':''}/> expertise</label>` : (isExpert?'<span class="pill">expertise</span>':'');
    return `<div class="skill-item ${isGranted?'locked':''}">
      <input type="checkbox" class="sk" value="${sk.index}" ${checked?'checked':''} ${disabled?'disabled':''}/>
      <span>${sk.name}</span>
      ${isGranted?'<span class="pill">granted</span>':(inPool?'':'<span class="pill">n/a</span>')}
      ${expertBox}
      <span class="sk-ability">${ab} ${fmtMod(d.skillBonus(sk.index, ab))}</span></div>`;
  }).join('');
  return `<h2>Skills</h2>
    <div class="pool">${budget ? `Choose <b>${remaining}</b> more` : 'This build grants no skill choices.'}${d.grants.expertiseChoice ? ` · Expertise: <b>${Math.max(0, expertiseLeft)}</b> left` : ''}</div>
    <div>${items}</div>
    <div class="info" style="margin-top:12px;">“granted” skills come from your race, background or features. “n/a” aren’t on your class list.</div>
    ${stepNav()}`;
}

function tabAppearance() {
  const ap = char.appearance, c = ap.colors;
  const range = (cls, key, label, min, max, value, hint = '') => `<div class="slider-row"><span title="${esc(hint)}">${esc(label)}</span>
    <input type="range" class="${cls}" data-k="${esc(key)}" min="${min}" max="${max}" step="0.05" value="${value}"/>
    <span>${Number(value).toFixed(2)}</span></div>`;
  const color = (key,label) => `<label>${label}<input type="color" class="ap-c" data-k="${key}" value="${esc(c[key])}"/></label>`;
  const seg = (key, values, label = cap) => `<div class="seg ap-seg" data-k="${key}">${values.map(v =>
    `<button data-v="${esc(v)}" class="${ap[key]===v?'on':''}">${esc(label(v))}</button>`).join('')}</div>`;
  const slotSelect = (slot) => {
    const options = Object.entries(KIT.assets).filter(([, a]) => a.slot === slot);
    return `<div class="row"><label class="fld">${SLOT_LABELS[slot]}</label><select class="ap-wear" data-slot="${slot}">
      <option value="">— none —</option>${options.map(([id, a]) => `<option value="${esc(id)}" ${ap.wear[slot]===id?'selected':''}>${esc(a.label)}</option>`).join('')}</select></div>`;
  };
  // Looks from installed model packs. One made for particular races is only offered to them
  // (and stays listed while it is the sheet's choice); the rest are for everyone.
  const looks = Object.values(characterLooks())
    .filter(l => !Array.isArray(l.races) || lookFits(l) || l.id === ap.look)
    .sort((x, y) => (lookFits(y) - lookFits(x)) || x.name.localeCompare(y.name));
  const card = (id, name, sub, thumb) => `<button class="look-card ${(ap.look||'')===id?'on':''}" data-look="${esc(id)}">
    ${thumb ? `<img src="${esc(thumb)}" alt=""/>` : `<span class="look-glyph">${id ? '◆' : '☻'}</span>`}
    <b>${esc(name)}</b><span>${esc(sub)}</span></button>`;
  const gallery = looks.length ? `<label class="fld">Model</label><div class="look-grid">${card('', 'Custom body', 'shape, face, wardrobe')}${looks.map(l =>
    card(l.id, l.name, lookFits(l) ? 'made for this race' : l.pack, l.thumb)).join('')}</div>` : '';
  const missing = ap.look && !characterLooks()[ap.look];
  const usingLook = ap.look && !missing;

  const groups = {};
  for (const [id, slider] of Object.entries(KIT.sliders)) (groups[slider.group] || (groups[slider.group] = [])).push(id);
  const detailHTML = Object.keys(DETAIL_GROUP_LABELS).filter(g => groups[g]).map(g => {
    const touched = groups[g].filter(id => ap.details[id]).length;
    return `<details class="ap-group" data-g="${g}" ${openDetailGroups.has(g)?'open':''}><summary>${DETAIL_GROUP_LABELS[g]}${touched?` <span class="pill">${touched} set</span>`:''}</summary>
      ${groups[g].map(id => { const s = KIT.sliders[id]; return range('ap-d', id, sliderLabel(id, g), s.neg.length ? -1 : 0, 1, ap.details[id] || 0); }).join('')}</details>`;
  }).join('');
  const skinOptions = Object.entries(KIT.skins).filter(([, k]) => k.tags.includes('fantasy') || k.tags.includes(ap.body));
  // A body form (a whole sculpted body, e.g. a dragonborn type) replaces the human face and
  // skin: what stays editable is its build, its color, and the clothes over it.
  const form = ap.wear.bodyform && KIT.assets[ap.wear.bodyform];
  const forms = Object.entries(KIT.assets).filter(([, a]) => a.slot === 'bodyform');
  const formPicker = forms.length ? `<div class="row"><label class="fld">Body type</label><select class="ap-wear" data-slot="bodyform">
      <option value="">Humanoid (shape it below)</option>${forms.map(([id, a]) =>
        `<option value="${esc(id)}" ${ap.wear.bodyform===id?'selected':''}>${esc(a.label)}</option>`).join('')}</select></div>` : '';
  const kin = (id) => id.split('-')[0] === ap.wear.bodyform.split('-')[0];   // dragonborn types blend with each other, not with a tabaxi
  const others = form ? forms.filter(([id]) => id !== ap.wear.bodyform && kin(id)) : [];
  const blendHTML = others.length ? `<h3 class="ap-h">Build blend</h3>
    <div class="info" style="margin-bottom:10px;">Keeps this type's head and hide, and leans its proportions toward another type's.</div>
    ${others.map(([id, a]) => range('ap-blend', a.target, 'Toward ' + a.label.replace(/^.*,\s*/, ''), 0, 1, ap.details[a.target] || 0)).join('')}` : '';
  const formBody = form ? `
    <h3 class="ap-h">Body</h3>
    ${formPicker}
    ${['muscle', 'weight', 'stature'].map(k => range('ap-f', k, FORM_LABELS[k][0], 0, 1, ap.form[k], FORM_LABELS[k][1] + ' → ' + FORM_LABELS[k][2])).join('')}
    ${blendHTML}
    <h3 class="ap-h">Wardrobe</h3>
    ${armorNote()}
    <div class="grid2">${slotSelect('outfit')}${slotSelect('top')}${slotSelect('bottom')}</div>
    ${ap.wear.outfit ? '<div class="info" style="margin-bottom:12px;">A full outfit replaces the top and legs pieces.</div>' : ''}
    <div class="color-row" style="margin-top:12px;">
      ${color('skin','Scale color')} ${color('torso','Outfit dye')} ${color('legs','Legs dye')}
    </div>
    <div class="info" style="margin-top:12px;">The weapon and shield in hand come from the Equipment tab. Boots, gloves and helms are not cut for this body yet.</div>` : '';
  const custom = form ? formBody : `
    <h3 class="ap-h">Body</h3>
    ${formPicker}
    <div class="row">${seg('body', BODY_TYPES)}</div>
    ${FORM_KEYS.map(k => range('ap-f', k, FORM_LABELS[k][0], 0, 1, ap.form[k], FORM_LABELS[k][1] + ' → ' + FORM_LABELS[k][2])).join('')}
    <h3 class="ap-h">Face &amp; proportions <button class="btn btn-ghost btn-sm" id="ap-details-reset" style="float:right;">Reset to ${esc(SRD.get('races',char.race)?.name||'race')}</button></h3>
    ${detailHTML}
    <h3 class="ap-h">Skin &amp; eyes</h3>
    <div class="grid2">
      <div class="row"><label class="fld">Skin</label><select id="ap-skin"><option value="">Natural</option>${skinOptions.map(([id, k]) =>
        `<option value="${esc(id)}" ${ap.skin===id?'selected':''}>${esc(k.label)}</option>`).join('')}</select></div>
      <div class="row"><label class="fld">Eyes</label><select id="ap-eyes">${EYE_COLORS.map(e =>
        `<option value="${e}" ${ap.eyeColor===e?'selected':''}>${esc(cap(e.replace('light', ' light').replace('deep', 'deep ').replace('green', ' green').trim()))}</option>`).join('')}</select></div>
    </div>
    <h3 class="ap-h">Hair</h3>
    <div class="grid2">${slotSelect('hair')}${slotSelect('beard')}${slotSelect('eyebrows')}${slotSelect('horns')}</div>
    <h3 class="ap-h">Wardrobe</h3>
    ${armorNote()}
    <div class="grid2">${slotSelect('outfit')}${slotSelect('head')}${slotSelect('top')}${slotSelect('bottom')}${slotSelect('feet')}${slotSelect('hands')}</div>
    ${ap.wear.outfit ? '<div class="info" style="margin-bottom:12px;">A full outfit replaces the top and legs pieces.</div>' : ''}
    <div class="row"><label class="fld">Features</label><div style="display:flex; flex-wrap:wrap; gap:8px;">${SHOWN_TRAITS.map(t =>
      `<label class="pill" style="cursor:pointer; padding:6px 10px;"><input type="checkbox" class="ap-trait" value="${t}" ${ap.traits.includes(t)?'checked':''}/> ${esc(TRAIT_LABELS[t])}</label>`).join('')}</div></div>
    <div class="color-row" style="margin-top:12px;">
      ${color('skin','Skin tone')} ${color('hair','Hair')} ${color('torso','Outfit dye')} ${color('legs','Legs dye')}
    </div>
    <div class="info" style="margin-top:12px;">The weapon and shield in hand come from the Equipment tab.</div>`;
  return `<h2>Appearance</h2>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button class="btn btn-sm" id="apply-preset">Reset to ${esc(SRD.get('races',char.race)?.name||'')} defaults</button>
      <button class="btn btn-sm" id="ap-random" title="Roll a new look for this race">Randomize</button>
    </div>
    ${gallery}
    ${missing ? `<div class="info" style="margin-bottom:12px;">This character uses the look <b>${esc(ap.look)}</b>, which is not installed on this server. The custom body below stands in until the pack is added.</div>` : ''}
    ${range('ap-s', 'height', 'Size', 0.6, 1.4, ap.height, 'overall scale')}
    ${usingLook ? '<div class="info">This model comes dressed and finished; only its size can be adjusted.</div>' : custom}
    ${stepNav()}`;
}
const openDetailGroups = new Set();
// Equipped armour is worn over the wardrobe unless the player switches that off.
function armorNote() {
  const armor = char.equipment.armor && SRD.get('equipment', char.equipment.armor);
  return `<label class="info" style="display:flex; gap:8px; align-items:center; margin-bottom:12px; cursor:pointer;">
    <input type="checkbox" id="ap-showarmor" ${char.appearance.showArmor === false ? '' : 'checked'}/>
    <span>Wear the equipped armour${armor ? ` (<b>${esc(armor.name)}</b>)` : ' — none equipped yet (Equipment tab)'}. It replaces the outfit, gloves and boots below; a matching helm is under Head.</span></label>`;
}
function lookFits(look) {
  if (!Array.isArray(look.races)) return 0;
  // A pack names races the way the SRD does ("elf"); a homebrew race is matched by its name.
  const race = SRD.get('races', char.race);
  const named = race && String(race.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [char.race, char.subrace, named].some(key => key && look.races.includes(key)) ? 1 : 0;
}
function randomizeLook() {
  const ap = char.appearance, race = raceForm(char.race);
  if (ap.wear.bodyform) {   // a sculpted body: roll the type, build and colors only
    const forms = Object.entries(KIT.assets).filter(([id, a]) => a.slot === 'bodyform' && id.split('-')[0] === ap.wear.bodyform.split('-')[0]).map(([id]) => id);
    const r = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 20) / 20;
    ap.wear.bodyform = pick(forms);
    ap.form = { age: 0, muscle: r(0.3, 0.7), weight: r(0.35, 0.65), stature: r(0.4, 0.65) };
    ap.details = {};
    ap.colors.skin = pick(['#9a5b3b', '#a8322a', '#2f5fa8', '#3f8a4a', '#d9d9e0', '#2a2a30', '#b8862c', '#7a5a2a', '#8a8f9a', '#e8e4dc']);
    ap.colors.torso = pick(CLOTH_TONES); ap.colors.legs = pick(LEG_TONES);
    return;
  }
  const around = (base, spread) => Math.round(Math.max(0, Math.min(1, base + (Math.random() * 2 - 1) * spread)) * 20) / 20;
  const ofSlot = (slot) => Object.entries(KIT.assets).filter(([, a]) => a.slot === slot).map(([id]) => id);
  ap.body = pick(BODY_TYPES);
  ap.form = { age: Math.random() < 0.2 ? around(0.8, 0.2) : around(0.1, 0.1), muscle: around(race.muscle ?? 0.5, 0.2),
    weight: around(race.weight ?? 0.5, 0.2), stature: around(race.stature ?? 0.5, 0.12) };
  ap.details = { ...(race.details || {}) };
  for (const id of ['head-oval', 'head-round', 'head-square', 'nose-scale-horiz', 'nose-scale-vert', 'nose-hump', 'chin-width', 'chin-prominent', 'cheek-bones', 'mouth-scale-horiz', 'torso-vshape', 'hip-waist']) {
    if (KIT.sliders[id] && Math.random() < 0.6) ap.details[id] = Math.round((Math.random() * 1.4 - (KIT.sliders[id].neg.length ? 0.7 : 0)) * 20) / 20;
  }
  ap.wear.hair = Math.random() < 0.08 ? '' : pick(ofSlot('hair'));
  ap.wear.beard = ap.body === 'male' && (char.race.includes('dwarf') || Math.random() < 0.4) ? pick(ofSlot('beard')) : '';
  ap.wear.eyebrows = pick(ofSlot('eyebrows'));
  ap.eyeColor = pick(EYE_COLORS);
  ap.colors.hair = pick(HAIR_TONES);
  ap.colors.torso = pick(CLOTH_TONES);
  ap.colors.legs = pick(LEG_TONES);
  if (!raceColors(char.race).skin) ap.colors.skin = pick(SKIN_TONES);
}
// A race brings its body (stature, mass, face, ears, horns, tail) and coloring;
// homebrew races start as an average human the player shapes.
function applyRaceLook(raceIdx, includeColors = true) {
  const ap = char.appearance, race = raceForm(raceIdx);
  ap.form = { age: 0, muscle: race.muscle ?? 0.5, weight: race.weight ?? 0.5, stature: race.stature ?? 0.5 };
  ap.details = { ...(race.details || {}) };
  ap.height = race.size ?? 1;
  ap.traits = raceTraits(raceIdx);
  ap.wear.horns = ap.traits.includes('horns') ? 'horns-curled' : '';
  ap.wear.bodyform = ap.traits.includes('snout') && KIT.assets['dragonborn-a'] ? 'dragonborn-a'
    : /tabaxi|catfolk|leonin/.test(String(raceIdx)) && KIT.assets['tabaxi-cheetah'] ? 'tabaxi-cheetah' : '';
  if (ap.wear.bodyform) ap.details = {};
  ap.wear.beard = String(raceIdx).includes('dwarf') && ap.body !== 'female' ? 'beard-viking' : '';
  if (includeColors) Object.assign(ap.colors, { skin: DEFAULT_COLORS.skin, hair: DEFAULT_COLORS.hair }, raceColors(raceIdx));
}
// Follow the class's usual dress until the player dresses the character themselves.
const wardrobeOf = (classIdx) => ({ outfit:'', top:BASE_WEAR.top, bottom:BASE_WEAR.bottom, feet:BASE_WEAR.feet, hands:'', head:'', ...(CLASS_WEAR[classIdx] || {}) });
function followClassOutfit(previousClass) {
  const ap = char.appearance, was = wardrobeOf(previousClass);
  if (previousClass && Object.keys(was).some(slot => (ap.wear[slot] || '') !== was[slot])) return; // hand-picked: leave it
  Object.assign(ap.wear, wardrobeOf(char.classes[0].class));
}

// Starting equipment: the fixed items plus option (a) of every choice, for the
// first class and the background. "Any martial weapon"-style picks take a
// sensible default the player can swap.
const KIT_CATEGORY_DEFAULTS = {
  'martial-weapons':'longsword', 'martial-melee-weapons':'longsword', 'simple-weapons':'mace', 'simple-melee-weapons':'mace',
  'holy-symbols':'amulet', 'arcane-foci':'wand', 'druidic-foci':'wooden-staff', 'musical-instruments':'lute'
};
function kitOption(option, out) {
  if (!option || typeof option !== 'object') return;
  if (option.option_type === 'counted_reference' && option.of) out.push(option.of.index);
  else if (option.option_type === 'multiple') (option.items || []).forEach(item => kitOption(item, out));
  else if (option.option_type === 'choice' && option.choice) kitChoice(option.choice, out);
}
function kitChoice(choice, out) {
  const from = choice && choice.from;
  if (!from) return;
  if (from.option_set_type === 'options_array') kitOption((from.options || [])[0], out);
  else if (from.option_set_type === 'equipment_category' && from.equipment_category) {
    const fallback = KIT_CATEGORY_DEFAULTS[from.equipment_category.index];
    for (let i = 0; fallback && i < (choice.choose || 1); i++) out.push(fallback);
  }
}
function takeStartingKit(sources = [SRD.get('classes', char.classes[0].class), SRD.get('backgrounds', char.background)]) {
  const picked = [];
  for (const source of sources) {
    if (!source) continue;
    (source.starting_equipment || []).forEach(entry => entry && entry.equipment && picked.push(entry.equipment.index));
    (source.starting_equipment_options || []).forEach(choice => kitChoice(choice, picked));
  }
  const eq = char.equipment;
  let added = 0;
  for (const index of picked) {
    const item = SRD.get('equipment', index);
    if (!item) continue;
    const category = item.equipment_category && item.equipment_category.index;
    if (category === 'armor') {
      if (item.armor_category === 'Shield') { if (!eq.shield) { eq.shield = true; added++; } }
      else if (!eq.armor) { eq.armor = index; added++; }
    } else if (category === 'weapon') {
      if (eq.weapons.filter(w => w === index).length < picked.filter(x => x === index).length && eq.weapons.length < 12) { eq.weapons.push(index); added++; }
    } else if (!eq.items.includes(index)) { eq.items.push(index); added++; }
  }
  return added;
}

function tabEquipment() {
  const eq = char.equipment;
  const d = derive();
  const armorOpts = '<option value="">— no armor —</option>' +
    ['Light','Medium','Heavy'].map(cat => {
      const items = SRD.armorList().filter(a=>a.armor_category===cat);
      return `<optgroup label="${cat}">` + items.map(a=>`<option value="${a.index}" ${eq.armor===a.index?'selected':''}>${a.name} (AC ${a.armor_class.base}${a.armor_class.dex_bonus?'+Dex':''})</option>`).join('') + `</optgroup>`;
    }).join('');
  const weaponOpts = SRD.weaponList().map(w=>`<option value="${w.index}">${w.name} — ${w.damage?w.damage.damage_dice:''} ${w.damage&&w.damage.damage_type?w.damage.damage_type.name:''}${w.weapon_range==='Ranged'?' (ranged)':''}</option>`).join('');
  const gearOpts = SRD.gearList().map(g=>`<option value="${g.index}">${g.name}</option>`).join('');
  const wRows = eq.weapons.map((wi,i)=>{ const w=SRD.get('equipment',wi); const a=w?weaponProfile(w,d,SRD,char.classes):{attack:0,damage:'',damageType:'',ranged:false,rangeFt:5}; return `<div class="inv-row"><span>${esc(w?w.name:wi)} <span class="pill">${a.ranged?'ranged '+a.rangeFt+' ft':'melee'}</span></span><span class="pill">${fmtMod(a.attack)} · ${esc(a.damage)} ${esc(a.damageType)}</span><button class="btn-danger btn-sm rm-w" data-i="${i}">✕</button></div>`; }).join('') || '<p style="color:var(--muted); font-size:13px;">No weapons.</p>';
  const iRows = eq.items.map((gi,i)=>{ const g=SRD.get('equipment',gi); return `<div class="inv-row"><span>${esc(g?g.name:gi)}</span><button class="btn-danger btn-sm rm-i" data-i="${i}">✕</button></div>`; }).join('') || '<p style="color:var(--muted); font-size:13px;">No gear.</p>';
  const kitNames = [SRD.get('classes', char.classes[0].class)?.name, SRD.get('backgrounds', char.background)?.name].filter(Boolean).join(' + ');
  return `<h2>Equipment <span style="float:right; font-size:13px; color:var(--muted); font-weight:400;">AC ${d.ac} · ${d.acSource}</span></h2>
    <button class="btn btn-sm" id="starting-kit" style="margin-bottom:14px;" title="Adds the class and background starting equipment (the first option of each choice); change anything afterwards">Take starting kit — ${esc(kitNames)}</button>
    <div class="grid2">
      <div class="row"><label class="fld">Armor</label><select id="eq-armor">${armorOpts}</select></div>
      <div class="row"><label class="fld">Shield</label><label style="display:flex; align-items:center; gap:8px; padding:9px 0;"><input type="checkbox" id="eq-shield" ${eq.shield?'checked':''}/> Equipped (+2 AC)</label></div>
    </div>
    <h3 style="font-size:14px; margin:10px 0 6px;">Weapons</h3>
    <div style="display:flex; gap:8px; margin-bottom:8px;"><select id="eq-weapon" style="flex:1;">${weaponOpts}</select><button class="btn btn-sm" id="add-weapon">Add</button></div>
    <div id="weapon-list">${wRows}</div>
    <h3 style="font-size:14px; margin:14px 0 6px;">Gear</h3>
    <div style="display:flex; gap:8px; margin-bottom:8px;"><select id="eq-gear" style="flex:1;">${gearOpts}</select><button class="btn btn-sm" id="add-gear">Add</button></div>
    <div id="gear-list">${iRows}</div>
    ${stepNav()}`;
}

function spellGuideHTML(classIdx, level, mods, casters) {
  const ci = casters.find(x=>x.class===classIdx) || {};
  const levelOf = {}; SRD.spellsForClass(classIdx).forEach(s => levelOf[s.index] = s.level);
  const chosen = char.spells.filter(x => levelOf[x] != null);
  const cc = chosen.filter(x => levelOf[x] === 0).length;
  const cs = chosen.filter(x => levelOf[x] > 0).length;
  const lim = SRD.spellLimits(classIdx, level, ci.ability ? (mods[ci.ability]||0) : 0);
  const cap = (n, max) => `<b class="${(max!=null && n>max)?'red':''}">${n}</b>/${max!=null?max:'—'}`;
  return `Cantrips ${cap(cc, lim.cantrips)} · ${lim.prepared?'Prepared':'Spells'} ${cap(cs, lim.known)}`;
}
function updateSpellGuides() {
  const d = derive();
  document.querySelectorAll('.caster-block').forEach(block => {
    const cls = block.dataset.class, lvl = +block.dataset.level, g = block.querySelector('.spell-guide');
    if (g && cls) g.innerHTML = spellGuideHTML(cls, lvl, d.mods, d.spellInfo.casters);
  });
}

function tabSpells() {
  const d = derive();
  const casters = char.classes.filter(c=>SRD.isCaster(c.class));
  if (!casters.length) return `<h2>Spells</h2><p style="color:var(--muted)">No spellcasting classes.</p>${stepNav()}`;
  const si = d.spellInfo;
  const slotLine = Object.entries(si.slots).filter(([l,n])=>n>0).map(([l,n])=>`L${l}×${n}`).join('  ·  ');
  const pactLine = si.pact ? `Pact magic: ${si.pact.count} × L${si.pact.level}` : '';
  const maxLvl = Math.max(0, ...Object.entries(si.slots).filter(([l,n])=>n>0).map(([l])=>+l), si.pact?si.pact.level:0);
  const blocks = casters.map(c => {
    const cl = SRD.get('classes', c.class);
    const ci = si.casters.find(x=>x.class===c.class) || {};
    const spellsOfClass = SRD.spellsForClass(c.class);
    const guide = `<div class="info spell-guide" style="margin:4px 0 8px; padding:8px 10px;">${spellGuideHTML(c.class, c.level, d.mods, si.casters)}</div>`;
    const byLevel = {};
    spellsOfClass.forEach(s => { if (s.level<=maxLvl) (byLevel[s.level]=byLevel[s.level]||[]).push(s); });
    const sections = Object.keys(byLevel).map(Number).sort((a,b)=>a-b).map(lv => {
      const label = lv===0?'Cantrips':`Level ${lv}`;
      const items = byLevel[lv].map(s=>`<label class="spell ${char.spells.includes(s.index)?'on':''}"><input type="checkbox" class="sp" value="${esc(s.index)}" ${char.spells.includes(s.index)?'checked':''}/> <span class="sp-name">${esc(s.name)}${s.concentration?' <span class="pill">C</span>':''}${s.ritual?' <span class="pill">R</span>':''}</span><button type="button" class="sp-info" data-spell="${esc(s.index)}" title="Read ${esc(s.name)}" aria-label="Read ${esc(s.name)}">i</button></label>`).join('');
      return `<details ${lv<=1?'open':''}><summary>${label} <span style="color:var(--muted)">(${byLevel[lv].length})</span></summary><div class="spell-grid">${items}</div><div class="spell-reader" hidden></div></details>`;
    }).join('') || '<p style="color:var(--muted); font-size:13px;">No spells available at this level yet.</p>';
    return `<div class="caster-block" data-class="${esc(c.class)}" data-level="${esc(c.level)}"><h3 style="font-size:15px; margin:6px 0;">${esc(cl.name)} <span style="color:var(--muted); font-weight:400; font-size:13px;">${ci.ability?esc(ci.ability.toUpperCase()):''} · save DC ${ci.dc!=null?esc(ci.dc):'?'} · spell atk ${ci.atk!=null?esc(fmtMod(ci.atk)):'?'}</span></h3>${guide}${sections}</div>`;
  }).join('');
  return `<h2>Spells</h2>
    <p style="color:var(--muted); font-size:13px; margin:0 0 8px;">Tick a spell to learn it; the <b>i</b> beside it opens its full text.</p>
    <div class="info" style="margin-bottom:12px;">Spell slots — ${slotLine||'—'}${pactLine?('  ·  '+pactLine):''}</div>
    ${blocks}
    ${stepNav()}`;
}

function tabReview() {
  const d = derive();
  const classes = char.classes.map(c => { const cl=SRD.get('classes',c.class); const sub=c.subclass&&SRD.get('subclasses',c.subclass); return `${esc(cl?cl.name:c.class)} ${esc(c.level)}${sub?` (${esc(sub.name)})`:''}`; }).join(' / ');
  const race = SRD.get('races', char.race); const sub = char.subrace && SRD.get('subraces', char.subrace);
  const abilGrid = ABILITIES.map(a=>`<div class="metric"><div class="l">${a.toUpperCase()}</div><div class="v">${d.finals[a]}</div><div class="l">${fmtMod(d.mods[a])}${d.saves.has(a)?' · save '+fmtMod(d.mods[a]+d.prof):''}</div></div>`).join('');
  const skillList = [...d.proficient].map(s=>SRD.get('skills',s)).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name)).map(sk=>{ const ab=sk.ability_score.index; return `<div class="inv-row"><span>${sk.name} <span class="pill">${ab}</span>${d.expertise.has(sk.index)?' <span class="pill">expertise</span>':''}</span><b>${fmtMod(d.skillBonus(sk.index, ab))}</b></div>`; }).join('') || '<span style="color:var(--muted)">—</span>';
  const attacks = char.equipment.weapons.map(wi=>{ const w=SRD.get('equipment',wi); if(!w) return ''; const a=weaponProfile(w,d,SRD,char.classes); return `<div class="inv-row"><span>${esc(w.name)} <span class="pill">${a.ranged?'ranged '+a.rangeFt+' ft':'melee'}</span></span><b>${fmtMod(a.attack)} · ${esc(a.damage)} ${esc(a.damageType)}</b></div>`; }).join('') || '<span style="color:var(--muted)">No weapons.</span>';
  const kit = d.combat;
  const extraAttacks = kit.attacks.filter(a => (a.tags||[]).includes('natural') || (a.tags||[]).includes('unarmed')).map(a => `<div class="inv-row"><span>${esc(a.name)} <span class="pill">${a.ranged?'ranged':'melee'}</span></span><b>${fmtMod(a.attack)} · ${esc(a.damage)} ${esc(a.damageType)}</b></div>`).join('');
  const combatRows = [
    ...kit.abilities.map(a => `<div class="inv-row"><span>${esc(a.name)} <span class="pill">${esc(a.cost)}</span></span><b>${esc([a.type==='heal'?'heal '+a.damage:[a.damage,a.damageType].filter(Boolean).join(' '), a.type==='save'?`DC ${a.dc} ${a.saveAbility.toUpperCase()}`:'', a.area!=='single'&&a.area!=='self'?`${a.areaFt} ft ${a.area}`:''].filter(Boolean).join(' · '))}</b></div>`),
    ...kit.riders.map(r => `<div class="inv-row"><span>${esc(r.name)} <span class="pill">bonus damage</span></span><b>+${esc(r.damage)} ${esc(r.damageType)}</b></div>`),
    ...Object.values(kit.resources).filter(r => r.max > 0).map(r => `<div class="inv-row"><span>${esc(r.name)} <span class="pill">resource</span></span><b>${r.max} / ${esc(r.recharge)} rest</b></div>`)
  ].join('');
  const si=d.spellInfo;
  const slotsTxt = Object.entries(si.slots).filter(([l,n])=>n>0).map(([l,n])=>`L${l}×${n}`).join('  ') + (si.pact?`  Pact ${si.pact.count}×L${si.pact.level}`:'');
  const spellNames = char.spells.map(x=>SRD.get('spells',x)).filter(Boolean).sort((a,b)=>a.level-b.level||a.name.localeCompare(b.name));
  const spellsTxt = spellNames.length ? spellNames.map(s=>`${s.level===0?'•':esc(s.level)} ${esc(s.name)}`).join(', ') : '—';
  const gear = char.equipment.items.map(gi=>SRD.get('equipment',gi)).filter(Boolean).map(g=>esc(g.name)).join(', ') || '—';
  const armorTxt = char.equipment.armor ? esc(SRD.get('equipment',char.equipment.armor)?.name || char.equipment.armor) : 'none';
  const featTxt = d.features.length ? d.features.map(f=>`${esc(f.name)}${f.classIdx?` (L${esc(f.level)})`:''}`).join(', ') : '—';
  const traitBits = [
    ...Object.entries(d.senses || {}).map(([sense, feet]) => `${sense === 'devilsSight' ? "Devil's Sight" : sense[0].toUpperCase() + sense.slice(1)} ${feet} ft`),
    ...Object.entries(d.speeds).map(([mode, feet]) => `${mode} ${feet} ft`),
    d.resistances.length ? 'Resist ' + d.resistances.join(', ') : '',
    d.languages.length ? 'Languages: ' + d.languages.join(', ') : '',
    d.proficiencies.length ? 'Proficiencies: ' + d.proficiencies.join(', ') : ''
  ].filter(Boolean).map(esc).join(' · ');
  return `<h2>${esc(char.name)||'(unnamed)'} <span style="float:right; font-size:13px; color:var(--muted); font-weight:400;">${esc(sub?sub.name:(race?race.name:''))} · ${classes}</span></h2>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
      <div>
        <div class="metrics" style="grid-template-columns:repeat(3,1fr);">${abilGrid}</div>
        <h3 style="font-size:14px; margin:12px 0 6px;">Skills</h3>${skillList}
      </div>
      <div>
        <div class="info" style="line-height:1.7;">AC <strong>${d.ac}</strong> <span style="color:var(--muted)">(${esc(d.acSource)})</span><br/>HP <strong>${d.hp}</strong> · Init <strong>${fmtMod(d.init)}</strong> · Speed <strong>${d.speed}</strong> · Prof <strong>${fmtMod(d.prof)}</strong> · PP <strong>${d.pp}</strong><br/>${char.background&&SRD.get('backgrounds',char.background)?esc(SRD.get('backgrounds',char.background).name):'—'}${char.alignment?(' · '+esc(SRD.get('alignments',char.alignment).name)):''}${traitBits?`<br/><span style="color:var(--muted)">${traitBits}</span>`:''}</div>
        <h3 style="font-size:14px; margin:12px 0 6px;">Attacks</h3>${attacks}${extraAttacks}
        ${kit.attacksPerAction>1?`<div style="color:var(--muted); font-size:13px;">Extra Attack: ${kit.attacksPerAction} attacks per Attack action.</div>`:''}
        ${combatRows?`<h3 style="font-size:14px; margin:12px 0 6px;">Combat features</h3>${combatRows}`:''}
        ${si.casters.length?`<h3 style="font-size:14px; margin:12px 0 6px;">Spells</h3><div class="info">${si.casters.map(ci=>`${esc(SRD.get('classes',ci.class).name)}: save DC ${ci.dc!=null?ci.dc:'?'} · spell atk ${ci.atk!=null?fmtMod(ci.atk):'?'}`).join('<br/>')}<div style="margin-top:6px;">Slots: ${slotsTxt||'—'}</div><div style="margin-top:6px;">${spellsTxt}</div></div>`:''}
      </div>
    </div>
    <h3 style="font-size:14px; margin:14px 0 6px;">Equipment</h3><div class="info">Armor: ${armorTxt}${char.equipment.shield?' · shield':''}<div style="margin-top:4px;">Gear: ${gear}</div></div>
    <h3 style="font-size:14px; margin:14px 0 6px;">Features</h3><div class="info">${featTxt}</div>
    ${PERSONALITY_FIELDS.some(([key]) => char.personality[key]) ? `<h3 style="font-size:14px; margin:14px 0 6px;">Personality</h3><div class="info">${PERSONALITY_FIELDS.filter(([key]) => char.personality[key]).map(([key, label]) => `<div style="white-space:pre-wrap;"><strong>${label}:</strong> ${esc(char.personality[key])}</div>`).join('')}</div>` : ''}
    ${reviewWarnings()}
    <p style="color:var(--muted); font-size:13px; margin-top:12px;">Use “Save character” on the right.</p>
    ${stepNav()}`;
}

// Things a player usually wants to know before saving; none of them block it.
function reviewWarnings() {
  const d = derive(), notes = [];
  if (!char.name.trim()) notes.push('The character has no name yet.');
  for (const c of d.choices) if (c.picked.length < c.choose) notes.push(`${c.name}: ${c.choose - c.picked.length} choice${c.choose - c.picked.length === 1 ? '' : 's'} left (${c.key.startsWith('background:') ? 'Background' : 'Features'}).`);
  const { slots, feats, spent, points } = asiBudget();
  if (spent > points) notes.push('More improvement points are spent than the build has earned (Abilities).');
  else if (slots && (slots - feats) * 2 - spent > 0) notes.push(`${(slots - feats) * 2 - spent} improvement point${(slots - feats) * 2 - spent === 1 ? '' : 's'} unspent (Abilities), or take a feat instead.`);
  for (const c of char.classes) {
    const subs = SRD.subclassesForClass(c.class);
    if (!c.subclass && subs.length && c.level >= SRD.subclassChoiceLevel(c.class)) notes.push(`${SRD.get('classes', c.class)?.name || c.class}: no subclass chosen (Class).`);
  }
  if (!char.equipment.weapons.length && !char.equipment.armor && !char.equipment.items.length) notes.push('No equipment yet: the Equipment tab can add the starting kit in one click.');
  return notes.length ? `<h3 style="font-size:14px; margin:14px 0 6px;">Before you save</h3><div class="info">${notes.map(n => `<div>• ${esc(n)}</div>`).join('')}</div>` : '';
}

function stepNav() {
  const T = TABS(); const i = T.findIndex(t=>t[0]===activeTab);
  return `<div class="stepnav">
    <button class="btn btn-sm nav-prev" ${i<=0?'disabled':''}>← Back</button>
    <button class="btn btn-sm btn-accent nav-next" ${i>=T.length-1?'disabled':''}>Next →</button></div>`;
}

/* ---------- Wiring ---------- */
function pruneSpells() {
  const valid = new Set(char.classes.flatMap(c => SRD.spellsForClass(c.class).map(s => s.index)));
  char.spells = char.spells.filter(x => valid.has(x));
}
// Reset references to homebrew that was deleted, so the dropdowns and char state agree.
function reconcileChar() {
  let changed = false;
  if (SRD && !SRD.get('races', char.race)) { char.race = 'human'; char.subrace = null; char.racialChoice = []; char.racialSpread = null; changed = true; }
  char.classes.forEach(c => { if (SRD && !SRD.get('classes', c.class)) { c.class = 'fighter'; c.subclass = null; changed = true; } });
  if (!SRD) return changed;
  if (char.subrace && !SRD.get('subraces', char.subrace)) { char.subrace = null; changed = true; }
  if (!SRD.get('backgrounds', char.background)) { char.background = 'acolyte'; changed = true; }
  char.classes.forEach(c => { if (c.subclass && !SRD.get('subclasses', c.subclass)) { c.subclass = null; changed = true; } });
  const feats = char.feats.filter(f => SRD.get('feats', f));
  if (feats.length !== char.feats.length) { char.feats = feats; changed = true; }
  const eq = char.equipment;
  if (eq.armor && !SRD.get('equipment', eq.armor)) { eq.armor = null; changed = true; }
  for (const key of ['weapons', 'items']) {
    const kept = eq[key].filter(x => SRD.get('equipment', x));
    if (kept.length !== eq[key].length) { eq[key] = kept; changed = true; }
  }
  return changed;
}
function refresh() { pruneSpells(); renderTab(); renderTabs(); renderRail(); updateModel(); }

function wireTab() {
  const b = $('tab-body');
  b.querySelectorAll('.nav-prev').forEach(e=>e.onclick=()=>{ const T=TABS(); const i=T.findIndex(t=>t[0]===activeTab); if(i>0){activeTab=T[i-1][0]; renderTabs(); renderTab();} });
  b.querySelectorAll('.nav-next').forEach(e=>e.onclick=()=>{ const T=TABS(); const i=T.findIndex(t=>t[0]===activeTab); if(i<T.length-1){activeTab=T[i+1][0]; renderTabs(); renderTab();} });

  if (activeTab === 'identity') {
    $('f-name').oninput = e => { char.name = e.target.value; };
    $('f-xp').oninput = e => {
      const n = Math.floor(Number(e.target.value));
      char.xp = Number.isFinite(n) ? Math.max(0, Math.min(100000000, n)) : 0;
    };
    $('f-race').onchange = e => { char.race = e.target.value; char.subrace=null; char.racialChoice=[]; char.racialSpread=null; applyRaceLook(char.race); refresh(); };
    $('f-subrace').onchange = e => { char.subrace = e.target.value || null; refresh(); };
    b.querySelectorAll('.rc').forEach(cb => cb.onchange = () => {
      const rb = SRD.racialAbilityBonuses(char.race, char.subrace);
      const picked = [...b.querySelectorAll('.rc:checked')].map(x=>x.value);
      if (picked.length <= (rb.options?rb.options.choose:0)) char.racialChoice = picked;
      refresh();
    });
    b.querySelectorAll('.rsp').forEach(radio => radio.onchange = () => {
      const rb = SRD.racialAbilityBonuses(char.race, char.subrace);
      const idx = Number(radio.dataset.i);
      if (!rb.spreads || !rb.spreads[idx]) return;
      char.racialSpread = idx;
      char.racialChoice = char.racialChoice.slice(0, rb.spreads[idx].bonuses.length);
      refresh();
    });
    b.querySelectorAll('.rslot').forEach(sel => sel.onchange = () => {
      const rb = SRD.racialAbilityBonuses(char.race, char.subrace);
      if (!rb.spreads) return;
      if (typeof char.racialSpread !== 'number' || !rb.spreads[char.racialSpread]) {
        // Picks shown on the default spread (a pre-spreads sheet): commit it now.
        const legacy = rb.spreads.findIndex(sp => sp.bonuses.every(b => b === 1) && sp.bonuses.length === char.racialChoice.filter(Boolean).length);
        char.racialSpread = legacy >= 0 ? legacy : 0;
      }
      char.racialChoice = [...b.querySelectorAll('.rslot')].map(s => s.value || null);
      refresh();
    });
  } else if (activeTab === 'class') {
    b.querySelectorAll('.class-row').forEach(row => {
      const i = +row.dataset.i;
      row.querySelector('.c-class').onchange = e => { const was = char.classes[0].class; char.classes[i].class=e.target.value; char.classes[i].subclass=null; if (i === 0) followClassOutfit(was); refresh(); };
      row.querySelector('.c-level').onchange = e => { char.classes[i].level=Math.max(1,Math.min(20,+e.target.value||1)); refresh(); };
      row.querySelector('.c-sub').onchange = e => { char.classes[i].subclass=e.target.value||null; refresh(); };
      row.querySelector('.c-del').onclick = () => { if(char.classes.length>1){char.classes.splice(i,1); refresh();} };
    });
    $('add-class').onclick = () => { if(char.classes.length<3){char.classes.push({class:'wizard',subclass:null,level:1}); refresh();} };
  } else if (activeTab === 'background') {
    // Re-rendering the tab must not throw the reader back to the top of a long page.
    const redraw = () => { const y = window.scrollY; renderTab(); window.scrollTo(0, y); };
    $('f-bg').onchange = e => { char.background = e.target.value; refresh(); };
    $('f-align').onchange = e => { char.alignment = e.target.value || null; };
    $('f-notes').oninput = e => { char.notes = e.target.value; };
    const kitBtn = $('bg-kit');
    if (kitBtn) kitBtn.onclick = () => { const added = takeStartingKit([SRD.get('backgrounds', char.background)]); refresh(); msg(added ? `Added ${added} item${added===1?'':'s'} to Equipment` : 'Already packed'); };
    wireChoices(b);
    b.querySelectorAll('.pers').forEach(t => t.oninput = () => {
      char.personality[t.dataset.k] = t.value;
      // Keep the suggestion marks in step with what is typed, without a re-render.
      const lines = personalityLines(t.dataset.k);
      b.querySelectorAll('.sugg').forEach(s => { if (s.dataset.k === t.dataset.k) s.classList.toggle('on', lines.includes(s.dataset.text)); });
    });
    b.querySelectorAll('.sugg').forEach(btn => btn.onclick = () => { togglePersonalityLine(btn.dataset.k, btn.dataset.text); redraw(); });
    b.querySelectorAll('.sugg-box').forEach(box => box.ontoggle = () => { if (box.open) openSuggestions.add(box.dataset.k); else openSuggestions.delete(box.dataset.k); });
    b.querySelectorAll('.pers-roll').forEach(btn => btn.onclick = () => {
      const key = btn.dataset.k, lines = personalityLines(key);
      const { choose, options } = personalityTable(key);
      const fresh = options.filter(o => !lines.includes(o));
      if (!fresh.length) return;
      // Rolling fills the picks the table asks for, then starts swapping the last one.
      const kept = lines.length >= choose ? lines.slice(0, choose - 1) : lines;
      char.personality[key] = [...kept, pick(fresh)].join('\n').slice(0, PERSONALITY_MAX);
      redraw();
    });
    $('add-lang').onclick = () => {
      const value = ($('f-lang-custom').value.trim() || $('f-lang').value).slice(0, 40);
      if (value && !char.languages.includes(value)) { char.languages.push(value); refresh(); }
    };
    b.querySelectorAll('.lang-rm').forEach(btn => btn.onclick = () => { char.languages.splice(+btn.dataset.i, 1); refresh(); });
  } else if (activeTab === 'features') {
    wireChoices(b);
    b.querySelectorAll('.feat-pick').forEach(cb => cb.onchange = () => {
      char.feats = [...b.querySelectorAll('.feat-pick:checked')].map(x => x.value).slice(0, 24);
      refresh();
    });
  } else if (activeTab === 'abilities') {
    b.querySelectorAll('.seg button').forEach(btn => btn.onclick = () => {
      char.abilityMethod = btn.dataset.m;
      if (char.abilityMethod==='standard-array') assignStandardArray();
      refresh();
    });
    b.querySelectorAll('.ability-row[data-a]').forEach(row => {
      const a = row.dataset.a;
      const inc = row.querySelector('.inc'), dec = row.querySelector('.dec');
      if (inc) inc.onclick = () => { if(canBuy(a,1)){ char.baseAbilities[a]++; refresh(); } };
      if (dec) dec.onclick = () => { if(char.baseAbilities[a]>8){ char.baseAbilities[a]--; refresh(); } };
    });
    b.querySelectorAll('.asi-row').forEach(row => {
      const a = row.dataset.a;
      row.querySelector('.asi-inc').onclick = () => { const { spent, points } = asiBudget(); if (spent < points) { char.asi[a] = (char.asi[a] || 0) + 1; refresh(); } };
      row.querySelector('.asi-dec').onclick = () => { if (char.asi[a] > 0) { char.asi[a]--; if (!char.asi[a]) delete char.asi[a]; refresh(); } };
    });
    b.querySelectorAll('.sa').forEach(s => s.onchange = e => { char.baseAbilities[e.target.dataset.a]=+e.target.value; refresh(); });
    b.querySelectorAll('.man').forEach(s => s.onchange = e => { char.baseAbilities[e.target.dataset.a]=Math.max(1,Math.min(30,+e.target.value||1)); refresh(); });
  } else if (activeTab === 'skills') {
    b.querySelectorAll('.sk').forEach(cb => cb.onchange = () => {
      char.skills = [...b.querySelectorAll('.sk:checked')].map(x=>x.value).filter(v => !grantedSkills().has(v));
      char.expertise = char.expertise.filter(s => char.skills.includes(s) || grantedSkills().has(s));
      refresh();
    });
    b.querySelectorAll('.sk-exp').forEach(cb => cb.onchange = () => {
      char.expertise = [...b.querySelectorAll('.sk-exp:checked')].map(x=>x.value);
      refresh();
    });
  } else if (activeTab === 'appearance') {
    const ap = char.appearance;
    const live = (input, set) => input.oninput = e => { set(+e.target.value); e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); updateModel(); };
    $('apply-preset').onclick = () => { applyRaceLook(char.race, true); Object.assign(ap.wear, wardrobeOf(char.classes[0].class)); refresh(); };
    $('ap-random').onclick = () => { randomizeLook(); refresh(); };
    b.querySelectorAll('.look-card').forEach(card => card.onclick = () => { ap.look = card.dataset.look || null; refresh(); });
    b.querySelectorAll('.ap-s').forEach(s => live(s, v => { ap[s.dataset.k] = v; }));
    const isForm = (id) => KIT.sliders[id] && KIT.sliders[id].group === 'form';
    b.querySelectorAll('.ap-blend').forEach(s2 => live(s2, v => {
      // The worn type keeps whatever share the others leave it.
      for (const id of Object.keys(ap.details)) if (isForm(id)) delete ap.details[id];
      let rest = 1;
      b.querySelectorAll('.ap-blend').forEach(x => { const w = Math.min(rest, +x.value); if (w > 0) { ap.details[x.dataset.k] = w; rest -= w; } });
      const own = KIT.assets[ap.wear.bodyform] && KIT.assets[ap.wear.bodyform].target;
      if (own && rest < 1) ap.details[own] = Math.max(0, rest);
    }));
    if (!b.querySelector('.ap-f')) return; // a pack look: nothing else to wire
    b.querySelectorAll('.ap-seg button').forEach(btn => btn.onclick = () => { ap[btn.parentElement.dataset.k] = btn.dataset.v; refresh(); });
    b.querySelectorAll('.ap-f').forEach(s => live(s, v => { ap.form[s.dataset.k] = v; }));
    b.querySelectorAll('.ap-d').forEach(s => live(s, v => { if (v) ap.details[s.dataset.k] = v; else delete ap.details[s.dataset.k]; }));
    b.querySelectorAll('.ap-group').forEach(d => d.ontoggle = () => { if (d.open) openDetailGroups.add(d.dataset.g); else openDetailGroups.delete(d.dataset.g); });
    if ($('ap-details-reset')) $('ap-details-reset').onclick = () => { ap.details = { ...(raceForm(char.race).details || {}) }; refresh(); };
    if ($('ap-skin')) $('ap-skin').onchange = e => { ap.skin = e.target.value; updateModel(); };
    if ($('ap-eyes')) $('ap-eyes').onchange = e => { ap.eyeColor = e.target.value; updateModel(); };
    if ($('ap-showarmor')) $('ap-showarmor').onchange = e => { ap.showArmor = e.target.checked; updateModel(); };
    b.querySelectorAll('.ap-wear').forEach(sel => sel.onchange = () => {
      const slot = sel.dataset.slot;
      ap.wear[slot] = sel.value;
      if (slot === 'bodyform') {   // a different body: its own build, no leftover blend or face sliders
        ap.details = sel.value ? {} : { ...(raceForm(char.race).details || {}) };
        ap.form = { age: 0, muscle: 0.5, weight: 0.5, stature: 0.5, ...(sel.value ? {} : { muscle: raceForm(char.race).muscle ?? 0.5, weight: raceForm(char.race).weight ?? 0.5, stature: raceForm(char.race).stature ?? 0.5 }) };
      }
      if (slot === 'outfit' || slot === 'bodyform') refresh(); else updateModel();
    });
    b.querySelectorAll('.ap-trait').forEach(cb => cb.onchange = () => {
      const shown = [...b.querySelectorAll('.ap-trait:checked')].map(x => x.value);
      ap.traits = [...ap.traits.filter(t => !SHOWN_TRAITS.includes(t)), ...shown];
      if (cb.value === 'horns') { ap.wear.horns = cb.checked ? (ap.wear.horns || 'horns-curled') : ''; refresh(); } else updateModel();
    });
    b.querySelectorAll('.ap-c').forEach(c => c.oninput = e => { ap.colors[e.target.dataset.k]=e.target.value; updateModel(); });
  } else if (activeTab === 'equipment') {
    $('eq-armor').onchange = e => { char.equipment.armor = e.target.value || null; refresh(); };
    $('starting-kit').onclick = () => { const added = takeStartingKit(); refresh(); msg(added ? `Added ${added} starting item${added===1?'':'s'}` : 'Nothing new to add (no starting kit, or it is already packed)'); };
    $('eq-shield').onchange = e => { char.equipment.shield = e.target.checked; refresh(); };
    $('add-weapon').onclick = () => { const v=$('eq-weapon').value; if(v){ char.equipment.weapons.push(v); refresh(); } };
    $('add-gear').onclick = () => { const v=$('eq-gear').value; if(v){ char.equipment.items.push(v); refresh(); } };
    b.querySelectorAll('.rm-w').forEach(btn=>btn.onclick=()=>{ char.equipment.weapons.splice(+btn.dataset.i,1); refresh(); });
    b.querySelectorAll('.rm-i').forEach(btn=>btn.onclick=()=>{ char.equipment.items.splice(+btn.dataset.i,1); refresh(); });
  } else if (activeTab === 'spells') {
    b.querySelectorAll('.sp').forEach(cb=>cb.onchange=()=>{ const v=cb.value; if(cb.checked){ if(!char.spells.includes(v)) char.spells.push(v); } else { char.spells=char.spells.filter(x=>x!==v); } b.querySelectorAll('.sp[value="'+CSS.escape(v)+'"]').forEach(x=>{ x.checked=cb.checked; x.closest('.spell').classList.toggle('on', cb.checked); }); updateSpellGuides(); renderRail(); });
    // The "i" on a spell opens its card under that level's list (again to close).
    b.querySelectorAll('.sp-info').forEach(btn=>btn.onclick=(e)=>{
      e.preventDefault(); e.stopPropagation();
      const reader = btn.closest('details').querySelector('.spell-reader');
      const spell = SRD.get('spells', btn.dataset.spell);
      if (!reader || !spell) return;
      const same = !reader.hidden && reader.dataset.spell === spell.index;
      b.querySelectorAll('.sp-info.on').forEach(x=>x.classList.remove('on'));
      reader.hidden = same;
      if (same) return;
      btn.classList.add('on');
      reader.dataset.spell = spell.index;
      reader.innerHTML = `<h4>${esc(spell.name)}</h4>${spellDetailHTML(spell, { charLevel: SRD.totalLevel(char.classes) || 1 })}`;
    });
  }
}

function canBuy(a, delta) {
  const next = char.baseAbilities[a] + delta;
  if (next < 8 || next > 15) return false;
  const used = ABILITIES.reduce((s,x)=> s + (POINT_BUY_COST[char.baseAbilities[x]] ?? 0), 0);
  const cost = (POINT_BUY_COST[next] ?? 99) - (POINT_BUY_COST[char.baseAbilities[a]] ?? 0);
  return used + cost <= POINT_BUY_BUDGET;
}
function assignStandardArray() {
  ABILITIES.forEach((a,i)=> char.baseAbilities[a] = STANDARD_ARRAY[i] ?? 8);
}
function renderRail() {
  const d = derive();
  $('metrics').innerHTML = [
    ['HP',d.hp],['AC',d.ac],['Speed',d.speed],['Init',fmtMod(d.init)],['Prof',fmtMod(d.prof)],['PP',d.pp]
  ].map(([l,v])=>`<div class="metric"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  $('mods').innerHTML = ABILITIES.map(a=>`<div class="m">${a.toUpperCase()}<b>${fmtMod(d.mods[a])}</b></div>`).join('');
}

/* ---------- 3D preview ---------- */
let scene, camera, renderer, controls, model;
const PREVIEW_H = 380;
function initPreview() {
  const canvas = $('preview-canvas');
  const w = canvas.clientWidth || 300, h = PREVIEW_H;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, w/h, 0.1, 1000); camera.position.set(0.9,0.85,2.3); camera.lookAt(0,0.6,0);
  renderer = new THREE.WebGLRenderer({ canvas, antialias:true }); renderer.setSize(w,h); renderer.setPixelRatio(window.devicePixelRatio);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0,0.6,0); controls.enableDamping=true; controls.enablePan=false; controls.minDistance=0.8; controls.maxDistance=4;
  controls.maxPolarAngle = Math.PI * 0.53;  // never under the floor
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x445566, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff,0.9); dl.position.set(2,5,3); scene.add(dl);
  const rim = new THREE.DirectionalLight(0xffc98a, 0.55); rim.position.set(-2.5, 3, -3); scene.add(rim);
  renderer.outputEncoding = THREE.sRGBEncoding; // PBR character textures need gamma out
  configureCharacterRendering({ gammaOut: true });
  buildStage();
  buildModel();
  document.querySelectorAll('#preview-roles button').forEach(btn => btn.onclick = () => {
    if (model && model.userData.playRole) model.userData.playRole(btn.dataset.role);
  });
  // Headless-testing handle (mirrors gm.js/player.js __dbg).
  window.__dbg = { get scene(){return scene;}, get camera(){return camera;}, get renderer(){return renderer;}, get model(){return model;} };
  (function loop(){ requestAnimationFrame(loop); tickRigCharacters(); controls.update(); renderer.render(scene,camera); })();
  window.addEventListener('resize', () => { const ww=canvas.clientWidth||300; renderer.setSize(ww,PREVIEW_H); camera.aspect=ww/PREVIEW_H; camera.updateProjectionMatrix(); });
}
// The figure stands on a small brass-rimmed dais in a warm, dark studio (the
// ink & brass of the rest of the chrome): a painted gradient for the
// backdrop, fog that melts the floor into it, and a soft contact shadow.
function paintedTexture(size, paint) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  paint(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function buildStage() {
  const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();   // output is sRGB-encoded
  scene.background = paintedTexture(256, (g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, '#2e241a'); grad.addColorStop(0.55, '#1a140e'); grad.addColorStop(1, '#0e0b08');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    const glow = g.createRadialGradient(s / 2, s * 0.42, 0, s / 2, s * 0.42, s * 0.5);
    glow.addColorStop(0, 'rgba(230,195,119,0.16)'); glow.addColorStop(1, 'rgba(230,195,119,0)');
    g.fillStyle = glow; g.fillRect(0, 0, s, s);
  });
  scene.fog = new THREE.Fog(srgb(0x120e0a), 3.2, 7);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 48), new THREE.MeshStandardMaterial({ color: srgb(0x1c1712), roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.09; scene.add(floor);
  const dais = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.68, 0.09, 64),
    new THREE.MeshStandardMaterial({ color: srgb(0x3b3229), roughness: 0.85 }));
  dais.position.y = -0.045; scene.add(dais);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.625, 0.012, 8, 96),
    new THREE.MeshStandardMaterial({ color: srgb(0xc9973a), metalness: 0.8, roughness: 0.35 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.001; scene.add(ring);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false,
    map: paintedTexture(128, (g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(0, 0, s, s);
    })
  }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.003; scene.add(shadow);
}
// The preview is the exact rigged character the tabletop shows (charmesh.js),
// rebuilt and released on every tweak.
function buildModel() {
  const previous = model;
  const next = createRigCharacter(
    { appearance: char.appearance, race: char.race, equipment: char.equipment },
    { footY: 0, onReady: () => {
        if (model !== next) return;           // superseded while it was building
        next.visible = true;
        if (previous) dropModel(previous);
      } });
  next.visible = !previous;
  if (previous && previous.userData.pendingPrevious) { dropModel(previous.userData.pendingPrevious); }
  next.userData.pendingPrevious = previous && !previous.visible ? null : previous;
  if (previous && !previous.visible) dropModel(previous); // never became visible: nothing to hold on to
  model = next;
  scene.add(model);
  // Pack looks without mapped clips are static figures: no pose buttons.
  const look = char.appearance.look && characterLooks()[char.appearance.look];
  const roles = $('preview-roles');
  if (roles) roles.classList.toggle('hidden', !!(look && !look.clips));
}
function dropModel(m) {
  scene.remove(m);
  if (m.userData.rigCharacter) releaseRigCharacter(m); else disposeModel(m);
}
let modelTimer = null;
function updateModel() {
  if (!renderer) return;
  clearTimeout(modelTimer);
  modelTimer = setTimeout(buildModel, 70);
}

/* ---------- Save / load ---------- */
function buildSaveObject() {
  const ap = char.appearance;
  return {
    id: char.id || undefined,
    name: char.name || 'Unnamed',
    schemaVersion: 2,
    race: char.race, subrace: char.subrace, background: char.background, alignment: char.alignment,
    classes: char.classes.map(c => ({ ...c })),
    abilityMethod: char.abilityMethod,
    abilities: { ...char.baseAbilities }, racialChoice: [...char.racialChoice],
    ...(char.racialSpread != null ? { racialSpread: char.racialSpread } : {}),
    skills: [...char.skills],
    appearance: { height:ap.height, build:1, headSize:1, armLength:1, legLength:1, colors:{...ap.colors},
      body:ap.body, form:{ ...ap.form }, details:{ ...ap.details }, wear:{ ...ap.wear },
      ...(ap.skin ? { skin: ap.skin } : {}), ...(ap.showArmor === false ? { showArmor: false } : {}), eyeColor:ap.eyeColor, traits:[...ap.traits], ...(ap.look ? { look: ap.look } : {}) },
    equipment: { armor: char.equipment.armor, shield: !!char.equipment.shield, weapons: [...char.equipment.weapons], items: [...char.equipment.items] },
    spells: [...char.spells],
    feats: [...char.feats], expertise: [...char.expertise], languages: [...char.languages],
    choices: Object.fromEntries(Object.entries(char.choices).map(([k, v]) => [k, [...v]])),
    notes: char.notes || '',
    ...(Number.isFinite(char.xp) ? { xp: char.xp } : {}),
    asi: { ...char.asi }, personality: { ...char.personality },
    ...(char.hp ? { hp: { current: char.hp.current } } : {}),
    // back-compat for existing token renderers
    color: ap.colors.torso,
    stats: { ...char.baseAbilities },
    owner: username
  };
}
function loadIntoBuilder(c) {
  char = defaultChar();
  char.id = c.id || null; char.name = c.name || '';
  char.race = c.race || 'human'; char.subrace = c.subrace || null;
  char.background = c.background || 'acolyte'; char.alignment = c.alignment || null;
  char.classes = Array.isArray(c.classes) && c.classes.length ? c.classes.map(x => ({ class: x.class || x.name?.toLowerCase?.() || 'fighter', subclass: x.subclass||null, level: x.level||1 })) : [{class:'fighter',subclass:null,level:1}];
  char.abilityMethod = c.abilityMethod || 'manual';
  char.baseAbilities = { ...char.baseAbilities, ...(c.abilities || c.stats || {}) };
  char.racialChoice = c.racialChoice || [];
  char.racialSpread = Number.isInteger(c.racialSpread) ? c.racialSpread : null;
  char.skills = c.skills || [];
  char.equipment = c.equipment ? { armor: c.equipment.armor ?? null, shield: !!c.equipment.shield, weapons: c.equipment.weapons || [], items: c.equipment.items || [] } : { armor:null, shield:false, weapons:[], items:[] };
  char.spells = c.spells || [];
  char.feats = Array.isArray(c.feats) ? [...c.feats] : [];
  char.expertise = Array.isArray(c.expertise) ? [...c.expertise] : [];
  char.languages = Array.isArray(c.languages) ? [...c.languages] : [];
  char.choices = (c.choices && typeof c.choices === 'object' && !Array.isArray(c.choices))
    ? Object.fromEntries(Object.entries(c.choices).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, [...v]])) : {};
  char.notes = typeof c.notes === 'string' ? c.notes : '';
  char.xp = Number.isFinite(c.xp) ? Math.max(0, Math.min(100000000, Math.floor(c.xp))) : 0;
  char.asi = {};
  if (c.asi && typeof c.asi === 'object') for (const a of ABILITIES) { const n = Math.max(0, Math.min(12, Math.floor(+c.asi[a] || 0))); if (n) char.asi[a] = n; }
  for (const [key] of PERSONALITY_FIELDS) char.personality[key] = (c.personality && typeof c.personality[key] === 'string') ? c.personality[key].slice(0, 600) : '';
  // Sheets from before the parametric body carry the old fields (build, hair
  // style, outfit…): resolveCharacter reads either generation, so the editor
  // starts from exactly what the tabletop was already showing.
  const src = c.appearance || {};
  // (the wardrobe as chosen, not with the equipped armour laid over it)
  const recipe = resolveCharacter({ race: char.race, equipment: char.equipment, appearance: { ...src, showArmor: false } }, KIT);
  char.appearance = {
    height: src.height ?? 1,
    colors: { ...DEFAULT_COLORS, ...(src.colors || (c.color?{torso:c.color}:{})) },
    body: BODY_TYPES.includes(src.body) ? src.body : 'male',
    form: { age: recipe.shape.age, muscle: recipe.shape.muscle, weight: recipe.shape.weight, stature: recipe.shape.height },
    details: { ...recipe.shape.details },
    wear: Object.fromEntries(WEAR_SLOTS.map(slot => [slot, recipe.wear[slot] || ''])),
    skin: typeof src.skin === 'string' && KIT.skins[src.skin] ? src.skin : '',
    eyeColor: recipe.eyeColor,
    showArmor: src.showArmor !== false,
    traits: [...recipe.traits],
    look: typeof src.look === 'string' ? src.look : null
  };
  // The outfit a full robe covered comes back if the robe is taken off.
  if (recipe.wear.outfit && !src.wear) Object.assign(char.appearance.wear, { top: '', bottom: '' });
  // Live HP rides along so export -> import round-trips combat state; the
  // server only honors it for NEW records (existing ones keep their HP).
  char.hp = (c.hp && typeof c.hp.current === 'number')
    ? { current: Math.max(0, Math.min(999, Math.floor(c.hp.current))) } : null;
  const reconciled = reconcileChar();
  activeTab = 'identity'; renderTabs(); buildModel(); refresh();
  msg('Loaded ' + (c.name||'character') + (reconciled ? ' (deleted homebrew reset to defaults)' : ''));
}
function renderSaved(list) {
  const el = $('saved');
  if (!list || !list.length) { el.innerHTML = '<p style="color:var(--muted); font-size:13px;">None yet.</p>'; return; }
  el.innerHTML = list.map(c => {
    const lvl = (Array.isArray(c.classes) ? c.classes : []).reduce((sum, entry) => {
      const level = Number(entry && entry.level);
      return sum + (Number.isFinite(level) ? Math.max(0, Math.min(20, Math.floor(level))) : 0);
    }, 0);
    const owner = c.owner && c.owner!==username ? ` <span class="pill">${esc(c.owner)}</span>` : '';
    return `<div class="c" data-id="${esc(c.id)}"><span><b style="color:${esc(c.color||'#dd4444')}">${esc(c.name)}</b>${owner} <span style="color:var(--muted)">· L${lvl}</span></span><button class="del" data-id="${esc(c.id)}">✕</button></div>`;
  }).join('');
  window._chars = list;
  el.querySelectorAll('.c').forEach(row => row.onclick = e => {
    if (e.target.classList.contains('del')) return;
    const c = list.find(x=>x.id===row.dataset.id); if (c) loadIntoBuilder(c);
  });
  el.querySelectorAll('.del').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    if (confirm('Delete this character?')) socket.emit('delete-character', btn.dataset.id);
  });
  // The tabletop inspector can deep-link directly into a placed character.
  // Resolve only once so later save/list refreshes do not overwrite active edits.
  if (requestedCharacterId && !requestedCharacterLoaded) {
    requestedCharacterLoaded = true;
    const requested = list.find(c => c.id === requestedCharacterId);
    if (requested) loadIntoBuilder(requested);
  }
}
/* ---------- Aurora (.dnd5e) import ---------- */
// Save one homebrew stub and resolve with the index the server assigned.
function saveHomebrewStub(type, data) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('homebrew-saved-success', onSaved); socket.off('error', onError); };
    const onSaved = (payload) => {
      if (!payload || payload.type !== type || !payload.data) return;
      cleanup(); resolve(payload.data.index);
    };
    const onError = (message) => { cleanup(); reject(new Error(String(message))); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('the server did not answer')); }, 8000);
    socket.on('homebrew-saved-success', onSaved);
    socket.on('error', onError);
    socket.emit('save-homebrew', { type, data });
  });
}
async function importAurora(text) {
  const { char: imported, missing, warnings } = matchAurora(parseAuroraCharacter(text), SRD);
  if (missing.length) {
    const list = missing.map(m => '• ' + m.label).join('\n');
    const create = confirm(`${imported.name} uses content this table does not have yet:\n\n${list}\n\nCreate homebrew entries for them now? They are filled with what the file records (names, skills, tools, languages); add rules text and mechanics afterwards in the Homebrew builder.\n\nCancel imports the character with stand-ins instead.`);
    if (create) {
      const collections = { race: 'races', subclass: 'subclasses', background: 'backgrounds' };
      const created = [];
      for (const entry of missing) {
        const index = await saveHomebrewStub(entry.type, entry.stub);
        entry.apply(index);
        created.push([collections[entry.type], index]);
      }
      // The shared homebrew broadcast lands just after the save replies; the
      // sheet must not load before every new entry is in the tables.
      for (let i = 0; i < 50 && created.some(([collection, index]) => !SRD.get(collection, index)); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }
  loadIntoBuilder(imported);
  const report = $('import-report');
  if (report) {
    report.innerHTML = warnings.length
      ? `<b>Imported from Aurora — to finish:</b><ul style="margin:6px 0 0 18px;">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul><a href="/homebrew" target="_blank">Open the Homebrew builder</a>`
      : '';
    report.classList.toggle('hidden', !warnings.length);
  }
  msg('Imported ' + (char.name || 'character') + ' from Aurora — Save to add it to this roster');
}

function msg(t, err=false) { const m=$('msg'); m.textContent=t; m.style.color = err?'#f87171':'#34d399'; setTimeout(()=>{ if(m.textContent===t) m.textContent=''; }, 3000); }

/* ---------- Boot ---------- */
async function startApp() {
  try { SRD = await loadSRD(); [KIT] = await Promise.all([loadCharacterKit(), loadCharacterLooks()]); }
  catch (e) { $('boot').textContent = 'Failed to load SRD data: ' + e.message; return; }
  $('boot').classList.add('hidden'); $('app').classList.remove('hidden');
  $('who').textContent = 'Logged in as ' + username;
  if (pendingHomebrew) SRD.setHomebrew(pendingHomebrew);
  reconcileChar();
  applyRaceLook(char.race); followClassOutfit(null);
  renderTabs(); renderTab(); renderRail(); initPreview();
  $('save-btn').onclick = () => {
    if (!socket || !username) return msg('Not connected', true);
    if (!char.name.trim()) { activeTab='identity'; renderTabs(); renderTab(); return msg('Enter a name', true); }
    socket.emit('save-character', { charData: buildSaveObject(), username });
  };
  $('new-btn').onclick = () => { char = defaultChar(); applyRaceLook(char.race); followClassOutfit(null); activeTab='identity'; renderTabs(); buildModel(); refresh(); msg('New character'); };

  // Export/import: the current sheet as a JSON file. Export prefers the
  // editor state (with saved HP merged in); import always lands as a NEW
  // character (stale ids/owners from other campaigns are stripped).
  $('export-btn').onclick = () => {
    const data = buildSaveObject();
    delete data.id;
    const saved = (window._chars || []).find(entry => entry.id === char.id);
    if (saved && saved.hp && saved.hp.current != null) data.hp = { current: saved.hp.current };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (char.name || 'character').replace(/[^\w\-. ]+/g, '').trim() || 'character';
    link.download += '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    msg('Exported ' + (char.name || 'character'));
  };
  $('import-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';   // re-picking the same file must fire again
    if (!file) return;
    try {
      const text = await file.text();
      if (/\.(dnd5e|xml)$/i.test(file.name) || /^﻿?\s*</.test(text)) { await importAurora(text); return; }
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a character file');
      if (typeof data.name !== 'string' && !data.race && !data.classes) throw new Error('not a character export');
      delete data.id;
      delete data.owner;
      loadIntoBuilder(data);
      msg('Imported ' + (char.name || 'character') + ' — Save to add it to this roster');
    } catch (error) {
      msg('Import failed: ' + error.message, true);
    }
  };

  // Switch which campaign roster this Studio edits (no ?campaign deep link).
  const campaignSelect = $('campaign-select');
  if (campaignSelect) campaignSelect.onchange = (event) => {
    const id = event.target.value;
    if (!socket || !id || (activeCampaign && activeCampaign.id === id)) return;
    socket.emit('join-campaign', { id, screen: 'studio' });
    const url = new URL(window.location.href);
    url.searchParams.set('campaign', id);
    history.replaceState(null, '', url);
  };
}

/* ---------- Login + socket ---------- */
const login = setupLoginModal(() => {
  socket = io();
  login.attach(socket);
  socket.on('connect', () => {
    // Studio screen: join the campaign roster without a map room.
    socket.emit('login', login.payload({ campaignId: campaignId || undefined, screen: 'studio' }));
  });
  socket.on('login-success', (data) => {
    username = data.username;
    startApp();
    socket.emit('get-campaigns');
  });
  socket.on('campaign-joined', (campaign) => {
    if (!campaign || campaign.ok === false) {
      msg('Campaign unavailable' + (campaign && campaign.error ? ': ' + campaign.error : ''), true);
      return;
    }
    activeCampaign = campaign;
    const select = document.getElementById('campaign-select');
    if (select && campaign.id) select.value = campaign.id;
    const note = document.getElementById('campaign-select-note');
    if (note) note.textContent = 'Roster of "' + campaign.name + '".';
  });
  socket.on('campaign-list', (payload) => {
    const list = payload && Array.isArray(payload.campaigns) ? payload.campaigns : [];
    const select = document.getElementById('campaign-select');
    if (!select) return;
    const current = activeCampaign ? activeCampaign.id : (campaignId || 'default');
    select.innerHTML = list.map(entry =>
      `<option value="${esc(entry.id)}">${esc(entry.name)}</option>`).join('');
    if (list.some(entry => entry.id === current)) select.value = current;
    select.disabled = list.length <= 1;
  });
  socket.on('load-user-characters', renderSaved);
  socket.on('load-homebrew', (hb) => {
    pendingHomebrew = hb;
    if (SRD) {
      SRD.setHomebrew(hb); reconcileChar(); pruneSpells();
      // Don't blow away the panel if the user is mid-edit inside it.
      const editing = document.activeElement && $('tab-body').contains(document.activeElement);
      if (!$('app').classList.contains('hidden') && !editing) { renderTabs(); renderTab(); renderRail(); }
    }
  });
  socket.on('character-saved-success', (c) => { char.id = c.id; msg('Saved “'+c.name+'”'); });
  socket.on('character-deleted', () => socket.emit('get-characters'));
  socket.on('error', (m) => { if (!username) { login.showError(m); login.reset(); } else { msg(m, true); } });
});
