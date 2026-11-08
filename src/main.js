import './styles.css';
import {
  ATTACKS,
  BOT_RANKS,
  ELEMENT_ICONS,
  GESTURE_ELEMENTS,
  MANA,
  POWER_CAP,
  powerLabel,
} from '../shared/rules.js';
import { Sound } from './audio.js';
import { forgetWizard, initAuth, saveWizard, savedWizards, signIn } from './auth.js';
import { openFaceScan } from './facescan.js';
import { Bot } from './bot.js';
import { Duel } from './duel.js';
import { zonePoint } from './pose.js';
import { GAP, Ritual, STEPS, clampToSide, inView } from './ritual.js';
import { ELEMENT_COLORS, ELEMENT_NAMES, icon } from './icons.js';
import { Renderer } from './render.js';
import { FLICK_SPEED, WRISTS, emptyTracks, gripStep, releaseDirection, swingOf, trackWrists } from './throws.js';
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
  // Frost Shard sits on the row below: Q and U.
  q: [0, 'Thumb_Up'],
  u: [1, 'Thumb_Up'],
};
// Dodges for keyboard players: jump clears low throws, duck clears high ones.
const DODGE_KEYS = { a: [0, 'jump'], s: [0, 'duck'], j: [1, 'jump'], k: [1, 'duck'] };
// The keyboard aim marker sweeps from head to feet in this long.
const AIM_SWEEP_MS = 1600;
const FRAME_EVERY_MS = 100;
const FLUSH_EVERY_MS = 2000;
const TYPE_SECONDS = 6;

// Who Player 2 is: a friend on the same laptop, or an AI wizard of a chosen rank.
// Remembered in this browser only; the lobby works the same without it.
const LOBBY_KEY = 'hexbyte.lobby';
function loadLobby() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOBBY_KEY)) ?? {};
    return { opponent: saved.opponent === 'ai' ? 'ai' : 'friend', rank: BOT_RANKS[saved.rank] ? saved.rank : 'medium' };
  } catch {
    return { opponent: 'friend', rank: 'medium' };
  }
}
function saveLobby() {
  try {
    localStorage.setItem(LOBBY_KEY, JSON.stringify(lobby));
  } catch {
    // Private windows can refuse storage. The choice just isn't remembered.
  }
}
let lobby = loadLobby();
let bot = null;

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

// Turns <i data-icon="fire" data-size="36" data-color="fire"> placeholders into pixel SVGs.
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((placeholder) => {
    const { icon: name, size, color } = placeholder.dataset;
    const svg = icon(name, { size: Number(size) || 24, color: ELEMENT_COLORS[color] ?? color });
    if (placeholder.className) svg.classList.add(...placeholder.className.split(/\s+/));
    placeholder.replaceWith(svg);
  });
}

// ---------- Lobby ----------

const MOST_MANA = Math.max(...Object.values(MANA), ...Object.values(BOT_RANKS).map((rank) => rank.mana));

// Mana as pixel blocks. Empty blocks show what signing in could add.
function manaMeter(count) {
  const pips = Array.from({ length: MOST_MANA }, (_, i) => element('span', { className: i < count ? 'pip' : 'pip empty' }));
  return element('div', { className: 'mana', role: 'img', ariaLabel: `${count} mana` }, [
    element('span', { className: 'mana-label', textContent: 'Mana', ariaHidden: 'true' }),
    element('span', { className: 'pips', ariaHidden: 'true' }, pips),
    element('span', { className: 'mana-count', textContent: String(count), ariaHidden: 'true' }),
  ]);
}

