# 验证结果 · 2026-09-22

环境：Windows，Node 24.21.0 / npm 11.19.0。初始工作区干净，分支 main；未执行 commit / push / merge / staging。

## 命令结果

| 命令 | 结果 |
| --- | --- |
| `npm run test:employees` | 退出码 0；16 tests / 16 pass / 0 fail |
| `npm run check` | 退出码 0；16 required files / 82 tracked files / 30 core files；无凭据、无旧实现复制、核心词汇检查通过 |
| `node --check apps/employee/*.mjs`（逐文件运行） | 全部通过 |
| `git diff --check` | 退出码 0；仅 Windows LF→CRLF 提示 |
| `npm test` | 退出码 1；180 tests / 58 pass / 122 fail |
| 原项目 lint / typecheck / build | 未定义这些脚本；未伪造运行结果。当前是浏览器原生 ESM，无构建依赖 |

第一次默认沙箱执行 Node 测试遇到 spawn EPERM；使用无进程隔离验证了纯逻辑，之后通过获准的本地测试执行完成了子进程集成测试和完整回归。沙箱内 check 曾无法运行 git；最终上表是成功检查 82 个 tracked files 的结果。

## 全仓失败归因

- 115 项：既有测试的 cleanup 在 SQLite 未 close 时删除临时目录，Windows 返回 EPERM。
- 7 项：既有进程测试期望 stop 返回 exit code 0；Windows SIGTERM 结束进程得到 null。业务断言之后的退出码检查失败。
- 用 `git archive HEAD` 生成隔离原始副本，运行原有 `activity.test.mjs` 与 `continuation.test.mjs`，6 项中 1 通过 / 5 失败，复现上述两类相同错误。
- 没有为使回归变绿而改写 Kernel、旧测试或进程 harness。完整原始输出位于忽略的 `.test-employee-evidence/`；原始副本验证后已移除，避免被 Node 重复发现。
- **全仓回归不是通过状态**。建议团队单独修复 Windows 测试资源回收/退出语义，或在项目原有 CI 平台复测。

## 新增测试覆盖

1. 7/20/60 人稳定入座、六座扩容、同组优先、释放座位、重连不重排。
2. 旧请求/旧 snapshot revision 拒绝、事件重复/缺口/公司隔离、断线动作停止。
3. 未知 Token 不变成 0；裁剪比例与边界；拒绝 SVG、伪装格式、过大文件和过大 PNG。
4. 真 Kernel：start → read projection → persisted Activity → Artifact metadata → complete；DTO 不包含工作包/产物正文。
5. 跨公司、指派改变、busy、未支持命令、历史游标和历史不重叠分页。
6. 本地 Origin/Host 检查、feature flag、幂等请求重放/冲突、202 不当成功。
7. 模拟配置冲突 409、运行中的配置版本冻结、pending 不当 confirmed、活跃归档拒绝、精确名称确认与 tombstone。
8. HTTP 断线后重取快照，卸载 abort 与停止订阅。

## 实际浏览器验收

通过 Codex in-app browser 操作项目服务，无 iframe 原型。

- 默认大厅 → 角色 → 居中 ID 卡；姓名/职位搜索，真实/模拟标识。
- 在**隔离 synthetic 测试公司**中，通过 UI 分配真实 Assignment 并启动真实 Kernel WorkerRun；卡片显示运行已开始；测试随后通过原接口记录 Artifact、完成 WorkerRun，卡片详情显示完成与真实产物 ID。没有模型调用。
- 真实服务停机后显示陈旧/断线并停止工作动画；重启后自动恢复快照，原员工 walking 数量为 0。
- 模拟新增角色出现 walking；60 人压力演示得到 10 张桌、60 个不同座位；reduce-motion 可跳过移动，业务状态不丢失。
- 模拟暂停立即仍显示运行中，显示待确认；回执后显示已暂停。
- 修改姓名后关闭弹出页面内确认；取消关闭保留输入；保存同步到大厅和工牌。
- PNG 文件实际导入、缩放、平移、确认本地预览；portrait 成为本地 PNG，sprite 路径不变。
- 头像 → 卡片 → 角色管理逐层 Esc/Back，恢复入口焦点；Shift+Tab 从关闭按钮回到日志，Tab 从日志回到关闭按钮。
- 1440×900、1280×720、390×844 实际视口检查；手机 body 无横向溢出，卡片 body scrollWidth = clientWidth = 347，初次打开 scrollTop = 0，底栏在视口内。
- 最终真实页浏览器 error/warn 日志为空。原生 `confirm` 在内置浏览器会阻塞自动化，已替换成可访问的页面内确认弹窗。

## 截图

均为真实 Kernel **测试数据**，不是生产模型执行截图。文件名为 CSS viewport 尺寸；浏览器截图可能不包含系统滚动条。

- [1440 大厅](screenshots/live-lobby-1440x900.png) · [1440 工牌](screenshots/live-card-1440x900.png)
- [1280 大厅](screenshots/live-lobby-1280x720.png) · [1280 工牌](screenshots/live-card-1280x720.png)
- [390 大厅](screenshots/live-lobby-390x844.png) · [390 工牌](screenshots/live-card-390x844.png)
- [真实断线降级](screenshots/live-offline.png)
