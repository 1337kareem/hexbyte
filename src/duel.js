// The duel itself: casting, throwing, dodging, hits, and who wins.
//
// An attack works like this: hold a gesture, say the incantation, and a charged orb
// appears in your hand at base power. Throw it (a real arm swing on camera, or the
// spell key again on the keyboard) and it flies in a straight line. It hits whatever
// body part it touches: head ×1.5, torso ×1, arms and legs ×0.75. Anyone can jump or
// duck out of the way, or pop a brief shield barrier. Attacks can be spammed: throw
// your orb and you can cast again right away, as often as you like. The shield is the
// only thing with a cooldown. Mana is how many spells the AI judge scores (Prune's
// step limit); after that, attacks still come, at once, at base power.
//
// The AI judge (Gemini through Prune) scores the incantation a few seconds later.
// If the orb is still in your hand or in the air, it grows to the judged power. If it
// already hit, the extra lands on the same spot. If it missed, the bonus is lost.

import {
  ATTACKS,
  BACKFIRE_DAMAGE,
  BASE_POWER,
  GESTURE_ELEMENTS,
  MATCH_SECONDS,
  MAX_HP,
  SHIELD_COOLDOWN_MS,
  SHIELD_UP_MS,
  applyHit,
  decideWinner,
  pickFallback,
  spellEffect,
} from '../shared/rules.js';
import { ZONE_MULTIPLIERS, dodgePose, hitZone, standingPose, zonePoint } from './pose.js';

const END_DELAY_MS = 2600;
// An orb you never throw fizzles after this long (its mana is already spent).
// An orb stays in the wizard's hand until they throw it. Nothing ever throws it for them.
// Orb speed in frame heights per second: fast, but you can see it coming.
export const ORB_SPEED = 1.1;
// ✌️ Lightning doesn't fly: it strikes down from the sky where it was thrown. A target
// mark shows the spot first, and the bolt lands this long after the throw. Time enough
// to see it coming and move, jump, duck or shield, but still the fastest attack.
export const STRIKE_DELAY_MS = 450;
// A bolt hits a little wider than an orb.
const STRIKE_SPLASH = 0.03;
// A hit that lands before the judge's creativity score waits this long for it, so the
// damage matches how creative the spell was. After that it deals base damage.
export const JUDGE_WAIT_MS = 3000;
// Keyboard and AI dodges. A new one can start as soon as the last one ends.
const JUMP_MS = 650;
const DUCK_MS = 700;
// The shield is an arc in front of the wizard: this wide either side of where it's
// aimed, reaching this many shoulder-widths out (at least SHIELD_MIN_REACH).
// 15° either side: a third of the old 45°, so it has to be aimed at the incoming throw.
export const SHIELD_HALF_ANGLE = Math.PI / 12;
const SHIELD_REACH = 1.6;
const SHIELD_MIN_REACH = 0.11;
// It can tilt up or down this far from straight ahead.
const SHIELD_MAX_TILT = Math.PI / 3;
// The AI opponent "says" its incantation for this long before its orb appears.
const SPEAK_MS = 800;
const GOLD = '#facc15';
const MUTED = '#94a3b8';

const now = () => performance.now();

