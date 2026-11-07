// Runs HexByte locally: the API from app.js plus the built game from dist/.
// On Vercel, api/index.js runs the same API and Vercel serves dist/ itself.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { auth0Config } from './auth.js';
import { hasPrune, pruneModel } from './prune.js';

const PORT = Number(process.env.PORT ?? 8788);
const DIST = join(import.meta.dirname, '..', 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('No build found. Run "npm run build" first.');
  process.exit(1);
}

const { app, store } = await createApp();
app.use(express.static(DIST));

app.listen(PORT, () => {
  console.log(`HexByte is running at http://localhost:${PORT}`);
  console.log(`Prune: ${hasPrune() ? `on (${pruneModel()})` : 'off, add PRUNE_API_KEY'}`);
  console.log(`Storage: ${store.kind}`);
  console.log(`Auth0: ${auth0Config() ? auth0Config().domain : 'off, players join as guests'}`);
});
