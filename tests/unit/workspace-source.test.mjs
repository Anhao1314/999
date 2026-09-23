import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Source guards for the Founder Workspace. The screen is read-only by
// construction: these assertions freeze that property against future edits.
const dir = new URL('../../apps/workspace/', import.meta.url);
const files = readdirSync(dir).filter((name) => /\.(mjs|html|css)$/.test(name));
const source = Object.fromEntries(
  files.map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
);
const frontend = ['app.mjs', 'adapter.mjs', 'domain.mjs', 'subpages.mjs', 'icons.mjs', 'placement.mjs', 'board-layout.mjs'];
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:[^"'();]*?from\s*)?["']([^"']+)["']/g;

test('no Workspace code reads storage or speaks SQL: Experience is the only Runtime read path', () => {
  for (const [name, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /store\.db|db\.prepare|json_extract|kernel\.store|sqlite/, `${name} must not touch storage`);
    assert.doesNotMatch(text, /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\s+FROM\b/, `${name} must not contain SQL`);
  }
});

test('the frontend holds no kernel and imports nothing beyond its own module graph', () => {
  for (const name of frontend) {
    for (const [, specifier] of source[name].matchAll(IMPORT_PATTERN))
      assert.ok(specifier.startsWith('./'), `${name} must not import ${specifier}`);
  }
  const server = source['server.mjs'];
  assert.match(server, /export function createWorkspaceRoutes/);
  for (const [, specifier] of server.matchAll(IMPORT_PATTERN))
    assert.ok(
      specifier === '../local-origin.mjs' || specifier.startsWith('node:'),
      `server.mjs must not import ${specifier}`,
    );
});

test('nothing in the Workspace can assign, start, review, repair or accept work', () => {
  for (const [name, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /\/commands/, `${name} must not reference the command seam`);
    assert.doesNotMatch(text, /\bPOST\b/, `${name} must not mention POST`);
    assert.doesNotMatch(text, /method:\s*['"]POST['"]/, name);
    for (const command of [
      'assignTask', 'startWorkerRun', 'completeWorkerRun', 'interruptWorkerRun',
      'requestReview', 'submitReview', 'createRepairTask', 'acceptWork', 'driveWork',
      'materializeNextAction', 'setEmployeeEnabled', 'createWork', 'createTask', 'completeTask',
    ])
      assert.doesNotMatch(text, new RegExp(`\\b${command}\\b`), `${name} must not reference ${command}`);
  }
});

test('the LIVE source is the workspace projection and nothing lower-level', () => {
  const adapter = source['adapter.mjs'];
  assert.match(adapter, /\/experience\/companies\//);
  assert.match(adapter, /\/experience\/employees\//);
  assert.match(adapter, /\/experience\/works\//);
  assert.match(adapter, /'\/companies'/);
  assert.doesNotMatch(adapter, /\/workforce/);
  assert.doesNotMatch(adapter, /\/attention/);
  const app = source['app.mjs'];
  for (const field of ['attention', 'primaryWork', 'workforce', 'recentDeliveries'])
    assert.match(app, new RegExp(`projection(\\?\\.|\\.)${field}`), `the canvas must render projection.${field}`);
  assert.match(app, /pulseStory\(projection\)/);
  assert.match(source['domain.mjs'], /projection\?\.pulse/);
  assert.match(app, /runtime-status/);
  assert.match(app, /状态来自|Runtime 暂不可用/);
});

test('transport state is separate from Company and Employee state, and no demo fallback exists', () => {
  assert.match(source['domain.mjs'], /RUNTIME_UNAVAILABLE/);
  assert.match(source['app.mjs'], /Runtime 暂不可用/);
  assert.match(source['app.mjs'], /尚未刷新/);
  for (const [name, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /\bONLINE\b|\bOFFLINE\b|\bIDLE\b|\bDISCONNECTED\b|\bFAILED\b/, `${name} must not invent Employee states`);
    assert.doesNotMatch(text, /demo/i, `${name} must not carry a demo mode`);
    assert.doesNotMatch(text, /\bunread\b|dismiss|archive/i, `${name} must not invent a notification lifecycle`);
  }
});

test('Founder subpages keep hiring read only and avoid fake decisions', () => {
  const subpages = source['subpages.mjs'];
  for (const id of ['work', 'artifacts', 'hiring', 'knowledge', 'settings'])
    assert.match(source['domain.mjs'], new RegExp(`id: '${id}'.*kind: 'SUBPAGE'`));
  assert.match(subpages, /hiring: .*source: 'READ_ONLY'/);
  assert.match(subpages, /source: 'LIVE'/);
  assert.match(source['company-hiring.mjs'], /试用通过不自动聘用/);
  assert.match(source['company-hiring.mjs'], /关闭后不会留下岗位或候选员工/);
  assert.match(subpages, /尚未提供交付内容预览/);
  assert.match(subpages, /当前界面尚未接入安全的产品创建命令/);
  assert.match(subpages, /start\.disabled = true/);
  assert.match(source['adapter.mjs'], /\/companies\/\$\{encodeURIComponent\(companyId\)\}\/works/);
});

test('the workforce widget links to the merged Lobby and reuses its assets', () => {
  const app = source['app.mjs'];
  assert.match(app, /'\/employees'/);
  assert.match(app, /\/employee-assets\/assets\/portrait-/);
  assert.match(app, /projection\?\.founderAssistant/);
  assert.match(app, /\/employee-assets\/assets\/sprite-/);
  assert.match(source['index.html'], /id="assistant-pet"/);
  assert.match(source['index.html'], /id="assistant-bubble"/);
});

test('read-only execution and artifact projections contain no model messages or credentials', () => {
  for (const name of frontend) {
    assert.doesNotMatch(
      source[name],
      /sessionId|processId|workspacePath|jsonl|\bprompt\b|chainOfThought|apiKey|secretValue/,
      `${name} must not surface process internals, model messages or credentials`,
    );
  }
  assert.match(source['adapter.mjs'], /live-action/);
  assert.match(source['adapter.mjs'], /artifactReading/);
  assert.match(source['app.mjs'], /workerRunId/);
  assert.match(source['app.mjs'], /真实交付正文/);
});

test('the page shell serves the Workspace client and text nodes only', () => {
  const page = source['index.html'];
  assert.match(page, /\/workspace-assets\/app\.mjs/);
  assert.match(page, /工作台/);
  assert.doesNotMatch(page, /<script(?![^>]*src=)/);
  assert.match(source['server.mjs'], /'icons\.mjs'/);
  assert.match(source['app.mjs'], /symbol\(id\)/);
  assert.match(source['subpages.mjs'], /symbol\(state\.id\)/);
  assert.match(page, /id="page-popover-mark"/);
});

test('Company Canvas keeps presentation local and Work submission unavailable', () => {
  const page = source['index.html'];
  const app = source['app.mjs'];
  const server = source['server.mjs'];
  assert.match(page, /id="new-work"[^>]*disabled/);
  assert.match(app, /projection\.primaryWork/);
  assert.match(app, /projection\.attention/);
  assert.match(app, /projection\.workforce/);
  assert.match(app, /projection\.recentDeliveries/);
  assert.match(app, /pulseStory\(projection\)/);
  assert.match(app, /lineageEvidence\(lineage\)/);
  assert.match(page, /id="presentation-toggle"/);
  assert.match(app, /function renderBoard/);
  assert.match(app, /function openBoardSummary/);
  assert.match(app, /function openBoardDetail/);
  assert.match(app, /clampCardPosition/);
  assert.match(app, /function companyWelcome/);
  assert.match(app, /event\.metaKey/);
  assert.match(app, /event\.ctrlKey/);
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page + app + server, /\/company(?:\/|['"`])/);
  assert.doesNotMatch(app, /Accept|Dismiss|Resolve|发送消息/);
});
