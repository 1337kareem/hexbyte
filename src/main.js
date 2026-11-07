import './styles.css';
import { ELEMENT_ICONS, GESTURE_ELEMENTS } from '../shared/rules.js';
import { Sound } from './audio.js';
import { forgetWizard, initAuth, savedWizards, signIn } from './auth.js';
import { Duel } from './duel.js';
import { COLORS, Renderer } from './render.js';
import { Vision } from './vision.js';
import { listenOnce, voiceAvailable } from './voice.js';

const $ = (selector) => document.querySelector(selector);
const screens = { title: $('#title'), duel: $('#duel'), results: $('#results') };
const video = $('#video');
const renderer = new Renderer($('#canvas'), video);
const sound = new Sound();

const KEYS = {
  1: [0, 'Closed_Fist'],
  2: [0, 'Open_Palm'],
  3: [0, 'Victory'],
  8: [1, 'Closed_Fist'],
  9: [1, 'Open_Palm'],
  0: [1, 'Victory'],
};
const FRAME_EVERY_MS = 100;
const FLUSH_EVERY_MS = 2000;
const TYPE_SECONDS = 8;

let config = { auth0: null };
let health = null;
let vision = null;
let duel = null;
let mode = 'camera';
let lastMatch = null;
let lastResult = null;
let frames = [];
let lastFrameAt = 0;
let flushTimer = null;
let replay = null;
let listening = 0;
let lastTickSecond = null;
// The server signs each match into a token, and every request about the match carries it.
let matchToken = null;
// The browser's own copy of the duel, so the replay works even if the server lost its copy.
let recording = { matchId: null, frames: [], spells: [] };
const MAX_RECORDED_FRAMES = 6000;