// A signed-in wizard's power level: a bar to 100, then MAX!!!
function powerMeter(level) {
  const label = powerLabel(level);
  const fill = element('span');
  fill.style.width = `${(Math.min(Math.max(level, 0), POWER_CAP) / POWER_CAP) * 100}%`;
  return element('div', { className: `power${level > POWER_CAP ? ' is-max' : ''}`, role: 'img', ariaLabel: `Power level ${label}` }, [
    element('span', { className: 'mana-label', textContent: 'Power', ariaHidden: 'true' }),
    element('span', { className: 'power-bar', ariaHidden: 'true' }, [fill]),
    element('span', { className: 'power-value', textContent: label, ariaHidden: 'true' }),
  ]);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`;
function recordLine(record) {
  return [plural(record.duels ?? 0, 'duel'), plural(record.wins ?? 0, 'win'), plural(record.losses ?? 0, 'loss'), plural(record.draws ?? 0, 'draw'), plural(record.logins ?? 0, 'login')].join(' · ');
}

function badge(text, tone = '') {
  return element('span', { className: `badge ${tone}`.trim() }, [icon('check', { size: 16 }), text]);
}

// A pixel segmented control: a fieldset of real radio buttons.
function choice(legend, name, options, current, onChange) {
  const group = element('div', { className: 'segmented' });
  for (const [value, label] of options) {
    const input = element('input', { type: 'radio', name, value, checked: value === current });
    input.addEventListener('change', () => onChange(value));
    group.append(element('label', { className: 'seg' }, [input, element('span', { textContent: label })]));
  }
  return element('fieldset', { className: 'control-group slot-choice' }, [element('legend', { textContent: legend }), group]);
}

function botCard(rankId) {
  const rank = BOT_RANKS[rankId];
  return element('div', { className: 'bot-card' }, [
    element('div', { className: 'wizard' }, [
      element('div', { className: 'avatar bot-avatar', ariaHidden: 'true' }, [icon('hat', { size: 32, color: 'var(--p2-text)' })]),
      element('div', {}, [
        element('strong', { textContent: rank.title }),
        element('div', { className: 'slot-badges' }, [element('span', { className: 'badge gold', textContent: `AI · ${rank.label}` })]),
      ]),
    ]),
    element('p', { className: 'hint', textContent: rank.blurb }),
    manaMeter(rank.mana),
  ]);
}

function renderSlots() {
  const wizards = savedWizards();
  document.querySelectorAll('.slot').forEach((slot) => {
    const side = Number(slot.dataset.side);
    const wizard = wizards[side];
    const body = element('div', { className: 'slot-body' });
    // Status badges for this player (sign-in, verified login, helpers) go in here.
    const badges = element('div', { className: 'slot-badges' });
    slot.replaceChildren(
      element('header', { className: 'slot-head' }, [
        element('h2', { textContent: side === 1 && lobby.opponent === 'ai' ? 'Player 2 · AI' : `Player ${side + 1}` }),
        element('span', { className: 'side-tag', textContent: side === 0 ? 'Left' : 'Right' }),
      ]),
      body,
    );

    // Player 2 can be a friend or an AI wizard.
    if (side === 1) {
      slot.classList.toggle('is-bot', lobby.opponent === 'ai');
      body.append(
        choice('Opponent', 'opponent', [['friend', 'Friend'], ['ai', 'AI']], lobby.opponent, (value) => {
          lobby.opponent = value;
          saveLobby();
          renderSlots();
          document.querySelector(`input[name="opponent"][value="${value}"]`)?.focus();
        }),
      );
      if (lobby.opponent === 'ai') {
        body.append(
          choice('Rank', 'rank', Object.entries(BOT_RANKS).map(([id, rank]) => [id, rank.label]), lobby.rank, (value) => {
            lobby.rank = value;
            saveLobby();
            renderSlots();
            document.querySelector(`input[name="rank"][value="${value}"]`)?.focus();
          }),
          botCard(lobby.rank),
        );
        return;
      }
    }

    if (wizard) {
      const avatar = wizard.picture
        ? element('img', { src: wizard.picture, alt: '', referrerPolicy: 'no-referrer', className: 'avatar' })
        : element('div', { className: 'avatar', textContent: wizard.name.slice(0, 1).toUpperCase(), ariaHidden: 'true' });
      const forget = element('button', { textContent: 'Sign out', className: 'link' });
      forget.addEventListener('click', () => {
        forgetWizard(side);
        renderSlots();
      });
      badges.append(badge('Auth0'));
      if (wizard.faceLogin) badges.append(badge('Face ID', 'gold'));
      if (wizard.ritualVerified) badges.append(badge('Ritual Gate', 'gold'));
      body.append(
        element('div', { className: 'wizard' }, [avatar, element('div', {}, [element('strong', { textContent: wizard.name }), badges])]),
        manaMeter(wizard.ritualVerified ? MANA.ritualWizard : MANA.wizard),
      );
      if (Number.isFinite(wizard.power)) body.append(powerMeter(wizard.power));
      // The player's long-term record, as saved on their account.
      if (wizard.record) body.append(element('p', { className: 'player-record', textContent: recordLine(wizard.record) }));
      // This sign-in's hash, as written to the Duel Ledger.
      if (wizard.login?.hash) body.append(loginLine(wizard.login));
      // Face login wizards can change their name: a quick rescan proves it's them.
      if (wizard.faceLogin && config.faceLogin) {
        const rename = element('button', { textContent: 'Change name', className: 'link' });
        rename.addEventListener('click', () => scanFace(side, { mode: 'rename' }));
        body.append(element('div', { className: 'slot-links' }, [rename, forget]));
      } else {
        body.append(forget);
      }
      return;
    }

    const input = element('input', {
      id: `name-${side}`,
      placeholder: `Wizard ${side + 1}`,
      maxLength: 24,
      autocomplete: 'off',
    });
    badges.append(element('span', { className: 'badge muted', textContent: 'Guest' }));
    body.append(badges, element('label', { htmlFor: input.id, textContent: 'Guest name' }), input, manaMeter(MANA.guest));
    if (config.faceLogin) {
      // Face login: scan your face and say your name. New faces join the registry.
      const button = element('button', { className: 'auth' }, [icon('face', { size: 20 }), element('span', { textContent: 'Scan your face' })]);
      button.addEventListener('click', () => scanFace(side));
      body.append(
        button,
        element('p', {
          className: 'hint',
          textContent:
            'Look at the camera and say your name. Your face and name bring back your account and the power level you left off at. New faces join the registry.',
        }),
      );
    } else if (config.auth0) {
      const button = element('button', { textContent: 'Sign in with Auth0', className: 'auth' });
      button.addEventListener('click', () => signIn(side));
      body.append(button, element('p', { className: 'hint', textContent: 'Signed-in wizards get more mana, and the Ritual Gate login skips the ritual before each duel.' }));
    }
  });
}

function loginLine(login) {
  const text = `Login ${login.hash.slice(0, 8)} · player ${login.player.slice(0, 8)}`;
  return element('p', { className: 'login-hash', title: `Login ${login.hash}, player ${login.player}` }, [
    login.ledger?.url ? element('a', { href: login.ledger.url, target: '_blank', rel: 'noopener', textContent: `${text} ↗` }) : text,
  ]);
}

function scanFace(side, options = {}) {
  return openFaceScan({
    side,
    ...options,
    onSignedIn: (wizard) => {
      saveWizard(side, wizard);
      renderSlots();
    },
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
    health.auth0
      ? `Auth0: on${health.faceLogin ? ' · Face login' : ''}${health.ritualGate ? ' · Ritual Gate' : ''}`
      : 'Auth0: off, players join as guests',
    health.solana ? 'Solana: Duel Ledger on devnet' : 'Solana: off, add SOLANA_SECRET_KEY to .env',
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
      ['Avg spell wait', stats.avgLatencyMs ? `${(stats.avgLatencyMs / 1000).toFixed(1)} s` : '–'],
      ...stats.byElement.map((e) => [
        ELEMENT_NAMES[e.element] ?? e.element,
        e.spells ? `${e.spells} · power ${Number(e.avgPower).toFixed(1)}` : '0',
        e.element,
      ]),
    ];
    if (stats.compression) {
      const saved = 100 - (stats.compression.after / stats.compression.before) * 100;
      cards.push(['Body data compressed', `${saved.toFixed(0)}% smaller`]);
    }
    box.replaceChildren(
      element('h2', { textContent: 'Season stats' }),
      element('p', {
        className: 'stats-source',
        textContent: `From ${stats.source}${stats.fromAggregate ? ' (continuous aggregate)' : ''}`,
      }),
      element(
        'div',
        { className: 'cards' },
        cards.map(([label, value, elementName]) => {
          const card = element('div', { className: 'card' }, [
            element('span', {}, [elementName ? icon(elementName, { size: 20, color: ELEMENT_COLORS[elementName] }) : '', label]),
            element('strong', { textContent: String(value) }),
          ]);
          if (elementName) card.dataset.element = elementName;
          return card;
        }),
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

// The hand-sign legend under the arena: attacks first, then defense, then moves.
const SIGNS = [
  ['fire', 'Attack'],
  ['lightning', 'Attack'],
  ['frost', 'Attack'],
  ['shield', 'Defense'],
];

function keysFor(gesture, sides) {
  return sides.map((side) => Object.keys(KEYS).find((key) => KEYS[key][0] === side && KEYS[key][1] === gesture)?.toUpperCase());
}

function renderSigns(match) {
  const gestureOf = Object.fromEntries(Object.entries(GESTURE_ELEMENTS).map(([gesture, name]) => [name, gesture]));
  // Against the AI, only Player 1's keys matter.
  const sides = match.players.some((player) => player.kind === 'bot') ? [0] : [0, 1];
  const camera = mode === 'camera';
  const rows = SIGNS.map(([name, kind]) => ({ name, kind, emoji: ELEMENT_ICONS[name], label: ELEMENT_NAMES[name], gesture: gestureOf[name] }));
  rows.push(
    { name: 'throw', kind: camera ? 'Swing your arm' : 'Spell key again', emoji: '💨', label: 'Throw', keys: [] },
    { name: 'jump', kind: camera ? 'Jump for real' : 'Dodge low throws', emoji: '⬆️', label: 'Jump', keys: dodgeKeys('jump', sides) },
    { name: 'duck', kind: camera ? 'Duck for real' : 'Dodge high throws', emoji: '⬇️', label: 'Duck', keys: dodgeKeys('duck', sides) },
  );
  $('#signs').replaceChildren(
    ...rows.map((row) => {
      const sign = element('li', { className: 'sign' }, [
        element('span', { className: 'sign-emoji', textContent: row.emoji, ariaHidden: 'true' }),
        element('span', { className: 'sign-text' }, [
          element('span', { className: 'sign-name', textContent: row.label }),
          element('span', { className: 'sign-kind', textContent: row.kind }),
        ]),
        ...(row.keys ?? keysFor(row.gesture, sides)).filter(Boolean).map((key) => element('kbd', { textContent: key })),
        element('span', { className: 'sign-cd', ariaHidden: 'true' }),
      ]);
      sign.dataset.element = row.name;
      return sign;
    }),
  );
}

function dodgeKeys(kind, sides) {
  return sides.map((side) => Object.keys(DODGE_KEYS).find((key) => DODGE_KEYS[key][0] === side && DODGE_KEYS[key][1] === kind)?.toUpperCase());
}

// The shield is the only thing with a cooldown: its legend chip shows the timer.
let rechargeShownAt = 0;
function showRecharges(t) {
  if (t - rechargeShownAt < 150) return;
  rechargeShownAt = t;
  const humans = duel.players.map((player, side) => side).filter((side) => duel.players[side].kind !== 'bot');
  document.querySelectorAll('.sign').forEach((sign) => {
    const name = sign.dataset.element;
    const waits = humans.map((side) => (name === 'shield' ? Math.max(0, duel.players[side].barrierReadyAt - t) : 0));
    const label = waits.some((ms) => ms > 0)
      ? waits.map((ms, i) => (humans.length > 1 ? `P${humans[i] + 1} ` : '') + (ms > 0 ? `${Math.ceil(ms / 1000)}s` : 'ready')).join(' · ')
      : '';
    const cd = sign.querySelector('.sign-cd');
    if (cd && cd.textContent !== label) cd.textContent = label;
    sign.classList.toggle('is-charging', waits.length > 0 && waits.every((ms) => ms > 0));
  });
}

// Flashes a sign in the legend when that spell is cast.
function flashSign(name) {
  const sign = document.querySelector(`.sign[data-element="${name}"]`);
  if (!sign) return;
  sign.classList.remove('is-cast');
  void sign.offsetWidth;
  sign.classList.add('is-cast');
  setTimeout(() => sign.classList.remove('is-cast'), 500);
}

// Lights up the signs the camera sees being held right now.
let heldSigns = '';
function showHeldSigns() {
  const held = (vision?.running && mode === 'camera' ? vision.sides : [])
    .map((side) => side.held?.gesture)
    .filter(Boolean)
    .map((gesture) => GESTURE_ELEMENTS[gesture])
    .join(',');
  if (held === heldSigns) return;
  heldSigns = held;
  document.querySelectorAll('.sign').forEach((sign) => sign.classList.toggle('is-held', held.split(',').includes(sign.dataset.element)));
}

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
      vision ??= new Vision({ video, onGesture: act });
      if (!vision.running) await vision.start((text) => ($('#stage-status').textContent = text));
      $('#stage-status').textContent = '';
    } catch (error) {
      mode = 'keyboard';
      $('#stage-status').textContent = `Camera unavailable (${error.message}). Using the keyboard instead.`;
    }
  }

  // Against the AI, the one person on camera is Player 1 wherever they stand.
  const vsBot = match.players.some((player) => player.kind === 'bot');
  if (vision) vision.solo = vsBot;

  renderSigns(match);
  matchToken = match.matchToken;
  resetLedger(match.game);
  // The game's first ledger entry: its hash, and which logins are playing.
  recordOnChain({ type: 'start' }, null, 'Game start on Solana', match);
  recording = { matchId: match.matchId, frames: [], spells: [] };
  duel = new Duel({
    match,
    listen,
    cast: (body) => api('/api/spell', { ...body, matchToken }),
    onLog: addLog,
    onEnd: endDuel,
    onEvent: playDuelSound,
    bodyOf: bodyFor,
    // Nothing happens (and the clock waits) until the ritual and the countdown are done.
    waitForStart: true,
  });
  bot?.stop();
  const botPlayer = match.players.find((player) => player.kind === 'bot');
  bot = botPlayer ? new Bot({ duel, side: botPlayer.side, rank: botPlayer.rank }) : null;
  // On camera, every person in the duel does the opening ritual, except wizards who
  // already passed it at the Auth0 Ritual Gate. The keyboard goes straight to 3-2-1.
  const needRitual = match.players.filter((player) => player.kind !== 'bot' && player.kind !== 'ritualWizard').map((player) => player.side);
  countdown = null;
  if (mode === 'camera' && vision?.running && needRitual.length) startRitual(needRitual, vsBot);
  else startCountdown();
  listening = 0;
  lastTickSecond = null;
  sound.setTension(false);
  // Music plays through the duel when it's switched on (it stays silent otherwise).
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
    if (!details.bonus) flashSign(details.element);
    if (details.element === 'fire') sound.fire(side, details.power);
    else if (details.element === 'lightning') sound.lightning(1 - side);
    else if (details.element === 'frost') sound.frost(side);
    else if (details.element === 'drain') sound.drain(side);
    else if (details.element === 'shield') sound.shieldUp(side);
    sound.bump(0.2);
  } else if (name === 'armed') {
    flashSign(details.element);
    sound.channel(side, details.element);
  } else if (name === 'throw') {
    flashSign('throw');
    if (details.element === 'fire') sound.fire(side, details.power);
    else if (details.element === 'lightning') sound.lightning(1 - side);
    else if (details.element === 'frost') sound.frost(side);
    else if (details.element === 'drain') sound.drain(side);
    sound.bump(0.2);
  } else if (name === 'blocked') {
    sound.blocked(side, 12);
    recordOnChain({ type: 'block', side: details.by, element: details.element }, details.castId, 'Block on Solana');
  } else if (name === 'landed') {
    const label = details.zone === 'head' ? 'Headshot on Solana' : details.bonus ? 'Bonus on Solana' : 'Hit on Solana';
    recordOnChain(
      { type: 'hit', side: details.side, element: details.element, zone: details.zone, damage: details.damage, bonus: details.bonus },
      details.castId,
      label,
    );
  } else if (name === 'dodge') {
    flashSign(details.kind);
  } else if (name === 'heal') {
    sound.heal(side);
  } else if (name === 'freeze') {
    sound.freeze(side);
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
  } else if (name === 'battle') {
    sound.shieldUp(0);
    sound.shieldUp(1);
    sound.bump(0.4);
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
  // The spell fires as soon as the wizard stops talking. Their words show in the
  // speech bubble while they say them.
  if (mode === 'camera') {
    if (!voiceAvailable) return Promise.resolve(null);
    // A short wait for the first word, so attacks can come fast.
    return listenOnce({
      startMs: 1500,
      onPartial: (text) => {
        const player = duel?.players[side];
        if (player?.status === 'listening') player.words = text;
      },
    });
  }
  return typedIncantation(side, element);
}

function typedIncantation(side, elementName) {
  const form = document.querySelector(`.say[data-side="${side}"]`);
  const input = form.querySelector('input');
  const label = form.querySelector('label');
  return new Promise((resolve) => {
    let seconds = TYPE_SECONDS;
    const update = () => {
      label.replaceChildren(
        icon(elementName, { size: 20, color: ELEMENT_COLORS[elementName] }),
        `Player ${side + 1}: type your ${(ELEMENT_NAMES[elementName] ?? 'spell').toLowerCase()} incantation, then Enter (${seconds}s)`,
      );
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
  const item = element('li', { className: `entry side-${entry.side} ${entry.outcome}` });
  if (entry.castId != null) item.dataset.castId = String(entry.castId);
  // The judged spell's own Solana memo, written by the server along with the verdict.
  if (entry.ledger?.url) {
    ledger.count += 1;
    showLedgerCount();
    ledger.links.set(entry.castId, [['Cast on Solana', entry.ledger.url], ...(ledger.links.get(entry.castId) ?? [])]);
  }
  const head = element('div', { className: 'entry-head' }, [
    element('span', { className: 'who' }, [
      icon(entry.element, { size: 20, color: ELEMENT_COLORS[entry.element] }),
      element('span', { textContent: entry.player }),
    ]),
    element('span', { className: 'wait', textContent: entry.latencyMs ? `${(entry.latencyMs / 1000).toFixed(1)} s` : '' }),
  ]);
  item.append(head, element('q', { textContent: `${entry.words}${entry.auto ? ' (auto)' : ''}` }));

  if (entry.outcome === 'cast') {
    const detail = landedDetail(entry);
    item.append(
      element('p', {
        className: 'result',
        textContent: `${entry.name} · ${Number.isFinite(entry.creativity) ? `creativity ${entry.creativity}/100 · ` : ''}power ${entry.power} · ${detail}`,
      }),
      element('p', {
        className: 'cost',
        textContent: `Cost $${Number(entry.costUsd ?? 0).toFixed(6)}${entry.effectText ? ` · ${entry.effectText}` : ''}`,
      }),
    );
    if (entry.receipt) item.append(receiptButtons(entry.receipt));
    if (health?.solana) item.append(chainRow(entry.castId));
  } else if (entry.outcome === 'cheat') {
    item.append(
      element('p', { className: 'result' }, [
        element('span', { className: 'tag', textContent: 'Blocked' }),
        'Prune caught a prompt injection. The spell backfired.',
      ]),
    );
  } else if (entry.outcome === 'out_of_mana') {
    item.append(
      element('p', { className: 'result' }, [
        element('span', { className: 'tag', textContent: 'Blocked' }),
        `Out of mana (Prune: ${entry.blockedBy}).`,
      ]),
    );
  } else {
    item.append(
      element('p', { className: 'result', textContent: `No verdict, so no bonus: ${entry.error ?? entry.blockedBy ?? 'unknown error'}` }),
    );
  }
  $('#log').prepend(item);
}

// What happened to the thrown orb, and what the judge's score did about it.
const ZONE_NAMES = { head: 'HEADSHOT ×1.5', torso: 'body hit', limb: 'arm or leg ×0.75' };
const ZONE_MULTIPLIER = { head: 1.5, torso: 1, limb: 0.75 };
function landedDetail(entry) {
  const bonus = entry.bonus?.damage ?? 0;
  if (entry.landed === 'hit') {
    const extra = Math.round(bonus * (ZONE_MULTIPLIER[entry.zone] ?? 1));
    return `${ZONE_NAMES[entry.zone] ?? 'hit'}${extra ? `, +${extra} judge's bonus` : ''}`;
  }
  if (entry.landed === 'held') return 'the orb in hand powered up';
  if (entry.landed === 'flying') return 'the orb powered up in the air';
  if (entry.landed === 'blocked') return 'blocked by a shield, no bonus';
  if (entry.landed === 'fizzled') return 'fizzled in hand, no bonus';
  return 'missed, no bonus';
}

// The receipt stays in the browser exactly as Prune signed it. Prune checks the signature.
function receiptButtons(receipt) {
  const result = element('span', { className: 'verdict' });
  const verify = element('button', { textContent: 'Verify', className: 'btn-small' });
  const tamper = element('button', { textContent: 'Tamper test', className: 'btn-small' });
  const run = async (tampered) => {
    result.textContent = 'Checking with Prune…';
    result.className = 'verdict';
    try {
      const answer = await api('/api/verify', { receipt, tamper: tampered });
      result.replaceChildren(
        icon(answer.valid ? 'check' : 'cross', { size: 16 }),
        answer.valid
          ? `Genuine. Signed by Prune key ${answer.keyId}`
          : `Rejected (${answer.reason})${tampered ? ': we changed the cost, so the signature no longer matches' : ''}`,
      );
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
  bot?.stop();
  // The duel is over, so the music fades out (it only plays during duels).
  sound.stopMusic();
  flushFrames();
  clearInterval(flushTimer);
  lastResult = result;
  const resultToken = matchToken;
  replayFingerprint(recording)
    .then((replay) =>
      api(`/api/match/${result.matchId}/end`, {
        winner: result.winner,
        finalHp: result.finalHp,
        replay,
        matchToken: resultToken,
        // The judge's signed ratings, for the creativity scores, and each player's stats.
        ratings: result.ratings,
        stats: result.players.map((player) => player.stats),
      }),
    )
    .then((answer) => {
      showPowerChanges(answer?.power);
      showScores(answer?.score);
      showResultOnChain(answer?.ledger, answer?.score);
    })
    .catch(() => {});
  $('#winner').textContent = result.winner === -1 ? 'A draw!' : `${result.players[result.winner].name} wins!`;
  $('#summary').replaceChildren(
    ...result.players.map((player, side) =>
      element('div', { className: `card side-${side}` }, [
        element('span', { textContent: `Player ${side + 1}${result.winner === side ? ' · Winner' : ''}` }),
        element('strong', { textContent: player.name }),
        element('span', { textContent: `${player.hp} HP left · ${player.mana - player.manaLeft} of ${player.mana} spells judged` }),
        element('span', {
          textContent: `${player.stats.thrown} thrown · ${player.stats.hits} hits · ${player.stats.blocks} blocks · ${player.stats.damage} damage`,
        }),
        element('span', { className: 'creativity', id: `creativity-${side}`, textContent: 'Creativity: scoring…' }),
        ...(Number.isFinite(player.power)
          ? [element('span', { className: 'power-change', id: `power-change-${side}`, textContent: `Power level ${powerLabel(player.power)}` })]
          : []),
      ]),
    ),
  );
  $('#results-note').textContent = '';
  $('#results-chain').replaceChildren();
  if (health?.solana && ledger.count) {
    $('#results-chain').append(`Writing the result to Solana… ${ledger.count} transactions this duel.`);
  }
  show('results');
  loadStats();
}

// The creativity scores: the average of the AI judge's ratings of each player's incantations.
function showScores(score) {
  [0, 1].forEach((side) => {
    const line = document.getElementById(`creativity-${side}`);
    if (!line) return;
    const card = score?.card?.[side];
    if (!card) {
      line.textContent = 'Creativity: not scored';
      return;
    }
    line.textContent = Number.isFinite(card.cr)
      ? `Creativity ${card.cr}/100 · from ${card.j} judged incantation${card.j === 1 ? '' : 's'}`
      : 'Creativity: no judged incantations';
    line.classList.toggle('is-scored', Number.isFinite(card.cr));
  });
}

// The server saved each signed-in wizard's new power level: show it, and keep it for the lobby.
function showPowerChanges(changes) {
  if (!Array.isArray(changes)) return;
  const wizards = savedWizards();
  changes.forEach((change, side) => {
    if (!change || !Number.isFinite(change.after)) return;
    const line = document.getElementById(`power-change-${side}`);
    if (line) {
      line.textContent =
        change.gained > 0
          ? `Power level ${powerLabel(change.before)} → ${powerLabel(change.after)} (+${change.gained})`
          : `Power level ${powerLabel(change.after)}`;
      line.classList.toggle('is-up', change.gained > 0);
    }
    if (wizards[side] && lastMatch?.players?.[side]?.idToken === wizards[side].idToken) {
      saveWizard(side, { ...wizards[side], power: change.after, record: change.record ?? wizards[side].record ?? null });
    }
  });
}

// ---------- The Duel Ledger (Solana) ----------
// Every judged spell (written by the server with the verdict), every hit and block, and
// the final result go to Solana devnet as memos. Links open them in the explorer.

const ledger = { count: 0, links: new Map(), game: null };

function resetLedger(game = null) {
  ledger.count = 0;
  ledger.links = new Map();
  ledger.game = game;
  showLedgerCount();
}

// Every entry for this game, read back from Solana by the game's hash.
const gameLedgerUrl = (game) => `/api/ledger/game/${game}`;

function showLedgerCount() {
  const status = $('#ledger-status');
  if (!health?.solana) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.replaceChildren(
    element('a', { href: health.solana.url, target: '_blank', rel: 'noopener', textContent: `On Solana: ${ledger.count} tx this duel ↗` }),
    ...(ledger.game ? [' · ', element('a', { href: gameLedgerUrl(ledger.game), target: '_blank', rel: 'noopener', textContent: `Game ${ledger.game.slice(0, 8)} ↗` })] : []),
  );
}

function chainLink(label, url) {
  return element('a', { className: 'chain-link', href: url, target: '_blank', rel: 'noopener', textContent: `${label} ↗` });
}

// Adds a ledger link to a cast's combat-log entry (now, or when the entry appears).
function addChainLink(castId, label, url) {
  ledger.count += 1;
  showLedgerCount();
  const links = ledger.links.get(castId) ?? [];
  links.push([label, url]);
  ledger.links.set(castId, links);
  const entry = castId != null ? document.querySelector(`#log [data-cast-id="${castId}"] .chain`) : null;
  entry?.append(chainLink(label, url));
}

