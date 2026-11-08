import assert from 'node:assert/strict';
import test from 'node:test';
import { standingPose } from '../src/pose.js';
import { GAP, Ritual, clampToSide, inView, isHeart, movingLimbs, twoThumbsUp } from '../src/ritual.js';

const body = (side = 0, changes = {}) => {
  const pose = standingPose(side, 0, 'ready').map((p) => ({ ...p, v: 1 }));
  for (const [i, p] of Object.entries(changes)) pose[i] = { ...pose[i], ...p };
  return pose;
};

// A hand's 21 points from a wrist position, with the thumb and index tips placed.
function hand({ wrist, thumb, index, gesture = 'None' }) {
  const points = Array.from({ length: 21 }, () => ({ ...wrist }));
  points[9] = { x: wrist.x, y: wrist.y - 0.08 };
  points[4] = thumb;
  points[8] = index;
  return { points, gesture, score: 0.9 };
}

test('in view means head and shoulders on screen: legs and feet can be out of frame', () => {
  assert.equal(inView(body()), true);
  assert.equal(inView(body(0, { 25: { y: 1.2 }, 26: { y: 1.2 }, 27: { y: 1.4 }, 28: { y: 1.4, v: 0.1 } })), true, 'no legs or feet in frame');
  assert.equal(inView(body(0, { 0: { y: 0.01 } })), false, 'head cut off at the top');
  assert.equal(inView(body(0, { 11: { v: 0.2 } })), false, 'a shoulder MediaPipe cannot really see');
  assert.equal(inView(null), false);
});

test('bodies stay on their own side of the gap in the middle', () => {
  const crossing = body(0).map((p) => ({ ...p, x: p.x + 0.3 }));
  const clamped = clampToSide(crossing, 0);
  const coreRight = Math.max(...[0, 11, 12, 23, 24, 25, 26, 27, 28].map((i) => clamped[i].x));
  assert.ok(Math.abs(coreRight - (0.5 - GAP / 2)) < 1e-9, 'Player 1 stops at the gap');

  const p2 = clampToSide(body(1).map((p) => ({ ...p, x: p.x - 0.3 })), 1);
  assert.ok(Math.min(...[0, 11, 12, 23, 24].map((i) => p2[i].x)) >= 0.5 + GAP / 2 - 1e-9, 'Player 2 too');
  const home = body(0);
  assert.equal(clampToSide(home, 0), home, 'a body on its own side is left alone');
});

test('two thumbs up needs both hands', () => {
  const up = hand({ wrist: { x: 0.2, y: 0.5 }, thumb: { x: 0.2, y: 0.4 }, index: { x: 0.21, y: 0.45 }, gesture: 'Thumb_Up' });
  assert.equal(twoThumbsUp([up]), false);
  assert.equal(twoThumbsUp([up, { ...up }]), true);
});

test('a heart is two hands with index tips together on top and thumbs together below', () => {
  const left = hand({ wrist: { x: 0.25, y: 0.55 }, index: { x: 0.3, y: 0.4 }, thumb: { x: 0.3, y: 0.5 } });
  const right = hand({ wrist: { x: 0.35, y: 0.55 }, index: { x: 0.305, y: 0.4 }, thumb: { x: 0.305, y: 0.5 } });
  assert.equal(isHeart([left, right]), true);
  const apart = hand({ wrist: { x: 0.5, y: 0.55 }, index: { x: 0.45, y: 0.4 }, thumb: { x: 0.45, y: 0.5 } });
  assert.equal(isHeart([left, apart]), false, 'fingertips not touching');
  const flipped = hand({ wrist: { x: 0.35, y: 0.55 }, index: { x: 0.305, y: 0.5 }, thumb: { x: 0.305, y: 0.4 } });
  const flippedLeft = hand({ wrist: { x: 0.25, y: 0.55 }, index: { x: 0.3, y: 0.5 }, thumb: { x: 0.3, y: 0.4 } });
  assert.equal(isHeart([flippedLeft, flipped]), false, 'upside down is not a heart');
});

test('a dance is several limbs moving fast', () => {
  const still = body();
  const moved = still.map((p, i) => (i >= 13 ? { ...p, x: p.x + 0.04, y: p.y - 0.03 } : p));
  assert.ok(movingLimbs(still, moved, 0.066) >= 4);
  assert.equal(movingLimbs(still, still, 0.066), 0);
});

test('the ritual goes 1/3, 2/3, 3/3 for every player, and waits until they are in view', () => {
  const ritual = new Ritual({ sides: [0, 1] });
  const thumbs = [hand({ wrist: { x: 0.2, y: 0.5 }, thumb: { x: 0.2, y: 0.4 }, index: { x: 0.2, y: 0.45 }, gesture: 'Thumb_Up' })];
  thumbs.push(thumbs[0]);
  const feed = (t, poses, hands) => ritual.update({ poses, hands, aspect: 16 / 9 }, t);

  // Player 1's feet are out of frame, which is fine. Player 2 is too close (head cut off).
  let t = 0;
  const noFeet = (side) => body(side, { 27: { y: 1.1 }, 28: { y: 1.1 } });
  for (; t <= 1000; t += 50) feed(t, { 0: noFeet(0), 1: body(1, { 0: { y: 0.01 } }) }, { 0: thumbs, 1: thumbs });
  assert.equal(ritual.step, 0);
  assert.equal(ritual.complete[0], true);
  assert.equal(ritual.inFrame[1], false);

  for (; t <= 2000; t += 50) feed(t, { 0: body(0), 1: body(1) }, { 0: thumbs, 1: thumbs });
  assert.equal(ritual.step, 1, 'both did two thumbs up');

  const left = hand({ wrist: { x: 0.25, y: 0.55 }, index: { x: 0.3, y: 0.4 }, thumb: { x: 0.3, y: 0.5 } });
  const right = hand({ wrist: { x: 0.35, y: 0.55 }, index: { x: 0.305, y: 0.4 }, thumb: { x: 0.305, y: 0.5 } });
  for (; t <= 3000; t += 50) feed(t, { 0: body(0), 1: body(1) }, { 0: [left, right], 1: [left, right] });
  assert.equal(ritual.step, 2, 'both made a heart');

  // Dance: limbs swing back and forth on every new pose.
  for (let n = 0; t <= 7000; t += 66, n += 1) {
    const swing = n % 2 ? 0.05 : -0.05;
    const dance = (side) => body(side).map((p, i) => (i >= 13 ? { ...p, x: p.x + swing, y: p.y + swing / 2 } : p));
    feed(t, { 0: dance(0), 1: dance(1) }, {});
  }
  assert.equal(ritual.done, true, '3/3: ready for the countdown');
});
