import assert from 'node:assert/strict';
import test from 'node:test';
import { answerFromSpeech, cleanName, nameFromSpeech, namesMatch, soundKey } from '../shared/names.js';

process.env.AUTH0_DOMAIN = 'hexbyte-test.us.auth0.com';
process.env.AUTH0_CLIENT_ID = 'spa-client';
process.env.AUTH0_FACE_CLIENT_ID = 'face-client';
process.env.AUTH0_FACE_CLIENT_SECRET = 'face-secret';
process.env.GATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const { FACE_MATCH, FACE_UNSURE, decide, faceRename, distance, faceConfig, faceLogin, passwordFor, validDescriptor } = await import('../server/face.js');

// Three faces: Ana, Ana again a moment later, and somebody else.
const ana = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.1);
const anaAgain = ana.map((value, i) => value + Math.sin(i * 7) * 0.01);
const bo = Array.from({ length: 128 }, (_, i) => Math.cos(i * 3) * 0.1);
// Ana's face on a bad camera day: closer than a stranger, not close enough to be sure.
const anaBlurry = ana.map((value, i) => value + Math.sin(i * 5) * 0.07);

// A pretend Auth0 tenant: the Management API and the token endpoint.
function fakeAuth0() {
  const users = [];
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method ?? 'GET', pathname, body });
    if (pathname === '/oauth/token' && body.grant_type === 'client_credentials') {
      assert.equal(body.client_secret, 'face-secret');
      return reply(200, { access_token: 'management-token', expires_in: 86400 });
    }
    if (pathname === '/oauth/token' && body.grant_type.endsWith('password-realm')) {
      const user = users.find((known) => known.email === body.username);
      if (!user || user.password !== body.password) return reply(403, { error: 'invalid_grant', error_description: 'Wrong email or password.' });
      return reply(200, { id_token: `id-token-for-${user.user_id}` });
    }
    assert.equal(options.headers.Authorization, 'Bearer management-token');
    if (pathname.startsWith('/api/v2/users/') && options.method === 'PATCH') {
      const user = users.find((known) => known.user_id === decodeURIComponent(pathname.slice('/api/v2/users/'.length)));
      if (!user) return reply(404, { message: 'User not found' });
      Object.assign(user, { name: body.name ?? user.name, app_metadata: { ...user.app_metadata, ...body.app_metadata } });
      return reply(200, user);
    }
    if (pathname === '/api/v2/users' && options.method === 'POST') {
      const user = { ...body, user_id: `auth0|${users.length + 1}` };
      users.push(user);
      return reply(201, user);
    }
    if (pathname === '/api/v2/users') return reply(200, users.map(({ password, ...user }) => user));
    return reply(404, { message: 'Not found' });
  };
  return { users, calls, fetch };
}

test('names: what people say becomes a clean first and last name', () => {
  assert.equal(nameFromSpeech('Hi, my name is kareem smith.'), 'Kareem Smith');
  assert.equal(nameFromSpeech("um I'm Ana"), 'Ana');
  assert.equal(nameFromSpeech('Ana Maria Lopez'), 'Ana Maria', 'first and last at most');
  assert.equal(nameFromSpeech('42'), '');
  assert.equal(cleanName("jo-ann o'neil"), "Jo-Ann O'Neil");
  assert.equal(namesMatch('Ana Lopez', 'ana'), true, 'a first name is enough');
  assert.equal(namesMatch('Ana', 'Ana Lopez'), true);
  assert.equal(namesMatch('Ana Lopez', 'Ana Smith'), false);
  assert.equal(namesMatch('Ana', 'Bo'), false);
});

test('names that sound the same match, whatever the spelling', () => {
  for (const group of [
    ['Jaden', 'Jadyn', 'Jayden', 'Jaiden'],
    ['Kareem', 'Karim'],
    ['Sean', 'Shawn', 'Shaun'],
    ['Mohammed', 'Muhammad', 'Mohamed'],
    ['Catherine', 'Kathryn'],
    ['Phillip', 'Filip'],
  ]) {
    for (const name of group) assert.equal(soundKey(name), soundKey(group[0]), `${name} sounds like ${group[0]}`);
  }
  assert.equal(namesMatch('Jadyn Smith', 'jaden'), true);
  assert.equal(namesMatch('Kareem', 'Korean'), false, 'a misheard name is a different name');
  assert.equal(namesMatch('Jade', 'Jaden'), false);
});

test('a spoken yes or no', () => {
  assert.equal(answerFromSpeech('Yes'), 'yes');
  assert.equal(answerFromSpeech("yeah that's right"), 'yes');
  assert.equal(answerFromSpeech('no'), 'no');
  assert.equal(answerFromSpeech('nope, not right'), 'no');
  assert.equal(answerFromSpeech('banana'), null);
  assert.equal(answerFromSpeech(null), null);
});

test('faces: the same face is close, a different face is far', () => {
  assert.ok(distance(ana, anaAgain) < FACE_MATCH);
  assert.ok(distance(ana, bo) > FACE_UNSURE);
  const blurry = distance(ana, anaBlurry);
  assert.ok(blurry > FACE_MATCH && blurry < FACE_UNSURE, `the blurry face is unsure (${blurry.toFixed(2)})`);
  assert.equal(validDescriptor(ana), true);
  assert.equal(validDescriptor(ana.slice(1)), false);
  assert.equal(validDescriptor([...ana.slice(1), Number.NaN]), false);
  assert.equal(validDescriptor('ana'), false);
});

