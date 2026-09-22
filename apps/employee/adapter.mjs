// The Lobby's only Runtime coupling: the frozen Workforce Experience HTTP API.
//
//   Employee Lobby UI  →  Experience API  →  Runtime Truth
//
// This adapter holds no kernel, opens no database and derives nothing about
// Employees: it fetches Experience projections, maps them into the browser's
// read model, and posts the one Founder control (enable/disable) through the
// Runtime's existing authorized command seam. Polling replaces the read model
// whole — the browser never patches Runtime truth event by event.

export const EXPERIENCE_PATHS = Object.freeze({
  workforce: (companyId) => `/experience/companies/${encodeURIComponent(companyId)}/workforce`,
  employee: (employeeId) => `/experience/employees/${encodeURIComponent(employeeId)}`,
  lineage: (workId) => `/experience/works/${encodeURIComponent(workId)}/lineage`,
});

const ROLE_VALUES = new Set(["EXECUTION", "REVIEW", "REPAIR"]);

// The Experience projection is already the product model; this mapping only
// renames Employee fields to the Lobby's card shape and bounds nothing.
export function workforceToReadModel(companyId, workforce) {
  return {
    companyId,
    source: "live",
    capturedAt: new Date().toISOString(),
    summary: {
      employees: workforce.summary.employees,
      working: workforce.summary.working,
      available: workforce.summary.available,
      disabled: workforce.summary.disabled,
    },
    employees: workforce.employees.map((card) => ({
      employeeId: card.employeeId,
      displayName: card.displayName,
      position: card.position,
      capabilities: card.capabilities ?? [],
      availability: card.availability,
      condition: card.condition ?? null,
      currentWork: card.currentWork
        ? { ...card.currentWork, role: ROLE_VALUES.has(card.currentWork.role) ? card.currentWork.role : null }
        : null,
      execution: card.execution ?? null,
    })),
  };
}

export class HttpEmployeeAdapter {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), interval = 2000 } = {}) {
    this.fetcher = fetcher;
    this.interval = interval;
    this.mode = "live";
  }

  async request(path, options = {}) {
    const response = await this.fetcher(path, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message ?? `HTTP ${response.status}`), { code: data.error?.code, status: response.status });
    if (response.status === 202) throw new Error("命令仅被受理，尚未确认；请刷新核对状态，勿重复提交");
    return data;
  }

  companies(signal) {
    return this.request("/companies", { signal }).then((data) => data.companies);
  }

  workforce(companyId, signal) {
    return this.request(EXPERIENCE_PATHS.workforce(companyId), { signal });
  }

  async snapshot(companyId, signal) {
    return workforceToReadModel(companyId, await this.workforce(companyId, signal));
  }

  employeeDetail(employeeId) {
    return this.request(EXPERIENCE_PATHS.employee(employeeId));
  }

  lineage(workId) {
    return this.request(EXPERIENCE_PATHS.lineage(workId));
  }

  // The only write path the Lobby has: an explicit Founder control, classified
  // as a Company control and routed through the Runtime command seam. Assign
  // and start are not reachable from this adapter at all.
  setEmployeeEnabled(employeeId, enabled) {
    return this.request("/commands", {
      method: "POST",
      body: JSON.stringify({ command: "setEmployeeEnabled", input: { employeeId, enabled } }),
    });
  }

  subscribe(companyId, store) {
    let stopped = false;
    let timer;
    let controller;
    const poll = async () => {
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8000);
      try {
        store.replace(await this.snapshot(companyId, controller.signal));
      } catch {
        // Transport failure only: the Employee vocabulary is untouched and the
        // last known projection stays on screen, clearly marked stale.
        if (!stopped) store.connection("RUNTIME_UNAVAILABLE");
      } finally {
        clearTimeout(deadline);
        if (!stopped) timer = setTimeout(poll, this.interval);
      }
    };
    store.connection("CONNECTING");
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }
}
