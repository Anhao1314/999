export function isRuntimeUrl(target, runtimeBase) {
  try {
    const candidate = new URL(target);
    const runtime = new URL(runtimeBase);
    return (
      candidate.origin === runtime.origin &&
      candidate.username === "" &&
      candidate.password === ""
    );
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(target) {
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
