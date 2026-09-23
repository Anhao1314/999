export function applicationMenuTemplate({
  appName,
  isPackaged,
  platform = process.platform,
  navigate = () => {},
  currentPath = "/workspace",
  openSettings = null,
} = {}) {
  const template = [];

  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        ...(openSettings ? [{ label: "模型与 Relay Sense 设置…", click: openSettings }, { type: "separator" }] : []),
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "导航",
    submenu: [
      { label: "公司", type: "radio", checked: currentPath === "/workspace", accelerator: "CmdOrCtrl+1", click: () => navigate("/workspace") },
      { label: "AI 员工", type: "radio", checked: currentPath === "/employees", accelerator: "CmdOrCtrl+2", click: () => navigate("/employees") },
      { type: "separator" },
      { label: "搜索当前页面", accelerator: "CmdOrCtrl+K", click: () => navigate("search") },
    ],
  });

  template.push({
    label: "File",
    submenu: [
      { label: "New Work", enabled: false },
      { type: "separator" },
      { role: "close" },
      ...(platform === "darwin" ? [] : [{ type: "separator" }, { role: "quit" }]),
    ],
  });

  template.push({
    label: "View",
    submenu: [
      { role: "togglefullscreen" },
      ...(isPackaged
        ? []
        : [{ type: "separator" }, { role: "toggleDevTools" }]),
    ],
  });

  if (platform !== "darwin" && openSettings)
    template.push({ label: "Settings", submenu: [{ label: "模型与 Relay Sense", click: openSettings }] });

  return template;
}
