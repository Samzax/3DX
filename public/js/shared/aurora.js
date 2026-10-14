// aurora.js — imports an Aurora Builder character file (.dnd5e, XML) into the
// creator's character shape. Pure (no DOM; importable in Node).
//
// An Aurora file names every choice by element id but carries almost no rules
// text, so matchAurora() resolves names against the table's SRD + homebrew
// content and, for anything missing (a non-SRD race, archetype or background),
// returns a homebrew stub built from what the file does record — trait names,
// granted skills/tools/languages, senses — for the GM to flesh out.
//
// The second half reads Aurora's own content files (the element XML under its
// "custom" folder): auroraBackgrounds() turns every Background element into a
// homebrew background record. tools/import-aurora-backgrounds.mjs runs it over
// a local Aurora install; none of that text ships with this repo.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, code) => {
    if (code[0] === '#') {
        const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code] ?? whole;
});

// A small tolerant XML reader: elements, attributes, text and CDATA. Comments,
// processing instructions and doctypes are skipped. → { name, attrs, children, text, parts }
// (parts keeps text and child elements in document order, for mixed content.)
export function parseXML(source) {
    const src = String(source || '').replace(/^﻿/, '');
    const root = { name: '#root', attrs: {}, children: [], text: '', parts: [] };
    const stack = [root];
    let i = 0;
    while (i < src.length) {
        const top = stack[stack.length - 1];
        if (src[i] !== '<') {
            const next = src.indexOf('<', i);
            const end = next < 0 ? src.length : next;
            const chunk = decode(src.slice(i, end));
            top.text += chunk;
            top.parts.push(chunk);
            i = end;
        } else if (src.startsWith('<!--', i)) {
            const end = src.indexOf('-->', i);
            i = end < 0 ? src.length : end + 3;
        } else if (src.startsWith('<![CDATA[', i)) {
            const end = src.indexOf(']]>', i);
            const chunk = src.slice(i + 9, end < 0 ? src.length : end);
            top.text += chunk;
            top.parts.push(chunk);
            i = end < 0 ? src.length : end + 3;
        } else if (src[i + 1] === '?' || src[i + 1] === '!') {
            const end = src.indexOf('>', i);
            i = end < 0 ? src.length : end + 1;
        } else if (src[i + 1] === '/') {
            const end = src.indexOf('>', i);
            if (stack.length > 1) stack.pop();
            i = end < 0 ? src.length : end + 1;
        } else {
            const end = src.indexOf('>', i);
            if (end < 0) break;
            const selfClosing = src[end - 1] === '/';
            const body = src.slice(i + 1, selfClosing ? end - 1 : end);
            const name = (/^[^\s/]+/.exec(body) || [''])[0];
            const attrs = {};
            const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
            let m;
            while ((m = attrRe.exec(body))) attrs[m[1]] = decode(m[2] != null ? m[2] : m[3]);
            const node = { name, attrs, children: [], text: '', parts: [] };
            top.children.push(node);
            top.parts.push(node);
            if (!selfClosing) stack.push(node);
            i = end + 1;
        }
    }
    return root;
}

const child = (node, name) => node && node.children.find(c => c.name === name);
const textOf = (node, ...path) => {
    let current = node;
    for (const name of path) current = child(current, name);
    return current ? current.text.trim() : '';
};
function walk(node, visit, ancestors = []) {
    for (const c of node.children) {
        visit(c, ancestors);
        walk(c, visit, [...ancestors, c]);
    }
}
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// "ID_WOTC_PHB_ARCHETYPE_WAY_OF_THE_OPEN_HAND", after "ARCHETYPE" → "Way of the Open Hand"
function nameFromId(id, marker) {
    const upper = String(id || '').toUpperCase();
    const at = upper.lastIndexOf('_' + marker + '_');
    if (at < 0) return '';
    const small = new Set(['of', 'the', 'and', 'in', 'to']);
    return upper.slice(at + marker.length + 2).split('_').filter(Boolean)
        .map((word, index) => {
            const lower = word.toLowerCase();
            return index > 0 && small.has(lower) ? lower : lower[0].toUpperCase() + lower.slice(1);
        }).join(' ');
}
const inParens = (s) => (/\(([^)]+)\)/.exec(String(s || '')) || [])[1] || '';

