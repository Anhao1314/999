# FlowCredit

**Personal AI Company OS — 一台电脑，一家公司。**

FlowCredit 认识 Founder，帮助他建立自己的 AI 公司、招聘 AI 员工，并让员工围绕 Work 持续协作完成工作。Founder 只处理真正需要自己的事情。

- **Category:** AI-native Company OS
- **Audience:** 个人创业者 / Solo Founder / 一人公司（OPC），单机、单用户
- **Long-term shape:** Founder 组建团队，FlowCredit 调度团队，Work 持续存在

## Current status

**Foundation + Persistent Work Kernel v0A + Workforce Identity & Assignment v0B1.**

已实现的是一个不依赖任何模型 provider 的持久 Work Kernel：`Company` / `Work` /
`Task` / `Artifact` / `Checkpoint` / `Activity` 在进程退出与重启后保持一致、可恢复，
并带 generation 隔离（旧 execution 的迟到结果无法覆盖新现实）。它跑在 Node 内置的
`node:sqlite` 上，零第三方依赖。

v0B1 在此之上加入团队身份与派工：`Position`（岗位能力）/ `Employee`（长期存在的
AI 员工）/ `Assignment`（谁负责这项 Task）/ `WorkerRun`（一次执行尝试，带自己的
id 与状态）。员工身份与模型、provider、执行尝试完全解耦：换 provider 不会换人，
崩溃不会让员工永远"忙碌"。store 已是 schema v2，v0A 的旧 store 会在首次打开时
一次性迁移并保留全部历史（旧 Artifact 的 producer 保持 `NULL`，不伪造）。

- 契约：[Persistent Work Kernel v0A](docs/contracts/persistent-work-kernel-v0.md) ·
  [Workforce Identity & Assignment v0B1](docs/contracts/workforce-identity-assignment-v0.md)
- 重启演示：`node scripts/demo-work-kernel.mjs` · `node scripts/demo-workforce-v0b1.mjs`
- 还没有 UI、没有 Canvas、没有模型调用；Review / Repair / Inbox / Hiring / Decision 未开始。

Three MVPs: **still not complete.** Company Genesis、AI Workforce Loop、AI Hiring Loop
都还没有实现——Kernel 只是它们共同的 Runtime 地基。历史能力仍留在旧的 R&D 仓库
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
docs/migration/   旧仓库能力迁移清单与 provenance
packages/         company（公司根对象）/ work（Work、Task、生命周期）/
                  workforce（Position、Employee、Assignment、WorkerRun、Work Packet）/
                  runtime（命令、存储、schema 迁移）
apps/runtime/     Kernel 的最小运行时进程（health/status + 命令 seam）
fixtures/         种子数据（system workforce roster），不属于核心语言
scripts/          check、重启演示与进程 harness
tests/            smoke / 单元 / 集成测试（node --test）
```

只有存在真实内容时才新增目录；不做占位式空结构。
