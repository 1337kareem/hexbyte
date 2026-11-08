// Prints a link to try the Ritual Gate without Auth0. It signs a session token the
// same way the Auth0 Action does, for a made-up wizard, and opens the page in test
// mode, which shows the result instead of sending it to Auth0.
// Add "tap" after the user id to skip the camera: node ... gate-test-link.mjs test|ana tap
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const secret = process.env.GATE_SECRET ?? '';
if (secret.length < 32) {
  console.log('Set GATE_SECRET (32 or more characters) in .env first.');
  process.exit(1);
}
const sub = process.argv[2] ?? 'test|wizard';
const token = await new SignJWT({ name: 'Test Wizard' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub)
  .setExpirationTime('30m')
  .sign(new TextEncoder().encode(secret));

const port = process.env.PORT ?? 8788;
const tap = process.argv[3] === 'tap' ? '&tap=1' : '';
console.log(`http://localhost:${port}/gate.html?state=test-${randomUUID().slice(0, 8)}&session_token=${token}&dryRun=1${tap}`);
