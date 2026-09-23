// A session-scoped display preference, never company or Runtime state.
const key = 'flowcredit.scene.paused';
export function scenePaused(systemPreference = false) {
  try { const value = sessionStorage.getItem(key); return value === null ? systemPreference : value === 'true'; }
  catch { return systemPreference; }
}
export function saveScenePaused(value) {
  try { sessionStorage.setItem(key, String(value)); } catch { /* Storage may be unavailable. */ }
}
