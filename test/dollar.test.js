import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStroke, scoreRunes } from '../shared/dollar.js';

// Strokes in camera-frame units (0 to 1), with a little hand wobble.
const wobble = (seed) => {
  let value = seed;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return (value / 233280 - 0.5) * 0.01;
  };
};

function circle(seed = 1, cx = 0.5, cy = 0.5, r = 0.15) {
  const noise = wobble(seed);
  return Array.from({ length: 60 }, (_, i) => {
    const a = (i / 59) * Math.PI * 2;
    return [cx + Math.cos(a) * r + noise(), cy + Math.sin(a) * r + noise()];
  });
}

function zigzag(seed = 1) {
  const noise = wobble(seed);
  return Array.from({ length: 60 }, (_, i) => [0.3 + i * 0.006 + noise(), (Math.floor(i / 10) % 2 === 0 ? 0.3 + (i % 10) * 0.03 : 0.6 - (i % 10) * 0.03) + noise()]);
}

function lightningBolt(seed = 1, scale = 1) {
  const noise = wobble(seed);
  const corners = [[0.5, 0.2], [0.4, 0.45], [0.55, 0.45], [0.45, 0.75]];
  const points = [];
  for (let c = 0; c < corners.length - 1; c += 1) {
    for (let i = 0; i < 20; i += 1) {
      const t = i / 20;
      points.push([
        0.5 + (corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t - 0.5) * scale + noise(),
        0.5 + (corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t - 0.5) * scale + noise(),
      ]);
    }
  }
  return points;
}

test('the same rune drawn twice scores high, even at a different size and place', () => {
  const first = prepareStroke(lightningBolt(1));
  const again = prepareStroke(lightningBolt(7, 0.7).map(([x, y]) => [x + 0.1, y - 0.05]));
  assert.ok(scoreRunes(again, first) > 0.85, `score was ${scoreRunes(again, first)}`);
  assert.ok(scoreRunes(prepareStroke(circle(3)), prepareStroke(circle(9, 0.3, 0.4, 0.1))) > 0.85);
});

test('different runes score low', () => {
  const bolt = prepareStroke(lightningBolt(1));
  assert.ok(scoreRunes(prepareStroke(circle(2)), bolt) < 0.8, 'a circle should not pass as a bolt');
  assert.ok(scoreRunes(prepareStroke(zigzag(4)), prepareStroke(circle(5))) < 0.8, 'a zigzag should not pass as a circle');
});

test('closed shapes with the same outline size do not pass for each other', () => {
  const square = [];
  const corners = [[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65], [0.35, 0.35]];
  for (let c = 0; c < 4; c += 1) {
    for (let i = 0; i < 15; i += 1) {
      const t = i / 15;
      square.push([corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t, corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t]);
    }
  }
  const score = scoreRunes(prepareStroke(square), prepareStroke(circle(1)));
  assert.ok(score < 0.85, `a square scored ${score} against a circle`);
});

test('tiny, flat or broken strokes are refused', () => {
  assert.equal(prepareStroke(circle(1, 0.5, 0.5, 0.005)), null);
  assert.equal(prepareStroke(Array.from({ length: 30 }, (_, i) => [0.2 + i * 0.01, 0.5])), null);
  assert.equal(prepareStroke([[0.1, 0.1]]), null);
  assert.equal(prepareStroke([...circle(1).slice(0, 20), ['x', 0.5]]), null);
  assert.equal(prepareStroke('not a stroke'), null);
});

test('a prepared rune is 64 small points', () => {
  const prepared = prepareStroke(circle(1));
  assert.equal(prepared.length, 64);
  assert.ok(JSON.stringify(prepared).length < 1500);
});
