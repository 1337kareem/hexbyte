import assert from 'node:assert/strict';
import test from 'node:test';
import { GESTURE_ELEMENTS, MAX_SHIELD, addShield, applyHit, clampPower, decideWinner, spellEffect } from '../shared/rules.js';

test('power is always a whole number from 1 to 10, whatever the AI says', () => {
  assert.equal(clampPower(9999), 10);
  assert.equal(clampPower(-5), 1);
  assert.equal(clampPower('seven'), 1);
  assert.equal(clampPower(6.6), 7);
  assert.equal(clampPower(undefined), 1);
});

test('each element does what the rules say', () => {
  const pick = ({ damage, shield, pierce, heal, freezeMs }) => ({ damage, shield, pierce, heal, freezeMs });
  assert.deepEqual(pick(spellEffect('fire', 10)), { damage: 26, shield: 0, pierce: 0, heal: 0, freezeMs: 0 });
  assert.deepEqual(pick(spellEffect('lightning', 1)), { damage: 6, shield: 0, pierce: 0.5, heal: 0, freezeMs: 0 });
  assert.deepEqual(pick(spellEffect('shield', 5)), { damage: 0, shield: 23, pierce: 0, heal: 0, freezeMs: 0 });
  assert.deepEqual(spellEffect('fire', 9999), spellEffect('fire', 10));
});

test('frost freezes longer with power', () => {
  assert.deepEqual([spellEffect('frost', 1).damage, spellEffect('frost', 1).freezeMs], [5, 2400]);
  assert.deepEqual([spellEffect('frost', 10).damage, spellEffect('frost', 10).freezeMs], [18, 6000]);
});

test('there is no heal or life drain any more', () => {
  for (const gone of ['heal', 'drain']) {
    assert.equal(Object.values(GESTURE_ELEMENTS).includes(gone), false);
    assert.equal(spellEffect(gone, 10).damage, 0);
  }
});

test('shields soak damage first', () => {
  const result = applyHit({ hp: 100, shield: 10 }, 20);
  assert.deepEqual(result, { hp: 90, shield: 0, absorbed: 10, dealt: 10 });
});

test('lightning goes through half of a shield', () => {
  const result = applyHit({ hp: 100, shield: 40 }, 20, 0.5);
  assert.equal(result.dealt, 10);
  assert.equal(result.shield, 30);
});

test('HP never drops below zero and shields have a cap', () => {
  assert.equal(applyHit({ hp: 5, shield: 0 }, 26).hp, 0);
  assert.equal(addShield(40, 38), MAX_SHIELD);
});

test('the winner has more HP, and a tie is a draw', () => {
  assert.equal(decideWinner([{ hp: 40 }, { hp: 12 }]), 0);
  assert.equal(decideWinner([{ hp: 3 }, { hp: 12 }]), 1);
  assert.equal(decideWinner([{ hp: 50 }, { hp: 50 }]), -1);
});