// The raw facts in an Aurora character file, before matching to table content.
export function parseAuroraCharacter(source) {
    const doc = parseXML(source);
    const character = child(doc, 'character');
    if (!character) throw new Error('not an Aurora character file');
    const display = child(character, 'display-properties');
    const build = child(character, 'build');
    if (!display || !build) throw new Error('the character file has no build data');
    const input = child(build, 'input');
    const elements = child(build, 'elements') || { children: [] };

    const abilityNames = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
    const abilityNode = child(build, 'abilities');
    const abilities = {};
    for (const [key, name] of Object.entries(abilityNames)) {
        const value = parseInt(textOf(abilityNode, name), 10);
        abilities[key] = Number.isFinite(value) ? Math.max(1, Math.min(30, value)) : 10;
    }

    // "Rogue (3) / Monk (3)"
    const classes = textOf(display, 'class').split('/').map(part => {
        const m = /^\s*(.+?)\s*\((\d+)\)\s*$/.exec(part);
        return m ? { name: m[1], level: Math.max(1, Math.min(20, parseInt(m[2], 10))), subclass: null, subclassFeatures: [] }
            : (part.trim() ? { name: part.trim(), level: 1, subclass: null, subclassFeatures: [] } : null);
    }).filter(Boolean);
    if (classes.length === 1 && !/\(\d+\)/.test(textOf(display, 'class'))) {
        classes[0].level = Math.max(1, Math.min(20, parseInt(textOf(display, 'level'), 10) || 1));
    }

    const skills = new Set(), expertise = new Set(), languages = new Set();
    const race = { name: textOf(display, 'race'), size: 'Medium', darkvision: 0, traits: [], skills: [], languages: [] };
    const background = { name: textOf(display, 'background'), skills: [], tools: [], feature: null };
    const skillOf = (id) => (/^ID_PROFICIENCY_SKILL_(.+)$/.exec(String(id || '')) || [])[1] || null;
    const toolOf = (name) => /^Tool Proficiency/i.test(String(name || '')) ? inParens(name) : '';

    walk(elements, (node, ancestors) => {
        if (node.name !== 'element') return;
        const type = node.attrs.type;
        const id = node.attrs.registered || node.attrs.id || '';
        const parentTypes = ancestors.filter(a => a.name === 'element').map(a => a.attrs.type);
        const inRace = parentTypes.includes('Race');
        const inBackground = parentTypes.includes('Background');
        if (type === 'Proficiency') {
            const skill = skillOf(id);
            if (skill) {
                skills.add(skill);
                if (inRace) race.skills.push(skill);
                if (inBackground) background.skills.push(skill);
            }
            const tool = toolOf(node.attrs.name);
            if (tool && inBackground && !background.tools.includes(tool)) background.tools.push(tool);
        } else if (/^ID_EXPERTISE_SKILL_/.test(id)) {
            expertise.add(id.replace('ID_EXPERTISE_SKILL_', ''));
        } else if (type === 'Language') {
            // A chosen language keeps the slot's label as its name; the pick is the id.
            const chosen = !!node.attrs.registered;
            const name = chosen ? nameFromId(id, 'LANGUAGE') : node.attrs.name;
            if (name) {
                languages.add(name);
                if (inRace && !chosen) race.languages.push(name);
            }
        } else if (type === 'Size' && inRace) {
            race.size = node.attrs.name || 'Medium';
        } else if (type === 'Vision' && inRace && /darkvision/i.test(node.attrs.name || '')) {
            race.darkvision = /superior/i.test(node.attrs.name) ? 120 : 60;
        } else if (type === 'Racial Trait') {
            race.traits.push({ name: node.attrs.name || 'Trait' });
        } else if (type === 'Archetype' && node.attrs.registered) {
            // The owning class is the nearest Class / Multiclass ancestor.
            const owner = [...ancestors].reverse().find(a => a.name === 'element' && (a.attrs.type === 'Class' || a.attrs.type === 'Multiclass'));
            const ownerName = owner ? nameFromId(owner.attrs.registered || '', owner.attrs.type === 'Class' ? 'CLASS' : 'MULTICLASS') : '';
            const target = classes.find(c => squash(c.name) === squash(ownerName)) || classes[0];
            if (target) {
                target.subclass = nameFromId(node.attrs.registered, 'ARCHETYPE');
                walk(node, (inner) => {
                    if (inner.name !== 'element' || inner.attrs.type !== 'Archetype Feature') return;
                    const tools = inner.children.filter(c => c.name === 'element').map(c => toolOf(c.attrs.name)).filter(Boolean);
                    target.subclassFeatures.push({ name: inner.attrs.name || 'Feature', tools });
                });
            }
        }
    });

    const featureNode = child(child(input, 'background'), 'feature');
    if (featureNode) background.feature = { name: featureNode.attrs.name || 'Feature', desc: textOf(featureNode, 'description') };

    const appearance = child(build, 'appearance');
    const notes = [
        ['Backstory', textOf(input, 'backstory')],
        ['Gender', textOf(input, 'gender')],
        ['Height', textOf(appearance, 'height')],
        ['Weight', textOf(appearance, 'weight')],
        ['Additional features', textOf(input, 'additional-features')]
    ].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n\n');

    const personality = {};
    for (const key of ['traits', 'ideals', 'bonds', 'flaws']) {
        const value = textOf(input, 'background-' + key);
        if (value) personality[key] = value.slice(0, 600);
    }

    return {
        name: textOf(display, 'name') || textOf(input, 'name') || 'Imported character',
        abilities, classes, race, background, personality,
        skills: [...skills], expertise: [...expertise], languages: [...languages], notes
    };
}

