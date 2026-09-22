# 后端最小交接

本次复用现有 Kernel；没有修改 `packages/`、schema、driver 或调度策略。

## 已接入

| 模块接口 | 真实来源 / 行为 |
| --- | --- |
| `GET /companies` | 现有公司列表 |
| `GET /employee-api/snapshot?companyId=…` | 同一进程同步读取 Employee、Position、Task、WorkerRun 和 Artifact 元数据；`revision` 为公司最新持久 Activity sequence；前端每 2 秒轮询 |
| `GET /employee-api/history?companyId=…&employeeId=…&before=…` | 现有 Activity 的只读参数化 SQL；每页 20 条；只输出公开类型摘要，不输出原始 detail、workPacket、指令或产物正文 |
| `POST /employee-api/commands` | `{companyId, kind, input, idempotencyKey}`；kind 仅 assign/start/enabled；调用既有 assignTask/startWorkerRun/setEmployeeEnabled |

`assign` 写 Assignment；`start` 单独返回真实 runId。两步操作避免掩盖部分完成，也允许 driver 继续按自己的策略启动。接口返回 200 confirmed；HTTP adapter 遇到 202 只提示“尚未确认”。暂停、归档等返回 501，UI 同时禁用。

读取与命令检查 company 归属；命令校验 Host/Origin、JSON、体积和幂等键。跨公司、当前忙碌、指派已改变等情况拒绝。幂等缓存仅当前进程最近 512 条；未添加数据库表，因此不承诺重启后的命令去重。

## 队友需要补的能力

1. **执行 adapter**：让现有 WorkerRun 驱动真实模型/工具，公开已脱敏的活动与 usage。当前 startWorkerRun 仅证明持久执行状态，不代表 LLM 已执行。
2. **配置**：后端维护 configVersion；写入需 expectedConfigVersion；新 run 固定配置版本；409 返回最新版本。目录需要模型连接状态、参数范围和已授权 tools/knowledge，后端执行预算。
3. **命令回执**：持久 commandId/idempotencyKey、pending/confirmed/failed 查询。只有实际支持安全点的执行器才能启用 pause/resume；不把 202 当完成。
4. **归档**：名称、版本、活跃 run 校验 + 事务归档 + import tombstone；历史不硬删；有 active run 返回 409。取消必须另行确认并等执行器回执。
5. **头像**：内容重新解码/校验、去元数据、私有资产存储与随机 assetId；绑定公司权限。当前仅内存预览，不能误认为已上传。
6. **增量事件**：若提供 SSE/WS，需原子快照 cursor、可补偿有序事件、重复去重、gap/expired 恢复协议。当前轮询完整快照无需假造连续 seq，Activity head 不能直接冒充工作区 SSE cursor。
7. **生产安全**：当前运行时是本地单用户 loopback transport，无登录会话。上线前由既有产品统一提供认证、授权、CSRF、日志策略；本模块不新建一套认证系统。

模拟模式的版本、暂停/恢复/取消、讨论和归档只作为交互与契约演示，不是这些接口已经实现的证据。
