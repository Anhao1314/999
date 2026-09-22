export class HttpEmployeeAdapter {
  constructor({ fetcher = (...args) => globalThis.fetch(...args), interval = 2000 } = {}) { this.fetcher = fetcher; this.interval = interval; this.mode = 'live'; }
  async request(path, options = {}) {
    const response = await this.fetcher(path, { ...options, signal: options.signal ?? AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message ?? `HTTP ${response.status}`), { code: data.error?.code, status: response.status });
    if (response.status === 202) throw new Error('命令仅被受理，尚未确认；请刷新核对状态，勿重复提交');
    return data;
  }
  companies(signal) { return this.request('/companies', { signal }).then(d => d.companies); }
  snapshot(companyId, signal) { return this.request(`/employee-api/snapshot?companyId=${encodeURIComponent(companyId)}`, { signal }); }
  history(companyId, employeeId, before) { return this.request(`/employee-api/history?${new URLSearchParams({ companyId, employeeId, ...(before ? { before } : {}) })}`); }
  command(companyId, kind, input) { return this.request('/employee-api/commands', { method: 'POST', body: JSON.stringify({ companyId, kind, input, idempotencyKey: crypto.randomUUID() }) }); }
  subscribe(companyId, store) {
    let stopped = false, timer, controller;
    const poll = async () => {
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8000);
      try { const snapshot = await this.snapshot(companyId, controller.signal); if (!stopped) store.snapshot(snapshot); }
      catch { if (!stopped) store.connection('offline'); }
      finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(poll, this.interval); }
    };
    store.connection('connecting'); poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }
}
