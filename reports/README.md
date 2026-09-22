# reports/ — 历史材料说明

本目录是 **PR #1 阶段（`feat/ai-employee-lobby`）** 的交付报告与验证记录，由该
PR 的作者提交（`Asternux`）。它们是集成过程的**历史材料，不是当前行为契约**。

- 当前行为契约：[`docs/contracts/employee-lobby-v0.md`](../docs/contracts/employee-lobby-v0.md)
- 当前启动与边界说明：[`README.md`](../README.md) 的「AI 员工模块（增量接入）」

PR #1 阶段的描述与 v0B 集成后的实现有以下已知差异，阅读旧报告时请以现在的代码与契约为准：

| 旧报告中的说法 | v0B 集成后的实际行为 |
| --- | --- |
| 模块自带 `/employee-api/*` 投影路由 | 已移除；大厅只读 Runtime 的 `/experience/*` GET 投影 |
| UI 支持分配、启动 WorkerRun | 不在 UI 中，也不在适配器中；调度只属于 Runtime |
| `FLOWCREDIT_EMPLOYEE_UI=0` 禁用模块 API | 只禁用大厅静态页面；Kernel 路由不受影响 |
| 截图 `live-*.png` 反映旧工牌与控制面板 | 已替换为 `v0b-*.png`（当前实现的真实验证截图） |

验证环境差异：旧报告记录在 Windows / npm 上运行；当前仓库要求 Node 24.19.0，
本仓库的检查一律用 `node --test` 与 `node scripts/check.mjs`（不依赖 npm）。

`reports/screenshots/v0b-*.png` 由一次真实 Runtime 驱动的会话产生（seed → 执行 →
评审 → 返工 → 多 run 异常 → 断连），用于人工核对；它们同样不是契约。
