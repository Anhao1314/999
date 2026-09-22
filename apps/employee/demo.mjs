// Synthetic demo adapter for `?demo=1`.
//
// A demo fixture, never Runtime truth: it writes nothing, fetches nothing and
// never mixes into live results. It synthesizes the same read-model shape the
// Experience projection produces, so one Lobby renders both — but its
// employees, works, runs, tokens and messages are explicitly synthetic and
// labeled as such in the UI.
import { AVAILABILITY, CONDITION_MULTIPLE_ACTIVE_RUNS } from "./domain.mjs";

const names = ["沈昇", "Kai", "Luna", "Chen", "Nova", "Momo", "Atlas", "Zoe"];
const roles = ["产品运营", "开发工程师", "内容创作", "数据分析", "视觉设计", "质量验证", "策略研究", "客户支持"];
const roleKinds = ["EXECUTION", "REVIEW", "REPAIR"];
const clone = (value) => structuredClone(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

export class DemoEmployeeAdapter {
  constructor() {
    this.mode = "mock";
    this.interrupted = false;
    this.nextId = 0;
    this.listeners = new Set();
    this.pending = new Set();
    this.disposed = false;
    this.employees = [];
    this.works = [];
    this.artifacts = [];
    this.activity = [];
    this.cursor = 0;
    for (let i = 0; i < 8; i++) this.add(false);
    const first = this.employees[0];
    const work = this.openWork(first, "整理产品发布清单（模拟）");
    this.log(first.id, "模拟执行已开始；没有调用模型");
    this.capabilities = { assign: true, start: true, enabled: true, config: true, archive: true, pause: true, resume: true, cancel: true, upload: false };
    this.works.push(work);
  }

  openWork(employee, title) {
    const workId = `demo-work-${crypto.randomUUID()}`;
    const taskId = `demo-task-${crypto.randomUUID()}`;
    const runId = `demo-run-${crypto.randomUUID()}`;
    employee.run = { workId, title, taskId, role: roleKinds[employee.kind % roleKinds.length], workerRunId: runId, generation: 1, attempt: 1, maxAutonomousAttempts: 3, tokenUsed: 12480, tokenLimit: 40000 };
    employee.kind += 1;
    return { workId, title, taskId, runId };
  }

  add(publish = true) {
    const n = this.nextId++;
    const id = `demo-${n + 1}`;
    const employee = {
      id,
      displayName: names[n % 8] + (n >= 8 ? ` ${Math.floor(n / 8) + 1}` : ""),
      enabled: true,
      position: roles[n % 8],
      capabilities: ["信息整理", "协作交付"],
      config: { instructions: "整理输入资料，明确证据与不足，再提交结果。", tokenLimitPerRun: 40000 },
      configVersion: 1,
      sprite: (n % 8) + 1,
      run: null,
      kind: n % 3,
      archived: false,
    };
    this.employees.push(employee);
    if (publish) {
      this.log(id, "模拟员工已导入");
      this.publish();
    }
    return id;
  }

  model() {
    const active = (employee) => (employee.run && !employee.run.ended ? employee.run : null);
    const employees = this.employees
      .filter((employee) => !employee.archived)
      .map((employee) => {
        const run = active(employee);
        const availability = !employee.enabled
          ? AVAILABILITY.DISABLED
          : run
            ? AVAILABILITY.WORKING
            : AVAILABILITY.AVAILABLE;
        return {
          employeeId: employee.id,
          displayName: employee.displayName,
          position: { id: `demo-position-${employee.sprite}`, title: employee.position },
          capabilities: employee.capabilities,
          availability,
          condition: employee.multiple ? CONDITION_MULTIPLE_ACTIVE_RUNS : null,
          currentWork: run
            ? {
                workId: run.workId,
                title: run.title,
                taskId: run.taskId,
                role: run.role,
                workerRunId: run.workerRunId,
                generation: run.generation,
                attempt: run.attempt,
                maxAutonomousAttempts: run.maxAutonomousAttempts,
              }
            : null,
          execution: run ? { backendType: "demo", backendVersion: "synthetic" } : null,
          demo: {
            tokenUsed: employee.enabled ? run?.tokenUsed ?? null : null,
            tokenLimit: run?.tokenLimit ?? null,
            configVersion: employee.configVersion,
            instructions: employee.config.instructions,
            paused: run?.paused ?? false,
          },
        };
      });
    const summary = { employees: employees.length, working: 0, available: 0, disabled: 0 };
    for (const employee of employees) {
      if (employee.availability === AVAILABILITY.WORKING) summary.working += 1;
      else if (employee.availability === AVAILABILITY.DISABLED) summary.disabled += 1;
      else summary.available += 1;
    }
    return {
      companyId: "demo",
      source: "mock",
      capturedAt: new Date().toISOString(),
      summary,
      employees,
      activity: clone(this.activity.slice(0, 60)),
    };
  }

  employeeDetail(employeeId) {
    const employee = this.employees.find((entry) => entry.id === employeeId);
    const model = this.model().employees.find((entry) => entry.employeeId === employeeId);
    if (!employee || !model) return Promise.reject(fail("EMPLOYEE_NOT_FOUND", "模拟员工不存在", 404));
    const activity = this.activity.filter((event) => event.employeeId === employeeId).map((event) => clone(event));
    return Promise.resolve({
      employeeId,
      displayName: employee.displayName,
      position: model.position,
      capabilities: model.capabilities,
      availability: model.availability,
      condition: model.condition,
      currentRole: model.currentWork?.role ?? null,
      currentWork: model.currentWork,
      execution: model.execution,
      recentDeliveries: this.artifacts
        .filter((artifact) => artifact.employeeId === employeeId)
        .map((artifact) => clone(artifact)),
      recentActivity: activity.slice(0, 20),
    });
  }

  lineage(workId) {
    const run = this.employees.map((employee) => employee.run).find((entry) => entry?.workId === workId);
    if (!run) return Promise.reject(fail("WORK_NOT_FOUND", "模拟工作不存在", 404));
    return Promise.resolve({
      work: { workId, title: run.title, intent: "合成演示：验证像素大厅如何渲染 Runtime 投影。", status: "ACTIVE", stage: "EXECUTION" },
      steps: [
        {
          kind: "TASK",
          role: run.role,
          taskId: run.taskId,
          title: run.title,
          state: "RUNNING",
          generation: run.generation,
          attempt: run.attempt,
          employeeId: this.employees.find((employee) => employee.run?.workId === workId)?.id ?? null,
          employeeName: this.employees.find((employee) => employee.run?.workId === workId)?.displayName ?? null,
          workerRunId: run.workerRunId,
          workerRunState: "RUNNING",
          artifacts: [],
        },
      ],
      outcome: { state: "OPEN", candidateArtifactIds: [] },
      latestArtifactId: null,
      founderBoundary: { waitingForFounder: false, attentionKind: null, decision: null },
    });
  }

  companies() {
    return Promise.resolve([{ id: "demo", name: "演示工作空间 · Synthetic" }]);
  }

  snapshot() {
    return Promise.resolve(this.model());
  }

  publish() {
    if (!this.interrupted && !this.disposed) for (const store of this.listeners) store.replace(clone(this.model()));
  }

  subscribe(_, store) {
    this.listeners.add(store);
    store.replace(clone(this.model()));
    return () => this.listeners.delete(store);
  }

  log(employeeId, summary, extra = {}) {
    this.activity.unshift({ id: `demo-event-${++this.cursor}`, employeeId, summary, at: new Date().toISOString(), source: "mock", ...extra });
    this.activity = this.activity.slice(0, 400);
  }

  history(_, employeeId, before) {
    const items = this.activity.filter((event) => event.employeeId === employeeId);
    const start = before ? items.findIndex((event) => event.id === before) + 1 : 0;
    const page = items.slice(start, start + 20);
    return Promise.resolve({ items: clone(page), nextCursor: start + 20 < items.length ? page.at(-1).id : null });
  }

  connection() {
    this.interrupted = !this.interrupted;
    for (const store of this.listeners) store.connection(this.interrupted ? "RUNTIME_UNAVAILABLE" : "LIVE");
    if (!this.interrupted) this.publish();
  }

  collaborate() {
    if (this.interrupted) return;
    const [a, b] = this.employees;
    if (!a || !b) return;
    this.log(a.id, "模拟消息：请核对发布清单中的验收项。", { toEmployeeId: b.id, kind: "message.sent" });
    this.publish();
  }

  updateConfig(id, patch, expectedVersion) {
    if (this.interrupted) throw fail("RUNTIME_UNAVAILABLE", "模拟连接已中断", 503);
    const employee = this.employees.find((entry) => entry.id === id);
    if (employee.configVersion !== expectedVersion) throw fail("CONFIG_CONFLICT", "配置版本冲突；请保留输入并重新加载最新配置");
    if (!patch.displayName?.trim() || patch.displayName.length > 40 || !patch.instructions?.trim() || patch.instructions.length > 16000 || !Number.isSafeInteger(patch.tokenLimitPerRun) || patch.tokenLimitPerRun < 1) throw fail("INVALID_CONFIG", "请检查姓名、工作指令和正整数预算", 400);
    employee.displayName = patch.displayName.trim();
    employee.config = { instructions: patch.instructions, tokenLimitPerRun: patch.tokenLimitPerRun };
    employee.configVersion += 1;
    this.log(id, `模拟配置 v${employee.configVersion} 已保存，下次模拟执行生效`);
    this.publish();
    return clone(employee);
  }

  archive(id, name, expectedVersion) {
    if (this.interrupted) throw fail("RUNTIME_UNAVAILABLE", "模拟连接已中断", 503);
    const employee = this.employees.find((entry) => entry.id === id);
    if (employee.run || this.pending.has(id)) throw fail("AGENT_HAS_ACTIVE_RUNS", "仍有活跃模拟执行或待确认命令，请先取消并等待确认");
    if (name !== employee.displayName) throw fail("NAME_MISMATCH", "名称不匹配", 400);
    if (expectedVersion !== employee.configVersion) throw fail("CONFIG_CONFLICT", "配置已变更，请重新打开设置");
    employee.archived = true;
    this.log(id, "模拟归档完成；历史保留，导入抑制标记已设置");
    this.publish();
  }

  async command(_, kind, input) {
    if (this.interrupted) throw fail("RUNTIME_UNAVAILABLE", "模拟连接已中断", 503);
    const employee = this.employees.find((entry) => entry.id === input.employeeId && !entry.archived);
    if (!employee) throw fail("NOT_FOUND", "模拟员工不存在", 404);
    if (this.pending.has(employee.id)) throw fail("COMMAND_PENDING", "上一条模拟命令仍待确认");
    if (kind === "assign" && (employee.run || !employee.enabled)) throw fail("NOT_AVAILABLE", "员工正在执行模拟工作或已停用");
    if (["pause", "resume", "cancel"].includes(kind) && (!employee.run || (kind === "pause" && employee.run.paused) || (kind === "resume" && !employee.run.paused))) throw fail("INVALID_STATE", "此状态不支持该命令");
    if (!["assign", "pause", "resume", "cancel", "enabled"].includes(kind)) throw fail("UNSUPPORTED", "模拟器不支持该命令", 501);
    const commandId = `demo-command-${crypto.randomUUID()}`;
    this.pending.add(employee.id);
    this.log(employee.id, `模拟命令 ${kind} 已受理，等待确认`, { commandId });
    this.publish();
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.interrupted || this.disposed) throw fail("COMMAND_UNCONFIRMED", "模拟命令未确认，状态未修改", 503);
      let runId;
      if (kind === "assign") {
        const work = this.openWork(employee, input.title?.slice(0, 160) || "新的模拟任务");
        this.works.push(work);
        runId = work.runId;
      } else if (kind === "enabled") employee.enabled = input.enabled;
      else if (kind === "pause") employee.run.paused = true;
      else if (kind === "resume") employee.run.paused = false;
      else if (kind === "cancel") {
        employee.run.ended = true;
        employee.run = null;
      }
      this.log(employee.id, `模拟命令 ${kind} 已确认`, { commandId });
      this.publish();
      return { commandId, state: "confirmed", runId };
    } finally {
      this.pending.delete(employee.id);
    }
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
