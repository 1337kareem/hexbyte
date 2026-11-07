// All of HexByte's sound is made live with the Web Audio API, so there are no
// audio files to download or license.
//
// Music: an original loop in D minor (Dm, Bb, Gm, A) with a harp-like arpeggio,
// a soft heartbeat drum, and a quiet son clave woodblock for a Miami touch. It
// gets busier as the duel heats up and plays a double heartbeat when someone is
// low on HP.
//
// Effects: fire, lightning, shields, hits, blocks, backfires and more. Each one is
// panned toward the player it belongs to, and fireballs travel across the stereo field.
export const MUSIC_VOLUME = 0.12;
export const SFX_VOLUME = 1;
export const BPM = 84;
export const STEP = 60 / BPM / 4; // one sixteenth note, in seconds
const LOOKAHEAD = 0.12;
const PREFS_KEY = 'hexbyte.sound';

// Two bars per chord, so the progression loops every eight bars (about 23 seconds).
export const CHORDS = [
  { name: 'Dm', bass: 38, tones: [62, 65, 69] },
  { name: 'Bb', bass: 34, tones: [62, 65, 70] },
  { name: 'Gm', bass: 31, tones: [62, 67, 70] },
  { name: 'A', bass: 33, tones: [61, 64, 69] },
];
// 3-2 son clave across two bars of sixteenth notes.
export const CLAVE_STEPS = [0, 6, 12, 20, 24];

export const midi = (note) => 440 * 2 ** ((note - 69) / 12);
export const chordAt = (step) => CHORDS[Math.floor(step / 32) % CHORDS.length];

// Which sixteenth notes of a bar get an arpeggio note, by intensity (0 to 1).
export function arpSteps(intensity) {
  if (intensity < 0.3) return [0, 6, 11];
  if (intensity < 0.65) return [0, 3, 6, 8, 11, 14];
  return [0, 2, 4, 6, 8, 10, 12, 14, 15];
}

const sidePan = (side) => (side === 0 ? -0.6 : 0.6);

// Fades a volume to a new level. Clearing older changes first matters: Chrome can
// keep applying an earlier setTargetAtTime, which left muted effects at full volume.
function fadeTo(param, value, ctx, seconds = 0.08) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + seconds);
}

