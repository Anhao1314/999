# Hiring UI 与圆桌对接验收

## 范围

基于用户提供的 Hiring UI Design Spec，延续浅蓝玻璃 Company Canvas。保持后端不动，完成可操作的招聘原型，并恢复已有圆桌管理入口。

首页包含示例 Capability Needs、六种 Position Templates、Open Positions 与 Recent Hires。六步流程为岗位、身份、能力与 Skills、访问与权限、Trial Work、Founder Confirm。岗位与候选人使用独立 ID，身份风格不改变权限。Skills 仅选择方法包，未安装真实工具。

试用可选择 PASS 或 REQUEST_REVISION 的演示结果；按执行、交付物、独立评审三个阶段展示。所有能力证据仍为 demo observed，未标记真实 Verified。失败不允许继续；修改配置后旧结果失效；显式勾选 Founder 确认后才进入演示名单。欢迎页提供 View Employee / Done。

## 圆桌复用

预览静态服务挂载原来的 Employee Lobby HTML、CSS、脚本与像素素材。仅在预览内加载 `lobby-adapter.mjs` 和 `lobby-entry.mjs`，使用公司同一批基础员工与本地已确认招聘记录。圆桌入座、工牌、公开活动、角色管理沿用既有实现。

角色管理增加岗位筛选和卡片/列表切换；新员工工牌可查看招聘档案、方法包与确认的访问/权限摘要。生产 LIVE 仍消费 Experience 投影，生产服务不导入本地招聘数据。

## 验证证据

```sh
npm run test:company
npm run test:employees
npm run check
git diff --check
```

- 招聘与静态预览：8 个测试通过。覆盖显式确认、配置变更使证据失效、失败重试、幂等入职、草稿恢复、损坏存储、无存储降级，以及静态路由/无命令端点。
- 既有员工模块：16 个测试通过，含 LIVE / demo 隔离、Experience adapter、HTTP 路由、投影、seating 与源代码边界。
- 仓库结构检查通过；50 个核心文件词汇检查通过。
- 浏览器实际操作：从 payments.integration 示例开始招聘 Aster；REQUEST_REVISION 阻止继续，重试 PASS；未勾选确认无法入职；确认后 8→9 人；圆桌入座、工牌、岗位筛选（1/9）、列表切换正确。
- 刷新恢复草稿；公司页 Recent Hires 与员工人数同步；像素头像保持一致。
- 1440×900 桌面检查；390×844 手机端检查（文档 clientWidth / scrollWidth 均 375，无横向溢出）；控制台 error/warn 为 0。恢复浏览器默认尺寸。

截图：[首页](company-hiring-desktop.png)、[身份向导](company-hiring-identity.png)、[手机端](company-hiring-mobile.png)。Aster / Robin 为本次浏览器验收的合成示例，记录不提交仓库。

## 边界

未创建真实 Position / Employee，未启动模型、WorkerRun 或 Trial 后端，未授予真实工具权限。静态服务 CSP 禁用网络连接，非 GET/HEAD 请求返回 405，Runtime/API 路径不可用。浏览器记录只属于独立演示空间，不是第二套生产 Company Truth。

默认启动 `npm run start:company`，访问 `http://127.0.0.1:4320/company/#hiring`。端口可由 `FLOWCREDIT_COMPANY_PREVIEW_PORT` 指定；招聘与圆桌需同一 origin 以共享演示存储。
