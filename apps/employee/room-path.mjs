// Presentation-only routes. Each of the four visible seats has its own lane,
// so paths remain in one display room and never cross another employee lane.
const stations = Object.freeze([
  { rest: [26, 32], work: [20, 22] },
  { rest: [74, 32], work: [80, 22] },
  { rest: [26, 76], work: [20, 66] },
  { rest: [74, 76], work: [80, 66] },
]);
export function roomPoint(slot, working) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= stations.length) throw new RangeError('Only four overview seats are visible');
  const [x, y] = working ? stations[slot].work : stations[slot].rest;
  return { x, y };
}
export function roomRoute(slot, fromWorking, toWorking) {
  const from = roomPoint(slot, fromWorking), to = roomPoint(slot, toWorking);
  if (fromWorking === toWorking) return [from];
  return [from, { x: from.x, y: to.y }, to];
}
export function roomRouteValid(slot, route) {
  if (!Array.isArray(route) || !route.length) return false;
  const [row, column] = [Math.floor(slot / 2), slot % 2];
  return route.every(({ x, y }) => x >= (column ? 50 : 0) && x <= (column ? 100 : 50)
    && y >= (row ? 50 : 0) && y <= (row ? 100 : 50));
}
