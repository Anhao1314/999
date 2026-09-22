// Static product shell for the Founder Workspace.
//
// Like the Employee Lobby shell, this process serves files and nothing else:
// it holds no kernel, opens no database, derives no projection and owns no
// write route. The browser consumes the frozen Workforce Experience HTTP API
// directly (see apps/workspace/adapter.mjs), so the Workspace cannot drift
// into a second read path, a scheduler or a second truth store.
//
// The page reads; it never writes. There is no command in this shell, in the
// adapter or in the page source — Founder Authority stays at the Runtime seam
// (docs/contracts/founder-workspace-v0.md §5).
import { readFile } from 'node:fs/promises';
import { isLocalBrowserRequest } from '../local-origin.mjs';

const ROOT = new URL('./', import.meta.url);
const ASSETS = new Set(['app.mjs', 'adapter.mjs', 'domain.mjs', 'styles.css']);
const TYPES = {
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  html: 'text/html; charset=utf-8',
};

export function createWorkspaceRoutes({ enabled = true } = {}) {
  return async (request, response, url) => {
    if (
      !enabled ||
      !(
        ['/workspace', '/workspace/'].includes(url.pathname) ||
        url.pathname.startsWith('/workspace-assets/')
      )
    )
      return false;
    const json = (status, data) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
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
    const file = url.pathname.startsWith('/workspace-assets/')
      ? url.pathname.slice('/workspace-assets/'.length)
      : 'index.html';
    if (file !== 'index.html' && !ASSETS.has(file)) {
      json(404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
      return true;
    }
    const body = await readFile(new URL(file, ROOT));
    response.writeHead(200, {
      'content-type': TYPES[file.split('.').at(-1)],
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    response.end(body);
    return true;
  };
}