async function api(path, body) {
  const options =
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function show(name) {
  for (const [key, element] of Object.entries(screens)) element.hidden = key !== name;
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- Lobby ----------

function renderSlots() {
  const wizards = savedWizards();
  document.querySelectorAll('.slot').forEach((slot) => {
    const side = Number(slot.dataset.side);
    const wizard = wizards[side];
    slot.style.setProperty('--player', COLORS[side]);
    slot.replaceChildren(element('h2', { textContent: `Player ${side + 1} · ${side === 0 ? 'left' : 'right'}` }));

    if (wizard) {
      const avatar = wizard.picture
        ? element('img', { src: wizard.picture, alt: '', referrerPolicy: 'no-referrer', className: 'avatar' })
        : element('div', { className: 'avatar', textContent: wizard.name.slice(0, 1).toUpperCase() });
      const forget = element('button', { textContent: 'Sign out', className: 'link' });
      forget.addEventListener('click', () => {
        forgetWizard(side);
        renderSlots();
      });
      slot.append(
        element('div', { className: 'wizard' }, [
          avatar,
          element('div', {}, [
            element('strong', { textContent: wizard.name }),
            element('span', {
              className: 'badge',
              textContent: wizard.runeVerified ? 'Auth0 + Rune Gate · 7 mana' : 'Signed in with Auth0 · 6 mana',
            }),
          ]),
        ]),
        forget,
      );
      return;
    }

    const input = element('input', {
      id: `name-${side}`,
      placeholder: `Wizard ${side + 1}`,
      maxLength: 24,
      autocomplete: 'off',
    });
    slot.append(element('label', { htmlFor: input.id, textContent: 'Guest name · 5 mana' }), input);
    if (config.auth0) {
      const button = element('button', { textContent: 'Sign in with Auth0', className: 'auth' });
      button.addEventListener('click', () => signIn(side));
      slot.append(button, element('p', { className: 'hint', textContent: 'Signed-in wizards get more mana. Draw your rune to get the most.' }));
    }
  });
}

function renderSponsors() {
  if (!health) {
    $('#sponsors').textContent = 'The server is not responding.';
    return;
  }
  const parts = [
    health.prune ? `Prune: on (${health.model})` : 'Prune: off, add PRUNE_API_KEY to .env',
    `Storage: ${health.store}`,
    health.auth0 ? `Auth0: on${health.runeGate ? ' with Rune Gate' : ''}` : 'Auth0: off, players join as guests',
    voiceAvailable ? 'Voice: on' : 'Voice: not in this browser (incantations are automatic)',
  ];
  $('#sponsors').textContent = parts.join('  ·  ');
}

async function loadStats() {
  const box = $('#stats');
  try {
    const stats = await api('/api/stats');
    const cards = [
      ['Duels', stats.matches],
      ['Spells cast', stats.spells],
      ['Cheats blocked', stats.cheatsBlocked],
      ['Average spell wait', stats.avgLatencyMs ? `${(stats.avgLatencyMs / 1000).toFixed(1)} s` : '–'],
      ...stats.byElement.map((e) => [
        `${ELEMENT_ICONS[e.element]} ${e.element}`,
        e.spells ? `${e.spells} · power ${Number(e.avgPower).toFixed(1)}` : '0',
      ]),
    ];
    if (stats.compression) {
      const saved = 100 - (stats.compression.after / stats.compression.before) * 100;
      cards.push(['Body data compressed', `${saved.toFixed(0)}% smaller`]);
    }
    box.replaceChildren(
      element('h2', { textContent: `Season stats · from ${stats.source}${stats.fromAggregate ? ' (continuous aggregate)' : ''}` }),
      element(
        'div',
        { className: 'cards' },
        cards.map(([label, value]) => element('div', { className: 'card' }, [element('span', { textContent: label }), element('strong', { textContent: String(value) })])),
      ),
      stats.topSpell
        ? element('p', {
            className: 'top-spell',
            textContent: `Strongest spell: “${stats.topSpell.name}” by ${stats.topSpell.player} (power ${stats.topSpell.power})`,
          })
        : '',
    );
  } catch (error) {
    box.textContent = `Stats are unavailable: ${error.message}`;
  }
}

// ---------- Duel ----------

async function startDuel(players) {
  $('#notice').textContent = '';
  mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'keyboard';
  let match;
  try {
    match = await api('/api/match', { players });
  } catch (error) {
    $('#notice').textContent = `Could not start the duel: ${error.message}`;
    show('title');
    return;
  }
  lastMatch = { players };
  show('duel');
  $('#log').replaceChildren();
  $('#stage-status').textContent = '';
  replay = null;

  if (mode === 'camera') {
    try {
      vision ??= new Vision({ video, onGesture: (side, gesture) => duel?.trigger(side, gesture) });
      if (!vision.running) await vision.start((text) => ($('#stage-status').textContent = text));
      $('#stage-status').textContent = '';
    } catch (error) {
      mode = 'keyboard';
      $('#stage-status').textContent = `Camera unavailable (${error.message}). Using the keyboard instead.`;
    }
  }

  matchToken = match.matchToken;
  recording = { matchId: match.matchId, frames: [], spells: [] };
  duel = new Duel({
    match,
    listen,
    cast: (body) => api('/api/spell', { ...body, matchToken }),
    onLog: addLog,
    onEnd: endDuel,
    onEvent: playDuelSound,
  });
  listening = 0;
  lastTickSecond = null;
  sound.setTension(false);
  sound.startMusic('duel');
  frames = [];
  clearInterval(flushTimer);
  flushTimer = setInterval(flushFrames, FLUSH_EVERY_MS);
}

// Every sound the duel makes, matched to what just happened on screen.
function playDuelSound(name, details) {
  const { side } = details;
  if (name === 'listening') {
    listening += 1;
    if (mode === 'camera') sound.duck(true);
  } else if (name === 'listened') {
    listening = Math.max(0, listening - 1);
    if (listening === 0) sound.duck(false);
  } else if (name === 'channel') {
    sound.channel(side, details.element);
    sound.bump(0.12);
  } else if (name === 'cast') {
    if (details.element === 'fire') sound.fire(side, details.power);
    else if (details.element === 'lightning') sound.lightning(1 - side);
    else sound.shieldUp(side);
    sound.bump(0.2);
  } else if (name === 'hit') {
    if (details.element === 'fire') sound.fireImpact(side, details.dealt + details.absorbed);
    if (details.absorbed > 0) sound.blocked(side, details.absorbed);
    if (details.dealt > 0) sound.hurt(side, details.dealt);
    sound.bump(0.15);
    updateTension();
  } else if (name === 'backfire') {
    sound.backfire(side);
    sound.bump(0.15);
    updateTension();
  } else if (name === 'outOfMana') {
    sound.outOfMana(side);
  } else if (name === 'fizzle') {
    sound.fizzle(side);
  } else if (name === 'end') {
    sound.finish({ knockout: details.knockout, draw: details.winner === -1 });
    sound.duck(false);
    sound.calm();
  }
}

// A double heartbeat joins the music when either wizard is close to losing.
function updateTension() {
  sound.setTension(Boolean(duel && !duel.over && duel.players.some((player) => player.hp > 0 && player.hp <= 30)));
}

function listen(side, element) {
  if (mode === 'camera') return voiceAvailable ? listenOnce({ timeoutMs: 3500 }) : Promise.resolve(null);
  return typedIncantation(side, element);
}

function typedIncantation(side, elementName) {
  const form = document.querySelector(`.say[data-side="${side}"]`);
  const input = form.querySelector('input');
  const label = form.querySelector('label');
  return new Promise((resolve) => {
    let seconds = TYPE_SECONDS;
    const update = () => {
      label.textContent = `Player ${side + 1} ${ELEMENT_ICONS[elementName]} type your incantation, then Enter (${seconds}s)`;
    };
    const done = (value) => {
      clearInterval(timer);
      // Blur first: a hidden box that keeps focus would swallow the next key presses.
      input.blur();
      form.hidden = true;
      form.onsubmit = null;
      input.onkeydown = null;
      resolve(value?.trim() || null);
    };
    const timer = setInterval(() => {
      seconds -= 1;
      update();
      if (seconds <= 0) done(input.value);
    }, 1000);
    update();
    input.value = '';
    form.hidden = false;
    input.focus();
    form.onsubmit = (event) => {
      event.preventDefault();
      done(input.value);
    };
    input.onkeydown = (event) => {
      if (event.key === 'Escape') done(null);
    };
  });
}

function addLog(entry) {
  if (entry.outcome === 'cast' || entry.outcome === 'cheat') {
    const { side, element, outcome, power, damage, name } = entry;
    recording.spells.push({ t: Date.now(), side, element, outcome, power, damage, name });
  }
  const icon = ELEMENT_ICONS[entry.element] ?? '•';
  const item = element('li', { className: `entry side-${entry.side} ${entry.outcome}` });
  const head = element('div', { className: 'entry-head' }, [
    element('span', { className: 'who', textContent: `${icon} ${entry.player}` }),
    element('span', { className: 'wait', textContent: entry.latencyMs ? `${(entry.latencyMs / 1000).toFixed(1)} s` : '' }),
  ]);
  item.append(head, element('q', { textContent: `${entry.words}${entry.auto ? ' (auto)' : ''}` }));

  if (entry.outcome === 'cast') {
    const detail =
      entry.element === 'shield' ? `+${entry.shield} shield` : `${entry.damage} damage${entry.pierce ? ', pierces shields' : ''}`;
    item.append(
      element('p', { className: 'result', textContent: `${entry.name} · power ${entry.power} · ${detail}` }),
      element('p', {
        className: 'cost',
        textContent: `Cost $${Number(entry.costUsd ?? 0).toFixed(6)}${entry.effectText ? ` · ${entry.effectText}` : ''}`,
      }),
    );
    if (entry.receipt) item.append(receiptButtons(entry.receipt));
  } else if (entry.outcome === 'cheat') {
    item.append(element('p', { className: 'result', textContent: 'Blocked by Prune (prompt_injection). The spell backfired.' }));
  } else if (entry.outcome === 'out_of_mana') {
    item.append(element('p', { className: 'result', textContent: `Blocked by Prune (${entry.blockedBy}). Out of mana.` }));
  } else {
    item.append(element('p', { className: 'result', textContent: `Fizzled: ${entry.error ?? entry.blockedBy ?? 'unknown error'}` }));
  }
  $('#log').prepend(item);
}

// The receipt stays in the browser exactly as Prune signed it. Prune checks the signature.
function receiptButtons(receipt) {
  const result = element('span', { className: 'verdict' });
  const verify = element('button', { textContent: 'Verify receipt', className: 'small' });
  const tamper = element('button', { textContent: 'Tamper test', className: 'small' });
  const run = async (tampered) => {
    result.textContent = 'Checking with Prune…';
    result.className = 'verdict';
    try {
      const answer = await api('/api/verify', { receipt, tamper: tampered });
      result.textContent = answer.valid
        ? `✓ Genuine. Signed by Prune key ${answer.keyId}`
        : `✗ Rejected (${answer.reason})${tampered ? ': we changed the cost, so the signature no longer matches' : ''}`;
      result.className = `verdict ${answer.valid ? 'good' : 'bad'}`;
    } catch (error) {
      result.textContent = error.message;
    }
  };
  verify.addEventListener('click', () => run(false));
  tamper.addEventListener('click', () => run(true));
  return element('div', { className: 'receipt' }, [verify, tamper, result]);
}

function recordFrames(t) {
  if (mode !== 'camera' || !vision?.running || !duel || duel.over || t - lastFrameAt < FRAME_EVERY_MS) return;
  lastFrameAt = t;
  const time = Date.now();
  vision.sides.forEach((side, index) => {
    if (!side.pose) return;
    const frame = { t: time, side: index, points: side.pose.flatMap((p) => [p.x, p.y]) };
    frames.push(frame);
    if (recording.frames.length < MAX_RECORDED_FRAMES) recording.frames.push(frame);
  });
}

function flushFrames() {
  if (!duel || frames.length === 0) return;
  const batch = frames;
  frames = [];
  api(`/api/match/${duel.matchId}/frames`, { frames: batch, matchToken }).catch(() => {});
}

async function endDuel(result) {
  flushFrames();
  clearInterval(flushTimer);
  lastResult = result;
  api(`/api/match/${result.matchId}/end`, { winner: result.winner, finalHp: result.finalHp, matchToken }).catch(() => {});
  $('#winner').textContent = result.winner === -1 ? 'A draw!' : `${result.players[result.winner].name} wins!`;
  $('#summary').replaceChildren(
    ...result.players.map((player, side) =>
      element('div', { className: 'card', style: `--player: ${COLORS[side]}` }, [
        element('strong', { textContent: player.name }),
        element('span', { textContent: `${player.hp} HP left · ${player.mana - player.manaLeft} of ${player.mana} spells used` }),
      ]),
    ),
  );
  $('#results-note').textContent = '';
  show('results');
  loadStats();
}

// ---------- Instant replay ----------

async function startReplay() {
  if (!lastResult) return;
  $('#results-note').textContent = 'Loading the replay…';
  let data = { frames: [], spells: [] };
  try {
    data = await api(`/api/match/${lastResult.matchId}/replay`);
  } catch {
    // Fall back to the browser's own recording below.
  }
  // Use whichever copy is more complete. On Vercel without Tiger Data, the server's
  // temporary copy can disappear between requests.
  const size = (copy) => copy.frames.length + copy.spells.length;
  if (recording.matchId === lastResult.matchId && size(recording) > size(data)) data = recording;
  const times = [...data.frames.map((f) => f.t), ...data.spells.map((s) => s.t)];
  if (times.length === 0) {
    $('#results-note').textContent = 'Nothing was recorded for this duel.';
    return;
  }
  const start = Math.min(...times) - 500;
  const end = Math.max(...times) + 1500;
  replay = {
    start,
    end,
    began: performance.now(),
    frames: data.frames.map((f) => ({ ...f, pose: unflatten(f.points) })),
    spells: data.spells.filter((s) => s.outcome === 'cast' || s.outcome === 'cheat'),
    nextSpell: 0,
    poses: [null, null],
    nextFrame: 0,
    effects: [],
    players: lastResult.players.map((p) => ({ ...p, status: 'ready', shield: 0, label: null })),
  };
  $('#results-note').textContent = '';
  duel = null;
  show('duel');
}

function replaySound(spell) {
  if (spell.outcome === 'cheat') {
    sound.backfire(spell.side);
  } else if (spell.element === 'fire') {
    sound.fire(spell.side, spell.power);
    setTimeout(() => sound.fireImpact(1 - spell.side, spell.damage ?? 16), 700);
  } else if (spell.element === 'lightning') {
    sound.lightning(1 - spell.side);
  } else {
    sound.shieldUp(spell.side);
  }
}

function unflatten(points) {
  const pose = [];
  for (let i = 0; i < points.length; i += 2) pose.push({ x: points[i], y: points[i + 1] });
  return pose;
}

function replayView(t) {
  const now = replay.start + (t - replay.began);
  while (replay.nextFrame < replay.frames.length && replay.frames[replay.nextFrame].t <= now) {
    const frame = replay.frames[replay.nextFrame];
    replay.poses[frame.side] = frame.pose;
    replay.nextFrame += 1;
  }
  while (replay.nextSpell < replay.spells.length && replay.spells[replay.nextSpell].t <= now) {
    const spell = replay.spells[replay.nextSpell];
    const caster = replay.players[spell.side];
    caster.label = { text: spell.outcome === 'cheat' ? 'BACKFIRE' : `${spell.name} · ${spell.power}`, until: t + 2200 };
    const type = spell.outcome === 'cheat' ? 'backfire' : { fire: 'fireball', lightning: 'bolt', shield: 'shieldUp' }[spell.element];
    replay.effects.push({ type, from: spell.side, to: 1 - spell.side, side: spell.side, power: spell.power, start: t, duration: 700 });
    replaySound(spell);
    replay.nextSpell += 1;
  }
  replay.effects = replay.effects.filter((effect) => t - effect.start < effect.duration);
  const hasPoses = replay.frames.length > 0;
  return {
    camera: false,
    players: replay.players,
    sides: hasPoses ? replay.poses.map((pose) => ({ pose, hands: [] })) : null,
    effects: replay.effects,
    floaters: [],
    banners: [],
    timeLeft: 0,
    replay: { progress: Math.min(1, (now - replay.start) / (replay.end - replay.start)) },
    progress: null,
  };
}

// ---------- Main loop ----------

function tick(t) {
  if (!screens.duel.hidden) {
    if (replay) {
      renderer.draw(replayView(t), t);
      if (t - replay.began > replay.end - replay.start) {
        replay = null;
        show('results');
      }
    } else if (duel) {
      duel.update(t);
      recordFrames(t);
      const secondsLeft = duel.timeLeft(t);
      if (!duel.over && secondsLeft <= 10 && secondsLeft > 0 && secondsLeft !== lastTickSecond) {
        lastTickSecond = secondsLeft;
        sound.tick();
      }
      renderer.draw(
        {
          camera: mode === 'camera' && Boolean(vision?.running),
          players: duel.players,
          sides: mode === 'camera' && vision?.running ? vision.sides : null,
          effects: duel.effects,
          floaters: duel.floaters,
          banners: duel.banners,
          timeLeft: duel.timeLeft(t),
          progress: {
            hold: (side) => (mode === 'camera' ? (vision?.holdProgress(side, t) ?? 0) : 0),
            channel: (side) => duel.channelProgress(side, t),
          },
        },
        t,
      );
    }
  }
  requestAnimationFrame(tick);
}

// The incantation boxes never submit the page, even if Enter lands at the wrong moment.
document.querySelectorAll('.say').forEach((form) => form.addEventListener('submit', (event) => event.preventDefault()));

// ---------- Sound settings ----------

function syncSoundControls() {
  $('#music-on').checked = sound.prefs.music;
  $('#effects-on').checked = sound.prefs.effects;
  $('#mute').textContent = sound.muted ? '🔇 Sound off (M)' : '🔊 Sound on (M)';
  $('#mute').setAttribute('aria-pressed', String(sound.muted));
}

$('#music-on').addEventListener('change', (event) => {
  sound.unlock();
  sound.setMusic(event.target.checked);
  syncSoundControls();
});
$('#effects-on').addEventListener('change', (event) => {
  sound.unlock();
  sound.setEffects(event.target.checked);
  syncSoundControls();
});
$('#mute').addEventListener('click', () => {
  sound.unlock();
  sound.toggleMute();
  syncSoundControls();
});

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement && !event.target.closest('form')?.hidden;
  if (typing || screens.duel.hidden) return;
  if (event.key === 'm' || event.key === 'M') {
    sound.unlock();
    sound.toggleMute();
    syncSoundControls();
    return;
  }
  if (!duel) return;
  const binding = KEYS[event.key];
  if (!binding) return;
  event.preventDefault();
  duel.trigger(binding[0], binding[1]);
});

