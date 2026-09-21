# FlowCredit MVP v0 — three core loops

Status: **frozen product scope, not implemented**. This document defines what
the three MVPs are; it does not claim any of them exists yet.

FlowCredit 是给一个人的公司用的 AI-native Company OS。三个 MVP 回答三个
不可避免的问题：公司是谁的、公司怎么工作、公司缺人时怎么办。

不在本文件范围内的两件事，先说清楚：

- **Company Canvas ≠ MVP 4.** 它是三个 MVP 的统一 Founder Workspace：Company Genesis 产出它的个性化内容，Workforce Loop 把 Work 的进展放进去，Hiring Loop 把员工放进去。
- **Jev ≠ MVP 4.** 它是可选的 Semantic Sensor 实现（`SemanticSensor → structured probability signal`）。新 Runtime 不得硬依赖 `@typesafe-ai/sdk` 才能运行。
- **Dynamic Swarm 不是当前 blocker.** 第一版 Workforce 可以是确定性路由（Research Task → Research Analyst，Review → Reviewer，Repair → Research Analyst）。

---

## MVP 1 — Company Genesis

**回答的问题：这是谁的公司？**

### Problem

通用 AI 工具不认人：它不知道 Founder 是谁、在做什么生意、什么算重要、哪些事
绝不能被自动决定。没有这层理解，产品只能给出通用建议，Founder 每用一次都要
重新解释一遍背景。

### User Journey

First launch
→ Founder Onboarding Agent（adaptive conversation，不是表单）
→ Founder Profile
→ Company Profile
→ Workspace Profile
→ Founder review / correction
→ confirmation
→ personalized Company Canvas

### Core Objects

`FounderProfile`、`CompanyProfile`、`WorkspaceProfile`

### Minimum Acceptance Criteria

1. Founder 能在一段对话里完成 onboarding，而不需要填写长表单。
2. 三个 Profile 都以**结构化**形式落盘，可被人读取、修改、导出。
3. Founder 必须显式确认（correction 后再次确认）才算成立：
   **AI inference ≠ Founder confirmed fact**。
4. Company Canvas 能根据确认后的 Profile 呈现个性化内容（而不是通用默认值）。
5. 未确认的推断必须可见地标为候选，不得冒充事实。

### Out of Scope

多用户 / 团队权限、组织架构编辑、真实财务与客户数据接入、从外部文档批量导入公司信息。

### Aha Moment

Founder 第一次看到自己的工作台时，上面写的是**他自己的公司**，而不是一个空白工具。

---

## MVP 2 — AI Workforce Loop

**回答的问题：这家公司怎么工作？**

### Problem

AI 能完成任务，但完成不等于可接受：没有结构化的分工、交接、复核与返工，
Founder 只能得到一堆各自正确、彼此无法追溯的输出。而 Founder 的注意力是
公司最稀缺的资源。

### User Journey

Founder creates Work
→ ASSIGN
→ AI Employee executes
→ Artifact
→ HANDOFF
→ REVIEW
→ REPAIR（需要时）
→ re-review
→ ESCALATE（只在必要时）
→ Founder Inbox
→ ACCEPT
→ Outcome

最小协作协议（frozen vocabulary）：**ASSIGN / EXECUTE / HANDOFF / REVIEW /
REPAIR / ESCALATE / COMPLETE**。

### Core Objects

`Work`、`Task`、`WorkerRun`、`Artifact`、`Review`、`Repair`、`Decision`、`Inbox`、`Activity`

### Minimum Acceptance Criteria

1. Work 与其 Task 在进程重启后仍然存在，并且能说清"现在轮到谁"。
2. 员工通过 **Artifact** 交接，而不是靠共享整段对话历史。
3. 复核结论与执行结果分离记录：Reviewer PASS 之后任务停在人工关口。
4. REQUEST_REVISION 不覆盖原始产物：产生带谱系的 Repair，原 Task / Artifact / Review 保留。
5. 只有 Founder 能做 ACCEPT；ACCEPT 之后不得自动改写知识。
6. Inbox 只包含真正需要 Founder 的事情，且每一件都能追溯到 Runtime 的真实状态。

### Out of Scope

动态能力分配、Task DAG、并行 fan-out / join、Specialist 自动生成、事件调度器、
自主组队、跨公司协作。

### Aha Moment

Founder 打开 Inbox，看到**只有两三件**真正需要他的事，其余都有人在推进。

---

## MVP 3 — AI Hiring Loop

**回答的问题：公司缺能力时如何增加员工？**

### Problem

当公司需要一种新能力时，Founder 不应该去改 prompt 或接一个新的 API key，
他应该**招一个人**：定义岗位、说清权限、试用、确认入职。

### User Journey

Founder hiring need
→ Hiring conversation
→ JD
→ Position Contract
→ Capability Validation
→ Permission Configuration
→ Trial Task
→ Founder confirmation
→ AI Employee joins company

### Core Objects

`Position` → `AI Employee` → `Worker Run`

### Minimum Acceptance Criteria

1. 招聘结果是一个**持久员工身份**（`Position` + `Employee`），不是一次性会话。
2. Position Contract 明确写清：职责、产出契约、能力、**权限边界**、升级（escalation）条件。
3. 新员工必须先跑至少一个 **Trial Task**，其产物能被 Founder 检查。
4. Employee 的权限只能来自显式配置与 Founder 确认：**Prompt ≠ Permission，Capability ≠ Permission**。
5. 入职后员工可被反复调度：**Employee ≠ Model，Employee ≠ WorkerRun**。

### Out of Scope

员工之间的自动重组、员工市场 / 外部人才网络、绩效与薪酬、批量招聘。

### Aha Moment

Founder 说"我需要有人盯竞品"，几分钟后公司里真的多了一个有岗位、有边界、
已经干过一件试用工作的员工。

---

## Cross-MVP boundaries

| 主张 | 含义 |
| --- | --- |
| Work persists. Workers come and go. | Work/Task/Artifact 是持久对象；会话与执行是一次性的 |
| Founder 组建团队，FlowCredit 调度团队 | 招聘与授权由人决定；调度由系统负责 |
| Founder Attention is scarcer than token cost | Inbox 的默认动作是"少打扰"，不是"多汇报" |
| Agent COMPLETE ≠ Accepted | 执行完成只是候选 |
| Reviewer PASS ≠ Human Approval | 复核通过只是可复核 |
| Founder ACCEPT ≠ Knowledge Admission | 接受结果不等于改写权威知识 |
| Canvas ≠ Runtime state | 拖拽只改变呈现 |
