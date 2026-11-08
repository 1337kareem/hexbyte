import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileStore } from '../server/store.js';

const frame = (t, side) => ({ t, side, points: Array.from({ length: 66 }, (_, i) => (i % 10) / 10) });

test('the local store saves duels, replays them and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexbyte-'));
  try {
    const store = await createFileStore(dir);
    await store.addMatch({ id: 'm-1', startedAt: new Date().toISOString(), players: [] });
    const time = new Date().toISOString();
    await store.addSpell({ time, matchId: 'm-1', side: 0, player: 'Ana', element: 'fire', outcome: 'cast', power: 8, damage: 22, name: 'Blaze', latencyMs: 6000 });
    await store.addSpell({ time, matchId: 'm-1', side: 1, player: 'Ben', element: 'lightning', outcome: 'cheat', latencyMs: 900 });

    const saved = await store.addFrames('m-1', [frame(200, 1), frame(100, 0), { t: 1, side: 3, points: [] }, { bad: true }]);
    assert.equal(saved, 2, 'bad frames are dropped');

    const replay = await store.replay('m-1');
    assert.deepEqual(replay.frames.map((f) => f.t), [100, 200]);
    assert.equal(replay.spells.length, 2);

    const stats = await store.stats();
    assert.equal(stats.matches, 1);
    assert.equal(stats.spells, 1);
    assert.equal(stats.cheatsBlocked, 1);
    assert.equal(stats.topSpell.name, 'Blaze');
    assert.equal(stats.byElement.find((e) => e.element === 'fire').avgPower, 8);

    await store.saveGate('auth0|ana', { hash: 'abc' });
    const reopened = await createFileStore(dir);
    assert.deepEqual(await reopened.getGate('auth0|ana'), { hash: 'abc' });
    assert.equal(await reopened.getGate('auth0|nobody'), null);
    assert.equal((await reopened.stats()).spells, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
