// Auth0 for HexByte: checks a wizard's ID token, and runs the Rune Gate, the
// extra login step where a wizard draws their personal rune in the air.
//
// The Rune Gate is wired into Auth0 with a post-login Action (auth0/post-login-action.js):
// 1. The Action pauses login and sends the wizard to /rune.html with a signed session token.
// 2. This server checks that token, then compares the drawn rune to the saved one.
// 3. It signs a short-lived result token, and the page posts it back to Auth0's /continue.
// 4. The Action checks the result and records the rune as a login method on the session.
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { prepareStroke, scoreRunes } from '../shared/dollar.js';

export const CLAIMS = 'https://hexbyte.game/';
const SAMPLES_NEEDED = 3;
// In tests, the same rune redrawn scores above 0.9 and look-alikes stay under 0.75.
const MATCH_SCORE = 0.85;
const ENROLL_SCORE = 0.8;
const MAX_TRIES = 3;

export function auth0Config() {
  const domain = process.env.AUTH0_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const clientId = process.env.AUTH0_CLIENT_ID;
  return domain && clientId ? { domain, clientId } : null;
}

let jwks = null;

// Returns the wizard behind a verified Auth0 ID token.
export async function readWizard(idToken) {
  const config = auth0Config();
  if (!config) throw new Error('Auth0 is not set up.');
  jwks ??= createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(String(idToken), jwks, {
    issuer: `https://${config.domain}/`,
    audience: config.clientId,
  });
  return {
    sub: payload.sub,
    name: payload.name ?? payload.nickname ?? payload.email ?? 'Wizard',
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    runeVerified: payload[`${CLAIMS}rune_verified`] === true,
  };
}

function runeSecret() {
  const secret = process.env.RUNE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Set RUNE_SECRET (32 or more characters) in .env and in the Auth0 Action secrets.');
  }
  return new TextEncoder().encode(secret);
}

// The session token the Action created with api.redirect.encodeToken().
export async function readRuneSession(sessionToken) {
  const { payload } = await jwtVerify(String(sessionToken), runeSecret(), { algorithms: ['HS256'] });
  const domain = auth0Config()?.domain;
  if (domain && payload.iss && payload.iss !== domain && payload.iss !== `https://${domain}/`) {
    throw new Error('This login came from a different Auth0 tenant.');
  }
  if (!payload.sub) throw new Error('The login token has no user.');
  return { sub: payload.sub, name: typeof payload.name === 'string' ? payload.name : 'Wizard' };
}

// The result the Action reads back with api.redirect.validateToken().
// Auth0 requires the state claim to match, which stops replays.
export async function continueToken({ sub, state, runeOk }) {
  return new SignJWT({ state, rune_ok: runeOk })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(runeSecret());
}

export async function runeStatus(store, sessionToken) {
  const session = await readRuneSession(sessionToken);
  const samples = await store.getRune(session.sub);
  return {
    name: session.name,
    enrolled: samples.length >= SAMPLES_NEEDED,
    samples: Math.min(samples.length, SAMPLES_NEEDED),
    needed: SAMPLES_NEEDED,
  };
}

const failures = new Map();

export async function checkRune(store, { sessionToken, state, stroke }) {
  const session = await readRuneSession(sessionToken);
  if (typeof state !== 'string' || !state) throw new Error('The login state is missing. Start the login again.');
  const points = prepareStroke(stroke);
  if (!points) return { status: 'too_small' };

  const samples = await store.getRune(session.sub);

  // First login: save three drawings of the new rune.
  if (samples.length < SAMPLES_NEEDED) {
    if (samples.length > 0) {
      const score = scoreRunes(points, samples[0]);
      if (score < ENROLL_SCORE) return { status: 'enroll_mismatch', score, samples: samples.length, needed: SAMPLES_NEEDED };
    }
    const saved = [...samples, points];
    await store.saveRune(session.sub, saved);
    if (saved.length < SAMPLES_NEEDED) return { status: 'enrolling', samples: saved.length, needed: SAMPLES_NEEDED };
    return { status: 'accepted', enrolledNow: true, token: await continueToken({ sub: session.sub, state, runeOk: true }) };
  }

  // Later logins: the drawing must match one of the saved samples closely.
  const score = Math.max(...samples.map((template) => scoreRunes(points, template)));
  if (score >= MATCH_SCORE) {
    failures.delete(state);
    return { status: 'accepted', score, token: await continueToken({ sub: session.sub, state, runeOk: true }) };
  }
  const failed = (failures.get(state) ?? 0) + 1;
  failures.set(state, failed);
  if (failed >= MAX_TRIES) {
    failures.delete(state);
    return { status: 'locked', score, token: await continueToken({ sub: session.sub, state, runeOk: false }) };
  }
  return { status: 'rejected', score, triesLeft: MAX_TRIES - failed };
}
