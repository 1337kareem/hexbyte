// The AI opponent. It plays Player 2 through the same duel rules as a person:
// it picks a gesture, "says" an incantation, and its spell goes through Prune to be
// judged. Its rank decides how often it casts, how well it picks, and (on the
// server) how strong its spells can land.
import { BOT_RANKS } from '../shared/rules.js';
import { zonePoint } from './pose.js';

export const ELEMENT_GESTURES = {
  fire: 'Closed_Fist',
  shield: 'Open_Palm',
  lightning: 'Victory',
  frost: 'Thumb_Up',
};

// Each rank talks like its skill level. The judge rates creativity, so better lines help too.
const LINES = {
  easy: {
    fire: ['Fire. Go.', 'Um, hot stuff?', 'Burn, I guess.', 'Flame spell number one.'],
    shield: ['Block, please.', 'Wall thing!', 'Ow, stop.'],
    lightning: ['Zap.', 'Bzzt.', 'Lightning, maybe?'],
    frost: ['Cold.', 'Brr, ice?', 'Chilly spell.'],
  },
  medium: {
    fire: ['Flames of Little Havana, rise!', 'Coconut Grove, catch fire!', 'Ember of Biscayne, burn bright!'],
    shield: ['Coral reef, guard me!', 'Hurricane shutters, close!', 'Seawall of Miami, hold the tide!'],
    lightning: ['Thunder over Brickell, strike!', 'Storm of the Keys, crash down!', 'Bolt from the Atlantic!'],
    frost: ['Ice of the deep Atlantic, bind them!', 'Freeze like a Brickell office in July!', 'Hailstorm over the Keys!'],
  },
  hard: {
    fire: [
      'By the neon of Ocean Drive and the heat of a July noon, let the sky rain molten sunsets on you!',
      'I brew the sun into a cafecito and pour it, scalding, down upon my foe!',
      'Calle Ocho drums, wake the volcano under the Everglades and let it roar!',
    ],
    shield: [
      'Mangroves of Biscayne, weave your roots into armor no storm has ever broken!',
      'Ten thousand hurricane seasons stand behind me as one unbreakable wall!',
    ],
    lightning: [
      'The Category Five in my veins answers only to me: split the sky and find your shield!',
      'Every storm that ever hit the Keys, I call you home through this one bolt!',
    ],
    frost: [
      'I pull the cold from the bottom of the Gulf Stream and nail your feet to the floor with it!',
      'Let a blizzard fall on Biscayne Bay for the first time in history, and let it fall on you!',
    ],
  },
};

const pick = (list, random) => list[Math.floor(random() * list.length)];
const between = ([low, high], random) => low + random() * (high - low);

// What to throw next. me and foe are duel players. Shields are only for defense now.
export function chooseElement(rank, me, foe, random = Math.random, t = performance.now()) {
  if (rank === 'easy') {
    const roll = random();
    return roll < 0.55 ? 'fire' : roll < 0.8 ? 'lightning' : 'frost';
  }
  if (rank === 'medium') {
    if ((foe.barrierUntil ?? 0) > t) return 'lightning';
    const roll = random();
    return roll < 0.55 ? 'fire' : roll < 0.8 ? 'lightning' : 'frost';
  }
  // Hard: when you shield, lightning (it strikes from the sky a beat later, after the
  // shield drops), and freeze you when it can.
  if ((foe.barrierUntil ?? 0) > t) return 'lightning';
  if ((foe.frozenUntil ?? 0) <= t && random() < 0.35) return 'frost';
  return 'fire';
}

// Where on your body each rank aims, and how steady its hand is.
const AIM = {
  easy: { head: 0.05, torso: 0.6, spread: 0.12, delay: [1200, 2000], dodge: 0.15, shield: 0.2 },
  medium: { head: 0.2, torso: 0.65, spread: 0.06, delay: [700, 1300], dodge: 0.45, shield: 0.3 },
  hard: { head: 0.6, torso: 0.35, spread: 0.025, delay: [350, 800], dodge: 0.75, shield: 0.4 },
};

export function pickZone(rank, random = Math.random) {
  const aim = AIM[rank] ?? AIM.medium;
  const roll = random();
  return roll < aim.head ? 'head' : roll < aim.head + aim.torso ? 'torso' : 'limb';
}