function lobbyPlayers() {
  const wizards = savedWizards();
  return [0, 1].map((side) =>
    wizards[side]
      ? { side, idToken: wizards[side].idToken }
      : { side, name: document.getElementById(`name-${side}`)?.value ?? '' },
  );
}

// sound.unlock() runs inside each click, because browsers only allow sound after one.
$('#start').addEventListener('click', () => {
  sound.unlock();
  startDuel(lobbyPlayers());
});
$('#rematch').addEventListener('click', () => {
  sound.unlock();
  if (lastMatch) startDuel(lastMatch.players);
});
$('#replay').addEventListener('click', () => {
  sound.unlock();
  startReplay();
});
$('#back').addEventListener('click', () => {
  duel = null;
  replay = null;
  sound.stopMusic();
  renderSlots();
  show('title');
  loadStats();
});

async function boot() {
  [config, health] = await Promise.all([
    api('/api/config').catch(() => ({ auth0: null })),
    api('/api/health').catch(() => null),
  ]);
  const authError = await initAuth(config.auth0).catch((error) => error.message);
  if (authError) $('#notice').textContent = authError;
  if (!navigator.mediaDevices?.getUserMedia) document.querySelector('input[value="keyboard"]').checked = true;
  renderSlots();
  renderSponsors();
  syncSoundControls();
  loadStats();
  requestAnimationFrame(tick);
}

// Exposed for quick checks in the browser console.
window.hexbyte = { GESTURE_ELEMENTS, sound, get duel() { return duel; } };
boot();
