# Company Canvas UI v0 · 队友接入说明

## 本次交付

用户要求先不改后端，按提供的浅蓝雪山玻璃风格图完成 UI 初版，并上传仓库供队友对接。

协作分支：`feat/company-canvas-ui-v0`。基于同步时的主线 `f8b484b`，新增独立演示模块 `apps/company/`；不会覆盖已经合并的 `apps/workspace/`、`apps/employee/`、Desktop、Runtime 或 Experience。

主线已包含 Worker Harness、CodexExecAdapter、Employee Lobby 与 Founder Workspace。此前旧员工分支中“没有模型执行”的评估不代表当前 main；本 PR 的“未连接执行环境”等文案仅指这个演示页面。

## 拉取与查看

先保留自己工作区的改动；可用独立 worktree 审阅：

```sh
git fetch origin
git worktree add ../flowcredit-company-ui-review origin/feat/company-canvas-ui-v0
cd ../flowcredit-company-ui-review
npm run start:company
```

打开 `http://127.0.0.1:4320/company/`。Node >=24.19.0 <25，无需安装新依赖，无数据库迁移。关闭预览进程即可停止服务。

入口仅提供静态文件，不启动 Runtime。原 `npm run start:workspace`、`npm run start:employees` 和桌面入口保持原有实现。

## 接入分工与映射

| UI 区域 | 视觉参考 | 生产接入的既有来源 |
| --- | --- | --- |
| 顶栏、侧栏、雪山与玻璃卡片 | `apps/company/styles.css`、`index.html`、`assets/alpine-wallpaper.png` | 迁入 `apps/workspace/` 壳，不改变 Runtime 路由 |
| 工作主卡、Needs You、员工概览、交付物、Pulse | `apps/company/index.html` | `GET /experience/companies/:id/workspace` 的单一投影 |
| 员工 Inspector | `apps/company/app.mjs` 中 `renderInspector` | `GET /experience/employees/:id` |
| 工作详情和 lineage | `showWork` 的展示结构 | `GET /experience/works/:id/lineage` |
| 公司身份 | 顶栏空间选择外观 | `/companies` 只发现身份，运行状态取 Experience |
| 新建 Work | 本地草稿弹窗仅供交互参考 | 主线 v0C 继续诚实禁用，等 Founder Work 定义里程碑 |
| ACCEPT | 本预览只展示待办与阅读 | 保持只读，等 Founder Decision UI 与完整决策绑定 |

前端同学可以先挑选背景、色彩、布局与 Inspector 样式，接到现有 `HttpWorkspaceAdapter`；后端同学本轮无需增加端点。不要把整个 demo adapter 或模拟统计复制进 LIVE 路径。

## 必须保留的边界

- `demo-adapter.mjs` 里的员工、结果、测试数量和指标全部是示例数据。
- 浏览器本地草稿不等于 Work，不应补写、批量导入或自动提交到 Runtime。
- LIVE 读取失败保留最后投影并明确提示，不回退 demo。
- Review PASS、Founder ACCEPT 与 Knowledge Admission 仍然分离。
- 画布布局与缩放只影响展示，不影响派工或运行。
- 执行环境名称、Token、测试结果等只有真实投影有来源时才可显示为生产事实。
- 生产页面的当前能力边界以 `docs/contracts/founder-workspace-v0.md` 为准。

## 验证

- 旧工作区内已完成 1440×900、1280×720、390×844 浏览器检查，无横向溢出，矮桌面卡片无重叠，控制台无 error/warn。
- 已验证草稿创建与刷新恢复、搜索员工、详情/活动切换、网格布局、卡片显隐与缩放。
- 提交前 `npm run check` 通过：24 required files / 213 tracked files / 50 core files；覆盖已暂存的本 PR 文件。
- `npm run test:workspace`：25/25 通过，包括主线工作台 HTTP、只读边界、Experience adapter、状态与源码边界检查。
- 三个新增 `.mjs` 的语法检查与 `git diff --cached --check` 通过。
- 完整回归由仓库 `FlowCredit CI` 执行，结果不能由旧分支测试代替。
- 图像生成来源、具体提示词、截图和限制见 [UI 验收记录](COMPANY_UI_V0.md)。

## 本轮没有包含

原本地员工列表／岗位筛选的未提交改动不在本 PR 中，避免覆盖队友已经重构的员工大厅。未合并 main，未修改后端，未声明真实执行或审批已经由本 UI 接通。
