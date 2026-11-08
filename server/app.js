// The HexByte API. server/index.js runs it locally; api/index.js runs it on Vercel.
//
// Nothing about a duel is kept in server memory, because Vercel runs several
// short-lived copies of this server and any of them may answer a request:
// - A match lives in a signed token that the browser sends back with every call.
// - A spell's Prune receipt is handed to the browser, which sends it back to be
//   verified. Prune's signature proves it wasn't changed along the way.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { auth0Config, checkRitual, gateStatus, hasRitualGate, readWizard } from './auth.js';
import { castSpell, hasPrune, pruneModel, setCustomerBudget, verifyReceipt } from './prune.js';
import {
  CLUSTER,
  accountUrl,
  gameEntries,
  gameHash,
  hasSolana,
  ledgerAddress,
  scoreHash,
  loginHash,
  loginMemo,
  memoFor,
  playerHash,
  writeMemo,
} from './solana.js';
import { faceConfig, faceLogin, faceRename } from './face.js';
import { hasPlayerRecords, playerFinishedDuel, playerLoggedIn, publicRecord, readPlayer } from './players.js';
import { createStore } from './store.js';
import {
  BOT_RANKS,
  GESTURE_ELEMENTS,
  MANA,
  botPower,
  clampPower,
  judgeBonus,
  spellEffect,
} from '../shared/rules.js';

const WIZARD_MONTHLY_BUDGET_USD = 0.05;
// Plain words for Prune blocks that aren't cheats or empty mana.
const BLOCK_REASONS = {
  agent_loop: 'Prune stopped the same spell repeated in a row (its loop guard). Say something new!',
};
const MAX_RECEIPT_CHARS = 20000;
const MATCH_HOURS = 6;

// The key that signs match tokens. It is derived from a secret every copy of the
// server shares (MATCH_SECRET, or else the Prune key), so no extra setup is needed.
// Without either, a random key works for a single server.
const fallbackSecret = randomBytes(32);
function matchKey() {
  const base = process.env.MATCH_SECRET || process.env.PRUNE_API_KEY;
  return base ? createHmac('sha256', base).update('hexbyte match tokens').digest() : fallbackSecret;
}

