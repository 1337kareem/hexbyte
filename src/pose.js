// Body shapes and hit zones, shared by the duel logic, the AI and the renderer.
// Points are MediaPipe pose landmarks in frame coordinates (0 to 1, mirrored so
// Player 1 is on the left). Distances use the frame's width/height ratio, so a
// circle on screen is a circle here too.

// A wizard with no camera body (keyboard mode or the AI) stands in its spot.
export function standingPose(side, t, status) {
  const cx = side === 0 ? 0.27 : 0.73;
  const facing = side === 0 ? 1 : -1;
  // Bob in two steps, like a two-frame idle sprite.
  const bob = Math.floor(t / 450 + side) % 2 === 0 ? 0 : 0.008;
  // Arms come up while casting and while holding a charged orb.
  const casting = status === 'listening' || status === 'channeling' || status === 'armed';
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

// Head ×1.5, torso ×1, arms and legs ×0.75.
export const ZONE_MULTIPLIERS = { head: 1.5, torso: 1, limb: 0.75 };

const LIMBS = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

const scaled = (p, aspect) => ({ x: p.x * aspect, y: p.y });

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Which part of a body an orb at `point` (radius r) touches: head, torso, limb, or null.
export function hitZone(pose, point, radius, aspect = 16 / 9) {
  if (!pose?.[0] || !pose[11] || !pose[12]) return null;
  const P = (i) => scaled(pose[i], aspect);
  const at = scaled(point, aspect);
  const shoulders = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y) || 0.1;
  const headRadius = Math.min(0.11, Math.max(0.035, shoulders * 0.4));
  const head = P(0);
  if (Math.hypot(at.x - head.x, at.y - (head.y - headRadius * 0.3)) <= headRadius + radius) return 'head';
  const torso = [P(11), P(12), P(24), P(23)];
  if (insidePolygon(at, torso) || [[11, 12], [12, 24], [24, 23], [23, 11]].some(([a, b]) => segmentDistance(at, P(a), P(b)) <= radius)) {
    return 'torso';
  }
  const thickness = Math.max(0.015, shoulders * 0.22);
  // Arms down at your sides count as body shots; raised arms and legs are limbs.
  const bodyTop = Math.min(P(11).y, P(12).y);
  const bodyBottom = pose[23] && pose[24] ? Math.max(P(23).y, P(24).y) : bodyTop + 0.2;
  for (const [a, b] of LIMBS) {
    if (!pose[a] || !pose[b] || segmentDistance(at, P(a), P(b)) > thickness + radius) continue;
    const arm = a <= 16;
    return arm && at.y >= bodyTop && at.y <= bodyBottom ? 'torso' : 'limb';
  }
  return null;
}

// Where an aim at a zone lands on a body, for the keyboard aim marker and the AI.
export function zonePoint(pose, zone) {
  if (zone === 'head') return { x: pose[0].x, y: pose[0].y };
  if (zone === 'limb') return { x: (pose[25].x + pose[26].x) / 2, y: (pose[25].y + pose[26].y) / 2 };
  return { x: (pose[11].x + pose[12].x + pose[23].x + pose[24].x) / 4, y: (pose[11].y + pose[12].y + pose[23].y + pose[24].y) / 4 };
}

// Jumping lifts the whole body; ducking drops the head and shoulders. Keyboard
// players and the AI dodge this way; on camera, players jump and duck for real.
export function dodgePose(pose, move, t) {
  if (!move || t >= move.until || t < move.start) return pose;
  const progress = (t - move.start) / (move.until - move.start);
  const amount = Math.min(1, Math.sin(progress * Math.PI) * 1.6);
  if (move.kind === 'jump') {
    const lift = 0.2 * Math.sin(progress * Math.PI);
    return pose.map((p) => ({ x: p.x, y: p.y - lift }));
  }
  const drop = (i) => (i <= 22 ? 0.18 : i <= 24 ? 0.08 : i <= 26 ? 0.04 : 0);
  return pose.map((p, i) => ({ x: p.x, y: p.y + drop(i) * amount }));
}
