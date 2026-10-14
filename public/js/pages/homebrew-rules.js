// homebrew-rules.js — the rules-content half of the Homebrew builder: races,
// subraces, classes, subclasses, backgrounds, feats, spells and items.
// (Monsters keep their dedicated form in homebrew.js.)
//
// Everything is schema-driven: each type is a list of field specs, and every
// trait/feature row shares one mechanics form (grants / combat action / damage
// rider / resource / pick-N choice) that maps 1:1 onto the feature block
// validated by lib/homebrew.cjs and interpreted by shared/rules.js.

import { ABILITIES, ABILITY_NAMES } from '../shared/srd.js';
import { SRD_MECHANICS, CONDITION_NAMES } from '../shared/rules.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {});
    o[keys[keys.length - 1]] = value;
}
const isEmpty = v => v == null || v === '' || v === false || (Array.isArray(v) && !v.length)
    || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
// Drop empty leaves so an untouched mechanics form saves as "no mechanics".
function prune(value) {
    if (Array.isArray(value)) return value.map(prune).filter(v => !isEmpty(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) { const p = prune(v); if (!isEmpty(p)) out[k] = p; }
        return out;
    }
    return value;
}

export const RULE_TYPES = [
    ['race', 'Race', 'races'], ['subrace', 'Subrace', 'subraces'], ['class', 'Class', 'classes'],
    ['subclass', 'Subclass', 'subclasses'], ['background', 'Background', 'backgrounds'],
    ['feat', 'Feat', 'feats'], ['spell', 'Spell', 'spells'], ['item', 'Item', 'items']
];
const SRD_SOURCE = { race: 'races', subrace: 'subraces', class: 'classes', subclass: 'subclasses', background: 'backgrounds', feat: 'feats', spell: 'spells', item: 'equipment' };

const ABILITY_OPTS = ABILITIES.map(a => [a, ABILITY_NAMES[a]]);
const EFFECT_OPTS = [['', '— none —'], ...Object.entries(CONDITION_NAMES)];
const RECHARGE_OPTS = [['short', 'Short rest'], ['long', 'Long rest'], ['combat', 'Each combat'], ['turn', 'Each turn']];
const AC_FORMULAS = [
    ['', '— none —'], ['10:dex,con', '10 + Dex + Con (Barbarian)'], ['10:dex,wis', '10 + Dex + Wis (Monk)'],
    ['13:dex', '13 + Dex (natural armor)'], ['10:dex,int', '10 + Dex + Int'], ['10:dex,cha', '10 + Dex + Cha'], ['12:dex', '12 + Dex'], ['17:', 'Flat 17 (shell)']
];
const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
const WEAPON_PROPS = ['ammunition', 'finesse', 'heavy', 'light', 'loading', 'reach', 'thrown', 'two-handed', 'versatile', 'monk'];
const CLASS_PROFS = [['simple-weapons', 'Simple weapons'], ['martial-weapons', 'Martial weapons'], ['light-armor', 'Light armor'], ['medium-armor', 'Medium armor'], ['heavy-armor', 'Heavy armor'], ['shields', 'Shields']];
const SPELL_LISTS = ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'];

// "6:3d6, 11:4d6" ↔ [{ level, damage }]
const scalingText = list => (list || []).map(t => `${t.level}:${t.damage}`).join(', ');
const scalingParse = text => csv(text).map(part => {
    const m = /^(\d+)\s*[:=]\s*(.+)$/.exec(part);
    return m ? { level: Number(m[1]), damage: m[2].trim() } : null;
}).filter(Boolean);