function chainRow(castId) {
  const row = element('p', { className: 'chain' });
  for (const [label, url] of ledger.links.get(castId) ?? []) row.append(chainLink(label, url));
  return row;
}

function recordOnChain(event, castId, label, match = duel) {
  if (!health?.solana || !matchToken || !match) return;
  api(`/api/match/${match.matchId}/ledger`, { matchToken, event })
    .then((answer) => answer?.ledger && addChainLink(castId, label, answer.ledger.url))
    .catch(() => {});
}

function showResultOnChain(written, score) {
  if (!written) return;
  ledger.count += score?.ledger ? 2 : 1;
  $('#results-chain').replaceChildren(
    `${ledger.count} transactions on Solana this duel${ledger.game ? `, all tagged game ${ledger.game.slice(0, 8)}` : ''}. `,
    chainLink('Match result on Solana', written.url),
    // The scorecard: both creativity scores and stats, under one hash.
    ...(score?.ledger ? [' ', chainLink(`Scorecard ${score.hash.slice(0, 8)} on Solana`, score.ledger.url)] : []),
    ...(ledger.game ? [' ', chainLink('Every entry for this game', gameLedgerUrl(ledger.game))] : []),
  );
}

// A fingerprint of the browser's recording, so the replay can be matched to the chain.
async function replayFingerprint(rec) {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ frames: rec.frames, spells: rec.spells }));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return undefined;
  }
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
    spells: data.spells.filter((s) => ['cast', 'cheat'].includes(s.outcome)),
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
  } else if (spell.element === 'frost') {
    sound.frost(spell.side);
  } else if (spell.element === 'drain') {
    sound.drain(spell.side);
  } else if (spell.element === 'heal') {
    sound.heal(spell.side);
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
    const type =
      spell.outcome === 'cheat' ? 'backfire' : { fire: 'fireball', lightning: 'bolt', shield: 'shieldUp', frost: 'shard', drain: 'drain', heal: 'heal' }[spell.element];
    replay.effects.push({
      type,
      from: spell.side,
      to: 1 - spell.side,
      side: spell.side,
      element: spell.element,
      power: spell.power,
      start: t,
      duration: 700,
    });
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
      const camera = mode === 'camera' && Boolean(vision?.running);
      const box = renderer.frameBox(camera);
      if (box.w && box.h) duel.aspect = box.w / box.h;
      if (!duel.live) updatePregame(t);
      updateOrbs(t);
      aimShields(t);
      duel.update(t);
      recordFrames(t);
      showHeldSigns();
      showRecharges(t);
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
          bodies: [bodyFor(0, t), bodyFor(1, t)],
          gap: GAP,
          stepBack: [outOfSafeZone(0), outOfSafeZone(1)],
          projectiles: duel.projectiles,
          strikes: duel.strikes,
          barriers: [duel.barrier(0, t), duel.barrier(1, t)],
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

// Two switches in the lobby: sound effects and music. M (or the button in the duel)
// mutes both, and pressing it again brings back whatever was on before.
function syncSoundControls() {
  const muted = !sound.prefs.effects && !sound.prefs.music;
  $('#effects-on').checked = sound.prefs.effects;
  $('#music-on').checked = sound.prefs.music;
  $('#mute').replaceChildren(icon(muted ? 'soundOff' : 'soundOn', { size: 20 }), muted ? 'Sound off (M)' : 'Sound on (M)');
  $('#mute').setAttribute('aria-pressed', String(muted));
}

let unmuteTo = null;
function toggleMute() {
  sound.unlock();
  if (sound.prefs.effects || sound.prefs.music) {
    unmuteTo = { effects: sound.prefs.effects, music: sound.prefs.music };
    sound.setEffects(false);
    sound.setMusic(false);
  } else {
    sound.setEffects(unmuteTo?.effects ?? true);
    sound.setMusic(unmuteTo?.music ?? false);
  }
  syncSoundControls();
}

$('#effects-on').addEventListener('change', (event) => {
  sound.unlock();
  sound.setEffects(event.target.checked);
  syncSoundControls();
});
$('#music-on').addEventListener('change', (event) => {
  sound.unlock();
  // Music only ever plays during a duel; this just remembers the choice.
  sound.setMusic(event.target.checked);
  syncSoundControls();
});
$('#mute').addEventListener('click', toggleMute);

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement && !event.target.closest('form')?.hidden;
  if (typing || screens.duel.hidden) return;
  if (event.key === 'm' || event.key === 'M') {
    toggleMute();
    return;
  }
  if (!duel) return;
  const key = event.key.toLowerCase();
  const dodge = DODGE_KEYS[key];
  if (dodge && duel.players[dodge[0]]?.kind !== 'bot') {
    event.preventDefault();
    duel.dodge(dodge[0], dodge[1]);
    return;
  }
  const binding = KEYS[key];
  if (!binding) return;
  event.preventDefault();
  const [side, gesture] = binding;
  // Holding an orb: your attack key throws it at the aim marker.
  if (duel.players[side]?.status === 'armed' && ATTACKS.includes(GESTURE_ELEMENTS[gesture])) {
    keyboardThrow(side);
    return;
  }
  act(side, gesture);
});

