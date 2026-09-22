# 队友接入速览

用户已验收 AI 员工模块，并授权上传团队仓库。协作分支：`feat/ai-employee-lobby`。本交接不合并 main。

## 拉取与启动

```sh
git fetch origin
git switch --track origin/feat/ai-employee-lobby
npm run start:employees
```

切换前请保护自己的未提交改动。Node 要求 >=24.19.0 <25；没有新增依赖，无需数据库迁移。

- 真实入口：`http://127.0.0.1:4318/employees`
- 模拟演示：`http://127.0.0.1:4318/employees?demo=1`
- 禁用：设置 `FLOWCREDIT_EMPLOYEE_UI=0` 并重启。

## 对接重点

真实模式已接员工/岗位/任务/运行/活动/产物元数据，以及现有 Kernel 的分配、启动和启用/停用。默认是大厅，右上“角色”管理，点击员工打开工牌。

模型执行、配置写入、Token 统计、暂停/恢复、归档和头像上传仍待后端实现；真实模式明确禁用。模拟模式中的控制与配置不表示真实接口已经完成。头像目前只作本页本地裁剪预览。

请后端同学优先查看 [最小接口交接](BACKEND_HANDOFF.md)。所有浏览器请求经 adapter；没有修改 `packages/`、driver、schema 或原有调度策略。共享入口仅改 `apps/runtime/server.mjs`、`package.json` 和 README。

## 验证与评审

- `npm run test:employees`：16/16 通过。
- `npm run check`、语法与 diff 检查通过。
- Windows 全仓回归：58/180 通过；122 项既有失败已在原始 HEAD 复现其两类原因，分别是 SQLite 未关闭时清理文件、进程退出码差异。不要将此结果标为全仓测试通过。
- [完整改动与能力矩阵](INTEGRATION_REPORT.md) · [测试和截图](TEST_RESULTS.md)

当前仅支持本地单用户 loopback 运行，不是可直接公开部署的生产服务。截图及联调数据为明确标记的 synthetic 测试记录，真实运行库、凭据和临时测试文件未列入交接提交。
