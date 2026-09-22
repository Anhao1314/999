# FlowCredit

**Personal AI Company OS — 一台电脑，一家公司。**

FlowCredit 认识 Founder，帮助他建立自己的 AI 公司、招聘 AI 员工，并让员工围绕 Work 持续协作完成工作。Founder 只处理真正需要自己的事情。

- **Category:** AI-native Company OS
- **Audience:** 个人创业者 / Solo Founder / 一人公司（OPC），单机、单用户
- **Long-term shape:** Founder 组建团队，FlowCredit 调度团队，Work 持续存在

## Current status

**Foundation + Persistent Work Kernel v0A + Workforce Identity & Assignment v0B1 +
Review / Repair Collaboration v0B2 + Founder Attention & Acceptance v0B3.**

已实现的是一个不依赖任何模型 provider 的持久 Work Kernel：`Company` / `Work` /
`Task` / `Artifact` / `Checkpoint` / `Activity` 在进程退出与重启后保持一致、可恢复，
并带 generation 隔离（旧 execution 的迟到结果无法覆盖新现实）。它跑在 Node 内置的
`node:sqlite` 上，零第三方依赖。

v0B1 在此之上加入团队身份与派工：`Position`（岗位能力）/ `Employee`（长期存在的
AI 员工）/ `Assignment`（谁负责这项 Task）/ `WorkerRun`（一次执行尝试，带自己的
id 与状态）。员工身份与模型、provider、执行尝试完全解耦：换 provider 不会换人，
崩溃不会让员工永远"忙碌"。store 已是 schema v2，v0A 的旧 store 会在首次打开时
一次性迁移并保留全部历史（旧 Artifact 的 producer 保持 `NULL`，不伪造）。

v0B2 加入企业协作协议：一个员工交付 Artifact 后，另一个员工可以正式 **Review** 它
（`PASS` / `REQUEST_REVISION`），Review 发现问题时 Runtime 会开出带完整 lineage 的
**Repair Task**（新的 Task，不是重开旧的），修复产出的 Artifact 通过
`supersedesArtifactId` 取代旧版本，并且必须再次接受 Review。Review 记录不可修改，
旧 Artifact 永不改写，循环次数不设上限。Review 之后 Work 只会变成
`READY_FOR_DECISION` —— **Reviewer PASS ≠ Founder ACCEPT**。store 已是 schema v3，
v1/v2 旧 store 会逐级迁移（v1 → v2 → v3）并保留全部历史。

v0B3 补上这条链路的最后一段：**Founder Attention + Founder ACCEPT**。Work 停下等待
人类时，`WorkKernel.founderAttention({ companyId })` 会给出一个派生 projection ——
哪些 Work 真的需要 Founder、可以做什么、以及为什么。它不是第二套 Todo：没有
Inbox 表、没有 read/unread/done/dismissed，读它不写任何东西，每个 Work 最多一条。
Founder 的 ACCEPT 是**唯一被持久化的人类权威动作**，写入一张 append-only、不可修改、
每个 Work 最多一条的 `founder_decisions`，并绑定**确切的 Artifact、确切的 digest、
确切的 DecisionBasis（该 Work 的 activity head）**。ACCEPT 与 Review 完全解耦：
Review 不可能自动变成接受，接受也不会写入 Knowledge。Work 的 outcome 是派生的
（`NO_CANDIDATE` / `READY` / `AMBIGUOUS` / `ACCEPTED`），collaboration status 仍是
`READY_FOR_DECISION`：`ACCEPT` 是动作，`ACCEPTED` 是状态。store 已是 schema v4，
v1/v2/v3 旧 store 会逐级迁移（v1 → v2 → v3 → v4）且不做任何历史回填。

