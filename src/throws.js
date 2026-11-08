// Camera throws. The orb stays in your hand while you hold the spell's hand sign
// (✊ fire, ✌️ lightning, 👍 frost). It launches the moment you let go, and only then.
// Letting go is either opening your hand (the sign ends) or flicking it hard at the
// opponent, which is how most people throw a ✌️: the camera still sees the V.
// The way your arm was moving when you let go steers it:
// - swinging sideways at the opponent: it follows the swing;
// - swinging forward at the screen or overhand: it flies at the opponent, a little
//   higher or lower with the swing;
// - not swinging: straight across at the height of your hand.
// Points are frame coordinates (0 to 1, mirrored so Player 1 is on the left).

// The hand sign can drop out for a frame mid-swing, so a let-go has to last this long.
export const RELEASE_MS = 150;
// Arm movement at least this fast (frame heights per second) over the last
// THROW_WINDOW_MS counts as a swing that steers the throw.
export const THROW_SPEED = 0.6;
export const THROW_WINDOW_MS = 260;
// A flick that counts as letting go: the orb's hand moving at least this fast. That's
// half the frame's height in about a quarter second, so only a real throw does it.
export const FLICK_SPEED = 1.8;
// Right after the orb appears, the hand may still be moving into the sign: ignore flicks.
export const FLICK_SETTLE_MS = 300;
// MediaPipe pose wrists: left 15, right 16.
export const WRISTS = [15, 16];

export const emptyTracks = () => ({ 15: [], 16: [] });

// Adds the wrists' newest positions and drops samples older than the window.
export function trackWrists(tracks, body, t) {
  for (const i of WRISTS) {
    const point = body?.[i];
    if (!point) continue;
    const last = tracks[i].at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) tracks[i].push({ x: point.x, y: point.y, t });
    tracks[i] = tracks[i].filter((sample) => t - sample.t <= THROW_WINDOW_MS);
  }
  return tracks;
}

// The fastest swing of the given wrists (both by default). dx is scaled by the aspect.
export function swingOf(tracks, side, aspect, minSpeed = THROW_SPEED, wrists = WRISTS) {
  let best = null;
  for (const i of wrists) {
    const track = tracks[i];
    if (track.length < 2) continue;
    const first = track[0];
    const last = track.at(-1);
    const seconds = (last.t - first.t) / 1000;
    if (seconds < 0.04) continue;
    const dx = (last.x - first.x) * aspect;
    const dy = last.y - first.y;
    const size = Math.hypot(dx, dy);
    const speed = size / seconds;
    const toward = (side === 0 ? 1 : -1) * dx;
    if (speed < minSpeed || (toward < 0 && -toward > 0.6 * size)) continue;
    if (!best || speed > best.speed) best = { wrist: i, at: { x: last.x, y: last.y }, dx, dy, size, toward, speed };
  }
  return best;
}

// Where a swing sends the orb, as a direction in frame units. A sideways swing at the
// opponent keeps its own angle; any other throw heads for the opponent's body.
// One frame of an orb in a camera player's hand. holding: is the spell's hand sign
// held right now? flicked: did the orb's hand just make a hard throwing flick?
// Returns 'release' only for a real let-go: never on its own, never on a flicker.
export function gripStep(orb, holding, t, flicked = false) {
  orb.since ??= t;
  if (flicked && t - orb.since >= FLICK_SETTLE_MS) return 'release';
  if (holding) {
    orb.gripped = true;
    orb.letGoAt = null;
    return 'held';
  }
  // Let go before the orb appeared: it waits until they make the sign again and let go.
  if (!orb.gripped) return 'waiting';
  orb.letGoAt ??= t;
  return t - orb.letGoAt >= RELEASE_MS ? 'release' : 'held';
}

// Where the orb goes when the hand lets go, as a direction in frame units.
export function releaseDirection(swing, hand, foeTorso, aspect) {
  if (swing) return throwDirection(swing, foeTorso, aspect);
  return { x: foeTorso.x - hand.x, y: 0 };
}

export function throwDirection(swing, foeTorso, aspect) {
  if (swing.toward > 0.6 * swing.size) return { x: swing.dx / aspect, y: swing.dy };
  const y = Math.min(0.95, Math.max(0.05, swing.at.y + (swing.dy / swing.size) * 0.2));
  return { x: foeTorso.x - swing.at.x, y: y - swing.at.y };
}