// A gesture (or key) casts a spell.
function act(side, gesture) {
  if (!duel) return;
  // Nobody can cast for the AI wizard.
  if (duel.players[side]?.kind === 'bot') return;
  // The camera has to see your head and shoulders to cast. Legs and feet don't matter.
  if (duel.live && outOfSafeZone(side)) {
    duel.floaters.push({ side, text: 'Get in view!', color: '#f87171', start: performance.now() });
    return;
  }
  duel.trigger(side, gesture);
}

// ---------- The opening ritual and the 3-2-1 countdown ----------

let ritual = null;
let countdown = null;
let ritualShown = '';
const COUNT_MS = 1000;

function startRitual(sides, vsBot) {
  ritual = new Ritual({ sides });
  ritualShown = '';
  $('#ritual-steps').replaceChildren(
    ...STEPS.map((step, i) => {
      const item = element('li', { textContent: `${step.emoji} ${step.title}` });
      item.dataset.step = String(i);
      return item;
    }),
  );
  $('#ritual-where').textContent = vsBot
    ? 'Stand on the left, with your head and shoulders on screen. Your legs can be out of frame.'
    : 'Player 1 on the left, Player 2 on the right, head and shoulders on screen. Legs can be out of frame.';
  $('#ritual').hidden = false;
}

