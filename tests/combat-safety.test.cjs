const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');

let safety;

before(async () => {
  const filename = path.resolve(__dirname, '..', 'public', 'js', 'shared', 'combat-safety.js');
  const encoded = Buffer.from(fs.readFileSync(filename, 'utf8')).toString('base64');
  safety = await import(`data:text/javascript;base64,${encoded}`);
});

test('legacy combat colors cannot break out of a style attribute', () => {
  assert.equal(safety.combatCssColor('#12aBcF'), '#12aBcF');
  assert.equal(safety.combatCssColor(0x123456), '#123456');
  assert.equal(safety.combatCssColor('#fff" onmouseover="alert(1)'), '#dd4444');
  assert.equal(safety.combatCssColor('red; background:url(javascript:alert(1))'), '#dd4444');
});

test('legacy combat numeric fields render as bounded numeric text', () => {
  assert.equal(safety.combatModifier('5" title="owned'), '+0');
  assert.equal(safety.combatSpellLevel('2" onclick="owned'), 0);
  assert.equal(safety.combatInteger('<img src=x onerror=alert(1)>', { fallback: 1 }), 1);
  assert.equal(safety.combatInteger('100000000', { min: 0, max: 999 }), 999);
  assert.equal(safety.combatModifier('-3'), '-3');
});
