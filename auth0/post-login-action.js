/**
 * HexByte Ritual Gate: an Auth0 post-login Action.
 *
 * Setup (Auth0 dashboard):
 * 1. Actions > Library > Create Action > Build from scratch. Trigger: Login / Post Login.
 * 2. Paste this file. Add these secrets (the key icon on the left):
 *      GATE_SECRET       The same value as GATE_SECRET in HexByte's .env.
 *      HEXBYTE_CLIENT_ID Optional. Your HexByte application's Client ID, so the gate
 *                        only runs for HexByte logins.
 *      GATE_URL          Optional. By default the gate is /gate.html on the same site
 *                        the login came from, so localhost and the live site both work.
 * 3. Deploy, then open Actions > Triggers > post-login and drag the Action into the flow.
 *
 * What it does: after the normal login, Auth0 pauses and sends the wizard to the
 * Ritual Gate, where they prove they're a live person on camera: two thumbs up, a
 * heart made with both hands, and a dance. The gate sends back a signed result. A
 * pass is recorded as a login method on the session (valid for 24 hours) and adds a
 * ritual_verified claim to the ID token.
 */
const CLAIMS = 'https://hexbyte.game/';
const RECHECK_MS = 24 * 60 * 60 * 1000;
// The name the Ritual Gate is recorded under in the session's login methods.
const METHOD = 'https://hexbyte.game/ritual-gate';

// Auth0 only accepts redirect URIs from the app's Allowed Callback URLs, so the gate
// page can safely live on the same site the login came from.
function gateUrl(event) {
  if (event.secrets.GATE_URL) return event.secrets.GATE_URL;
  const back = event.transaction?.redirect_uri;
  return back ? new URL('/gate.html', back).toString() : null;
}

exports.onExecutePostLogin = async (event, api) => {
  const onlyFor = event.secrets.HEXBYTE_CLIENT_ID;
  if (onlyFor && event.client.client_id !== onlyFor) return;

  const recent = (event.authentication?.methods ?? []).find(
    (method) => method.name === METHOD && Date.now() - new Date(method.timestamp).getTime() < RECHECK_MS,
  );
  if (recent) {
    api.idToken.setCustomClaim(`${CLAIMS}ritual_verified`, true);
    return;
  }

  const gate = gateUrl(event);
  if (!gate) return;
  const sessionToken = api.redirect.encodeToken({
    secret: event.secrets.GATE_SECRET,
    expiresInSeconds: 600,
    payload: { name: event.user.name ?? event.user.nickname ?? event.user.email ?? 'Wizard' },
  });
  api.redirect.sendUserTo(gate, { query: { session_token: sessionToken } });
};

exports.onContinuePostLogin = async (event, api) => {
  // Checks the signature, the expiry, and that the state matches this login.
  const result = api.redirect.validateToken({
    secret: event.secrets.GATE_SECRET,
    tokenParameterName: 'gate_token',
  });
  if (result.sub !== event.user.user_id || result.ritual_ok !== true) {
    api.access.deny('The ritual was not completed.');
    return;
  }
  api.authentication.recordMethod(METHOD);
  api.idToken.setCustomClaim(`${CLAIMS}ritual_verified`, true);
};