const findByName = (list, name) => {
    const key = squash(name);
    if (!key) return null;
    return list.find(x => squash(x.name) === key)
        || list.find(x => squash(x.name).includes(key) || key.includes(squash(x.name)))
        || null;
};

// Resolve a parsed Aurora character against the table's rules content.
// → { char, missing: [{ type, label, stub, apply(index) }], warnings: [string] }
export function matchAurora(parsed, SRD) {
    const warnings = [];
    const missing = [];
    const skillIndex = (aurora) => (SRD.skills.find(s => squash(s.name) === squash(aurora)) || {}).index || null;
    const skillRefs = (list) => [...new Set(list.map(skillIndex).filter(Boolean))].map(index => ({
        index: 'skill-' + index, name: 'Skill: ' + (SRD.get('skills', index) || {}).name
    }));

    const char = {
        name: parsed.name, schemaVersion: 2,
        race: 'human', subrace: null, background: 'acolyte', alignment: null,
        classes: [], abilityMethod: 'manual', abilities: { ...parsed.abilities }, racialChoice: [], racialSpread: null,
        skills: parsed.skills.map(skillIndex).filter(Boolean),
        expertise: parsed.expertise.map(skillIndex).filter(Boolean),
        languages: [], feats: [], choices: {}, notes: parsed.notes, personality: { ...(parsed.personality || {}) },
        equipment: { armor: null, shield: false, weapons: [], items: [] }, spells: []
    };

    // Race (a subrace name such as "Hill Dwarf" resolves to race + subrace).
    const subrace = findByName(SRD.subraces, parsed.race.name);
    const race = SRD.races.find(r => squash(r.name) === squash(parsed.race.name))
        || (subrace && SRD.get('races', subrace.race.index)) || null;
    if (race) {
        char.race = race.index;
        if (subrace && subrace.race.index === race.index) char.subrace = subrace.index;
    } else if (parsed.race.name) {
        const traits = parsed.race.traits.map(t => ({ name: t.name, desc: '' }));
        if (parsed.race.darkvision) traits.unshift({ name: 'Darkvision', desc: '', grants: { darkvision: parsed.race.darkvision } });
        missing.push({
            type: 'race', label: `race “${parsed.race.name}”`,
            stub: {
                name: parsed.race.name, size: parsed.race.size, speed: 30, ability_bonuses: [],
                starting_proficiencies: skillRefs(parsed.race.skills), languages: parsed.race.languages, traits
            },
            apply: (index) => { char.race = index; char.subrace = null; }
        });
        warnings.push(`${parsed.race.name}: the file does not record racial ability bonuses, speed or trait rules — set them in the Homebrew builder.`);
    }
    const racialLanguages = new Set(parsed.race.languages.map(squash));
    char.languages = parsed.languages.filter(l => !racialLanguages.has(squash(l)));

    // Classes and archetypes.
    for (const entry of parsed.classes.slice(0, 3)) {
        const cls = SRD.classes.find(c => squash(c.name) === squash(entry.name));
        if (!cls) { warnings.push(`Class “${entry.name}” is not available here — create it in the Homebrew builder, then re-import.`); continue; }
        const slot = { class: cls.index, subclass: null, level: entry.level };
        char.classes.push(slot);
        if (!entry.subclass) continue;
        if (entry.level < SRD.subclassChoiceLevel(cls.index)) continue;
        const sub = findByName(SRD.subclassesForClass(cls.index), entry.subclass);
        if (sub) { slot.subclass = sub.index; continue; }
        const level = SRD.subclassChoiceLevel(cls.index);
        missing.push({
            type: 'subclass', label: `${cls.name} archetype “${entry.subclass}”`,
            stub: {
                name: entry.subclass, class: { index: cls.index, name: cls.name },
                features: entry.subclassFeatures.map(f => ({
                    level, name: f.name, desc: '', ...(f.tools.length ? { grants: { proficiencies: f.tools } } : {})
                }))
            },
            apply: (index) => { slot.subclass = index; }
        });
        warnings.push(`${entry.subclass}: only feature names are in the file — add their rules text in the Homebrew builder.`);
    }
    if (!char.classes.length) char.classes.push({ class: 'fighter', subclass: null, level: 1 });

    // Background.
    const background = SRD.backgrounds.find(b => squash(b.name) === squash(parsed.background.name));
    if (background) char.background = background.index;
    else if (parsed.background.name) {
        missing.push({
            type: 'background', label: `background “${parsed.background.name}”`,
            stub: {
                name: parsed.background.name,
                starting_proficiencies: skillRefs(parsed.background.skills),
                tools: parsed.background.tools,
                features: parsed.background.feature ? [parsed.background.feature] : []
            },
            apply: (index) => { char.background = index; }
        });
    }
    return { char, missing, warnings };
}

