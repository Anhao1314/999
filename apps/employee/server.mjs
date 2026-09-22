// Static product shell for the Employee Lobby.
//
// This process serves files and nothing else: it holds no kernel, opens no
// database and contains no projection logic. The browser consumes the frozen
// Workforce Experience HTTP API directly (see apps/employee/adapter.mjs), so
// the Lobby cannot drift into a second read path or a manual scheduler.
import { readFile } from 'node:fs/promises';
import { isLocalBrowserRequest } from '../local-origin.mjs';

const ROOT = new URL('./', import.meta.url);
const ASSETS = new Set([
  'app.mjs', 'adapter.mjs', 'domain.mjs', 'demo.mjs', 'avatar.mjs', 'styles.css',
  ...Array.from({ length: 8 }, (_, i) => `assets/portrait-${i + 1}.png`),
  ...Array.from({ length: 8 }, (_, i) => `assets/sprite-${i + 1}.png`),
]);
const TYPES = { mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', html: 'text/html; charset=utf-8' };

// Re-exported for the Runtime process, which gates /commands with the same rule.
export { isLocalBrowserRequest };

export function createEmployeeRoutes({ enabled = true } = {}) {
  return async (request, response, url) => {
    if (!enabled || !(['/employees', '/employees/'].includes(url.pathname) || url.pathname.startsWith('/employee-assets/'))) return false;
    const json = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    if (!isLocalBrowserRequest(request)) {
      json(403, { error: { code: 'LOCAL_ORIGIN_REQUIRED', message: '仅允许同源本地请求' } });
      return true;
    }
    if (request.method !== 'GET') {
      json(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return true;
    }
    const file = url.pathname.startsWith('/employee-assets/') ? url.pathname.slice('/employee-assets/'.length) : 'index.html';
    if (file !== 'index.html' && !ASSETS.has(file)) {
      json(404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
      return true;
    }
    const body = await readFile(new URL(file, ROOT));
    response.writeHead(200, {
      'content-type': TYPES[file.split('.').at(-1)],
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    response.end(body);
    return true;
  };
}
