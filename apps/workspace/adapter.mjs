// The Workspace's only Runtime coupling: the frozen Workforce Experience API.
//
//   Founder Workspace  →  Experience projections  →  Runtime Truth
//
// This adapter holds no kernel, opens no database, derives no Company fact of
// its own and owns no write path: there is no command method here at all. It
// fetches the projections, replaces the browser read model whole, and reports
// transport health through the store's `connection` field — never by rewriting
// what the last projection said about the Company.

export const EXPERIENCE_PATHS = Object.freeze({
  workspace: (companyId) =>
    `/experience/companies/${encodeURIComponent(companyId)}/workspace`,
  employee: (employeeId) => `/experience/employees/${encodeURIComponent(employeeId)}`,
  lineage: (workId) => `/experience/works/${encodeURIComponent(workId)}/lineage`,
  liveAction: (workId) => `/experience/works/${encodeURIComponent(workId)}/live-action`,
  artifactReading: (artifactId) => `/experience/artifacts/${encodeURIComponent(artifactId)}/reading`,
});

// Existing read-only inventory endpoint. Each item is enriched with its
// Experience lineage before the Work page presents a state or decision.
export const WORKS_PATH = (companyId) =>
  `/companies/${encodeURIComponent(companyId)}/works`;
export const POSITIONS_PATH = (companyId) =>
  `/companies/${encodeURIComponent(companyId)}/positions`;
export const EMPLOYEES_PATH = (companyId) =>
  `/companies/${encodeURIComponent(companyId)}/employees`;

const LIVE_SOURCE = 'live';

// The Experience projection is already the product read model; this mapping
// only stamps who and when the browser read it.
export function workspaceToReadModel(companyId, projection) {
  return {
    companyId,
    source: LIVE_SOURCE,
    capturedAt: new Date().toISOString(),
    projection,
  };
}

export class HttpWorkspaceAdapter {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), interval = 2000 } = {}) {
    this.fetcher = fetcher;
    this.interval = interval;
  }

  async request(path, options = {}) {
    const response = await this.fetcher(path, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(8000),
      headers: { accept: 'application/json', ...options.headers },
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(data.error?.message ?? `HTTP ${response.status}`),
        { code: data.error?.code, status: response.status },
      );
    return data;
  }

  companies(signal) {
    return this.request('/companies', { signal }).then((data) => data.companies);
  }

  workspace(companyId, signal) {
    return this.request(EXPERIENCE_PATHS.workspace(companyId), { signal });
  }

  async snapshot(companyId, signal) {
    return workspaceToReadModel(companyId, await this.workspace(companyId, signal));
  }

  employeeDetail(employeeId, signal) {
    return this.request(EXPERIENCE_PATHS.employee(employeeId), { signal });
  }

  lineage(workId, signal) {
    return this.request(EXPERIENCE_PATHS.lineage(workId), { signal });
  }

  liveAction(workId, signal) {
    return this.request(EXPERIENCE_PATHS.liveAction(workId), { signal });
  }

  artifactReading(artifactId, signal) {
    return this.request(EXPERIENCE_PATHS.artifactReading(artifactId), { signal });
  }

  works(companyId, signal) {
    return this.request(WORKS_PATH(companyId), { signal }).then((data) => data.works);
  }

  positions(companyId, signal) {
    return this.request(POSITIONS_PATH(companyId), { signal }).then((data) => data.positions);
  }

  employees(companyId, signal) {
    return this.request(EMPLOYEES_PATH(companyId), { signal }).then((data) => data.employees);
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
        // Transport failure only: the last known projection stays on screen,
        // visibly marked as not fresh, and no Company or Employee state is
        // rewritten to explain the outage.
        if (!stopped) store.connection('RUNTIME_UNAVAILABLE');
      } finally {
        clearTimeout(deadline);
        if (!stopped) timer = setTimeout(poll, this.interval);
      }
    };
    store.connection('CONNECTING');
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }
}