// --- Mechanics field specs (paths are relative to one feature) --------------
// type: text | number | select | bool | abilities | checks | skills | csv | scaling | acformula
const MECH_GROUPS = [
    {
        key: 'grants', title: 'Passive bonuses', hint: 'Always on while the character has this.',
        fields: [
            { path: 'grants.abilities', label: 'Ability score bonuses', type: 'abilities', min: -5, max: 10, wide: true },
            { path: 'grants.skills', label: 'Skill proficiencies', type: 'skills', wide: true },
            { path: 'grants.expertise', label: 'Expertise in', type: 'skills', wide: true },
            { path: 'grants.expertiseChoice', label: 'Expertise picks', type: 'number', min: 0, max: 6 },
            { path: 'grants.skillChoice.choose', label: 'Extra skill picks', type: 'number', min: 0, max: 18 },
            { path: 'grants.skillChoice.from', label: '…from (blank = any skill)', type: 'skills', wide: true },
            { path: 'grants.saves', label: 'Saving throw proficiencies', type: 'checks', options: ABILITY_OPTS.map(([a]) => [a, a.toUpperCase()]), wide: true },
            { path: 'grants.saveAdvantage', label: 'Advantage on saving throws', type: 'checks', options: ABILITY_OPTS.map(([a]) => [a, a.toUpperCase()]), wide: true },
            { path: 'grants.saveBonus', label: 'Bonus to every save (number or formula)', type: 'text', placeholder: 'cha, 1, prof' },
            { path: 'grants.evasion', label: 'Evasion (DEX save for half: none / half)', type: 'bool' },
            { path: 'grants.concentrationAdvantage', label: 'Advantage on saves to keep concentration', type: 'bool' },
            { path: 'grants.checkMinDie', label: 'Proficient checks: d20 counts as at least', type: 'number', min: 0, max: 20 },
            { path: 'grants.checkFloor', label: 'Checks never total below the score', type: 'checks', options: ABILITY_OPTS.map(([a]) => [a, a.toUpperCase()]), wide: true },
            { path: 'grants.proficiencies', label: 'Tools / weapons / armor', type: 'csv', placeholder: "Thieves' tools, Longsword", wide: true },
            { path: 'grants.languages', label: 'Languages', type: 'csv', placeholder: 'Elvish, Draconic' },
            { path: 'grants.languageChoice', label: 'Extra language picks', type: 'number', min: 0, max: 6 },
            { path: 'grants.resistances', label: 'Damage resistances', type: 'csv', placeholder: 'fire, poison' },
            { path: 'grants.immunities', label: 'Damage immunities', type: 'csv' },
            { path: 'grants.speed', label: 'Walk speed bonus (ft)', type: 'number', min: -30, max: 120 },
            { path: 'grants.speeds.climb', label: 'Climb speed (ft)', type: 'number', min: 0, max: 240 },
            { path: 'grants.speeds.fly', label: 'Fly speed (ft)', type: 'number', min: 0, max: 240 },
            { path: 'grants.speeds.swim', label: 'Swim speed (ft)', type: 'number', min: 0, max: 240 },
            { path: 'grants.ac', label: 'AC bonus', type: 'number', min: -5, max: 10 },
            { path: 'grants.acFormula', label: 'Unarmored AC formula', type: 'acformula' },
            { path: 'grants.hpPerLevel', label: 'Extra HP per level', type: 'number', min: 0, max: 5 },
            { path: 'grants.initiative', label: 'Initiative bonus', type: 'number', min: -10, max: 20 },
            { path: 'grants.initiativeProf', label: 'Add proficiency bonus to initiative', type: 'bool' },
            { path: 'grants.darkvision', label: 'Darkvision (ft)', type: 'number', min: 0, max: 300 },
            { path: 'grants.blindsight', label: 'Blindsight (ft)', type: 'number', min: 0, max: 300 },
            { path: 'grants.truesight', label: 'Truesight (ft)', type: 'number', min: 0, max: 300 },
            { path: 'grants.tremorsense', label: 'Tremorsense (ft)', type: 'number', min: 0, max: 300 },
            { path: 'grants.devilsSight', label: "Devil's Sight (ft)", type: 'number', min: 0, max: 300 },
            { path: 'grants.blind', label: 'Blind beyond those senses (no ordinary sight)', type: 'bool' },
            { path: 'grants.attacksPerAction', label: 'Attacks per Attack action', type: 'number', min: 0, max: 4 },
            { path: 'grants.critRange', label: 'Crit on (18–20)', type: 'number', min: 0, max: 20 },
            { path: 'grants.unarmedDamage', label: 'Unarmed strike die', type: 'text', placeholder: '1d6' },
            { path: 'grants.unarmedFinesse', label: 'Unarmed uses Dex or Str', type: 'bool' },
            { path: 'grants.monkWeapons', label: 'Monk weapons use Dex + unarmed die', type: 'bool' }
        ]
    },
    {
        key: 'action', title: 'Combat action', hint: 'A button in the encounter tracker. Dice may use level, classLevel, prof, str…cha (e.g. 1d10+classLevel).',
        fields: [
            { path: 'action.name', label: 'Button label (blank = feature name)', type: 'text', placeholder: 'Breath Weapon' },
            { path: 'action.type', label: 'Kind', type: 'select', options: [['', '— none —'], ['save', 'Saving throw (breath, burst)'], ['attack', 'Attack roll'], ['heal', 'Heal'], ['utility', 'Utility / self buff']] },
            { path: 'action.cost', label: 'Costs', type: 'select', options: [['action', 'Action'], ['bonus', 'Bonus action'], ['free', 'Free (no action)'], ['attack', 'Counts as a weapon attack']] },
            { path: 'action.damage', label: 'Dice (damage or healing)', type: 'text', placeholder: '2d6' },
            { path: 'action.damageType', label: 'Damage type', type: 'text', placeholder: 'fire' },
            { path: 'action.scaling', label: 'Scaling (level:dice)', type: 'scaling', placeholder: '6:3d6, 11:4d6, 16:5d6', wide: true },
            { path: 'action.saveAbility', label: 'Target saves with', type: 'select', options: ABILITY_OPTS },
            { path: 'action.saveSuccess', label: 'On a successful save', type: 'select', options: [['half', 'Half damage'], ['none', 'No effect']] },
            { path: 'action.dcAbility', label: 'DC = 8 + prof +', type: 'select', options: [['', '(fixed DC)'], ...ABILITY_OPTS] },
            { path: 'action.dc', label: 'Fixed DC', type: 'number', min: 0, max: 40 },
            { path: 'action.ability', label: 'Attack ability', type: 'select', options: [...ABILITY_OPTS, ['best', 'Str or Dex (best)']] },
            { path: 'action.proficient', label: 'Add proficiency to hit', type: 'bool', default: true },
            { path: 'action.ranged', label: 'Ranged', type: 'bool' },
            { path: 'action.rangeFt', label: 'Range / reach (ft)', type: 'number', min: 0, max: 600 },
            { path: 'action.area', label: 'Shape', type: 'select', options: [['single', 'Single target'], ['cone', 'Cone'], ['line', 'Line'], ['sphere', 'Sphere'], ['cube', 'Cube'], ['self', 'Self only']] },
            { path: 'action.areaFt', label: 'Area size (ft)', type: 'number', min: 0, max: 300 },
            { path: 'action.maxTargets', label: 'Max targets', type: 'number', min: 0, max: 12 },
            { path: 'action.uses', label: 'Uses (number or formula)', type: 'text', placeholder: '1, prof, 1+cha' },
            { path: 'action.recharge', label: 'Uses return after', type: 'select', options: RECHARGE_OPTS },
            { path: 'action.resource', label: 'Spends resource (key)', type: 'text', placeholder: 'ki' },
            { path: 'action.resourceCost', label: 'Resource cost', type: 'number', min: 0, max: 20 },
            { path: 'action.effect', label: 'Condition on target', type: 'select', options: EFFECT_OPTS },
            { path: 'action.selfEffect', label: 'Condition on self', type: 'select', options: EFFECT_OPTS },
            { path: 'action.grant', label: 'Also grants', type: 'select', options: [['', '— nothing —'], ['dash', 'Dash'], ['dodge', 'Dodge'], ['disengage', 'Disengage'], ['attacks', 'Extra attacks'], ['action', 'One more action']] },
            { path: 'action.grantCount', label: 'Extra attacks', type: 'number', min: 0, max: 4 },
            { path: 'action.grantAttack', label: '…only with attack named', type: 'text', placeholder: 'Unarmed' }
        ]
    },
    {
        key: 'rider', title: 'Bonus damage on weapon attacks', hint: 'Sneak Attack–style dice the player can add to a hit.',
        fields: [
            { path: 'rider.damage', label: 'Dice', type: 'text', placeholder: '1d6' },
            { path: 'rider.damageType', label: 'Damage type', type: 'text' },
            { path: 'rider.scaling', label: 'Scaling (level:dice)', type: 'scaling', placeholder: '3:2d6, 5:3d6', wide: true },
            { path: 'rider.applies', label: 'Applies to', type: 'select', options: [['any', 'Any attack'], ['melee', 'Melee'], ['ranged', 'Ranged'], ['finesse-or-ranged', 'Finesse or ranged'], ['unarmed', 'Unarmed']] },
            { path: 'rider.oncePerTurn', label: 'Once per turn', type: 'bool', default: true },
            { path: 'rider.auto', label: 'Always applies (no toggle)', type: 'bool' },
            { path: 'rider.requiresEffect', label: 'Only while', type: 'select', options: EFFECT_OPTS }
        ]
    },
    {
        key: 'resource', title: 'Resource pool', hint: 'A pool other features spend by key (e.g. "ki").',
        fields: [
            { path: 'resource.key', label: 'Key', type: 'text', placeholder: 'ki' },
            { path: 'resource.name', label: 'Display name', type: 'text', placeholder: 'Ki' },
            { path: 'resource.max', label: 'Size (number or formula)', type: 'text', placeholder: 'classLevel' },
            { path: 'resource.recharge', label: 'Refills after', type: 'select', options: RECHARGE_OPTS }
        ]
    }
];
const PREREQ_GROUP = {
    key: 'prereq', title: 'Prerequisites',
    fields: [
        { path: 'prereq.level', label: 'Minimum level', type: 'number', min: 0, max: 20 },
        { path: 'prereq.abilities', label: 'Minimum ability scores', type: 'abilities', min: 0, max: 30, wide: true },
        { path: 'prereq.text', label: 'Other (shown as text)', type: 'text', wide: true }
    ]
};

