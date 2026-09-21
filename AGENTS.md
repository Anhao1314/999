# AGENTS.md — FlowCredit engineering charter

本文件对新仓库的所有协作者生效（人类与 AI Agent）。它很短，因为约束本来就少而硬。

## 1. 这是 clean re-foundation

`Anhao1314/999` 是从零开始的产品工程，不是旧 `FlowCredit-worklab` 的 fork，也不是它的清理版。新 Git history 从零开始；**禁止整目录复制旧 `apps/`、`packages/`、`docs/`**（`cp -R` 一律禁止）。

## 2. 三个 MVP 是最高优先级

1. **Company Genesis** — 这是谁的公司？
2. **AI Workforce Loop** — 这家公司怎么工作？
3. **AI Hiring Loop** — 公司缺能力时如何增加员工？

任何其它 feature、重构或实验都不得高于这三条主线。Company Canvas 是三者的统一 Founder Workspace，不是 MVP 4；Jev 是可选的 Semantic Sensor，不是 MVP 4；Dynamic Swarm 不是当前 blocker。

## 3. 旧仓库只读、只作为 provenance

旧仓库及其 worktree（`flowcredit-harness-migration`、`flowcredit-m2-decision-foundation`、`FlowCredit-Platform`）是 **READ ONLY**：不修改、不 reset、不 clean、不 stash、不覆盖。

能力迁入必须 **capability by capability, contract by contract, test by test**，并在 `docs/migration/from-flowcredit-worklab-v1.md` 记录来源仓库 / worktree / commit / 文件 / 验证测试 / 适配说明。provenance 不允许丢失。

## 4. 一次只做一个里程碑

一个里程碑一个可验证的边界。未完成当前里程碑并给出证据前，不开下一个。

## 5. Runtime truth > UI

- Runtime 是状态与控制面的唯一权威；UI 只是投影。
- Canvas ≠ Runtime state；拖拽只改变呈现，不改变现实。
- 不放 fake production data：没有真实来源就显示空状态或明确标注的 synthetic / demo。

## 6. Founder authority

- Founder = Authority。任何代码路径不得让 Agent 直接写知识或替 Founder 做决定。
- **Agent COMPLETE ≠ Accepted**；**Reviewer PASS ≠ Human Approval**；**Founder ACCEPT ≠ Knowledge Admission**。
- Prompt ≠ Permission；Capability ≠ Permission。权限只能来自显式的 Founder 授权路径。

## 7. Work-centric swarm

Work 持久，员工流动。Employee ≠ Provider ≠ WorkerRun；Work ≠ Task。协作必须结构化（ASSIGN / EXECUTE / HANDOFF / REVIEW / REPAIR / ESCALATE / COMPLETE），推理可以灵活。

## 8. Git 与凭据安全

- 未经明确授权不 commit / 不 push / 不改写历史；禁止 `git add .` 与 `git add -A`，只加显式路径。
- 不提交密钥、token、真实运行数据、SQLite、导出文件或机器绝对路径。
- `.runtime/`、`.pages/`、`.test-*/`、`node_modules/` 等生成物永不进入版本库。
- 声明完成前必须给出证据（命令 + 关键输出）；没有验证就写"未验证"。
