// Draws the duel on a canvas: the mirrored camera (or an arena in keyboard mode),
// each wizard's skeleton and hat, spells in flight, damage numbers and the HUD.
import { ELEMENT_ICONS, MAX_HP, MAX_SHIELD } from '../shared/rules.js';

export const COLORS = ['#22d3ee', '#f472b6'];
const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];
const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const STATUS_TEXT = {
  ready: '',
  listening: 'Say your incantation…',
  channeling: 'Channeling…',
  cooldown: '',
  out: 'Out of mana',
};

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;

export class Renderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.anchors = [null, null];
    this.images = new Map();
    this.stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.7, r: Math.random() * 1.6 + 0.3 }));
    this.bolts = new Map();
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

    this.drawBackground(view.camera, box, t);

    view.players.forEach((player, side) => {
      const tracked = view.sides?.[side]?.pose;
      const pose = tracked ?? standingPose(side, t, player.status);
      const points = pose.map(toScreen);
      const shoulder = Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y) || this.w * 0.06;
      const chest = { x: (points[11].x + points[12].x) / 2, y: (points[11].y + points[12].y) / 2 + shoulder * 0.35 };
      // Spells leave from the hand nearest the opponent.
      const [w1, w2] = [points[15], points[16]];
      const leadHand = side === 0 ? (w1.x > w2.x ? w1 : w2) : w1.x < w2.x ? w1 : w2;
      const heldHand = view.sides?.[side]?.held?.hand;
      const hand = heldHand ? toScreen(heldHand) : leadHand;
      this.anchors[side] = { chest, hand, head: points[0], shoulder };

      ctx.globalAlpha = view.camera && !tracked && !view.replay ? 0.25 : 1;
      this.drawShieldBubble(player, chest, shoulder, t);
      this.drawSkeleton(points, COLORS[side], shoulder);
      this.drawHat(points, COLORS[side], shoulder);
      ctx.globalAlpha = 1;
      if (view.camera && !tracked && !view.replay) {
        this.text(`Step in, Player ${side + 1}`, chest.x, chest.y, 16, '#e4e4e7');
      }
      (view.sides?.[side]?.hands ?? []).forEach((h) => this.drawHand(h, toScreen, COLORS[side]));
      this.drawStatus(view, player, side, t);
    });

    view.effects.forEach((effect) => this.drawEffect(effect, t));
    view.floaters.forEach((floater) => this.drawFloater(floater, t));
    if (!view.replay) this.drawHud(view);
    view.banners.forEach((banner) => this.drawBanner(banner, t));
    if (view.replay) this.drawReplayBadge(view.replay);
  }

  drawBackground(camera, box, t) {
    const { ctx } = this;
    if (camera && this.video.readyState >= 2) {
      ctx.save();
      ctx.translate(box.x + box.w, box.y);
      ctx.scale(-1, 1);
      ctx.drawImage(this.video, 0, 0, box.w, box.h);
      ctx.restore();
      ctx.fillStyle = 'rgba(8, 6, 20, 0.55)';
      ctx.fillRect(0, 0, this.w, this.h);
      return;
    }
    const sky = ctx.createLinearGradient(0, 0, 0, this.h);
    sky.addColorStop(0, '#0b0820');
    sky.addColorStop(0.7, '#1b1040');
    sky.addColorStop(1, '#2a0f3d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, this.h);
    for (const star of this.stars) {
      ctx.globalAlpha = 0.4 + 0.4 * Math.sin(t / 700 + star.x * 40);
      ctx.fillStyle = '#e9d5ff';
      ctx.beginPath();
      ctx.arc(star.x * this.w, star.y * this.h, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(192, 132, 252, 0.12)';
    ctx.beginPath();
    ctx.ellipse(this.w / 2, this.h * 0.93, this.w * 0.48, this.h * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSkeleton(points, color, shoulder) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(4, shoulder * 0.08);
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    for (const [a, b] of BONES) {
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, shoulder * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawHat(points, color, shoulder) {
    const { ctx } = this;
    const head = points[0];
    const base = head.y - shoulder * 0.2;
    const width = shoulder * 0.75;
    ctx.save();
    ctx.fillStyle = '#1e1036';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(head.x - width, base);
    ctx.lineTo(head.x + width, base);
    ctx.lineTo(head.x + width * 0.15, base - shoulder * 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fde68a';
    ctx.font = `${Math.max(10, shoulder * 0.22)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('✦', head.x + width * 0.05, base - shoulder * 0.4);
    ctx.restore();
  }

  drawHand(hand, toScreen, color) {
    const { ctx } = this;
    const points = hand.points.map(toScreen);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawShieldBubble(player, chest, shoulder, t) {
    if (player.shield <= 0) return;
    const { ctx } = this;
    const strength = player.shield / MAX_SHIELD;
    const radius = shoulder * 2.1 + Math.sin(t / 200) * 3;
    ctx.save();
    const glow = ctx.createRadialGradient(chest.x, chest.y, radius * 0.5, chest.x, chest.y, radius);
    glow.addColorStop(0, 'rgba(147, 197, 253, 0)');
    glow.addColorStop(1, `rgba(147, 197, 253, ${0.15 + 0.35 * strength})`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(chest.x, chest.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(191, 219, 254, ${0.4 + 0.5 * strength})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  drawStatus(view, player, side, t) {
    const anchor = this.anchors[side];
    if (!anchor) return;
    const { ctx } = this;
    // Status sits low on each player's half, clear of the HUD and the typing box.
    const x = side === 0 ? this.w * 0.25 : this.w * 0.75;
    const y = this.h - 150;

    // Holding a gesture: a ring fills around the hand.
    const hold = view.progress?.hold?.(side) ?? 0;
    if (hold > 0 && player.status === 'ready') {
      ctx.save();
      ctx.strokeStyle = COLORS[side];
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(anchor.hand.x, anchor.hand.y, 34, -Math.PI / 2, -Math.PI / 2 + hold * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (player.status === 'listening' || player.status === 'channeling') {
      if (player.words) this.bubble(`“${player.words}”${player.auto ? ' (auto)' : ''}`, x, y - 30);
      this.text(`${ELEMENT_ICONS[player.element] ?? ''} ${STATUS_TEXT[player.status]}`, x, y + 6, 18, '#f4f4f5');
    }
    if (player.status === 'channeling') {
      const progress = view.progress?.channel?.(side) ?? 0;
      const width = 180;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(x - width / 2, y + 16, width, 8);
      ctx.fillStyle = COLORS[side];
      ctx.fillRect(x - width / 2, y + 16, width * progress, 8);
    } else if (player.status === 'out') {
      this.text(STATUS_TEXT.out, x, y + 6, 18, '#fbbf24');
    }
    // The spell's name and power float above the caster, below the HUD.
    if (player.label && t < player.label.until) {
      this.text(player.label.text, anchor.head.x, Math.max(150, anchor.head.y - anchor.shoulder * 1.5), 22, '#fde68a');
    }
  }

  drawEffect(effect, t) {
    const progress = Math.min(1, (t - effect.start) / effect.duration);
    const { ctx } = this;
    if (effect.type === 'fireball') {
      const from = this.anchors[effect.from]?.hand;
      const to = this.anchors[effect.to]?.chest;
      if (!from || !to) return;
      const p = easeOut(progress);
      const x = lerp(from.x, to.x, p);
      const y = lerp(from.y, to.y, p) - Math.sin(Math.PI * p) * 90;
      const radius = 14 + (effect.power ?? 5) * 1.6;
      for (let i = 0; i < 6; i += 1) {
        const back = Math.max(0, p - i * 0.04);
        const tx = lerp(from.x, to.x, back);
        const ty = lerp(from.y, to.y, back) - Math.sin(Math.PI * back) * 90;
        ctx.fillStyle = `rgba(251, 146, 60, ${0.25 - i * 0.035})`;
        ctx.beginPath();
        ctx.arc(tx, ty, radius * (1 - i * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, '#fff7ed');
      glow.addColorStop(0.4, '#fb923c');
      glow.addColorStop(1, 'rgba(220, 38, 38, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (effect.type === 'bolt') {
      const to = this.anchors[effect.to]?.chest;
      if (!to) return;
      if (progress < 0.25) {
        ctx.fillStyle = `rgba(224, 242, 254, ${0.35 * (1 - progress * 4)})`;
        ctx.fillRect(0, 0, this.w, this.h);
      }
      const points = [{ x: to.x + (Math.random() - 0.5) * 60, y: 0 }];
      const steps = 9;
      for (let i = 1; i <= steps; i += 1) {
        points.push({ x: lerp(points[0].x, to.x, i / steps) + (i < steps ? (Math.random() - 0.5) * 50 : 0), y: (to.y * i) / steps });
      }
      ctx.save();
      ctx.strokeStyle = '#e0f2fe';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 25;
      ctx.lineWidth = 5 * (1 - progress) + 1;
      ctx.beginPath();
      points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.stroke();
      ctx.restore();
    } else if (effect.type === 'shieldUp' || effect.type === 'backfire') {
      const anchor = this.anchors[effect.side];
      if (!anchor) return;
      const color = effect.type === 'shieldUp' ? '147, 197, 253' : '248, 113, 113';
      ctx.save();
      ctx.strokeStyle = `rgba(${color}, ${1 - progress})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(anchor.chest.x, anchor.chest.y, anchor.shoulder * (0.8 + 1.6 * easeOut(progress)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawFloater(floater, t) {
    const anchor = this.anchors[floater.side];
    if (!anchor) return;
    const progress = Math.max(0, (t - floater.start) / 1200);
    this.ctx.globalAlpha = 1 - progress;
    this.text(floater.text, anchor.chest.x + (floater.side === 0 ? -30 : 30), anchor.chest.y - 40 - progress * 70, 30, floater.color);
    this.ctx.globalAlpha = 1;
  }

  drawHud(view) {
    view.players.forEach((player, side) => this.drawPlayerPanel(player, side));
    this.text(`${view.timeLeft}`, this.w / 2, 46, 34, '#f4f4f5');
  }

  drawPlayerPanel(player, side) {
    const { ctx } = this;
    const width = Math.min(380, this.w * 0.36);
    const x = side === 0 ? 20 : this.w - 20 - width;
    const y = 18;
    ctx.fillStyle = 'rgba(15, 10, 35, 0.75)';
    roundRect(ctx, x, y, width, 92, 14);
    ctx.fill();

    const avatarX = side === 0 ? x + 40 : x + width - 40;
    this.drawAvatar(player, avatarX, y + 46, 26, COLORS[side]);

    const textX = side === 0 ? x + 78 : x + width - 78;
    ctx.textAlign = side === 0 ? 'left' : 'right';
    ctx.fillStyle = '#f4f4f5';
    ctx.font = '600 18px system-ui';
    ctx.fillText(player.name, textX, y + 28);
    ctx.font = '12px system-ui';
    ctx.fillStyle = player.kind === 'guest' ? '#a1a1aa' : '#86efac';
    ctx.fillText(BADGES[player.kind], textX, y + 46);

    const barWidth = width - 100;
    const barX = side === 0 ? textX : textX - barWidth;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(barX, y + 54, barWidth, 12);
    ctx.fillStyle = player.hp > 30 ? '#4ade80' : '#f87171';
    const hpWidth = (barWidth * player.hp) / MAX_HP;
    ctx.fillRect(side === 0 ? barX : barX + barWidth - hpWidth, y + 54, hpWidth, 12);
    if (player.shield > 0) {
      ctx.fillStyle = 'rgba(147, 197, 253, 0.8)';
      const shieldWidth = (barWidth * player.shield) / MAX_HP;
      ctx.fillRect(side === 0 ? barX : barX + barWidth - shieldWidth, y + 67, shieldWidth, 4);
    }

    for (let i = 0; i < player.mana; i += 1) {
      const pipX = side === 0 ? barX + i * 16 + 6 : barX + barWidth - i * 16 - 6;
      ctx.fillStyle = i < player.manaLeft ? '#c084fc' : 'rgba(192, 132, 252, 0.2)';
      ctx.beginPath();
      ctx.arc(pipX, y + 80, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = 'center';
  }

  drawAvatar(player, x, y, radius, color) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#2e1065';
    ctx.fill();
    const image = player.picture ? this.image(player.picture) : null;
    if (image?.complete && image.naturalWidth) {
      ctx.clip();
      ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
    } else {
      ctx.fillStyle = '#f4f4f5';
      ctx.font = '600 20px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(player.name.slice(0, 1).toUpperCase(), x, y + 1);
    }
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  image(url) {
    if (!this.images.has(url)) {
      const image = new Image();
      image.referrerPolicy = 'no-referrer';
      image.src = url;
      this.images.set(url, image);
    }
    return this.images.get(url);
  }

  drawBanner(banner, t) {
    const progress = (t - banner.start) / banner.duration;
    const alpha = progress < 0.1 ? progress * 10 : progress > 0.8 ? (1 - progress) * 5 : 1;
    this.ctx.globalAlpha = Math.max(0, alpha);
    this.text(banner.title, this.w / 2, this.h * 0.42, 64, banner.color);
    if (banner.detail) this.text(banner.detail, this.w / 2, this.h * 0.42 + 44, 22, '#f4f4f5');
    this.ctx.globalAlpha = 1;
  }

  drawReplayBadge(replay) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(15, 10, 35, 0.8)';
    roundRect(ctx, this.w / 2 - 150, 16, 300, 44, 12);
    ctx.fill();
    this.text(`● REPLAY  ${Math.round(replay.progress * 100)}%`, this.w / 2, 46, 20, '#f87171');
  }

  text(value, x, y, size, color) {
    const { ctx } = this;
    ctx.save();
    ctx.font = `700 ${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = Math.max(3, size / 7);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeText(value, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
    ctx.restore();
  }

  bubble(value, x, y) {
    const { ctx } = this;
    ctx.save();
    ctx.font = 'italic 15px system-ui';
    const width = Math.min(this.w * 0.4, ctx.measureText(value).width + 24);
    ctx.fillStyle = 'rgba(250, 245, 255, 0.92)';
    roundRect(ctx, x - width / 2, y - 22, width, 30, 10);
    ctx.fill();
    ctx.fillStyle = '#3b0764';
    ctx.textAlign = 'center';
    ctx.fillText(value, x, y - 2, width - 16);
    ctx.restore();
  }
}

const BADGES = {
  guest: 'Guest wizard',
  wizard: 'Signed in with Auth0',
  runeWizard: 'Auth0 + Rune Gate verified',
};

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

// A standing wizard for keyboard mode (and for an empty side in camera mode),
// in the same 33-point layout MediaPipe uses, so one drawing routine serves both.
export function standingPose(side, t, status) {
  const cx = side === 0 ? 0.27 : 0.73;
  const facing = side === 0 ? 1 : -1;
  const bob = Math.sin(t / 450 + side) * 0.006;
  const casting = status === 'listening' || status === 'channeling';
  const points = Array.from({ length: 33 }, () => ({ x: cx, y: 0.36 + bob }));
  const set = (i, x, y) => {
    points[i] = { x: cx + x, y: y + bob };
  };
  set(0, 0, 0.35);
  set(11, -0.045, 0.45);
  set(12, 0.045, 0.45);
  set(23, -0.03, 0.64);
  set(24, 0.03, 0.64);
  set(25, -0.035, 0.76);
  set(26, 0.035, 0.76);
  set(27, -0.04, 0.88);
  set(28, 0.04, 0.88);
  if (casting) {
    // Arms reach toward the opponent.
    set(13, -0.045 + facing * 0.05, 0.42);
    set(15, -0.045 + facing * 0.1, 0.38);
    set(14, 0.045 + facing * 0.05, 0.43);
    set(16, 0.045 + facing * 0.1, 0.4);
  } else {
    set(13, -0.06, 0.53);
    set(15, -0.065, 0.61);
    set(14, 0.06, 0.53);
    set(16, 0.065, 0.61);
  }
  return points;
}