v0B4 把"调度团队"这一段也交还给 Runtime：Continuation Driver 是一个**无状态执行器**
（读真相 → 选一个合法动作 → 跑一条命令 → 重新读），没有时钟、没有队列、没有调度策略；
每次迭代最多提交一次业务写入（`MAX_CONTINUATION_STEPS = 16` 是循环保险丝）。协调规则
冻结在 Work Continuity v0B4 契约里：eligibility（组织能力事实）≠ dispatchability
（此刻能否自动开工），BUSY 不等于能力缺口（`NO_DISPATCHABLE_EMPLOYEE`）；Reviewer
独立性（reviewer ≠ 该 Artifact 的 producer）在 `assignTask` 与 `startWorkerRun` 两处
fail-closed 强制；`WORK_ALREADY_ACTIVATED` 是良性收敛而不是失败。跨 Work 的唤醒只是
"公司人力事实变了（run 结束 / enabled 变化 / 新员工）→ 重新读真相"的信号：不写别的
Work 的 Activity、不推进它的 basis、没有持久队列、没有 event bus。新增 append-only 的
`continuation_traces`（仅供观测，永不作为决策输入）；store 已是 schema v6，v1–v5 旧
store 会逐级迁移（v1 → v2 → v3 → v4 → v5 → v6）且不做任何历史回填。

H0/H0.1/H0.2 是**实验证据**：用真实 `codex exec` 子进程验证执行层假设——真实 Codex
执行从实验上确认了 Harness 的隔离边界、中断与结构化结果假设，这些结论随后被固化成执行
契约；而 committed 的 Worker Harness v0 是 **provider-neutral** 的生产执行架构，生产
`CodexExecAdapter` 仍 **NOT YET IMPLEMENTED**。执行层的形态：一次 WorkerRun 的结束由
Worker host 报告——失败走 `interruptWorkerRun`（`WORKER_TIMEOUT` / `WORKER_PROCESS_EXIT` /
`WORKER_PROTOCOL_ERROR`，与崩溃恢复共用同一个中断 primitive），成功走 `submitWorkerResult`。
成功交付是**原子**的：Artifact 记录、WorkerRun 收口、Task 状态与 **Runtime 自己推导的**
Review 交接在同一事务提交，host 无法自行选择交接方式；重放
`(workerRunId, generation, resultDigest)` 幂等，换 digest 则 `WORKER_RESULT_CONFLICT`。
候选 outcome 只认 producer Task **当前 generation** 的 Artifact：被放弃 generation 的残留
永远是历史而不是候选，所以"崩溃 + 自动重试"不会再制造假的 `OUTCOME_AMBIGUOUS`。完整
Harness evidence 永不入库，只留 digest。

Worker Harness v0 Slice 1.1 是**执行层**：`WorkerHost` 只执行 Runtime 已经开工的
WorkerRun——派工、开工、Review/Repair 调度仍属于 v0B4。开工观察走与 v0B4 同形的
post-commit seam（重复通知安全，错过可被 reconcile 修复，没有轮询/事件总线/持久队列）。
每次尝试持久化一条不可变的 `WorkerExecutionBinding`（schema v6，1 WorkerRun : 1
binding），并把「运行目录」按 `run + generation` 隔离：新 generation 一定是新 workspace，
旧的孤儿目录永不复用——正确性来自 generation fencing + isolation，不依赖杀掉孤儿进程。
WorkerResult（Worker 自述）与 HarnessEvidence（Host 观测）是两个对象，都不等于批准；
`executionPolicy.requested ≠ effective`：请求的限制不等于已证明的隔离。

尝试按角色持有各自的 `ResultContract`（执行/Repair = `ARTIFACT_DELIVERY`，Review =
`REVIEW_JUDGMENT`，由 WorkPacket 决定，adapter 不能改）。两条交付 seam 都是原子的：
`submitWorkerResult` 写 Artifact，`submitWorkerReviewResult` 写 **Reviewer 的判断**——
Runtime 从 WorkerRun 推导 Review Task → ReviewRequest → 目标 Artifact + digest 的全部
lineage，复用同一个 `submitReview` 原语，绝不伪造 verdict，也不会在事务里顺手创建
Repair。两条 seam 都以 `(workerRunId, generation, resultDigest)` 幂等，冲突返回 409；
Provider 专属解析属于 adapter，schema 验证属于 Host，非法候选只会中断尝试（
`WORKER_PROTOCOL_ERROR`），永远不会变成 Runtime truth。自动重试是**有界**的：
`MAX_AUTONOMOUS_ATTEMPTS_PER_TASK = 3`（1 次初始 + 2 次自动重试），计数完全从持久的
WorkerRun 历史推导，不存计数器、不加 Task 状态；预算用尽后 Driver 停止
（`AUTO_RETRY_EXHAUSTED`），Work 进入 Founder Attention（`RESUME_EXECUTION` /
`ASSIGN_EMPLOYEE` / `ENABLE_EMPLOYEE` / `ABANDON_TASK`）。真实 `CodexExecAdapter` 不在
本切片内。

