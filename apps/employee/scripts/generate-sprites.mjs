// Deterministic original 24×36 human sprite set, authored for FlowCredit.
// Run with: node apps/employee/scripts/generate-sprites.mjs
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { FRAME, DIRECTIONS, ACTIONS } from '../sprite-motion.mjs';

const output = new URL('../assets/', import.meta.url);
const transparent = [0, 0, 0, 0];
const colors = {
  outline: '#17243a', navy: '#243957', blue: '#1769cf', bright: '#43a8f7', gold: '#f2bd59',
  white: '#f8f6ef', blush: '#d48278', ink: '#0f1d32', paper: '#dceefb',
};
const looks = [
  ['#f0b88d', '#18283c', '#2d6cb6', '#1e3b62', 'short'],
  ['#b87958', '#1d1b2d', '#297e98', '#1d4962', 'curl'],
  ['#f2c49d', '#624132', '#7154ac', '#273350', 'side'],
  ['#d69772', '#182538', '#bd614e', '#253b5e', 'long'],
  ['#f2d3b0', '#ac744c', '#348a69', '#20364c', 'swept'],
  ['#9a604a', '#262333', '#9765b3', '#25354f', 'short'],
  ['#ddb08e', '#3a3743', '#4379b6', '#28354d', 'bun'],
  ['#bd8967', '#493325', '#bd8542', '#213955', 'curl'],
  ['#efc4a0', '#243047', '#f4f6fb', '#173d79', 'side'],
];
function rgba(hex) {
  if (!hex) return transparent;
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(255);
}
function canvas(width, height) {
  const data = new Uint8Array(width * height * 4);
  function rect(x, y, w, h, color) {
    const pixel = rgba(color);
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py++)
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px++) data.set(pixel, (py * width + px) * 4);
  }
  return { width, height, data, rect };
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, content) {
  const body = Buffer.concat([Buffer.from(type), content]);
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(content.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}
function png(image) {
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width, 0); header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(image.height * (1 + image.width * 4));
  for (let y = 0; y < image.height; y++) rows.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * (1 + image.width * 4) + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function frame(draw, ox, oy, look, action, phase, direction) {
  const [skin, hair, jacket, trousers, style] = look;
  const r = (x, y, w, h, c) => draw(ox + x, oy + y, w, h, c);
  const moving = action === 'walk';
  const step = moving ? [0, 2, 0, -2][phase] : 0;
  const bounce = ['excited', 'cheer'].includes(action) ? [0, -2, -3, -1][phase] : moving ? [0, -1, 0, -1][phase] : 0;
  const leaning = action === 'sleep' ? 2 : action === 'stress' ? [-1, 0, 1, 0][phase] : 0;
  const back = direction === 'back', side = direction === 'right' || direction === 'left';
  const flip = direction === 'left' ? (x, w) => 24 - x - w : (x) => x;
  const p = (x, y, w, h, c) => r(flip(x, w), y + bounce, w, h, c);
  // Four readable layers: shoes, trousers, jacket, head. Every frame stays inside 24×36.
  p(6 + step, 32, 5, 3, colors.outline); p(13 - step, 32, 5, 3, colors.outline);
  p(7 + step, 27, 4, 6, trousers); p(13 - step, 27, 4, 6, trousers);
  p(6, 16, 12, 13, colors.outline); p(7, 17, 10, 10, jacket);
  p(8, 17, 2, 9, colors.white + ''); p(10, 17, 5, 8, look === looks[8] ? colors.blue : '#e4e8ef');
  p(11, 17, 2, 5, colors.gold); p(15, 20, 2, 2, colors.bright);
  // Arms follow the pose. Raised silhouettes are deliberately distinctive at small sizes.
  const raised = ['excited', 'cheer', 'wave'].includes(action);
  if (raised) {
    p(3, 11 + phase % 2, 3, 9, jacket); p(18, 10 + (phase + 1) % 2, 3, 10, jacket);
    p(3, 10 + phase % 2, 3, 3, skin); p(18, 9 + (phase + 1) % 2, 3, 3, skin);
  } else if (action === 'point') {
    p(3, 19, 4, 7, jacket); p(17, 18, 5 + phase % 2, 3, jacket); p(21, 18, 3, 3, skin);
  } else if (action === 'type' || action === 'read') {
    p(3, 19, 4, 7, jacket); p(17, 19, 4, 7, jacket);
    p(6 + phase % 2, 23, 4, 3, skin); p(14 - phase % 2, 23, 4, 3, skin);
    if (action === 'read') { p(8, 22, 8, 6, colors.paper); p(11, 22, 1, 5, colors.blue); }
    else { p(8, 25, 8, 2, colors.ink); p(9 + phase % 2, 24, 2, 1, colors.white); }
  } else {
    p(3 + (moving ? -step / 2 : 0), 18, 4, 9, jacket); p(17 - (moving ? -step / 2 : 0), 18, 4, 9, jacket);
    p(4, 26, 3, 3, skin); p(18, 26, 3, 3, skin);
  }
  p(7 + leaning, 4, 10, 13, colors.outline);
  p(8 + leaning, 6, 8, 10, skin);
  p(8 + leaning, 3, 8, 4, hair);
  if (style === 'long' || style === 'bun') { p(6 + leaning, 7, 3, 10, hair); p(16 + leaning, 7, 3, style === 'bun' ? 5 : 10, hair); }
  if (style === 'curl') { p(7 + leaning, 2, 3, 3, hair); p(13 + leaning, 2, 3, 3, hair); }
  if (style === 'side' || style === 'swept') p(6 + leaning, 5, 5, 3, hair);
  if (!back) {
    if (side) p(14 + leaning, 10, 2, 2, colors.ink);
    else { p(9 + leaning, 10, 2, 2, colors.ink); p(14 + leaning, 10, 2, 2, colors.ink); }
    if (action === 'stress') { p(10 + leaning, 14, 4, 1, colors.blush); p(17, 8, 2, 3, colors.bright); }
    if (action === 'think') p(16, 8, 2, 2, colors.gold);
    if (action === 'sleep') p(10 + leaning, 11, 5, 1, colors.outline);
  }
}
for (let variant = 1; variant <= 9; variant++) {
  const look = looks[variant - 1];
  const atlas = canvas(FRAME.width * FRAME.columns, FRAME.height * FRAME.rows);
  for (const [action, spec] of Object.entries(ACTIONS)) {
    for (let d = 0; d < DIRECTIONS.length; d++) {
      for (let phase = 0; phase < 4; phase++) frame(atlas.rect, (d * 4 + phase) * 24, spec.row * 36, look, action, phase, DIRECTIONS[d]);
    }
  }
  const name = variant === 9 ? 'assistant' : String(variant);
  await writeFile(new URL(`sprite-${name}.png`, output), png(atlas));
  const portrait = canvas(72, 108);
  frame((x, y, w, h, c) => portrait.rect(x * 3, y * 3, w * 3, h * 3, c), 0, 0, look, 'idle', 0, 'front');
  await writeFile(new URL(`portrait-${name}.png`, output), png(portrait));
}
await writeFile(new URL('manifest.json', output), JSON.stringify({
  license: 'Original FlowCredit human pixel characters. No third-party code or artwork.',
  frameWidth: FRAME.width, frameHeight: FRAME.height, columns: FRAME.columns, rows: FRAME.rows,
  directions: DIRECTIONS, actions: ACTIONS,
  sprites: Array.from({ length: 9 }, (_, i) => ({ id: i === 8 ? 'assistant' : String(i + 1), image: `sprite-${i === 8 ? 'assistant' : i + 1}.png`, portrait: `portrait-${i === 8 ? 'assistant' : i + 1}.png` })),
}, null, 2) + '\n');
