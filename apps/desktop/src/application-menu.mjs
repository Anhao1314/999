export function applicationMenuTemplate({
  appName,
  isPackaged,
  platform = process.platform,
} = {}) {
  const template = [];

  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
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

  return template;
}
