import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { auth0Config, checkRune, readWizard, runeStatus } from './auth.js';
import { castSpell, hasPrune, pruneModel, setCustomerBudget, verifyReceipt } from './prune.js';
import { createStore } from './store.js';
import { GESTURE_ELEMENTS, MANA, clampPower, spellEffect } from '../shared/rules.js';

const PORT = Number(process.env.PORT ?? 8788);
const DIST = join(import.meta.dirname, '..', 'dist');
const WIZARD_MONTHLY_BUDGET_USD = 0.05;
const MAX_RECEIPTS = 500;

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('No build found. Run "npm run build" first.');
  process.exit(1);
}

const app = express();
const store = await createStore(process.env.DATABASE_URL);
app.use(express.json({ limit: '2mb' }));

const matches = new Map();
const receipts = new Map();
const budgetsSet = new Set();

// Protects API credits if a public URL gets hammered.
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
      sub: wizard?.sub ?? null,
    });

    // Signed-in wizards also get a monthly Prune budget, tied to their Auth0 user.
    if (wizard && hasPrune() && !budgetsSet.has(playerId)) {
      budgetsSet.add(playerId);
      setCustomerBudget(playerId, WIZARD_MONTHLY_BUDGET_USD).catch(warn('Prune budget'));
    }
  }

  const match = { id, startedAt: new Date().toISOString(), players };
  matches.set(id, match);
  await store.addMatch(match).catch(warn('Saving the match'));
  response.json({ matchId: id, players: players.map(({ sub, ...player }) => player) });
});

app.post('/api/spell', rateLimit(90), async (request, response) => {
  const { matchId, side, gesture } = request.body ?? {};
  const player = matches.get(matchId)?.players[Number(side)];
  if (!player) {
    response.status(404).json({ error: 'Unknown match or player.' });
    return;
  }
  const element = GESTURE_ELEMENTS[gesture];
  if (!element) {
    response.status(400).json({ error: 'Unknown gesture.' });
    return;
  }
  if (!hasPrune()) {
    response.json({ outcome: 'error', element, error: 'Add PRUNE_API_KEY to .env to cast spells.' });
    return;
  }

  const words = cleanText(request.body.words, 160);
  const started = Date.now();
  let result;
  try {
    result = await castSpell({ playerId: player.playerId, matchId, gesture, words, manaSpells: player.mana });
  } catch (error) {
    response.json({ outcome: 'error', element, words, error: error.message, latencyMs: Date.now() - started });
    return;
  }
  const latencyMs = Date.now() - started;
  const spellId = randomUUID();
  let reply;

  if (result.blockedBy) {
    const outOfMana = ['agent_step_budget', 'run_budget'].includes(result.blockedBy);
    const outcome = result.blockedBy === 'prompt_injection' ? 'cheat' : outOfMana ? 'out_of_mana' : 'blocked';
    reply = { spellId, outcome, blockedBy: result.blockedBy, element, words, latencyMs };
  } else {
    const power = clampPower(result.spell?.power);
    if (result.receiptRaw) {
      receipts.set(spellId, result.receiptRaw);
      if (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
    }
    reply = {
      spellId,
      outcome: 'cast',
      element,
      words,
      latencyMs,
      power,
      ...spellEffect(element, power),
      name: cleanText(result.spell?.name, 40) || `${element[0].toUpperCase()}${element.slice(1)} spell`,
      effectText: cleanText(result.spell?.effect, 120),
      costUsd: result.receipt?.cost_with_prune_usd ?? null,
      signed: Boolean(result.receipt?.receipt_signature && result.receiptRaw),
    };
  }

  store
    .addSpell({
      time: new Date().toISOString(),
      matchId,
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
  const raw = receipts.get(request.body?.spellId);
  if (!raw) {
    response.status(404).json({ error: 'No receipt is saved for that spell.' });
    return;
  }
  try {
    response.json(await verifyReceipt(raw, { tamper: request.body.tamper === true }));
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.post('/api/match/:id/frames', rateLimit(120), async (request, response) => {
  if (!matches.has(request.params.id)) {
    response.status(404).json({ error: 'Unknown match.' });
    return;
  }
  try {
    response.json({ saved: await store.addFrames(request.params.id, request.body?.frames) });
  } catch (error) {
    console.warn(`Saving body tracking: ${error.message}`);
    response.status(500).json({ error: 'Could not save body tracking.' });
  }
});

app.post('/api/match/:id/end', rateLimit(30), async (request, response) => {
  const match = matches.get(request.params.id);
  if (!match || match.ended) {
    response.status(404).json({ error: 'Unknown or finished match.' });
    return;
  }
  match.ended = true;
  const winner = [0, 1, -1].includes(request.body?.winner) ? request.body.winner : -1;
  const finalHp = Array.isArray(request.body?.finalHp) ? request.body.finalHp.slice(0, 2).map(Number) : [];
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

app.use(express.static(DIST));

app.listen(PORT, () => {
  console.log(`HexByte is running at http://localhost:${PORT}`);
  console.log(`Prune: ${hasPrune() ? `on (${pruneModel()})` : 'off, add PRUNE_API_KEY'}`);
  console.log(`Storage: ${store.kind}`);
  console.log(`Auth0: ${auth0Config() ? auth0Config().domain : 'off, players join as guests'}`);
});
