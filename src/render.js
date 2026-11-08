// Draws the duel on a canvas: the mirrored camera (or a pixel arena in keyboard mode),
// each wizard's skeleton and hat, spells in flight, damage numbers and the HUD.
// Arcade pixel style: hard edges, blocky shapes, no glows or gradients. Colors mirror
// src/tokens.css.
import { ELEMENT_ICONS, MAX_HP, MAX_SHIELD, SHIELD_COOLDOWN_MS, SHIELD_UP_MS, gestureEmoji, powerLabel } from '../shared/rules.js';
import { ELEMENT_COLORS, drawIcon } from './icons.js';
import { orbRadius } from './duel.js';
import { standingPose } from './pose.js';

export { standingPose };

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

// Player 1 is red, Player 2 is blue. Fills use COLORS; outlines and text use TEXT_COLORS.
export const COLORS = ['#dc2626', '#2563eb'];
const TEXT_COLORS = ['#f87171', '#60a5fa'];
const DEEP_COLORS = ['#450a0a', '#172554'];
const C = {
  bg: '#0f172a',
  bgDeep: '#0a1020',
  card: '#192134',
  cardRaised: '#222c44',
  line: '#334155',
  fg: '#ffffff',
  muted: '#94a3b8',
  gold: '#facc15',
  accent: '#22c55e',
  danger: '#dc2626',
  ink: '#000000',
  paper: '#f8fafc',
};
const DISPLAY = '"Press Start 2P", ui-monospace, monospace';
const BODY = 'VT323, ui-monospace, monospace';
const PX = 4;

const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];
const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const STATUS_TEXT = {
  armed: '',
  ready: '',
  listening: 'Speak!',
  channeling: 'Channeling',
  cooldown: '',
  out: 'Out of mana',
};
const BADGES = {
  guest: 'GUEST',
  wizard: 'AUTH0',
  ritualWizard: 'AUTH0 + RITUAL',
};
const HP_SEGMENTS = 20;
// With reduced motion, nothing blinks or flashes; spells still travel so the duel reads.
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const snap = (value, unit = PX) => Math.round(value / unit) * unit;
// Animations move in a few hard steps, like sprites.
const stepped = (t, steps) => Math.floor(t * steps) / steps;

