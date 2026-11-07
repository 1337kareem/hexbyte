import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT, jwtVerify } from 'jose';
import { checkRune, readRuneSession, runeStatus } from '../server/auth.js';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.RUNE_SECRET = SECRET;
delete process.env.AUTH0_DOMAIN;
const key = new TextEncoder().encode(SECRET);

// The same kind of token Auth0's api.redirect.encodeToken() makes.
const sessionFor = (sub, secret = key) =>
  new SignJWT({ name: 'Ana' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('hexbyte-test.us.auth0.com')
    .setExpirationTime('5m')
    .sign(secret);

const memoryStore = () => {
  const runes = new Map();
  return {
    getRune: async (sub) => runes.get(sub) ?? [],
    saveRune: async (sub, samples) => runes.set(sub, samples),
  };
};

const circle = (r = 0.15) => Array.from({ length: 50 }, (_, i) => [0.5 + Math.cos((i / 49) * 6.28) * r, 0.5 + Math.sin((i / 49) * 6.28) * r]);
const zigzag = () => Array.from({ length: 50 }, (_, i) => [0.2 + i * 0.012, i % 10 < 5 ? 0.3 + (i % 5) * 0.06 : 0.6 - (i % 5) * 0.06]);

test('a forged session token is refused', async () => {
  const forged = await sessionFor('auth0|ana', new TextEncoder().encode('a-different-secret-of-32-or-more-chars!!'));
  await assert.rejects(readRuneSession(forged));
  assert.equal((await readRuneSession(await sessionFor('auth0|ana'))).sub, 'auth0|ana');
});

test('enrolling takes three similar drawings, then signs a result for Auth0', async () => {
  const store = memoryStore();
  const session = await sessionFor('auth0|ana');
  assert.equal((await runeStatus(store, session)).enrolled, false);

  assert.equal((await checkRune(store, { sessionToken: session, state: 's1', stroke: circle() })).status, 'enrolling');
  assert.equal((await checkRune(store, { sessionToken: session, state: 's1', stroke: zigzag() })).status, 'enroll_mismatch');
  assert.equal((await checkRune(store, { sessionToken: session, state: 's1', stroke: circle(0.12) })).status, 'enrolling');
  const done = await checkRune(store, { sessionToken: session, state: 's1', stroke: circle(0.18) });
  assert.equal(done.status, 'accepted');

  const { payload } = await jwtVerify(done.token, key);
  assert.equal(payload.sub, 'auth0|ana');
  assert.equal(payload.state, 's1');
  assert.equal(payload.rune_ok, true);
  assert.ok(payload.exp - payload.iat <= 120, 'the result expires quickly');
});

test('three wrong runes lock the login, and the right rune still works', async () => {
  const store = memoryStore();
  const session = await sessionFor('auth0|ben');
  for (const r of [0.15, 0.13, 0.17]) await checkRune(store, { sessionToken: session, state: 'enroll', stroke: circle(r) });

  const first = await checkRune(store, { sessionToken: session, state: 's2', stroke: zigzag() });
  assert.equal(first.status, 'rejected');
  assert.equal(first.triesLeft, 2);
  await checkRune(store, { sessionToken: session, state: 's2', stroke: zigzag() });
  const locked = await checkRune(store, { sessionToken: session, state: 's2', stroke: zigzag() });
  assert.equal(locked.status, 'locked');
  assert.equal((await jwtVerify(locked.token, key)).payload.rune_ok, false);

  const right = await checkRune(store, { sessionToken: session, state: 's3', stroke: circle(0.16) });
  assert.equal(right.status, 'accepted');
});

test('a missing state is refused', async () => {
  const store = memoryStore();
  await assert.rejects(checkRune(store, { sessionToken: await sessionFor('auth0|cy'), stroke: circle() }));
});
