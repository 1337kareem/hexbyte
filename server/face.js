// Face login: a wizard signs in by showing their face and saying their name.
//
// Auth0 is the system of record. Every wizard is an Auth0 user (in the
// Username-Password-Authentication database) with their face stored in app_metadata as
// a 128-number descriptor (numbers describing the face, not a photo). HexByte's server,
// through its own Auth0 application ("HexByte Face Login"):
// 1. reads the wizards with the Management API and compares the face and name it was sent,
// 2. creates a new Auth0 user for a face it has never seen,
// 3. signs the wizard in with Auth0's password-realm grant. Each wizard's password is
//    derived from a server secret, never stored and never shown, so the face + name
//    check here is the only way in. Auth0 issues the ID token the game then uses.
import { createHmac, randomUUID } from 'node:crypto';
import { cleanName, nameFromSpeech, namesMatch } from '../shared/names.js';
import { auth0Config } from './auth.js';

export { cleanName, namesMatch };

// face-api descriptors: the same person is usually under 0.45 apart, different people over 0.6.
export const FACE_MATCH = 0.5;
// In between, with the same name, it's probably them on a bad camera day: ask for a rescan
// rather than make them a second account.
export const FACE_UNSURE = 0.6;
const CONNECTION = 'Username-Password-Authentication';
const DESCRIPTOR_LENGTH = 128;
// Auth0's user list can take a few seconds to show a brand-new user; remember them meanwhile.
const RECENT_MS = 2 * 60 * 1000;

export function faceConfig() {
  const auth0 = auth0Config();
  const clientId = process.env.AUTH0_FACE_CLIENT_ID;
  const clientSecret = process.env.AUTH0_FACE_CLIENT_SECRET;
  const secret = process.env.GATE_SECRET ?? '';
  if (!auth0 || !clientId || !clientSecret || secret.length < 32) return null;
  return { domain: auth0.domain, clientId, clientSecret, secret };
}

export class FaceError extends Error {}

export function validDescriptor(descriptor) {
  return (
    Array.isArray(descriptor) &&
    descriptor.length === DESCRIPTOR_LENGTH &&
    descriptor.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 2)
  );
}

export function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// What a face and a name mean, given the wizards already in the system.
export function decide(wizards, { name, descriptor }) {
  const scored = wizards
    .filter((wizard) => validDescriptor(wizard.face))
    .map((wizard) => ({ ...wizard, distance: distance(wizard.face, descriptor) }))
    .sort((a, b) => a.distance - b.distance);
  // Names match by sound, so Jaden finds Jadyn.
  const named = scored.filter((wizard) => namesMatch(wizard.name, name));
  if (named[0] && named[0].distance < FACE_MATCH) return { status: 'recognized', wizard: named[0] };
  // A face already in the registry under another name: no second account for it.
  if (scored[0] && scored[0].distance < FACE_MATCH) return { status: 'known_face', wizard: scored[0] };
  // Almost their face: a rescan, not a second account.
  if (named[0] && named[0].distance < FACE_UNSURE) return { status: 'wrong_face', wizard: named[0] };
  // A different person who shares a name gets their own account.
  return { status: 'new' };
}

// Never stored: the same email always gives the same password, and only this server can make it.
export function passwordFor(email, secret) {
  return `Hx!${createHmac('sha256', secret).update(`face-login\n${email}`).digest('base64url').slice(0, 28)}9a`;
}

export async function auth0Fetch(config, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`https://${config.domain}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data.error_description ?? data.message ?? data.error ?? `HTTP ${response.status}`;
    throw new FaceError(`Auth0: ${reason}`);
  }
  return data;
}

let management = null;
export async function managementToken(config) {
  if (management && management.until > Date.now()) return management.token;
  const data = await auth0Fetch(config, '/oauth/token', {
    method: 'POST',
    body: {
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: `https://${config.domain}/api/v2/`,
    },
  });
  management = { token: data.access_token, until: Date.now() + (data.expires_in - 60) * 1000 };
  return management.token;
}

// New sign-ups and renames, by email: Auth0's user list takes a few seconds to show them.
const recent = new Map();

