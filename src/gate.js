// The Ritual Gate page. Auth0 sends a wizard here in the middle of signing in.
// They prove they're a live person on camera with the 3-step ritual: two thumbs up,
// a heart made with both hands, and a dance. The server checks the steps, and this
// page posts the signed result back to Auth0 so the login can finish.
import './styles.css';
import './gate.css';
import { Ritual, STEPS } from './ritual.js';
import { Vision } from './vision.js';

const params = new URLSearchParams(window.location.search);
const state = params.get('state');
const sessionToken = params.get('session_token');
const dryRun = params.has('dryRun');

// The camera is drawn this many pixels wide, then scaled up for the pixel look.
const PIXEL_WIDTH = 120;
// In test mode, each "done" waits this long, so the timing still looks like a real ritual.
const TEST_STEP_MS = 1100;

const $ = (selector) => document.querySelector(selector);
const video = $('#gate-video');
const canvas = $('#gate-canvas');
const ctx = canvas.getContext('2d');
const small = document.createElement('canvas');
const smallCtx = small.getContext('2d');

let auth0 = null;
let vision = null;
let ritual = null;
let sending = false;
let finished = false;
let tapMode = params.has('tap');
let shown = '';

const setStatus = (text, tone = '') => {
  $('#gate-status').textContent = text;
  $('#gate-status').dataset.tone = tone;
};

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function buildSteps() {
  $('#gate-steps').replaceChildren(
    ...STEPS.map((step, i) => {
      const item = document.createElement('li');
      item.dataset.step = String(i);
      item.textContent = `${step.emoji} ${step.title}`;
      return item;
    }),
  );
}

async function boot() {
  buildSteps();
  if (!state || !sessionToken) {
    $('#gate-title').textContent = 'Open this page by signing in to HexByte.';
    return;
  }
  try {
    auth0 = (await (await fetch('/api/config')).json()).auth0;
    const info = await post('/api/gate/start', { sessionToken });
    $('#gate-title').textContent = `Welcome, ${info.name}. Prove you're a live wizard: three moves on camera.`;
  } catch (error) {
    $('#gate-title').textContent = `This sign-in link is not valid: ${error.message}`;
    return;
  }
  ritual = new Ritual({ sides: [0], requireFullBody: false });
  $('#gate-test').addEventListener('click', testStep);
  if (tapMode) {
    useTapMode('Test mode: press the button after each step.');
  } else {
    try {
      vision = new Vision({ video, onGesture: () => {} });
      vision.solo = true;
      await vision.start((text) => setStatus(text));
      setStatus('Camera ready. Follow the steps on the right.');
    } catch (error) {
      useTapMode(`Camera unavailable (${error.message}). Test mode: press the button after each step.`);
    }
  }
  requestAnimationFrame(frame);
}

function useTapMode(message) {
  tapMode = true;
  $('#gate-test').hidden = false;
  $('#gate-reading-label').textContent = 'Test mode';
  setStatus(message);
}

// Test mode only: marks the current step done, with a short wait so the timing is believable.
function testStep() {
  if (!ritual || ritual.done) return;
  $('#gate-test').disabled = true;
  ritual.next(performance.now());
  setTimeout(() => ($('#gate-test').disabled = false), TEST_STEP_MS);
}

async function send() {
  sending = true;
  setStatus('Checking your ritual…');
  try {
    const result = await post('/api/gate/check', { sessionToken, state, steps: ritual.log });
    if (result.status === 'accepted') {
      finished = true;
      document.body.dataset.result = 'open';
      $('#gate-step').textContent = 'Gate open';
      setStatus('Ritual complete. Entering HexByte…', 'good');
      finish(result.token);
      return;
    }
    setStatus("That didn't look like a real ritual. Let's do it again.", 'bad');
  } catch (error) {
    setStatus(error.message, 'bad');
  }
  ritual = new Ritual({ sides: [0], requireFullBody: false });
  sending = false;
}

// Sends the signed result back to Auth0, which resumes the login.
function finish(token) {
  const action = `https://${auth0?.domain ?? 'your-tenant.auth0.com'}/continue?state=${encodeURIComponent(state)}`;
  if (dryRun || !auth0) {
    $('#gate-title').textContent = `Test mode: would send gate_token to ${action}`;
    window.gateResult = { action, token };
    return;
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'gate_token', value: token }));
  document.body.append(form);
  setTimeout(() => form.submit(), 900);
}

function showStep() {
  const step = ritual.current;
  const inView = tapMode || ritual.inFrame[0];
  const share = ritual.share(0);
  const key = `${ritual.step}|${inView}|${Math.round(share * 20)}|${finished}`;
  if (key === shown) return;
  shown = key;
  $('#gate-count').textContent = step ? `Step ${ritual.step + 1} of 3` : 'All 3 steps done';
  $('#gate-emoji').textContent = step?.emoji ?? '✨';
  if (!finished) $('#gate-step').textContent = step?.title ?? 'Ritual complete';
  $('#gate-hint').textContent = step ? step.hint : '';
  $('#gate-reading-label').textContent = tapMode ? 'Test mode' : inView ? (share > 0 ? 'Keep going!' : 'Watching…') : 'Step into view';
  $('#gate-hold-fill').style.width = `${Math.round(share * 100)}%`;
  $('#gate-steps')
    .querySelectorAll('li')
    .forEach((item) => {
      const i = Number(item.dataset.step);
      item.className = i < ritual.step ? 'done' : i === ritual.step ? 'now' : '';
    });
}

function frame(t) {
  if (ritual && !ritual.done && !tapMode && vision?.running) {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    ritual.update({ poses: { 0: vision.sides[0].pose }, hands: { 0: vision.sides[0].hands }, aspect }, t);
  }
  if (ritual) showStep();
  if (ritual?.done && !sending && !finished) send();
  draw();
  requestAnimationFrame(frame);
}

// The camera, tiny and scaled back up, with the hand points the gate is reading.
function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0a1020';
  ctx.fillRect(0, 0, width, height);
  if (vision?.running && video.readyState >= 2) {
    small.width = PIXEL_WIDTH;
    small.height = Math.round((PIXEL_WIDTH * height) / width) || 1;
    smallCtx.save();
    smallCtx.translate(small.width, 0);
    smallCtx.scale(-1, 1);
    smallCtx.drawImage(video, 0, 0, small.width, small.height);
    smallCtx.restore();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(small, 0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#facc15';
    for (const hand of vision.sides[0].hands ?? []) {
      for (const point of hand.points) ctx.fillRect(Math.round(point.x * width) - 3, Math.round(point.y * height) - 3, 6, 6);
    }
  }
}

boot();
