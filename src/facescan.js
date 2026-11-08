// Face login in the lobby. The camera scans the wizard's face, they say their name,
// and HexByte's server signs them in through Auth0 (server/face.js): a face it knows
// under that name signs in, and a face it has never seen joins the registry.
//
// No photo leaves this page: the server gets 128 numbers that describe the face.
// The small pixel portrait shown in the lobby stays in this browser tab.
import { answerFromSpeech, nameFromSpeech } from '../shared/names.js';
import { listenOnce, stopListening, voiceAvailable } from './voice.js';

const MODELS = '/models/face-api';
// The scan runs at least this long with a face in view, so people can watch it work.
const SCAN_MS = 2400;
// Face readings averaged into one steady description.
const SAMPLES = 8;
// A face narrower than this share of the picture is too far away to read well.
const MIN_FACE = 0.16;
// How long to wait for someone to start saying their name.
const LISTEN_MS = 5000;
// The matching animation stays up at least this long, so it can be seen.
const MATCHING_MS = 1100;

// The 68 face points, joined into the outline of a face.
const CONTOURS = [
  [0, 16, false], // jaw
  [17, 21, false], // brows
  [22, 26, false],
  [27, 30, false], // nose
  [31, 35, false],
  [36, 41, true], // eyes
  [42, 47, true],
  [48, 59, true], // mouth
  [60, 67, true],
];

const RESULTS = {
  recognized: { tone: 'match', stamp: 'MATCH', line: (name) => `Welcome back, ${name}.` },
  enrolled: { tone: 'new', stamp: 'NEW WIZARD', line: (name) => `${name} joined the wizard registry.` },
  wrong_face: { tone: 'denied', stamp: 'NOT SURE', line: (name) => `Not sure this is ${name}. Face the light and rescan.` },
  known_face: {
    tone: 'denied',
    stamp: 'KNOWN FACE',
    line: (name) => `This face is registered as ${name}. Say that name to sign in, or change it.`,
  },
  renamed: {
    tone: 'new',
    stamp: 'RENAMED',
    line: (name, result) => `You're ${name} now${result.previous && result.previous !== name ? ` (was ${result.previous})` : ''}.`,
  },
  no_match: {
    tone: 'denied',
    stamp: 'NO MATCH',
    line: () => "This face isn't in the registry yet. Say your name to join instead.",
  },
};

let faceapi = null;
async function loadFaceApi() {
  if (!faceapi) {
    const api = await import('@vladmandic/face-api');
    await api.tf.ready();
    await Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(MODELS),
      api.nets.faceLandmark68TinyNet.loadFromUri(MODELS),
      api.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    faceapi = api;
  }
  return faceapi;
}

const $ = (selector) => document.querySelector(selector);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lerp = (a, b, k) => a + (b - a) * k;

function average(samples) {
  return samples[0].map((_, i) => samples.reduce((sum, sample) => sum + sample[i], 0) / samples.length);
}

function cssColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    ink: read('--ink', '#000'),
    deep: read('--bg-deep', '#0a1020'),
    muted: read('--fg-muted', '#94a3b8'),
    scan: read('--gold', '#facc15'),
    match: read('--accent', '#22c55e'),
    check: read('--element-shield', '#38bdf8'),
    denied: read('--p1-text', '#f87171'),
    new: read('--gold', '#facc15'),
  };
}

let current = null;

// onSignedIn({ idToken, name, picture, ritualVerified, faceLogin }) runs after a match or a new sign-up.
// stream: an optional camera stream to use instead of asking for the camera (for tests).
// mode: 'login' signs in (or signs up); 'rename' changes the name on a face already signed up.
export function openFaceScan({ side, onSignedIn, stream, mode = 'login' } = {}) {
  current?.close();
  current = new FaceScan({ side, onSignedIn, stream, mode });
  current.open();
  return current;
}