async function listWizards(config) {
  const token = await managementToken(config);
  const wizards = [];
  for (let page = 0; page < 10; page += 1) {
    const users = await auth0Fetch(
      config,
      `/api/v2/users?per_page=100&page=${page}&fields=user_id,name,email,app_metadata&include_fields=true`,
      { token },
    );
    for (const user of users) {
      const face = user.app_metadata?.hexbyte_face;
      if (face) wizards.push({ id: user.user_id, name: user.app_metadata?.hexbyte_name ?? user.name, email: user.email, face });
    }
    if (users.length < 100) break;
  }
  const now = Date.now();
  for (const [email, wizard] of recent) {
    if (now - wizard.at > RECENT_MS) {
      recent.delete(email);
      continue;
    }
    const listed = wizards.find((known) => known.email === email);
    if (listed) listed.name = wizard.name;
    else wizards.push(wizard);
  }
  return wizards;
}

async function renameWizard(config, wizard, name) {
  const token = await managementToken(config);
  await auth0Fetch(config, `/api/v2/users/${encodeURIComponent(wizard.id)}`, {
    method: 'PATCH',
    token,
    body: { name, app_metadata: { hexbyte_name: name } },
  });
  recent.set(wizard.email, { ...wizard, name, at: Date.now() });
}

async function createWizard(config, { name, descriptor }) {
  const token = await managementToken(config);
  const slug = name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || 'wizard';
  const email = `${slug}-${randomUUID().slice(0, 8)}@faces.hexbyte.game`;
  const face = descriptor.map((value) => Math.round(value * 1e4) / 1e4);
  const user = await auth0Fetch(config, '/api/v2/users', {
    method: 'POST',
    token,
    body: {
      connection: CONNECTION,
      email,
      email_verified: true,
      verify_email: false,
      password: passwordFor(email, config.secret),
      name,
      app_metadata: { hexbyte_face: face, hexbyte_name: name },
    },
  });
  const wizard = { id: user.user_id, name, email, face, at: Date.now() };
  recent.set(email, wizard);
  return wizard;
}

async function signIn(config, email) {
  const data = await auth0Fetch(config, '/oauth/token', {
    method: 'POST',
    body: {
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      realm: CONNECTION,
      username: email,
      password: passwordFor(email, config.secret),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'openid profile email',
    },
  });
  return data.id_token;
}

export async function faceLogin({ name, descriptor }) {
  const config = faceConfig();
  if (!config) throw new FaceError('Face login is not set up on this server.');
  // "My name is Ana Lopez" signs in as Ana Lopez.
  const cleanedName = nameFromSpeech(name);
  if (!cleanedName) return { status: 'no_name' };
  if (!validDescriptor(descriptor)) return { status: 'no_face' };

  const decision = decide(await listWizards(config), { name: cleanedName, descriptor });
  if (decision.status === 'recognized') {
    return { status: 'recognized', name: decision.wizard.name, idToken: await signIn(config, decision.wizard.email) };
  }
  if (decision.status === 'new') {
    const wizard = await createWizard(config, { name: cleanedName, descriptor });
    return { status: 'enrolled', name: wizard.name, idToken: await signIn(config, wizard.email) };
  }
  return { status: decision.status, name: decision.wizard.name };
}

// Changing your name: the face has to be one the registry knows. It's the same proof
// that signs you in, so only the face's owner can rename it.
export async function faceRename({ name, descriptor }) {
  const config = faceConfig();
  if (!config) throw new FaceError('Face login is not set up on this server.');
  const cleanedName = nameFromSpeech(name);
  if (!cleanedName) return { status: 'no_name' };
  if (!validDescriptor(descriptor)) return { status: 'no_face' };

  const owner = ownerOf(await listWizards(config), descriptor);
  if (!owner) return { status: 'no_match' };
  const previous = owner.name;
  if (cleanName(previous) !== cleanedName) await renameWizard(config, owner, cleanedName);
  return { status: 'renamed', name: cleanedName, previous, idToken: await signIn(config, owner.email) };
}

// The wizard this face belongs to, if it's clearly one of them.
export function ownerOf(wizards, descriptor) {
  const [nearest] = wizards
    .filter((wizard) => validDescriptor(wizard.face))
    .map((wizard) => ({ ...wizard, distance: distance(wizard.face, descriptor) }))
    .sort((a, b) => a.distance - b.distance);
  return nearest && nearest.distance < FACE_MATCH ? nearest : null;
}