- 契约：[Persistent Work Kernel v0A](docs/contracts/persistent-work-kernel-v0.md) ·
  [Workforce Identity & Assignment v0B1](docs/contracts/workforce-identity-assignment-v0.md) ·
  [Review / Repair Collaboration v0B2](docs/contracts/review-repair-collaboration-v0.md) ·
  [Founder Attention & Acceptance v0B3](docs/contracts/founder-attention-acceptance-v0.md) ·
  [Work Continuity v0B4](docs/contracts/work-continuity-v0.md) ·
  [Worker Execution Seam v0 (H0.1 + H0.2)](docs/contracts/worker-execution-seam-v0.md) ·
  [Worker Harness v0 (Slice 1.1)](docs/contracts/worker-harness-v0.md)
- 演示：`node scripts/demo-work-kernel.mjs` · `node scripts/demo-workforce-v0b1.mjs` ·
  `node scripts/demo-review-repair-v0b2.mjs` · `node scripts/demo-founder-acceptance-v0b3.mjs` ·
  `node scripts/demo-work-continuity-v0b4.mjs` · `node scripts/demo-worker-harness-v0.mjs`
- 还没有 UI、没有 Canvas、没有模型调用；协调由确定性的 Continuation Driver 完成（不是
  scheduler / event bus / 持久队列），执行由 WorkerHost + 确定性 test backend 完成
  （真实 CodexExecAdapter 仍未接入），Hiring / Genesis 未开始。

Three MVPs: **still not complete.** Company Genesis、AI Workforce Loop、AI Hiring Loop
都还没有实现——Kernel 只是它们共同的 Runtime 地基，还没有真实模型执行。

v0B3 记录了一个 **AI Workforce MVP closure gate**：

> Founder 建好 Work 之后，能否不亲自做日常协调，一直等到 FlowCredit 合理地需要他？

**v0B4 关闭了这个 gate**：`FLOWCREDIT_COORDINATION=driver` 时，普通 Task 的指派与启动、
Review 的指派、Repair 的协调都由 Runtime 的 Continuation Driver 逐步完成；Scenario 1 /
Scenario 2 实测 Founder Extra Touch 与 Manual Coordination 均为 **0**。这个结果的名字是
`Deterministic Workforce Coordination Closure = PASS`，**不是**"完整产品自主"——真实执行
仍需要 execution adapter / System 2 接入，所以 MVP 2 还没有宣布 PASS。v0B4 不包含
scheduler、capability ranking、DAG planner、Dynamic Swarm、Hiring 或 Knowledge
Admission；历史能力仍留在旧的 R&D 仓库（见下），迁移遵循 capability by capability，
不整目录复制。

## The three core MVPs

| # | MVP | 回答的问题 | 核心产物 |
| --- | --- | --- | --- |
| 1 | **Company Genesis** | 这是谁的公司？ | `FounderProfile` `CompanyProfile` `WorkspaceProfile` |
| 2 | **AI Workforce Loop** | 这家公司怎么工作？ | `Work` `Task` `WorkerRun` `Artifact` `Review` `Repair` `Decision` |
| 3 | **AI Hiring Loop** | 公司缺能力时如何增加员工？ | `Position` `Employee`（经 Trial Task 与 Founder 确认） |

Company Canvas 不是第四个 MVP，它是三个 MVP 的统一 Founder Workspace。
Jev 不是第四个 MVP，它是可选的 Semantic Sensor 实现；新 Runtime 不得硬依赖 TypeSafe SDK 才能运行。
Dynamic Swarm（动态分配、并行 fan-out、自主组队）不是当前 MVP blocker。

细节见 [MVP 定义](docs/product/mvp-v0.md)。

## Frozen principles

Founder = Authority · Work = Continuity · Runtime = Control · Semantic Sensors = Sense · AI Employee = Think + Act · Knowledge = Memory

四条不可协商的判断：