function startCountdown(t = performance.now()) {
  ritual = null;
  $('#ritual').hidden = true;
  countdown = { start: t, shown: null };
}

$('#ritual-skip').addEventListener('click', () => startCountdown());

// Runs every frame before the duel starts.
function updatePregame(t) {
  if (ritual) {
    ritual.update(
      {
        poses: Object.fromEntries(ritual.sides.map((side) => [side, vision?.sides[side]?.pose ?? null])),
        hands: Object.fromEntries(ritual.sides.map((side) => [side, vision?.sides[side]?.hands ?? []])),
        aspect: duel.aspect,
      },
      t,
    );
    if (ritual.done) {
      sound.shieldUp(0);
      startCountdown(t);
    } else {
      showRitual();
    }
  }
  if (countdown) {
    const left = 3 - Math.floor((t - countdown.start) / COUNT_MS);
    const label = left > 0 ? String(left) : null;
    if (label !== countdown.shown) {
      countdown.shown = label;
      if (label) {
        $('#countdown').hidden = false;
        $('#countdown').textContent = label;
        sound.tick();
      }
    }
    if (left <= 0) {
      countdown = null;
      $('#countdown').textContent = 'BATTLE!';
      setTimeout(() => ($('#countdown').hidden = true), 900);
      duel.begin(t);
      bot?.start();
    }
  }
}

