import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// No Prune key and no database: the API must still hand out and check match tokens.
delete process.env.PRUNE_API_KEY;
delete process.env.MATCH_SECRET;
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.SOLANA_SECRET_KEY;
const dir = await mkdtemp(join(tmpdir(), 'hexbyte-app-'));
process.env.HEXBYTE_DATA_DIR = dir;

const { createApp, creativityScores, readMatch, readRating, signMatch, signRating } = await import('../server/app.js');

async function withServer(run) {
  const { app } = await createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(post);
  } finally {
    server.close();
  }
}

test.after(() => rm(dir, { recursive: true, force: true }));

test('a match token carries the match and cannot be forged or edited', async () => {
  const token = await signMatch({ id: 'm-1', players: [{ side: 0, mana: 5 }] });
  assert.equal((await readMatch(token)).id, 'm-1');

  const [header, payload, signature] = token.split('.');
  const edited = JSON.parse(Buffer.from(payload, 'base64url'));
  edited.match.players[0].mana = 999;
  const forged = [header, Buffer.from(JSON.stringify(edited)).toString('base64url'), signature].join('.');
  assert.equal(await readMatch(forged), null);
  assert.equal(await readMatch('nonsense'), null);
});

test('any server copy can run a duel from the token alone', async () => {
  await withServer(async (post) => {
    const started = await post('/api/match', { players: [{ side: 0, name: 'Ana' }, { side: 1, name: 'Ben' }] });
    assert.equal(started.status, 200);
    const { matchId, matchToken, players } = started.body;
    assert.deepEqual(players.map((p) => [p.name, p.mana]), [['Ana', 8], ['Ben', 8]]);

    // Without a Prune key the spell is refused politely, but the token is accepted.
    const spell = await post('/api/spell', { matchToken, side: 0, gesture: 'Closed_Fist', words: 'Flame!' });
    assert.equal(spell.status, 200);
    assert.equal(spell.body.outcome, 'error');

    assert.equal((await post('/api/spell', { matchToken: 'forged', side: 0, gesture: 'Closed_Fist' })).status, 403);
    assert.equal((await post('/api/spell', { matchToken, side: 0, gesture: 'None' })).status, 400);

    const frame = { t: Date.now(), side: 0, points: Array.from({ length: 66 }, () => 0.5) };
    assert.equal((await post(`/api/match/${matchId}/frames`, { matchToken, frames: [frame] })).body.saved, 1);
    assert.equal((await post('/api/match/someone-elses-match/frames', { matchToken, frames: [frame] })).status, 403);
    assert.equal((await post(`/api/match/${matchId}/end`, { matchToken, winner: 0, finalHp: [40, 0] })).status, 200);
  });
});

test('an AI opponent gets its rank and its mana', async () => {
  await withServer(async (post) => {
    const { players } = (await post('/api/match', { players: [{ side: 0, name: 'Ana' }, { side: 1, bot: 'hard' }] })).body;
    assert.deepEqual(
      { name: players[1].name, kind: players[1].kind, rank: players[1].rank, mana: players[1].mana },
      { name: 'Archmage', kind: 'bot', rank: 'hard', mana: 10 },
    );
    const unknown = (await post('/api/match', { players: [{ side: 1, bot: 'impossible', name: 'Ben' }] })).body.players[1];
    assert.equal(unknown.kind, 'guest');
  });
});

test('the ledger route needs a real match token, and stays quiet without a Solana key', async () => {
  await withServer(async (post) => {
    const { matchId, matchToken } = (await post('/api/match', { players: [{ side: 0, name: 'Ana' }] })).body;
    const hit = { type: 'hit', side: 0, element: 'fire', zone: 'head', damage: 21 };
    assert.equal((await post(`/api/match/${matchId}/ledger`, { matchToken: 'forged', event: hit })).status, 403);
    assert.deepEqual((await post(`/api/match/${matchId}/ledger`, { matchToken, event: hit })).body, { ledger: null });
    assert.equal((await post(`/api/match/${matchId}/end`, { matchToken, winner: 0, finalHp: [50, 0] })).body.ledger, null);
  });
});

