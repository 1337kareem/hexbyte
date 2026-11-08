import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_RANKS, botPower } from '../shared/rules.js';
import { Bot, chooseElement, incantation, pickZone } from '../src/bot.js';
import { Duel } from '../src/duel.js';

const player = (changes = {}) => ({ hp: 100, shield: 0, status: 'ready', element: null, ...changes });
const always = (value) => () => value;

test('each rank keeps its spell power inside its range', () => {
  assert.equal(botPower('easy', 9), 4);
  assert.equal(botPower('easy', 1), 1);
  assert.equal(botPower('medium', 10), 7);
  assert.equal(botPower('medium', 1), 3);
  assert.equal(botPower('hard', 2), 6);
  assert.equal(botPower('hard', 'nonsense'), 6);
  assert.ok(BOT_RANKS.easy.mana < BOT_RANKS.hard.mana);
  assert.ok(BOT_RANKS.easy.thinkMs[0] > BOT_RANKS.hard.thinkMs[1], 'hard thinks faster than easy');
});

test('hard zaps through a shield and freezes you when it can', () => {
  const late = always(0.9);
  assert.equal(chooseElement('hard', player(), player({ barrierUntil: 5000 }), late, 1000), 'lightning');
  assert.equal(chooseElement('hard', player(), player(), always(0.1), 1000), 'frost');
  assert.equal(chooseElement('hard', player(), player({ frozenUntil: 5000 }), always(0.1), 1000), 'fire');
  assert.equal(chooseElement('hard', player(), player(), late, 1000), 'fire');
});

test('only fire, lightning and frost are chosen; shields are for defense', () => {
  for (const rank of ['easy', 'medium', 'hard']) {
    for (const roll of [0, 0.3, 0.6, 0.95]) {
      assert.ok(['fire', 'lightning', 'frost'].includes(chooseElement(rank, player({ hp: 20 }), player(), always(roll), 1000)));
    }
  }
});

test('hard aims for the head, easy mostly at the body', () => {
  assert.equal(pickZone('hard', always(0.1)), 'head');
  assert.equal(pickZone('easy', always(0.1)), 'torso');
  assert.equal(pickZone('easy', always(0.99)), 'limb');
  assert.match(incantation('hard', 'fire', always(0)), /Ocean Drive/);
});

test('the AI never says the same line twice in one duel', () => {
  const used = new Set();
  const lines = Array.from({ length: 8 }, () => incantation('hard', 'frost', Math.random, used));
  assert.equal(new Set(lines).size, lines.length);
});

function botDuel() {
  const heard = [];
  const duel = new Duel({
    match: {
      matchId: 'm-bot',
      players: [
        { side: 0, name: 'Ana', kind: 'guest', mana: 8 },
        { side: 1, name: 'Archmage', kind: 'bot', rank: 'hard', mana: 10 },
      ],
    },
    listen: async (side) => {
      heard.push(side);
      return null;
    },
    cast: () => new Promise(() => {}),
    onLog: () => {},
    onEnd: () => {},
    speakMs: 0,
  });
  return { duel, heard };
}

test('the AI charges an orb with its own words, then throws it at you', async () => {
  const { duel, heard } = botDuel();
  const bot = new Bot({ duel, side: 1, rank: 'hard', random: always(0.9) });
  await bot.think();
  assert.deepEqual(heard, [], 'the AI never waits on a microphone');
  assert.equal(duel.players[1].status, 'armed');
  assert.match(duel.players[1].words, /Calle Ocho|Ocean Drive|sun/);
  bot.throwOrb();
  bot.stop();
  assert.equal(duel.projectiles.length, 1);
  assert.ok(duel.projectiles[0].vx < 0, 'thrown toward Player 1 on the left');
});

test('the AI dodges or shields an orb that is about to hit it', async () => {
  const { duel } = botDuel();
  await duel.fire(0, 'Closed_Fist');
  duel.throwOrb(0, { x: 0.62, y: 0.34 }, { x: 1, y: 0 });
  const bot = new Bot({ duel, side: 1, rank: 'hard', random: always(0) });
  bot.defend();
  bot.stop();
  const me = duel.players[1];
  assert.ok(me.barrierUntil > performance.now() || me.move?.kind === 'duck', 'a high orb gets a shield or a duck');
});

test('the AI ducks head-high orbs, jumps leg-high ones, and shields chest-high ones', async () => {
  for (const [y, expect] of [
    [0.34, 'duck'],
    [0.84, 'jump'],
    [0.55, 'shield'],
  ]) {
    const { duel } = botDuel();
    await duel.fire(0, 'Closed_Fist');
    duel.throwOrb(0, { x: 0.62, y }, { x: 1, y: 0 });
    // Dice: always dodge, never pick the optional shield (so head-high means duck).
    const rolls = [0, 0.99];
    const bot = new Bot({ duel, side: 1, rank: 'hard', random: () => rolls.shift() ?? 0.99 });
    bot.defend();
    bot.stop();
    const me = duel.players[1];
    const did = me.barrierUntil > performance.now() ? 'shield' : me.move?.kind;
    assert.equal(did, expect, `an orb at ${y}`);
  }
});