export class Duel {
  // listen(side, element) resolves to the spoken or typed words, or null.
  // cast(body) sends the spell to the server and resolves to its reply.
  // bodyOf(side, t) gives each wizard's pose (camera or standing); hits use it.
  // onEvent(name, details) hears every moment worth a sound.
  // waitForStart: true holds everything (and the clock) until begin(), for the opening
  // ritual and the 3-2-1 countdown.
  // judgeWaitMs: 0 deals base damage at once on a hit before the verdict (and adds any bonus later).
  constructor({ match, listen, cast, onLog, onEnd, onEvent = () => {}, speakMs = SPEAK_MS, bodyOf = null, waitForStart = false, judgeWaitMs = JUDGE_WAIT_MS }) {
    this.matchId = match.matchId;
    this.speakMs = speakMs;
    this.judgeWaitMs = judgeWaitMs;
    this.listen = listen;
    this.cast = cast;
    this.onLog = onLog;
    this.onEnd = onEnd;
    this.onEvent = onEvent;
    this.bodyOf = bodyOf ?? ((side, t) => this.standingBody(side, t));
    // Frame width over height. main.js keeps it in step with the screen.
    this.aspect = 16 / 9;
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
      label: null,
      // A charged orb in hand: { castId, element, power, at, aim, hand, gripped, prompt }.
      orb: null,
      // The brief shield arc, where it's aimed (a height on screen), and when it can go up again.
      barrierUntil: 0,
      barrierReadyAt: 0,
      shieldAimY: null,
      // A keyboard or AI jump or duck: { kind, start, until }.
      move: null,
      // Frost Shard: until this time, the wizard can't start a spell.
      frozenUntil: 0,
      // Spells whose verdict hasn't come back yet.
      judging: 0,
      // For the end-of-duel scorecard (and the Duel Ledger).
      stats: { thrown: 0, hits: 0, blocks: 0, damage: 0 },
    }));
    this.casts = new Map();
    // The judge's signed ratings, handed back at the end for the creativity scores.
    this.ratings = [];
    this.castCount = 0;
    this.projectiles = [];
    // Lightning on its way down: { castId, side, x, y, start, at }.
    this.strikes = [];
    this.effects = [];
    this.floaters = [];
    this.banners = [];
    this.scheduled = [];
    this.pending = 0;
    this.startedAt = now();
    this.lastUpdate = this.startedAt;
    this.endsAt = this.startedAt + MATCH_SECONDS * 1000;
    this.over = false;
    this.winner = null;
    this.live = !waitForStart;
  }

  // BATTLE! The clock starts now.
  begin(t = now()) {
    if (this.live || this.over) return;
    this.live = true;
    this.startedAt = t;
    this.lastUpdate = t;
    this.endsAt = t + MATCH_SECONDS * 1000;
    this.onEvent('battle', {});
  }

  // A wizard with no camera body: the standing pose, plus any jump or duck.
  standingBody(side, t = now()) {
    const player = this.players[side];
    return dodgePose(standingPose(side, t, player.status), player.move, t);
  }

  // Casts a spell and waits for the judge's verdict too.
  async trigger(side, gesture, words = null) {
    const fired = await this.fire(side, gesture, words);
    await fired?.judged;
  }

  // Starts a spell. A shield goes up at once. An attack listens for the
  // incantation, then puts a charged orb in the wizard's hand and resolves.
  // `judged` settles when the verdict has been applied.
  async fire(side, gesture, words = null) {
    const player = this.players[side];
    const element = GESTURE_ELEMENTS[gesture];
    if (!this.live || this.over || !element || this.isFrozen(side)) return null;
    if (element === 'shield') return this.raiseShield(side);
    // No limit on attacks: the only wait is throwing the orb already in hand.
    if (player.status !== 'ready') return null;
    // While there's mana, the AI judge scores the spell, so it listens for an
    // incantation. Out of mana, the orb comes at once, unjudged, at base power.
    const judging = player.manaLeft > 0;

    player.element = element;
    player.status = 'listening';
    player.words = words ?? '';
    let heard = judging ? words : null;
    if (judging && words) {
      await new Promise((resolve) => setTimeout(resolve, this.speakMs));
    } else if (judging) {
      this.onEvent('listening', { side, element });
      heard = await this.listen(side, element);
      this.onEvent('listened', { side });
    }
    if (this.over) return null;
    player.auto = !heard;
    player.words = heard || pickFallback(element);

    // Mana is spent now, because the judge's call goes through Prune, which counts
    // it against the wizard's step limit.
    const t = now();
    if (judging) player.manaLeft -= 1;
    const castId = (this.castCount += 1);
    // judging: the creativity score is on its way, and it sets this spell's power.
    const cast = { castId, side, element, power: BASE_POWER, effect: spellEffect(element, BASE_POWER), state: 'held', judging };
    this.casts.set(castId, cast);
    player.orb = { castId, element, power: BASE_POWER, at: null, aim: null, hand: null };
    player.status = 'armed';
    this.onEvent('armed', { side, element });
    if (!judging) {
      cast.unjudged = true;
      return { judged: Promise.resolve(), castId };
    }

    // The judge: Prune, then Gemini, in the background.
    player.judging += 1;
    this.pending += 1;
    const judged = Promise.resolve()
      .then(() => this.cast({ matchId: this.matchId, side, gesture, words: player.words }))
      .catch((error) => ({ outcome: 'error', element, error: error.message }))
      .then((reply) => {
        this.pending -= 1;
        player.judging -= 1;
        cast.judging = false;
        this.verdict(castId, player.words, reply);
      });
    return { judged, castId };
  }

  // Throws the orb in hand from `from` in direction `dir` (frame coordinates).
  throwOrb(side, from, dir) {
    const player = this.players[side];
    const orb = player.orb;
    if (this.over || player.status !== 'armed' || !orb || !from) return false;
    const dx = (dir?.x ?? (side === 0 ? 1 : -1)) * this.aspect;
    const dy = dir?.y ?? 0;
    const length = Math.hypot(dx, dy) || 1;
    // Never backwards: an orb always heads toward the opponent's side.
    const toward = side === 0 ? 1 : -1;
    let ux = dx / length;
    const uy = dy / length;
    if (ux * toward < 0.35) ux = 0.35 * toward;
    const cast = this.casts.get(orb.castId);
    const t = now();
    if (orb.element === 'lightning') {
      // Where the throw crosses the opponent is where the sky strikes.
      const spot = this.strikeSpot(side, from, ux, uy, t);
      this.strikes.push({ castId: orb.castId, side, element: 'lightning', x: spot.x, y: spot.y, start: t, at: t + STRIKE_DELAY_MS });
    } else {
      this.projectiles.push({
        castId: orb.castId,
        side,
        element: orb.element,
        power: cast.power,
        x: from.x,
        y: from.y,
        vx: ux * ORB_SPEED,
        vy: uy * ORB_SPEED,
        radius: orbRadius(cast.power),
        trail: [],
        born: t,
      });
    }
    cast.state = 'flying';
    player.stats.thrown += 1;
    player.orb = null;
    player.label = null;
    this.onEvent('throw', { side, element: orb.element, power: cast.power });
    this.settle(side);
    return true;
  }

  // ✋ The shield: an arc pulled out in front of the wizard, for a moment. aimY is the
  // height (on screen) it points at; on camera it follows the open palm.
  raiseShield(side, t = now(), aimY = null) {
    const player = this.players[side];
    if (!this.live || this.over || player.status === 'listening' || player.barrierReadyAt > t) return null;
    player.barrierUntil = t + SHIELD_UP_MS;
    player.barrierReadyAt = t + SHIELD_COOLDOWN_MS;
    player.shieldAimY = aimY;
    this.effects.push({ type: 'shieldUp', side, start: t, duration: 500 });
    this.onEvent('cast', { side, element: 'shield' });
    return { judged: Promise.resolve() };
  }

  // The shield arc: centered on the chest, reaching out toward the opponent, tilted
  // toward where it's aimed. Throws that come in outside the arc get through.
  barrier(side, t = now()) {
    const player = this.players[side];
    if (player.barrierUntil <= t) return null;
    const body = this.bodyOf(side, t);
    if (!body?.[11] || !body[12] || !body[23] || !body[24]) return null;
    const facing = side === 0 ? 1 : -1;
    const cx = (body[11].x + body[12].x) / 2;
    const cy = (body[11].y + body[12].y + body[23].y + body[24].y) / 4;
    const shoulders = Math.abs(body[11].x - body[12].x) * this.aspect || 0.08;
    const r = Math.max(SHIELD_MIN_REACH, shoulders * SHIELD_REACH);
    const aimY = player.shieldAimY ?? cy;
    const tilt = Math.max(-SHIELD_MAX_TILT, Math.min(SHIELD_MAX_TILT, Math.atan2(aimY - cy, r)));
    return { cx, cy, r, angle: facing === 1 ? tilt : Math.PI - tilt, span: SHIELD_HALF_ANGLE, aspect: this.aspect };
  }

  // Keyboard and AI dodges: jump (clears low throws) or duck (clears high ones).
  // No cooldown: a new one can start once the current one is over.
  dodge(side, kind, t = now()) {
    const player = this.players[side];
    if (!this.live || this.over || (player.move && t < player.move.until) || this.isFrozen(side)) return false;
    player.move = { kind, start: t, until: t + (kind === 'jump' ? JUMP_MS : DUCK_MS) };
    this.onEvent('dodge', { side, kind });
    return true;
  }

  // After a throw: ready to cast again at once, mana or not.
  settle(side) {
    const player = this.players[side];
    player.status = 'ready';
  }

  // The judge's verdict on a cast.
  verdict(castId, words, reply) {
    const cast = this.casts.get(castId);
    const { side, element } = cast;
    const player = this.players[side];
    const t = now();
    this.onLog({ side, player: player.name, words, auto: player.auto, ...reply, castId, landed: cast.state, zone: cast.zone });
    if (typeof reply?.rating === 'string') this.ratings.push(reply.rating);
    if (this.over) return;

    if (reply.outcome === 'cast') {
      const power = reply.power;
      const bonus = reply.bonus ?? {};
      const score = Number.isFinite(reply.creativity) ? `Creativity ${reply.creativity}` : `Judge ${power}/10`;
      if (cast.state === 'held' || cast.state === 'flying' || cast.pendingHit) {
        // The judge sets the spell's power, up for a creative incantation, down for a lazy one.
        cast.power = power;
        cast.effect = spellEffect(element, cast.power);
        if (player.orb?.castId === castId) player.orb.power = cast.power;
        const flying = this.projectiles.find((p) => p.castId === castId);
        if (flying) {
          flying.power = cast.power;
          flying.radius = orbRadius(cast.power);
        }
        const text = power > BASE_POWER ? `${score}: power up!` : power < BASE_POWER ? `${score}: weak spell` : score;
        this.floaters.push({ side, text, color: power > BASE_POWER ? GOLD : MUTED, start: t });
        // It already hit and was waiting for this: the damage lands now, at the judged power.
        if (cast.pendingHit) this.applyHit(cast, t);
      } else if (cast.state === 'hit' && bonus.damage > 0) {
        // Already hit: the extra lands on the same spot, with the same multiplier.
        const extra = Math.max(1, Math.round(bonus.damage * cast.multiplier));
        this.floaters.push({ side, text: `Judge +${extra}`, color: GOLD, start: t });
        this.onEvent('cast', { side, element, power, bonus: true });
        const result = this.hit(cast.target, extra, 0, element, cast.zone);
        player.stats.damage += result?.dealt ?? 0;
        if (element === 'frost' && result?.dealt > 0) this.freeze(cast.target, bonus.freezeMs, { extend: true });
        this.onEvent('landed', { castId, side, target: cast.target, element, power, zone: cast.zone, damage: result?.dealt ?? 0, bonus: true });
      } else {
        const why = cast.state === 'hit' ? '' : `: ${cast.state}`;
        this.floaters.push({ side, text: `${power}/10${why}`, color: MUTED, start: t });
      }
    } else if (reply.outcome === 'cheat') {
      // A cheater's orb crumbles in their hand (or in the air), and it backfires.
      // A hit that was waiting for this verdict does nothing.
      cast.pendingHit = null;
      this.destroyCast(castId, 'fizzled');
      player.hp = Math.max(0, player.hp - BACKFIRE_DAMAGE);
      this.effects.push({ type: 'backfire', side, start: t, duration: 700 });
      this.floaters.push({ side, text: `-${BACKFIRE_DAMAGE}`, color: '#f87171', start: t });
      this.banner('BACKFIRE!', 'Prune caught a cheating incantation', '#f87171');
      this.onEvent('backfire', { side, hp: player.hp });
    } else if (reply.outcome === 'out_of_mana') {
      if (cast.pendingHit) this.applyHit(cast, t);
      player.manaLeft = 0;
      this.banner('OUT OF MANA', `No more judging for ${player.name}: attacks fly at base power`, '#fbbf24');
      this.onEvent('outOfMana', { side });
    } else {
      // The orb is still real; it just stays at base power.
      if (cast.pendingHit) this.applyHit(cast, t);
      this.floaters.push({ side, text: 'No verdict', color: MUTED, start: t });
      this.onEvent('fizzle', { side });
    }
  }

  destroyCast(castId, state) {
    const cast = this.casts.get(castId);
    if (!cast) return;
    const player = this.players[cast.side];
    if (player.orb?.castId === castId) {
      player.orb = null;
      this.settle(cast.side);
    }
    this.projectiles = this.projectiles.filter((p) => p.castId !== castId);
    this.strikes = this.strikes.filter((strike) => strike.castId !== castId);
    if (cast.state === 'held' || cast.state === 'flying') cast.state = state;
  }

  // Returns what the hit did, so a frost hit can follow up with its freeze.
  hit(side, damage, pierce, element, zone = null) {
    if (this.over) return null;
    const player = this.players[side];
    const result = applyHit(player, damage, pierce);
    player.hp = result.hp;
    player.shield = result.shield;
    const t = now();
    if (result.dealt > 0) {
      const headshot = zone === 'head' && element !== 'lightning';
      const text = headshot ? `HEADSHOT -${result.dealt}` : zone === 'limb' ? `-${result.dealt} limb` : `-${result.dealt}`;
      this.floaters.push({ side, text, color: headshot ? GOLD : '#fca5a5', start: t });
    }
    if (result.absorbed > 0) this.floaters.push({ side, text: `${result.absorbed} blocked`, color: '#93c5fd', start: t + 150 });
    this.onEvent('hit', { side, element, zone, dealt: result.dealt, absorbed: result.absorbed, hp: player.hp });
    return result;
  }

  freeze(side, ms, { extend = false } = {}) {
    if (this.over || !ms) return;
    const player = this.players[side];
    const t = now();
    // The judge's bonus adds to a freeze that's still going.
    player.frozenUntil = extend ? Math.max(player.frozenUntil, t) + ms : Math.max(player.frozenUntil, t + ms);
    this.floaters.push({ side, text: 'Frozen!', color: '#bae6fd', start: t + 200 });
    this.onEvent('freeze', { side, ms });
  }

  isFrozen(side, t = now()) {
    return this.players[side].frozenUntil > t;
  }

  at(time, run) {
    this.scheduled.push({ time, run });
  }

  banner(title, detail, color, duration = 2200) {
    this.banners.push({ title, detail, color, start: now(), duration });
  }

  // Moves the orbs in the air and checks what they hit.
  // The spot a lightning throw is aimed at: follow the throw (a direction, with x scaled
  // by the aspect) to the opponent's body, and take its height there.
  strikeSpot(side, from, ux, uy, t) {
    const foe = this.bodyOf(1 - side, t);
    const x = foe?.[11] && foe[23] ? zonePoint(foe, 'torso').x : side === 0 ? 0.75 : 0.25;
    const run = ux / this.aspect;
    const steps = Math.abs(run) > 1e-6 ? (x - from.x) / run : 0;
    const y = from.y + uy * Math.max(0, steps);
    return { x, y: Math.min(0.97, Math.max(0.03, y)) };
  }

  // Lightning that's due comes down: blocked by a raised shield, a hit on whatever is
  // under it, or a miss if the target moved away.
  resolveStrikes(t) {
    const keep = [];
    for (const strike of this.strikes) {
      if (t < strike.at) {
        keep.push(strike);
        continue;
      }
      const cast = this.casts.get(strike.castId);
      const target = 1 - strike.side;
      const point = { x: strike.x, y: strike.y };
      const radius = orbRadius(cast.power) + STRIKE_SPLASH;
      this.effects.push({ type: 'strike', point, start: t, duration: 420 });
      // A bolt is stopped by a shield aimed at the height it comes down at (within reach).
      if (arcCovers(this.barrier(target, t), point, this.aspect, radius)) {
        cast.state = 'blocked';
        this.players[target].stats.blocks += 1;
        this.effects.push({ type: 'impact', point, element: 'shield', start: t, duration: 450 });
        this.floaters.push({ side: target, text: 'BLOCKED!', color: '#93c5fd', start: t });
        this.onEvent('blocked', { side: target, by: strike.side, castId: strike.castId, element: 'lightning' });
        continue;
      }
      const zone = hitZone(this.bodyOf(target, t), point, radius, this.aspect);
      if (zone) {
        this.land({ ...strike, power: cast.power }, cast, target, zone, t);
        continue;
      }
      cast.state = 'missed';
      this.floaters.push({ side: target, text: 'Missed!', color: MUTED, start: t });
      this.onEvent('miss', { side: strike.side });
    }
    this.strikes = keep;
  }

  moveProjectiles(t) {
    const dt = Math.min(0.05, Math.max(0, (t - this.lastUpdate) / 1000));
    const keep = [];
    for (const orb of this.projectiles) {
      const before = { x: orb.x, y: orb.y };
      orb.trail.push({ x: orb.x, y: orb.y });
      if (orb.trail.length > 9) orb.trail.shift();
      orb.x += (orb.vx / this.aspect) * dt;
      orb.y += orb.vy * dt;
      const target = 1 - orb.side;
      const cast = this.casts.get(orb.castId);

      // The target's shield arc blocks any orb that comes in through it.
      const blockedAt = arcCrossing(this.barrier(target, t), before, orb, this.aspect, orb.radius);
      if (blockedAt) {
        cast.state = 'blocked';
        this.players[target].stats.blocks += 1;
        this.effects.push({ type: 'impact', point: blockedAt, element: 'shield', start: t, duration: 450 });
        this.floaters.push({ side: target, text: 'BLOCKED!', color: '#93c5fd', start: t });
        this.onEvent('blocked', { side: target, by: orb.side, castId: orb.castId, element: orb.element });
        continue;
      }

      const zone = hitZone(this.bodyOf(target, t), orb, orb.radius, this.aspect);
      if (zone) {
        this.land(orb, cast, target, zone, t);
        continue;
      }
      if (orb.x < -0.15 || orb.x > 1.15 || orb.y < -0.3 || orb.y > 1.3) {
        cast.state = 'missed';
        this.floaters.push({ side: target, text: 'Missed!', color: MUTED, start: t });
        this.onEvent('miss', { side: orb.side });
        continue;
      }
      keep.push(orb);
    }
    this.projectiles = keep;
  }

  land(orb, cast, target, zone, t) {
    // Lightning comes down from above, so it has no headshot bonus: a head strike counts as a body hit.
    const multiplier = orb.element === 'lightning' && zone === 'head' ? ZONE_MULTIPLIERS.torso : ZONE_MULTIPLIERS[zone];
    Object.assign(cast, { state: 'hit', zone, multiplier, target });
    this.effects.push({ type: 'impact', point: { x: orb.x, y: orb.y }, element: orb.element, zone, start: t, duration: 500 });
    this.players[orb.side].stats.hits += 1;
    // The judge hasn't scored it yet: the damage waits for the creativity score.
    if (cast.judging && this.judgeWaitMs > 0) {
      cast.pendingHit = { t };
      this.floaters.push({ side: target, text: 'Hit! Judging…', color: MUTED, start: t });
      return;
    }
    this.applyHit(cast, t);
  }

  // Deals a landed spell's damage at its current power (judged, or base).
  applyHit(cast, t) {
    cast.pendingHit = null;
    const effect = spellEffect(cast.element, cast.power);
    const damage = Math.max(1, Math.round(effect.damage * cast.multiplier));
    const result = this.hit(cast.target, damage, 0, cast.element, cast.zone);
    this.players[cast.side].stats.damage += result?.dealt ?? 0;
    if (cast.element === 'frost' && result?.dealt > 0) this.freeze(cast.target, effect.freezeMs);
    this.onEvent('landed', { castId: cast.castId, side: cast.side, target: cast.target, element: cast.element, power: cast.power, zone: cast.zone, damage: result?.dealt ?? 0 });
  }

  // Called every animation frame.
  update(t = now()) {
    const due = this.scheduled.filter((event) => event.time <= t);
    this.scheduled = this.scheduled.filter((event) => event.time > t);
    due.forEach((event) => event.run());

    if (!this.over) {
      this.moveProjectiles(t);
      this.resolveStrikes(t);
      // A hit still waiting on a slow judge deals base damage after JUDGE_WAIT_MS.
      for (const cast of this.casts.values()) {
        if (cast.pendingHit && t - cast.pendingHit.t >= this.judgeWaitMs) this.applyHit(cast, t);
      }
    }
    this.lastUpdate = t;

    for (const [side, player] of this.players.entries()) {
      if (player.shield > 0 && t > player.shieldUntil) player.shield = 0;
      if (player.move && t >= player.move.until) player.move = null;
    }
    this.effects = this.effects.filter((effect) => t - effect.start < effect.duration);
    this.floaters = this.floaters.filter((floater) => t - floater.start < 1200);
    this.banners = this.banners.filter((banner) => t - banner.start < banner.duration);

    if (!this.over && this.live) this.checkEnd(t);
  }

  checkEnd(t) {
    const [left, right] = this.players;
    let reason = null;
    // Attacks never run out, so a duel ends with a knockout or the clock.
    if (left.hp <= 0 || right.hp <= 0) reason = 'KO!';
    else if (t >= this.endsAt) reason = 'TIME!';
    if (!reason) return;

    this.over = true;
    this.projectiles = [];
    this.strikes = [];
    this.players.forEach((player) => (player.orb = null));
    this.winner = left.hp <= 0 && right.hp <= 0 ? -1 : left.hp <= 0 ? 1 : right.hp <= 0 ? 0 : decideWinner(this.players);
    const detail = this.winner === -1 ? 'A draw' : `${this.players[this.winner].name} wins`;
    this.banner(reason, detail, '#fde68a', END_DELAY_MS + 400);
    this.onEvent('end', { winner: this.winner, knockout: reason === 'KO!' });
    setTimeout(() => this.onEnd(this.result()), END_DELAY_MS);
  }

  result() {
    return {
      matchId: this.matchId,
      winner: this.winner,
      finalHp: this.players.map((player) => player.hp),
      players: this.players.map(({ name, kind, rank, picture, hp, mana, manaLeft, power, stats }) => ({ name, kind, rank, picture, hp, mana, manaLeft, power, stats: { ...stats } })),
      ratings: [...this.ratings],
    };
  }

  timeLeft(t = now()) {
    if (!this.live) return MATCH_SECONDS;
    return Math.max(0, Math.ceil((this.endsAt - t) / 1000));
  }

  channelProgress() {
    return 0;
  }
}

