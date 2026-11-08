import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT, jwtVerify } from 'jose';
import { checkRitual, gateStatus, readGateSession, ritualLooksReal } from '../server/auth.js';
import { Ritual } from '../src/ritual.js';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.GATE_SECRET = SECRET;
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

const ritual = (gaps = [1200, 3000]) => [
  { id: 'thumbs', at: 1000 },
  { id: 'heart', at: 1000 + gaps[0] },
  { id: 'dance', at: 1000 + gaps[0] + gaps[1] },
];

test('a forged session token is refused', async () => {
  const forged = await sessionFor('auth0|ana', new TextEncoder().encode('a-different-secret-of-32-or-more-chars!!'));
  await assert.rejects(readGateSession(forged));
  assert.equal((await readGateSession(await sessionFor('auth0|ana'))).sub, 'auth0|ana');
  assert.deepEqual((await gateStatus(await sessionFor('auth0|ana'))).steps, ['thumbs', 'heart', 'dance']);
});

test('a completed ritual signs a short-lived result for Auth0', async () => {
  const done = await checkRitual({ sessionToken: await sessionFor('auth0|ana'), state: 's1', steps: ritual() });
  assert.equal(done.status, 'accepted');
  const { payload } = await jwtVerify(done.token, key);
  assert.equal(payload.sub, 'auth0|ana');
  assert.equal(payload.state, 's1');
  assert.equal(payload.ritual_ok, true);
  assert.ok(payload.exp - payload.iat <= 120, 'the result expires quickly');
});

test('steps out of order, missing, or impossibly fast are refused', () => {
  assert.equal(ritualLooksReal(ritual()), true);
  assert.equal(ritualLooksReal(ritual().reverse()), false, 'out of order');
  assert.equal(ritualLooksReal(ritual().slice(0, 2)), false, 'missing the dance');
  assert.equal(ritualLooksReal(ritual([100, 100])), false, 'faster than a real dance');
  assert.equal(ritualLooksReal('thumbs,heart,dance'), false);
});

test('a missing state is refused', async () => {
  await assert.rejects(checkRitual({ sessionToken: await sessionFor('auth0|cy'), steps: ritual() }));
});

test('at the gate, the ritual does not need the whole body in frame, and logs each step', () => {
  const gate = new Ritual({ sides: [0], requireFullBody: false });
  const seated = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.6, v: 1 }));
  seated[0] = { x: 0.5, y: 0.3, v: 1 };
  seated[27] = { x: 0.5, y: 1.4, v: 0.1 };
  const up = { gesture: 'Thumb_Up', score: 0.9, points: [] };
  for (let t = 0; t <= 800; t += 50) gate.update({ poses: { 0: seated }, hands: { 0: [up, up] } }, t);
  assert.equal(gate.inFrame[0], true, 'feet out of frame are fine at a laptop');
  assert.equal(gate.step, 1);
  assert.equal(gate.log[0].id, 'thumbs');
});
