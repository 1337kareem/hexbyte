// Pixel-art icons on a 12×12 grid. The same bitmaps become inline SVGs for the
// page and filled squares on the duel canvas, so both share one icon family.
// '#' is the icon's main color (currentColor in SVG); '+' is its secondary color.
const BITMAPS = {
  fire: [
    '....#.......',
    '....##......',
    '...###...#..',
    '...####..##.',
    '..#####.###.',
    '..#########.',
    '.####++####.',
    '.###++++###.',
    '.###+++++##.',
    '.##++++++##.',
    '..##++++##..',
    '...######...',
  ],
  shield: [
    '############',
    '#++++##++++#',
    '#++++##++++#',
    '#++++##++++#',
    '############',
    '#++++##++++#',
    '.#+++##+++#.',
    '.#+++##+++#.',
    '..#++##++#..',
    '...#+##+#...',
    '....####....',
    '.....##.....',
  ],
  lightning: [
    '.....#####..',
    '....#####...',
    '....####....',
    '...####.....',
    '...########.',
    '..########..',
    '.....####...',
    '....####....',
    '....###.....',
    '...###......',
    '...##.......',
    '..#.........',
  ],
  soundOn: [
    '......#.....',
    '.....##..#..',
    '....###...#.',
    '#######...#.',
    '#######.#.#.',
    '#######.#.#.',
    '#######.#.#.',
    '#######.#.#.',
    '#######...#.',
    '....###...#.',
    '.....##..#..',
    '......#.....',
  ],
  soundOff: [
    '......#.....',
    '.....##.....',
    '....###.....',
    '#######.....',
    '#######.#..#',
    '#######..##.',
    '#######..##.',
    '#######.#..#',
    '#######.....',
    '....###.....',
    '.....##.....',
    '......#.....',
  ],
  check: [
    '............',
    '............',
    '............',
    '..........##',
    '.........##.',
    '........##..',
    '.##....##...',
    '..##..##....',
    '...####.....',
    '....##......',
    '............',
    '............',
  ],
  cross: [
    '............',
    '............',
    '..##....##..',
    '...##..##...',
    '....####....',
    '.....##.....',
    '....####....',
    '...##..##...',
    '..##....##..',
    '............',
    '............',
    '............',
  ],
  play: [
    '............',
    '...#........',
    '...##.......',
    '...###......',
    '...####.....',
    '...#####....',
    '...#####....',
    '...####.....',
    '...###......',
    '...##.......',
    '...#........',
    '............',
  ],
  hat: [
    '.......#....',
    '......##....',
    '......###...',
    '.....####...',
    '.....#####..',
    '....######..',
    '....######..',
    '...########.',
    '..#++++++##.',
    '############',
    '............',
    '............',
  ],
};

// Face login: a face inside scanner brackets.
BITMAPS.face = [
  '###......###',
  '#..........#',
  '#...####...#',
  '...#....#...',
  '..#.#..#.#..',
  '..#......#..',
  '..#.+..+.#..',
  '...#.++.#...',
  '#...####...#',
  '#..........#',
  '###......###',
  '............',
];

// Frost Shard: an ice crystal.
BITMAPS.frost = [
  '.....##.....',
  '....####....',
  '...##++##...',
  '..##++++##..',
  '.##++++++##.',
  '##++++++++##',
  '##++++++++##',
  '.##++++++##.',
  '..##++++##..',
  '...##++##...',
  '....####....',
  '.....##.....',
];

// Life Drain: a drop of life force with a glint.
BITMAPS.drain = [
  '.....##.....',
  '.....##.....',
  '....####....',
  '....####....',
  '...######...',
  '..########..',
  '..########..',
  '.###++#####.',
  '.###++#####.',
  '..########..',
  '...######...',
  '....####....',
];

// Heal: a pixel cross.
BITMAPS.heal = [
  '............',
  '....####....',
  '....#++#....',
  '....#++#....',
  '.####++####.',
  '.#++++++++#.',
  '.#++++++++#.',
  '.####++####.',
  '....#++#....',
  '....#++#....',
  '....####....',
  '............',
];

// Secondary colors; anything not listed draws '+' as the main color at 45% strength.
const SECONDARY = { fire: '#fde047', hat: '#facc15', frost: '#f0f9ff', drain: '#ede9fe', heal: '#dcfce7' };

export const ELEMENT_COLORS = {
  fire: '#f97316',
  shield: '#38bdf8',
  lightning: '#facc15',
  frost: '#bae6fd',
  drain: '#a78bfa',
  heal: '#4ade80',
};
export const ELEMENT_NAMES = {
  fire: 'Fire',
  shield: 'Shield',
  lightning: 'Lightning',
  frost: 'Frost Shard',
  drain: 'Life Drain',
  heal: 'Heal',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// Decorative by default (aria-hidden). Pass a label when the icon stands alone.
export function icon(name, { size = 24, color, label, className = 'px-icon' } = {}) {
  const rows = BITMAPS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', className);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  if (color) svg.style.color = color;
  if (!rows) return svg;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const cell = row[x];
      if (cell === '.') continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      if (cell === '+') {
        if (SECONDARY[name]) rect.setAttribute('fill', SECONDARY[name]);
        else {
          rect.setAttribute('fill', 'currentColor');
          rect.setAttribute('fill-opacity', '0.45');
        }
      } else {
        rect.setAttribute('fill', 'currentColor');
      }
      svg.append(rect);
    }
  });
  return svg;
}

// Draws an icon on a canvas with its top-left corner at (x, y), each pixel `scale` px wide.
export function drawIcon(ctx, name, x, y, scale, color) {
  const rows = BITMAPS[name];
  if (!rows) return;
  ctx.save();
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (cell === '.') continue;
      if (cell === '+' && !SECONDARY[name]) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = color;
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = cell === '+' ? SECONDARY[name] : color;
      }
      ctx.fillRect(Math.round(x + c * scale), Math.round(y + r * scale), Math.ceil(scale), Math.ceil(scale));
    }
  });
  ctx.restore();
}
