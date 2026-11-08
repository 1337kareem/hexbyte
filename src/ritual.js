// The opening ritual and the safe zone, for camera duels.
//
// Before a duel starts, every player on camera has to be in view (head and shoulders
// on screen; legs and feet can be out of frame), then complete three steps: two thumbs
// up, a heart made with both hands, and a dance. Then the countdown runs: 3, 2, 1, BATTLE!
//
// During the duel, each wizard's body stays on their own side of a gap in the middle,
// and a player whose head or shoulders leave the screen can't cast until they're back.
//
// Points are MediaPipe landmarks in frame coordinates (0 to 1, mirrored so Player 1
// is on the left). Hands are { points, gesture, score } from src/vision.js.

// The empty strip down the middle of the arena, as a share of the frame's width.
export const GAP = 0.14;

export const STEPS = [
  { id: 'thumbs', emoji: '👍👍', title: 'Two thumbs up', hint: 'Both hands, thumbs up. Hold it.' },
  { id: 'heart', emoji: '🫶', title: 'Make a heart', hint: 'Index fingertips together on top, thumbs together at the bottom.' },
  { id: 'dance', emoji: '💃', title: 'Dance!', hint: 'Any dance. Keep moving until your bar fills.' },
];

// How long each step must be held (thumbs, heart) or danced (dance), in milliseconds.
const HOLD_MS = { thumbs: 600, heart: 500, dance: 2500 };
// A limb counts as moving at this many shoulder-widths per second; a dance needs 4 of them.
const DANCE_SPEED = 0.9;
const DANCE_LIMBS = 4;

