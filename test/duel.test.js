import assert from 'node:assert/strict';
import test from 'node:test';
import { Duel, HOLD_LIMIT_MS, arcCrossing } from '../src/duel.js';
import { judgeBonus } from '../shared/rules.js';

// A duel where each cast gets the next reply in the queue (a value or a promise).
function makeDuel(replies = []) {
  const events = [];
  const log = [];
  const queue = [...replies];
  const duel = new Duel({
    match: {
      matchId: 'm-test',
      players: [
        { side: 0, name: 'Ana', kind: 'guest', mana: 5 },
        { side: 1, name: 'Ben', kind: 'guest', mana: 5 },
      ],
    },
    listen: async () => 'Flamingo inferno!',
    cast: () => queue.shift() ?? new Promise(() => {}),
    onLog: (entry) => log.push(entry),
    onEnd: () => {},
    onEvent: (name, details) => events.push({ name, ...details }),
    speakMs: 0,
  });
  duel.aspect = 16 / 9;
  return { duel, events, log, names: () => events.map((event) => event.name) };
}

const later = (ms) => performance.now() + ms;

// Steps the duel forward in 16 ms frames until the orbs are gone.
function fly(duel, { onStep, maxMs = 4000 } = {}) {
  const start = performance.now();
  let t = start;
  duel.lastUpdate = t;
  do {
    t += 16;
    onStep?.(t);
    duel.update(t);
  } while ((duel.projectiles.length > 0 || duel.strikes.length > 0) && t - start < maxMs);
  return t;
}

// Player 1 throws straight across at a height (0.34 head, 0.52 chest, 0.82 shins).
const throwAt = (duel, y, side = 0) => duel.throwOrb(side, { x: side === 0 ? 0.36 : 0.64, y }, { x: side === 0 ? 1 : -1, y: 0 });

test('an attack charges an orb in hand, and nothing happens until it is thrown', async () => {
  const { duel, names } = makeDuel();
  await duel.fire(0, 'Closed_Fist');
  assert.deepEqual(names(), ['listening', 'listened', 'armed']);
  assert.equal(duel.players[0].status, 'armed');
  assert.equal(duel.players[0].orb.element, 'fire');
  assert.equal(duel.players[0].manaLeft, 4, 'mana is spent when the orb appears');
  duel.update(later(2000));
  assert.equal(duel.players[1].hp, 100);
});

test('a straight throw hits the torso for full damage, the head for 1.5x and the legs for 0.75x', async () => {
  for (const [y, zone, hp] of [
    [0.52, 'torso', 86],
    [0.34, 'head', 79],
    [0.82, 'limb', 89],
  ]) {
    const { duel, events } = makeDuel();
    await duel.fire(0, 'Closed_Fist');
    assert.equal(throwAt(duel, y), true);
    fly(duel);
    assert.equal(events.find((event) => event.name === 'hit')?.zone, zone, `a throw at ${y}`);
    assert.equal(duel.players[1].hp, hp, `${zone} damage`);
  }
});

test('power level is only a level: it changes no damage', async () => {
  for (const power of [null, 1, 100, 250]) {
    const { duel } = makeDuel();
    duel.players[0].power = power;
    await duel.fire(0, 'Closed_Fist');
    throwAt(duel, 0.52);
    fly(duel);
    assert.equal(duel.players[1].hp, 86, `power level ${power} hits like anyone else`);
  }
});

test('jumping clears a low throw and ducking clears a high one', async () => {
  for (const [y, move] of [
    [0.82, 'jump'],
    [0.34, 'duck'],
  ]) {
    const { duel } = makeDuel();
    await duel.fire(0, 'Closed_Fist');
    throwAt(duel, y);
    let dodged = false;
    fly(duel, {
      onStep: (t) => {
        if (!dodged && duel.projectiles[0]?.x > 0.5) dodged = duel.dodge(1, move, t);
      },
    });
    assert.equal(dodged, true);
    assert.equal(duel.players[1].hp, 100, `${move} dodges a throw at ${y}`);
    assert.equal(duel.casts.get(1).state, 'missed');
  }
});

