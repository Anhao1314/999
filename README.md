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

- 契约：[Persistent Work Kernel v0A](docs/contracts/persistent-work-kernel-v0.md) ·
  [Workforce Identity & Assignment v0B1](docs/contracts/workforce-identity-assignment-v0.md) ·
  [Review / Repair Collaboration v0B2](docs/contracts/review-repair-collaboration-v0.md) ·
  [Founder Attention & Acceptance v0B3](docs/contracts/founder-attention-acceptance-v0.md)
- 演示：`node scripts/demo-work-kernel.mjs` · `node scripts/demo-workforce-v0b1.mjs` ·
  `node scripts/demo-review-repair-v0b2.mjs` · `node scripts/demo-founder-acceptance-v0b3.mjs`
- 还没有 UI、没有 Canvas、没有模型调用、没有 dispatcher；Hiring / Genesis 未开始。

Three MVPs: **still not complete.** Company Genesis、AI Workforce Loop、AI Hiring Loop
都还没有实现——Kernel 只是它们共同的 Runtime 地基。v0B3 之后，AI Workforce MVP 的
协议闭环（Work → 执行 → Review → Repair → Review → Founder ACCEPT）已经打通，
但**还没有宣布 PASS**：仍有一个 closure gate ——

> Founder 建好 Work 之后，能否不亲自做日常协调，一直等到 FlowCredit 合理地需要他？

今天 Runtime 里**没有 dispatcher**：普通 Task 的指派与启动、Review 的指派、Repair 的
协调仍然要 Founder 手动触发（`assignTask` / `startWorkerRun` / `createRepairTask`）。
这与"Founder 组建团队，FlowCredit 调度团队"的冻结原则之间的差距，是一个已记录的
**AI Workforce MVP closure gate**，而不是 v0B3 的实现内容——v0B3 不包含 scheduler、
capability ranking、DAG planner、Dynamic Swarm 或 Hiring。历史能力仍留在旧的 R&D 仓库
（见下），迁移遵循 capability by capability，不整目录复制。

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
node apps/runtime/server.mjs        # 以长期进程方式启动 Kernel
```

服务进程读取 `FLOWCREDIT_RUNTIME_DIR`（store 目录）与 `FLOWCREDIT_PORT`
（默认 `0` = 临时端口，只监听 `127.0.0.1`）。零运行时依赖，尚未安装任何 SDK、
框架或模型客户端。

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
docs/migration/   旧仓库能力迁移清单与 provenance
packages/         company（公司根对象）/ work（Work、Task、生命周期、协作与 outcome 投影）/
                  decision（Founder Decision 记录）/
                  workforce（Position、Employee、Assignment、WorkerRun、Work Packet）/
                  runtime（命令、存储、schema 迁移）
apps/runtime/     Kernel 的最小运行时进程（health/status + 命令 seam + Founder Attention 读取）
fixtures/         种子数据（system workforce roster），不属于核心语言
scripts/          check、重启演示与进程 harness
tests/            smoke / 单元 / 集成测试（node --test）
```

只有存在真实内容时才新增目录；不做占位式空结构。
