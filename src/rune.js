// The Rune Gate page. Auth0 sends a wizard here in the middle of signing in.
// The wizard draws their rune in the air (pinch to draw) or with the mouse; the
// server compares it to the saved rune, and this page posts the signed result back
// to Auth0 so the login can finish.
import './styles.css';
import './rune.css';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';

const params = new URLSearchParams(window.location.search);
const state = params.get('state');
const sessionToken = params.get('session_token');
const dryRun = params.has('dryRun');

const $ = (selector) => document.querySelector(selector);
const canvas = $('#rune-canvas');
const ctx = canvas.getContext('2d');
const video = $('#rune-video');

const PINCH_ON = 0.35;
const PINCH_OFF = 0.5;

let auth0 = null;
let busy = false;
let stroke = [];
let lastStroke = null;
let cursor = null;
let pinching = false;
// Which input is drawing right now: 'hand' or 'mouse'. They never mix in one stroke.
let source = null;
let recognizer = null;
let lastVideoTime = -1;

const setStatus = (text, tone = '') => {
  $('#rune-status').textContent = text;
  $('#rune-status').className = `rune-status ${tone}`;
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

async function boot() {
  if (!state || !sessionToken) {
    $('#rune-title').textContent = 'Open this page by signing in to HexByte.';
    return;
  }
  try {
    auth0 = (await (await fetch('/api/config')).json()).auth0;
    const info = await post('/api/rune/start', { sessionToken });
    $('#rune-title').textContent = info.enrolled
      ? `Welcome back, ${info.name}. Draw your rune to enter.`
      : `Welcome, ${info.name}. Choose a rune: any shape you can draw in one stroke. Draw it ${info.needed} times.`;
    if (!info.enrolled) $('#rune-progress').textContent = `Saved ${info.samples} of ${info.needed}`;
  } catch (error) {
    $('#rune-title').textContent = `This sign-in link is not valid: ${error.message}`;
    return;
  }
  setupMouse();
  // ?mouse in the address skips the camera, for testing with a mouse only.
  if (params.has('mouse')) setStatus('Mouse mode. Draw your rune in the box.');
  else startCamera().catch((error) => setStatus(`Camera unavailable (${error.message}). Draw with your mouse instead.`));
  requestAnimationFrame(draw);
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await video.play();
  const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '/models/gesture_recognizer.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  setStatus('Camera ready. Pinch to start drawing.');
}

function readHand(now) {
  if (!recognizer || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const hand = recognizer.recognizeForVideo(video, now).landmarks[0];
  if (source === 'mouse') return;
  if (!hand) {
    cursor = null;
    if (pinching) endStroke();
    return;
  }
  const point = (i) => ({ x: 1 - hand[i].x, y: hand[i].y });
  const size = Math.hypot(hand[0].x - hand[9].x, hand[0].y - hand[9].y) || 1;
  const gap = Math.hypot(hand[4].x - hand[8].x, hand[4].y - hand[8].y) / size;
  cursor = point(8);
  if (!pinching && gap < PINCH_ON) {
    pinching = true;
    source = 'hand';
    stroke = [];
  } else if (pinching && gap > PINCH_OFF) {
    endStroke();
  }
  if (pinching) stroke.push([cursor.x, cursor.y]);
}

function setupMouse() {
  const toPoint = (event) => {
    const box = canvas.getBoundingClientRect();
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
  };
  canvas.addEventListener('pointerdown', (event) => {
    if (source === 'hand') return;
    canvas.setPointerCapture(event.pointerId);
    pinching = true;
    source = 'mouse';
    stroke = [toPoint(event)];
  });
  canvas.addEventListener('pointermove', (event) => {
    if (source === 'mouse') stroke.push(toPoint(event));
  });
  canvas.addEventListener('pointerup', () => source === 'mouse' && endStroke());
  canvas.addEventListener('pointercancel', () => source === 'mouse' && endStroke());
}

async function endStroke() {
  if (!pinching) return;
  pinching = false;
  source = null;
  const drawn = stroke;
  stroke = [];
  if (busy || drawn.length < 12) {
    if (!busy) setStatus('That was too short. Pinch and draw a whole shape.');
    return;
  }
  lastStroke = { points: drawn, at: performance.now() };
  busy = true;
  setStatus('Checking your rune…');
  try {
    handle(await post('/api/rune/check', { sessionToken, state, stroke: drawn }));
  } catch (error) {
    setStatus(error.message, 'bad');
  } finally {
    busy = false;
  }
}

function handle(result) {
  if (result.status === 'too_small') setStatus('Draw it bigger, as a shape rather than a line.', 'bad');
  else if (result.status === 'enroll_mismatch') {
    setStatus(`That doesn't match your first drawing (${pct(result.score)} alike). Draw the same rune again.`, 'bad');
  } else if (result.status === 'enrolling') {
    $('#rune-progress').textContent = `Saved ${result.samples} of ${result.needed}`;
    setStatus('Saved. Draw the same rune again.', 'good');
  } else if (result.status === 'rejected') {
    const tries = result.triesLeft === 1 ? '1 try' : `${result.triesLeft} tries`;
    setStatus(`That isn't your rune (${pct(result.score)} alike). ${tries} left.`, 'bad');
  } else if (result.status === 'accepted') {
    setStatus(result.enrolledNow ? 'Rune saved. Entering…' : `Rune accepted (${pct(result.score)} alike). Entering…`, 'good');
    finish(result.token);
  } else if (result.status === 'locked') {
    setStatus('Too many wrong runes. This sign-in will be refused.', 'bad');
    finish(result.token);
  }
}

const pct = (score) => `${Math.round(Math.max(0, score) * 100)}%`;

// Sends the signed result back to Auth0, which resumes the login.
function finish(token) {
  const action = `https://${auth0?.domain ?? 'your-tenant.auth0.com'}/continue?state=${encodeURIComponent(state)}`;
  if (dryRun || !auth0) {
    $('#rune-progress').textContent = `Test mode: would post rune_token to ${action}`;
    window.runeResult = { action, token };
    return;
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'rune_token', value: token }));
  document.body.append(form);
  setTimeout(() => form.submit(), 900);
}

function draw(now) {
  readHand(now);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0820';
  ctx.fillRect(0, 0, width, height);
  if (recognizer && video.readyState >= 2) {
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.35;
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }

  const line = (points, color, alpha) => {
    if (points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * width, y * height) : ctx.lineTo(x * width, y * height)));
    ctx.stroke();
    ctx.restore();
  };
  if (lastStroke) line(lastStroke.points, '#c084fc', Math.max(0, 1 - (now - lastStroke.at) / 2500));
  line(stroke, '#22d3ee', 1);

  if (cursor) {
    ctx.beginPath();
    ctx.arc(cursor.x * width, cursor.y * height, pinching ? 12 : 8, 0, Math.PI * 2);
    ctx.fillStyle = pinching ? '#22d3ee' : 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
  }
  requestAnimationFrame(draw);
}

boot();
