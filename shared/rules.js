// Duel rules shared by the server (which decides what a spell does) and the
// browser (which animates it). The AI only suggests a power from 1 to 10;
// these rules decide everything else, so a clever incantation can't break them.
export const MAX_HP = 100;
export const BACKFIRE_DAMAGE = 12;
export const SHIELD_MS = 15000;
// Frost Shard: the target can't start a spell for this long (2.4 to 6 seconds).
export const FREEZE_BASE_MS = 2000;
export const FREEZE_PER_POWER_MS = 400;
export const MAX_SHIELD = 45;
export const MATCH_SECONDS = 90;

// Spells fire the moment they're cast, at this power. The AI judge's verdict comes
// back a few seconds later through Prune, and anything above this power lands as a
// "judge's bonus" strike. A busy or slow judge never holds up the duel.
export const BASE_POWER = 4;

// The gesture picks the element. The AI never gets to change it.
export const GESTURE_ELEMENTS = {
  Closed_Fist: 'fire',
  Open_Palm: 'shield',
  Victory: 'lightning',
  Thumb_Up: 'frost',
};

// Spells that hit the other wizard. Each one is charged into your hand and thrown.
// Attacks can be spammed: no cooldown and no limit. You only need to throw the orb
// you're holding first. Mana counts how many the AI judge scores, not how many you cast.
export const ATTACKS = ['fire', 'lightning', 'frost'];

// The shield is the one thing that can't be spammed: a brief barrier that pops up in
// front of you, stays only this long, and can be raised again this long after it went up.
export const SHIELD_UP_MS = 1400;
export const SHIELD_COOLDOWN_MS = 3000;

export const ELEMENT_ICONS = { fire: '✊', shield: '✋', lightning: '✌️', frost: '👍' };

// The emoji for a hand sign, so players can see at a glance what each one does.
export function gestureEmoji(gesture) {
  return ELEMENT_ICONS[GESTURE_ELEMENTS[gesture]] ?? '';
}

// Spells per match. Prune enforces this with its step limit.
// Guests get 8, Auth0 wizards 9, and wizards who passed the Ritual Gate 10.
export const MANA = { guest: 8, wizard: 9, ritualWizard: 10 };

// Power level: every signed-in wizard has one, saved on their Auth0 account, so their
// face and name bring them back to the level they left off at. It grows with every
// duel they finish, more for a win. Past 100 it just says MAX!!! It's a level to show
// and track, not a stat: it changes nothing in a duel.
export const POWER_START = 1;
export const POWER_CAP = 100;
export const POWER_GAIN = { played: 3, win: 4, draw: 1 };
// Shortest duel that counts toward power level, so nobody farms it by quitting at once.
export const POWER_MIN_DUEL_MS = 15_000;

export function powerGain({ won = false, draw = false } = {}) {
  return POWER_GAIN.played + (won ? POWER_GAIN.win : draw ? POWER_GAIN.draw : 0);
}

export function powerLabel(level) {
  if (!Number.isFinite(level)) return '';
  return level > POWER_CAP ? 'MAX!!!' : String(Math.max(0, Math.floor(level)));
}


// AI opponents. Each rank casts through Prune like a person, but the server keeps
// its spell power inside the rank's range, and the rank sets how fast and how
// cleverly it fights (src/bot.js).
export const BOT_RANKS = {
  easy: {
    label: 'Easy',
    title: 'Apprentice',
    mana: 7,
    power: [1, 4],
    thinkMs: [4500, 7000],
    blurb: 'Slow and clumsy. Weak spells, no plan.',
  },
  medium: {
    label: 'Medium',
    title: 'Sorcerer',
    mana: 8,
    power: [3, 7],
    thinkMs: [3000, 5000],
    blurb: 'Steady. Shields when hurt and zaps through your shield.',
  },
  hard: {
    label: 'Hard',
    title: 'Archmage',
    mana: 10,
    power: [6, 10],
    thinkMs: [2000, 3200],
    blurb: 'Fast and ruthless. Strong spells, reads your every move.',
  },
};

// The power an AI's spell lands with: the judge's score, kept inside its rank's range.
export function botPower(rank, power) {
  const [low, high] = BOT_RANKS[rank]?.power ?? [1, 10];
  return Math.min(high, Math.max(low, clampPower(power)));
}

export function clampPower(power) {
  const value = Math.round(Number(power));
  return Number.isFinite(value) ? Math.min(10, Math.max(1, value)) : 1;
}

export function spellEffect(element, power) {
  const p = clampPower(power);
  const none = { damage: 0, shield: 0, pierce: 0, heal: 0, freezeMs: 0 };
  if (element === 'fire') return { ...none, damage: 6 + 2 * p };
  if (element === 'lightning') return { ...none, damage: 4 + 2 * p, pierce: 0.5 };
  if (element === 'shield') return { ...none, shield: 8 + 3 * p };
  // Frost Shard: weaker hit, but it freezes the target. A shield that soaks all of it stops the freeze.
  if (element === 'frost') return { ...none, damage: Math.round(3 + 1.5 * p), freezeMs: FREEZE_BASE_MS + FREEZE_PER_POWER_MS * p };
  return none;
}

// What the judge's score adds on top of the instant base spell. Never negative:
// a weak incantation just earns no bonus.
export function judgeBonus(element, power) {
  const full = spellEffect(element, power);
  const base = spellEffect(element, BASE_POWER);
  return {
    damage: Math.max(0, full.damage - base.damage),
    shield: Math.max(0, full.shield - base.shield),
    heal: Math.max(0, full.heal - base.heal),
    freezeMs: Math.max(0, full.freezeMs - base.freezeMs),
    pierce: full.pierce,
  };
}



// Shields soak damage first. Lightning goes straight through half of a shield.
export function applyHit(target, damage, pierce = 0) {
  const pierced = Math.round(damage * pierce);
  const absorbed = Math.min(target.shield, damage - pierced);
  const dealt = damage - absorbed;
  return { hp: Math.max(0, target.hp - dealt), shield: target.shield - absorbed, absorbed, dealt };
}

export function addShield(current, amount) {
  return Math.min(MAX_SHIELD, current + amount);
}

// Higher HP wins. Equal HP is a draw (-1).
export function decideWinner(players) {
  const [left, right] = players;
  if (left.hp === right.hp) return -1;
  return left.hp > right.hp ? 0 : 1;
}

export const FALLBACK_WORDS = {
  fire: ['Ember of Biscayne, burn bright!', 'Calle Ocho fireworks, ignite!', 'Flame of the Everglades, rise!'],
  shield: ['Seawall of Miami, hold the tide!', 'Coral reef, guard me!', 'Hurricane shutters, close!'],
  lightning: ['Thunder over Brickell, strike!', 'Storm of the Keys, crash down!', 'Bolt from the Atlantic!'],
  frost: ['Freeze like a Brickell office in July!', 'Ice of the deep Atlantic, bind them!', 'Winter never comes to Miami, except for you!'],
};

// Never the same line twice in a row: Prune's loop guard blocks repeated identical spells.
const lastFallback = {};
export function pickFallback(element) {
  const list = (FALLBACK_WORDS[element] ?? ['Abracadabra!']).filter((line, _, all) => all.length === 1 || line !== lastFallback[element]);
  lastFallback[element] = list[Math.floor(Math.random() * list.length)];
  return lastFallback[element];
}
