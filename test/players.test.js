import assert from 'node:assert/strict';
import test from 'node:test';
import { POWER_START, powerGain, powerLabel } from '../shared/rules.js';

process.env.AUTH0_DOMAIN = 'hexbyte-test.us.auth0.com';
process.env.AUTH0_CLIENT_ID = 'spa-client';
process.env.AUTH0_FACE_CLIENT_ID = 'face-client';
process.env.AUTH0_FACE_CLIENT_SECRET = 'face-secret';
process.env.GATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const { playerFinishedDuel, playerLoggedIn, publicRecord, readPlayer } = await import('../server/players.js');
const readPower = async (sub) => (await readPlayer(sub)).level;
const awardPower = async (sub, duel) => {
  const change = await playerFinishedDuel(sub, duel);
  return change && { before: change.before, after: change.after, gained: change.gained };
};
const { memoFor } = await import('../server/solana.js');

// A pretend Auth0 tenant with one user, who keeps their power level in app_metadata.
function fakeAuth0() {
  const user = { user_id: 'auth0|kareem', app_metadata: {} };
  const patches = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    if (pathname === '/oauth/token') return reply(200, { access_token: 'management-token', expires_in: 86400 });
    assert.equal(decodeURIComponent(pathname), '/api/v2/users/auth0|kareem');
    if (options.method === 'PATCH') {
      patches.push(body);
      user.app_metadata = { ...user.app_metadata, ...body.app_metadata };
    }
    return reply(200, user);
  };
  return { user, patches, fetch };
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

test('power level labels: a number up to 100, then MAX!!!', () => {
  assert.equal(powerLabel(1), '1');
  assert.equal(powerLabel(100), '100');
  assert.equal(powerLabel(101), 'MAX!!!');
  assert.equal(powerLabel(5000), 'MAX!!!');
  assert.equal(powerLabel(null), '');
});

test('a win levels up most, then a draw, then a loss', () => {
  assert.ok(powerGain({ won: true }) > powerGain({ draw: true }));
  assert.ok(powerGain({ draw: true }) > powerGain());
});

test('the more you play, the higher your power level, saved on your account', async () => {
  const auth0 = fakeAuth0();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth0.fetch;
  try {
    assert.equal(await readPower('auth0|kareem'), POWER_START, 'a new wizard starts at the bottom');

    const win = await awardPower('auth0|kareem', { matchId: 'm-1', startedAt: minutesAgo(2), won: true });
    assert.deepEqual(win, { before: POWER_START, after: POWER_START + powerGain({ won: true }), gained: powerGain({ won: true }) });
    const loss = await awardPower('auth0|kareem', { matchId: 'm-2', startedAt: minutesAgo(2) });
    assert.equal(loss.gained, powerGain());
    assert.equal(await readPower('auth0|kareem'), loss.after, 'it comes back at the level left off at');
    const saved = auth0.user.app_metadata.hexbyte_player;
    assert.equal(saved.duels, 2);
    assert.equal(saved.wins, 1);
    assert.equal(saved.losses, 1);
    assert.equal(saved.draws, 0);
    assert.ok(saved.lastPlayed);

    const again = await awardPower('auth0|kareem', { matchId: 'm-2', startedAt: minutesAgo(2), won: true });
    assert.equal(again.gained, 0, 'one duel only pays once');
    assert.equal(await awardPower('auth0|kareem', { matchId: 'm-3', startedAt: new Date().toISOString(), won: true }), null, 'quitting at once pays nothing');
    assert.equal(auth0.patches.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the result memo carries the new power levels', () => {
  const match = { id: 'm-abc', game: '0123456789abcdef', players: [{ side: 0, player: 'aaaaaaaaaaaaaaaa' }, { side: 1, player: 'bot-hard' }] };
  const memo = memoFor(match, { type: 'result', winner: 0, finalHp: [80, 0], power: [11, null] });
  assert.deepEqual(JSON.parse(memo.slice(memo.indexOf('{'))).pl, [11, null]);
  const guests = memoFor(match, { type: 'result', winner: 0, finalHp: [80, 0], power: [null, null] });
  assert.ok(!guests.includes('"pl"'), 'no power levels, no field');
});

test('the player record keeps logins and the name, for the next sign-in from anywhere', async () => {
  const auth0 = fakeAuth0();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth0.fetch;
  try {
    const first = await playerLoggedIn('auth0|kareem', { name: 'Kareem', now: new Date('2026-11-08T12:00:00Z') });
    assert.equal(first.logins, 1);
    assert.equal(first.firstSeen, '2026-11-08T12:00:00.000Z');
    await playerFinishedDuel('auth0|kareem', { matchId: 'm-9', startedAt: minutesAgo(3), draw: true });
    const second = await playerLoggedIn('auth0|kareem', { name: 'Kareem', now: new Date('2026-11-09T08:00:00Z') });
    assert.equal(second.logins, 2);
    assert.equal(second.firstSeen, '2026-11-08T12:00:00.000Z', 'first seen stays');
    assert.equal(second.lastLogin, '2026-11-09T08:00:00.000Z');
    assert.equal(second.draws, 1, 'stats survive the next login');
    assert.equal(second.level, POWER_START + powerGain({ draw: true }));
    assert.equal(second.name, 'Kareem');
    assert.equal(publicRecord(second).paid, undefined, 'bookkeeping stays on the server');
  } finally {
    globalThis.fetch = realFetch;
  }
});
