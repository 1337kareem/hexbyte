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
import { auth0Config, checkRune, readWizard, runeStatus } from './auth.js';
import { castSpell, hasPrune, pruneModel, setCustomerBudget, verifyReceipt } from './prune.js';
import { createStore } from './store.js';
import { GESTURE_ELEMENTS, MANA, clampPower, spellEffect } from '../shared/rules.js';

const WIZARD_MONTHLY_BUDGET_USD = 0.05;
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

export async function readMatch(token) {
  try {
    const { payload } = await jwtVerify(String(token ?? ''), matchKey(), { algorithms: ['HS256'] });
    return payload.match ?? null;
  } catch {
    return null;
  }
}

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

  app.get('/api/health', (_request, response) => {
    response.json({
      prune: hasPrune(),
      model: pruneModel(),
      store: store.kind,
      auth0: Boolean(auth0Config()),
      runeGate: Boolean(auth0Config() && (process.env.RUNE_SECRET ?? '').length >= 32),
    });
  });

  app.get('/api/config', (_request, response) => {
    response.json({ auth0: auth0Config() });
  });

  app.post('/api/match', rateLimit(30), async (request, response) => {
    const input = Array.isArray(request.body?.players) ? request.body.players : [];
    const id = `m-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const players = [];

    for (const side of [0, 1]) {
      const entry = input.find((player) => Number(player?.side) === side) ?? {};
      let wizard = null;
      if (entry.idToken) {
        wizard = await readWizard(entry.idToken).catch((error) => {
          console.warn(`Could not verify player ${side + 1}'s Auth0 login: ${error.message}`);
          return null;
        });
      }
      const kind = wizard ? (wizard.runeVerified ? 'runeWizard' : 'wizard') : 'guest';
      const playerId = wizard ? `wizard-${slug(wizard.sub)}` : `guest-${id}-${side}`;
      players.push({
        side,
        name: cleanText(wizard?.name ?? entry.name, 24) || `Wizard ${side + 1}`,
        picture: wizard?.picture ?? null,
        kind,
        mana: MANA[kind],
        playerId,
      });

      // Signed-in wizards also get a monthly Prune budget, tied to their Auth0 user.
      if (wizard && hasPrune() && !budgetsSet.has(playerId)) {
        budgetsSet.add(playerId);
        setCustomerBudget(playerId, WIZARD_MONTHLY_BUDGET_USD).catch(warn('Prune budget'));
      }
    }

    const match = { id, startedAt: new Date().toISOString(), players };
    await store.addMatch(match).catch(warn('Saving the match'));
    response.json({ matchId: id, matchToken: await signMatch(match), players });
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
      reply = { outcome, blockedBy: result.blockedBy, element, words, latencyMs };
    } else {
      const power = clampPower(result.spell?.power);
      reply = {
        outcome: 'cast',
        element,
        words,
        latencyMs,
        power,
        ...spellEffect(element, power),
        name: cleanText(result.spell?.name, 40) || `${element[0].toUpperCase()}${element.slice(1)} spell`,
        effectText: cleanText(result.spell?.effect, 120),
        costUsd: result.receipt?.cost_with_prune_usd ?? null,
        // Exactly as Prune sent it, so its signature can be checked later.
        receipt: result.receipt?.receipt_signature ? result.receiptRaw : null,
      };
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
    response.json({ ok: true });
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

  app.post('/api/rune/start', rateLimit(30), async (request, response) => {
    try {
      response.json(await runeStatus(store, request.body?.sessionToken));
    } catch (error) {
      response.status(401).json({ error: error.message });
    }
  });

  app.post('/api/rune/check', rateLimit(60), async (request, response) => {
    try {
      response.json(await checkRune(store, request.body ?? {}));
    } catch (error) {
      response.status(401).json({ error: error.message });
    }
  });

  return { app, store };
}
