// Duel rules shared by the server (which decides what a spell does) and the
// browser (which animates it). The AI only suggests a power from 1 to 10;
// these rules decide everything else, so a clever incantation can't break them.
export const MAX_HP = 100;
export const BACKFIRE_DAMAGE = 12;
export const SHIELD_MS = 15000;
export const MAX_SHIELD = 45;
export const MATCH_SECONDS = 150;

// The gesture picks the element. The AI never gets to change it.
export const GESTURE_ELEMENTS = {
  Closed_Fist: 'fire',
  Open_Palm: 'shield',
  Victory: 'lightning',
};

export const ELEMENT_ICONS = { fire: '✊', shield: '✋', lightning: '✌️' };

// Spells per match. Prune enforces this with its step limit.
export const MANA = { guest: 5, wizard: 6, runeWizard: 7 };

export function clampPower(power) {
  const value = Math.round(Number(power));
  return Number.isFinite(value) ? Math.min(10, Math.max(1, value)) : 1;
}

export function spellEffect(element, power) {
  const p = clampPower(power);
  if (element === 'fire') return { damage: 6 + 2 * p, shield: 0, pierce: 0 };
  if (element === 'lightning') return { damage: 4 + 2 * p, shield: 0, pierce: 0.5 };
  if (element === 'shield') return { damage: 0, shield: 8 + 3 * p, pierce: 0 };
  return { damage: 0, shield: 0, pierce: 0 };
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
};

export function pickFallback(element) {
  const list = FALLBACK_WORDS[element] ?? ['Abracadabra!'];
  return list[Math.floor(Math.random() * list.length)];
}
