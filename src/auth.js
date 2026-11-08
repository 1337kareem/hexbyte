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

// Face login hands over its own Auth0 ID token (see facescan.js).
export function saveWizard(side, wizard) {
  saveWizards({ ...savedWizards(), [side]: wizard });
}

export function forgetWizard(side) {
  const wizards = savedWizards();
  delete wizards[side];
  saveWizards(wizards);
}

// Returns an error message if the login was refused (for example, the ritual failed).
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
        ritualVerified: claims[`${CLAIMS}ritual_verified`] === true,
        // The ledger's record of this login, and the player record saved on the account.
        ...(await recordLogin(claims.__raw)),
      },
    });
    return null;
  } catch (error) {
    return `Sign-in did not finish: ${error.message}`;
  } finally {
    window.history.replaceState({}, '', '/');
  }
}

// Puts this sign-in on the Duel Ledger (a hash of the login and of who it signed in).
async function recordLogin(idToken) {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!response.ok) return { login: null, power: null, record: null };
    const { login = null, power = null, record = null } = await response.json();
    return { login, power, record };
  } catch {
    return { login: null, power: null, record: null };
  }
}

export function signIn(side) {
  if (!client) return;
  client.loginWithRedirect({
    appState: { side },
    authorizationParams: { prompt: 'login' },
  });
}
