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
const dir = await mkdtemp(join(tmpdir(), 'hexbyte-app-'));
process.env.HEXBYTE_DATA_DIR = dir;

const { createApp, readMatch, signMatch } = await import('../server/app.js');

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
    assert.deepEqual(players.map((p) => [p.name, p.mana]), [['Ana', 5], ['Ben', 5]]);

    // Without a Prune key the spell is refused politely, but the token is accepted.
    const spell = await post('/api/spell', { matchToken, side: 0, gesture: 'Closed_Fist', words: 'Flame!' });
    assert.equal(spell.status, 200);
    assert.equal(spell.body.outcome, 'error');

    assert.equal((await post('/api/spell', { matchToken: 'forged', side: 0, gesture: 'Closed_Fist' })).status, 403);
    assert.equal((await post('/api/spell', { matchToken, side: 0, gesture: 'Thumb_Up' })).status, 400);

    const frame = { t: Date.now(), side: 0, points: Array.from({ length: 66 }, () => 0.5) };
    assert.equal((await post(`/api/match/${matchId}/frames`, { matchToken, frames: [frame] })).body.saved, 1);
    assert.equal((await post('/api/match/someone-elses-match/frames', { matchToken, frames: [frame] })).status, 403);
    assert.equal((await post(`/api/match/${matchId}/end`, { matchToken, winner: 0, finalHp: [40, 0] })).status, 200);
  });
});

test('receipts must come back exactly as a spell returned them', async () => {
  await withServer(async (post) => {
    assert.equal((await post('/api/verify', { receipt: 12345 })).status, 400);
    assert.equal((await post('/api/verify', { receipt: 'not json' })).status, 400);
    assert.equal((await post('/api/verify', { receipt: `{${'x'.repeat(30000)}}` })).status, 400);
  });
});
