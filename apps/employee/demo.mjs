import { canArchive } from './domain.mjs';
const names = ['沈昇', 'Kai', 'Luna', 'Chen', 'Nova', 'Momo', 'Atlas', 'Zoe'];
const roles = ['产品运营', '开发工程师', '内容创作', '数据分析', '视觉设计', '质量验证', '策略研究', '客户支持'];
const clone = value => structuredClone(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
export class DemoEmployeeAdapter {
  constructor() {
    this.mode = 'mock'; this.offline = false; this.nextId = 0; this.listeners = new Set(); this.pending = new Set(); this.disposed = false;
    this.data = { companyId: 'demo', source: 'mock', employees: [], tasks: [], runs: [], activity: [], cursor: 0,
      capabilities: { assign: true, start: true, enabled: true, config: true, archive: true, pause: true, resume: true, cancel: true, upload: false } };
    for (let i = 0; i < 8; i++) this.add(false);
    this.data.tasks.push({ id: 'demo-task', title: '整理产品发布清单（模拟）', state: 'RUNNING', employeeId: 'demo-1', requiredCapabilities: [], artifacts: [], dependencies: null });
    this.data.runs.push({ id: 'demo-run', employeeId: 'demo-1', taskId: 'demo-task', status: 'running', configVersion: 1, tokenUsed: 12480, tokenLimit: 40000, startedAt: new Date().toISOString() });
    this.log('demo-1', '模拟运行已开始；没有调用模型');
  }
  companies() { return Promise.resolve([{ id: 'demo', name: '演示工作空间 · Synthetic' }]); }
  snapshot() { return Promise.resolve(clone(this.data)); }
  publish() { if (!this.offline && !this.disposed) for (const store of this.listeners) store.snapshot(clone(this.data)); }
  subscribe(_, store) { this.listeners.add(store); store.snapshot(clone(this.data)); return () => this.listeners.delete(store); }
  log(employeeId, summary, extra = {}) { this.data.activity.unshift({ id: `demo-event-${++this.data.cursor}`, employeeId, summary, at: new Date().toISOString(), source: 'mock', ...extra }); this.data.activity = this.data.activity.slice(0, 400); }
  add(publish = true) {
    const n = this.nextId++, id = `demo-${n + 1}`;
    this.data.employees.push({ id, displayName: names[n % 8] + (n >= 8 ? ` ${Math.floor(n / 8) + 1}` : ''), role: roles[n % 8], enabled: true, lifecycle: 'active', taskGroupId: null, description: '这是合成演示角色，用于验证界面交互。', capabilities: ['信息整理', '协作交付'], configVersion: 1, config: { instructions: '整理输入资料，明确证据与不足，再提交结果。', tokenLimitPerRun: 40000 }, sprite: n % 8 + 1 });
    if (publish) { this.log(id, '模拟员工已导入'); this.publish(); } return id;
  }
  history(_, employeeId, before) {
    const items = this.data.activity.filter(e => e.employeeId === employeeId || e.toEmployeeId === employeeId);
    const start = before ? items.findIndex(e => e.id === before) + 1 : 0, page = items.slice(start, start + 20);
    return Promise.resolve({ items: clone(page), nextCursor: start + 20 < items.length ? page.at(-1).id : null });
  }
  connection() { this.offline = !this.offline; for (const s of this.listeners) s.connection(this.offline ? 'offline' : 'mock'); if (!this.offline) this.publish(); }
  collaborate() {
    if (this.offline) return;
    const [a,b] = this.data.employees;
    if (!a || !b) return;
    this.log(a.id, '模拟消息：请核对发布清单中的验收项。', { toEmployeeId: b.id, kind: 'message.sent' }); this.publish();
  }
  updateConfig(id, patch, expectedVersion) {
    if (this.offline) throw fail('OFFLINE', '模拟连接已断开', 503);
    const e = this.data.employees.find(e => e.id === id);
    if (e.configVersion !== expectedVersion) throw fail('CONFIG_CONFLICT', '配置版本冲突；请保留输入并重新加载最新配置');
    if (!patch.displayName?.trim() || patch.displayName.length > 40 || !patch.instructions?.trim() || patch.instructions.length > 16000 || !Number.isSafeInteger(patch.tokenLimitPerRun) || patch.tokenLimitPerRun < 1) throw fail('INVALID_CONFIG', '请检查姓名、工作指令和正整数预算', 400);
    e.displayName = patch.displayName.trim(); e.config = { instructions: patch.instructions, tokenLimitPerRun: patch.tokenLimitPerRun }; e.configVersion++;
    this.log(id, `模拟配置 v${e.configVersion} 已保存，下次模拟运行生效`); this.publish(); return clone(e);
  }
  archive(id, name, expectedVersion) {
    if (this.offline) throw fail('OFFLINE', '模拟连接已断开', 503);
    const e = this.data.employees.find(e => e.id === id);
    if (!canArchive(this.data, id) || this.pending.has(id)) throw fail('AGENT_HAS_ACTIVE_RUNS', '仍有活跃运行或待确认命令，请先取消并等待确认');
    if (name !== e.displayName) throw fail('NAME_MISMATCH', '名称不匹配', 400);
    if (expectedVersion !== e.configVersion) throw fail('CONFIG_CONFLICT', '配置已变更，请重新打开设置');
    e.lifecycle = 'archived'; e.suppressedImport = true; this.log(id, '模拟归档完成；历史保留，导入抑制标记已设置'); this.publish();
  }
  async command(_, kind, input) {
    if (this.offline) throw fail('OFFLINE', '模拟连接已断开', 503);
    const e = this.data.employees.find(e => e.id === input.employeeId && e.lifecycle === 'active');
    if (!e) throw fail('NOT_FOUND', '模拟员工不存在', 404);
    if (this.pending.has(e.id)) throw fail('COMMAND_PENDING', '上一条模拟命令仍待确认');
    const active = this.data.runs.find(r => r.employeeId === e.id && ['running','paused','waiting'].includes(r.status));
    if (kind === 'assign' && (active || !e.enabled)) throw fail('NOT_AVAILABLE', '员工正在执行任务或已停用');
    if (['pause','resume','cancel'].includes(kind) && (!active || (kind === 'pause' && active.status !== 'running') || (kind === 'resume' && active.status !== 'paused'))) throw fail('INVALID_STATE', '此状态不支持该命令');
    if (!['assign','pause','resume','cancel','enabled'].includes(kind)) throw fail('UNSUPPORTED', '模拟器不支持该命令', 501);
    const commandId = `demo-command-${crypto.randomUUID()}`;
    this.pending.add(e.id); this.log(e.id, `模拟命令 ${kind} 已受理，等待确认`, { commandId }); this.publish();
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (this.offline || this.disposed) throw fail('COMMAND_UNCONFIRMED', '模拟命令未确认，状态未修改', 503);
      let runId;
      if (kind === 'assign') {
        const taskId = `demo-task-${crypto.randomUUID()}`; runId = `demo-run-${crypto.randomUUID()}`;
        this.data.tasks.push({ id: taskId, title: input.title?.slice(0, 160) || '新的模拟任务', employeeId: e.id, state: 'RUNNING', artifacts: [], dependencies: null });
        this.data.runs.push({ id: runId, employeeId: e.id, taskId, status: 'running', configVersion: e.configVersion, tokenUsed: 0, tokenLimit: e.config.tokenLimitPerRun, startedAt: new Date().toISOString() });
      } else if (kind === 'enabled') e.enabled = input.enabled;
      else { active.status = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[kind]; if (kind === 'cancel') this.data.tasks.find(t => t.id === active.taskId).state = 'CANCELLED'; }
      this.log(e.id, `模拟命令 ${kind} 已确认`, { commandId }); this.publish();
      return { commandId, state: 'confirmed', runId };
    } finally { this.pending.delete(e.id); }
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
