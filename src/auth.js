// Auth0 sign-in for two wizards on one laptop. Each player signs in on their own
// turn (prompt=login lets the second player use a different account), and we keep
// each player's ID token so the server can verify who is playing.
import { createAuth0Client } from '@auth0/auth0-spa-js';

const STORE_KEY = 'hexbyte.wizards';
const CLAIMS = 'https://hexbyte.game/';

let client = null;

export function savedWizards() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveWizards(wizards) {
  sessionStorage.setItem(STORE_KEY, JSON.stringify(wizards));
}

export function forgetWizard(side) {
  const wizards = savedWizards();
  delete wizards[side];
  saveWizards(wizards);
}

// Returns an error message if the login was refused (for example, a wrong rune).
export async function initAuth(config) {
  if (!config) return null;
  client = await createAuth0Client({
    domain: config.domain,
    clientId: config.clientId,
    cacheLocation: 'memory',
    authorizationParams: { redirect_uri: `${window.location.origin}/` },
  });

  const params = new URLSearchParams(window.location.search);
  if (!params.has('state') || !(params.has('code') || params.has('error'))) return null;
  try {
    if (params.has('error')) throw new Error(params.get('error_description') || params.get('error'));
    const { appState } = await client.handleRedirectCallback();
    const claims = await client.getIdTokenClaims();
    const side = appState?.side === 1 ? 1 : 0;
    saveWizards({
      ...savedWizards(),
      [side]: {
        idToken: claims.__raw,
        name: claims.name ?? claims.nickname ?? claims.email ?? 'Wizard',
        picture: claims.picture ?? null,
        runeVerified: claims[`${CLAIMS}rune_verified`] === true,
      },
    });
    return null;
  } catch (error) {
    return `Sign-in did not finish: ${error.message}`;
  } finally {
    window.history.replaceState({}, '', '/');
  }
}

export function signIn(side) {
  if (!client) return;
  client.loginWithRedirect({
    appState: { side },
    authorizationParams: { prompt: 'login' },
  });
}