export function incantation(rank, element, random = Math.random, used = new Set()) {
  const lines = LINES[rank]?.[element] ?? LINES.medium[element];
  const fresh = lines.filter((line) => !used.has(line));
  let line = fresh.length ? pick(fresh, random) : `${pick(lines, random)} ${pick(ENCORES, random)}`;
  for (let n = 2; used.has(line); n += 1) line = `${pick(lines, random)} Encore number ${n}!`;
  used.add(line);
  return line;
}

const ENCORES = ['Again!', 'Once more, with feeling!', 'And twice as bright!', 'Remember this one?'];

export class Bot {
  constructor({ duel, side = 1, rank, random = Math.random }) {
    this.duel = duel;
    this.side = side;
    this.rank = BOT_RANKS[rank] ? rank : 'medium';
    this.aim = AIM[this.rank];
    this.random = random;
    this.timer = null;
    this.throwTimer = null;
    this.watcher = null;
    this.stopped = false;
    this.used = new Set();
    this.seen = new Set();
  }

  start() {
    // A short pause at the start so the human gets the first move.
    this.later(between(BOT_RANKS[this.rank].thinkMs, this.random) + 1000);
    this.watcher = setInterval(() => this.defend(), 80);
  }

  later(ms) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => this.think(), ms);
  }

  async think() {
    const { duel, side } = this;
    if (this.stopped || duel.over) return;
    const me = duel.players[side];
    const foe = duel.players[1 - side];
    if (duel.isFrozen(side)) {
      this.later(me.frozenUntil - performance.now() + 300);
      return;
    }
    if (me.status !== 'ready') {
      this.later(400);
      return;
    }
    const element = chooseElement(this.rank, me, foe, this.random);
    const fired = await duel.fire(side, ELEMENT_GESTURES[element], incantation(this.rank, element, this.random, this.used));
    if (!fired) {
      this.later(500);
      return;
    }
    clearTimeout(this.throwTimer);
    this.throwTimer = setTimeout(() => this.throwOrb(), between(this.aim.delay, this.random));
    this.later(between(BOT_RANKS[this.rank].thinkMs, this.random) + this.aim.delay[1]);
  }

  // Aims at a body part (with a less or more steady hand) and throws.
  throwOrb() {
    const { duel, side } = this;
    if (this.stopped || duel.over || duel.players[side].status !== 'armed') return;
    const t = performance.now();
    const me = duel.bodyOf(side, t);
    const foe = duel.bodyOf(1 - side, t);
    const toward = side === 0 ? 1 : -1;
    // The hand nearer the opponent holds the orb.
    const hand = (me[15].x - me[16].x) * toward > 0 ? me[15] : me[16];
    const target = zonePoint(foe, pickZone(this.rank, this.random));
    const wobble = (this.random() * 2 - 1) * this.aim.spread;
    duel.throwOrb(side, hand, { x: target.x - hand.x, y: target.y + wobble - hand.y });
  }

  // Watches incoming orbs and lightning marks. Just before one lands, maybe shield, jump or duck.
  defend() {
    const { duel, side } = this;
    if (this.stopped || duel.over) return;
    const t = performance.now();
    const body = duel.bodyOf(side, t);
    const chestX = (body[11].x + body[12].x) / 2;
    const shoulderY = Math.min(body[11].y, body[12].y);
    const hipY = Math.max(body[23].y, body[24].y);
    const incoming = [
      ...duel.projectiles.map((orb) => ({ ...orb, secondsAway: (Math.abs(chestX - orb.x) * duel.aspect) / (Math.abs(orb.vx) || 1) })),
      ...(duel.strikes ?? []).map((strike) => ({ ...strike, secondsAway: (strike.at - t) / 1000 })),
    ];
    for (const orb of incoming) {
      if (orb.side === side || this.seen.has(orb.castId)) continue;
      if (orb.secondsAway > 0.4) continue;
      this.seen.add(orb.castId);
      if (this.random() >= this.aim.dodge) continue;
      const shieldReady = duel.players[side].barrierReadyAt <= t;
      // Head high: duck under it. Leg high: jump over it. Chest high: ducking would
      // put the head in the way, so shield if it can, or jump and take it on the legs.
      if (orb.y < shoulderY - 0.02) {
        if (shieldReady && this.random() < this.aim.shield) duel.raiseShield(side, t, orb.y);
        else duel.dodge(side, 'duck');
      } else if (orb.y > hipY) {
        duel.dodge(side, 'jump');
      } else if (shieldReady) {
        duel.raiseShield(side, t, orb.y);
      } else {
        duel.dodge(side, 'jump');
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.throwTimer);
    clearInterval(this.watcher);
  }
}
