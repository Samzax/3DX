import { loadSRD, ABILITIES, ABILITY_NAMES } from '../shared/srd.js';
import { setupLoginModal } from '../shared/login.js';

let SRD = null, socket = null, username = null, homebrew = { races: [], classes: [] };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let editingRaceIndex = null, editingClassIndex = null;
function resetRaceForm() {
  editingRaceIndex = null;
  $('r-name').value = ''; $('r-speed').value = '30'; $('r-size').value = 'Medium'; $('r-traits').value = '';
  document.querySelectorAll('.r-ab').forEach(i => i.value = '0');
}
function resetClassForm() {
  editingClassIndex = null;
  $('c-name').value = ''; $('c-hd').value = '8'; $('c-skill-choose').value = '2';
  document.querySelectorAll('.c-save,.c-prof,.c-skill').forEach(cb => cb.checked = false);
  $('c-caster').value = 'none'; $('c-caster-fields').classList.add('hidden');
  $('c-features').innerHTML = ''; addFeatureRow(1);
}
function loadRaceIntoForm(r) {
  editingRaceIndex = r.index;
  $('r-name').value = r.name || ''; $('r-size').value = r.size || 'Medium'; $('r-speed').value = r.speed || 30;
  document.querySelectorAll('.r-ab').forEach(i => { const b = (r.ability_bonuses || []).find(x => x.ability_score.index === i.dataset.a); i.value = b ? b.bonus : 0; });
  $('r-traits').value = (r.traits || []).map(t => t.name).join('\n');
  window.scrollTo(0, 0);
}
function loadClassIntoForm(c) {
  editingClassIndex = c.index;
  $('c-name').value = c.name || ''; $('c-hd').value = String(c.hit_die || 8);
  const saveSet = new Set((c.saving_throws || []).map(s => s.index));
  document.querySelectorAll('.c-save').forEach(cb => cb.checked = saveSet.has(cb.value));
  const profSet = new Set((c.proficiencies || []).map(p => p.index));
  document.querySelectorAll('.c-prof').forEach(cb => cb.checked = profSet.has(cb.value));
  const grp = (c.proficiency_choices || [])[0];
  const skillSet = new Set((((grp && grp.from && grp.from.options) || [])).map(o => o.item.index.replace('skill-', '')));
  document.querySelectorAll('.c-skill').forEach(cb => cb.checked = skillSet.has(cb.value));
  $('c-skill-choose').value = grp ? grp.choose : 2;
  $('c-caster').value = c.caster || 'none';
  $('c-caster-fields').classList.toggle('hidden', (c.caster || 'none') === 'none');
  if (c.spellcasting) $('c-cast-ability').value = c.spellcasting.spellcasting_ability.index;
  if (c.spellList) $('c-spell-list').value = c.spellList;
  $('c-features').innerHTML = '';
  (c.customFeatures || []).forEach(f => addFeatureRow(f.level, f.name, f.desc));
  if (!(c.customFeatures || []).length) addFeatureRow(1);
  window.scrollTo(0, 0);
}
const CASTER_CLASSES = ['bard','cleric','druid','paladin','ranger','sorcerer','warlock','wizard'];
const OTHER_PROFS = [['simple-weapons','Simple weapons'],['martial-weapons','Martial weapons'],['light-armor','Light armor'],['medium-armor','Medium armor'],['heavy-armor','Heavy armor'],['shields','Shields']];

async function startApp() {
  try { SRD = await loadSRD(); } catch (e) { $('boot').textContent = 'Failed to load SRD: ' + e.message; return; }
  $('boot').classList.add('hidden'); $('app').classList.remove('hidden');
  buildForms();
  renderList();
}

function buildForms() {
  // Race ability inputs
  $('r-abilities').innerHTML = ABILITIES.map(a => `<div><label>${a.toUpperCase()}</label><input type="number" class="r-ab" data-a="${a}" value="0" min="-2" max="5"/></div>`).join('');
  // Class saving throws + skills + profs
  $('c-saves').innerHTML = ABILITIES.map(a => `<label><input type="checkbox" class="c-save" value="${a}"/> ${ABILITY_NAMES[a]}</label>`).join('');
  $('c-profs').innerHTML = OTHER_PROFS.map(([v,l]) => `<label><input type="checkbox" class="c-prof" value="${v}"/> ${l}</label>`).join('');
  $('c-skills').innerHTML = SRD.skills.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(s => `<label><input type="checkbox" class="c-skill" value="${s.index}"/> ${s.name}</label>`).join('');
  // Caster fields
  $('c-cast-ability').innerHTML = ABILITIES.map(a => `<option value="${a}" ${a==='int'?'selected':''}>${ABILITY_NAMES[a]}</option>`).join('');
  $('c-spell-list').innerHTML = CASTER_CLASSES.map(c => { const cl = SRD.get('classes', c); return `<option value="${c}" ${c==='wizard'?'selected':''}>${cl?cl.name:c}</option>`; }).join('');
  $('c-caster').onchange = e => $('c-caster-fields').classList.toggle('hidden', e.target.value === 'none');
  $('add-feature').onclick = () => addFeatureRow();
  addFeatureRow(1);
}

function addFeatureRow(level = 1, name = '', desc = '') {
  const div = document.createElement('div');
  div.className = 'feat-row';
  div.innerHTML = `<input type="number" class="f-level" value="${parseInt(level,10)||1}" min="1" max="20"/>
    <input type="text" class="f-name" placeholder="Feature"/>
    <input type="text" class="f-desc" placeholder="Description"/>
    <button class="btn btn-danger btn-sm f-del">✕</button>`;
  div.querySelector('.f-name').value = name;
  div.querySelector('.f-desc').value = desc;
  div.querySelector('.f-del').onclick = () => div.remove();
  $('c-features').appendChild(div);
}