export async function signMatch(match) {
  return new SignJWT({ match })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MATCH_HOURS}h`)
    .sign(matchKey());
}

// The AI judge's rating of one incantation (1 to 10), signed so the browser can hand
// it back at the end of the duel for the creativity score, but can't make one up.
export function signRating({ matchId, side, rating }) {
  const body = Buffer.from(JSON.stringify({ m: matchId, s: side, r: rating, n: randomUUID().slice(0, 12) })).toString('base64url');
  return `${body}.${createHmac('sha256', matchKey()).update(`rating\n${body}`).digest('base64url').slice(0, 22)}`;
}

export function readRating(token, matchId) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac || body.length > 200) return null;
  if (createHmac('sha256', matchKey()).update(`rating\n${body}`).digest('base64url').slice(0, 22) !== mac) return null;
  try {
    const rating = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return rating.m === matchId && [0, 1].includes(rating.s) && Number.isInteger(rating.r) && rating.r >= 1 && rating.r <= 10 ? rating : null;
  } catch {
    return null;
  }
}

// Creativity: the average of the AI judge's ratings of a player's incantations, out of 100.
export function creativityScores(tokens, matchId) {
  const ratings = new Map();
  for (const token of Array.isArray(tokens) ? tokens.slice(0, 300) : []) {
    const rating = readRating(token, matchId);
    // Each rating counts once, however many times it's sent.
    if (rating) ratings.set(rating.n, rating);
  }
  return [0, 1].map((side) => {
    const mine = [...ratings.values()].filter((rating) => rating.s === side).map((rating) => rating.r);
    return { score: mine.length ? Math.round((mine.reduce((sum, r) => sum + r, 0) / mine.length) * 10) : null, judged: mine.length };
  });
}

export async function readMatch(token) {
  try {
    const { payload } = await jwtVerify(String(token ?? ''), matchKey(), { algorithms: ['HS256'] });
    return payload.match ?? null;
  } catch {
    return null;
  }
}

// A Solana write that takes too long becomes a missing link, not a stuck page.
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

// Every sign-in goes on the Duel Ledger: a hash of this login and of the player it
// signed in, never their name or Auth0 id.
async function recordLogin(wizard) {
  const login = { hash: loginHash(wizard.sub, wizard.loginAt), player: playerHash(wizard.sub), via: wizard.via };
  return { ...login, ledger: await within(writeMemo(loginMemo(login)), 5000) };
}

// The power level saved on a wizard's account, or null if it can't be read right now.
const powerOf = (sub) =>
  readPlayer(sub)
    .then((record) => record?.level ?? null)
    .catch((error) => {
      console.warn(`Reading a player record: ${error.message}`);
      return null;
    });

// A sign-in updates the player's long-term record and hands it back to the browser.
const loggedIn = (wizard) =>
  playerLoggedIn(wizard.sub, { name: wizard.name })
    .then(publicRecord)
    .catch((error) => {
      console.warn(`Saving a login to the player record: ${error.message}`);
      return null;
    });

// Protects API credits if the public link gets hammered.
function rateLimit(limit) {
  const log = new Map();
  return (request, response, next) => {
    const now = Date.now();
    const recent = (log.get(request.ip) ?? []).filter((time) => now - time < 60000);
    if (recent.length >= limit) {
      response.status(429).json({ error: 'Too many requests. Try again in a minute.' });
      return;
    }
    log.set(request.ip, [...recent, now]);
    next();
  };
}

const warn = (what) => (error) => console.warn(`${what}: ${error.message}`);
const cleanText = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
const slug = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '-');

export async function createApp() {
  const app = express();
  const store = await createStore(process.env.DATABASE_URL);
  const budgetsSet = new Set();
  app.set('trust proxy', true);
  const parseJson = express.json({ limit: '2mb' });
  app.use((request, response, next) => {
    // Vercel can parse the body before Express sees it. Use that instead of reading it twice.
    let body;
    try {
      body = request.body;
    } catch {
      response.status(400).json({ error: 'The request body is not valid JSON.' });
      return;
    }
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      next();
      return;
    }
    parseJson(request, response, next);
  });

  // Reads the match token from a request body. Replies 403 and returns null if it isn't valid.
  async function matchFrom(request, response) {
    const match = await readMatch(request.body?.matchToken);
    if (!match || (request.params.id && request.params.id !== match.id)) {
      response.status(403).json({ error: 'This duel has expired. Start a new one.' });
      return null;
    }
    return match;
  }

  app.get('/api/health', async (_request, response) => {
    const address = await ledgerAddress().catch(() => null);
    response.json({
      solana: address ? { cluster: CLUSTER, address, url: accountUrl(address) } : null,
      prune: hasPrune(),
      model: pruneModel(),
      store: store.kind,
      auth0: Boolean(auth0Config()),
      ritualGate: hasRitualGate(),
      faceLogin: Boolean(faceConfig()),
      playerRecords: hasPlayerRecords(),
    });
  });

  app.get('/api/config', (_request, response) => {
    response.json({ auth0: auth0Config(), faceLogin: Boolean(faceConfig()) });
  });

  app.post('/api/match', rateLimit(30), async (request, response) => {
    const input = Array.isArray(request.body?.players) ? request.body.players : [];
    const id = `m-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const players = [];
    // Each side's Auth0 user, kept in the signed match so the end of the duel can pay
    // out power levels. Not sent back with the players.
    const subs = [null, null];

    for (const side of [0, 1]) {
      const entry = input.find((player) => Number(player?.side) === side) ?? {};

      // An AI opponent: no login, its own Prune run, and mana from its rank.
      const rank = BOT_RANKS[entry.bot];
      if (rank) {
        players.push({
          side,
          name: rank.title,
          picture: null,
          kind: 'bot',
          rank: entry.bot,
          mana: rank.mana,
          playerId: `bot-${entry.bot}-${id}-${side}`,
          player: `bot-${entry.bot}`,
        });
        continue;
      }

      let wizard = null;
      if (entry.idToken) {
        wizard = await readWizard(entry.idToken).catch((error) => {
          console.warn(`Could not verify player ${side + 1}'s Auth0 login: ${error.message}`);
          return null;
        });
      }
      const kind = wizard ? (wizard.ritualVerified ? 'ritualWizard' : 'wizard') : 'guest';
      const playerId = wizard ? `wizard-${slug(wizard.sub)}` : `guest-${id}-${side}`;
      players.push({
        side,
        name: cleanText(wizard?.name ?? entry.name, 24) || `Wizard ${side + 1}`,
        picture: wizard?.picture ?? null,
        kind,
        mana: MANA[kind],
        playerId,
        // For the ledger: who this is, and which of their logins is playing.
        player: playerHash(wizard ? wizard.sub : `guest:${id}:${side}`),
        login: wizard ? loginHash(wizard.sub, wizard.loginAt) : null,
        // Signed-in wizards bring the power level they left off at; guests have none.
        power: wizard ? await powerOf(wizard.sub) : null,
      });
      subs[side] = wizard?.sub ?? null;

      // Signed-in wizards also get a monthly Prune budget, tied to their Auth0 user.
      if (wizard && hasPrune() && !budgetsSet.has(playerId)) {
        budgetsSet.add(playerId);
        setCustomerBudget(playerId, WIZARD_MONTHLY_BUDGET_USD).catch(warn('Prune budget'));
      }
    }

    const match = { id, startedAt: new Date().toISOString(), players, subs };
    // The game's hash: every ledger memo for this duel carries it.
    match.game = gameHash(match);
    await store.addMatch(match).catch(warn('Saving the match'));
    response.json({ matchId: id, game: match.game, matchToken: await signMatch(match), players });
  });

  app.post('/api/spell', rateLimit(90), async (request, response) => {
    const match = await matchFrom(request, response);
    if (!match) return;
    const player = match.players[Number(request.body.side)];
    const element = GESTURE_ELEMENTS[request.body.gesture];
    if (!player || !element) {
      response.status(400).json({ error: 'Unknown player or gesture.' });
      return;
    }
    if (!hasPrune()) {
      response.json({ outcome: 'error', element, error: 'Add PRUNE_API_KEY to cast spells.' });
      return;
    }

    const words = cleanText(request.body.words, 160);
    const started = Date.now();
    let result;
    try {
      result = await castSpell({
        playerId: player.playerId,
        matchId: match.id,
        gesture: request.body.gesture,
        words,
        manaSpells: player.mana,
      });
    } catch (error) {
      response.json({ outcome: 'error', element, words, error: error.message, latencyMs: Date.now() - started });
      return;
    }
    const latencyMs = Date.now() - started;
    let reply;

    if (result.blockedBy) {
      const outOfMana = ['agent_step_budget', 'run_budget'].includes(result.blockedBy);
      const outcome = result.blockedBy === 'prompt_injection' ? 'cheat' : outOfMana ? 'out_of_mana' : 'blocked';
      reply = { outcome, blockedBy: result.blockedBy, element, words, latencyMs, error: BLOCK_REASONS[result.blockedBy] };
    } else {
      // An AI opponent's spell is judged like anyone's, then kept inside its rank's range.
      const power = player.kind === 'bot' ? botPower(player.rank, result.spell?.power) : clampPower(result.spell?.power);
      reply = {
        outcome: 'cast',
        element,
        words,
        latencyMs,
        power,
        ...spellEffect(element, power),
        // The spell already landed at base power in the browser; this is the extra.
        bonus: judgeBonus(element, power),
        name: cleanText(result.spell?.name, 40) || `${element[0].toUpperCase()}${element.slice(1)} spell`,
        effectText: cleanText(result.spell?.effect, 120),
        costUsd: result.receipt?.cost_with_prune_usd ?? null,
        // Exactly as Prune sent it, so its signature can be checked later.
        receipt: result.receipt?.receipt_signature ? result.receiptRaw : null,
        // The judge's own rating (before an AI's rank range), signed, for the creativity score.
        rating: signRating({ matchId: match.id, side: player.side, rating: clampPower(result.spell?.power) }),
      };
      // The Duel Ledger: the judged spell, with a fingerprint of its Prune receipt.
      reply.ledger = await writeMemo(memoFor(match, { type: 'cast', side: player.side, element, power, receipt: reply.receipt }));
    }

    await store
      .addSpell({
        time: new Date().toISOString(),
        matchId: match.id,
        side: player.side,
        player: player.name,
        element,
        outcome: reply.outcome,
        power: reply.power ?? null,
        damage: reply.damage ?? null,
        name: reply.name ?? null,
        words,
        costUsd: reply.costUsd ?? null,
        latencyMs,
      })
      .catch(warn('Saving the spell'));
    response.json(reply);
  });

  app.post('/api/verify', rateLimit(60), async (request, response) => {
    const receipt = request.body?.receipt;
    if (typeof receipt !== 'string' || !receipt.startsWith('{') || receipt.length > MAX_RECEIPT_CHARS) {
      response.status(400).json({ error: 'Send the receipt exactly as the spell returned it.' });
      return;
    }
    try {
      response.json(await verifyReceipt(receipt, { tamper: request.body.tamper === true }));
    } catch (error) {
      response.status(502).json({ error: error.message });
    }
  });

  app.post('/api/match/:id/frames', rateLimit(120), async (request, response) => {
    const match = await matchFrom(request, response);
    if (!match) return;
    try {
      response.json({ saved: await store.addFrames(match.id, request.body.frames) });
    } catch (error) {
      console.warn(`Saving body tracking: ${error.message}`);
      response.status(500).json({ error: 'Could not save body tracking.' });
    }
  });

  app.post('/api/match/:id/end', rateLimit(30), async (request, response) => {
    const match = await matchFrom(request, response);
    if (!match) return;
    const winner = [0, 1, -1].includes(request.body.winner) ? request.body.winner : -1;
    const finalHp = Array.isArray(request.body.finalHp) ? request.body.finalHp.slice(0, 2).map(Number) : [];
    await store.endMatch(match.id, { winner, finalHp }).catch(warn('Saving the result'));
    // Every signed-in wizard who finished the duel: their long-term record grows (duels,
    // wins, losses, draws) and so does their power level, more for a win.
    const creativity = creativityScores(request.body.ratings, match.id);
    const finished = (sub, side) =>
      playerFinishedDuel(sub, {
        matchId: match.id,
        startedAt: match.startedAt,
        won: winner === side,
        draw: winner === -1,
        creativity: creativity[side].score,
      })
        .then((change) => change && { before: change.before, after: change.after, gained: change.gained, record: publicRecord(change.record) })
        .catch((error) => {
          console.warn(`Saving a player record: ${error.message}`);
          return null;
        });
    const power = await Promise.all([0, 1].map((side) => (match.subs?.[side] ? finished(match.subs[side], side) : null)));
    // The Duel Ledger: the final result, with a fingerprint of the replay and the new power levels.
    const levels = power.map((change) => change?.after ?? null);
    const ledger = await writeMemo(memoFor(match, { type: 'result', side: 0, winner, finalHp, replay: request.body.replay, power: levels }));

    // The scorecard, the last entry for the game: each player's creativity score (from
    // the judge's signed ratings) and stats, under one hash.
    const stats = Array.isArray(request.body.stats) ? request.body.stats : [];
    const n = (value, high) => Math.min(high, Math.max(0, Math.round(Number(value) || 0)));
    const card = [0, 1].map((side) => ({
      as: match.players[side]?.player ?? null,
      cr: creativity[side].score,
      j: creativity[side].judged,
      t: n(stats[side]?.thrown, 999),
      h: n(stats[side]?.hits, 999),
      b: n(stats[side]?.blocks, 999),
      dmg: n(stats[side]?.damage, 9999),
      hp: n(finalHp[side], 100),
      pl: levels[side],
    }));
    const hash = scoreHash(match, card);
    const scoreLedger = await writeMemo(memoFor(match, { type: 'score', card, hash }));
    response.json({ ok: true, ledger, power, score: { card, hash, ledger: scoreLedger } });
  });

  // The Duel Ledger: hits and blocks happen in the browser, which reports them here.
  // The server checks and trims every field before signing it onto Solana.
  app.post('/api/match/:id/ledger', rateLimit(150), async (request, response) => {
    const match = await matchFrom(request, response);
    if (!match) return;
    if (!hasSolana()) {
      response.json({ ledger: null });
      return;
    }
    const event = request.body?.event;
    // The start memo is built from the signed match alone; nothing the browser sends goes in it.
    const memo = ['hit', 'block'].includes(event?.type) ? memoFor(match, event) : event?.type === 'start' ? memoFor(match, { type: 'start' }) : null;
    if (!memo) {
      response.status(400).json({ error: 'Not a ledger event.' });
      return;
    }
    response.json({ ledger: await writeMemo(memo) });
  });

  // Everything on the Duel Ledger for one game, by its hash, read back from Solana.
  app.get('/api/ledger/game/:game', rateLimit(30), async (request, response) => {
    if (!/^[0-9a-f]{16}$/.test(request.params.game)) {
      response.status(400).json({ error: 'A game hash is 16 hex characters.' });
      return;
    }
    if (!hasSolana()) {
      response.json({ game: request.params.game, entries: [] });
      return;
    }
    try {
      const entries = await gameEntries(request.params.game);
      response.json({ game: request.params.game, ledger: accountUrl(await ledgerAddress()), count: entries.length, entries });
    } catch (error) {
      response.status(502).json({ error: `Could not read Solana: ${error.message}` });
    }
  });

  // An Auth0 sign-in from the browser (the Auth0 page): verified, then recorded on the ledger.
  app.post('/api/login', rateLimit(20), async (request, response) => {
    try {
      const wizard = await readWizard(request.body?.idToken);
      const [login, record] = await Promise.all([recordLogin(wizard), loggedIn(wizard)]);
      response.json({ login, power: record?.level ?? null, record });
    } catch (error) {
      response.status(401).json({ error: `That login could not be verified: ${error.message}` });
    }
  });

  app.get('/api/match/:id/replay', async (request, response) => {
    try {
      response.json(await store.replay(request.params.id));
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.get('/api/stats', async (_request, response) => {
    try {
      response.json(await store.stats());
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  // Face login: a face descriptor and a spoken name in; an Auth0 ID token out.
  // Changing a face login's name: the same face check, then a rename in Auth0.
  app.post('/api/face/rename', rateLimit(10), (request, response) => faceRoute(faceRename, request, response));
  app.post('/api/face/login', rateLimit(20), (request, response) => faceRoute(faceLogin, request, response));

  async function faceRoute(run, request, response) {
    try {
      const result = await run(request.body ?? {});
      // A face that signed in goes on the ledger like any other login.
      if (result.idToken) {
        const wizard = await readWizard(result.idToken).catch((error) => {
          console.warn(`Reading the face login: ${error.message}`);
          return null;
        });
        // The login goes on the ledger, and the account's power level comes back with it.
        const [login, record] = wizard ? await Promise.all([recordLogin(wizard).catch(() => null), loggedIn(wizard)]) : [null, null];
        Object.assign(result, { login, record, power: record?.level ?? null });
      }
      response.json(result);
    } catch (error) {
      console.warn(`Face login: ${error.message}`);
      response.status(502).json({ error: error.message });
    }
  }

  app.post('/api/gate/start', rateLimit(30), async (request, response) => {
    try {
      response.json(await gateStatus(request.body?.sessionToken));
    } catch (error) {
      response.status(401).json({ error: error.message });
    }
  });

  app.post('/api/gate/check', rateLimit(60), async (request, response) => {
    try {
      response.json(await checkRitual(request.body ?? {}));
    } catch (error) {
      response.status(401).json({ error: error.message });
    }
  });

  return { app, store };
}