- Agent COMPLETE ≠ Accepted
- Reviewer PASS ≠ Human Approval
- Founder ACCEPT ≠ Knowledge Admission
- Prompt ≠ Permission，Capability ≠ Permission

完整清单见 [架构原则](docs/architecture/principles.md) 与 [对象模型](docs/architecture/object-model.md)。

## Run and test

要求 Node **24.19.0**（`.nvmrc`）。

```sh
npm run check                       # 结构 / 密钥 / 生成物 / 核心语言与依赖检查
npm test                            # node --test（单元 + 真实进程重启集成测试）
node scripts/demo-work-kernel.mjs   # 持久化与恢复演示（真实进程，SIGKILL 后恢复）
node scripts/demo-workforce-v0b1.mjs # 派工演示：员工身份跨崩溃存活，Artifact 指明 producer
node scripts/demo-review-repair-v0b2.mjs # 协作演示：Review → Repair → 再次 Review → PASS
node scripts/demo-founder-acceptance-v0b3.mjs # 接受演示：Founder Attention → ACCEPT → ACCEPTED（含硬重启）
node scripts/demo-work-continuity-v0b4.mjs # 协调演示：Driver 自动派工/开工/Review/Repair（0 手动协调 + 跨 Work 唤醒）
node scripts/demo-worker-harness-v0.mjs # 执行演示：WorkerHost + 确定性 test backend（执行→评审→ACCEPT、REVISION→Repair→PASS、超时重派与 workspace 隔离、重试预算用尽后交给 Founder）
node apps/runtime/server.mjs        # 以长期进程方式启动 Kernel
```

服务进程读取 `FLOWCREDIT_RUNTIME_DIR`（store 目录）与 `FLOWCREDIT_PORT`
（默认 `0` = 临时端口，只监听 `127.0.0.1`），以及 `FLOWCREDIT_COORDINATION`
（默认 `off`；设为 `driver` 时启动 Continuation Driver：启动后 drive 一次，
并在每个命令提交后唤醒）。零运行时依赖，尚未安装任何 SDK、框架或模型客户端。

## Relationship to the old worklab repository

旧的 `FlowCredit-worklab` 系仓库（含其 worktree）**不再是产品主线**。它们的角色是：

**R&D / Provenance / Historical Evidence Source** —— 只读。

未来能力迁移遵循：**capability by capability, contract by contract, test by test**；每一项都要在 [迁移清单](docs/migration/from-flowcredit-worklab-v1.md) 中留下来源、提交与验证测试，禁止整目录复制（`cp -R`）。

## Repository map

```
README.md         产品入口与当前状态
AGENTS.md         工程章程（AI/人类协作者都适用）
docs/product/     MVP 定义
docs/architecture/原则与对象模型
docs/contracts/   Persistent Work Kernel v0A 契约
                   / Workforce v0B1 契约 / Review & Repair v0B2 契约
                   / Founder Attention & Acceptance v0B3 契约
                   / Work Continuity v0B4 契约（Continuation Driver）
                   / Worker Execution Seam v0 契约（中断命令、原子结果投递与 H0 实验结论）
                   / Worker Harness v0 Slice 1.1 契约（WorkerHost、执行绑定、workspace 隔离、
                     Reviewer 交付 seam、角色化 ResultContract 与有界自动重试）
docs/migration/   旧仓库能力迁移清单与 provenance
packages/         company（公司根对象）/ work（Work、Task、生命周期、协作、outcome 与
                  Continuation Policy 投影）/ decision（Founder Decision 记录）/
                  planning（确定性 NextActionProposer）/ workforce（Position、Employee、
                  Assignment、WorkerRun、Work Packet、dispatchability）/
                  harness（WorkerAdapter 契约、WorkerHost、角色化 ResultContract、
                  执行绑定与 workspace 布局、确定性 test backend）/
                  runtime（命令、存储、schema 迁移、Continuation Driver）
apps/runtime/     Kernel 的最小运行时进程（health/status + 命令 seam + Founder Attention 读取）
fixtures/         种子数据（system workforce roster），不属于核心语言
scripts/          check、重启演示与进程 harness
tests/            smoke / 单元 / 集成测试（node --test）
```

只有存在真实内容时才新增目录；不做占位式空结构。