// The ritual card: the step, how to do it, and each player's progress.
function showRitual() {
  const step = ritual.current;
  const players = ritual.sides.map((side) => {
    const name = duel.players[side].name;
    if (!ritual.inFrame[side]) return [side, `${name}: get your head and shoulders on camera`, 'warn', 0];
    if (ritual.complete[side]) return [side, `${name}: done!`, 'done', 1];
    return [side, name, '', ritual.share(side)];
  });
  const key = `${ritual.step}|${players.map((p) => `${p[1]}:${p[2]}:${Math.round(p[3] * 10)}`).join(',')}`;
  if (key === ritualShown) return;
  ritualShown = key;
  $('#ritual-count').textContent = `${ritual.step}/3`;
  $('#ritual-emoji').textContent = step.emoji;
  $('#ritual-title').textContent = `Step ${ritual.step + 1}: ${step.title}`;
  $('#ritual-hint').textContent = step.hint;
  $('#ritual-players').replaceChildren(
    ...players.map(([side, text, tone, share]) => {
      const bar = element('span', { className: 'ritual-bar' }, [element('span', { className: 'ritual-fill' })]);
      bar.firstChild.style.width = `${Math.round(share * 100)}%`;
      const item = element('li', { className: `ritual-player side-${side} ${tone}` }, [element('span', { textContent: text }), bar]);
      return item;
    }),
  );
  $('#ritual-steps').querySelectorAll('li').forEach((item) => {
    const i = Number(item.dataset.step);
    item.className = i < ritual.step ? 'done' : i === ritual.step ? 'now' : '';
  });
}

