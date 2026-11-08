import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyTracks, swingOf, throwDirection, trackWrists } from '../src/throws.js';

const ASPECT = 16 / 9;
// Player 1 (left side) moves one wrist from `from` to `to` over `ms`, sampled every 66 ms
// (the body tracker's rate), with the other wrist still.
function swing(from, to, ms = 200, wrist = 16) {
  const tracks = emptyTracks();
  const still = { x: 0.3, y: 0.6 };
  const steps = Math.max(1, Math.round(ms / 66));
  for (let i = 0; i <= steps; i += 1) {
    const k = i / steps;
    const moving = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    const body = [];
    body[wrist] = moving;
    body[wrist === 16 ? 15 : 16] = still;
    trackWrists(tracks, body, 1000 + i * (ms / steps));
  }
  return tracks;
}
const foeTorso = { x: 0.75, y: 0.5 };

test('a sideways swing at the opponent throws along the swing', () => {
  const found = swingOf(swing({ x: 0.3, y: 0.5 }, { x: 0.42, y: 0.46 }), 0, ASPECT);
  assert.ok(found, 'counts as a throw');
  const dir = throwDirection(found, foeTorso, ASPECT);
  assert.ok(dir.x > 0 && dir.y < 0, 'toward the opponent, a little upward, like the swing');
});

test('a forward or overhand swing (mostly up and down) still throws, at the opponent', () => {
  const overhand = swingOf(swing({ x: 0.33, y: 0.3 }, { x: 0.34, y: 0.55 }), 0, ASPECT);
  assert.ok(overhand, 'an overhand throw at the screen counts');
  const dir = throwDirection(overhand, foeTorso, ASPECT);
  assert.ok(dir.x > 0.3, 'it heads across to the opponent');
});

test('either hand can throw', () => {
  assert.ok(swingOf(swing({ x: 0.3, y: 0.5 }, { x: 0.42, y: 0.5 }, 200, 15), 0, ASPECT), 'left wrist');
  assert.ok(swingOf(swing({ x: 0.3, y: 0.5 }, { x: 0.42, y: 0.5 }, 200, 16), 0, ASPECT), 'right wrist');
});

test('a wind-up straight back, or a slow move, is not a throw', () => {
  assert.equal(swingOf(swing({ x: 0.4, y: 0.5 }, { x: 0.25, y: 0.5 }), 0, ASPECT), null, 'pulling back to wind up');
  assert.equal(swingOf(swing({ x: 0.3, y: 0.5 }, { x: 0.33, y: 0.5 }, 260), 0, ASPECT), null, 'a slow drift');
  assert.ok(swingOf(swing({ x: 0.6, y: 0.5 }, { x: 0.45, y: 0.5 }), 1, ASPECT), 'Player 2 throws toward the left');
});
