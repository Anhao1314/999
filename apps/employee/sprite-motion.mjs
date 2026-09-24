// Original FlowCredit character atlas contract. Four frames per direction,
// four directions per action row; the generated JSON manifest mirrors this.
export const FRAME = Object.freeze({ width: 24, height: 36, columns: 16, rows: 11 });
export const DIRECTIONS = Object.freeze(['front', 'back', 'right', 'left']);
export const ACTIONS = Object.freeze({
  idle: { row: 0, frames: 2, fps: 2, loop: true },
  think: { row: 1, frames: 3, fps: 3, loop: true },
  excited: { row: 2, frames: 4, fps: 7, loop: false },
  stress: { row: 3, frames: 3, fps: 4, loop: true },
  walk: { row: 4, frames: 4, fps: 8, loop: true },
  point: { row: 5, frames: 3, fps: 4, loop: true },
  sleep: { row: 6, frames: 2, fps: 1, loop: true },
  cheer: { row: 7, frames: 4, fps: 7, loop: false },
  wave: { row: 8, frames: 4, fps: 6, loop: false },
  type: { row: 9, frames: 4, fps: 7, loop: true },
  read: { row: 10, frames: 3, fps: 3, loop: true },
});

const players = new Set();
let timer = null;
function tick() {
  for (const player of players) player.update();
}
function register(player) {
  players.add(player);
  if (!timer) timer = setInterval(tick, 80);
}
function unregister(player) {
  players.delete(player);
  if (!players.size && timer) { clearInterval(timer); timer = null; }
}

export function spriteVariant(employeeId) {
  return Array.from(String(employeeId)).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 8 + 1;
}
export function spriteUrl(employeeId, assistant = false) {
  return `/employee-assets/assets/sprite-${assistant ? 'assistant' : spriteVariant(employeeId)}.png`;
}
export function portraitUrl(employeeId, assistant = false) {
  return `/employee-assets/assets/portrait-${assistant ? 'assistant' : spriteVariant(employeeId)}.png`;
}

export function createSpritePlayer(element, { employeeId, assistant = false, reduced = () => false } = {}) {
  let pose = 'idle', base = 'idle', direction = 'front', began = performance.now(), once = false;
  let enabled = true;
  element.style.backgroundImage = `url('${spriteUrl(employeeId, assistant)}')`;
  function draw(frame = 0) {
    const scale = element.getBoundingClientRect().width / FRAME.width || 2;
    element.style.backgroundSize = `${FRAME.width * FRAME.columns * scale}px ${FRAME.height * FRAME.rows * scale}px`;
    element.style.backgroundPosition = `${-(DIRECTIONS.indexOf(direction) * 4 + frame) * FRAME.width * scale}px ${-ACTIONS[pose].row * FRAME.height * scale}px`;
  }
  const player = {
    update() {
      if (!element.isConnected || !enabled || document.hidden || element.closest('.fc-hidden')) return;
      if (once && performance.now() - began >= ACTIONS[pose].frames * 1000 / ACTIONS[pose].fps) {
        once = false; pose = base; began = performance.now();
      }
      const action = ACTIONS[pose];
      draw(reduced() ? 0 : Math.floor((performance.now() - began) * action.fps / 1000) % action.frames);
    },
    setBase(next) {
      if (!(next in ACTIONS)) throw new Error(`Unknown sprite action: ${next}`);
      base = next;
      if (!once && pose !== next) { pose = next; began = performance.now(); }
      player.update();
    },
    play(next) {
      if (!(next in ACTIONS)) throw new Error(`Unknown sprite action: ${next}`);
      pose = next; once = !ACTIONS[next].loop; began = performance.now(); player.update();
    },
    setDirection(next) { if (!DIRECTIONS.includes(next)) throw new Error(`Unknown direction: ${next}`); direction = next; player.update(); },
    setEnabled(next) { if (enabled === Boolean(next)) return; enabled = Boolean(next); if (!enabled) draw(0); else { began = performance.now(); player.update(); } },
    destroy() { unregister(player); },
    get pose() { return pose; },
  };
  register(player); player.update();
  return player;
}