// ---------- Bodies, orbs in hand, and throws ----------

// A camera body is kept on its own side of the gap in the middle.
const trackedBody = (side) =>
  mode === 'camera' && vision?.running && duel?.players[side]?.kind !== 'bot'
    ? clampToSide(vision.sides[side]?.pose ?? null, side)
    : null;

// Head or shoulders off screen (too close, or out of the picture): they can't cast.
const outOfSafeZone = (side) =>
  mode === 'camera' && Boolean(vision?.running) && duel?.players[side]?.kind !== 'bot' && !inView(vision.sides[side]?.pose);

// The body that orbs can hit: the camera's, or the standing (and dodging) wizard.
function bodyFor(side, t = performance.now()) {
  return trackedBody(side) ?? duel.standingBody(side, t);
}

const leadWrist = (body, side) => ((body[15].x - body[16].x) * (side === 0 ? 1 : -1) > 0 ? 15 : 16);

// Keeps each orb in its wizard's hand, sweeps the keyboard aim, and spots real throws.
// Each side's recent wrist positions, for spotting throws (src/throws.js).
const wristTracks = [emptyTracks(), emptyTracks()];

// The hand sign that holds each element's orb.
const GESTURE_OF = Object.fromEntries(Object.entries(GESTURE_ELEMENTS).map(([gesture, name]) => [name, gesture]));