class FaceScan {
  constructor({ side, onSignedIn, stream, mode }) {
    this.side = side;
    this.mode = mode === 'rename' ? 'rename' : 'login';
    this.onSignedIn = onSignedIn;
    this.givenStream = stream ?? null;
    this.el = {
      dialog: $('#face-scan'),
      title: $('#face-title'),
      video: $('#face-video'),
      canvas: $('#face-canvas'),
      stamp: $('#face-stamp'),
      status: $('#face-status'),
      form: $('#face-name'),
      input: $('#face-name-input'),
      say: $('#face-say'),
      rescan: $('#face-rescan'),
      rename: $('#face-rename'),
      submit: $('#face-submit'),
      cancel: $('#face-cancel'),
      confirm: $('#face-confirm'),
      question: $('#face-question'),
      yes: $('#face-yes'),
      no: $('#face-no'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    this.colors = cssColors();
    this.phase = 'loading';
    this.closed = false;
    this.listening = 0;
    this.resetScan();
    this.draw = this.draw.bind(this);
    this.cleanups = [];
  }

  resetScan() {
    this.samples = [];
    this.scanned = 0;
    this.descriptor = null;
    this.reading = null;
    this.result = null;
  }

  on(target, type, handler) {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  async open() {
    const { dialog, input, form, say, rescan, rename, cancel, stamp, confirm, yes, no } = this.el;
    this.showMode();
    confirm.hidden = true;
    rename.hidden = true;
    form.hidden = true;
    say.hidden = true;
    rescan.hidden = true;
    stamp.hidden = true;
    input.value = '';
    this.on(dialog, 'cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.on(cancel, 'click', () => this.close());
    this.on(say, 'click', () => {
      this.mode = 'login';
      this.showMode();
      this.askName();
    });
    this.on(rescan, 'click', () => this.rescan());
    // "That's my face, but not my name": rename it, keeping what they last said.
    this.on(rename, 'click', () => {
      this.mode = 'rename';
      this.showMode();
      this.askName('Say the name you want, or fix it in the box.', this.pendingName ?? '');
    });
    this.on(input, 'input', () => {
      // Typing takes over from the microphone.
      this.listening += 1;
      stopListening();
    });
    this.on(form, 'submit', (event) => {
      event.preventDefault();
      this.confirmName(nameFromSpeech(input.value));
    });
    this.on(yes, 'click', () => this.answer('yes'));
    this.on(no, 'click', () => this.answer('no'));
    if (!dialog.open) dialog.showModal();
    this.status('Waking up the face scanner…');
    this.raf = requestAnimationFrame(this.draw);

    try {
      const camera = this.givenStream
        ? Promise.resolve(this.givenStream)
        : navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      const [stream] = await Promise.all([camera, loadFaceApi()]);
      if (this.closed) {
        if (!this.givenStream) stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.el.video.srcObject = stream;
      await this.el.video.play();
    } catch (error) {
      if (this.closed) return;
      this.phase = 'error';
      this.status(
        error?.name === 'NotAllowedError'
          ? 'The camera is blocked. Allow it in the address bar, then try again.'
          : `The face scanner did not start: ${error?.message ?? error}`,
        'bad',
      );
      return;
    }
    this.phase = 'scanning';
    this.status('Look at the camera and hold still.');
    this.track();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.listening += 1;
    stopListening();
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach((cleanup) => cleanup());
    if (!this.givenStream) this.stream?.getTracks().forEach((track) => track.stop());
    this.el.video.srcObject = null;
    if (this.el.dialog.open) this.el.dialog.close();
    if (current === this) current = null;
  }

  status(text, tone = '') {
    this.el.status.textContent = text;
    this.el.status.dataset.tone = tone;
  }

  // Finds the face over and over, for as long as the window is open.
  async track() {
    const api = faceapi;
    const options = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    while (!this.closed) {
      let found = null;
      try {
        const face = api.detectSingleFace(this.el.video, options).withFaceLandmarks(true);
        // Only the scan needs the face description; afterwards the points are enough.
        found = this.phase === 'scanning' ? await face.withFaceDescriptor() : await face;
      } catch {
        found = null;
      }
      if (this.closed) return;
      this.seen(found);
      await wait(30);
    }
  }

  seen(found) {
    const width = this.el.video.videoWidth || 640;
    if (!found) {
      this.target = null;
      return;
    }
    const { box } = found.detection;
    // The picture is mirrored, like a mirror.
    this.target = { x: width - box.x - box.width, y: box.y, w: box.width, h: box.height };
    this.points = found.landmarks.positions.map((point) => ({ x: width - point.x, y: point.y }));
    const now = performance.now();
    const since = now - (this.seenAt ?? now);
    this.seenAt = now;
    if (this.phase === 'scanning' && found.descriptor && box.width / width >= MIN_FACE) {
      this.reading = found.descriptor;
      this.samples.push(Array.from(found.descriptor));
      if (this.samples.length > SAMPLES) this.samples.shift();
      // The scan moves on with each reading of the face, not with screen repaints,
      // so a slow screen can't stall it. A long gap counts for little.
      this.scanned += Math.min(since, 300);
      if (this.scanned >= SCAN_MS && this.samples.length >= 3) this.faceScanned();
    }
  }

  faceVisible(now) {
    return Boolean(this.target && now - this.seenAt < 500);
  }

  showMode() {
    const rename = this.mode === 'rename';
    this.el.title.textContent = `Player ${this.side + 1}: ${rename ? 'change your name' : 'face login'}`;
    this.el.submit.textContent = rename ? 'Rename' : 'Sign in';
  }

  faceScanned() {
    this.descriptor = average(this.samples);
    this.portrait = this.snapshot();
    this.flashAt = performance.now();
    this.askName(this.mode === 'rename' ? 'Face scanned. Say your new name, or type it.' : undefined);
  }

  rescan() {
    this.resetScan();
    this.listening += 1;
    stopListening();
    this.phase = 'scanning';
    this.el.confirm.hidden = true;
    this.el.form.hidden = true;
    this.el.say.hidden = true;
    this.el.rescan.hidden = true;
    this.el.rename.hidden = true;
    this.el.stamp.hidden = true;
    this.status('Look at the camera and hold still.');
  }

  async askName(note, typed = '') {
    const { form, input, say, rescan, stamp, confirm, rename } = this.el;
    this.listening += 1;
    stopListening();
    this.phase = 'name';
    stamp.hidden = true;
    confirm.hidden = true;
    rename.hidden = true;
    say.hidden = true;
    rescan.hidden = false;
    form.hidden = false;
    input.value = typed;
    if (!voiceAvailable) {
      this.status(note ?? 'Face scanned. Type your first name, or first and last.');
      input.focus();
      return;
    }
    this.status(note ?? 'Face scanned. Say your first name, or first and last.', 'listen');
    const turn = ++this.listening;
    const heard = await listenOnce({
      startMs: LISTEN_MS,
      onPartial: (text) => {
        if (turn === this.listening) input.value = nameFromSpeech(text) || text;
      },
    });
    if (turn !== this.listening || this.closed || this.phase !== 'name') return;
    const name = nameFromSpeech(heard);
    if (!name) {
      say.hidden = false;
      this.status("Didn't catch a name. Type it, or press Say name again.", 'bad');
      input.focus();
      return;
    }
    this.confirmName(name);
  }

  // "Are you sure Kareem is your name?" Speech can mishear a name (Kareem as "Korean"),
  // so nothing is sent until the wizard says or clicks yes.
  async confirmName(name) {
    if (this.closed || (this.phase !== 'name' && this.phase !== 'confirm')) return;
    if (!name) {
      this.status('Your name needs at least one letter.', 'bad');
      return;
    }
    const { form, say, confirm, question, yes } = this.el;
    this.phase = 'confirm';
    this.pendingName = name;
    form.hidden = true;
    say.hidden = true;
    const strong = (text) => Object.assign(document.createElement('strong'), { textContent: text });
    if (this.mode === 'rename') {
      question.replaceChildren(
        this.knownAs ? 'Change your name from ' : 'Change your name to ',
        ...(this.knownAs ? [strong(this.knownAs), ' to '] : []),
        strong(name),
        '?',
      );
    } else {
      question.replaceChildren('Are you sure ', strong(name), ' is your name?');
    }
    confirm.hidden = false;
    yes.focus();
    if (!voiceAvailable) {
      this.status('Click Yes or No.');
      return;
    }
    this.status('Say yes or no, or click.', 'listen');
    const turn = ++this.listening;
    const heard = await listenOnce({ startMs: 4000 });
    if (turn !== this.listening || this.closed || this.phase !== 'confirm') return;
    const reply = answerFromSpeech(heard);
    if (reply) this.answer(reply);
    else this.status('Click Yes or No.');
  }

  answer(reply) {
    if (this.phase !== 'confirm' || this.closed) return;
    this.listening += 1;
    stopListening();
    if (reply === 'yes') this.submit(this.pendingName);
    // Keep what was heard in the box, so a spelling can be fixed by typing.
    else this.askName('Okay. Say your name again, or fix it in the box.', this.pendingName);
  }

  async submit(name) {
    if (this.phase !== 'confirm' || this.closed) return;
    this.listening += 1;
    this.phase = 'checking';
    this.el.confirm.hidden = true;
    this.el.form.hidden = true;
    this.el.say.hidden = true;
    this.el.rescan.hidden = true;
    this.status(this.mode === 'rename' ? `Checking your face, then renaming you ${name}…` : `Searching the wizard registry for ${name}…`);
    const started = performance.now();
    let result;
    try {
      const response = await fetch(this.mode === 'rename' ? '/api/face/rename' : '/api/face/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, descriptor: this.descriptor.map((value) => Math.round(value * 1e5) / 1e5) }),
      });
      result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    } catch (error) {
      if (this.closed) return;
      this.phase = 'name';
      this.el.form.hidden = false;
      this.el.rescan.hidden = false;
      this.status(`Face login did not finish: ${error.message}`, 'bad');
      return;
    }
    await wait(Math.max(0, MATCHING_MS - (performance.now() - started)));
    if (!this.closed) this.finish(result);
  }

  finish(result) {
    if (result.status === 'no_name') return this.askName('Say or type a name with letters in it.');
    if (result.status === 'no_face') return this.rescan();
    const shown = RESULTS[result.status];
    if (!shown) {
      this.phase = 'name';
      this.el.form.hidden = false;
      this.status('Face login sent back something unexpected. Try again.', 'bad');
      return;
    }
    this.phase = 'done';
    this.result = result.status;
    this.resultTone = shown.tone;
    const { stamp, say, rescan, rename } = this.el;
    // The name this face is registered under, for "Change your name from Korean to Kareem?"
    if (result.status === 'known_face') this.knownAs = result.name;
    stamp.dataset.tone = shown.tone;
    stamp.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: shown.stamp }),
      Object.assign(document.createElement('span'), { textContent: result.name }),
    );
    stamp.hidden = false;
    this.status(shown.line(result.name, result), shown.tone === 'denied' ? 'bad' : 'good');

    if (result.idToken) {
      this.onSignedIn?.({
        idToken: result.idToken,
        name: result.name,
        picture: this.portrait,
        ritualVerified: false,
        faceLogin: true,
        login: result.login ?? null,
        // The power level this account left off at.
        power: Number.isFinite(result.power) ? result.power : null,
        // Duels, wins, losses, draws and logins, saved long term on the account.
        record: result.record ?? null,
      });
      setTimeout(() => this.close(), 1900);
      return;
    }
    say.hidden = false;
    rescan.hidden = false;
    rename.hidden = result.status !== 'known_face';
  }

  // A tiny pixel-art portrait for the lobby card. It never leaves this tab.
  snapshot() {
    const { video } = this.el;
    const box = this.box ?? this.target;
    if (!box || !video.videoWidth) return null;
    try {
      const size = Math.max(box.w, box.h) * 1.35;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h * 0.42;
      const tiny = Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
      const t = tiny.getContext('2d');
      // Mirrored, to match what the wizard saw.
      t.translate(16, 0);
      t.scale(-1, 1);
      t.drawImage(video, video.videoWidth - cx - size / 2, cy - size / 2, size, size, 0, 0, 16, 16);
      const big = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
      const b = big.getContext('2d');
      b.imageSmoothingEnabled = false;
      b.drawImage(tiny, 0, 0, 64, 64);
      return big.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  // ---------- The scan animation ----------

  draw(now) {
    if (this.closed) return;
    const { ctx, el, colors } = this;
    const { video, canvas } = el;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.fillStyle = colors.deep;
    ctx.fillRect(0, 0, w, h);
    if (video.readyState >= 2) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();
    }
    // A darker, old-monitor look so the scan stands out.
    ctx.fillStyle = 'rgba(10, 16, 32, 0.38)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);

    const visible = this.faceVisible(now);
    if (this.target) {
      this.box = this.box ? this.easeBox(this.box, this.target) : { ...this.target };
      if (!this.lockedAt || !visible) this.lockedAt = visible ? now : null;
    }

    if (this.phase === 'scanning') this.scanHint(visible, w);

    if (visible && this.box) this.drawFace(now);
    else if (this.phase !== 'loading' && this.phase !== 'error') this.drawGuide(now, w, h);
    else this.drawBoot(now, w, h);

    // A white flash the moment the face locks in.
    const flash = this.flashAt ? 1 - (now - this.flashAt) / 260 : 0;
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${flash * 0.55})`;
      ctx.fillRect(0, 0, w, h);
    }
    this.raf = requestAnimationFrame(this.draw);
  }

  easeBox(from, to) {
    return { x: lerp(from.x, to.x, 0.35), y: lerp(from.y, to.y, 0.35), w: lerp(from.w, to.w, 0.35), h: lerp(from.h, to.h, 0.35) };
  }

  scanHint(visible, width) {
    const tooFar = visible && this.target.w / width < MIN_FACE;
    const hint = !visible ? 'No face yet. Look at the camera.' : tooFar ? 'Come a little closer.' : 'Scanning. Hold still.';
    if (this.el.status.textContent !== hint) this.status(hint);
  }

  progress() {
    if (this.phase !== 'scanning') return 1;
    return Math.min(1, this.scanned / SCAN_MS);
  }

  tone(now) {
    const c = this.colors;
    if (this.phase === 'checking') return c.check;
    if (this.phase === 'done') return c[this.resultTone] ?? c.match;
    if (this.phase === 'name' || this.phase === 'confirm') return c.match;
    return c.scan;
  }

  frameBox() {
    const box = this.box;
    // The detector's box stops at the eyebrows; take in the forehead and chin too.
    return { x: box.x - box.w * 0.16, y: box.y - box.h * 0.32, w: box.w * 1.32, h: box.h * 1.46 };
  }

  drawFace(now) {
    const { ctx, colors } = this;
    const color = this.tone(now);
    const b = this.frameBox();
    const progress = this.progress();

    // A faint pixel grid over the face.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.16;
    for (let x = b.x + 7; x < b.x + b.w; x += 14) for (let y = b.y + 7; y < b.y + b.h; y += 14) ctx.fillRect(x, y, 2, 2);
    ctx.globalAlpha = 1;

    // The scan line sweeps the face: steady while scanning, fast while matching.
    const sweeping = this.phase === 'scanning' || this.phase === 'checking';
    let lineY = b.y + b.h;
    if (sweeping) {
      const period = this.phase === 'checking' ? 620 : 1300;
      const t = (now % period) / period;
      const down = t < 0.5;
      lineY = b.y + b.h * (down ? t * 2 : 2 - t * 2);
      const trail = 44;
      const gradient = ctx.createLinearGradient(0, lineY - (down ? trail : -trail), 0, lineY);
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(1, `${color}66`);
      ctx.fillStyle = gradient;
      ctx.fillRect(b.x, down ? lineY - trail : lineY, b.w, trail);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = color;
      ctx.fillRect(b.x - 6, lineY - 2, b.w + 12, 3);
      ctx.restore();
    }

    // Face points appear as the scan reaches them, then join into an outline.
    const reach = this.phase === 'scanning' ? b.y + b.h * Math.min(1, progress * 1.15) : Infinity;
    const shown = (point) => point.y <= reach;
    if (this.points?.length === 68) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.55;
      for (const [from, to, closed] of CONTOURS) {
        ctx.beginPath();
        let open = false;
        for (let i = from; i <= to; i += 1) {
          const point = this.points[i];
          if (!shown(point)) {
            open = false;
            continue;
          }
          if (open) ctx.lineTo(point.x, point.y);
          else ctx.moveTo(point.x, point.y);
          open = true;
        }
        if (closed && shown(this.points[from]) && shown(this.points[to])) ctx.lineTo(this.points[from].x, this.points[from].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const point of this.points) {
        if (!shown(point)) continue;
        ctx.fillStyle = colors.ink;
        ctx.fillRect(point.x - 3, point.y - 3, 6, 6);
        ctx.fillStyle = color;
        ctx.fillRect(point.x - 2, point.y - 2, 4, 4);
      }
    }

    this.drawBrackets(now, b, color);
    this.drawTag(b, color, progress);
    if (sweeping) this.drawReadout(now, b, color);
  }

  // Corner brackets snap in around the face when it's first found.
  drawBrackets(now, b, color) {
    const { ctx, colors } = this;
    const age = now - (this.lockedAt ?? now);
    const grow = 1 + 0.6 * Math.max(0, 1 - age / 280);
    const pulse = this.phase === 'checking' ? 1 + 0.04 * Math.sin(now / 70) : 1;
    const scale = grow * pulse;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const hw = (b.w / 2) * scale;
    const hh = (b.h / 2) * scale;
    const arm = Math.min(b.w, b.h) * 0.22;
    const corners = [
      [cx - hw, cy - hh, 1, 1],
      [cx + hw, cy - hh, -1, 1],
      [cx - hw, cy + hh, 1, -1],
      [cx + hw, cy + hh, -1, -1],
    ];
    ctx.lineCap = 'square';
    for (const [width, stroke] of [
      [11, colors.ink],
      [6, color],
    ]) {
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      for (const [x, y, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(x, y + dy * arm);
        ctx.lineTo(x, y);
        ctx.lineTo(x + dx * arm, y);
        ctx.stroke();
      }
    }
  }

  drawTag(b, color, progress) {
    const { ctx, colors } = this;
    const labels = {
      scanning: `SCANNING ${Math.floor(progress * 100)}%`,
      name: 'FACE LOCKED',
      confirm: 'FACE LOCKED',
      checking: 'MATCHING…',
      done: { match: 'MATCH', new: 'NEW WIZARD', denied: 'NO ENTRY' }[this.resultTone] ?? '',
    };
    const text = labels[this.phase];
    if (!text) return;
    ctx.font = '12px "Press Start 2P", monospace';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(text).width + 16;
    const x = Math.max(4, Math.min(this.el.canvas.width - width - 4, b.x));
    const y = Math.max(4, b.y - 36);
    ctx.fillStyle = colors.ink;
    ctx.fillRect(x, y, width, 26);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 8, y + 14);

    if (this.phase !== 'scanning') return;
    // The progress bar under the face.
    const barY = Math.min(this.el.canvas.height - 18, b.y + b.h + 12);
    ctx.fillStyle = colors.ink;
    ctx.fillRect(b.x - 2, barY - 2, b.w + 4, 14);
    ctx.fillStyle = color;
    ctx.fillRect(b.x, barY, b.w * progress, 10);
  }

  // The face's numbers scrolling beside it.
  drawReadout(now, b, color) {
    const { ctx } = this;
    const values = this.reading ?? this.descriptor;
    if (!values?.length) return;
    const lines = 7;
    const start = Math.floor(now / 90);
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textBaseline = 'top';
    const width = ctx.measureText('00 00 00 00').width;
    const right = b.x + b.w + 16;
    const x = right + width < this.el.canvas.width - 4 ? right : Math.max(4, b.x - width - 16);
    ctx.fillStyle = color;
    for (let row = 0; row < lines; row += 1) {
      const bytes = [];
      for (let k = 0; k < 4; k += 1) {
        const value = values[((start + row) * 4 + k) % values.length];
        const byte = Math.max(0, Math.min(255, Math.round(((value + 0.25) / 0.5) * 255)));
        bytes.push(byte.toString(16).padStart(2, '0').toUpperCase());
      }
      ctx.globalAlpha = 0.35 + (0.55 * (row + 1)) / lines;
      ctx.fillText(bytes.join(' '), x, b.y + row * 16);
    }
    ctx.globalAlpha = 1;
  }

  // No face in view: an outline showing where to put it.
  drawGuide(now, w, h) {
    const { ctx, colors } = this;
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 10]);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.47, h * 0.24, h * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawBoot(now, w, h) {
    const { ctx, colors } = this;
    ctx.font = '14px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.phase === 'error' ? colors.denied : colors.scan;
    const dots = '.'.repeat(1 + (Math.floor(now / 300) % 3));
    ctx.fillText(this.phase === 'error' ? 'SCANNER OFFLINE' : `LOADING${dots}`, w / 2, h / 2);
    ctx.textAlign = 'start';
  }
}