// The landmarks that must be on screen: nose, shoulders, hips, ankles.
const FULL_BODY = [0, 11, 12, 23, 24, 27, 28];
// The body's core (no arms), which has to stay on its own side of the gap.
const CORE = [0, 11, 12, 23, 24, 25, 26, 27, 28];
const LIMBS = [13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

const distance = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

// Head and both shoulders on screen, where the camera can really see them. That's all
// a duel needs: casting, throwing and dodging all read the upper body.
const UPPER_BODY = [0, 11, 12];
export function inView(pose) {
  if (!pose) return false;
  return UPPER_BODY.every((i) => {
    const p = pose[i];
    return p && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98 && (p.v ?? 1) >= 0.5;
  });
}

// Is the whole body in frame, head to ankles? (No longer required; kept for reference.)
export function bodyInFrame(pose) {
  if (!pose) return false;
  return FULL_BODY.every((i) => {
    const p = pose[i];
    return p && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98 && (p.v ?? 1) >= 0.5;
  });
}

// Slides a body back to its own side if it reaches into the gap. Arms may reach in.
export function clampToSide(pose, side, gap = GAP) {
  if (!pose) return pose;
  const core = CORE.map((i) => pose[i]).filter(Boolean);
  if (!core.length) return pose;
  const shift =
    side === 0
      ? Math.min(0, 0.5 - gap / 2 - Math.max(...core.map((p) => p.x)))
      : Math.max(0, 0.5 + gap / 2 - Math.min(...core.map((p) => p.x)));
  return shift ? pose.map((p) => ({ ...p, x: p.x + shift })) : pose;
}

export function twoThumbsUp(hands = []) {
  return hands.filter((hand) => hand.gesture === 'Thumb_Up' && hand.score >= 0.5).length >= 2;
}

// A heart: two hands, index fingertips touching, thumb tips touching, index tips on top.
export function isHeart(hands = [], aspect = 16 / 9) {
  if (hands.length < 2) return false;
  for (let i = 0; i < hands.length; i += 1) {
    for (let j = i + 1; j < hands.length; j += 1) {
      const a = hands[i].points;
      const b = hands[j].points;
      if (!a?.[9] || !b?.[9]) continue;
      const size = (distance(a[0], a[9], aspect) + distance(b[0], b[9], aspect)) / 2 || 0.1;
      const indexTips = distance(a[8], b[8], aspect);
      const thumbTips = distance(a[4], b[4], aspect);
      const indexOnTop = (a[8].y + b[8].y) / 2 < (a[4].y + b[4].y) / 2;
      if (indexTips < size * 0.6 && thumbTips < size * 0.6 && indexOnTop) return true;
    }
  }
  return false;
}

// How many limbs moved fast between two poses: enough of them, and it's dancing.
export function movingLimbs(before, after, seconds, aspect = 16 / 9) {
  if (!before || !after || seconds <= 0) return 0;
  const shoulders = distance(after[11], after[12], aspect) || 0.1;
  return LIMBS.filter((i) => before[i] && after[i] && distance(before[i], after[i], aspect) / seconds / shoulders >= DANCE_SPEED).length;
}

export class Ritual {
  // sides: the players on camera who must complete it (both, or just Player 1 against the AI).
  // requireFullBody: off by default. Head and shoulders in view is enough, in a duel
  // and at the Auth0 Ritual Gate.
  constructor({ sides, requireFullBody = false }) {
    this.sides = sides;
    this.requireFullBody = requireFullBody;
    this.step = 0;
    this.done = false;
    // When each step was finished, for the server to check at the Ritual Gate.
    this.log = [];
    this.progress = Object.fromEntries(sides.map((side) => [side, 0]));
    this.complete = Object.fromEntries(sides.map((side) => [side, false]));
    this.inFrame = Object.fromEntries(sides.map((side) => [side, false]));
    this.lastPose = {};
    this.lastT = null;
  }

  get current() {
    return STEPS[this.step] ?? null;
  }

  // input: { poses: { side: pose }, hands: { side: hands[] }, aspect }
  update(input, t) {
    if (this.done) return;
    const dt = this.lastT == null ? 0 : Math.min(100, t - this.lastT);
    this.lastT = t;
    const step = this.current;
    for (const side of this.sides) {
      const pose = input.poses?.[side];
      this.inFrame[side] = this.requireFullBody ? bodyInFrame(pose) : inView(pose);
      const before = this.lastPose[side];
      if (pose && pose !== before?.pose) this.lastPose[side] = { pose, t };
      if (this.complete[side]) continue;
      // Not in view: nothing counts until the camera can see them.
      if (!this.inFrame[side]) continue;
      let doing = false;
      if (step.id === 'thumbs') doing = twoThumbsUp(input.hands?.[side]);
      else if (step.id === 'heart') doing = isHeart(input.hands?.[side], input.aspect);
      else if (step.id === 'dance') {
        const seconds = before && pose !== before.pose ? (t - before.t) / 1000 : 0;
        doing = seconds > 0 ? movingLimbs(before.pose, pose, seconds, input.aspect) >= DANCE_LIMBS : this.dancing?.[side];
        this.dancing = { ...this.dancing, [side]: doing };
      }
      const hold = HOLD_MS[step.id];
      if (doing) this.progress[side] = Math.min(hold, this.progress[side] + dt);
      // Holds reset when you let go; a dance only slowly drains, so a pause doesn't wipe it.
      else this.progress[side] = step.id === 'dance' ? Math.max(0, this.progress[side] - dt * 0.25) : 0;
      if (this.progress[side] >= hold) this.complete[side] = true;
    }
    if (this.sides.every((side) => this.complete[side])) this.next(t);
  }

  // Moves on to the next step (also used by the test-mode button at the Ritual Gate).
  next(t = performance.now()) {
    this.log.push({ id: this.current.id, at: Math.round(t) });
    this.step += 1;
    if (this.step >= STEPS.length) {
      this.done = true;
      return;
    }
    for (const side of this.sides) {
      this.progress[side] = 0;
      this.complete[side] = false;
    }
    this.dancing = {};
  }

  // 0 to 1 for a side's current step.
  share(side) {
    const step = this.current;
    return step ? Math.min(1, this.progress[side] / HOLD_MS[step.id]) : 1;
  }
}