test('the shield arc blocks every element, lightning included', async () => {
  for (const gesture of ['Closed_Fist', 'Victory', 'Thumb_Up']) {
    const { duel } = makeDuel();
    await duel.fire(0, gesture);
    duel.raiseShield(1, performance.now());
    throwAt(duel, 0.52);
    fly(duel);
    assert.equal(duel.players[1].hp, 100, `${gesture} is blocked`);
    assert.equal(duel.casts.get(1).state, 'blocked');
  }
});

test('lightning strikes down from the sky where it was thrown, after a target mark', async () => {
  for (const [y, zone] of [
    [0.34, 'head'],
    [0.52, 'torso'],
    [0.82, 'limb'],
  ]) {
    const { duel, events } = makeDuel();
    await duel.fire(0, 'Victory');
    throwAt(duel, y);
    assert.equal(duel.projectiles.length, 0, 'no orb flies across');
    const [strike] = duel.strikes;
    assert.ok(Math.abs(strike.y - y) < 0.01, 'the mark is where the throw was aimed');
    assert.ok(strike.x > 0.6, "and on the opponent's side");
    duel.update(strike.start + 200);
    assert.equal(duel.players[1].hp, 100, 'nothing yet: the mark comes first');
    fly(duel);
    assert.equal(events.find((event) => event.name === 'hit')?.zone, zone, `a strike at ${y}`);
    assert.ok(duel.effects.some((effect) => effect.type === 'strike'), 'a bolt comes down');
  }
});

test('lightning has no headshot bonus', async () => {
  const damageAt = async (y) => {
    const { duel } = makeDuel();
    await duel.fire(0, 'Victory');
    throwAt(duel, y);
    fly(duel);
    return 100 - duel.players[1].hp;
  };
  assert.equal(await damageAt(0.34), await damageAt(0.52), 'a head strike does what a body strike does');
});

test('lightning can be dodged by ducking, shielded, or thrown over their head', async () => {
  const ducked = makeDuel();
  await ducked.duel.fire(0, 'Victory');
  throwAt(ducked.duel, 0.34);
  ducked.duel.dodge(1, 'duck', ducked.duel.strikes[0].at - 150);
  fly(ducked.duel);
  assert.equal(ducked.duel.players[1].hp, 100, 'ducked under a head strike');
  assert.equal(ducked.duel.casts.get(1).state, 'missed');

  const over = makeDuel();
  await over.duel.fire(0, 'Victory');
  over.duel.throwOrb(0, { x: 0.36, y: 0.4 }, { x: 1, y: -0.6 });
  fly(over.duel);
  assert.equal(over.duel.players[1].hp, 100, 'a throw aimed at the sky strikes above them');
});

test('the shield only covers an arc: a throw outside it gets through, and aiming moves it', async () => {
  // Held at chest height, a knee-high throw goes under the arc.
  const low = makeDuel();
  await low.duel.fire(0, 'Closed_Fist');
  low.duel.raiseShield(1, performance.now());
  throwAt(low.duel, 0.76);
  fly(low.duel);
  assert.equal(low.duel.casts.get(1).state, 'hit');
  assert.equal(low.duel.casts.get(1).zone, 'limb');

  // Aimed low, the same throw is blocked.
  const aimed = makeDuel();
  await aimed.duel.fire(0, 'Closed_Fist');
  aimed.duel.raiseShield(1, performance.now(), 0.84);
  throwAt(aimed.duel, 0.76);
  fly(aimed.duel);
  assert.equal(aimed.duel.casts.get(1).state, 'blocked');
});

test('the shield is brief and has to recharge', async () => {
  const { duel } = makeDuel();
  const t = performance.now();
  assert.ok(duel.raiseShield(1, t));
  assert.ok(duel.barrier(1, t + 500));
  assert.equal(duel.barrier(1, t + 2000), null, 'gone after a moment');
  assert.equal(duel.raiseShield(1, t + 2000), null, 'still recharging');
  assert.ok(duel.raiseShield(1, t + 3100), 'ready again 3 seconds after it went up');
});

