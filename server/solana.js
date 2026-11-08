// The Duel Ledger: HexByte writes every judged spell, every hit and every match
// result to Solana devnet as a memo transaction, signed by the server's key.
//
// Prune proves what the AI judge said (a signed receipt); the ledger puts a
// fingerprint of that receipt, and what the spell then did, on a public chain where
// nobody can quietly rewrite a duel's history. It's devnet (the free test network),
// so no real money moves and players need no wallets.
//
// Every memo names its game by a hash (g), and every player by a hash (as), so one
// game's entries never mix with another's. Each login is recorded too: which login
// (lg) signed in which player (as). Hashes are keyed with a server secret, so nobody
// can work back from them to a name or an Auth0 user.
//
// Sends never hold up a duel: a slow or failed Solana call only means a missing link.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  appendTransactionMessageInstruction,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';

export const CLUSTER = 'devnet';
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
// A blockhash stays valid for about a minute; reuse it for 20 seconds to save calls.
const BLOCKHASH_MS = 20_000;
// Memos must stay small; ours are about 120 to 200 bytes.
const MAX_MEMO_BYTES = 500;

const ELEMENTS = ['fire', 'lightning', 'frost', 'shield'];
const ZONES = ['head', 'torso', 'limb'];

export const hasSolana = () => Buffer.from(process.env.SOLANA_SECRET_KEY ?? '', 'base64').length === 32;

export const explorerUrl = (signature) => `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
export const accountUrl = (address) => `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;

// A short, stable fingerprint of a Prune receipt (or a replay), safe to publish.
export const fingerprint = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

// Hashes for the ledger, keyed with a secret every copy of the server shares.
const fallbackSalt = randomBytes(32);
function ledgerHash(...parts) {
  const salt = process.env.GATE_SECRET || process.env.MATCH_SECRET || process.env.PRUNE_API_KEY || fallbackSalt;
  return createHmac('sha256', salt).update(['hexbyte ledger', ...parts].join('\n')).digest('hex').slice(0, 16);
}

// Who: the same Auth0 user is always the same hash, game after game.
export const playerHash = (sub) => ledgerHash('player', sub);
// Which login: each sign-in (the user and when Auth0 issued the token) gets its own hash.
export const loginHash = (sub, loginAt) => ledgerHash('login', sub, loginAt);
// Which game: unique to the match, when it started, and who logged in to play it.
export const gameHash = (match) =>
  ledgerHash('game', match.id, match.startedAt, ...match.players.map((player) => `${player.player}:${player.login ?? ''}`));

// The scorecard's hash: covers the game and every number on the card, so anyone holding
// the card can check it against the ledger, and a changed number won't match.
export const scoreHash = (match, card) => ledgerHash('score', match.game ?? match.id, JSON.stringify(card));

const HASH = /^[0-9a-f]{16}$/;
const hashOrNull = (value) => (HASH.test(String(value)) ? value : null);

