# Company Canvas · UI v0

按用户提供的工作台参考图及 Hiring 设计说明实现的纯前端预览，沿用仓库原生 HTML/CSS/ESM 技术栈。未修改 Runtime、数据库、Kernel 或员工 API；复用既有员工大厅，并增加岗位筛选与列表切换。

从仓库根目录运行：

```sh
npm run start:company
```

打开 `http://127.0.0.1:4320/company/`。可通过 `FLOWCREDIT_COMPANY_PREVIEW_PORT` 改预览端口。

## 已实现

- 雪山背景、玻璃侧栏与顶栏、公司画布、曲线连接、员工详情栏。
- 公司／工作／员工／招聘／交付物／知识导航。
- 员工详情和活动切换、交付物阅读、工作说明、待办示例。
- 新建本地草稿、刷新恢复、按工作名称与员工姓名／职位搜索，Ctrl/⌘ K 快捷键。
- 自由布局／网格布局、70–120% 缩放、卡片显隐、详情栏显隐、减少动态与背景设置。
- 手机纵向卡片布局，员工信息作为可关闭抽屉。
- 招聘首页、六种岗位模板、六步招聘向导、访问权限配置、模拟试用与 Founder 明确确认。
- 确认入职后进入已有圆桌大厅，工牌显示招聘摘要，公司页同步演示团队人数。

## 数据边界

页面使用 `demo-adapter.mjs`，所有员工、执行状态、测试结果、交付物和统计均为明确标识的演示数据。工作草稿只写本浏览器 `flowcredit.company-ui.v1.drafts`，招聘草稿和确认记录写 `flowcredit.company-ui.hiring.v1`，存储不可用时退回页面内存并提示。没有调用模型、发送消息或真实审批。知识模块仍显示后续接入说明。

`scripts/preview-company.mjs` 是仅提供白名单静态文件的本地预览器，不导入 Runtime，不打开数据库，不提供写接口。浏览器 CSP 使用 `connect-src 'none'`。预览服务内 `/employees` 强制进入 demo，加载同一演示团队；既有 `npm run start:employees` 的生产入口和 LIVE 数据路径不变。

验证：`npm run test:company`、`npm run test:employees`。交互与截图见 `reports/COMPANY_HIRING_UI.md`。

主线已有 `apps/workspace/` LIVE 工作台和 Experience API。本模块只提供视觉与交互参考，不取代产品入口。后续应将样式与布局迁入既有工作台，保留其只读 adapter 和失败语义，不把本地演示草稿接成真实工作写操作。详见 `reports/COMPANY_UI_TEAM_HANDOFF.md`。

## 视觉资源

- 员工头像：复用 `apps/employee/assets/portrait-1.png` 至 `portrait-8.png`；当前为已有占位像素素材。
- 图标：页面内 SVG。
- 雪山背景：内置 imagegen 工具生成，已保存为 `assets/alpine-wallpaper.png`，不依赖外链。
- 素材提示词及验收记录：`reports/COMPANY_UI_V0.md`。
