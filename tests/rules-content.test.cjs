// Homebrew rules content end to end: the feature-mechanics schema
// (lib/homebrew.cjs), the client interpreter (public/js/shared/rules.js), the
// Aurora importer, and the combat engine running feature abilities, riders,
// resources, bonus actions and multi-target saves against the real server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const { sanitizeRulesHomebrew, HOMEBREW_COLLECTIONS } = require('../lib/homebrew.cjs');
const kit = require('../lib/combat-kit.cjs');

// The browser modules load the SRD over fetch; serve it from disk here.
async function loadClientRules() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => JSON.parse(fs.readFileSync(path.join(repoRoot, String(url)), 'utf8'))
  });
  try {
    const moduleUrl = (file) => pathToFileURL(path.join(repoRoot, 'public/js/shared', file)).href;
    const srd = await import(moduleUrl('srd.js'));
    const rules = await import(moduleUrl('rules.js'));
    const aurora = await import(moduleUrl('aurora.js'));
    return { SRD: await srd.loadSRD(), rules, aurora };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const BREATH = {
  name: 'Storm Breath', desc: 'Exhale lightning.',
  action: {
    type: 'save', cost: 'action', damage: '3d8', damageType: 'lightning',
    scaling: [{ level: 6, damage: '4d8' }], saveAbility: 'dex', saveSuccess: 'half',
    dcAbility: 'con', area: 'cone', areaFt: 15, rangeFt: 15, maxTargets: 4, uses: '2', recharge: 'short'
  }
};

test('homebrew schemas keep valid mechanics and drop everything else', () => {
  const race = sanitizeRulesHomebrew('race', {
    name: 'Stormborn', size: 'Medium', speed: 35, evil: { nested: true },
    ability_bonuses: [{ ability_score: { index: 'con' }, bonus: 2 }, { ability_score: { index: 'luck' }, bonus: 9 }],
    ability_spreads: [{ bonuses: [2, 1] }, { bonuses: [1, 1, 1] }, { bonuses: [2, 1] }, { bonuses: [0, 9] }, { bonuses: [] }, 'junk'],
    starting_proficiencies: [{ index: 'skill-perception' }],
    languages: ['Common', 'Primordial'],
    traits: [
      BREATH,
      { name: 'Thick Hide', grants: { ac: 1, darkvision: 60, resistances: ['lightning'], bogus: 'x', speed: 99999 } },
      { name: 'Legacy', choice: { choose: 1, options: [{ name: 'Sky', grants: { speeds: { fly: 30 } } }, { name: 'Sea', choice: { choose: 1, options: [{ name: 'too deep' }] } }] } },
      { desc: 'no name' }
    ]
  });
  assert.equal(race.speed, 35);
  assert.equal(race.evil, undefined);
  assert.deepEqual(race.ability_bonuses, [{ ability_score: { index: 'con', name: 'CON' }, bonus: 2 }]);
  assert.deepEqual(race.ability_spreads, [{ bonuses: [2, 1] }, { bonuses: [1, 1, 1] }], 'valid spreads kept (deduped), junk dropped');
  assert.deepEqual(race.languages, [{ index: 'common', name: 'Common' }, { index: 'primordial', name: 'Primordial' }]);
  assert.equal(race.traits.length, 3);
  assert.equal(race.traits[0].action.damage, '3d8');
  assert.equal(race.traits[0].action.uses, '2');
  assert.deepEqual(race.traits[1].grants, { resistances: ['lightning'], speed: 120, ac: 1, darkvision: 60 });
  assert.deepEqual(race.traits[2].choice.options.map(option => option.name), ['Sky', 'Sea']);
  assert.equal(race.traits[2].choice.options[1].choice, undefined, 'choices nest one level only');

  // Formulas and dice only accept the tiny expression grammar.
  const feat = sanitizeRulesHomebrew('feat', {
    name: 'Brawler', desc: 'Hit harder.',
    prereq: { abilities: { str: 13, cha: 99 }, level: 4 },
    rider: { damage: '1d4', applies: 'unarmed', oncePerTurn: false },
    resource: { key: 'grit', name: 'Grit', max: 'prof+1' },
    action: { type: 'heal', cost: 'bonus', damage: 'require("fs")', uses: 'process.exit()' }
  });
  assert.deepEqual(feat.prereq, { level: 4, abilities: { str: 13, cha: 30 } });
  assert.equal(feat.rider.oncePerTurn, false);
  assert.equal(feat.resource.max, 'prof+1');
  assert.equal(feat.action.damage, undefined);
  assert.equal(feat.action.uses, undefined);

  assert.equal(sanitizeRulesHomebrew('subclass', { name: 'Orphan' }), null, 'a subclass needs its class');
  assert.equal(sanitizeRulesHomebrew('subrace', { name: 'Orphan' }), null, 'a subrace needs its race');
  assert.equal(sanitizeRulesHomebrew('race', { name: 'Huge', traits: [{ name: 'x', desc: 'y'.repeat(200000) }] }), null);
  assert.equal(sanitizeRulesHomebrew('monster', { name: 'Not here' }), null);

  const spell = sanitizeRulesHomebrew('spell', {
    name: 'Ember Lance', level: 1, school: { name: 'Evocation' }, classes: [{ index: 'wizard' }],
    attack_type: 'ranged', damage: { damage_type: { name: 'Fire' }, damage_at_slot_level: { 1: '3d8', 2: '4d8', x: 'nope' } }
  });
  assert.deepEqual(spell.damage.damage_at_slot_level, { 1: '3d8', 2: '4d8' });
  const blade = sanitizeRulesHomebrew('item', {
    name: 'Rapier +1', kind: 'weapon', bonus: 1, weapon_category: 'Martial',
    damage: { damage_dice: '1d8', damage_type: { name: 'Piercing' } }, properties: [{ index: 'finesse' }, { index: 'vorpal' }]
  });
  assert.equal(blade.equipment_category.index, 'weapon');
  assert.deepEqual(blade.properties, [{ index: 'finesse' }]);
  assert.deepEqual(Object.keys(HOMEBREW_COLLECTIONS).sort(),
    ['background', 'class', 'feat', 'item', 'monster', 'race', 'spell', 'subclass', 'subrace']);
});

test('the combat kit rebuilds abilities, riders and resources from untrusted input', () => {
  const abilities = kit.normalizeAbilities([
    { name: 'Breath', type: 'save', cost: 'bonus', damage: '3d8', saveAbility: 'luck', dc: 99, area: 'cone', maxTargets: 50, resource: 'use-1', effect: 'down' },
    { name: 'Bad dice', type: 'heal', damage: 'eval(1)', area: 'self', maxTargets: 3 },
    { type: 'teleport' }, null
  ]);
  assert.equal(abilities.length, 2);
  assert.deepEqual(
    { save: abilities[0].saveAbility, dc: abilities[0].dc, max: abilities[0].maxTargets, effect: abilities[0].effect },
    { save: 'dex', dc: 40, max: 12, effect: undefined });
  assert.equal(abilities[1].damage, '');
  assert.equal(abilities[1].maxTargets, 0, 'self abilities take no targets');
  assert.deepEqual(kit.normalizeResources({ ki: { name: 'Ki', max: 3, current: 9 }, 'bad key!': { max: 1 }, x: 7 }),
    { ki: { name: 'Ki', max: 3, current: 3, recharge: 'short' } });
  assert.deepEqual(kit.normalizeRiders([{ name: 'Sneak', damage: '2d6', applies: 'finesse-or-ranged' }, { damage: 'lots' }]).length, 1);

  const sneak = { damage: '2d6', applies: 'finesse-or-ranged', oncePerTurn: true };
  const rogue = { effects: [] };
  assert.equal(kit.riderApplies(sneak, { tags: ['melee', 'finesse'] }, rogue, [], 0), true);
  assert.equal(kit.riderApplies(sneak, { tags: ['melee'] }, rogue, [], 0), false);
  assert.equal(kit.riderApplies(sneak, { ranged: true }, rogue, [], 0), true, 'untagged attacks fall back to ranged/melee');
  assert.equal(kit.riderApplies(sneak, { tags: ['ranged'] }, rogue, [0], 0), false, 'once per turn');
  const rage = { damage: '2', applies: 'melee', requiresEffect: 'raging', oncePerTurn: false };
  assert.equal(kit.riderApplies(rage, { tags: ['melee'] }, rogue, [], 1), false);
  assert.equal(kit.riderApplies(rage, { tags: ['melee'] }, { effects: [{ key: 'raging' }] }, [], 1), true);
});

test('the sheet derives SRD and homebrew mechanics alike', async (t) => {
  const { SRD, rules } = await loadClientRules();
  assert.equal(rules.evalFormula('1+classLevel*2', { classLevel: 3 }), 7);
  assert.equal(rules.evalFormula('prof+wis', { prof: 3, wis: -1 }), 2);
  assert.equal(rules.evalFormula('alert(1)', {}), 0);
  assert.equal(rules.resolveDice('1d10+classLevel', { classLevel: 4 }), '1d10+4');
  assert.equal(rules.resolveDice('classLevel*5', { classLevel: 4 }), '20');

  // SRD prose features get their mechanics from SRD_MECHANICS.
  const multiclass = rules.buildSheet({
    race: 'dragonborn', background: 'acolyte',
    classes: [{ class: 'rogue', level: 3 }, { class: 'monk', level: 3 }],
    abilities: { str: 7, dex: 16, con: 14, int: 11, wis: 16, cha: 13 },
    skills: ['stealth'], expertise: ['stealth'], equipment: { weapons: ['shortsword'] },
    choices: { 'race:dragonborn|Draconic Ancestry': ['Silver (cold)'] }
  }, SRD);
  assert.equal(multiclass.ac, 16, 'monk Unarmored Defense: 10 + Dex 3 + Wis 3');
  assert.equal(multiclass.acSource, 'Unarmored Defense');
  assert.equal(multiclass.speed, 40, 'Unarmored Movement');
  assert.deepEqual(multiclass.resistances, ['cold']);
  assert.equal(multiclass.skillBonus('stealth', 'dex'), 3 + 3 + 3, 'expertise doubles proficiency');
  const combat = multiclass.combat;
  assert.deepEqual(combat.riders.map(r => [r.name, r.damage]), [['Sneak Attack', '2d6']]);
  assert.equal(combat.resources.ki.max, 3);
  const breath = combat.abilities.find(a => a.name === 'Breath Weapon');
  assert.deepEqual([breath.damage, breath.damageType, breath.saveAbility, breath.dc], ['3d6', 'cold', 'con', 13]);
  assert.equal(combat.resources[breath.resource].max, 1);
  assert.ok(combat.abilities.some(a => a.name === 'Flurry of Blows' && a.cost === 'bonus' && a.resource === 'ki'));
  const unarmed = combat.attacks.find(a => a.name === 'Unarmed Strike');
  assert.deepEqual([unarmed.attack, unarmed.damage], [6, '1d4+3'], 'Martial Arts die with Dex');
  assert.equal(rules.buildSheet({ race: 'human', classes: [{ class: 'fighter', level: 11 }], abilities: {} }, SRD).combat.attacksPerAction, 3);

  // The same numbers out of homebrew data: a race, a subclass, a feat, an item.
  SRD.setHomebrew({
    races: [{ ...sanitizeRulesHomebrew('race', { name: 'Stormborn', speed: 30, traits: [BREATH, { name: 'Claws', action: { type: 'attack', cost: 'attack', damage: '1d4', damageType: 'slashing', ability: 'best' } }, { name: 'Quick', grants: { initiativeProf: true } }] }), index: 'hb-race-storm' }],
    subclasses: [{ ...sanitizeRulesHomebrew('subclass', { name: 'Assassin', class: { index: 'rogue' }, features: [{ level: 3, name: 'Poisoner', grants: { proficiencies: ["Poisoner's kit"] } }, { level: 9, name: 'Later', grants: { ac: 5 } }] }), index: 'hb-subclass-assassin' }],
    feats: [{ ...sanitizeRulesHomebrew('feat', { name: 'Tough Hide', grants: { ac: 1, hpPerLevel: 2 }, prereq: { abilities: { con: 13 } } }), index: 'hb-feat-hide' }],
    items: [{ ...sanitizeRulesHomebrew('item', { name: 'Rapier +1', kind: 'weapon', bonus: 1, weapon_category: 'Martial', damage: { damage_dice: '1d8', damage_type: { name: 'Piercing' } }, properties: [{ index: 'finesse' }] }), index: 'hb-item-rapier' }]
  });
  t.after(() => SRD.setHomebrew({}));   // the SRD tables are a shared singleton
  const char = {
    race: 'hb-race-storm', background: 'acolyte', classes: [{ class: 'rogue', subclass: 'hb-subclass-assassin', level: 6 }],
    abilities: { str: 8, dex: 16, con: 14, int: 10, wis: 10, cha: 10 }, feats: ['hb-feat-hide'],
    equipment: { weapons: ['hb-item-rapier'] }
  };
  const sheet = rules.buildSheet(char, SRD);
  assert.equal(sheet.ac, 10 + 3 + 1);
  assert.equal(sheet.init, 3 + sheet.prof, 'proficiency bonus added to initiative');
  assert.equal(sheet.maxHP, SRD.maxHP(char.classes, 2) + 12);
  assert.deepEqual(sheet.proficiencies, ["Poisoner's kit"], 'the level 9 subclass feature is not gained yet');
  assert.deepEqual(rules.meetsPrereq(SRD.get('feats', 'hb-feat-hide').prereq, sheet), { ok: true, reason: '' });
  assert.deepEqual(rules.meetsPrereq({ level: 9, abilities: { str: 13 } }, sheet), { ok: false, reason: 'Requires level 9, STR 13' });
  const storm = sheet.combat.abilities.find(a => a.name === 'Storm Breath');
  assert.equal(storm.damage, '4d8', 'scales at character level 6');
  assert.equal(sheet.combat.resources[storm.resource].max, 2);
  const rapier = sheet.combat.attacks.find(a => a.name === 'Rapier +1');
  assert.deepEqual([rapier.attack, rapier.damage, rapier.tags], [3 + 3 + 1, '1d8+4', ['melee', 'finesse']]);
  const claws = sheet.combat.attacks.find(a => a.name === 'Claws');
  assert.deepEqual([claws.attack, claws.damage, claws.tags], [6, '1d4+3', ['melee', 'natural']]);
  SRD.setHomebrew({});
  assert.equal(SRD.get('races', 'hb-race-storm'), undefined, 'homebrew unloads cleanly');
});

test('an Aurora character file resolves against the table and stubs what is missing', async () => {
  const { SRD, aurora } = await loadClientRules();
  const xml = `﻿<?xml version="1.0" encoding="utf-8"?>
<character version="1.0.3"><!-- a comment -->
  <display-properties><name>Mira &amp; Co</name><race>Tabaxi</race><class>Rogue (3) / Monk (2)</class><background>Charlatan</background><level>5</level></display-properties>
  <build>
    <input><backstory><![CDATA[Grew up <fast>.]]></backstory>
      <background><feature name="False Identity"><description><![CDATA[A second identity.]]></description></feature></background></input>
    <abilities><strength>7</strength><dexterity>16</dexterity><constitution>14</constitution><intelligence>11</intelligence><wisdom>16</wisdom><charisma>13</charisma></abilities>
    <elements>
      <element type="Level" name="1" id="ID_LEVEL_1">
        <element type="Race" name="Race" registered="ID_WOTC_VGTM_RACE_TAXBAXI">
          <element type="Language" name="Language (Tabaxi)" registered="ID_LANGUAGE_UNDERCOMMON" />
          <element type="Vision" name="Darkvision" id="ID_VISION_DARKVISION" />
          <element type="Language" name="Common" id="ID_LANGUAGE_COMMON" />
          <element type="Racial Trait" name="Cat’s Talent" id="ID_X"><element type="Proficiency" name="Stealth" id="ID_PROFICIENCY_SKILL_STEALTH" /></element>
        </element>
        <element type="Class" name="Class" registered="ID_WOTC_PHB_CLASS_ROGUE">
          <element type="Proficiency" name="Skill Proficiency (Rogue)" registered="ID_PROFICIENCY_SKILL_SLEIGHTOFHAND" />
          <element type="Class Feature" name="Expertise (Rogue)" registered="ID_EXPERTISE_SKILL_STEALTH" />
          <element type="Class Feature" name="Roguish Archetype" id="ID_Y">
            <element type="Archetype" name="Roguish Archetype" registered="ID_WOTC_PHB_ARCHETYPE_ASSASSIN">
              <element type="Archetype Feature" name="Bonus Proficiencies" id="ID_Z"><element type="Proficiency" name="Tool Proficiency (Disguise kit)" id="ID_T" /></element>
            </element>
          </element>
        </element>
        <element type="Background" name="Background" registered="ID_BACKGROUND_CHARLATAN">
          <element type="Proficiency" name="Deception" id="ID_PROFICIENCY_SKILL_DECEPTION" />
          <element type="Proficiency" name="Tool Proficiency (Forgery kit)" id="ID_F" />
        </element>
      </element>
    </elements>
  </build>
</character>`;
  const parsed = aurora.parseAuroraCharacter(xml);
  assert.equal(parsed.name, 'Mira & Co');
  assert.deepEqual(parsed.abilities, { str: 7, dex: 16, con: 14, int: 11, wis: 16, cha: 13 });
  assert.deepEqual(parsed.classes.map(c => [c.name, c.level, c.subclass]), [['Rogue', 3, 'Assassin'], ['Monk', 2, null]]);
  assert.equal(parsed.notes, 'Backstory: Grew up <fast>.');

  const { char, missing, warnings } = aurora.matchAurora(parsed, SRD);
  assert.deepEqual(char.classes, [{ class: 'rogue', subclass: null, level: 3 }, { class: 'monk', subclass: null, level: 2 }]);
  assert.deepEqual(char.skills.sort(), ['deception', 'sleight-of-hand', 'stealth']);
  assert.deepEqual(char.expertise, ['stealth']);
  assert.deepEqual(char.languages, ['Undercommon'], 'the race stub carries its fixed languages');
  assert.deepEqual(missing.map(entry => entry.type), ['race', 'subclass', 'background']);
  const [race, subclass, background] = missing.map(entry => entry.stub);
  assert.equal(race.traits[0].grants.darkvision, 60);
  assert.deepEqual(race.starting_proficiencies.map(p => p.index), ['skill-stealth']);
  assert.deepEqual(subclass.features, [{ level: 3, name: 'Bonus Proficiencies', desc: '', grants: { proficiencies: ['Disguise kit'] } }]);
  assert.deepEqual(background.tools, ['Forgery kit']);
  assert.equal(background.features[0].desc, 'A second identity.');
  assert.equal(warnings.length, 2);
  // Every stub is accepted by the server-side schema as written.
  for (const entry of missing) assert.ok(sanitizeRulesHomebrew(entry.type, entry.stub), entry.type);
  missing.forEach((entry, i) => entry.apply(`hb-${i}`));
  assert.deepEqual([char.race, char.classes[0].subclass, char.background], ['hb-0', 'hb-1', 'hb-2']);

  assert.throws(() => aurora.parseAuroraCharacter('<html></html>'), /not an Aurora character file/);
});

test('Aurora background elements become homebrew backgrounds with their picks and tables', async () => {
  const { SRD, rules, aurora } = await loadClientRules();
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
<elements>
  <element name="Lamplighter" type="Background" source="Test Book" id="ID_TEST_BACKGROUND_LAMPLIGHTER">
    <description>
      <p>You kept the <em>street lamps</em> burning.</p>
      <p>Second paragraph.</p>
      <ul><li><strong>Skill Proficiencies:</strong> Perception</li>
        <li><strong>Equipment:</strong> A set of common clothes, a lamp (with oil), a trinket worth 3 gp, and a belt pouch containing 12 gp</li></ul>
      <h5>ROUNDS</h5><table><tr><td>1</td><td>Docks</td></tr></table>
    </description>
    <rules>
      <grant type="Proficiency" id="ID_PROFICIENCY_SKILL_PERCEPTION" />
      <grant type="Proficiency" id="ID_PROFICIENCY_TOOL_PROFICIENCY_THIEVES_TOOLS" />
      <grant type="Language" id="ID_LANGUAGE_DWARVISH" />
      <grant type="Background Feature" id="ID_TEST_BACKGROUND_FEATURE_NIGHT_ROUNDS" requirements="!ID_INTERNAL_GRANT_OPTIONAL_BACKGROUND_FEATURE" />
      <select type="Background Feature" name="Variant Feature" supports="Optional Background Feature" optional="true" />
      <select type="Language" name="Language" supports="Standard||Exotic" number="2" />
      <select type="Proficiency" name="Skill" supports="ID_PROFICIENCY_SKILL_STEALTH|ID_PROFICIENCY_SKILL_SLEIGHTOFHAND" />
      <select type="Proficiency" name="Tool" supports="Gaming Set||Musical Instrument" />
      <select type="Background Feature" name="District" supports="Lamplighter District" />
      <select type="Background Variant" name="Variant" supports="Variant Lamplighter" optional="true" />
      <select name="Round" type="List" optional="true"><item id="1">Docks</item><item id="2">Temple hill</item></select>
      <select name="Personality Trait" type="List" number="2"><item id="1">I hum while I work.</item><item id="2">I count everything.</item></select>
      <select name="Ideal" type="List"><item id="1">Duty. The lamps must burn. (Lawful)</item></select>
      <select name="Bond" type="List"><item id="1">My old ladder.</item></select>
      <select name="Flaw" type="List"><item id="1">I fear the dark.</item></select>
    </rules>
  </element>
  <element name="Feature: Night Rounds" type="Background Feature" source="Test Book" id="ID_TEST_BACKGROUND_FEATURE_NIGHT_ROUNDS">
    <supports>Background Feature</supports>
    <description><p>You know every alley <strong>after dark</strong>.</p></description>
  </element>
  <element name="Docks" type="Background Feature" source="Test Book" id="ID_TEST_DISTRICT_DOCKS">
    <supports>Lamplighter District</supports><description><p>Salt and tar.</p></description>
    <rules><grant type="Proficiency" id="ID_PROFICIENCY_TOOL_PROFICIENCY_VEHICLES_WATER" /></rules>
  </element>
  <element name="Hill" type="Background Feature" source="Test Book" id="ID_TEST_DISTRICT_HILL">
    <supports>Lamplighter District</supports><description><p>Incense.</p></description>
  </element>
  <element name="Lamplighter: Snuffer" type="Background Variant" source="Test Book" id="ID_TEST_VARIANT_SNUFFER">
    <supports>Variant Lamplighter</supports><description><p>You put them out instead.</p></description>
  </element>
</elements>`;
  const elements = [...aurora.parseAuroraElements(xml), ...aurora.parseAuroraElements(xml)];
  const converted = aurora.auroraBackgrounds(elements, aurora.auroraContext(SRD));
  assert.equal(converted.length, 1, 'one record per Aurora id, however many files repeat it');
  assert.equal(converted[0].id, 'ID_TEST_BACKGROUND_LAMPLIGHTER');
  const bg = sanitizeRulesHomebrew('background', converted[0].record);
  assert.ok(bg, 'the schema accepts the converted record');
  assert.equal(bg.desc, 'You kept the street lamps burning.\n\nSecond paragraph.');
  assert.equal(bg.source, 'Test Book');
  assert.deepEqual(bg.starting_proficiencies.map(p => p.index), ['skill-perception']);
  assert.deepEqual(bg.tools, ["Thieves' Tools"]);
  assert.deepEqual(bg.languages.map(l => l.name), ['Dwarvish']);
  assert.equal(bg.languageChoice, 2);
  assert.match(bg.equipment, /^A set of common clothes/);
  assert.deepEqual(bg.starting_equipment.map(e => e.equipment.index), ['clothes-common', 'lamp', 'pouch']);
  assert.deepEqual(bg.starting_gold, { quantity: 12, unit: 'gp' });
  assert.deepEqual(bg.features.map(f => f.name), ['Night Rounds', 'District', 'Skill proficiency', 'Tool proficiency']);
  assert.equal(bg.features[0].desc, 'You know every alley after dark.');
  assert.deepEqual(bg.features[1].choice.options.map(o => [o.name, o.grants || null]),
    [['Docks', { proficiencies: ['Water Vehicles'] }], ['Hill', null]]);
  assert.deepEqual(bg.features[2].grants.skillChoice, { choose: 1, from: ['stealth', 'sleight-of-hand'] });
  assert.ok(bg.features[3].choice.options.some(o => o.name === 'Lute') && bg.features[3].choice.options.some(o => o.name === 'Dice Set'));
  assert.equal(bg.personality_traits.choose, 2);
  assert.deepEqual(bg.personality_traits.from.options.map(o => o.string), ['I hum while I work.', 'I count everything.']);
  assert.equal(bg.ideals.from.options.length + bg.bonds.from.options.length + bg.flaws.from.options.length, 3);
  assert.deepEqual(bg.tables, [
    { name: 'Round', options: ['Docks', 'Temple hill'] },
    { name: 'Variant', options: ['Lamplighter: Snuffer — You put them out instead.'] }
  ]);

  // At the table it behaves like any other background: grants, picks, choices.
  SRD.setHomebrew({ backgrounds: [{ ...bg, index: 'aurora-test-lamplighter' }] });
  try {
    const sheet = rules.buildSheet({
      race: 'human', background: 'aurora-test-lamplighter', classes: [{ class: 'fighter', level: 1 }],
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      choices: { 'background:aurora-test-lamplighter|District': ['Docks'] }
    }, SRD);
    assert.ok(sheet.granted.has('perception'));
    assert.ok(sheet.languages.includes('Dwarvish'));
    assert.equal(sheet.languageChoice, 2);
    assert.ok(sheet.proficiencies.includes("Thieves' Tools") && sheet.proficiencies.includes('Water Vehicles'));
    assert.deepEqual(sheet.grants.skillChoices, [{ choose: 1, from: ['stealth', 'sleight-of-hand'] }]);
    assert.deepEqual(sheet.choices.filter(c => c.key.startsWith('background:')).map(c => [c.name, c.picked]),
      [['District', ['Docks']], ['Tool proficiency', []]]);
    // The SRD's own background offers its language picks the same way.
    assert.equal(rules.buildSheet({ race: 'human', background: 'acolyte', classes: [{ class: 'fighter', level: 1 }] }, SRD).languageChoice, 2);
  } finally {
    SRD.setHomebrew({});
  }
});

// ---- protocol ---------------------------------------------------------------
async function startServer(dataDirectory) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  const env = { ...process.env, PORT: String(port), THREEDX_DATA_DIR: dataDirectory, THREEDX_OPEN_LOGIN: '1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (!output.includes('VTT Server Running')) {
    if (Date.now() > deadline || child.exitCode != null) throw new Error(`server did not start\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, port };
}

// Minimal Socket.IO-over-polling client.
async function connect(port) {
  const url = (sid) => `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling&t=${Math.random()}${sid ? `&sid=${sid}` : ''}`;
  const handshake = await (await fetch(url())).text();
  const sid = JSON.parse(handshake.slice(1)).sid;
  const post = async (packet) => { await fetch(url(sid), { method: 'POST', body: packet }); };
  await post('40');
  const inbox = [];
  const session = {
    emit: (event, payload) => post(`42${JSON.stringify([event, payload])}`),
    async wait(eventName, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = inbox.findIndex(([name]) => name === eventName);
        if (index >= 0) return inbox.splice(index, 1)[0][1];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${eventName}`);
        const response = await fetch(url(sid), { signal: AbortSignal.timeout(4000) });
        const packets = (await response.text()).split('\x1e');
        if (packets.includes('2')) await post('3');
        for (const packet of packets) {
          if (packet.startsWith('42')) inbox.push(JSON.parse(packet.slice(2)));
        }
      }
    },
    drop(eventName) { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i][0] === eventName) inbox.splice(i, 1); },
    async request(event, payload, answer) {
      session.drop(answer);
      await session.emit(event, payload);
      return session.wait(answer);
    }
  };
  return session;
}

test('every homebrew type saves, and combat runs feature abilities', { timeout: 40000 }, async (t) => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), '3dx-rules-'));
  let instance;
  t.after(async () => {
    if (instance) { instance.child.kill(); await once(instance.child, 'exit').catch(() => {}); }
    fs.rmSync(saveDir, { recursive: true, force: true });
  });
  instance = await startServer(saveDir);
  const gm = await connect(instance.port);
  await gm.request('login', 'GM', 'login-success');
  await gm.wait('map-state');

  const save = async (type, data) => (await gm.request('save-homebrew', { type, data }, 'homebrew-saved-success')).data;
  const race = await save('race', { name: 'Stormborn', speed: 30, traits: [BREATH] });
  assert.match(race.index, /^hb-race-/);
  const subrace = await save('subrace', { name: 'Deep Stormborn', race: { index: race.index }, traits: [] });
  const cls = await save('class', { name: 'Warden', hit_die: 10, customFeatures: [{ level: 1, name: 'Ward', grants: { ac: 1 } }] });
  const subclass = await save('subclass', { name: 'Assassin', class: { index: 'rogue' }, features: [{ level: 3, name: 'Assassinate' }] });
  const background = await save('background', { name: 'Charlatan', tools: ['Forgery kit'], features: [{ name: 'False Identity' }] });
  const feat = await save('feat', { name: 'Tough Hide', grants: { ac: 1 } });
  const spell = await save('spell', { name: 'Ember Lance', level: 1, classes: [{ index: 'wizard' }] });
  const item = await save('item', { name: 'Rapier +1', kind: 'weapon', bonus: 1 });
  assert.equal(subclass.class.index, 'rogue');
  const refused = await gm.request('save-homebrew', { type: 'subclass', data: { name: 'No parent' } }, 'error');
  assert.equal(refused, 'Invalid homebrew');

  const listed = await gm.request('get-homebrew', null, 'load-homebrew');
  for (const [collection, saved] of Object.entries({
    races: race, subraces: subrace, classes: cls, subclasses: subclass,
    backgrounds: background, feats: feat, spells: spell, items: item
  })) {
    assert.deepEqual(listed[collection], [saved], collection);
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(saveDir, 'homebrew.json'), 'utf8'));
  assert.equal(persisted.races[race.index].traits[0].action.damage, '3d8');

  // The sheet keeps its feats, choices, expertise, languages and notes.
  const character = await gm.request('save-character', {
    username: 'GM',
    charData: {
      name: 'Gale', race: race.index, classes: [{ class: 'rogue', subclass: subclass.index, level: 3 }],
      abilities: { str: 8, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      feats: [feat.index, 'not a ref!'], expertise: ['stealth'], languages: ['Auran', 'Auran'],
      choices: { 'race:x|Legacy': ['Sky'], __proto__: ['nope'] }, notes: 'Line one\nLine two'
    }
  }, 'character-saved-success');
  assert.deepEqual(character.feats, [feat.index]);
  assert.deepEqual(character.languages, ['Auran']);
  assert.deepEqual(character.choices, { 'race:x|Legacy': ['Sky'] });
  assert.equal(character.notes, 'Line one\nLine two');

  // Three tokens: the hero plus two default targets (AC 12, 10 HP).
  const add = async (data) => gm.request('add-object', data, 'object-added');
  const hero = await add({ type: 'character', characterData: { id: character.id }, position: { x: 0, y: 0.1, z: 0 } });
  const goblinA = await add({ type: 'token', name: 'Goblin A', position: { x: 1, y: 0.1, z: 0 } });
  const goblinB = await add({ type: 'token', name: 'Goblin B', position: { x: 2, y: 0.1, z: 0 } });

  let combat = await gm.request('combat-start', null, 'combat-updated');
  assert.equal(combat.combatants[hero.id].statsPending, true);
  const stats = {
    combatantId: hero.id, ac: 15, speedFeet: 30, initMod: 3, maxHP: 24,
    attacks: [
      { name: 'Rapier', attack: 30, damage: '1d8+3', damageType: 'piercing', tags: ['melee', 'finesse', 'bogus'] },
      { name: 'Unarmed Strike', attack: 30, damage: '1', damageType: 'bludgeoning', tags: ['melee', 'unarmed'] }
    ],
    abilities: [
      { name: 'Storm Breath', type: 'save', cost: 'action', damage: '3d8', damageType: 'lightning', saveAbility: 'dex', saveSuccess: 'half', dc: 30, area: 'cone', areaFt: 15, maxTargets: 4, resource: 'use-1', resourceCost: 1 },
      { name: 'Flurry', type: 'utility', cost: 'bonus', area: 'self', resource: 'ki', resourceCost: 1, grant: 'attacks', grantCount: 2, grantAttack: 'Unarmed' },
      { name: 'Second Wind', type: 'heal', cost: 'bonus', area: 'self', damage: '1d10+3' },
      { name: 'Surge', type: 'utility', cost: 'free', area: 'self', grant: 'action', resource: 'use-2', resourceCost: 1 }
    ],
    riders: [{ name: 'Sneak Attack', damage: '2d6', applies: 'finesse-or-ranged', oncePerTurn: true }],
    resources: { 'use-1': { name: 'Storm Breath', max: 1, current: 0 }, ki: { name: 'Ki', max: 1 }, 'use-2': { name: 'Surge', max: 1 } },
    attacksPerAction: 2, saves: { dex: 6 }
  };
  combat = await gm.request('combat-set-stats', stats, 'combat-updated');
  let me = combat.combatants[hero.id];
  assert.deepEqual(me.attacks[0].tags, ['melee', 'finesse']);
  assert.equal(me.resources['use-1'].current, 1, 'pools start full whatever the client claims');
  assert.equal(me.attacksPerAction, 2);

  // Make the hero act first and keep the turn.
  await gm.request('combat-update-combatant', { combatantId: hero.id, patch: { initiative: 60 } }, 'combat-updated');
  combat = await gm.request('combat-begin', {}, 'combat-updated');
  assert.equal(combat.activeId, hero.id);
  // The dice are real, so a swing can still roll a natural 1: read the outcome
  // from the log instead of assuming it.
  let lastHit = false;
  const act = async (payload) => {
    const state = await gm.request('combat-action', { combatantId: hero.id, ...payload }, 'combat-updated');
    lastHit = /— (HIT|CRIT!)/.test(state.log[state.log.length - 1].text);
    return state.combatants;
  };
  const deny = async (payload) => (await gm.request('combat-action', { combatantId: hero.id, ...payload }, 'combat-denied')).reason;
  const hp = (combatants, id) => combatants[id].hp.current;

  // A cone catches both goblins: one damage roll, one save each, DC 30 fails.
  assert.match(await deny({ kind: 'ability', abilityIndex: 0, targetIds: [goblinA.id, goblinB.id] }), /Aim Storm Breath first/, 'an area is aimed, never a hand-picked list');
  let now = await act({ kind: 'ability', abilityIndex: 0, aim: { x: 3, z: 0 } });
  assert.equal(now[hero.id].resources['use-1'].current, 0);
  assert.equal(now[hero.id].actionUsed, true);
  assert.ok(hp(now, goblinA.id) < 10);
  assert.equal(hp(now, goblinA.id), hp(now, goblinB.id), 'the breath rolls damage once for the area');
  assert.match(await deny({ kind: 'ability', abilityIndex: 0, aim: { x: 3, z: 0 } }), /No Storm Breath uses left/);
  assert.match(await deny({ kind: 'attack', attackIndex: 0, targetId: goblinA.id }), /Action already used/);

  // Action Surge hands the action back; Extra Attack allows two swings.
  now = await act({ kind: 'ability', abilityIndex: 3 });
  assert.equal(now[hero.id].actionUsed, false);
  await gm.request('combat-update-combatant', { combatantId: goblinA.id, patch: { maxHP: 200, hpCurrent: 200 } }, 'combat-updated');
  now = await act({ kind: 'attack', attackIndex: 0, targetId: goblinA.id, riders: [0], advantage: true });
  const afterFirst = hp(now, goblinA.id);
  const sneaked = lastHit;
  if (sneaked) assert.ok(200 - afterFirst >= 1 + 3 + 2, 'rapier plus two Sneak Attack dice');
  else assert.equal(afterFirst, 200);
  assert.deepEqual(now[hero.id].ridersUsed, sneaked ? [0] : [], 'a rider is only spent on a hit');
  assert.equal(now[hero.id].attacksLeft, 1);
  now = await act({ kind: 'attack', attackIndex: 0, targetId: goblinA.id, riders: [0] });
  const second = afterFirst - hp(now, goblinA.id);
  if (sneaked && lastHit) assert.ok(second >= 4 && second <= 19, 'Sneak Attack applies once per turn');
  assert.equal(now[hero.id].attacksLeft, 0);
  assert.match(await deny({ kind: 'attack', attackIndex: 0, targetId: goblinA.id }), /Action already used/);

  // A ki bonus action grants two unarmed strikes — and only unarmed ones.
  now = await act({ kind: 'ability', abilityIndex: 1 });
  assert.equal(now[hero.id].bonusUsed, true);
  assert.deepEqual(now[hero.id].bonusAttacks, { count: 2, only: 'Unarmed' });
  assert.equal(now[hero.id].resources.ki.current, 0);
  assert.match(await deny({ kind: 'attack', attackIndex: 0, targetId: goblinA.id }), /Action already used/);
  now = await act({ kind: 'attack', attackIndex: 1, targetId: goblinA.id });
  now = await act({ kind: 'attack', attackIndex: 1, targetId: goblinA.id });
  assert.equal(now[hero.id].bonusAttacks, null);
  assert.match(await deny({ kind: 'ability', abilityIndex: 2 }), /Bonus action already used/);

  // Next round: everything per-turn resets; pools do not.
  await gm.request('combat-end-turn', {}, 'combat-updated');
  await gm.request('combat-set-turn', { combatantId: hero.id }, 'combat-updated');
  await gm.request('combat-update-combatant', { combatantId: hero.id, patch: { hpCurrent: 5, resources: { ki: 1, nope: 4 } } }, 'combat-updated');
  now = await act({ kind: 'ability', abilityIndex: 2 });
  assert.ok(hp(now, hero.id) >= 9 && hp(now, hero.id) <= 18, 'Second Wind heals 1d10+3');
  assert.equal(now[hero.id].resources.ki.current, 1, 'the GM can refill a pool');
  assert.equal(now[hero.id].resources['use-1'].current, 0);
  assert.deepEqual(now[hero.id].ridersUsed, []);

  const stored = JSON.parse(fs.readFileSync(path.join(saveDir, 'characters.json'), 'utf8'));
  assert.equal(stored[character.id].hp.current, hp(now, hero.id), 'healing writes back to the sheet');
});

test('races can offer alternative ability spreads (Harengon-style +2/+1 or +1/+1/+1)', async () => {
  const { SRD, rules } = await loadClientRules();
  const harengon = sanitizeRulesHomebrew('race', {
    name: 'Harengon', speed: 30,
    ability_spreads: [{ bonuses: [2, 1] }, { bonuses: [1, 1, 1] }],
    traits: [{ name: 'Hare-Trigger', grants: { initiativeProf: true } }]
  });
  assert.deepEqual(harengon.ability_spreads, [{ bonuses: [2, 1] }, { bonuses: [1, 1, 1] }]);
  SRD.setHomebrew({ races: [{ ...harengon, index: 'hb-race-harengon' }] });
  try {
    const base = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    assert.deepEqual(SRD.finalAbilities(base, 'hb-race-harengon', null, ['dex', 'con'], 0),
      { ...base, dex: 12, con: 11 }, 'the +2/+1 spread lands in slot order');
    assert.deepEqual(SRD.finalAbilities(base, 'hb-race-harengon', null, ['str', 'dex', 'con'], 1),
      { ...base, str: 11, dex: 11, con: 11 }, 'the +1-to-three spread');
    assert.deepEqual(SRD.finalAbilities(base, 'hb-race-harengon', null, ['str', 'dex', 'con'], null),
      { ...base, str: 11, dex: 11, con: 11 }, 'a pre-spreads sheet keeps its flat +1s');
    assert.deepEqual(SRD.finalAbilities(base, 'hb-race-harengon', null, [null, 'dex'], 0),
      { ...base, dex: 11 }, 'an empty slot adds nothing and later slots keep their bonus');
    const sheet = rules.buildSheet({ race: 'hb-race-harengon', classes: [{ class: 'fighter', level: 1 }], abilities: base, racialChoice: ['dex', 'con'], racialSpread: 0 }, SRD);
    assert.equal(sheet.finals.dex, 12);
    assert.equal(sheet.finals.con, 11);
    assert.equal(sheet.init, 1 + sheet.prof, 'the trait grant still rides along');
  } finally {
    SRD.setHomebrew({});
  }
});
