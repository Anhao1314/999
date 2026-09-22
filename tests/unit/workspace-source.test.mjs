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
const frontend = ['app.mjs', 'adapter.mjs', 'domain.mjs'];
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
  for (const field of ['attention', 'primaryWork', 'workforce', 'recentDeliveries', 'pulse'])
    assert.match(app, new RegExp(`projection(\\?\\.|\\.)${field}`), `the canvas must render projection.${field}`);
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

test('placeholder areas are honest and invent no LIVE data', () => {
  const domain = source['domain.mjs'];
  assert.match(domain, /招聘能力将在 Hiring MVP 中开放/);
  assert.match(domain, /知识空间将在 Knowledge layer 接入后开放/);
  assert.match(domain, /工作列表将在后续里程碑开放/);
  assert.doesNotMatch(source['app.mjs'], /候选人|示例数据|mock|sample/i);
});

test('the workforce widget links to the merged Lobby and reuses its assets', () => {
  const app = source['app.mjs'];
  assert.match(app, /'\/employees'/);
  assert.match(app, /\/employee-assets\/assets\/portrait-/);
});

test('no forbidden raw execution field is rendered', () => {
  for (const name of frontend) {
    assert.doesNotMatch(
      source[name],
      /workerRunId|sessionId|processId|workspacePath|jsonl|contentDigest|artifactDigest|\bprompt\b/,
      `${name} must not surface raw execution detail`,
    );
  }
});

test('the page shell serves the Workspace client and text nodes only', () => {
  const page = source['index.html'];
  assert.match(page, /\/workspace-assets\/app\.mjs/);
  assert.match(page, /工作台/);
  assert.doesNotMatch(page, /<script(?![^>]*src=)/);
});