export function createRulesBuilder({ root, SRD, getSocket, getHomebrew, onNotify }) {
    let type = 'race';
    let editingIndex = null;
    let form = null;        // { read(), el }
    const skillName = idx => (SRD.get('skills', idx) || {}).name || idx;
    const skillIndex = name => (SRD.skills.find(s => squash(s.name) === squash(name) || s.index === name) || {}).index || null;

    // ---- one generic field ------------------------------------------------
    function fieldHTML(spec, value, id) {
        const label = `<label class="fld">${esc(spec.label)}</label>`;
        const attr = `data-path="${esc(spec.path)}" data-type="${spec.type}"`;
        const v = value == null ? (spec.default != null ? spec.default : '') : value;
        let control;
        switch (spec.type) {
            case 'number': control = `<input type="number" ${attr} value="${esc(v === 0 && !spec.keepZero ? '' : v)}" ${spec.min != null ? `min="${spec.min}"` : ''} ${spec.max != null ? `max="${spec.max}"` : ''}/>`; break;
            case 'textarea': control = `<textarea ${attr} rows="${spec.rows || 3}" placeholder="${esc(spec.placeholder || '')}">${esc(v)}</textarea>`; break;
            case 'select': control = `<select ${attr}>${spec.options.map(([val, text]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`; break;
            case 'bool': return `<label class="mech-check ${spec.wide ? 'wide' : ''}"><input type="checkbox" ${attr} ${(value == null ? !!spec.default : !!value) ? 'checked' : ''}/> ${esc(spec.label)}</label>`;
            case 'abilities': control = `<div class="ability-grid" ${attr}>${ABILITIES.map(a => `<div><label>${a.toUpperCase()}</label><input type="number" data-a="${a}" value="${esc((value && value[a]) || '')}" min="${spec.min}" max="${spec.max}"/></div>`).join('')}</div>`; break;
            case 'checks': control = `<div class="checks" ${attr}>${spec.options.map(([val, text]) => `<label><input type="checkbox" value="${esc(val)}" ${(value || []).includes(val) ? 'checked' : ''}/> ${esc(text)}</label>`).join('')}</div>`; break;
            case 'skills': control = `<input type="text" ${attr} value="${esc((value || []).map(skillName).join(', '))}" placeholder="Perception, Stealth" list="hb-skill-names"/>`; break;
            case 'csv': control = `<input type="text" ${attr} value="${esc((value || []).join(', '))}" placeholder="${esc(spec.placeholder || '')}"/>`; break;
            case 'scaling': control = `<input type="text" ${attr} value="${esc(scalingText(value))}" placeholder="${esc(spec.placeholder || '')}"/>`; break;
            case 'spreads': control = `<input type="text" ${attr} value="${esc((value || []).map(s => (s.bonuses || []).join(', ')).join(' | '))}" placeholder="${esc(spec.placeholder || '2, 1 | 1, 1, 1')}"/>`; break;
            case 'acformula': {
                const current = value ? `${value.base}:${(value.abilities || []).join(',')}` : '';
                control = `<select ${attr}>${AC_FORMULAS.map(([val, text]) => `<option value="${val}" ${current === val ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
                break;
            }
            default: control = `<input type="text" ${attr} value="${esc(v)}" placeholder="${esc(spec.placeholder || '')}"/>`;
        }
        return `<div class="row ${spec.wide ? 'wide' : ''}">${label}${control}${spec.hint ? `<div class="field-hint">${esc(spec.hint)}</div>` : ''}</div>`;
    }
    function readField(el) {
        switch (el.dataset.type) {
            case 'number': return el.value.trim() === '' ? null : Number(el.value);
            case 'bool': return el.checked;
            case 'abilities': { const out = {}; el.querySelectorAll('input').forEach(i => { const n = parseInt(i.value, 10); if (n) out[i.dataset.a] = n; }); return out; }
            case 'checks': return [...el.querySelectorAll('input:checked')].map(i => i.value);
            case 'skills': return [...new Set(csv(el.value).map(skillIndex).filter(Boolean))];
            case 'csv': return csv(el.value);
            case 'scaling': return scalingParse(el.value);
            case 'spreads': return String(el.value).split('|').map(part => part.trim()).filter(Boolean)
                .map(part => ({ bonuses: part.split(/[^0-9]+/).map(v => parseInt(v, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= 3).slice(0, 3) }))
                .filter(s => s.bonuses.length);
            case 'acformula': {
                if (!el.value) return null;
                const [base, abilities] = el.value.split(':');
                return { base: Number(base), abilities: abilities ? abilities.split(',') : [], shield: true };
            }
            default: return el.value.trim();
        }
    }
    // ---- the shared mechanics form ---------------------------------------
    function mechanicsHTML(feature, groups) {
        return groups.map(group => {
            const used = !isEmpty(prune(feature[group.key]));
            return `<details class="mech-group" ${used ? 'open' : ''}><summary>${esc(group.title)}${used ? ' <span class="pill">set</span>' : ''}</summary>
                ${group.hint ? `<div class="field-hint">${esc(group.hint)}</div>` : ''}
                <div class="mech-grid">${group.fields.map(spec => fieldHTML(spec, getPath(feature, spec.path))).join('')}</div></details>`;
        }).join('');
    }
    // Tidy one feature read back from the form into the wire shape.
    function cleanFeature(raw) {
        const f = prune(raw);
        if (f.action && !f.action.type) delete f.action;
        if (f.action) {
            if (f.action.dcAbility) delete f.action.dc;
            if (f.action.type !== 'save' && f.action.type !== 'attack') { delete f.action.saveAbility; delete f.action.saveSuccess; delete f.action.ability; }
            if (f.action.type !== 'save') { delete f.action.saveAbility; delete f.action.saveSuccess; if (!raw.action.dc) delete f.action.dcAbility; }
            if (f.action.type === 'attack' && raw.action.proficient === false) f.action.proficient = false;
            if (!f.action.uses) delete f.action.recharge;
        }
        if (f.rider && !f.rider.damage) delete f.rider;
        if (f.rider && raw.rider.oncePerTurn === false) f.rider.oncePerTurn = false;
        if (f.resource && !(f.resource.key && f.resource.max)) delete f.resource;
        if (f.grants && f.grants.skillChoice && !f.grants.skillChoice.choose) delete f.grants.skillChoice;
        if (f.grants && f.grants.skillChoice && !f.grants.skillChoice.from) f.grants.skillChoice.from = [];
        if (f.grants && !Object.keys(f.grants).length) delete f.grants;
        return f;
    }

    // ---- feature list editor (traits, class features, choice options) -----
    function featureEditor({ withLevel = false, depth = 0, addLabel = '+ Add feature' } = {}) {
        const el = document.createElement('div');
        el.className = 'feature-editor';
        el.dataset.editor = String(depth);
        const list = document.createElement('div');
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'btn btn-sm'; add.textContent = addLabel;
        el.append(list, add);
        const optionEditors = new WeakMap();
        const untouched = new WeakMap();   // row → the feature it was loaded with

        function addRow(feature = {}) {
            const row = document.createElement('div');
            row.className = 'feature-row';
            const mechCount = ['grants', 'action', 'rider', 'resource', 'choice'].filter(k => !isEmpty(prune(feature[k]))).length;
            row.innerHTML = `
                <div class="fr-head">
                    ${withLevel ? `<input type="number" class="fr-level" value="${esc(feature.level || 1)}" min="1" max="20" title="Level gained"/>` : ''}
                    <input type="text" class="fr-name" placeholder="Name" value="${esc(feature.name || '')}"/>
                    <button type="button" class="btn btn-sm fr-toggle">Mechanics${mechCount ? ` <span class="pill">${mechCount}</span>` : ''}</button>
                    <button type="button" class="btn btn-danger btn-sm fr-del" title="Remove">✕</button>
                </div>
                <textarea class="fr-desc" rows="2" placeholder="Rules text">${esc(feature.desc || '')}</textarea>
                <div class="fr-mech hidden"></div>`;
            // The mechanics form is built the first time it is opened: a class
            // cloned from the SRD has dozens of rows. Until then the row keeps
            // the mechanics it was loaded with.
            untouched.set(row, feature);
            const build = () => {
                if (!untouched.has(row)) return;
                untouched.delete(row);
                row.querySelector('.fr-mech').innerHTML = `${mechanicsHTML(feature, MECH_GROUPS)}
                    ${depth === 0 ? `<details class="mech-group" ${feature.choice ? 'open' : ''}><summary>Choice — pick N options${feature.choice ? ' <span class="pill">set</span>' : ''}</summary>
                        <div class="field-hint">Each option is a feature of its own; the player picks in the creator's Features tab.</div>
                        <div class="row compact-number"><label class="fld">Choose how many</label><input type="number" class="fr-choose" min="1" max="6" value="${esc((feature.choice && feature.choice.choose) || 1)}"/></div>
                        <div class="fr-options"></div></details>` : ''}`;
                if (depth === 0) {
                    const options = featureEditor({ depth: 1, addLabel: '+ Add option' });
                    options.setValue((feature.choice && feature.choice.options) || []);
                    row.querySelector('.fr-options').appendChild(options.el);
                    optionEditors.set(row, options);
                }
            };
            row.querySelector('.fr-toggle').onclick = () => { build(); row.querySelector('.fr-mech').classList.toggle('hidden'); };
            row.querySelector('.fr-del').onclick = () => row.remove();
            list.appendChild(row);
            return row;
        }
        add.onclick = () => addRow();

        return {
            el,
            setValue(features) { list.innerHTML = ''; for (const f of features || []) addRow(f); },
            getValue() {
                return [...list.children].map(row => {
                    const name = row.querySelector(':scope > .fr-head .fr-name').value.trim();
                    if (!name) return null;
                    const raw = { name, desc: row.querySelector(':scope > .fr-desc').value.trim() };
                    if (withLevel) raw.level = Math.max(1, Math.min(20, parseInt(row.querySelector(':scope > .fr-head .fr-level').value, 10) || 1));
                    const loaded = untouched.get(row);
                    if (loaded) {
                        for (const key of ['grants', 'action', 'rider', 'resource', 'choice', 'prereq']) if (loaded[key]) raw[key] = loaded[key];
                        return raw;
                    }
                    const mech = row.querySelector(':scope > .fr-mech');
                    mech.querySelectorAll(':scope > .mech-group > .mech-grid [data-path]').forEach(input => setPath(raw, input.dataset.path, readField(input)));
                    const feature = cleanFeature(raw);
                    const options = optionEditors.get(row);
                    if (options) {
                        const picked = options.getValue();
                        if (picked.length) feature.choice = { choose: Math.max(1, parseInt(mech.querySelector('.fr-choose').value, 10) || 1), options: picked };
                    }
                    return feature;
                }).filter(Boolean);
            }
        };
    }

    // ---- per-type forms ----------------------------------------------------
    const raceOptions = () => SRD.races.map(r => [r.index, r.name + (r.custom ? ' (homebrew)' : '')]);
    const classOptions = () => SRD.classes.map(c => [c.index, c.name + (c.custom ? ' (homebrew)' : '')]);
    const bonusesToRecord = list => Object.fromEntries((list || []).map(b => [b.ability_score.index, b.bonus]));
    const recordToBonuses = rec => Object.entries(rec || {}).map(([a, bonus]) => ({ ability_score: { index: a, name: a.toUpperCase() }, bonus }));
    const skillsToRefs = list => (list || []).map(idx => ({ index: 'skill-' + idx, name: 'Skill: ' + skillName(idx) }));
    const refsToSkills = list => (list || []).map(p => p.index && p.index.startsWith('skill-') ? p.index.slice(6) : null).filter(Boolean);
    const languageNames = list => (list || []).map(l => (typeof l === 'string' ? l : (l.name || l.index))).filter(Boolean);
    // Background suggestion tables (SRD shape) ↔ one suggestion per line.
    const suggestionLines = table => (((table && table.from && table.from.options) || []).map(o => o.string || o.desc).filter(Boolean)).join('\n');
    const suggestionTable = (lines, choose) => {
        const options = String(lines || '').split('\n').map(s => s.trim()).filter(Boolean).map(string => ({ string }));
        return options.length ? { choose, from: { options } } : undefined;
    };

    // Each form: fields (generic specs over a flat "view" record), lists
    // (feature editors keyed by target property), toView(item) and toData(view).
    const FORMS = {
        race: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Stoneborn' },
                { path: 'size', label: 'Size', type: 'select', options: ['Tiny', 'Small', 'Medium', 'Large'].map(s => [s, s]) },
                { path: 'speed', label: 'Speed (ft)', type: 'number', min: 0, max: 120, keepZero: true },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true },
                { path: 'bonuses', label: 'Ability score bonuses', type: 'abilities', min: -5, max: 10, wide: true },
                { path: 'bonusChoose', label: 'Plus: choose this many other abilities for +1', type: 'number', min: 0, max: 5 },
                { path: 'spreads', label: 'Alternative spreads', type: 'spreads', wide: true, placeholder: '2, 1 | 1, 1, 1',
                  hint: 'MotM-style choice: the player picks one spread and assigns one ability per slot. When set, it replaces the “choose N” picker above.' },
                { path: 'skills', label: 'Skill proficiencies', type: 'skills', wide: true },
                { path: 'languages', label: 'Languages', type: 'csv', placeholder: 'Common, Elvish', wide: true }
            ],
            lists: { traits: { title: 'Traits', addLabel: '+ Add trait' } },
            toView: r => ({
                name: r.name, size: r.size || 'Medium', speed: r.speed ?? 30, desc: r.desc || '',
                bonuses: bonusesToRecord(r.ability_bonuses),
                bonusChoose: (r.ability_bonus_options && r.ability_bonus_options.choose) || 0,
                spreads: (r.ability_spreads || []).map(s => ({ bonuses: s.bonuses || [] })),
                skills: refsToSkills(r.starting_proficiencies), languages: languageNames(r.languages), traits: r.traits || []
            }),
            toData: v => {
                const fixed = Object.keys(v.bonuses || {});
                const spreads = (v.spreads || []).filter(s => s && Array.isArray(s.bonuses) && s.bonuses.length);
                return {
                    name: v.name, size: v.size, speed: v.speed ?? 30, desc: v.desc,
                    ability_bonuses: recordToBonuses(v.bonuses),
                    ability_bonus_options: (v.bonusChoose && !spreads.length) ? {
                        choose: v.bonusChoose,
                        from: { options: ABILITIES.filter(a => !fixed.includes(a)).map(a => ({ ability_score: { index: a, name: a.toUpperCase() }, bonus: 1 })) }
                    } : null,
                    ...(spreads.length ? { ability_spreads: spreads } : {}),
                    starting_proficiencies: skillsToRefs(v.skills), languages: v.languages, traits: v.traits
                };
            }
        },
        subrace: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Deep Stoneborn' },
                { path: 'race', label: 'Subrace of', type: 'select', options: raceOptions },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true },
                { path: 'bonuses', label: 'Additional ability score bonuses', type: 'abilities', min: -5, max: 10, wide: true },
                { path: 'skills', label: 'Skill proficiencies', type: 'skills', wide: true },
                { path: 'languages', label: 'Languages', type: 'csv', wide: true }
            ],
            lists: { traits: { title: 'Traits', addLabel: '+ Add trait' } },
            toView: r => ({
                name: r.name, race: r.race && r.race.index, desc: Array.isArray(r.desc) ? r.desc.join(' ') : (r.desc || ''),
                bonuses: bonusesToRecord(r.ability_bonuses), skills: refsToSkills(r.starting_proficiencies),
                languages: languageNames(r.languages), traits: r.traits || (r.racial_traits || []).map(t => ({ name: t.name, index: t.index }))
            }),
            toData: v => ({
                name: v.name, race: { index: v.race, name: (SRD.get('races', v.race) || {}).name }, desc: v.desc,
                ability_bonuses: recordToBonuses(v.bonuses), starting_proficiencies: skillsToRefs(v.skills),
                languages: v.languages, traits: v.traits
            })
        },
        class: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Warden' },
                { path: 'hit_die', label: 'Hit die', type: 'select', options: [6, 8, 10, 12].map(d => [d, 'd' + d]) },
                { path: 'subclassLevel', label: 'Subclass chosen at level', type: 'number', min: 1, max: 20 },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true },
                { path: 'saves', label: 'Saving throw proficiencies (pick 2)', type: 'checks', options: ABILITY_OPTS, wide: true },
                { path: 'profs', label: 'Armor & weapon proficiencies', type: 'checks', options: CLASS_PROFS, wide: true },
                { path: 'skillChoose', label: 'Skill choices — choose', type: 'number', min: 0, max: 6, keepZero: true },
                { path: 'skillPool', label: 'Skill list (the pool to choose from)', type: 'checks', options: () => SRD.skills.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => [s.index, s.name]), wide: true },
                { path: 'caster', label: 'Spellcasting', type: 'select', options: [['none', 'Non-caster'], ['full', 'Full caster (Wizard)'], ['half', 'Half caster (Paladin)'], ['third', 'Third caster (Eldritch Knight)'], ['pact', 'Pact magic (Warlock)']] },
                { path: 'castAbility', label: 'Spellcasting ability', type: 'select', options: ABILITY_OPTS },
                { path: 'spellList', label: 'Spell list', type: 'select', options: () => [['', 'Own list only (homebrew spells that name this class)'], ...SPELL_LISTS.map(c => [c, 'Borrow ' + ((SRD.get('classes', c) || {}).name || c) + "'s list"])], wide: true }
            ],
            lists: { customFeatures: { title: 'Features by level', withLevel: true, hint: 'Repeat a feature\'s name at a higher level to upgrade it (e.g. a d4 die at 1, d6 at 5).' } },
            toView: c => {
                const group = (c.proficiency_choices || []).find(g => ((g.from && g.from.options) || []).some(o => o.item && o.item.index && o.item.index.startsWith('skill-')));
                return {
                    name: c.name, hit_die: c.hit_die || 8, subclassLevel: c.subclassLevel || 3, desc: c.desc || '',
                    saves: (c.saving_throws || []).map(s => s.index),
                    profs: (c.proficiencies || []).map(p => p.index),
                    extraProfs: (c.proficiencies || []).filter(p => !CLASS_PROFS.some(([k]) => k === p.index)),
                    skillChoose: group ? group.choose : 2,
                    skillPool: group ? group.from.options.map(o => o.item.index.replace('skill-', '')) : [],
                    caster: c.caster || 'none',
                    castAbility: (c.spellcasting && c.spellcasting.spellcasting_ability && c.spellcasting.spellcasting_ability.index) || 'int',
                    spellList: c.spellList || '', customFeatures: c.customFeatures || []
                };
            },
            toData: (v, previous) => ({
                name: v.name, hit_die: Number(v.hit_die) || 8, subclassLevel: v.subclassLevel || 3, desc: v.desc,
                saving_throws: (v.saves || []).map(a => ({ index: a, name: a.toUpperCase() })),
                // Specific grants a clone carried over (e.g. "shortswords") survive the checkbox list.
                proficiencies: [...(v.profs || []).map(index => ({ index })), ...((previous && previous.extraProfs) || [])],
                proficiency_choices: (v.skillPool || []).length && v.skillChoose > 0 ? [{
                    choose: Math.min(v.skillChoose, v.skillPool.length), type: 'proficiencies',
                    from: { option_set_type: 'options_array', options: v.skillPool.map(s => ({ option_type: 'reference', item: { index: 'skill-' + s, name: 'Skill: ' + skillName(s) } })) }
                }] : [],
                caster: v.caster,
                spellcasting: v.caster !== 'none' ? { spellcasting_ability: { index: v.castAbility, name: String(v.castAbility).toUpperCase() } } : null,
                spellList: v.caster !== 'none' ? (v.spellList || null) : null,
                customFeatures: v.customFeatures
            })
        },
        subclass: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Assassin' },
                { path: 'class', label: 'Subclass of', type: 'select', options: classOptions },
                { path: 'subclass_flavor', label: 'Label (e.g. Roguish Archetype)', type: 'text' },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true }
            ],
            lists: { features: { title: 'Features by level', withLevel: true } },
            toView: s => ({
                name: s.name, class: s.class && s.class.index, subclass_flavor: s.subclass_flavor || '',
                desc: Array.isArray(s.desc) ? s.desc.join(' ') : (s.desc || ''), features: s.features || []
            }),
            toData: v => ({
                name: v.name, class: { index: v.class, name: (SRD.get('classes', v.class) || {}).name },
                subclass_flavor: v.subclass_flavor, desc: v.desc, features: v.features
            })
        },
        background: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Charlatan' },
                { path: 'languageChoice', label: 'Extra language picks', type: 'number', min: 0, max: 6 },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true },
                { path: 'skills', label: 'Skill proficiencies', type: 'skills', wide: true },
                { path: 'tools', label: 'Tool proficiencies', type: 'csv', placeholder: 'Disguise kit, Forgery kit', wide: true },
                { path: 'languages', label: 'Fixed languages', type: 'csv', wide: true },
                { path: 'equipment', label: 'Starting equipment', type: 'textarea', wide: true },
                { path: 'source', label: 'Source (book or setting)', type: 'text', wide: true },
                { path: 'traitLines', label: 'Suggested personality traits (one per line)', type: 'textarea', rows: 4, wide: true },
                { path: 'idealLines', label: 'Suggested ideals (one per line)', type: 'textarea', rows: 3, wide: true },
                { path: 'bondLines', label: 'Suggested bonds (one per line)', type: 'textarea', rows: 3, wide: true },
                { path: 'flawLines', label: 'Suggested flaws (one per line)', type: 'textarea', rows: 3, wide: true }
            ],
            lists: { features: { title: 'Features', addLabel: '+ Add feature' } },
            toView: b => ({
                name: b.name, desc: b.desc || '', skills: refsToSkills(b.starting_proficiencies), tools: b.tools || [],
                languages: languageNames(b.languages),
                languageChoice: b.languageChoice || (b.language_options && b.language_options.choose) || 0,
                equipment: b.equipment || '', source: b.custom ? (b.source || '') : '',
                traitLines: suggestionLines(b.personality_traits), idealLines: suggestionLines(b.ideals),
                bondLines: suggestionLines(b.bonds), flawLines: suggestionLines(b.flaws),
                // No editor for these yet: they ride along untouched.
                kept: { tables: b.tables, starting_equipment: b.starting_equipment, starting_gold: b.starting_gold },
                features: b.features || (b.feature ? [{ name: b.feature.name, desc: (b.feature.desc || []).join('\n\n') }] : [])
            }),
            toData: (v, previous) => ({
                name: v.name, desc: v.desc, starting_proficiencies: skillsToRefs(v.skills), tools: v.tools,
                languages: v.languages, languageChoice: v.languageChoice || 0, equipment: v.equipment, features: v.features,
                source: v.source, ...((previous && previous.kept) || {}),
                personality_traits: suggestionTable(v.traitLines, 2), ideals: suggestionTable(v.idealLines, 1),
                bonds: suggestionTable(v.bondLines, 1), flaws: suggestionTable(v.flawLines, 1)
            })
        },
        feat: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Sentinel' },
                { path: 'desc', label: 'Rules text', type: 'textarea', rows: 5, wide: true }
            ],
            mechanics: [PREREQ_GROUP, ...MECH_GROUPS],
            toView: f => ({ ...f, desc: Array.isArray(f.desc) ? f.desc.join('\n\n') : (f.desc || '') }),
            toData: v => cleanFeature(v)
        },
        spell: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Ember Lance' },
                { path: 'level', label: 'Level (0 = cantrip)', type: 'number', min: 0, max: 9, keepZero: true },
                { path: 'school', label: 'School', type: 'select', options: SCHOOLS.map(s => [s, s]) },
                { path: 'classes', label: 'On the spell list of', type: 'checks', options: () => SRD.classes.filter(c => SRD.isCaster(c.index)).map(c => [c.index, c.name]), wide: true },
                { path: 'casting_time', label: 'Casting time', type: 'text', placeholder: '1 action' },
                { path: 'range', label: 'Range', type: 'text', placeholder: '60 feet' },
                { path: 'duration', label: 'Duration', type: 'text', placeholder: 'Instantaneous' },
                { path: 'components', label: 'Components', type: 'checks', options: [['V', 'Verbal'], ['S', 'Somatic'], ['M', 'Material']] },
                { path: 'material', label: 'Material', type: 'text' },
                { path: 'concentration', label: 'Concentration', type: 'bool' },
                { path: 'ritual', label: 'Ritual', type: 'bool' },
                { path: 'desc', label: 'Description', type: 'textarea', rows: 5, wide: true },
                { path: 'higher_level', label: 'At higher levels', type: 'textarea', wide: true },
                { path: 'resolve', label: 'In combat it…', type: 'select', options: [['', 'has no automated damage'], ['ranged', 'makes a ranged spell attack'], ['melee', 'makes a melee spell attack'], ['save', 'forces a saving throw']] },
                { path: 'saveAbility', label: 'Save', type: 'select', options: ABILITY_OPTS },
                { path: 'saveSuccess', label: 'On a successful save', type: 'select', options: [['half', 'Half damage'], ['none', 'No damage']] },
                { path: 'damageType', label: 'Damage type', type: 'text', placeholder: 'fire' },
                { path: 'damage', label: 'Damage at base level', type: 'text', placeholder: '3d8' },
                { path: 'scaling', label: 'Scaling (slot level:dice — character level for cantrips)', type: 'scaling', placeholder: '4:4d8, 5:5d8', wide: true }
            ],
            toView: s => {
                const table = (s.damage && (s.damage.damage_at_slot_level || s.damage.damage_at_character_level)) || {};
                const levels = Object.keys(table).map(Number).sort((a, b) => a - b);
                return {
                    name: s.name, level: s.level || 0, school: (s.school && s.school.name) || 'Evocation',
                    classes: (s.classes || []).map(c => c.index), casting_time: s.casting_time || '1 action', range: s.range || '',
                    duration: s.duration || 'Instantaneous', components: s.components || [], material: s.material || '',
                    concentration: !!s.concentration, ritual: !!s.ritual,
                    desc: (Array.isArray(s.desc) ? s.desc : [s.desc]).filter(Boolean).join('\n\n'),
                    higher_level: (Array.isArray(s.higher_level) ? s.higher_level : [s.higher_level]).filter(Boolean).join('\n\n'),
                    resolve: s.attack_type || (s.dc ? 'save' : ''),
                    saveAbility: (s.dc && s.dc.dc_type && s.dc.dc_type.index) || 'dex', saveSuccess: (s.dc && s.dc.dc_success) || 'half',
                    damageType: (s.damage && s.damage.damage_type && s.damage.damage_type.name) || '',
                    damage: levels.length ? table[levels[0]] : '',
                    scaling: levels.slice(1).map(level => ({ level, damage: table[level] }))
                };
            },
            toData: v => {
                const level = v.level || 0;
                const table = {};
                if (v.damage) table[level === 0 ? 1 : level] = v.damage;
                for (const tier of v.scaling || []) table[tier.level] = tier.damage;
                const data = {
                    name: v.name, level, school: { name: v.school }, classes: (v.classes || []).map(index => ({ index, name: (SRD.get('classes', index) || {}).name })),
                    casting_time: v.casting_time, range: v.range, duration: v.duration, components: v.components, material: v.material,
                    concentration: !!v.concentration, ritual: !!v.ritual,
                    desc: String(v.desc || '').split(/\n{2,}/).filter(Boolean), higher_level: String(v.higher_level || '').split(/\n{2,}/).filter(Boolean)
                };
                if (v.resolve === 'ranged' || v.resolve === 'melee') data.attack_type = v.resolve;
                if (v.resolve === 'save') data.dc = { dc_type: { index: v.saveAbility }, dc_success: v.saveSuccess };
                if (Object.keys(table).length && v.resolve) {
                    data.damage = { damage_type: { name: v.damageType || 'force' }, [level === 0 ? 'damage_at_character_level' : 'damage_at_slot_level']: table };
                }
                return data;
            }
        },
        item: {
            fields: [
                { path: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Flametongue Rapier' },
                { path: 'kind', label: 'Kind', type: 'select', options: [['weapon', 'Weapon'], ['armor', 'Armor'], ['gear', 'Gear / wondrous item']] },
                { path: 'bonus', label: 'Magic bonus (+N to hit & damage, or AC)', type: 'number', min: -3, max: 5 },
                { path: 'cost', label: 'Cost', type: 'text', placeholder: '50 gp' },
                { path: 'weight', label: 'Weight (lb)', type: 'number', min: 0, max: 9999 },
                { path: 'desc', label: 'Description', type: 'textarea', wide: true },
                { path: 'weapon_category', label: 'Weapon: category', type: 'select', options: [['Simple', 'Simple'], ['Martial', 'Martial']] },
                { path: 'weapon_range', label: 'Weapon: type', type: 'select', options: [['Melee', 'Melee'], ['Ranged', 'Ranged']] },
                { path: 'damageDice', label: 'Weapon: damage dice', type: 'text', placeholder: '1d8' },
                { path: 'damageType', label: 'Weapon: damage type', type: 'text', placeholder: 'Piercing' },
                { path: 'twoHanded', label: 'Weapon: two-handed dice (versatile)', type: 'text', placeholder: '1d10' },
                { path: 'rangeNormal', label: 'Weapon: range / reach (ft)', type: 'number', min: 0, max: 600 },
                { path: 'rangeLong', label: 'Weapon: long range (ft)', type: 'number', min: 0, max: 2400 },
                { path: 'properties', label: 'Weapon: properties', type: 'checks', options: WEAPON_PROPS.map(p => [p, p]), wide: true },
                { path: 'armor_category', label: 'Armor: category', type: 'select', options: ['Light', 'Medium', 'Heavy'].map(s => [s, s]) },
                { path: 'acBase', label: 'Armor: base AC', type: 'number', min: 0, max: 30 },
                { path: 'acDex', label: 'Armor: add Dex modifier', type: 'bool', default: true },
                { path: 'acMaxDex', label: 'Armor: max Dex bonus (blank = none)', type: 'number', min: 0, max: 10, keepZero: true },
                { path: 'str_minimum', label: 'Armor: Strength required', type: 'number', min: 0, max: 30 },
                { path: 'stealth_disadvantage', label: 'Armor: disadvantage on Stealth', type: 'bool' }
            ],
            mechanics: [MECH_GROUPS[0]],
            mechanicsTitle: 'Bonuses while carried',
            toView: it => {
                const category = it.equipment_category && it.equipment_category.index;
                return {
                    name: it.name, kind: it.kind || (category === 'weapon' ? 'weapon' : category === 'armor' ? 'armor' : 'gear'),
                    bonus: it.bonus || 0, cost: typeof it.cost === 'string' ? it.cost : (it.cost ? `${it.cost.quantity} ${it.cost.unit}` : ''),
                    weight: it.weight || 0, desc: Array.isArray(it.desc) ? it.desc.join('\n\n') : (it.desc || ''),
                    weapon_category: it.weapon_category || 'Simple', weapon_range: it.weapon_range || 'Melee',
                    damageDice: (it.damage && it.damage.damage_dice) || '', damageType: (it.damage && it.damage.damage_type && it.damage.damage_type.name) || '',
                    twoHanded: (it.two_handed_damage && it.two_handed_damage.damage_dice) || '',
                    rangeNormal: (it.range && it.range.normal) || 5, rangeLong: (it.range && it.range.long) || 0,
                    properties: (it.properties || []).map(p => p.index),
                    armor_category: it.armor_category || 'Light', acBase: (it.armor_class && it.armor_class.base) || 11,
                    acDex: !it.armor_class || it.armor_class.dex_bonus !== false,
                    acMaxDex: it.armor_class && it.armor_class.max_bonus != null ? it.armor_class.max_bonus : null,
                    str_minimum: it.str_minimum || 0, stealth_disadvantage: !!it.stealth_disadvantage, grants: it.grants || {}
                };
            },
            toData: v => {
                const data = { name: v.name, kind: v.kind, bonus: v.bonus || 0, cost: v.cost, weight: v.weight || 0, desc: v.desc, grants: prune(v.grants || {}) };
                if (v.kind === 'weapon') Object.assign(data, {
                    weapon_category: v.weapon_category, weapon_range: v.weapon_range,
                    damage: { damage_dice: v.damageDice || '1d4', damage_type: { name: v.damageType || 'Bludgeoning' } },
                    two_handed_damage: v.twoHanded ? { damage_dice: v.twoHanded } : null,
                    range: { normal: v.rangeNormal || 5, long: v.rangeLong || null },
                    properties: (v.properties || []).map(index => ({ index, name: index }))
                });
                if (v.kind === 'armor') Object.assign(data, {
                    armor_category: v.armor_category,
                    armor_class: { base: v.acBase || 11, dex_bonus: v.acDex !== false, max_bonus: v.acMaxDex },
                    str_minimum: v.str_minimum || 0, stealth_disadvantage: !!v.stealth_disadvantage
                });
                return data;
            }
        }
    };

    // ---- SRD templates -----------------------------------------------------
    // Cloning materialises the built-in SRD mechanics (rules.js) into editable
    // homebrew data — that is how "a better Dragonborn" starts from the real one.
    function materialize(raw, ctx) {
        const base = { name: raw.name, desc: (Array.isArray(raw.desc) ? raw.desc.join('\n\n') : (raw.desc || '')).slice(0, 4000) };
        if (raw.level) base.level = raw.level;
        const builtin = raw.index && SRD_MECHANICS[raw.index];
        const extra = builtin ? (builtin(ctx) || {}) : {};
        if (extra.hide) return [];
        const strip = option => { const { set, ...rest } = option; return rest; };
        const main = { ...base };
        if (raw.grants || extra.grants) main.grants = raw.grants || extra.grants;
        if (raw.rider || extra.rider) main.rider = raw.rider || extra.rider;
        if (raw.resource || extra.resource) main.resource = raw.resource || extra.resource;
        if (raw.choice || extra.choice) {
            const choice = raw.choice || extra.choice;
            main.choice = { choose: choice.choose, options: choice.options.map(option => ctx.optionAction ? { ...strip(option), ...ctx.optionAction(option) } : strip(option)) };
        }
        const actions = raw.action ? [raw.action] : (extra.actions || []);
        if (actions.length === 1 && !ctx.dropActions) main.action = actions[0];
        const out = [main];
        // A feature with several actions becomes one row per action.
        if (actions.length > 1) for (const action of actions) {
            const { name, ...rest } = action;
            out.push({ name: name || raw.name, desc: '', ...(raw.level ? { level: raw.level } : {}), action: rest });
        }
        return out;
    }
    function classFeatureRows(features, classIdx) {
        const rows = [];
        for (const feature of features.slice().sort((a, b) => (a.level || 1) - (b.level || 1))) {
            let last = null;
            for (let level = feature.level || 1; level <= 20; level++) {
                const spec = (SRD.classLevelData(classIdx, level) || {}).class_specific || {};
                const made = materialize({ ...feature, level }, { SRD, vars: {}, classLevel: level, level, spec });
                const signature = JSON.stringify(made.map(({ desc, level: _l, ...mech }) => mech));
                if (level === (feature.level || 1)) { rows.push(...made); last = signature; }
                else if (signature !== last) {
                    // Only the mechanics changed: add upgrade rows without repeating the prose.
                    rows.push(...made.map(row => ({ ...row, desc: '' })));
                    last = signature;
                }
            }
        }
        return rows.slice(0, 120);
    }
    function template(sourceType, entry) {
        const ctx = { SRD, vars: {}, classLevel: 1, level: 1, spec: {} };
        if (sourceType === 'race') {
            const traits = entry.traits || [];
            const breath = traits.some(t => t.index === 'breath-weapon') && traits.some(t => t.index === 'draconic-ancestry');
            return {
                ...entry,
                traits: traits.flatMap(trait => materialize(trait, {
                    ...ctx,
                    dropActions: breath && trait.index === 'breath-weapon',
                    optionAction: breath && trait.index === 'draconic-ancestry'
                        ? option => ({ action: { name: 'Breath Weapon', ...SRD_MECHANICS['breath-weapon']({ ...ctx, vars: option.set || {} }).actions[0] } })
                        : null
                }))
            };
        }
        if (sourceType === 'subrace') {
            return { ...entry, traits: (entry.traits || entry.racial_traits || []).flatMap(t => materialize(t, ctx)) };
        }
        if (sourceType === 'class') {
            if (entry.custom) return entry;
            const type = SRD.casterType(entry.index);
            return {
                ...entry, caster: type || 'none', spellList: SPELL_LISTS.includes(entry.index) ? entry.index : null,
                subclassLevel: SRD.subclassChoiceLevel(entry.index),
                customFeatures: classFeatureRows(SRD.features.filter(f => f.class && f.class.index === entry.index && !f.subclass), entry.index)
            };
        }
        if (sourceType === 'subclass') {
            if (entry.custom) return entry;
            return { ...entry, features: classFeatureRows(SRD.features.filter(f => f.subclass && f.subclass.index === entry.index), entry.class.index) };
        }
        if (sourceType === 'feat') return materialize(entry, ctx)[0] ? { ...entry, ...materialize(entry, ctx)[0], prereq: entry.prereq } : entry;
        return entry;
    }

    // ---- rendering ---------------------------------------------------------
    function resolveOptions(spec) { return typeof spec.options === 'function' ? { ...spec, options: spec.options() } : spec; }
    function render(view = null, previous = null) {
        const def = FORMS[type];
        const data = view || def.toView({ name: '' });
        const srdList = (SRD[SRD_SOURCE[type]] || []).filter(x => type !== 'item' || ['weapon', 'armor', 'adventuring-gear'].includes(x.equipment_category && x.equipment_category.index));
        root.innerHTML = `
            <div class="panel-heading"><h2>Rules content</h2><span class="pill" id="rules-edit-badge">${editingIndex ? 'editing' : 'new'}</span></div>
            <div class="type-tabs">${RULE_TYPES.map(([key, label]) => `<button type="button" class="type-tab ${key === type ? 'active' : ''}" data-type="${key}">${label}</button>`).join('')}</div>
            <div class="template-row"><div class="row">
                <label class="fld">Start from an existing ${esc(type)}</label>
                <div class="inline-control"><select id="rules-template"><option value="">Choose…</option>${srdList.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${esc(x.index)}">${esc(x.name)}${x.custom ? ' (homebrew)' : ''}</option>`).join('')}</select>
                <button class="btn btn-sm" id="rules-use-template" type="button">Use as template</button></div>
                <div class="field-hint">Copies it into a new homebrew ${esc(type)} with its mechanics filled in, ready to change. The original is never modified.</div>
            </div></div>
            <datalist id="hb-skill-names">${SRD.skills.map(s => `<option value="${esc(s.name)}"></option>`).join('')}</datalist>
            <div class="rules-form" data-editor="form">
                <div class="mech-grid top">${def.fields.map(spec => fieldHTML(resolveOptions(spec), getPath(data, spec.path))).join('')}</div>
                ${def.mechanics ? `<h3 class="section-title">${esc(def.mechanicsTitle || 'Mechanics')}</h3><div class="top-mech">${mechanicsHTML(data, def.mechanics)}</div>` : ''}
                ${Object.entries(def.lists || {}).map(([key, list]) => `<h3 class="section-title">${esc(list.title)}</h3>${list.hint ? `<div class="field-hint">${esc(list.hint)}</div>` : ''}<div data-list="${key}"></div>`).join('')}
            </div>
            <div class="form-actions"><button class="btn btn-accent" id="rules-save">Save ${esc(type)}</button><button class="btn" id="rules-reset" type="button">Reset</button></div>
            <div class="msg" id="rules-msg"></div>`;
        const editors = {};
        for (const [key, list] of Object.entries(def.lists || {})) {
            editors[key] = featureEditor({ withLevel: !!list.withLevel, addLabel: list.addLabel });
            editors[key].setValue(data[key] || []);
            root.querySelector(`[data-list="${key}"]`).appendChild(editors[key].el);
        }
        form = {
            read() {
                const viewOut = {};
                root.querySelectorAll('.rules-form > .mech-grid.top [data-path], .rules-form > .top-mech [data-path]').forEach(el => setPath(viewOut, el.dataset.path, readField(el)));
                for (const [key, editor] of Object.entries(editors)) viewOut[key] = editor.getValue();
                return def.toData(viewOut, previous);
            }
        };
        root.querySelectorAll('.type-tab').forEach(btn => btn.onclick = () => { type = btn.dataset.type; editingIndex = null; render(); });
        root.querySelector('#rules-reset').onclick = () => { editingIndex = null; render(); };
        root.querySelector('#rules-use-template').onclick = () => {
            const index = root.querySelector('#rules-template').value;
            const entry = index && SRD.get(SRD_SOURCE[type], index);
            if (!entry) return notify('Choose something to copy first', true);
            editingIndex = null;
            const copy = template(type, JSON.parse(JSON.stringify(entry)));
            const viewCopy = def.toView(copy);
            viewCopy.name = entry.custom ? `${entry.name} copy` : `Improved ${entry.name}`;
            render(viewCopy, viewCopy);
            notify(`Loaded ${entry.name} as a new ${type}`);
        };
        root.querySelector('#rules-save').onclick = () => {
            const socket = getSocket();
            if (!socket || !socket.connected) return notify('Not connected', true);
            const data = form.read();
            if (!data.name) return notify('Enter a name', true);
            if (editingIndex) data.index = editingIndex;
            onNotify('pending', type);
            socket.emit('save-homebrew', { type, data });
        };
    }
    function notify(text, error = false) {
        const el = root.querySelector('#rules-msg');
        if (!el) return;
        el.textContent = text; el.style.color = error ? '#f87171' : '#34d399';
        setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
    }

    render();
    return {
        types: RULE_TYPES,
        handles: t => RULE_TYPES.some(([key]) => key === t),
        edit(itemType, item) {
            type = itemType; editingIndex = item.index;
            const view = FORMS[type].toView(JSON.parse(JSON.stringify(item)));
            render(view, view);
            root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
        saved(itemType, name) { if (itemType === type) { editingIndex = null; render(); } notify(`Saved "${name}"`); },
        error(text) { notify(text, true); }
    };
}
