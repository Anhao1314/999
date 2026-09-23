// Presentation state for the Employee Lobby.
//
// Seating/crop algorithms adapted from the user-supplied ai_employee_codexkit
// core/core.js. Rooms and seats are PRESENTATION_ONLY: they never determine
// assignment, authority, capability, permission or scheduling.
//
// The Lobby speaks the frozen Experience vocabulary and nothing else:
//   availability  AVAILABLE | WORKING | DISABLED
//   role          EXECUTION | REVIEW | REPAIR
// Transport health lives on the store's `connection` field, never on an
// Employee: an unreachable Runtime never changes anyone's availability.
export const PORTRAIT_RATIO = 0.618;

export const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  WORKING: "WORKING",
  DISABLED: "DISABLED",
});

export const ROLE = Object.freeze({
  EXECUTION: "EXECUTION",
  REVIEW: "REVIEW",
  REPAIR: "REPAIR",
});

// A derived Runtime diagnostic on a card, never an Employee status.
export const CONDITION_MULTIPLE_ACTIVE_RUNS = "MULTIPLE_ACTIVE_RUNS";

// Transport state of the browser's read path. Values name the transport, not
// the Employees: RUNTIME_UNAVAILABLE describes the connection between this
// page and the Runtime process, and nothing about who is working.
export const CONNECTION = Object.freeze({
  CONNECTING: "CONNECTING",
  LIVE: "LIVE",
  RUNTIME_UNAVAILABLE: "RUNTIME_UNAVAILABLE",
});

export const FLOOR_ROOMS = Object.freeze([
  { id: 'founder', name: '创始人办公室' },
  { id: 'research', name: '产品研究' },
  { id: 'design', name: '设计内容' },
  { id: 'engineering', name: '工程自动化' },
  { id: 'delivery', name: '交付运营' },
  { id: 'collaboration', name: '会议协作' },
]);

export function syncRooms(employees, previous = []) {
  const active = new Map(employees.map((e) => [e.employeeId, e]));
  if (active.size !== employees.length) throw new Error("Duplicate employee");
  const seen = new Set();
  const rooms = FLOOR_ROOMS.map(({ id, name }) => ({
    id, name,
    seats: (previous.find((room) => room.id === id)?.seats ?? []).map((employeeId) => {
      if (!active.has(employeeId) || seen.has(employeeId)) return null;
      seen.add(employeeId);
      return employeeId;
    }),
  }));
  for (const e of [...active.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId))) {
    if (seen.has(e.employeeId)) continue;
    const room = rooms.reduce((best, candidate) =>
      candidate.seats.filter(Boolean).length < best.seats.filter(Boolean).length ? candidate : best,
    );
    const empty = room.seats.indexOf(null);
    if (empty < 0) room.seats.push(e.employeeId);
    else room.seats[empty] = e.employeeId;
  }
  return rooms;
}

export function cropRect(width, height, zoom = 1, x = 0, y = 0) {
  if (![width, height, zoom, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || zoom < 1) throw new Error("Invalid crop");
  let w = Math.min(width, height * PORTRAIT_RATIO) / zoom, h = w / PORTRAIT_RATIO;
  return { x: (width - w) / 2 * (1 + Math.max(-1, Math.min(1, x))), y: (height - h) / 2 * (1 + Math.max(-1, Math.min(1, y))), width: w, height: h };
}

// A card is "working" or it is not; the visual layer never derives more than
// that. `role` decides which animation a working card gets, and an unresolved
// condition keeps the card still instead of guessing a focus.
export function isWorking(card) {
  return card.availability === AVAILABILITY.WORKING;
}

export function currentRoleOf(card) {
  return card?.currentWork?.role ?? null;
}

export function needsFounderCheck(card) {
  return card?.condition === CONDITION_MULTIPLE_ACTIVE_RUNS;
}

export function visualAction(state, card) {
  if (state.connection !== CONNECTION.LIVE) return "still";
  if (needsFounderCheck(card)) return "still";
  return isWorking(card) ? "typing" : "still";
}

// The one place the browser read model is replaced after a poll. A new
// projection replaces the previous one whole: the Lobby never patches Runtime
// truth event by event, and a stale response can never overwrite a newer one.
export class EmployeeStore {
  constructor() {
    this.state = {
      companyId: null,
      source: "live",
      capturedAt: null,
      summary: { employees: 0, working: 0, available: 0, disabled: 0 },
      employees: [],
      rooms: syncRooms([]),
      connection: CONNECTION.CONNECTING,
    };
    this.listeners = new Set();
    this.generation = -1;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  connection(value) {
    this.state = { ...this.state, connection: value };
    this.emit();
  }

  replace(readModel, generation = this.generation + 1) {
    if (generation <= this.generation) return false;
    this.generation = generation;
    const sameCompany = this.state.companyId === readModel.companyId;
    this.state = {
      ...readModel,
      rooms: syncRooms(readModel.employees, sameCompany ? this.state.rooms : []),
      connection: CONNECTION.LIVE,
    };
    this.emit();
    return true;
  }
}
