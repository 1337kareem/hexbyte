// Checks each sponsor service with the settings in .env. It never prints a secret.
import pg from 'pg';
import { auth0Config } from '../server/auth.js';
import { hasSolana, ledgerAddress, ledgerBalance, writeMemo } from '../server/solana.js';
import { castSpell, hasPrune, verifyReceipt } from '../server/prune.js';

const failures = [];
const secrets = [process.env.PRUNE_API_KEY, process.env.DATABASE_URL, process.env.RUNE_SECRET].filter(Boolean);
const hide = (message) => secrets.reduce((text, secret) => text.replaceAll(secret, '[hidden]'), String(message));

async function check(name, configured, test, missing) {
  if (!configured) {
    console.log(`-  ${name}: ${missing}`);
    return;
  }
  try {
    console.log(`OK ${name}: ${await test()}`);
  } catch (error) {
    failures.push(name);
    console.log(`X  ${name}: ${hide(error.message)}`);
  }
}

await check(
  'Prune',
  hasPrune(),
  async () => {
    const result = await castSpell({
      playerId: 'sponsor-check',
      matchId: `check-${Date.now()}`,
      gesture: 'Closed_Fist',
      words: 'Spark of the sponsor check!',
      manaSpells: 3,
    });
    if (result.blockedBy) throw new Error(`Prune blocked the test spell: ${result.blockedBy}`);
    if (!result.spell) throw new Error('The spell came back without JSON.');
    const verdict = await verifyReceipt(result.receiptRaw);
    if (!verdict.valid) throw new Error(`The receipt did not verify: ${verdict.reason}`);
    return `cast "${result.spell.name}" (power ${result.spell.power}) and verified its signed receipt`;
  },
  'no PRUNE_API_KEY in .env',
);

await check(
  'Tiger Data',
  Boolean(process.env.DATABASE_URL),
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`);
      if (!rows[0]) throw new Error('Connected, but TimescaleDB is missing. Use a Tiger Data service connection string.');
      return `connected (TimescaleDB ${rows[0].extversion}). Tables are created when the server starts.`;
    } finally {
      await client.end();
    }
  },
  'no DATABASE_URL in .env (duels save to server/data/)',
);

await check(
  'Solana',
  hasSolana(),
  async () => {
    const address = await ledgerAddress();
    const balance = await ledgerBalance();
    if (!balance) throw new Error(`Ledger key ${address} has no devnet SOL. Fund it at https://faucet.solana.com (Devnet).`);
    const written = await writeMemo(`HexByte check {"t":${Date.now()}}`);
    if (!written) throw new Error('Devnet did not accept a test memo (see the warning above).');
    return `Duel Ledger key ${address} has ${balance} devnet SOL. Test memo: ${written.url}`;
  },
  'no SOLANA_SECRET_KEY in .env (the Duel Ledger is off)',
);

const auth0 = auth0Config();
await check(
  'Auth0',
  Boolean(auth0),
  async () => {
    const response = await fetch(`https://${auth0.domain}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`${auth0.domain} returned ${response.status}. Check AUTH0_DOMAIN.`);
    const gate = (process.env.GATE_SECRET ?? '').length >= 32;
    return `tenant ${auth0.domain} is reachable. Ritual Gate secret ${gate ? 'is set' : 'is missing (needs 32+ characters)'}.`;
  },
  'no AUTH0_DOMAIN or AUTH0_CLIENT_ID in .env (players join as guests)',
);

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exitCode = 1;
}
