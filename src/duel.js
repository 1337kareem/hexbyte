// The duel itself: who is casting, what each spell does when it lands, and who wins.
// Spells take several seconds to come back from Prune, so a player "channels" while
// waiting, and both players can have spells in the air at once.
import {
  BACKFIRE_DAMAGE,
  GESTURE_ELEMENTS,
  MATCH_SECONDS,
  MAX_HP,
  SHIELD_MS,
  addShield,
  applyHit,
  decideWinner,
  pickFallback,
} from '../shared/rules.js';

const COOLDOWN_MS = 900;
const FIRE_FLIGHT_MS = 700;
const BOLT_DELAY_MS = 250;
const END_DELAY_MS = 2600;

const now = () => performance.now();

export class Duel {
  // listen(side, element) resolves to the spoken or typed words, or null.
  // cast(body) sends the spell to the server and resolves to its reply.
  constructor({ match, listen, cast, onLog, onEnd }) {
    this.matchId = match.matchId;
    this.listen = listen;
    this.cast = cast;
    this.onLog = onLog;
    this.onEnd = onEnd;
    this.players = match.players.map((player) => ({
      ...player,
      hp: MAX_HP,
      shield: 0,
      shieldUntil: 0,
      manaLeft: player.mana,
      status: 'ready',
      element: null,
      words: '',
      auto: false,
      channelStart: 0,
      label: null,
    }));
    this.effects = [];
    this.floaters = [];
    this.banners = [];
    this.scheduled = [];
    this.pending = 0;
    this.expectedMs = 7000;
    this.startedAt = now();
    this.endsAt = this.startedAt + MATCH_SECONDS * 1000;
    this.over = false;
    this.winner = null;
  }

  async trigger(side, gesture) {
    const player = this.players[side];
    const element = GESTURE_ELEMENTS[gesture];
    if (this.over || !element || player.status !== 'ready' || player.manaLeft <= 0) return;

    player.status = 'listening';
    player.element = element;
    player.words = '';
    const heard = await this.listen(side, element);
    if (this.over) return;
    player.auto = !heard;
    player.words = heard || pickFallback(element);
    player.status = 'channeling';
    player.channelStart = now();

    this.pending += 1;
    let reply;
    try {
      reply = await this.cast({ matchId: this.matchId, side, gesture, words: player.words });
    } catch (error) {
      reply = { outcome: 'error', element, error: error.message };
    }
    this.pending -= 1;
    if (Number.isFinite(reply.latencyMs)) this.expectedMs = this.expectedMs * 0.7 + reply.latencyMs * 0.3;
    this.resolve(side, reply);
  }

  resolve(side, reply) {
    const player = this.players[side];
    const target = 1 - side;
    const t = now();
    this.onLog({ side, player: player.name, words: player.words, auto: player.auto, ...reply });

    if (reply.outcome === 'cast') {
      player.manaLeft -= 1;
      player.label = { text: `${reply.name} · ${reply.power}`, until: t + 2600 };
      if (!this.over) {
        if (reply.element === 'fire') {
          this.effects.push({ type: 'fireball', from: side, to: target, power: reply.power, start: t, duration: FIRE_FLIGHT_MS });
          this.at(t + FIRE_FLIGHT_MS, () => this.hit(target, reply.damage, reply.pierce));
        } else if (reply.element === 'lightning') {
          this.effects.push({ type: 'bolt', to: target, start: t, duration: 450 });
          this.at(t + BOLT_DELAY_MS, () => this.hit(target, reply.damage, reply.pierce));
        } else if (reply.element === 'shield') {
          player.shield = addShield(player.shield, reply.shield);
          player.shieldUntil = t + SHIELD_MS;
          this.effects.push({ type: 'shieldUp', side, start: t, duration: 700 });
          this.floaters.push({ side, text: `+${reply.shield} shield`, color: '#93c5fd', start: t });
        }
      }
    } else if (reply.outcome === 'cheat') {
      player.manaLeft -= 1;
      player.hp = Math.max(0, player.hp - BACKFIRE_DAMAGE);
      this.effects.push({ type: 'backfire', side, start: t, duration: 700 });
      this.floaters.push({ side, text: `-${BACKFIRE_DAMAGE}`, color: '#f87171', start: t });
      this.banner('BACKFIRE!', 'Prune caught a cheating incantation', '#f87171');
    } else if (reply.outcome === 'out_of_mana') {
      player.manaLeft = 0;
      this.banner('OUT OF MANA', `Prune stopped ${player.name}'s spell`, '#fbbf24');
    } else {
      this.banner('FIZZLE', reply.error ?? reply.blockedBy ?? 'The spell failed', '#a1a1aa', 1800);
    }

    if (player.manaLeft <= 0) {
      player.status = 'out';
    } else {
      player.status = 'cooldown';
      setTimeout(() => {
        if (player.status === 'cooldown') player.status = 'ready';
      }, COOLDOWN_MS);
    }
  }

