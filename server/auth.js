// Auth0 for HexByte: checks a wizard's ID token, and runs the Ritual Gate, the extra
// login step where a wizard proves they're a live person on camera with the 3-step
// ritual: two thumbs up, a heart made with both hands, and a dance.
//
// The Ritual Gate is wired into Auth0 with a post-login Action (auth0/post-login-action.js):
// 1. The Action pauses login and sends the wizard to /gate.html with a signed session token.
// 2. The page watches the camera (hands and body) and walks the wizard through the steps.
// 3. This server checks the steps came in order, over a believable amount of time, then
//    signs a short-lived result token, which the page posts back to Auth0's /continue.
// 4. The Action checks the result and records the Ritual Gate as a login method.
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';

export const CLAIMS = 'https://hexbyte.game/';
export const RITUAL_STEPS = ['thumbs', 'heart', 'dance'];
// The dance alone takes 2.5 seconds; nobody does all three faster than this.
const MIN_RITUAL_MS = 2500;
// And a ritual that took longer than this is from a stale page.
const MAX_RITUAL_MS = 10 * 60 * 1000;

export function auth0Config() {
  const domain = process.env.AUTH0_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const clientId = process.env.AUTH0_CLIENT_ID;
  return domain && clientId ? { domain, clientId } : null;
}

export const hasRitualGate = () => Boolean(auth0Config() && (process.env.GATE_SECRET ?? '').length >= 32);

let jwks = null;
export function auth0Keys() {
  const config = auth0Config();
  if (!config) throw new Error('Auth0 is not set up.');
  jwks ??= createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`));
  return jwks;
}

// Returns the wizard behind a verified Auth0 ID token.
export async function readWizard(idToken) {
  const config = auth0Config();
  if (!config) throw new Error('Auth0 is not set up.');
  // Tokens come from the browser sign-in (the SPA) or from face login (HexByte's server app).
  const { payload } = await jwtVerify(String(idToken), auth0Keys(), {
    issuer: `https://${config.domain}/`,
    audience: [config.clientId, process.env.AUTH0_FACE_CLIENT_ID].filter(Boolean),
  });
  const faceClient = process.env.AUTH0_FACE_CLIENT_ID;
  return {
    sub: payload.sub,
    name: payload.name ?? payload.nickname ?? payload.email ?? 'Wizard',
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    ritualVerified: payload[`${CLAIMS}ritual_verified`] === true,
    // When Auth0 signed this login, and through which door.
    loginAt: payload.iat,
    via: faceClient && [].concat(payload.aud).includes(faceClient) ? 'face' : 'auth0',
  };
}

function gateKey() {
  const secret = process.env.GATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Set GATE_SECRET (32 or more characters) in .env and in the Auth0 Action secrets.');
  }
  return new TextEncoder().encode(secret);
}

// The session token the Action created with api.redirect.encodeToken().
export async function readGateSession(sessionToken) {
  const { payload } = await jwtVerify(String(sessionToken), gateKey(), { algorithms: ['HS256'] });
  const domain = auth0Config()?.domain;
  if (domain && payload.iss && payload.iss !== domain && payload.iss !== `https://${domain}/`) {
    throw new Error('This login came from a different Auth0 tenant.');
  }
  if (!payload.sub) throw new Error('The login token has no user.');
  return { sub: payload.sub, name: typeof payload.name === 'string' ? payload.name : 'Wizard' };
}

// The result the Action reads back with api.redirect.validateToken().
// Auth0 requires the state claim to match, which stops replays.
export async function continueToken({ sub, state, ok }) {
  return new SignJWT({ state, ritual_ok: ok })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(gateKey());
}

export async function gateStatus(sessionToken) {
  const session = await readGateSession(sessionToken);
  return { name: session.name, steps: RITUAL_STEPS };
}

// steps: [{ id, at }] from the page, in the order they were finished.
export function ritualLooksReal(steps) {
  if (!Array.isArray(steps) || steps.length !== RITUAL_STEPS.length) return false;
  if (!steps.every((step, i) => step?.id === RITUAL_STEPS[i] && Number.isFinite(step.at))) return false;
  if (!steps.every((step, i) => i === 0 || step.at > steps[i - 1].at)) return false;
  const took = steps.at(-1).at - steps[0].at;
  return took >= MIN_RITUAL_MS - 600 && took <= MAX_RITUAL_MS;
}

export async function checkRitual({ sessionToken, state, steps }) {
  const session = await readGateSession(sessionToken);
  if (typeof state !== 'string' || !state) throw new Error('The login state is missing. Start the login again.');
  if (!ritualLooksReal(steps)) return { status: 'invalid' };
  return { status: 'accepted', token: await continueToken({ sub: session.sub, state, ok: true }) };
}