test('decide: a name and a face both have to fit', () => {
  const wizards = [{ name: 'Ana Lopez', email: 'a', face: ana }];
  assert.equal(decide(wizards, { name: 'Ana', descriptor: anaAgain }).status, 'recognized');
  assert.equal(decide(wizards, { name: 'Anna', descriptor: anaAgain }).status, 'recognized', 'spelled differently, sounds the same');
  assert.equal(decide(wizards, { name: 'Bo', descriptor: anaAgain }).status, 'known_face', 'her face under a new name');
  assert.equal(decide(wizards, { name: 'Ana', descriptor: anaBlurry }).status, 'wrong_face', 'almost her face: rescan');
  assert.equal(decide(wizards, { name: 'Ana', descriptor: bo }).status, 'new', 'another person called Ana');
  assert.equal(decide(wizards, { name: 'Bo', descriptor: bo }).status, 'new');
  // Two wizards called Ana: the face picks the right one.
  const twoAnas = [...wizards, { name: 'Ana Kim', email: 'b', face: bo }];
  assert.equal(decide(twoAnas, { name: 'Ana', descriptor: bo }).wizard.email, 'b');
});

test('passwords are made from the server secret, never stored', () => {
  const secret = process.env.GATE_SECRET;
  assert.equal(passwordFor('a@x', secret), passwordFor('a@x', secret));
  assert.notEqual(passwordFor('a@x', secret), passwordFor('b@x', secret));
  assert.notEqual(passwordFor('a@x', secret), passwordFor('a@x', `${secret}!`));
  assert.match(passwordFor('a@x', secret), /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!]).{16,}$/, 'meets the Auth0 password policy');
});

test('face login: a new face joins, comes back by name, and nobody else gets in as them', async () => {
  assert.ok(faceConfig());
  const auth0 = fakeAuth0();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth0.fetch;
  try {
    const joined = await faceLogin({ name: 'my name is Ana Lopez', descriptor: ana });
    assert.equal(joined.status, 'enrolled');
    assert.equal(joined.name, 'Ana Lopez');
    assert.equal(joined.idToken, 'id-token-for-auth0|1');
    const [user] = auth0.users;
    assert.equal(user.connection, 'Username-Password-Authentication');
    assert.equal(user.app_metadata.hexbyte_name, 'Ana Lopez');
    assert.equal(user.app_metadata.hexbyte_face.length, 128);
    assert.match(user.email, /^analopez-[0-9a-f]{8}@faces\.hexbyte\.game$/);

    const back = await faceLogin({ name: 'Ana', descriptor: anaAgain });
    assert.equal(back.status, 'recognized');
    assert.equal(back.idToken, 'id-token-for-auth0|1');

    const unsure = await faceLogin({ name: 'Ana', descriptor: anaBlurry });
    assert.equal(unsure.status, 'wrong_face');
    assert.equal(unsure.idToken, undefined, 'no token for a face it is not sure of');

    const alias = await faceLogin({ name: 'Bo', descriptor: anaAgain });
    assert.equal(alias.status, 'known_face');
    assert.equal(alias.idToken, undefined);
    assert.equal(auth0.users.length, 1, 'no second account for a known face');

    // Another person who is also called Ana gets their own account, not Ana Lopez's.
    const otherAna = await faceLogin({ name: 'Ana', descriptor: bo });
    assert.equal(otherAna.status, 'enrolled');
    assert.equal(otherAna.idToken, 'id-token-for-auth0|2');
    assert.equal(auth0.users.length, 2);

    assert.equal((await faceLogin({ name: '123', descriptor: ana })).status, 'no_name');
    assert.equal((await faceLogin({ name: 'Bo', descriptor: [1, 2] })).status, 'no_face');

    const tokenCalls = auth0.calls.filter((call) => call.body?.grant_type === 'client_credentials');
    assert.equal(tokenCalls.length, 1, 'the management token is reused');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('changing your name: only the face that owns the account can rename it', async () => {
  const auth0 = fakeAuth0();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth0.fetch;
  try {
    // A misheard sign-up: "Kareem" became "Korean".
    const kareem = Array.from({ length: 128 }, (_, i) => Math.cos(i * 1.7) * 0.1);
    const korean = await faceLogin({ name: 'Korean', descriptor: kareem });
    assert.equal(korean.status, 'enrolled');
    const id = auth0.users.find((user) => user.name === 'Korean').user_id;
    assert.equal((await faceLogin({ name: 'Kareem', descriptor: kareem })).status, 'known_face');

    const stranger = Array.from({ length: 128 }, (_, i) => Math.sin(i * 2.9) * 0.1);
    const refused = await faceRename({ name: 'Kareem', descriptor: stranger });
    assert.equal(refused.status, 'no_match', 'a different face cannot rename it');
    assert.equal(refused.idToken, undefined);

    const renamed = await faceRename({ name: 'my name is kareem', descriptor: kareem });
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.name, 'Kareem');
    assert.equal(renamed.previous, 'Korean');
    assert.equal(renamed.idToken, `id-token-for-${id}`, 'signed in to the same account');
    const user = auth0.users.find((known) => known.user_id === id);
    assert.equal(user.name, 'Kareem');
    assert.equal(user.app_metadata.hexbyte_name, 'Kareem');
    assert.equal(user.app_metadata.hexbyte_face.length, 128, 'the face stays');

    const back = await faceLogin({ name: 'Karim', descriptor: kareem });
    assert.equal(back.status, 'recognized', 'and the new name signs in, whatever the spelling');
    assert.equal(back.name, 'Kareem');
  } finally {
    globalThis.fetch = realFetch;
  }
});