const clampInt = (value, low, high) => Math.min(high, Math.max(low, Math.round(Number(value) || 0)));
const clean = (value, max) =>
  String(value ?? '')
    .replace(/[^\w .,!?'-]/g, '')
    .slice(0, max);

const finish = (type, body) => {
  const memo = `HexByte ${type} ${JSON.stringify(body)}`;
  return Buffer.byteLength(memo) <= MAX_MEMO_BYTES ? memo : null;
};

// A sign-in: which login, as which player, and how (face login or the Auth0 page).
export function loginMemo({ hash, player, via }) {
  if (!hashOrNull(hash) || !hashOrNull(player)) return null;
  return finish('login', { lg: hash, as: player, via: via === 'face' ? 'face' : 'auth0' });
}

// Builds the memo text for one ledger event, or null if the event isn't valid.
// Everything a player's browser sends is checked and trimmed here first.
export function memoFor(match, event) {
  // The game's hash heads every memo (older match tokens fall back to the match id).
  const game = { g: match.game ?? match.id, m: match.id };
  const as = (side) => clean(match.players?.[side]?.player ?? match.players?.[side]?.name, 24);
  if (event?.type === 'start') {
    return finish('start', {
      ...game,
      p: (match.players ?? []).slice(0, 2).map((player) => ({
        as: as(player.side),
        ...(hashOrNull(player.login) ? { lg: player.login } : {}),
        k: clean(player.kind, 12),
        ...(player.rank ? { r: clean(player.rank, 8) } : {}),
      })),
    });
  }
  // The end-of-duel scorecard: each player's creativity score and stats, and its hash.
  if (event?.type === 'score') {
    if (!Array.isArray(event.card) || !hashOrNull(event.hash)) return null;
    return finish('score', { ...game, p: event.card.slice(0, 2), sh: event.hash });
  }
  const side = Number(event?.side);
  if (event?.type !== 'result' && ![0, 1].includes(side)) return null;
  let body;
  if (event.type === 'cast') {
    if (!ELEMENTS.includes(event.element)) return null;
    body = {
      ...game,
      p: side,
      as: as(side),
      el: event.element,
      pw: clampInt(event.power, 1, 10),
      ...(event.receipt ? { rc: fingerprint(event.receipt) } : {}),
    };
  } else if (event.type === 'hit') {
    if (!ELEMENTS.includes(event.element) || !ZONES.includes(event.zone)) return null;
    body = {
      ...game,
      by: side,
      as: as(side),
      el: event.element,
      z: event.zone,
      dmg: clampInt(event.damage, 0, 99),
      ...(event.bonus ? { bonus: 1 } : {}),
      ...(typeof event.cast === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(event.cast) ? { c: event.cast.slice(0, 16) } : {}),
    };
  } else if (event.type === 'block') {
    if (!ELEMENTS.includes(event.element)) return null;
    body = { ...game, by: side, as: as(side), el: event.element, blocked: 1 };
  } else if (event.type === 'result') {
    const hp = Array.isArray(event.finalHp) ? event.finalHp.slice(0, 2).map((v) => clampInt(v, 0, 100)) : [];
    body = {
      ...game,
      w: [0, 1, -1].includes(event.winner) ? event.winner : -1,
      hp,
      ...(typeof event.replay === 'string' && /^[0-9a-f]{16,64}$/.test(event.replay) ? { rp: event.replay.slice(0, 16) } : {}),
      // Each side's power level after this duel (null for guests and the AI).
      ...(Array.isArray(event.power) && event.power.some(Number.isFinite)
        ? { pl: event.power.slice(0, 2).map((level) => (Number.isFinite(level) ? clampInt(level, 0, 1_000_000) : null)) }
        : {}),
    };
  } else {
    return null;
  }
  return finish(event.type, body);
}

let rpc = null;
let signer = null;
let blockhash = null;

async function ready() {
  rpc ??= createSolanaRpc(RPC_URL);
  signer ??= await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(Buffer.from(process.env.SOLANA_SECRET_KEY, 'base64')));
  if (!blockhash || Date.now() - blockhash.at > BLOCKHASH_MS) {
    const { value } = await rpc.getLatestBlockhash().send();
    blockhash = { value, at: Date.now() };
  }
  return { rpc, signer, latest: blockhash.value };
}

export async function ledgerAddress() {
  if (!hasSolana()) return null;
  signer ??= await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(Buffer.from(process.env.SOLANA_SECRET_KEY, 'base64')));
  return signer.address;
}

// Signs and sends one memo. Resolves with its signature and explorer link once the
// network has accepted it (it confirms a moment later); never throws.
export async function writeMemo(memo) {
  if (!hasSolana() || !memo) return null;
  try {
    const { rpc, signer, latest } = await ready();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstruction(getAddMemoInstruction({ memo }), m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
    return { signature, url: explorerUrl(signature) };
  } catch (error) {
    // A stale blockhash is the usual cause; fetch a fresh one next time.
    blockhash = null;
    const reason = [error.message, error.cause?.message].filter(Boolean).join(': ');
    console.warn(`Solana ledger: ${reason}`.slice(0, 300));
    return null;
  }
}

// Every ledger entry for one game, oldest first, read back from Solana.
export async function gameEntries(game, limit = 1000) {
  if (!hasSolana() || !hashOrNull(game)) return null;
  const { rpc, signer } = await ready();
  const found = await rpc.getSignaturesForAddress(signer.address, { limit, commitment: 'confirmed' }).send();
  return found
    .filter((entry) => entry.memo?.includes(`"g":"${game}"`))
    .map((entry) => {
      // Solana returns the memo as "[length] text".
      const memo = entry.memo.replace(/^\[\d+\]\s*/, '');
      const type = memo.match(/^HexByte (\w+)/)?.[1] ?? 'memo';
      let body = null;
      try {
        body = JSON.parse(memo.slice(memo.indexOf('{')));
      } catch {
        // Keep the raw memo.
      }
      return {
        type,
        body,
        signature: entry.signature,
        url: explorerUrl(entry.signature),
        at: entry.blockTime ? new Date(Number(entry.blockTime) * 1000).toISOString() : null,
        failed: Boolean(entry.err),
      };
    })
    .reverse();
}

export async function ledgerBalance() {
  if (!hasSolana()) return null;
  const { rpc, signer } = await ready();
  const { value } = await rpc.getBalance(signer.address).send();
  return Number(value) / 1e9;
}
