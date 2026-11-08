import assert from 'node:assert/strict';
import test from 'node:test';
import { explorerUrl, fingerprint, gameHash, loginHash, loginMemo, memoFor, playerHash, scoreHash } from '../server/solana.js';

process.env.GATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ana = playerHash('auth0|ana');
const anaLogin = loginHash('auth0|ana', 1794130000);
const match = {
  id: 'm-abc',
  startedAt: '2026-11-08T11:00:00.000Z',
  players: [
    { side: 0, name: 'Ana', player: ana, login: anaLogin, kind: 'wizard' },
    { side: 1, name: 'Archmage', player: 'bot-hard', kind: 'bot', rank: 'hard' },
  ],
};
match.game = gameHash(match);
const g = match.game;
const body = (memo) => JSON.parse(memo.slice(memo.indexOf('{')));

test('a judged spell goes on the ledger with a fingerprint of its Prune receipt', () => {
  const receipt = '{"receipt_signature":"abc","cost_with_prune_usd":0.000012}';
  const memo = memoFor(match, { type: 'cast', side: 0, element: 'fire', power: 9, receipt });
  assert.match(memo, /^HexByte cast \{/);
  assert.deepEqual(body(memo), { g, m: 'm-abc', p: 0, as: ana, el: 'fire', pw: 9, rc: fingerprint(receipt) });
  assert.ok(!memo.includes('Ana'), 'players are hashes, not names');
  assert.equal(fingerprint(receipt).length, 16);
  assert.ok(!memo.includes('receipt_signature'), 'only the fingerprint is published');
});

test('hits, blocks and results are recorded', () => {
  assert.deepEqual(body(memoFor(match, { type: 'hit', side: 1, element: 'frost', zone: 'head', damage: 13 })), {
    g,
    m: 'm-abc',
    by: 1,
    as: 'bot-hard',
    el: 'frost',
    z: 'head',
    dmg: 13,
  });
  assert.deepEqual(body(memoFor(match, { type: 'block', side: 0, element: 'lightning' })), { g, m: 'm-abc', by: 0, as: ana, el: 'lightning', blocked: 1 });
  assert.deepEqual(body(memoFor(match, { type: 'result', winner: 1, finalHp: [0, 42], replay: 'a1b2c3d4e5f60718' })), {
    g,
    m: 'm-abc',
    w: 1,
    hp: [0, 42],
    rp: 'a1b2c3d4e5f60718',
  });
});

test('every game has its own hash, and its start memo names the logins playing it', () => {
  assert.match(g, /^[0-9a-f]{16}$/);
  assert.notEqual(gameHash({ ...match, id: 'm-abd' }), g, 'another game, another hash');
  const rematch = { ...match, startedAt: '2026-11-08T11:05:00.000Z' };
  assert.notEqual(gameHash(rematch), g, 'a rematch is a new game');
  const relogin = { ...match, players: [{ ...match.players[0], login: loginHash('auth0|ana', 1794139999) }, match.players[1]] };
  assert.notEqual(gameHash(relogin), g, 'a new login makes a new game');
  assert.deepEqual(body(memoFor(match, { type: 'start' })), {
    g,
    m: 'm-abc',
    p: [
      { as: ana, lg: anaLogin, k: 'wizard' },
      { as: 'bot-hard', k: 'bot', r: 'hard' },
    ],
  });
});

test('the scorecard memo carries both players, their creativity and stats, and its hash', () => {
  const card = [
    { as: ana, cr: 74, j: 6, t: 14, h: 8, b: 3, dmg: 96, hp: 40, pl: 15 },
    { as: 'bot-hard', cr: 62, j: 9, t: 11, h: 6, b: 2, dmg: 60, hp: 0, pl: null },
  ];
  const hash = scoreHash(match, card);
  const memo = memoFor(match, { type: 'score', card, hash });
  assert.match(memo, /^HexByte score \{/);
  assert.deepEqual(body(memo), { g, m: 'm-abc', p: card, sh: hash });
  assert.notEqual(scoreHash(match, [{ ...card[0], cr: 99 }, card[1]]), hash, 'change one number and the hash changes');
  assert.ok(Buffer.byteLength(memo) < 500);
  assert.equal(memoFor(match, { type: 'score', card, hash: 'nope' }), null);
});

test('logins: one hash per sign-in, one hash per player, no names or Auth0 ids', () => {
  assert.equal(playerHash('auth0|ana'), ana, 'the same player is always the same hash');
  assert.notEqual(playerHash('auth0|bo'), ana);
  assert.notEqual(loginHash('auth0|ana', 1794130001), anaLogin, 'each sign-in is its own login');
  const memo = loginMemo({ hash: anaLogin, player: ana, via: 'face' });
  assert.deepEqual(body(memo), { lg: anaLogin, as: ana, via: 'face' });
  assert.ok(!memo.includes('auth0|'), 'the Auth0 id stays off the chain');
  assert.equal(loginMemo({ hash: 'not-a-hash', player: ana }), null);
});

test('whatever the browser sends is checked and trimmed before it is signed', () => {
  assert.equal(memoFor(match, { type: 'hit', side: 0, element: 'nuke', zone: 'head', damage: 5 }), null);
  assert.equal(memoFor(match, { type: 'hit', side: 0, element: 'fire', zone: 'soul', damage: 5 }), null);
  assert.equal(memoFor(match, { type: 'hit', side: 7, element: 'fire', zone: 'head', damage: 5 }), null);
  assert.equal(memoFor(match, { type: 'mint', side: 0 }), null);
  assert.equal(body(memoFor(match, { type: 'hit', side: 0, element: 'fire', zone: 'torso', damage: 99999 })).dmg, 99);
  const sneaky = memoFor({ ...match, players: [{ player: 'Ana"},{"evil":1' }] }, { type: 'cast', side: 0, element: 'fire', power: 4 });
  assert.equal(body(sneaky).as, 'Ana,evil1', 'quotes and braces are stripped, so it stays one field');
  assert.ok(Buffer.byteLength(sneaky) < 500);
});

test('explorer links point at devnet', () => {
  assert.equal(explorerUrl('5abc'), 'https://explorer.solana.com/tx/5abc?cluster=devnet');
});
