import assert from 'node:assert/strict';
import test from 'node:test';
import { Duel } from '../src/duel.js';

function makeDuel(replies) {
  const events = [];
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
    cast: async () => queue.shift(),
    onLog: () => {},
    onEnd: () => {},
    onEvent: (name, details) => events.push({ name, ...details }),
  });
  return { duel, events, names: () => events.map((event) => event.name) };
}

const later = (ms) => performance.now() + ms;

test('a fire spell plays its sounds in order: listening, channel, cast, then the hit', async () => {
  const { duel, events, names } = makeDuel([
    { outcome: 'cast', element: 'fire', power: 8, damage: 22, shield: 0, pierce: 0, name: 'Blaze' },
  ]);
  await duel.trigger(0, 'Closed_Fist');
  assert.deepEqual(names(), ['listening', 'listened', 'channel', 'cast']);
  assert.equal(events.at(-1).power, 8);

  duel.update(later(800));
  const hit = events.at(-1);
  assert.deepEqual({ name: hit.name, side: hit.side, element: hit.element, dealt: hit.dealt }, { name: 'hit', side: 1, element: 'fire', dealt: 22 });
});

test('a shield reports absorbed damage on the next hit, and lightning pierces half', async () => {
  const { duel, events } = makeDuel([
    { outcome: 'cast', element: 'shield', power: 4, damage: 0, shield: 20, pierce: 0, name: 'Wall' },
    { outcome: 'cast', element: 'lightning', power: 8, damage: 20, shield: 0, pierce: 0.5, name: 'Bolt' },
  ]);
  await duel.trigger(1, 'Open_Palm');
  await duel.trigger(0, 'Victory');
  duel.update(later(400));
  const hit = events.at(-1);
  assert.equal(hit.name, 'hit');
  assert.equal(hit.element, 'lightning');
  assert.equal(hit.absorbed, 10);
  assert.equal(hit.dealt, 10);
});

test('cheats, empty mana and failures each have their own sound event', async () => {
  const { duel, names } = makeDuel([
    { outcome: 'cheat', element: 'fire', blockedBy: 'prompt_injection' },
    { outcome: 'out_of_mana', element: 'fire', blockedBy: 'agent_step_budget' },
  ]);
  await duel.trigger(0, 'Closed_Fist');
  duel.players[1].status = 'ready';
  await duel.trigger(1, 'Closed_Fist');
  assert.ok(names().includes('backfire'));
  assert.ok(names().includes('outOfMana'));
  assert.equal(duel.players[0].hp, 88);
});

test('a knockout ends the duel with an end event marked as a knockout', async () => {
  const { duel, events } = makeDuel([]);
  duel.hit(1, 200, 0, 'fire');
  duel.update(later(10));
  const end = events.at(-1);
  assert.deepEqual({ name: end.name, winner: end.winner, knockout: end.knockout }, { name: 'end', winner: 0, knockout: true });
});
