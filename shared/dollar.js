// Rune matching, based on the $1 Unistroke Recognizer (Wobbrock, Wilson and Li,
// UIST 2007): turn a drawn stroke into 64 standard points, then score how closely
// two strokes match from 0 (nothing alike) to 1 (identical).
//
// Unlike classic $1, a rune keeps its orientation, proportions and drawing
// direction, like a signature. Classic $1 rotates every shape to a standard angle
// and stretches it to a square, which let a square pass as a circle (0.88).
// Here the worst look-alike in our tests scores 0.74, while the same rune drawn
// tilted 12° and squashed 15% still scores above 0.9.
const N = 64;
const SIZE = 250;
const HALF_DIAGONAL = 0.5 * Math.sqrt(2 * SIZE * SIZE);
const RANGE = (15 * Math.PI) / 180;
const PRECISION = (2 * Math.PI) / 180;
const PHI = 0.5 * (-1 + Math.sqrt(5));

// The smallest rune we accept, as a share of the camera frame.
export const MIN_RUNE_SIZE = 0.04;

// Checks a raw stroke ([[x, y], ...] in 0..1 frame units) and prepares it.
// Returns null when it is too short or too flat to be a rune.
export function prepareStroke(stroke) {
  if (!Array.isArray(stroke) || stroke.length < 12 || stroke.length > 3000) return null;
  const points = [];
  for (const point of stroke) {
    const [x, y] = Array.isArray(point) ? point : [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
  }
  const box = boundingBox(points);
  if (box.width < MIN_RUNE_SIZE || box.height < MIN_RUNE_SIZE) return null;

  let prepared = resample(points, N);
  prepared = scaleUniform(prepared, SIZE);
  prepared = translateToOrigin(prepared);
  return prepared.map(({ x, y }) => [round(x), round(y)]);
}

// Both inputs must come from prepareStroke.
export function scoreRunes(candidate, template) {
  const a = candidate.map(([x, y]) => ({ x, y }));
  const b = template.map(([x, y]) => ({ x, y }));
  return 1 - distanceAtBestAngle(a, b, -RANGE, RANGE, PRECISION) / HALF_DIAGONAL;
}

const round = (value) => Math.round(value * 100) / 100;
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function pathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += distance(points[i - 1], points[i]);
  return length;
}

function resample(input, count) {
  const points = input.map((point) => ({ ...point }));
  const interval = pathLength(points) / (count - 1);
  const output = [points[0]];
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const step = distance(points[i - 1], points[i]);
    if (travelled + step >= interval && step > 0) {
      const t = (interval - travelled) / step;
      const point = {
        x: points[i - 1].x + t * (points[i].x - points[i - 1].x),
        y: points[i - 1].y + t * (points[i].y - points[i - 1].y),
      };
      output.push(point);
      points.splice(i, 0, point);
      travelled = 0;
    } else {
      travelled += step;
    }
  }
  while (output.length < count) output.push({ ...points[points.length - 1] });
  return output.slice(0, count);
}

function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function rotateBy(points, radians) {
  const c = centroid(points);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((p) => ({
    x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x,
    y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y,
  }));
}

function boundingBox(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// Scales the longer side to SIZE and keeps the proportions.
function scaleUniform(points, size) {
  const box = boundingBox(points);
  const scale = size / Math.max(box.width, box.height, 1e-6);
  return points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

function translateToOrigin(points) {
  const c = centroid(points);
  return points.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

function pathDistance(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += distance(a[i], b[i]);
  return total / a.length;
}

const distanceAtAngle = (points, template, radians) => pathDistance(rotateBy(points, radians), template);

// Golden-section search for the rotation that lines the two strokes up best.
function distanceAtBestAngle(points, template, from, to, threshold) {
  let a = from;
  let b = to;
  let x1 = PHI * a + (1 - PHI) * b;
  let f1 = distanceAtAngle(points, template, x1);
  let x2 = (1 - PHI) * a + PHI * b;
  let f2 = distanceAtAngle(points, template, x2);
  while (Math.abs(b - a) > threshold) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = PHI * a + (1 - PHI) * b;
      f1 = distanceAtAngle(points, template, x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = (1 - PHI) * a + PHI * b;
      f2 = distanceAtAngle(points, template, x2);
    }
  }
  return Math.min(f1, f2);
}
