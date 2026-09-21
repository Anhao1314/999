# Object model (v0) — domain language

Status: **CURRENT TARGET MODEL, not CURRENT IMPLEMENTATION.** Nothing in this
document exists in code yet. There is no schema here on purpose: this file fixes
names and relationships so later milestones do not rename the product.

## Vocabulary

### Company layer

| Object | Definition |
| --- | --- |
| **Founder** | 公司的所有者与唯一权威。所有人，不是角色，也不是 Agent |
| **Company** | Founder 用 FlowCredit 建立的那家公司；Work、员工与知识都归属它 |
| **FounderProfile** | Founder 本人的结构化认识（目标、偏好、判断边界），经本人确认 |
| **CompanyProfile** | 这家公司是什么：做什么、为谁做、什么算成功 |
| **WorkspaceProfile** | 工作台如何呈现：关注什么、不打扰什么、默认视图 |

### Workforce layer

| Object | Definition |
| --- | --- |
| **Position** | 一个岗位：职责、产出契约、能力要求、权限边界、升级条件 |
| **Employee** | 持久的 AI 员工身份：占据某个 Position，可被反复调度（≠ Model，≠ Run） |
| **WorkerRun** | 员工的一次执行：临时、可失败、可重试；是工作记录不是身份 |

### Work layer

| Object | Definition |
| --- | --- |
| **Work** | 持续存在的目标单位；Work 比员工、会话、模型都活得久（≠ Task） |
| **Task** | Work 之下一次有边界的委托：绑定范围、输入、执行者与状态 |
| **Artifact** | 可交付的候选产物（+ provenance）；协作通过它发生 |
| **Review** | 对某个 Artifact 的独立复核意见；通过只是"可复核"，不是批准 |
| **Repair** | 保留原产物谱系的返工（不覆盖历史） |
| **Decision** | Founder 对结果的判断（接受 / 要求修改 / 放弃），Runtime 记录 |

### Memory & attention layer

| Object | Definition |
| --- | --- |
| **Knowledge** | 公司记忆；只有显式人工/领域路径可以写入权威内容 |
| **Activity** | 发生过的生命周期事件流（事实记录，不是进度仪表盘） |
| **Inbox** | 只包含真正需要 Founder 且不做就无法继续的事项；项目本身没有生命周期 |
| **Canvas** | Founder Workspace 的呈现层；它投影状态，不拥有状态 |
| **Widget** | Canvas 上一块可移动的视图；拖放只改变呈现 |

## Core relationships

```
Founder
   ↓
Company
   ├──────────────┐
   ↓              ↓
Position          Work
   ↓              ↓
Employee          Task
   │              │
   └──────┬───────┘
          ↓
      WorkerRun
          ↓
       Artifact
          ↓
   Review / Repair
          ↓
       Decision
          ↓
       Outcome
```

Company Genesis additionally produces `FounderProfile`, `CompanyProfile` and
`WorkspaceProfile`, which personalize the Canvas and constrain later Work.

## Relationship rules

1. **Company is the root.** Every Work, Employee, Artifact and Decision belongs to exactly one Company.
2. **Position outlives Employee.** Filling a position creates an Employee; the position is the contract, the employee is the person filling it.
3. **Work outlives Task.** A Work may contain many Tasks over time, including Repair tasks and tasks by different employees.
4. **Task binds scope.** A Task's inputs and authorized range are fixed at creation; nothing may silently expand them later.
5. **WorkerRun is temporary.** Runs are attributable, disposable work by a persistent Employee.
6. **Artifact carries provenance.** Every artifact names its producer run and its inputs, and stays a candidate until decided.
7. **Repair never rewrites history.** A repair references the artifact it supersedes; both remain readable.
8. **Decision is human.** Only a Founder decision turns a candidate into an accepted outcome.
9. **Knowledge is downstream.** Accepted outcomes do not automatically become knowledge; admission is a separate explicit path.
10. **Inbox is derived.** An Inbox item exists only while its underlying Runtime condition exists; reading is not an exit.

## Naming rules

- Product language never uses **Research**, **Northstar**, **Agent session** or **Jev** as the system's mother tongue. Research is one future *Work Type / Capability*.
- `Task`, `Run`, `Checkpoint`, `DecisionRecord`, `Provider`, `Snapshot` are technical objects: they may appear in technical detail, but not as first-level product navigation.
- Reserved words with fixed meaning: **Work, Task, Employee, Position, Artifact, Review, Repair, Decision, Inbox, Canvas, Widget**. Introduce synonyms only with an explicit migration note.