// --- Aurora content files → homebrew backgrounds -----------------------------
const BLOCK_TAGS = new Set(['p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'thead', 'tbody', 'div', 'br', 'blockquote']);
const CELL_END = '\u0001', BLOCK_END = '\u0002';
// Mixed-content markup → plain text: one line per block, table cells joined.
export function plainText(node) {
    if (!node) return '';
    const flatten = (n) => (n.parts || []).map(part => {
        if (typeof part === 'string') return part;
        const inner = flatten(part);
        if (part.name === 'td' || part.name === 'th') return inner + CELL_END;
        return BLOCK_TAGS.has(part.name) ? BLOCK_END + inner + BLOCK_END : inner;
    }).join('');
    return flatten(node).replace(/\s+/g, ' ')
        .split(BLOCK_END).map(row => row.split(CELL_END).map(cell => cell.trim()).filter(Boolean).join(' — '))
        .filter(Boolean).join('\n');
}

// Every element of one content file. → [{ id, name, type, source, supports, node }]
export function parseAuroraElements(source) {
    const root = child(parseXML(source), 'elements');
    if (!root) return [];
    return root.children.filter(c => c.name === 'element' && c.attrs.id).map(node => ({
        id: node.attrs.id, name: (node.attrs.name || '').trim(), type: node.attrs.type || '',
        source: (node.attrs.source || '').trim(),
        supports: textOf(node, 'supports').split(',').map(t => t.trim()).filter(Boolean), node
    }));
}

// What the converter needs to know about the table's rules: skill, tool and
// equipment names. Takes the SRD object (or the same collections read in Node).
export function auroraContext(SRD) {
    const ofType = (re) => (SRD.proficiencies || []).filter(p => re.test(p.type || '')).map(p => p.name);
    const isKit = (name) => /kit$/i.test(name);
    return {
        skills: (SRD.skills || []).map(s => ({ index: s.index, name: s.name, ability: s.ability_score && s.ability_score.index })),
        equipment: (SRD.equipment || []).map(e => ({ index: e.index, name: e.name })),
        tools: {
            artisan: ofType(/^Artisan/).filter(n => !isKit(n)), gaming: ofType(/^Gaming/), musical: ofType(/^Musical/),
            other: [...ofType(/^Artisan/).filter(isKit), ...ofType(/^Other/)], vehicles: ofType(/^Vehicles/)
        }
    };
}

const ABILITY_WORDS = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const titleCase = (words) => words.toLowerCase().split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const skillFromId = (id, ctx) => {
    const m = /PROFICIENCY_SKILL_(.+)$/.exec(String(id || '').trim());
    return m ? (ctx.skills.find(s => squash(s.name) === squash(m[1])) || {}).index || null : null;
};
function toolFromId(id, ctx) {
    const tail = String(id || '').trim().replace(/^.*PROFICIENCY_/, '').replace(/^(MUSICAL_INSTRUMENT|GAMING_SET|ARTISAN_TOOLS?|TOOL)_/, '');
    if (!tail) return '';
    const vehicle = /^VEHICLES?_(.+)$/.exec(tail);
    const key = vehicle ? squash(vehicle[1]) + 'vehicles' : squash(tail);
    const known = Object.values(ctx.tools).flat().find(name => squash(name) === key);
    // "CARPENTERS_TOOLS" → "Carpenter's Tools" when the table has no such tool.
    return known || titleCase(tail).replace(/^(\w+?)s (Tools|Supplies|Utensils|Kit)$/, "$1's $2");
}
const languageFromId = (id) => nameFromId(id, 'LANGUAGE') || titleCase(String(id || '').replace(/^ID_/, ''));

// supports="A, B || C": any group, with every tag of that group on the element.
function supportsMatch(element, expression) {
    const have = new Set(element.supports.map(t => t.toLowerCase()));
    return String(expression || '').split('||').some(group => {
        const tags = group.replace(/[()]/g, '').split(',').map(t => t.trim()).filter(Boolean);
        return tags.length && tags.every(t => t === element.id || have.has(t.toLowerCase()));
    });
}

// <select type="Proficiency" supports="…"> → a feature carrying the pick.
function proficiencyPick(attrs, choose, ctx) {
    const supports = String(attrs.supports || '');
    const skillNames = (list) => list.map(i => (ctx.skills.find(s => s.index === i) || {}).name || i).join(', ');
    if (/^\s*Skill\b/i.test(supports)) {
        const abilities = Object.keys(ABILITY_WORDS).filter(word => supports.toLowerCase().includes(word)).map(word => ABILITY_WORDS[word]);
        const from = abilities.length ? ctx.skills.filter(s => abilities.includes(s.ability)).map(s => s.index) : [];
        return { name: 'Skill proficiency', desc: `Choose ${choose}${from.length ? ' from: ' + skillNames(from) : ' of any skill'} (Skills tab).`, grants: { skillChoice: { choose, from } } };
    }
    let tools = [];
    if (supports.includes('ID_')) {
        const ids = supports.split(/\|+/).map(t => t.trim()).filter(Boolean);
        const skills = ids.map(id => skillFromId(id, ctx)).filter(Boolean);
        if (skills.length === ids.length) {
            return { name: 'Skill proficiency', desc: `Choose ${choose} from: ${skillNames(skills)} (Skills tab).`, grants: { skillChoice: { choose, from: skills } } };
        }
        tools = ids.filter(id => !skillFromId(id, ctx)).map(id => toolFromId(id, ctx));
    } else {
        for (const tag of supports.split('||').map(t => squash(t))) {
            if (tag.startsWith('artisan')) tools.push(...ctx.tools.artisan);
            else if (tag.startsWith('gamingset')) tools.push(...ctx.tools.gaming);
            else if (tag.startsWith('musicalinstrument')) tools.push(...ctx.tools.musical);
            else if (tag === 'tool' || tag === 'tools') tools.push(...ctx.tools.artisan, ...ctx.tools.other, ...ctx.tools.gaming, ...ctx.tools.musical);
            else if (tag.startsWith('thieves')) tools.push(ctx.tools.other.find(n => /thieves/i.test(n)) || "Thieves' Tools");
        }
    }
    tools = [...new Set(tools.filter(Boolean))].slice(0, 40);
    if (!tools.length) return null;
    return {
        name: 'Tool proficiency', desc: '',
        choice: { choose: Math.min(choose, tools.length), options: tools.map(name => ({ name, desc: '', grants: { proficiencies: [name] } })) }
    };
}

// The <rules> of a background or background feature, sorted by what they do.
function readRules(element, ctx) {
    const out = { skills: [], tools: [], languages: [], languageChoice: 0, picks: [], featureIds: [], featureSelects: [], variants: [], lists: [] };
    for (const rule of (child(element.node, 'rules') || { children: [] }).children) {
        const a = rule.attrs, type = a.type;
        const choose = Math.max(1, Math.min(6, parseInt(a.number, 10) || 1));
        if (rule.name === 'grant') {
            if (type === 'Proficiency') {
                const skill = skillFromId(a.id, ctx);
                if (skill) out.skills.push(skill); else { const tool = toolFromId(a.id, ctx); if (tool) out.tools.push(tool); }
            } else if (type === 'Language') out.languages.push(languageFromId(a.id));
            else if (type === 'Background Feature') out.featureIds.push(a.id);
            else if (/THIEVES_CANT/.test(a.id || '')) out.languages.push("Thieves' Cant");
        } else if (rule.name === 'select') {
            if (type === 'List') {
                const items = rule.children.filter(c => c.name === 'item').map(c => c.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
                if (items.length) out.lists.push({ name: (a.name || 'Table').trim(), choose, items });
            } else if (type === 'Background Variant') out.variants.push(a.supports);
            else if (a.optional === 'true') continue;   // variant features and the like: left to the player's notes
            else if (type === 'Language') out.languageChoice += choose;
            else if (type === 'Proficiency') { const pick = proficiencyPick(a, choose, ctx); if (pick) out.picks.push(pick); }
            else if (type === 'Background Feature') out.featureSelects.push({ name: (a.name || 'Feature').trim(), supports: a.supports, choose });
        }
    }
    return out;
}

function featureFromElement(element, ctx) {
    const rules = readRules(element, ctx);
    const grants = {};
    if (rules.skills.length) grants.skills = rules.skills;
    if (rules.tools.length) grants.proficiencies = rules.tools;
    if (rules.languages.length) grants.languages = rules.languages;
    if (rules.languageChoice) grants.languageChoice = rules.languageChoice;
    const feature = {
        name: element.name.replace(/^(?:Variant\s+)?Feature:\s*/i, '') || 'Feature',
        desc: plainText(child(element.node, 'description')).slice(0, 4000)
    };
    if (Object.keys(grants).length) feature.grants = grants;
    return { feature, picks: rules.picks };
}

// "a set of fine clothes, a disguise kit, … and a belt pouch containing 15 gp"
// → the items this table's equipment list knows, plus the gold.
export function matchEquipmentText(text, catalog) {
    const words = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const names = (catalog || []).map(entry => {
        const base = entry.name.replace(/\(.*?\)/g, '');
        const halves = base.split(',').map(p => p.trim());
        const variants = [words(base)];
        if (halves.length === 2) variants.push(words(halves[1] + ' ' + halves[0]));   // "Clothes, fine" → "fine clothes"
        return { entry, variants: variants.filter(v => v.length >= 3) };
    });
    const items = [];
    for (const fragment of String(text || '').replace(/\([^)]*\)/g, ' ').split(/,|;|\band\b/i)) {
        const phrase = ' ' + words(fragment).replace(/\bbelt pouch\b/, 'pouch').replace(/\bset of (\w+) clothes\b/, '$1 clothes') + ' ';
        let best = null, length = 0;
        for (const { entry, variants } of names) {
            for (const v of variants) if (v.length > length && phrase.includes(' ' + v + ' ')) { best = entry; length = v.length; }
        }
        if (best && !items.some(i => i.index === best.index)) items.push({ index: best.index, name: best.name });
    }
    // The purse comes last ("…jewelry worth 10 gp, and a pouch containing 5 gp").
    const amounts = String(text || '').match(/\d+\s*gp\b/gi) || [];
    const gold = parseInt(amounts[amounts.length - 1], 10) || 0;
    return { items, gold };
}

const SUGGESTION_LISTS = [[/^personality/i, 'personality_traits'], [/^ideal/i, 'ideals'], [/^bond/i, 'bonds'], [/^flaw/i, 'flaws']];

// Background elements → homebrew background records (lib/homebrew.cjs shape).
// `elements` is every parsed element of the content set: features, variants
// and feature options live in other elements, often in other files.
// → [{ id, record }], one per background id.
export function auroraBackgrounds(elements, ctx) {
    const byId = new Map();
    for (const element of elements) if (!byId.has(element.id)) byId.set(element.id, element);
    const all = [...byId.values()];
    const out = [];
    for (const element of all) {
        if (element.type !== 'Background' || !element.name) continue;
        const rules = readRules(element, ctx);
        const description = child(element.node, 'description') || { children: [] };
        // The lead paragraphs are the background itself; the bullet list repeats
        // the proficiencies and carries the equipment line.
        const lead = [];
        for (const part of description.children) { if (part.name !== 'p') break; lead.push(plainText(part)); }
        const facts = {};
        walk(description, (node) => {
            if (node.name !== 'li') return;
            const m = /^([^:]{3,40}):\s*([\s\S]+)$/.exec(plainText(node));
            if (m) facts[m[1].trim().toLowerCase()] = m[2].trim();
        });
        const equipment = facts.equipment || '';
        const kit = matchEquipmentText(equipment, ctx.equipment);

        const features = [];
        const used = new Set();
        const add = (feature) => {
            let name = feature.name;
            for (let n = 2; used.has(name); n++) name = `${feature.name} ${n}`;
            used.add(name);
            features.push({ ...feature, name });
        };
        const picks = [...rules.picks];
        for (const id of rules.featureIds) {
            const found = byId.get(id);
            if (!found) continue;
            const converted = featureFromElement(found, ctx);
            add(converted.feature);
            picks.push(...converted.picks);
        }
        for (const select of rules.featureSelects) {
            const options = all.filter(e => e.type === 'Background Feature' && supportsMatch(e, select.supports))
                .map(e => featureFromElement(e, ctx).feature).slice(0, 40);
            if (options.length === 1) add(options[0]);
            else if (options.length) add({ name: select.name, desc: '', choice: { choose: Math.min(select.choose, options.length), options } });
        }
        picks.forEach(add);

        const record = {
            name: element.name, source: element.source, desc: lead.join('\n\n').slice(0, 4000),
            starting_proficiencies: [...new Set(rules.skills)].map(index => ({
                index: 'skill-' + index, name: 'Skill: ' + (ctx.skills.find(s => s.index === index) || {}).name
            })),
            tools: [...new Set(rules.tools)], languages: [...new Set(rules.languages)],
            languageChoice: Math.min(6, rules.languageChoice), equipment: equipment.slice(0, 1000),
            features: features.slice(0, 8), tables: []
        };
        if (kit.items.length) record.starting_equipment = kit.items.map(item => ({ equipment: item, quantity: 1 }));
        if (kit.gold) record.starting_gold = { quantity: kit.gold, unit: 'gp' };
        for (const list of rules.lists) {
            const slot = SUGGESTION_LISTS.find(([re]) => re.test(list.name));
            if (slot) record[slot[1]] = { choose: list.choose, from: { options: list.items.map(string => ({ string })) } };
            else record.tables.push({ name: list.name, options: list.items });
        }
        for (const supports of rules.variants) {
            const variants = all.filter(e => e.type === 'Background Variant' && supportsMatch(e, supports));
            if (variants.length) record.tables.push({
                name: 'Variant',
                options: variants.map(v => `${v.name.replace(/^Variant:?\s*/i, '')} — ${plainText(child(v.node, 'description')).replace(/\n/g, ' ')}`.slice(0, 400))
            });
        }
        out.push({ id: element.id, record });
    }
    return out;
}