// --- Save race ---
$('save-race').onclick = () => {
  if (!socket || !socket.connected || !username) return msg('race-msg', 'Not connected', true);
  const name = $('r-name').value.trim();
  if (!name) return msg('race-msg', 'Enter a name', true);
  const ability_bonuses = [...document.querySelectorAll('.r-ab')]
    .map(i => ({ a: i.dataset.a, v: parseInt(i.value, 10) || 0 }))
    .filter(x => x.v !== 0)
    .map(x => ({ ability_score: { index: x.a, name: x.a.toUpperCase() }, bonus: x.v }));
  const traits = $('r-traits').value.split('\n').map(t => t.trim()).filter(Boolean).map(t => ({ name: t }));
  const data = { name, size: $('r-size').value, speed: parseInt($('r-speed').value, 10) || 30,
    ability_bonuses, starting_proficiencies: [], subraces: [], traits, languages: [] };
  if (editingRaceIndex) data.index = editingRaceIndex;
  socket.emit('save-homebrew', { type: 'race', data });
};

// --- Save class ---
$('save-class').onclick = () => {
  if (!socket || !socket.connected || !username) return msg('class-msg', 'Not connected', true);
  const name = $('c-name').value.trim();
  if (!name) return msg('class-msg', 'Enter a name', true);
  const saving_throws = [...document.querySelectorAll('.c-save:checked')].map(c => ({ index: c.value, name: c.value.toUpperCase() }));
  const proficiencies = [...document.querySelectorAll('.c-prof:checked')].map(c => ({ index: c.value }));
  const skillPool = [...document.querySelectorAll('.c-skill:checked')].map(c => c.value);
  let choose = parseInt($('c-skill-choose').value, 10) || 0;
  if (choose > 0 && skillPool.length === 0) return msg('class-msg', 'You set a skill choice count but selected no class skills', true);
  choose = Math.min(choose, skillPool.length);
  const proficiency_choices = (skillPool.length && choose > 0) ? [{
    choose, type: 'proficiencies',
    from: { option_set_type: 'options_array', options: skillPool.map(s => ({ option_type: 'reference', item: { index: 'skill-' + s, name: 'Skill: ' + s } })) }
  }] : [];
  const caster = $('c-caster').value;
  const customFeatures = [...document.querySelectorAll('#c-features .feat-row')]
    .map(r => ({ level: parseInt(r.querySelector('.f-level').value, 10) || 1, name: r.querySelector('.f-name').value.trim(), desc: r.querySelector('.f-desc').value.trim() }))
    .filter(f => f.name);
  const data = {
    name, hit_die: parseInt($('c-hd').value, 10) || 8,
    saving_throws, proficiencies, proficiency_choices, subclasses: [],
    spellcasting: caster !== 'none' ? { spellcasting_ability: { index: $('c-cast-ability').value, name: $('c-cast-ability').value.toUpperCase() } } : null,
    caster, spellList: caster !== 'none' ? $('c-spell-list').value : null,
    customFeatures
  };
  if (editingClassIndex) data.index = editingClassIndex;
  socket.emit('save-homebrew', { type: 'class', data });
};

function renderList() {
  const el = $('hb-list');
  const items = [
    ...homebrew.races.map(r => ({ ...r, type: 'race' })),
    ...homebrew.classes.map(c => ({ ...c, type: 'class' }))
  ];
  if (!items.length) { el.innerHTML = '<p style="color:var(--muted); font-size:13px;">None yet.</p>'; return; }
  el.innerHTML = items.map(it => {
    const owned = it.owner === username || (username && username.toLowerCase() === 'gm');
    return `<div class="hb-item"><span><b>${esc(it.name)}</b> <span class="pill">${esc(it.type)}</span>${it.owner && it.owner!==username ? ` <span class="pill">${esc(it.owner)}</span>` : ''}</span>${owned ? `<span><button class="edit" data-type="${esc(it.type)}" data-index="${esc(it.index)}">edit</button> <button class="del" data-type="${esc(it.type)}" data-index="${esc(it.index)}">delete</button></span>` : ''}</div>`;
  }).join('');
  el.querySelectorAll('.del').forEach(b => b.onclick = () => {
    if (confirm('Delete this homebrew?')) socket.emit('delete-homebrew', { type: b.dataset.type, index: b.dataset.index });
  });
  el.querySelectorAll('.edit').forEach(b => b.onclick = () => {
    const all = b.dataset.type === 'race' ? homebrew.races : homebrew.classes;
    const item = all.find(x => x.index === b.dataset.index);
    if (item) (b.dataset.type === 'race' ? loadRaceIntoForm : loadClassIntoForm)(item);
  });
}

function msg(id, t, err = false) { const m = $(id); m.textContent = t; m.style.color = err ? '#f87171' : '#34d399'; setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 3000); }

// --- Login + socket ---
const login = setupLoginModal((u) => {
  socket = io();
  socket.on('connect', () => socket.emit('login', u));
  socket.on('login-success', (d) => { username = d.username; sessionStorage.setItem('vtt_username', username); login.hide(); startApp(); });
  socket.on('load-homebrew', (hb) => { homebrew = { races: hb.races || [], classes: hb.classes || [] }; renderList(); });
  socket.on('homebrew-saved-success', (p) => { msg(p.type === 'race' ? 'race-msg' : 'class-msg', `Saved "${p.data.name}"`); if (p.type === 'race') resetRaceForm(); else resetClassForm(); });
  socket.on('error', (m) => { if (!username) { login.showError(m); login.reset(); } else { msg('class-msg', m, true); } });
});
