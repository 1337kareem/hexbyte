import assert from 'node:assert/strict';
import test from 'node:test';
import { CHORDS, CLAVE_STEPS, MUSIC_VOLUME, SFX_VOLUME, arpSteps, chordAt, midi } from '../src/audio.js';

test('notes are tuned to A440', () => {
  assert.equal(midi(69), 440);
  assert.ok(Math.abs(midi(62) - 293.66) < 0.01, 'D4');
});

test('the progression changes chord every two bars and loops every eight', () => {
  assert.equal(chordAt(0).name, 'Dm');
  assert.equal(chordAt(31).name, 'Dm');
  assert.equal(chordAt(32).name, 'Bb');
  assert.equal(chordAt(32 * CHORDS.length).name, 'Dm');
});

test('the arpeggio gets busier as the duel heats up', () => {
  const calm = arpSteps(0.1).length;
  const tense = arpSteps(0.5).length;
  const frantic = arpSteps(0.9).length;
  assert.ok(calm < tense && tense < frantic);
  for (const steps of [arpSteps(0), arpSteps(0.5), arpSteps(1)]) {
    assert.ok(steps.every((step) => step >= 0 && step < 16));
  }
});

test('the clave fits in two bars, and music stays well below the effects', () => {
  assert.ok(CLAVE_STEPS.every((step) => step >= 0 && step < 32));
  assert.ok(MUSIC_VOLUME < SFX_VOLUME / 3);
});
