const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');

let monsters;

before(async () => {
  const filename = path.resolve(__dirname, '..', 'public', 'js', 'shared', 'monsters.js');
  const encoded = Buffer.from(fs.readFileSync(filename, 'utf8')).toString('base64');
  monsters = await import(`data:text/javascript;base64,${encoded}`);
});

function owlbearFixture() {
  return {
    index: 'owlbear', name: 'Owlbear', size: 'Large', type: 'monstrosity',
    alignment: 'unaligned', armor_class: [{ type: 'natural', value: 13 }],
    hit_points: 59, hit_dice: '7d10+21', speed: { walk: '40 ft.' },
    strength: 20, dexterity: 12, constitution: 17,
    intelligence: 3, wisdom: 12, charisma: 7,
    challenge_rating: 3, proficiency_bonus: 2, xp: 700,
    proficiencies: [{ value: 3, proficiency: { index: 'saving-throw-wis', name: 'Saving Throw: WIS' } }],
    special_abilities: [{ name: 'Keen Sight and Smell', desc: 'Advantage on Perception checks.' }],
    actions: [{
      name: 'Beak', attack_bonus: 7,
      desc: 'Melee Weapon Attack: +7 to hit, reach 5 ft., one creature.',
      damage: [{ damage_dice: '1d10 + 5', damage_type: { index: 'piercing', name: 'Piercing' } }]
    }],
    image: '/api/images/monsters/owlbear.png',
    url: '/api/2014/monsters/owlbear'
  };
}

test('monster combat stats derive the encounter fields from an SRD-shaped record', () => {
  const stats = monsters.monsterCombatStats(owlbearFixture());
  assert.equal(stats.ac, 13);
  assert.equal(stats.maxHP, 59);
  assert.equal(stats.speedFeet, 40);
  assert.equal(stats.initMod, 1);
  assert.equal(stats.saves.wis, 3);
  assert.deepEqual(stats.attacks, [{
    name: 'Beak', attack: 7, damage: '1d10+5', damageType: 'piercing',
    ranged: false, rangeFt: 5
  }]);
});

test('placed monster snapshots retain rules text but omit upstream image and API metadata', () => {
  const snapshot = monsters.monsterTokenSnapshot(owlbearFixture());
  assert.equal(snapshot.source, 'srd-5.1');
  assert.equal(snapshot.size, 'Large');
  assert.equal(snapshot.actions[0].damage[0].damage_dice, '1d10 + 5');
  assert.equal(Object.hasOwn(snapshot, 'image'), false);
  assert.equal(Object.hasOwn(snapshot, 'url'), false);
});

test('Ape appearance variants expose stable asset IDs with a safe default', () => {
  const ape = { index: 'ape', name: 'Ape' };
  assert.deepEqual(monsters.monsterAppearanceVariants(ape).map(variant => variant.id), [
    'silverback', 'highland', 'albino'
  ]);
  assert.equal(monsters.monsterAppearanceVariant(ape), 'silverback');
  assert.equal(monsters.monsterAppearanceVariant(ape, 'highland'), 'highland');
  assert.equal(monsters.monsterAppearanceVariant(ape, 'not-a-variant'), 'silverback');
  assert.deepEqual(monsters.monsterAppearanceVariants({ index: 'baboon' }), []);
  assert.equal(monsters.monsterAppearanceVariant({ index: 'baboon' }, 'silverback'), '');
});

test('monster stat-block markup escapes user-authored names and descriptions', () => {
  const fixture = owlbearFixture();
  fixture.name = '<img src=x onerror=alert(1)>';
  fixture.actions[0].desc = '<script>alert(1)</script>';
  const html = monsters.monsterStatBlockHTML(fixture);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
});

test('movement falls back to a viable non-walk speed and clamps authored values', () => {
  assert.equal(monsters.monsterSpeedFeet({ speed: { walk: '0 ft.', fly: '60 ft. (hover)' } }), 60);
  assert.equal(monsters.monsterSpeedFeet({ speed: { walk: '999 ft.' } }), 120);
});

test('attacks retain simultaneous damage while choosing only one listed alternative', () => {
  const fixture = owlbearFixture();
  fixture.actions = [{
    name: 'Planar Blade', attack_bonus: 8, desc: 'Melee Weapon Attack: reach 5 ft.',
    damage: [
      { damage_dice: '1d8+4', damage_type: { index: 'slashing', name: 'Slashing' } },
      { choose: 1, from: { options: [
        { option_type: 'damage', damage_dice: '2d6', damage_type: { index: 'fire', name: 'Fire' } },
        { option_type: 'damage', damage_dice: '2d6', damage_type: { index: 'cold', name: 'Cold' } }
      ] } }
    ]
  }];
  const [attack] = monsters.monsterAttacks(fixture);
  assert.deepEqual(attack.damageParts, [
    { damage: '1d8+4', damageType: 'slashing' },
    { damage: '2d6', damageType: 'fire' }
  ]);
  assert.equal(attack.damageParts.some(part => part.damageType === 'cold'), false);
});
