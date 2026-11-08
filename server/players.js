// Player records, kept long term on each wizard's Auth0 account
// (app_metadata.hexbyte_player). Face login and the Auth0 page both connect a person to
// their account, so the next login, from any device, picks up where they left off:
// their power level, duels, wins, losses, draws and logins.
//
// Auth0 is the home for this because it lasts: the duel stats store (server/store.js)
// is a temporary folder on Vercel unless a Tiger Data database is connected.
// HexByte's server reads and writes the records with the face login app's Management API access.
import { POWER_MIN_DUEL_MS, POWER_START, powerGain } from '../shared/rules.js';
import { auth0Fetch, faceConfig, managementToken } from './face.js';

// The last few duels each account was paid for, so one duel can't be counted twice.
const REMEMBER_DUELS = 20;

export const hasPlayerRecords = () => Boolean(faceConfig());

const count = (value, fallback = 0) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
const when = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

function recordFrom(appMetadata) {
  const saved = appMetadata?.hexbyte_player ?? {};
  return {
    name: typeof saved.name === 'string' ? saved.name.slice(0, 40) : null,
    level: count(saved.level, POWER_START),
    duels: count(saved.duels),
    wins: count(saved.wins),
    losses: count(saved.losses),
    draws: count(saved.draws),
    logins: count(saved.logins),
    bestCreativity: Number.isFinite(saved.bestCreativity) ? saved.bestCreativity : null,
    firstSeen: when(saved.firstSeen),
    lastLogin: when(saved.lastLogin),
    lastPlayed: when(saved.lastPlayed),
    paid: Array.isArray(saved.paid) ? saved.paid.filter((id) => typeof id === 'string').slice(-REMEMBER_DUELS) : [],
  };
}

// What the browser gets: everything but the bookkeeping.
export function publicRecord(record) {
  if (!record) return null;
  const { paid, ...shown } = record;
  return shown;
}

const userPath = (sub) => `/api/v2/users/${encodeURIComponent(sub)}`;

async function readRecord(config, sub) {
  const token = await managementToken(config);
  const user = await auth0Fetch(config, `${userPath(sub)}?fields=app_metadata&include_fields=true`, { token });
  return recordFrom(user.app_metadata);
}

async function saveRecord(config, sub, record) {
  const token = await managementToken(config);
  await auth0Fetch(config, userPath(sub), { method: 'PATCH', token, body: { app_metadata: { hexbyte_player: record } } });
  return record;
}

// A wizard's saved record, or null when records are off (no Management API access).
export async function readPlayer(sub) {
  const config = faceConfig();
  if (!config || !sub) return null;
  return readRecord(config, sub);
}

// Every sign-in: count it, and remember the name it signed in with.
export async function playerLoggedIn(sub, { name, now = new Date() } = {}) {
  const config = faceConfig();
  if (!config || !sub) return null;
  const record = await readRecord(config, sub);
  const at = now.toISOString();
  return saveRecord(config, sub, {
    ...record,
    name: typeof name === 'string' && name ? name.slice(0, 40) : record.name,
    logins: record.logins + 1,
    firstSeen: record.firstSeen ?? at,
    lastLogin: at,
  });
}

// Pays out one finished duel. Returns { before, after, gained, record }, or null if it doesn't count.
export async function playerFinishedDuel(sub, { matchId, startedAt, won = false, draw = false, creativity = null, now = Date.now() }) {
  const config = faceConfig();
  if (!config || !sub || !matchId) return null;
  if (now - Date.parse(startedAt) < POWER_MIN_DUEL_MS) return null;
  const record = await readRecord(config, sub);
  if (record.paid.includes(matchId)) return { before: record.level, after: record.level, gained: 0, record };
  const gained = powerGain({ won, draw });
  const next = await saveRecord(config, sub, {
    ...record,
    level: record.level + gained,
    duels: record.duels + 1,
    wins: record.wins + (won ? 1 : 0),
    losses: record.losses + (!won && !draw ? 1 : 0),
    draws: record.draws + (draw ? 1 : 0),
    bestCreativity: Number.isFinite(creativity) ? Math.max(record.bestCreativity ?? 0, creativity) : record.bestCreativity,
    firstSeen: record.firstSeen ?? new Date(now).toISOString(),
    lastPlayed: new Date(now).toISOString(),
    paid: [...record.paid, matchId].slice(-REMEMBER_DUELS),
  });
  return { before: record.level, after: next.level, gained, record: next };
}
