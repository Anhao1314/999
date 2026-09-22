# AI 员工增量模块交付

实现于团队现有 `999` 仓库，保持 Node 原生 ESM / HTTP / SQLite、零第三方运行依赖。默认模块入口是像素圆桌大厅；右上“角色”打开员工管理层；点击员工在视口中央打开冰蓝工牌。没有重建项目、复制原型站点、替换全局首页或重写多 Agent 协调器。

## 启动

在仓库根目录运行：

```powershell
npm run start:employees
```

浏览器访问 `http://127.0.0.1:4318/employees`。这是**真实模式**，不会自动写样例公司、员工或任务。沿用原项目 `FLOWCREDIT_RUNTIME_DIR`（默认 `.runtime/kernel`）和 `FLOWCREDIT_COORDINATION`；也可用 `FLOWCREDIT_PORT` 指定端口。

`http://127.0.0.1:4318/employees?demo=1` 为**显式模拟演示**，只在浏览器内存中运行，不写真实 Runtime，不调用模型。刷新会重置演示配置和肖像预览。

## 修改范围

| 路径 | 改动 |
| --- | --- |
| `apps/runtime/server.mjs` | 增加模块路由 hook 和原命令路由的同源本地请求检查；共 6 行新增；无调度改动 |
| `package.json` | 增加 start:employees / test:employees 脚本，更新状态描述；未增依赖 |
| `README.md` | 新入口、真实/模拟边界、禁用方式 |
| `scripts/start-employee-ui.mjs` | 复用现有 server，默认端口 4318 |
| `apps/employee/index.html`, `styles.css`, `app.mjs` | 大厅、角色网格、工牌、详情/设置/分配/日志、头像、焦点和历史管理 |
| `apps/employee/domain.mjs` | 单一规范化 store、稳定座位、Run/Task/Employee 分离、视觉状态与裁剪算法 |
| `apps/employee/adapter.mjs`, `server.mjs` | 真实后端投影、完整快照轮询、分页活动、现有命令接入 |
| `apps/employee/demo.mjs`, `avatar.mjs` | 显式模拟 adapter；本地图片格式/大小验证 |
| `apps/employee/assets/` | 包内 8 套原创几何 placeholder 肖像/精灵与 manifest；尚非精修角色美术 |
| `apps/employee/README.md` | 模块边界、来源与已知限制 |
| `tests/unit/employee-domain.test.mjs`, `employee-adapter.test.mjs` | 核心、契约、权限边界与降级测试 |
| `tests/integration/employee-http.test.mjs` | 同一个真实 Runtime 进程的 HTTP 端到端测试 |
| `reports/` | 审查、进度、后端交接、测试结果和三种尺寸截图 |

`packages/`、数据库 schema、driver、已有测试与旧仓库未修改。原工作区没有未提交改动；首次交付与验收时全部修改留在工作区，未暂存、未 commit、未 push、未合并。用户验收后另行授权上传团队远程仓库，使用独立功能分支交接；不合并 main。

## 能力支持矩阵

| 能力 | 真实模式 | 模拟 / 本地模式 |
| --- | --- | --- |
| 公司、员工、岗位能力、任务、运行 | **真实接入**，来自 Kernel | 明确标记的 synthetic fixture |
| 活动/历史/产物元数据 | **真实接入**，公开摘要、每页 20 条 | 内存模拟事件；无隐藏推理 |
| 自动入座、满桌扩容、动画 | 真实快照投影；初次不重复入场；断线停动画 | 可演示导入、60 人、双方讨论 |
| 分配 / 启动 / 启用停用 | **真实接入**，分别调用既有命令；确认后显示 runId；停用不暂停当前执行 | 延迟确认的模拟命令 |
| 暂停 / 恢复 / 取消 | **未接入并禁用**；Kernel 没有执行器安全点确认契约 | 模拟 pending → confirmed |
| 配置修改与下次生效 | **未接入并禁用**；缺版本、模型与能力目录 | 模拟版本冲突和 in-flight 配置冻结 |
| 删除 / 归档 | **未接入并禁用**；缺事务与 tombstone | 名称确认、活跃运行拒绝、历史保留与模拟抑制标记 |
| 肖像 | **仅本页本地预览**；内置/上传文件/裁剪/恢复；刷新后恢复 | 相同；不上传，不写员工身份 |
| Token、模型、工具、知识、预算执行 | **未接入**，unknown 显示“未提供”，不显示任务进度百分比 | 有明确的模拟 Token 数值；模型/工具仍禁用 |
| SSE / WS、有序补偿 | **未接入**，使用完整快照轮询；不是伪造事件流 | gap/重复等纯逻辑 seam 已有测试，不能当生产流验证 |
| 真 LLM 执行 | **项目尚未支持，未验证** | 不调用模型 |

真实 HTTP 命令幂等缓存仅当前进程最近 512 条，不承诺重启后的持久去重。接口只面向本地单用户；Host/Origin 检查不等于生产认证。活动历史为类型摘要，不展示原始日志/工作包/敏感正文。

## 验证

- `npm run test:employees`：**16 / 16 通过**。
- `npm run check`、全部新 JS 语法、`git diff --check`：通过。
- `npm test`：**58 / 180 通过，122 失败**。115 项是既有 Windows SQLite 文件清理问题，7 项是既有 Windows 进程退出码断言；在未修改 HEAD 副本已复现两类失败。没有把这次全仓回归报成通过。
- 浏览器实测：默认大厅、搜索、逐层模态返回/焦点、脏表单、PNG 导入裁剪、命令受理与确认、真实断线/恢复、60 人扩容、三种视口。
- 真实闭环：隔离测试公司内 UI 分配 → Kernel run.started 对应记录 → 公开 Activity → 真 Artifact 元数据 → Kernel completed → 工牌更新。所有记录明确是测试 fixture；**没有真实模型执行**。

详见 [完整测试结果与截图](TEST_RESULTS.md)。

## 演示路线

1. 打开 `/employees` 查看团队已有公司/员工；没有数据时显示真实空状态。既有系统创建员工后，下次轮询自动入座。
2. 点“角色”，搜索姓名/职位，打开工牌，查看真实活动/任务/历史。
3. 有 OPEN/INTERRUPTED 任务且员工可用时，在工牌中分配；随后单独启动 Kernel 运行。此项目尚无模型执行器。
4. 要演示完整交互链，打开 `?demo=1`：模拟导入 → 入座 → 角色 → 工牌 → 编辑下一轮配置 → 分配模拟任务 → 暂停并等待确认 → 设置危险区，主动取消模拟运行后输入准确名称归档。
5. 头像选择/文件导入只更新本页预览；用“模拟断线”和“60 人压力演示”检查场景行为。

## 禁用与回滚

PowerShell：`$env:FLOWCREDIT_EMPLOYEE_UI='0'`，重启服务即可禁用 `/employees`、静态资源和 `/employee-api/*`，原 Kernel 命令/读取路由仍保留。不需要数据库回滚。

需要代码回滚时，人工审查后仅撤回上述模块文件、server hook、两个 npm scripts 与文档段落；不要对整个工作区执行 reset/clean。不改写已有版本历史。

团队后续最小接口与限制见 [后端交接](BACKEND_HANDOFF.md)。