test('each player gets a scorecard: thrown, hits, blocks, damage, and the judge ratings', async () => {
  const { duel } = makeDuel([{ outcome: 'cast', element: 'fire', power: 7, bonus: { damage: 0 }, rating: 'signed-7' }]);
  const fired = await duel.fire(0, 'Closed_Fist');
  throwAt(duel, 0.52);
  fly(duel);
  await fired.judged;
  await duel.fire(0, 'Closed_Fist');
  duel.raiseShield(1, performance.now());
  throwAt(duel, 0.52);
  fly(duel);
  const { players, ratings } = duel.result();
  assert.deepEqual(players[0].stats, { thrown: 2, hits: 1, blocks: 0, damage: 100 - duel.players[1].hp });
  assert.equal(players[1].stats.blocks, 1, 'the second throw hit the shield');
  assert.deepEqual(ratings, ['signed-7']);
});

test('attacks can be spammed: out of mana, they keep coming at once, unjudged', async () => {
  let judged = 0;
  const { duel } = makeDuel();
  duel.cast = () => {
    judged += 1;
    return new Promise(() => {});
  };
  duel.listen = () => new Promise(() => {});
  duel.players[0].manaLeft = 0;
  for (let i = 0; i < 12; i += 1) {
    const fired = await duel.fire(0, i % 2 ? 'Victory' : 'Closed_Fist');
    assert.ok(fired, `attack ${i + 1} fires`);
    assert.equal(duel.players[0].status, 'armed', 'no waiting for an incantation');
    throwAt(duel, 0.52);
    assert.equal(duel.players[0].status, 'ready');
  }
  assert.equal(judged, 0, 'no judge calls without mana');
  assert.equal(duel.projectiles.length + duel.strikes.length, 12, 'twelve attacks on the way');
  assert.equal(duel.over, false);
});

test('only the shield has a cooldown: throw, and you can cast the same attack again at once', async () => {
  const { duel } = makeDuel();
  await duel.fire(0, 'Closed_Fist');
  assert.equal(await duel.fire(0, 'Victory'), null, 'one orb at a time: throw it first');
  throwAt(duel, 0.52);
  assert.equal(duel.players[0].status, 'ready', 'no cooldown after a throw');
  assert.ok(await duel.fire(0, 'Closed_Fist'), 'the same attack again, right away');

  const t = performance.now();
  assert.ok(duel.dodge(1, 'jump', t));
  assert.ok(duel.dodge(1, 'duck', t + 700), 'a new dodge as soon as the last one lands');
});

test('the judge grows an orb still in hand, and adds a bonus to a hit that already landed', async () => {
  const early = makeDuel([{ outcome: 'cast', element: 'fire', power: 9, name: 'Blaze', bonus: judgeBonus('fire', 9) }]);
  const fired = await early.duel.fire(0, 'Closed_Fist');
  await fired.judged;
  assert.equal(early.duel.players[0].orb.power, 9);
  throwAt(early.duel, 0.52);
  fly(early.duel);
  assert.equal(early.duel.players[1].hp, 76, 'power 9 fire: 24 to the torso');

  let answer;
  const late = makeDuel([new Promise((resolve) => (answer = resolve))]);
  const thrown = await late.duel.fire(0, 'Closed_Fist');
  throwAt(late.duel, 0.34);
  fly(late.duel);
  assert.equal(late.duel.players[1].hp, 79, 'base headshot');
  answer({ outcome: 'cast', element: 'fire', power: 9, name: 'Blaze', bonus: judgeBonus('fire', 9) });
  await thrown.judged;
  assert.equal(late.duel.players[1].hp, 64, 'the 10 bonus lands on the head too: +15');
});

