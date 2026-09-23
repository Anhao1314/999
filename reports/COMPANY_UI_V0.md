# 公司工作台 UI 初版 · 2026-09-23

## 范围

根据用户提供的浅蓝雪山、玻璃质感 Company Canvas 参考图，新增 `apps/company/` 前端模块。用户要求先不动后端，本次未修改 `apps/runtime/`、`packages/`、数据库或员工模块既有文件。原员工页面三项未提交改动和角色管理报告均保留。

新增前端入口、样式、交互与 demo adapter；新增独立静态预览脚本；`package.json` 仅添加 `start:company` 命令。没有新增依赖。根据用户后续上传授权，本预览以独立 PR 交付；未部署、未合并 main。协作边界见 [队友接入说明](COMPANY_UI_TEAM_HANDOFF.md)。

## 预览

`npm run start:company` → `http://127.0.0.1:4320/company/`。

这是项目内的纯前端预览入口，尚未挂载到 Runtime 的产品路由。预览进程不会启动 Kernel，也不会读取 `.runtime/`。

## 实际检查

- 三个新增 `.mjs` 文件均通过 `node --check`。
- `git diff --check` 通过，只有已有文件的 Windows 换行提示。
- `npm run check` 通过：16 required files / 125 tracked files / 30 core files。
- 浏览器 1440×900：检查完整工作台、卡片布局与详情栏。
- 浏览器 390×844：纵向卡片、员工抽屉开关、导航可访问名称正常，页面 scrollWidth 等于 clientWidth，无横向溢出。
- 浏览器 1280×720：无横向溢出；逐对检查五张画布卡片的可见边界，无重叠。矮窗口通过纵向滚动查看下方内容。
- 新建“第一版工作台体验”演示草稿，工作列表即时出现，刷新后仍存在。
- 搜索 Iris 只返回对应员工；点击后详情切换至 Iris；活动页显示对应员工的示例记录。
- 网格布局可切换；关闭 Company Pulse 复选框后卡片隐藏；缩放从 100% 更新为 90%。
- 浏览器记录未发现 error / warn。
- UI 实现阶段未重复运行全仓后端测试；先前 Windows 失败记录来自旧员工分支，不能用来描述更新后的 main。基于最新主线的提交前检查单独记入队友接入说明。

截图：[桌面](company-ui-desktop.png) · [手机](company-ui-mobile.png)。桌面截图为 1440×900 CSS viewport，以 1.5 倍像素密度保存。

## 当前限制

- 页面明确为演示空间，执行状态、测试数量与产物都是 UI 示例，不是后端验收证据。
- 新建工作仅保存为浏览器本地草稿；招聘、知识、消息、真实审批与模型配置尚未接入。
- 自由画布是预设位置布局；尚未实现卡片拖拽或连线编辑。小屏改为纵向排列，缩放只用于桌面自由画布。
- 头像复用现有占位素材，后续可换精修头像。
- 桌面矮窗口允许纵向滚动，以保留卡片间距；详情栏内容可独立滚动。
- 浏览器验收产生的一条明确标记的本地演示草稿保留供体验，不写项目数据文件或数据库。

## 背景素材 provenance

生成方式：内置 `image_gen`，非 API/CLI fallback。

保存位置：`apps/company/assets/alpine-wallpaper.png`。

最终提示词：

> Use case: stylized-concept. Asset type: full screen background wallpaper for an airy pale blue desktop productivity app. Create a high quality panoramic landscape, 1536x1024 or wider, photorealistic yet softly ethereal snow-covered alpine mountain range. Composition: upper 65 percent is almost empty luminous powder blue sky with very subtle white haze, lower 35 percent snowy mountains, high jagged ridge entering from left bottom at 45 percent height and descending toward center valley, distant peaks on lower right, smooth foreground snow at bottom. Cool icy blue and white palette with the faintest warm ivory sunlight and soft lavender shadows, bright low contrast dreamy winter morning, premium macOS wallpaper aesthetic, delicate detailed snow texture and realistic sharp craggy peaks. Keep the entire center especially airy and bright for floating UI cards. No text, no interface, no icons, no people, no buildings, no watermark. It is a BACKGROUND only, not an image of an app.

网页通过 CSS 渐变和透明度调节背景，让文字与卡片保持可读。
