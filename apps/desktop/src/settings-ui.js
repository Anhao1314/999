const $ = (id) => document.getElementById(id);
const names = {
  NOT_CONFIGURED: "未配置",
  CONFIGURED: "已配置 · 尚未测试",
  CONNECTED: "已连接",
  INVALID: "密钥无效",
  UNAVAILABLE: "安全存储或连接暂不可用",
};

function render(result) {
  const state = names[result?.status] ? result.status : "UNAVAILABLE";
  $("status").textContent = names[state];
  $("status").dataset.state = state;
  $("configured-note").hidden = result?.configured !== true;
  $("test").disabled = result?.configured !== true;
  $("remove").disabled = result?.configured !== true;
  $("save").disabled = state === "UNAVAILABLE" && result?.configured !== true;
}

async function run(action) {
  for (const id of ["save", "test", "remove"]) $(id).disabled = true;
  $("message").textContent = "正在处理…";
  try {
    const result = await action();
    render(result);
    $("message").textContent = result?.status === "UNAVAILABLE" ?
      "操作未完成，请检查本机安全存储或网络后重试。" : "状态已更新。";
  } catch {
    $("message").textContent = "操作未完成，请重试。";
    render({ status: "UNAVAILABLE", configured: false });
  }
}

$("save").addEventListener("click", () => {
  const key = $("key").value;
  $("key").value = "";
  void run(() => window.relaySettings.save(key));
});
$("test").addEventListener("click", () => void run(() => window.relaySettings.test()));
$("remove").addEventListener("click", () => void run(() => window.relaySettings.remove()));
void window.relaySettings.status().then(render).catch(() => render({ status: "UNAVAILABLE" }));


function renderDeepSeek(result) {
  const state = names[result?.status] ? result.status : "UNAVAILABLE";
  $("deepseek-status").textContent = names[state];
  $("deepseek-status").dataset.state = state;
  $("deepseek-configured-note").hidden = result?.configured !== true;
  $("deepseek-test").disabled = result?.configured !== true;
  $("deepseek-remove").disabled = result?.configured !== true;
  $("deepseek-save").disabled = state === "UNAVAILABLE" && result?.configured !== true;
}

async function runDeepSeek(action) {
  for (const id of ["deepseek-save", "deepseek-test", "deepseek-remove"]) $(id).disabled = true;
  $("deepseek-message").textContent = "正在处理…";
  try {
    const result = await action();
    renderDeepSeek(result);
    $("deepseek-message").textContent = result?.status === "UNAVAILABLE" ?
      "操作未完成，请检查本机安全存储或网络后重试。" : "状态已更新。";
  } catch {
    $("deepseek-message").textContent = "操作未完成，请重试。";
    renderDeepSeek({ status: "UNAVAILABLE", configured: false });
  }
}

$("deepseek-save").addEventListener("click", () => {
  const key = $("deepseek-key").value;
  $("deepseek-key").value = "";
  void runDeepSeek(() => window.relaySettings.deepseekSave(key));
});
$("deepseek-test").addEventListener("click", () => void runDeepSeek(() => window.relaySettings.deepseekTest()));
$("deepseek-remove").addEventListener("click", () => void runDeepSeek(() => window.relaySettings.deepseekRemove()));
void window.relaySettings.deepseekStatus().then(renderDeepSeek).catch(() => renderDeepSeek({ status: "UNAVAILABLE" }));