function loadPrefs() {
  try {
    return { music: true, effects: true, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
  } catch {
    return { music: true, effects: true };
  }
}

export class Sound {
  constructor() {
    this.prefs = loadPrefs();
    this.ctx = null;
    this.intensity = 0;
    this.target = 0;
    this.tension = false;
    this.mood = 'calm';
    this.playing = false;
    this.ducked = false;
  }

  // For tests: an engine that renders into the given context (for example an OfflineAudioContext).
  static forContext(ctx) {
    const sound = new Sound();
    sound.prefs = { music: true, effects: true };
    sound.build(ctx);
    return sound;
  }

  // Browsers only allow sound after a click or key press, so call this from one.
  unlock() {
    if (typeof AudioContext === 'undefined') return;
    if (!this.ctx) this.build(new AudioContext());
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  build(ctx) {
    this.ctx = ctx;
    // A safety limiter: normal sounds pass untouched, and only pile-ups get squeezed.
    this.master = ctx.createDynamicsCompressor();
    this.master.threshold.value = -6;
    this.master.knee.value = 6;
    this.master.ratio.value = 8;
    this.master.attack.value = 0.003;
    this.master.release.value = 0.25;
    this.master.connect(ctx.destination);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.prefs.music ? MUSIC_VOLUME : 0;
    this.musicGain.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 1400;
    this.musicFilter.connect(this.musicGain);

    // An echo for the arpeggio, which makes it sound like a harp in a big hall.
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = STEP * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400;
    this.echo.connect(tone);
    tone.connect(feedback);
    feedback.connect(this.echo);
    tone.connect(this.musicFilter);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.prefs.effects ? SFX_VOLUME : 0;
    this.sfxGain.connect(this.master);

    const length = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  // ---------- Settings ----------

  setMusic(on) {
    this.prefs.music = on;
    this.savePrefs();
    this.applyMusicLevel();
  }

  setEffects(on) {
    this.prefs.effects = on;
    this.savePrefs();
    if (this.ctx) fadeTo(this.sfxGain.gain, on ? SFX_VOLUME : 0, this.ctx);
  }

  get muted() {
    return !this.prefs.music && !this.prefs.effects;
  }

  // The M key: mute everything, or turn everything back on.
  toggleMute() {
    const on = this.muted;
    this.setMusic(on);
    this.setEffects(on);
  }

  savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Private windows can refuse storage. The setting still works for this visit.
    }
  }

  // Quieter music while a player speaks, so the microphone hears the incantation.
  duck(on) {
    this.ducked = on;
    this.applyMusicLevel();
  }

  applyMusicLevel() {
    if (!this.ctx) return;
    const level = this.prefs.music ? MUSIC_VOLUME * (this.ducked ? 0.3 : 1) : 0;
    fadeTo(this.musicGain.gain, level, this.ctx, 0.3);
  }

  // ---------- Music ----------

  startMusic(mood = 'duel') {
    this.mood = mood;
    if (!this.ctx) return;
    this.applyMusicLevel();
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.next = this.ctx.currentTime + 0.1;
    this.lastTick = this.ctx.currentTime;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  calm() {
    this.mood = 'calm';
    this.target = 0;
    this.tension = false;
  }

  stopMusic() {
    if (!this.ctx || !this.playing) return;
    fadeTo(this.musicGain.gain, 0, this.ctx, 1.2);
    // Stop scheduling after the fade, so the last notes ring out softly.
    const timer = this.timer;
    setTimeout(() => clearInterval(timer), 1200);
    this.playing = false;
  }

  // Raises the music's intensity for a moment. It settles back down on its own.
  bump(amount) {
    this.target = Math.min(1, this.target + amount);
  }

  setTension(on) {
    this.tension = on;
  }

  schedule() {
    const now = this.ctx.currentTime;
    // After the tab was in the background, skip the missed notes instead of bunching them up.
    if (now - this.next > 0.3) this.next = now + 0.05;

    const elapsed = now - this.lastTick;
    this.lastTick = now;
    this.target = Math.max(this.mood === 'duel' ? 0.15 : 0, this.target - 0.05 * elapsed);
    this.intensity += (this.target - this.intensity) * Math.min(1, elapsed * 2);
    this.musicFilter.frequency.setTargetAtTime(700 + 3300 * this.intensity, now, 0.4);

    while (this.next < now + LOOKAHEAD) {
      this.playStep(this.step, this.next);
      this.next += STEP;
      this.step += 1;
    }
  }

  playStep(step, time) {
    const chord = chordAt(step);
    const beat = step % 16;
    const intensity = this.mood === 'calm' ? Math.min(this.intensity, 0.2) : this.intensity;

    if (step % 32 === 0) this.pad(chord, time, STEP * 32);
    if (beat === 0 || (beat === 10 && intensity > 0.5)) this.bass(chord.bass, time);

    const arp = arpSteps(intensity);
    const index = arp.indexOf(beat);
    if (index !== -1) {
      const octave = index % 4 === 3 ? 24 : 12;
      this.pluck(chord.tones[(index + Math.floor(step / 16)) % 3] + octave, time);
    }

    if (this.mood === 'duel') {
      const heartbeat = this.tension ? [0, 2, 8, 10] : intensity > 0.35 ? [0, 8] : [0];
      if (heartbeat.includes(beat)) this.kick(time, beat % 8 === 2 ? 0.6 : 1);
      if (intensity > 0.35 && CLAVE_STEPS.includes(step % 32)) this.woodblock(time);
      if (intensity > 0.7 && beat % 2 === 1) this.shaker(time);
    }
  }

  pad(chord, time, length) {
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.05, time + 1.2);
    gain.gain.setValueAtTime(0.05, time + length - 1.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + length + 0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.connect(gain);
    gain.connect(this.musicFilter);
    for (const note of chord.tones) {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midi(note - 12);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(time);
        osc.stop(time + length + 0.4);
      }
    }
  }

  bass(note, time) {
    const gain = this.envelope(this.musicFilter, time, 0.01, 0.22, 1.1);
    this.oscillator('triangle', midi(note + 12), time, time + 1.2, gain);
    this.oscillator('sine', midi(note), time, time + 1.2, gain);
  }

  pluck(note, time) {
    const gain = this.envelope(this.musicFilter, time, 0.005, 0.08, 0.6);
    gain.connect(this.echo);
    this.oscillator('triangle', midi(note), time, time + 0.7, gain);
  }

  kick(time, level) {
    const gain = this.envelope(this.musicGain, time, 0.004, 0.4 * level, 0.25);
    const osc = this.oscillator('sine', 95, time, time + 0.3, gain);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.18);
  }

  woodblock(time) {
    const gain = this.envelope(this.musicFilter, time, 0.002, 0.07, 0.06);
    this.oscillator('sine', 1650, time, time + 0.08, gain);
    this.oscillator('triangle', 1100, time, time + 0.08, gain);
  }

  shaker(time) {
    const gain = this.envelope(this.musicGain, time, 0.003, 0.025, 0.04);
    this.noiseBurst(time, 0.06, this.filterNode('highpass', 6500, 0.7, gain));
  }

  // ---------- Building blocks ----------

  envelope(destination, start, attack, peak, decay) {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    gain.connect(destination);
    return gain;
  }

  oscillator(type, frequency, start, stop, destination) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    osc.connect(destination);
    osc.start(start);
    osc.stop(stop);
    return osc;
  }

  filterNode(type, frequency, q, destination) {
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    filter.connect(destination);
    return filter;
  }

  noiseBurst(start, duration, destination) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.connect(destination);
    source.start(start, Math.random() * 1.5, duration);
    return source;
  }

  panner(pan) {
    const node = this.ctx.createStereoPanner();
    node.pan.value = pan;
    node.connect(this.sfxGain);
    return node;
  }

  // Effects only play once sound is unlocked and effects are on.
  ready() {
    return Boolean(this.ctx && this.prefs.effects);
  }

  // ---------- Effects ----------

  // A rising shimmer when a player starts channeling a spell.
  channel(side, element) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const base = { fire: 220, shield: 330, lightning: 440 }[element] ?? 300;
    const osc = this.oscillator('triangle', base, t, t + 0.9, this.envelope(out, t, 0.25, 0.2, 0.6));
    osc.frequency.exponentialRampToValueAtTime(base * 2, t + 0.8);
    [0, 0.12, 0.24].forEach((delay, i) => {
      const s = t + delay;
      this.oscillator('sine', base * 4 * (1 + i * 0.25), s, s + 0.3, this.envelope(out, s, 0.005, 0.1, 0.25));
    });
  }

  // A whoosh that travels from the caster to the opponent with the fireball.
  fire(side, power = 5) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.ctx.createStereoPanner();
    out.pan.setValueAtTime(sidePan(side), t);
    out.pan.linearRampToValueAtTime(sidePan(1 - side), t + 0.7);
    out.connect(this.sfxGain);
    const band = this.filterNode('bandpass', 400, 1.4, this.envelope(out, t, 0.15, 1 + power * 0.06, 0.55));
    band.frequency.setValueAtTime(400, t);
    band.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    band.frequency.exponentialRampToValueAtTime(900, t + 0.7);
    this.noiseBurst(t, 0.75, band);
    this.oscillator('sawtooth', 70, t, t + 0.7, this.filterNode('lowpass', 300, 1, this.envelope(out, t, 0.05, 0.14, 0.6)));
  }

  // The fireball landing: a boom, louder for bigger hits.
  fireImpact(side, damage) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const level = 0.5 + Math.min(1, damage / 26) * 0.5;
    const boom = this.oscillator('sine', 140, t, t + 0.5, this.envelope(out, t, 0.005, 0.9 * level, 0.45));
    boom.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    const rumble = this.filterNode('lowpass', 1200, 0.7, this.envelope(out, t, 0.005, 0.6 * level, 0.35));
    rumble.frequency.exponentialRampToValueAtTime(200, t + 0.35);
    this.noiseBurst(t, 0.4, rumble);
  }

  // A crackling strike on the target, then thunder rolling across both speakers.
  lightning(side) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side) * 0.7);
    const crackle = this.filterNode('highpass', 2500, 0.7, out);
    for (let i = 0; i < 9; i += 1) {
      const s = t + i * 0.025 + Math.random() * 0.015;
      this.noiseBurst(s, 0.06, this.envelope(crackle, s, 0.002, 0.9 * (1 - i / 12), 0.04));
    }
    const zap = this.oscillator('square', 1800, t, t + 0.2, this.filterNode('lowpass', 4000, 0.7, this.envelope(out, t, 0.003, 0.2, 0.16)));
    zap.frequency.exponentialRampToValueAtTime(150, t + 0.18);
    const thunder = this.panner(sidePan(side) * 0.3);
    this.noiseBurst(t + 0.12, 2, this.filterNode('lowpass', 250, 0.8, this.envelope(thunder, t + 0.12, 0.08, 1.4, 1.8)));
  }

  // A bright chime and a soft whoom as a shield goes up.
  shieldUp(side) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    [81, 85, 88, 93].forEach((note, i) => {
      const s = t + i * 0.06;
      this.oscillator('triangle', midi(note), s, s + 1, this.envelope(out, s, 0.01, 0.22, 0.9));
      this.oscillator('sine', midi(note) * 2.01, s, s + 0.7, this.envelope(out, s, 0.01, 0.04, 0.6));
    });
    const whoom = this.filterNode('lowpass', 200, 2, this.envelope(out, t, 0.2, 0.25, 0.5));
    whoom.frequency.exponentialRampToValueAtTime(1500, t + 0.5);
    this.noiseBurst(t, 0.75, whoom);
  }

  // A metallic clang when a shield absorbs damage.
  blocked(side, absorbed) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const level = Math.min(1, 0.4 + absorbed / 30);
    for (const [frequency, decay] of [[520, 0.6], [1310, 0.4], [2230, 0.25], [3150, 0.15]]) {
      this.oscillator('sine', frequency, t, t + decay + 0.05, this.envelope(out, t, 0.002, 0.35 * level, decay));
    }
  }

  // A thud when a player takes damage, heavier for bigger hits.
  hurt(side, dealt) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + 0.03;
    const out = this.panner(sidePan(side));
    const level = Math.min(1, 0.35 + dealt / 30);
    const thud = this.oscillator('square', 180, t, t + 0.22, this.filterNode('lowpass', 900, 1, this.envelope(out, t, 0.003, 0.7 * level, 0.18)));
    thud.frequency.exponentialRampToValueAtTime(60, t + 0.18);
    this.noiseBurst(t, 0.1, this.filterNode('bandpass', 1800, 1.5, this.envelope(out, t, 0.002, 0.25 * level, 0.08)));
  }

  // A cheat blew up in the caster's face: a sad "wah-wah" and a pop.
  backfire(side) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const wah = this.filterNode('lowpass', 1800, 4, this.envelope(out, t, 0.01, 0.5, 0.7));
    wah.frequency.setValueAtTime(1800, t);
    wah.frequency.linearRampToValueAtTime(400, t + 0.15);
    wah.frequency.linearRampToValueAtTime(1600, t + 0.3);
    wah.frequency.linearRampToValueAtTime(300, t + 0.7);
    const buzz = this.oscillator('sawtooth', 440, t, t + 0.75, wah);
    buzz.frequency.exponentialRampToValueAtTime(70, t + 0.7);
    this.noiseBurst(t, 0.2, this.filterNode('lowpass', 2500, 0.8, this.envelope(out, t, 0.002, 0.7, 0.15)));
  }

  // Out of mana: a tone that fizzles away.
  outOfMana(side) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const tone = this.oscillator('sine', 900, t, t + 0.65, this.envelope(out, t, 0.01, 0.4, 0.6));
    tone.frequency.exponentialRampToValueAtTime(160, t + 0.6);
    this.noiseBurst(t, 0.6, this.filterNode('highpass', 4000, 0.7, this.envelope(out, t, 0.05, 0.08, 0.5)));
  }

  // A spell that failed for a technical reason: a dull thunk.
  fizzle(side) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(sidePan(side));
    const thunk = this.oscillator('sine', 160, t, t + 0.25, this.envelope(out, t, 0.004, 0.45, 0.2));
    thunk.frequency.exponentialRampToValueAtTime(80, t + 0.2);
  }

  // The last ten seconds of the clock.
  tick() {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.oscillator('sine', 1700, t, t + 0.06, this.envelope(this.panner(0), t, 0.002, 0.35, 0.05));
  }

  // The duel is over: a gong for a knockout, then a fanfare or a shrug for a draw.
  finish({ knockout, draw }) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const out = this.panner(0);
    const strength = knockout ? 1 : 0.6;
    for (const [frequency, decay, peak] of [[98, 3.2, 0.5], [147.5, 2.6, 0.3], [233, 2, 0.2], [311, 1.5, 0.12], [415, 1.2, 0.08]]) {
      this.oscillator('sine', frequency, t, t + decay, this.envelope(out, t, 0.004, peak * strength, decay));
    }
    if (knockout) this.noiseBurst(t, 1.5, this.filterNode('highpass', 3000, 0.5, this.envelope(out, t, 0.003, 0.4, 1.4)));
    const notes = draw ? [62, 61] : [62, 66, 69, 74];
    notes.forEach((note, i) => {
      const s = t + 0.9 + i * 0.13;
      this.oscillator('triangle', midi(note), s, s + 1.3, this.envelope(out, s, 0.01, 0.18, 1.2));
      this.oscillator('sine', midi(note + 12), s, s + 0.8, this.envelope(out, s, 0.01, 0.05, 0.7));
    });
  }
}