// Orbs in hand follow the hand. On camera, holding the spell's hand sign grips the orb
// and letting go throws it: nothing else throws it, and nothing throws it on its own.
function updateOrbs(t) {
  duel.players.forEach((player, side) => {
    const tracked = trackedBody(side);
    if (tracked) trackWrists(wristTracks[side], tracked, t);
    const orb = player.orb;
    if (!orb) return;
    const body = tracked ?? duel.standingBody(side, t);
    if (!tracked) {
      orb.at = body[leadWrist(body, side)];
      if (player.kind !== 'bot') {
        orb.aim = aimPoint(side, t);
        orb.prompt = 'Press again to throw';
      }
      return;
    }
    // On camera: the orb sits in the hand that made the gesture.
    if (orb.hand == null) {
      const held = vision.sides[side]?.held?.hand;
      orb.hand = held
        ? WRISTS.reduce((best, i) => (Math.hypot(body[i].x - held.x, body[i].y - held.y) < Math.hypot(body[best].x - held.x, body[best].y - held.y) ? i : best))
        : leadWrist(body, side);
    }
    orb.at = body[orb.hand];
    orb.aim = null;
    // A hard throwing flick of the orb's hand counts as letting go too (how a ✌️ is thrown).
    const flick = swingOf(wristTracks[side], side, duel.aspect, FLICK_SPEED, [orb.hand]);
    const step = gripStep(orb, vision.sides[side]?.held?.gesture === GESTURE_OF[orb.element], t, Boolean(flick));
    orb.prompt = step === 'waiting' ? `${ELEMENT_ICONS[orb.element]} then let go` : 'Let go to throw';
    if (step !== 'release') return;
    const swing = flick ?? swingOf(wristTracks[side], side, duel.aspect, undefined, [orb.hand]);
    duel.throwOrb(side, orb.at, releaseDirection(swing, orb.at, zonePoint(bodyFor(1 - side, t), 'torso'), duel.aspect));
    wristTracks[side] = emptyTracks();
  });
}

// On camera, a raised shield follows the open palm up and down (or the forward hand).
function aimShields(t) {
  duel.players.forEach((player, side) => {
    if (player.barrierUntil <= t || player.kind === 'bot') return;
    const tracked = trackedBody(side);
    if (!tracked) return;
    const held = vision.sides[side]?.held;
    const palm = held?.gesture === 'Open_Palm' ? held.hand : null;
    player.shieldAimY = palm?.y ?? tracked[leadWrist(tracked, side)].y;
  });
}

// The keyboard aim marker: it sweeps up and down the opponent, so timing picks the spot.
function aimPoint(side, t) {
  const foe = bodyFor(1 - side, t);
  const top = foe[0].y - 0.03;
  const bottom = Math.max(foe[27]?.y ?? 0.88, foe[28]?.y ?? 0.88);
  const phase = (Math.sin(((t / AIM_SWEEP_MS) * 2 - 0.5) * Math.PI) + 1) / 2;
  return { x: zonePoint(foe, 'torso').x, y: top + (bottom - top) * phase };
}

function keyboardThrow(side) {
  const orb = duel.players[side].orb;
  if (!orb?.at) return;
  const aim = orb.aim ?? zonePoint(bodyFor(1 - side), 'torso');
  duel.throwOrb(side, orb.at, { x: aim.x - orb.at.x, y: aim.y - orb.at.y });
}

function lobbyPlayers() {
  const wizards = savedWizards();
  return [0, 1].map((side) => {
    if (side === 1 && lobby.opponent === 'ai') return { side, bot: lobby.rank };
    return wizards[side]
      ? { side, idToken: wizards[side].idToken }
      : { side, name: document.getElementById(`name-${side}`)?.value ?? '' };
  });
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
  bot?.stop();
  ritual = null;
  countdown = null;
  $('#ritual').hidden = true;
  $('#countdown').hidden = true;
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
window.hexbyte = { GESTURE_ELEMENTS, sound, scanFace, get duel() { return duel; } };
hydrateIcons();
syncSoundControls();
boot();