  hit(side, damage, pierce) {
    if (this.over) return;
    const player = this.players[side];
    const result = applyHit(player, damage, pierce);
    player.hp = result.hp;
    player.shield = result.shield;
    const t = now();
    if (result.dealt > 0) this.floaters.push({ side, text: `-${result.dealt}`, color: '#fca5a5', start: t });
    if (result.absorbed > 0) this.floaters.push({ side, text: `${result.absorbed} blocked`, color: '#93c5fd', start: t + 150 });
  }

  at(time, run) {
    this.scheduled.push({ time, run });
  }

  banner(title, detail, color, duration = 2200) {
    this.banners.push({ title, detail, color, start: now(), duration });
  }

  // Called every animation frame.
  update(t = now()) {
    const due = this.scheduled.filter((event) => event.time <= t);
    this.scheduled = this.scheduled.filter((event) => event.time > t);
    due.forEach((event) => event.run());

    for (const player of this.players) {
      if (player.shield > 0 && t > player.shieldUntil) player.shield = 0;
    }
    this.effects = this.effects.filter((effect) => t - effect.start < effect.duration);
    this.floaters = this.floaters.filter((floater) => t - floater.start < 1200);
    this.banners = this.banners.filter((banner) => t - banner.start < banner.duration);

    if (!this.over) this.checkEnd(t);
  }

  checkEnd(t) {
    const [left, right] = this.players;
    let reason = null;
    if (left.hp <= 0 || right.hp <= 0) reason = 'KO!';
    else if (t >= this.endsAt) reason = 'TIME!';
    else if (left.status === 'out' && right.status === 'out' && this.pending === 0 && this.scheduled.length === 0) {
      reason = 'NO MANA LEFT';
    }
    if (!reason) return;

    this.over = true;
    this.winner = left.hp <= 0 && right.hp <= 0 ? -1 : left.hp <= 0 ? 1 : right.hp <= 0 ? 0 : decideWinner(this.players);
    const detail = this.winner === -1 ? 'A draw' : `${this.players[this.winner].name} wins`;
    this.banner(reason, detail, '#fde68a', END_DELAY_MS + 400);
    setTimeout(() => this.onEnd(this.result()), END_DELAY_MS);
  }

  result() {
    return {
      matchId: this.matchId,
      winner: this.winner,
      finalHp: this.players.map((player) => player.hp),
      players: this.players.map(({ name, kind, picture, hp, mana, manaLeft }) => ({ name, kind, picture, hp, mana, manaLeft })),
    };
  }

  timeLeft(t = now()) {
    return Math.max(0, Math.ceil((this.endsAt - t) / 1000));
  }

  channelProgress(side, t = now()) {
    const player = this.players[side];
    if (player.status !== 'channeling') return 0;
    return Math.min(0.95, (t - player.channelStart) / this.expectedMs);
  }
}