export class Renderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.anchors = [null, null];
    this.images = new Map();
    this.pixelated = new Map();
    this.stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * 0.6, big: Math.random() < 0.2 }));
    // A blocky mountain range, one height per column.
    this.ridge = Array.from({ length: 64 }, (_, i) => 0.1 + 0.06 * Math.sin(i * 0.7) + 0.05 * Math.sin(i * 1.9 + 1) + Math.random() * 0.02);
    // Canvas text only shows the pixel fonts once they have loaded.
    document.fonts?.load(`16px ${DISPLAY}`).catch(() => {});
    document.fonts?.load(`24px ${BODY}`).catch(() => {});
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = width;
    this.h = height;
  }

  // The part of the canvas the camera picture covers (or the whole canvas).
  frameBox(useVideo) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!useVideo || !vw || !vh) return { x: 0, y: 0, w: this.w, h: this.h };
    const scale = Math.max(this.w / vw, this.h / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (this.w - w) / 2, y: (this.h - h) / 2, w, h };
  }

  // view: { camera, players, sides, effects, floaters, banners, timeLeft, replay, progress(side) }
  draw(view, t) {
    this.resize();
    const { ctx } = this;
    const box = this.frameBox(view.camera);
    const toScreen = (p) => ({ x: box.x + p.x * box.w, y: box.y + p.y * box.h });

    // Hits shake the arena for a moment (never with reduced motion). The HUD stays still.
    const shake = this.shakeOffset(view.effects, t);
    ctx.fillStyle = C.bgDeep;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(shake.x, shake.y);
    this.drawBackground(view.camera, box, t);
    if (view.gap) this.drawGap(view.gap, box);

    view.players.forEach((player, side) => {
      // The AI opponent has no body on camera, so it always stands in its spot.
      const bot = player.kind === 'bot';
      const tracked = bot ? null : view.sides?.[side]?.pose;
      // The same body the duel checks hits against: kept on its own side of the gap,
      // and including any jump or duck.
      const pose = view.bodies?.[side] ?? tracked ?? standingPose(side, t, player.status);
      const points = pose.map(toScreen);
      const shoulder = Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y) || this.w * 0.06;
      const chest = { x: (points[11].x + points[12].x) / 2, y: (points[11].y + points[12].y) / 2 + shoulder * 0.35 };
      // Spells leave from the hand nearest the opponent.
      const [w1, w2] = [points[15], points[16]];
      const leadHand = side === 0 ? (w1.x > w2.x ? w1 : w2) : w1.x < w2.x ? w1 : w2;
      const heldHand = view.sides?.[side]?.held?.hand;
      const hand = heldHand ? toScreen(heldHand) : leadHand;
      this.anchors[side] = { chest, hand, head: points[0], shoulder };

      ctx.globalAlpha = view.camera && !tracked && !view.replay && !bot ? 0.3 : 1;
      this.drawShieldBubble(player, chest, shoulder, t);
      this.drawSkeleton(points, side, shoulder);
      this.drawHat(points, side, shoulder);
      if ((player.frozenUntil ?? 0) > t) this.drawIce(points, player.frozenUntil, t);
      ctx.globalAlpha = 1;
      if (view.camera && !tracked && !view.replay && !bot) {
        this.text(`Step in, P${side + 1}`, chest.x, chest.y, 14, C.fg);
      }
      if (!bot) (view.sides?.[side]?.hands ?? []).forEach((h) => this.drawHand(h, toScreen, TEXT_COLORS[side]));
      this.drawStatus(view, player, side, t);
      if (view.stepBack?.[side] && tracked) {
        const flash = REDUCED_MOTION || Math.floor(t / 400) % 2 === 0;
        this.text('GET IN VIEW', points[0].x, Math.max(130, points[0].y - shoulder * 1.4), 14, flash ? C.danger : C.fg);
      }
    });

    (view.barriers ?? []).forEach((wall, side) => wall && this.drawBarrier(wall, side, toScreen, box, t));
    view.players.forEach((player, side) => player.orb?.at && this.drawHeldOrb(player, side, toScreen, box, t));
    (view.projectiles ?? []).forEach((orb) => this.drawFlyingOrb(orb, toScreen, box, t));
    (view.strikes ?? []).forEach((strike) => this.drawStrikeMark(strike, toScreen, t));
    view.effects.forEach((effect) => this.drawEffect(effect, t, toScreen));
    view.floaters.forEach((floater) => this.drawFloater(floater, t));
    ctx.restore();
    if (!view.replay) this.drawHud(view, t);
    view.banners.forEach((banner) => this.drawBanner(banner, t));
    if (view.replay) this.drawReplayBadge(view.replay, t);
  }

  drawBackground(camera, box, t) {
    const { ctx } = this;
    if (camera && this.video.readyState >= 2) {
      ctx.save();
      ctx.translate(box.x + box.w, box.y);
      ctx.scale(-1, 1);
      ctx.drawImage(this.video, 0, 0, box.w, box.h);
      ctx.restore();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.5)';
      ctx.fillRect(0, 0, this.w, this.h);
      return;
    }
    ctx.fillStyle = C.bgDeep;
    ctx.fillRect(0, 0, this.w, this.h);

    // Stars blink on and off instead of fading.
    for (const star of this.stars) {
      const on = REDUCED_MOTION || Math.sin(t / 900 + star.x * 40) > -0.4;
      if (!on) continue;
      const size = star.big ? PX : PX / 2;
      ctx.fillStyle = star.big ? C.gold : C.muted;
      ctx.fillRect(snap(star.x * this.w), snap(star.y * this.h), size, size);
    }

    // Mountains: one stepped column per ridge value.
    const ground = snap(this.h * 0.9);
    const column = Math.ceil(this.w / this.ridge.length / PX) * PX;
    ctx.fillStyle = C.card;
    this.ridge.forEach((height, i) => {
      const top = snap(ground - height * this.h * 1.6);
      ctx.fillRect(i * column, top, column, ground - top);
    });

    // Ground: a checker of tiles with a bright top edge.
    ctx.fillStyle = C.cardRaised;
    ctx.fillRect(0, ground, this.w, this.h - ground);
    ctx.fillStyle = C.line;
    ctx.fillRect(0, ground, this.w, PX);
    ctx.fillStyle = C.card;
    const tile = PX * 6;
    for (let x = 0; x < this.w; x += tile * 2) {
      for (let y = ground + PX; y < this.h; y += tile) {
        const offset = ((y - ground - PX) / tile) % 2 === 0 ? 0 : tile;
        ctx.fillRect(x + offset, y, tile, tile);
      }
    }
  }

  drawSkeleton(points, side, shoulder) {
    const { ctx } = this;
    const width = Math.max(6, snap(shoulder * 0.1, 2));
    ctx.save();
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    // A black outline under each bone gives the sprite look.
    for (const [stroke, lineWidth] of [
      [C.ink, width + 6],
      [TEXT_COLORS[side], width],
    ]) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(points[a].x, points[a].y);
        ctx.lineTo(points[b].x, points[b].y);
      }
      // Neck: from the head to the middle of the shoulders.
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo((points[11].x + points[12].x) / 2, (points[11].y + points[12].y) / 2);
      ctx.stroke();
    }
    // A square head.
    const head = snap(shoulder * 0.42);
    const hx = snap(points[0].x - head / 2);
    const hy = snap(points[0].y - head / 2);
    ctx.fillStyle = C.ink;
    ctx.fillRect(hx - 3, hy - 3, head + 6, head + 6);
    ctx.fillStyle = TEXT_COLORS[side];
    ctx.fillRect(hx, hy, head, head);
    ctx.restore();
  }

  // A stepped pointy hat in the player's color with a gold band.
  drawHat(points, side, shoulder) {
    const { ctx } = this;
    const head = points[0];
    const base = snap(head.y - shoulder * 0.21);
    const width = snap(shoulder * 0.75);
    const height = shoulder * 1.05;
    const block = Math.max(PX, snap(shoulder * 0.09));
    const steps = Math.max(4, Math.round(height / block));
    const lean = width * 0.15;
    ctx.save();
    for (let i = 0; i < steps; i += 1) {
      const progress = i / steps;
      const rowWidth = snap(width * 2 * (1 - progress)) || block;
      const center = head.x + lean * progress;
      const y = base - (i + 1) * block;
      ctx.fillStyle = C.ink;
      ctx.fillRect(snap(center - rowWidth / 2) - 3, y - 3, rowWidth + 6, block + 6);
    }
    for (let i = 0; i < steps; i += 1) {
      const progress = i / steps;
      const rowWidth = snap(width * 2 * (1 - progress)) || block;
      const center = head.x + lean * progress;
      const y = base - (i + 1) * block;
      ctx.fillStyle = i === 0 ? C.gold : COLORS[side];
      ctx.fillRect(snap(center - rowWidth / 2), y, rowWidth, block);
    }
    ctx.restore();
  }

  drawHand(hand, toScreen, color) {
    const { ctx } = this;
    const points = hand.points.map(toScreen);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'square';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // A ring of square blocks.
  pixelRing(cx, cy, radius, block, color, alpha = 1) {
    const { ctx } = this;
    const count = Math.max(12, Math.ceil((2 * Math.PI * radius) / (block * 1.4)));
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      ctx.fillRect(snap(cx + Math.cos(angle) * radius - block / 2), snap(cy + Math.sin(angle) * radius - block / 2), block, block);
    }
    ctx.restore();
  }

  drawShieldBubble(player, chest, shoulder, t) {
    if (player.shield <= 0) return;
    const { ctx } = this;
    const strength = player.shield / MAX_SHIELD;
    const radius = shoulder * 2.1 + (REDUCED_MOTION ? 0 : (Math.floor(t / 250) % 2) * PX);
    ctx.save();
    ctx.globalAlpha *= 0.1 + 0.15 * strength;
    ctx.fillStyle = ELEMENT_COLORS.shield;
    ctx.beginPath();
    ctx.arc(chest.x, chest.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.pixelRing(chest.x, chest.y, radius, PX * 2, ELEMENT_COLORS.shield, 0.5 + 0.5 * strength);
  }

  drawStatus(view, player, side, t) {
    const anchor = this.anchors[side];
    if (!anchor) return;
    const { ctx } = this;
    // Status sits low on each player's half, clear of the HUD and the typing box.
    const x = side === 0 ? this.w * 0.25 : this.w * 0.75;
    const y = this.h - 150;

    // Holding a gesture: blocks fill in a ring around the hand, and the sign's emoji
    // shows above it, so you can see what the camera thinks you're making.
    const hold = view.progress?.hold?.(side) ?? 0;
    const held = view.sides?.[side]?.held;
    if (held && player.status === 'ready') this.emoji(gestureEmoji(held.gesture), anchor.hand.x, anchor.hand.y - 64, 40);
    if (hold > 0 && player.status === 'ready') {
      const count = 16;
      for (let i = 0; i < count; i += 1) {
        const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
        ctx.fillStyle = i / count < hold ? TEXT_COLORS[side] : 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(snap(anchor.hand.x + Math.cos(angle) * 36 - 4), snap(anchor.hand.y + Math.sin(angle) * 36 - 4), 8, 8);
      }
    }

    // The spell being cast shows big beside the caster's head (on the side facing the
    // opponent, clear of the HUD), for both players to see.
    if (player.status === 'listening' && player.element) {
      const inward = side === 0 ? 1 : -1;
      this.emoji(ELEMENT_ICONS[player.element], anchor.head.x + inward * anchor.shoulder * 1.8, anchor.head.y + anchor.shoulder * 0.3, 52);
    }
    if (player.status === 'listening' || player.status === 'channeling') {
      if (player.words) this.bubble(`“${player.words}”${player.auto ? ' (auto)' : ''}`, x, y - 36);
      // The AI isn't listening for a voice, it's already casting.
      const label = player.kind === 'bot' ? 'Casting' : STATUS_TEXT[player.status];
      ctx.font = `12px ${DISPLAY}`;
      const labelWidth = ctx.measureText(label).width;
      if (player.element) drawIcon(ctx, player.element, snap(x - labelWidth / 2 - 30), y - 14, 2, ELEMENT_COLORS[player.element]);
      this.text(label, x + 2, y + 6, 12, C.fg);
    }
    if (player.status === 'channeling') {
      const progress = view.progress?.channel?.(side) ?? 0;
      const segments = 12;
      const segment = 14;
      const width = segments * segment;
      const left = snap(x - width / 2);
      ctx.fillStyle = C.ink;
      ctx.fillRect(left - 4, y + 16, width + 4, 18);
      for (let i = 0; i < segments; i += 1) {
        ctx.fillStyle = i / segments < progress ? TEXT_COLORS[side] : C.card;
        ctx.fillRect(left + i * segment, y + 20, segment - 4, 10);
      }
    } else if (player.status === 'out') {
      this.text(STATUS_TEXT.out, x, y + 6, 12, C.gold);
    }
    // Spells already landed; the judge's verdict (and any bonus) is on its way.
    if (player.judging > 0 && player.status !== 'listening') {
      this.text(player.judging > 1 ? `Judging ×${player.judging}…` : 'Judging…', x, y + 30, 10, C.muted);
    }
    // The spell's name and power float above the caster, below the HUD.
    if (player.label && t < player.label.until) {
      this.text(player.label.text, anchor.head.x, Math.max(160, anchor.head.y - anchor.shoulder * 1.6), 14, C.gold, { maxWidth: this.w * 0.45 });
    }
  }

  // The empty strip down the middle: neither wizard's body can cross into it.
  drawGap(gap, box) {
    const { ctx } = this;
    const left = snap(box.x + (0.5 - gap / 2) * box.w);
    const right = snap(box.x + (0.5 + gap / 2) * box.w);
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = C.ink;
    ctx.fillRect(left, 0, right - left, this.h);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = C.line;
    for (let y = 0; y < this.h; y += PX * 6) {
      ctx.fillRect(left, y, PX, PX * 3);
      ctx.fillRect(right - PX, y, PX, PX * 3);
    }
    ctx.restore();
  }

  // A charged orb in hand: it follows the hand, pulses, and counts down until it fizzles.
  drawHeldOrb(player, side, toScreen, box, t) {
    const { ctx } = this;
    const orb = player.orb;
    const at = toScreen(orb.at);
    const size = snap(orbRadius(orb.power) * box.h * 2 * (REDUCED_MOTION ? 1 : 1 + 0.12 * (Math.floor(t / 150) % 2)));
    if (orb.aim) {
      // Keyboard aim: a dotted line to a crosshair sweeping up and down the opponent.
      const aim = toScreen(orb.aim);
      ctx.fillStyle = TEXT_COLORS[side];
      for (let i = 1; i < 12; i += 1) {
        const p = i / 12;
        ctx.fillRect(snap(lerp(at.x, aim.x, p)) - 2, snap(lerp(at.y, aim.y, p)) - 2, PX, PX);
      }
      ctx.fillRect(snap(aim.x) - 14, snap(aim.y) - 2, 28, PX);
      ctx.fillRect(snap(aim.x) - 2, snap(aim.y) - 14, PX, 28);
    }
    // A pulsing halo shows the orb is charged.
    if (!REDUCED_MOTION) this.pixelRing(at.x, at.y, size * (0.85 + 0.15 * (Math.floor(t / 120) % 2)), PX, ELEMENT_COLORS[orb.element] ?? C.gold, 0.7);
    this.orbBlock(orb.element, at.x, at.y, size);
    // How to throw it: let go on camera, the key again on the keyboard. No countdown.
    if (player.kind !== 'bot') this.text(orb.prompt ?? 'Throw!', at.x, at.y - size / 2 - 14, 10, C.gold);
  }

  drawFlyingOrb(orb, toScreen, box, t) {
    const { ctx } = this;
    const size = snap(orbRadius(orb.power) * box.h * 2);
    const color = ELEMENT_COLORS[orb.element] ?? C.gold;
    // A long, bright trail of blocks behind it.
    orb.trail.forEach((point, i) => {
      const p = toScreen(point);
      const share = (i + 1) / orb.trail.length;
      const s2 = snap(size * (0.35 + share * 0.6));
      ctx.globalAlpha = 0.3 + share * 0.6;
      ctx.fillStyle = i % 3 === 0 ? C.paper : color;
      ctx.fillRect(snap(p.x - s2 / 2), snap(p.y - s2 / 2), s2, s2);
    });
    ctx.globalAlpha = 1;
    const at = toScreen(orb);
    // A halo and a few sparks spinning around it.
    this.pixelRing(at.x, at.y, size * 0.95, PX, color, 0.6);
    for (let i = 0; i < 4; i += 1) {
      const angle = (REDUCED_MOTION ? 0 : t / 70) + i * (Math.PI / 2);
      ctx.fillStyle = i % 2 ? C.paper : C.gold;
      ctx.fillRect(snap(at.x + Math.cos(angle) * size * 0.85), snap(at.y + Math.sin(angle) * size * 0.85), PX, PX);
    }
    this.orbBlock(orb.element, at.x, at.y, size);
  }

  // One pixel orb: an ink outline, the element's color, and a bright core.
  orbBlock(element, x, y, size) {
    const { ctx } = this;
    const color = ELEMENT_COLORS[element] ?? C.gold;
    const left = snap(x - size / 2);
    const top = snap(y - size / 2);
    ctx.fillStyle = C.ink;
    ctx.fillRect(left - PX, top - PX, size + PX * 2, size + PX * 2);
    if (element === 'frost' || element === 'drain' || element === 'lightning') {
      drawIcon(ctx, element, left, top, size / 12, color);
      return;
    }
    ctx.fillStyle = color;
    ctx.fillRect(left, top, size, size);
    ctx.fillStyle = C.gold;
    ctx.fillRect(snap(left + size / 4), snap(top + size / 4), snap(size / 2), snap(size / 2));
    ctx.fillStyle = C.paper;
    ctx.fillRect(snap(left + (size * 3) / 8), snap(top + (size * 3) / 8), snap(size / 4), snap(size / 4));
  }

  // The shield: an arc of pixel blocks pulled out in front of the wizard.
  drawBarrier(arc, side, toScreen, box, t) {
    const { ctx } = this;
    const steps = 22;
    const point = (angle, scale) =>
      toScreen({ x: arc.cx + (Math.cos(angle) * arc.r * scale) / arc.aspect, y: arc.cy + Math.sin(angle) * arc.r * scale });
    const flicker = REDUCED_MOTION ? 1 : 0.8 + 0.2 * (Math.floor(t / 110) % 2);
    for (const [scale, size, color, alpha] of [
      [1, PX * 4, C.ink, 0.9],
      [1, PX * 3, ELEMENT_COLORS.shield, flicker],
      [0.9, PX * 2, C.paper, 0.5],
    ]) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      for (let i = 0; i <= steps; i += 1) {
        const p = point(arc.angle - arc.span + (2 * arc.span * i) / steps, scale);
        ctx.fillRect(snap(p.x - size / 2), snap(p.y - size / 2), size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Frost Shard: the frozen wizard is boxed in a block of ice until it thaws.
  drawIce(points, until, t) {
    const { ctx } = this;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = PX * 4;
    const left = snap(Math.min(...xs) - pad);
    const top = snap(Math.min(...ys) - pad * 3);
    const width = snap(Math.max(...xs) - Math.min(...xs) + pad * 2);
    const height = snap(Math.max(...ys) - Math.min(...ys) + pad * 4);
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = ELEMENT_COLORS.frost;
    ctx.fillRect(left, top, width, height);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = ELEMENT_COLORS.frost;
    ctx.lineWidth = PX;
    ctx.strokeRect(left, top, width, height);
    // A few hard white glints on the ice.
    ctx.fillStyle = C.paper;
    for (const [fx, fy] of [[0.15, 0.1], [0.2, 0.16], [0.8, 0.55], [0.74, 0.6]]) {
      ctx.fillRect(snap(left + width * fx), snap(top + height * fy), PX * 2, PX * 2);
    }
    ctx.restore();
    const seconds = Math.max(0, (until - t) / 1000).toFixed(1);
    this.text(`Frozen ${seconds}s`, left + width / 2, top - 10, 10, ELEMENT_COLORS.frost);
  }

  // ✌️ Lightning on its way down: a target mark on the spot, closing in, under a
  // flickering line to the sky. Time to move, jump, duck or shield.
  drawStrikeMark(strike, toScreen, t) {
    const { ctx } = this;
    const at = toScreen(strike);
    const top = toScreen({ x: strike.x, y: 0 }).y;
    const progress = Math.min(1, Math.max(0, (t - strike.start) / (strike.at - strike.start)));
    const color = ELEMENT_COLORS.lightning;
    const blink = REDUCED_MOTION || Math.floor(t / 80) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = 0.2 + 0.5 * progress;
    ctx.fillStyle = color;
    for (let y = top; y < at.y - 20; y += PX * 4) ctx.fillRect(snap(at.x - PX / 2), snap(y), PX, PX * 2);
    ctx.restore();
    const radius = 46 - 28 * progress;
    this.pixelRing(at.x, at.y, radius, PX, blink ? color : C.paper, 0.6 + 0.4 * progress);
    ctx.fillStyle = C.ink;
    const tick = 12;
    for (const [dx, dy, w, h] of [
      [-radius - tick, -PX / 2, tick, PX],
      [radius, -PX / 2, tick, PX],
      [-PX / 2, -radius - tick, PX, tick],
      [-PX / 2, radius, PX, tick],
    ]) {
      ctx.fillStyle = C.ink;
      ctx.fillRect(snap(at.x + dx) - 2, snap(at.y + dy) - 2, w + 4, h + 4);
      ctx.fillStyle = color;
      ctx.fillRect(snap(at.x + dx), snap(at.y + dy), w, h);
    }
  }

  drawEffect(effect, t, toScreen) {
    const progress = Math.min(1, (t - effect.start) / effect.duration);
    const { ctx } = this;
    if (effect.type === 'impact') {
      // Where an orb hit: rings of blocks, bigger for a headshot.
      if (!toScreen) return;
      const at = toScreen(effect.point);
      const p = stepped(progress, 6);
      const color = ELEMENT_COLORS[effect.element] ?? C.gold;
      const reach = effect.zone === 'head' ? 120 : 80;
      // A white flash right where it hit.
      if (!REDUCED_MOTION && progress < 0.2) {
        const flash = effect.zone === 'head' ? 56 : 36;
        ctx.globalAlpha = 0.85 * (1 - progress / 0.2);
        ctx.fillStyle = C.paper;
        ctx.fillRect(snap(at.x - flash / 2), snap(at.y - flash / 2), flash, flash);
        ctx.globalAlpha = 1;
      }
      this.pixelRing(at.x, at.y, 12 + p * reach, PX * 2, color, 1 - p);
      this.pixelRing(at.x, at.y, 6 + p * reach * 0.6, PX * 2, effect.zone === 'head' ? C.gold : C.paper, 1 - p);
      // Debris: blocks flying out from the hit.
      const count = effect.zone === 'head' ? 14 : 10;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2 + (effect.start % 1);
        const distance = 10 + easeOut(progress) * reach * (0.55 + ((i * 37) % 10) / 22);
        const block = PX * (i % 2 ? 2 : 3);
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = i % 3 === 0 ? C.paper : color;
        ctx.fillRect(snap(at.x + Math.cos(angle) * distance), snap(at.y + Math.sin(angle) * distance + progress * 18), block, block);
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (effect.type === 'shard') {
      // Frost Shard: an ice crystal that flies straight and fast.
      const from = this.anchors[effect.from]?.hand;
      const to = this.anchors[effect.to]?.chest;
      if (!from || !to) return;
      const p = stepped(progress, 12);
      const size = snap(16 + (effect.power ?? 5) * 1.6);
      for (let i = 4; i >= 1; i -= 1) {
        const q = Math.max(0, p - i * 0.06);
        const s = snap(size * (1 - i * 0.18));
        ctx.globalAlpha = 1 - i * 0.2;
        ctx.fillStyle = ELEMENT_COLORS.frost;
        ctx.fillRect(snap(lerp(from.x, to.x, q) - s / 2), snap(lerp(from.y, to.y, q) - s / 2), s, s);
      }
      ctx.globalAlpha = 1;
      const x = lerp(from.x, to.x, p);
      const y = lerp(from.y, to.y, p);
      drawIcon(ctx, 'frost', snap(x - size / 2), snap(y - size / 2), size / 12, ELEMENT_COLORS.frost);
    } else if (effect.type === 'drain') {
      // Life Drain: blocks of life force flow from the target back to the caster.
      const from = this.anchors[effect.to]?.chest;
      const to = this.anchors[effect.from]?.chest;
      if (!from || !to) return;
      for (let i = 0; i < 9; i += 1) {
        const q = stepped(Math.min(1, Math.max(0, progress * 1.5 - i * 0.06)), 10);
        if (q <= 0 || q >= 1) continue;
        const wobble = Math.sin((q + i) * Math.PI * 2) * 18;
        const s = i % 3 === 0 ? PX * 4 : PX * 3;
        ctx.fillStyle = C.ink;
        ctx.fillRect(snap(lerp(from.x, to.x, q) - s / 2) - 2, snap(lerp(from.y, to.y, q) + wobble - s / 2) - 2, s + 4, s + 4);
        ctx.fillStyle = i % 2 ? ELEMENT_COLORS.drain : C.paper;
        ctx.fillRect(snap(lerp(from.x, to.x, q) - s / 2), snap(lerp(from.y, to.y, q) + wobble - s / 2), s, s);
      }
    } else if (effect.type === 'heal') {
      // Heal: green crosses rise around the wizard.
      const anchor = this.anchors[effect.side];
      if (!anchor) return;
      const p = stepped(progress, 9);
      ctx.globalAlpha = p > 0.7 ? 0.5 : 1;
      for (let i = 0; i < 5; i += 1) {
        const angle = (i / 5) * Math.PI * 2;
        const x = anchor.chest.x + Math.cos(angle) * anchor.shoulder * 1.1;
        const y = anchor.chest.y + Math.sin(angle) * anchor.shoulder * 0.6 - p * 90 - (i % 2) * 20;
        drawIcon(ctx, 'heal', snap(x - 12), snap(y - 12), 2, ELEMENT_COLORS.heal);
      }
      ctx.globalAlpha = 1;
    } else if (effect.type === 'fireball') {
      const from = this.anchors[effect.from]?.hand;
      const to = this.anchors[effect.to]?.chest;
      if (!from || !to) return;
      const at = (p) => ({ x: lerp(from.x, to.x, p), y: lerp(from.y, to.y, p) - Math.sin(Math.PI * p) * 90 });
      const p = easeOut(stepped(progress, 14));
      const size = snap(20 + (effect.power ?? 5) * 2.4);
      // A trail of shrinking blocks.
      for (let i = 5; i >= 1; i -= 1) {
        const point = at(Math.max(0, p - i * 0.05));
        const s = snap(size * (1 - i * 0.14));
        ctx.fillStyle = i > 3 ? C.danger : ELEMENT_COLORS.fire;
        ctx.globalAlpha = 1 - i * 0.15;
        ctx.fillRect(snap(point.x - s / 2), snap(point.y - s / 2), s, s);
      }
      ctx.globalAlpha = 1;
      const head = at(p);
      const x = snap(head.x - size / 2);
      const y = snap(head.y - size / 2);
      ctx.fillStyle = C.ink;
      ctx.fillRect(x - 4, y - 4, size + 8, size + 8);
      ctx.fillStyle = ELEMENT_COLORS.fire;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = C.gold;
      ctx.fillRect(x + size / 4, y + size / 4, size / 2, size / 2);
      ctx.fillStyle = C.paper;
      ctx.fillRect(x + (size * 3) / 8, y + (size * 3) / 8, size / 4, size / 4);
    } else if (effect.type === 'strike') {
      // The bolt itself: from the top of the arena straight down onto the marked spot.
      if (!toScreen) return;
      const to = toScreen(effect.point);
      const top = toScreen({ x: effect.point.x, y: 0 }).y;
      if (progress < 0.25 && !REDUCED_MOTION) {
        ctx.fillStyle = progress < 0.1 ? 'rgba(250, 204, 21, 0.32)' : 'rgba(250, 204, 21, 0.12)';
        ctx.fillRect(0, 0, this.w, this.h);
      }
      // Its zigzag stays put for its short life (seeded by when it struck).
      const jag = (i) => ((((Math.sin(effect.start * 12.9898 + i * 78.233) * 43758.5453) % 1) + 1) % 1) - 0.5;
      const steps = 10;
      const points = [];
      for (let i = 0; i <= steps; i += 1) {
        const k = i / steps;
        points.push({ x: to.x + (i > 0 && i < steps ? jag(i) * 46 : 0), y: lerp(top, to.y, k) });
      }
      const width = snap(10 * (1 - progress) + 4, 2);
      ctx.save();
      ctx.globalAlpha = 1 - progress * 0.6;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      for (const [stroke, lineWidth] of [
        [C.ink, width + 6],
        [ELEMENT_COLORS.lightning, width],
        [C.paper, Math.max(2, width / 3)],
      ]) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        points.forEach((point, i) => (i === 0 ? ctx.moveTo(snap(point.x), snap(point.y)) : ctx.lineTo(snap(point.x), snap(point.y))));
        ctx.stroke();
      }
      ctx.restore();
      this.pixelRing(to.x, to.y, 10 + stepped(progress, 6) * 60, PX * 2, ELEMENT_COLORS.lightning, 1 - progress);
    } else if (effect.type === 'bolt') {
      const to = this.anchors[effect.to]?.chest;
      if (!to) return;
      if (progress < 0.25 && !REDUCED_MOTION) {
        // A two-step flash.
        ctx.fillStyle = progress < 0.12 ? 'rgba(250, 204, 21, 0.3)' : 'rgba(250, 204, 21, 0.12)';
        ctx.fillRect(0, 0, this.w, this.h);
      }
      const points = [{ x: to.x + (Math.random() - 0.5) * 60, y: 0 }];
      const steps = 9;
      for (let i = 1; i <= steps; i += 1) {
        points.push({ x: lerp(points[0].x, to.x, i / steps) + (i < steps ? (Math.random() - 0.5) * 50 : 0), y: (to.y * i) / steps });
      }
      const width = snap(8 * (1 - progress) + 4, 2);
      ctx.save();
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      for (const [stroke, lineWidth] of [
        [C.ink, width + 6],
        [ELEMENT_COLORS.lightning, width],
        [C.paper, Math.max(2, width / 3)],
      ]) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        points.forEach((point, i) => (i === 0 ? ctx.moveTo(snap(point.x), snap(point.y)) : ctx.lineTo(snap(point.x), snap(point.y))));
        ctx.stroke();
      }
      ctx.restore();
    } else if (effect.type === 'shieldUp' || effect.type === 'backfire') {
      const anchor = this.anchors[effect.side];
      if (!anchor) return;
      const color = effect.type === 'shieldUp' ? ELEMENT_COLORS.shield : C.danger;
      const p = stepped(progress, 6);
      this.pixelRing(anchor.chest.x, anchor.chest.y, anchor.shoulder * (0.8 + 1.6 * easeOut(p)), PX * 2, color, 1 - p);
    }
  }

  drawFloater(floater, t) {
    const anchor = this.anchors[floater.side];
    if (!anchor) return;
    const progress = Math.max(0, (t - floater.start) / 1200);
    this.ctx.globalAlpha = progress > 0.75 ? 0.5 : 1;
    const rise = snap(stepped(progress, 10) * 70);
    // Keep the words inside the arena, even for a wizard near the edge.
    const size = floater.text.length > 14 ? 14 : 20;
    this.ctx.font = `${size}px ${DISPLAY}`;
    const half = this.ctx.measureText(floater.text).width / 2 + 8;
    const x = Math.min(this.w - half, Math.max(half, anchor.chest.x + (floater.side === 0 ? -30 : 30)));
    this.text(floater.text, x, anchor.chest.y - 40 - rise, size, floater.color);
    this.ctx.globalAlpha = 1;
  }

  // A few pixels of shake after a hit: more for a headshot, a little for a block.
  shakeOffset(effects, t) {
    if (REDUCED_MOTION) return { x: 0, y: 0 };
    let amount = 0;
    for (const effect of effects) {
      if (effect.type !== 'impact') continue;
      const age = t - effect.start;
      if (age < 0 || age > 260) continue;
      const strength = effect.element === 'shield' ? 3 : effect.zone === 'head' ? 10 : 6;
      amount = Math.max(amount, strength * (1 - age / 260));
    }
    if (!amount) return { x: 0, y: 0 };
    return { x: Math.round(Math.sin(t * 0.9) * amount), y: Math.round(Math.cos(t * 1.3) * amount * 0.6) };
  }

  drawHud(view, t = performance.now()) {
    view.players.forEach((player, side) => this.drawPlayerPanel(player, side, t));
    this.drawTimer(view.timeLeft);
  }

  drawTimer(timeLeft) {
    const { ctx } = this;
    const width = 104;
    const x = snap(this.w / 2 - width / 2);
    const y = 18;
    this.box(x, y, width, 56, C.bgDeep, C.gold);
    this.text(String(timeLeft), this.w / 2, y + 40, 22, timeLeft <= 10 ? TEXT_COLORS[0] : C.fg, { outline: false });
    ctx.textAlign = 'center';
  }

  // A hard-edged panel with a colored border and a black offset shadow.
  box(x, y, width, height, fill, border) {
    const { ctx } = this;
    ctx.fillStyle = C.ink;
    ctx.fillRect(x + PX, y + PX, width, height);
    ctx.fillStyle = border;
    ctx.fillRect(x - PX, y - PX, width + PX * 2, height + PX * 2);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, width, height);
  }

  drawPlayerPanel(player, side, t = performance.now()) {
    const { ctx } = this;
    const width = snap(Math.min(380, this.w * 0.36));
    const height = 104;
    const x = side === 0 ? 20 : snap(this.w - 20 - width);
    const y = 18;
    this.box(x, y, width, height, C.card, COLORS[side]);

    const avatarSize = 56;
    const avatarX = side === 0 ? x + 12 : x + width - 12 - avatarSize;
    this.drawAvatar(player, avatarX, y + 12, avatarSize, side);

    const inner = width - avatarSize - 36;
    const textX = side === 0 ? x + avatarSize + 24 : x + width - avatarSize - 24;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = side === 0 ? 'left' : 'right';
    ctx.fillStyle = C.fg;
    ctx.font = `12px ${DISPLAY}`;
    ctx.fillText(fitText(ctx, player.name.toUpperCase(), inner), textX, y + 26);
    ctx.font = `18px ${BODY}`;
    ctx.fillStyle = player.kind === 'guest' ? C.muted : C.accent;
    const badge = player.kind === 'bot' ? `AI · ${String(player.rank ?? '').toUpperCase()}` : BADGES[player.kind];
    // Signed-in wizards show the power level they brought to this duel.
    const power = Number.isFinite(player.power) ? ` · PWR ${powerLabel(player.power)}` : '';
    ctx.fillText(fitText(ctx, `${badge ?? player.kind ?? ''}${power}`, inner), textX, y + 44);

    // HP: segmented blocks; each block is 5 HP. They empty from the outside in.
    const barX = side === 0 ? textX : textX - inner;
    const gap = 2;
    const segment = (inner - gap * (HP_SEGMENTS - 1)) / HP_SEGMENTS;
    const filled = Math.ceil((player.hp / MAX_HP) * HP_SEGMENTS);
    const hpColor = player.hp > 30 ? C.accent : C.danger;
    ctx.fillStyle = C.ink;
    ctx.fillRect(barX - 2, y + 52, inner + 4, 18);
    for (let i = 0; i < HP_SEGMENTS; i += 1) {
      const index = side === 0 ? i : HP_SEGMENTS - 1 - i;
      ctx.fillStyle = i < filled ? hpColor : C.cardRaised;
      ctx.fillRect(Math.round(barX + index * (segment + gap)), y + 54, Math.ceil(segment), 14);
    }
    // The shield bar: drains while the shield is out, refills while it recharges,
    // and turns green when it's ready again.
    const up = (player.barrierUntil ?? 0) > t;
    const charging = !up && (player.barrierReadyAt ?? 0) > t;
    const shieldShare = up
      ? (player.barrierUntil - t) / SHIELD_UP_MS
      : charging
        ? 1 - (player.barrierReadyAt - t) / (SHIELD_COOLDOWN_MS - SHIELD_UP_MS)
        : 1;
    ctx.fillStyle = C.ink;
    ctx.fillRect(barX - 2, y + 72, inner + 4, 8);
    ctx.fillStyle = C.cardRaised;
    ctx.fillRect(barX, y + 74, inner, 4);
    ctx.fillStyle = up ? C.paper : charging ? ELEMENT_COLORS.shield : C.accent;
    const fillWidth = Math.round(inner * Math.max(0, Math.min(1, shieldShare)));
    ctx.fillRect(side === 0 ? barX : barX + inner - fillWidth, y + 74, fillWidth, 4);

    // Mana: one square per spell.
    for (let i = 0; i < player.mana; i += 1) {
      const pipX = side === 0 ? barX + i * 18 : barX + inner - 12 - i * 18;
      ctx.fillStyle = C.ink;
      ctx.fillRect(pipX - 2, y + 82, 16, 16);
      ctx.fillStyle = i < player.manaLeft ? TEXT_COLORS[side] : C.cardRaised;
      ctx.fillRect(pipX, y + 84, 12, 12);
    }
    // The shield's state in words, at the far end of the mana row when there's room.
    const shieldLabel = up ? 'SHIELD UP' : charging ? `SHIELD ${Math.ceil((player.barrierReadyAt - t) / 1000)}s` : 'SHIELD READY';
    ctx.font = `10px ${DISPLAY}`;
    const room = inner - player.mana * 18;
    if (ctx.measureText(shieldLabel).width + 8 <= room) {
      ctx.textAlign = side === 0 ? 'right' : 'left';
      ctx.fillStyle = up ? C.paper : charging ? ELEMENT_COLORS.shield : C.accent;
      ctx.fillText(shieldLabel, side === 0 ? barX + inner : barX, y + 96);
    }
    ctx.textAlign = 'center';
  }

  // Avatars are drawn tiny and scaled up without smoothing, so they look like sprites.
  drawAvatar(player, x, y, size, side) {
    const { ctx } = this;
    ctx.fillStyle = TEXT_COLORS[side];
    ctx.fillRect(x - 3, y - 3, size + 6, size + 6);
    ctx.fillStyle = DEEP_COLORS[side];
    ctx.fillRect(x, y, size, size);
    const sprite = player.picture ? this.sprite(player.picture) : null;
    if (sprite) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sprite, x, y, size, size);
      ctx.restore();
    } else {
      this.text(player.name.slice(0, 1).toUpperCase(), x + size / 2, y + size / 2 + 10, 20, C.fg, { outline: false });
    }
  }

  sprite(url) {
    if (this.pixelated.has(url)) return this.pixelated.get(url);
    if (!this.images.has(url)) {
      const image = new Image();
      image.referrerPolicy = 'no-referrer';
      image.src = url;
      this.images.set(url, image);
    }
    const image = this.images.get(url);
    if (!image.complete || !image.naturalWidth) return null;
    const small = document.createElement('canvas');
    small.width = 16;
    small.height = 16;
    small.getContext('2d').drawImage(image, 0, 0, 16, 16);
    this.pixelated.set(url, small);
    return small;
  }

  drawBanner(banner, t) {
    const progress = (t - banner.start) / banner.duration;
    // Banners pop in and blink out instead of fading.
    if (!REDUCED_MOTION && progress > 0.8 && Math.floor(t / 120) % 2 === 0) return;
    const size = progress < 0.06 && !REDUCED_MOTION ? 28 : 40;
    this.text(banner.title, this.w / 2, this.h * 0.42, size, banner.color, { maxWidth: this.w * 0.9, shadow: true });
    if (banner.detail) {
      this.text(banner.detail, this.w / 2, this.h * 0.42 + 48, 28, C.fg, { family: BODY, maxWidth: this.w * 0.9 });
    }
  }

  drawReplayBadge(replay, t) {
    const width = 280;
    const x = snap(this.w / 2 - width / 2);
    this.box(x, 18, width, 48, C.bgDeep, C.danger);
    if (REDUCED_MOTION || Math.floor(t / 500) % 2 === 0) {
      this.ctx.fillStyle = C.danger;
      this.ctx.fillRect(x + 20, 34, 16, 16);
    }
    this.text(`REPLAY ${Math.round(replay.progress * 100)}%`, this.w / 2 + 14, 50, 14, C.fg, { outline: false });
  }

  // Pixel text with a black outline (and an optional hard drop shadow), shrunk to fit.
  text(value, x, y, size, color, { family = DISPLAY, maxWidth = this.w * 0.95, outline = true, shadow = false } = {}) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let fontSize = size;
    ctx.font = `${fontSize}px ${family}`;
    const measured = ctx.measureText(value).width;
    if (measured > maxWidth) {
      fontSize = Math.max(family === DISPLAY ? 10 : 16, Math.floor((fontSize * maxWidth) / measured));
      ctx.font = `${fontSize}px ${family}`;
    }
    if (shadow) {
      ctx.fillStyle = C.ink;
      ctx.fillText(value, x + Math.max(3, fontSize / 10), y + Math.max(3, fontSize / 10));
    }
    if (outline) {
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(4, Math.round(fontSize / 4));
      ctx.strokeStyle = C.ink;
      ctx.strokeText(value, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
    ctx.restore();
  }

  // A white speech bubble with a stepped tail, for the incantation.
  emoji(value, x, y, size) {
    if (!value) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1;
    ctx.fillText(value, x, y);
    ctx.restore();
  }

  bubble(value, x, y) {
    const { ctx } = this;
    ctx.save();
    ctx.font = `24px ${BODY}`;
    const maxWidth = this.w * 0.42;
    const text = fitText(ctx, value, maxWidth - 24);
    const width = snap(Math.min(maxWidth, ctx.measureText(text).width + 28));
    const height = 36;
    const left = snap(x - width / 2);
    const top = snap(y - height + 6);
    ctx.fillStyle = C.ink;
    ctx.fillRect(left - PX, top - PX, width + PX * 2, height + PX * 2);
    ctx.fillRect(snap(x) - 8, top + height, 16, 8);
    ctx.fillRect(snap(x) - 4, top + height + 8, 8, 8);
    ctx.fillStyle = C.paper;
    ctx.fillRect(left, top, width, height);
    ctx.fillRect(snap(x) - 4, top + height, 8, 4);
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + width / 2, top + height / 2 + 1);
    ctx.restore();
  }
}

// Cuts text with an ellipsis so it fits the given width in the current font.
function fitText(ctx, value, maxWidth) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// A standing wizard for keyboard mode (and for an empty side in camera mode),
// in the same 33-point layout MediaPipe uses, so one drawing routine serves both.