test('a missed throw earns no bonus, and an orb held too long is thrown for you', async () => {
  let answer;
  const { duel } = makeDuel([new Promise((resolve) => (answer = resolve))]);
  const fired = await duel.fire(0, 'Closed_Fist');
  duel.throwOrb(0, { x: 0.36, y: 0.52 }, { x: 1, y: -1.5 });
  fly(duel);
  answer({ outcome: 'cast', element: 'fire', power: 10, name: 'Blaze', bonus: judgeBonus('fire', 10) });
  await fired.judged;
  assert.equal(duel.players[1].hp, 100);

  const slow = makeDuel();
  await slow.duel.fire(0, 'Closed_Fist');
  slow.duel.update(later(HOLD_LIMIT_MS + 50));
  assert.equal(slow.duel.players[0].orb, null);
  assert.equal(slow.duel.casts.get(1).state, 'flying', 'auto-thrown, not fizzled');
  fly(slow.duel);
  assert.ok(slow.duel.players[1].hp < 100, 'and it flies at the opponent');
});

test('a cheat crumbles the orb and backfires', async () => {
  const { duel, names } = makeDuel([{ outcome: 'cheat', element: 'fire', blockedBy: 'prompt_injection' }]);
  const fired = await duel.fire(0, 'Closed_Fist');
  await fired.judged;
  assert.equal(duel.players[0].orb, null);
  assert.equal(duel.players[0].hp, 88);
  assert.ok(names().includes('backfire'));
});

test('a frost hit freezes, and there is no life drain any more', async () => {
  const frost = makeDuel();
  await frost.duel.fire(0, 'Thumb_Up');
  throwAt(frost.duel, 0.52);
  fly(frost.duel);
  assert.equal(frost.duel.isFrozen(1), true);
  assert.equal(await frost.duel.fire(1, 'Closed_Fist'), null, 'a frozen wizard casts nothing');

  const { duel } = makeDuel();
  assert.equal(await duel.fire(0, 'ILoveYou'), null);
});

test('a knockout ends the duel with an end event marked as a knockout', async () => {
  const { duel, events } = makeDuel([]);
  duel.hit(1, 200, 0, 'fire');
  duel.update(later(10));
  const end = events.at(-1);
  assert.deepEqual({ name: end.name, winner: end.winner, knockout: end.knockout }, { name: 'end', winner: 0, knockout: true });
});

test('a duel waiting for the countdown does nothing and keeps its clock until BATTLE', async () => {
  const events = [];
  const duel = new Duel({
    match: { matchId: 'm-wait', players: [{ side: 0, name: 'Ana', kind: 'guest', mana: 5 }, { side: 1, name: 'Ben', kind: 'guest', mana: 5 }] },
    listen: async () => 'Flamingo inferno!',
    cast: () => new Promise(() => {}),
    onLog: () => {},
    onEnd: () => {},
    onEvent: (name) => events.push(name),
    speakMs: 0,
    waitForStart: true,
  });
  assert.equal(await duel.fire(0, 'Closed_Fist'), null);
  assert.equal(duel.raiseShield(1), null);
  assert.equal(duel.dodge(1, 'jump'), false);
  duel.update(later(200_000));
  assert.equal(duel.over, false, 'the clock has not started');
  assert.equal(duel.timeLeft(), 90);
  duel.begin();
  assert.ok(events.includes('battle'));
  assert.ok(await duel.fire(0, 'Closed_Fist'), 'after BATTLE! spells work');
});

test('an orb crossing into the arc is caught; one coming in beside it is not', () => {
  const arc = { cx: 0.5, cy: 0.5, r: 0.2, angle: Math.PI, span: Math.PI / 4, aspect: 1 };
  assert.ok(arcCrossing(arc, { x: 0.25, y: 0.5 }, { x: 0.31, y: 0.5 }, 1), 'straight in through the middle');
  assert.equal(arcCrossing(arc, { x: 0.5, y: 0.25 }, { x: 0.5, y: 0.31 }, 1), null, 'from above, outside the arc');
  assert.equal(arcCrossing(null, { x: 0, y: 0 }, { x: 1, y: 1 }, 1), null);
});
