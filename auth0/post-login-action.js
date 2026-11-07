/**
 * HexByte Rune Gate: an Auth0 post-login Action.
 *
 * Setup (Auth0 dashboard):
 * 1. Actions > Library > Create Action > Build from scratch. Trigger: Login / Post Login.
 * 2. Paste this file. Add these secrets (the key icon on the left):
 *      RUNE_SECRET       The same value as RUNE_SECRET in HexByte's .env.
 *      RUNE_GATE_URL     Where the Rune Gate page runs, e.g. http://localhost:8788/rune.html
 *      HEXBYTE_CLIENT_ID Optional. Your HexByte application's Client ID, so the gate
 *                        only runs for HexByte logins.
 * 3. Deploy, then open Actions > Triggers > post-login and drag the Action into the flow.
 *
 * What it does: after the normal login, Auth0 pauses and sends the wizard to the
 * Rune Gate to draw their rune in the air. The gate sends back a signed result.
 * A match is recorded as a login method on the session (valid for 24 hours) and
 * adds a rune_verified claim to the ID token. Three wrong runes refuse the login.
 */
const CLAIMS = 'https://hexbyte.game/';
const RECHECK_MS = 24 * 60 * 60 * 1000;

exports.onExecutePostLogin = async (event, api) => {
  const onlyFor = event.secrets.HEXBYTE_CLIENT_ID;
  if (onlyFor && event.client.client_id !== onlyFor) return;

  const gate = event.secrets.RUNE_GATE_URL;
  const recent = (event.authentication?.methods ?? []).find(
    (method) => method.name === gate && Date.now() - new Date(method.timestamp).getTime() < RECHECK_MS,
  );
  if (recent) {
    api.idToken.setCustomClaim(`${CLAIMS}rune_verified`, true);
    return;
  }

  const sessionToken = api.redirect.encodeToken({
    secret: event.secrets.RUNE_SECRET,
    expiresInSeconds: 300,
    payload: { name: event.user.name ?? event.user.nickname ?? event.user.email ?? 'Wizard' },
  });
  api.redirect.sendUserTo(gate, { query: { session_token: sessionToken } });
};

exports.onContinuePostLogin = async (event, api) => {
  // Checks the signature, the expiry, and that the state matches this login.
  const result = api.redirect.validateToken({
    secret: event.secrets.RUNE_SECRET,
    tokenParameterName: 'rune_token',
  });
  if (result.sub !== event.user.user_id || result.rune_ok !== true) {
    api.access.deny('The rune did not match.');
    return;
  }
  api.authentication.recordMethod(event.secrets.RUNE_GATE_URL);
  api.idToken.setCustomClaim(`${CLAIMS}rune_verified`, true);
};