// Where an orb moving from `before` to `after` comes in through a shield arc, or null.
// Works in width-corrected units, so the arc is round on screen.
export function arcCrossing(arc, before, after, aspect, pad = 0) {
  if (!arc) return null;
  const rel = (p) => ({ x: (p.x - arc.cx) * aspect, y: p.y - arc.cy });
  const a = rel(before);
  const b = rel(after);
  if (Math.hypot(a.x, a.y) <= arc.r || Math.hypot(b.x, b.y) > arc.r) return null;
  const angle = Math.atan2(b.y, b.x);
  const off = Math.atan2(Math.sin(angle - arc.angle), Math.cos(angle - arc.angle));
  // An orb that clips the arc's edge with its body counts as blocked.
  if (Math.abs(off) > arc.span + Math.atan2(pad, arc.r)) return null;
  return { x: arc.cx + (Math.cos(angle) * arc.r) / aspect, y: arc.cy + Math.sin(angle) * arc.r };
}

// Does the shield cover a lightning strike? The bolt has to land within the shield's
// reach and inside the band of heights the arc covers (give or take pad), so the
// shield has to be aimed at the strike's mark.
export function arcCovers(arc, point, aspect, pad = 0) {
  if (!arc) return false;
  if (Math.hypot((point.x - arc.cx) * aspect, point.y - arc.cy) > arc.r + pad) return false;
  const [low, high] = [Math.sin(arc.angle - arc.span), Math.sin(arc.angle + arc.span)].sort((a, b) => a - b);
  return point.y >= arc.cy + arc.r * low - pad && point.y <= arc.cy + arc.r * high + pad;
}

// Bigger power, bigger orb (and a bigger target to hit with).
export function orbRadius(power) {
  return 0.028 + power * 0.0025;
}

export { ATTACKS };