test('every match gets its own game hash, and logins must be real Auth0 logins', async () => {
  await withServer(async (post) => {
    const first = (await post('/api/match', { players: [{ side: 0, name: 'Ana' }, { side: 1, bot: 'easy' }] })).body;
    const second = (await post('/api/match', { players: [{ side: 0, name: 'Ana' }, { side: 1, bot: 'easy' }] })).body;
    assert.match(first.game, /^[0-9a-f]{16}$/);
    assert.notEqual(first.game, second.game, 'two games never share a hash');
    assert.match(first.players[0].player, /^[0-9a-f]{16}$/, 'a guest still gets a player hash');
    assert.equal(first.players[1].player, 'bot-easy');
    const start = await post(`/api/match/${first.matchId}/ledger`, { matchToken: first.matchToken, event: { type: 'start' } });
    assert.deepEqual(start.body, { ledger: null });
    assert.equal((await post('/api/login', { idToken: 'not-a-token' })).status, 401);
  });
});

test('receipts must come back exactly as a spell returned them', async () => {
  await withServer(async (post) => {
    assert.equal((await post('/api/verify', { receipt: 12345 })).status, 400);
    assert.equal((await post('/api/verify', { receipt: 'not json' })).status, 400);
    assert.equal((await post('/api/verify', { receipt: `{${'x'.repeat(30000)}}` })).status, 400);
  });
});

test('creativity scores come only from ratings the server signed, each counted once', () => {
  const eight = signRating({ matchId: 'm-1', side: 0, rating: 8 });
  const six = signRating({ matchId: 'm-1', side: 0, rating: 6 });
  const bot = signRating({ matchId: 'm-1', side: 1, rating: 3 });
  assert.equal(readRating(eight, 'm-1').r, 8);
  assert.equal(readRating(eight, 'm-2'), null, 'a rating from another game');
  const [body, mac] = eight.split('.');
  const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: 10 })).toString('base64url')}.${mac}`;
  assert.equal(readRating(forged, 'm-1'), null, 'a rating edited to 10');
  assert.deepEqual(creativityScores([eight, eight, eight, six, bot, forged, 'junk'], 'm-1'), [
    { score: 70, judged: 2 },
    { score: 30, judged: 1 },
  ]);
  assert.deepEqual(creativityScores(null, 'm-1'), [
    { score: null, judged: 0 },
    { score: null, judged: 0 },
  ]);
});

test('the end of a duel hands back a hashed scorecard: creativity and stats for both players', async () => {
  await withServer(async (post) => {
    const { matchId, matchToken } = (await post('/api/match', { players: [{ side: 0, name: 'Ana' }, { side: 1, bot: 'hard' }] })).body;
    const ratings = [signRating({ matchId, side: 0, rating: 9 }), signRating({ matchId, side: 1, rating: 5 })];
    const stats = [
      { thrown: 12, hits: 7, blocks: 2, damage: 88 },
      { thrown: 9, hits: 4, blocks: 1, damage: 400000 },
    ];
    const { body } = await post(`/api/match/${matchId}/end`, { matchToken, winner: 0, finalHp: [52, 0], ratings, stats });
    const [ana, bot] = body.score.card;
    assert.equal(ana.cr, 90);
    assert.equal(bot.cr, 50);
    assert.deepEqual([ana.t, ana.h, ana.b, ana.dmg, ana.hp], [12, 7, 2, 88, 52]);
    assert.equal(bot.dmg, 9999, 'stats are clamped');
    assert.equal(bot.as, 'bot-hard');
    assert.match(body.score.hash, /^[0-9a-f]{16}$/);
    assert.equal(body.score.ledger, null, 'no Solana key in tests, so nothing is written');
  });
});
