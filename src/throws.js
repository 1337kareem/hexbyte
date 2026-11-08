// Camera throws. Every attack can be thrown with a natural swing of either arm:
// - sideways at the opponent, and the orb follows the swing;
// - forward at the screen or overhand, and it flies at the opponent, higher or lower
//   with the swing;
// Only a wind-up (a swing straight back, away from the opponent) doesn't count.
// Points are frame coordinates (0 to 1, mirrored so Player 1 is on the left).

// A throw: a wrist moving at least this fast (frame heights per second), measured over
// the last THROW_WINDOW_MS.
export const THROW_SPEED = 1.0;
export const THROW_WINDOW_MS = 260;
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

// The fastest swing of either wrist, if it's a throw. dx is scaled by the aspect.
export function swingOf(tracks, side, aspect, minSpeed = THROW_SPEED) {
  let best = null;
  for (const i of WRISTS) {
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
export function throwDirection(swing, foeTorso, aspect) {
  if (swing.toward > 0.6 * swing.size) return { x: swing.dx / aspect, y: swing.dy };
  const y = Math.min(0.95, Math.max(0.05, swing.at.y + (swing.dy / swing.size) * 0.2));
  return { x: foeTorso.x - swing.at.x, y: y - swing.at.y };
}
