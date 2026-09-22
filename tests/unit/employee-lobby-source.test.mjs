import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../../apps/employee/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
const source = Object.fromEntries(files.map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));

test('no Lobby code reads storage directly: the Experience API is the only Runtime read path', () => {
  for (const [name, text] of Object.entries(source)) {
    assert.doesNotMatch(text, /store\.db|db\.prepare|json_extract|kernel\.store/, `${name} must not touch storage`);
    assert.doesNotMatch(text, /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\s+FROM\b/, `${name} must not contain SQL projection`);
  }
});

test('the production shell holds no kernel and mounts no command or projection route', () => {
  const server = source['server.mjs'];
  assert.doesNotMatch(server, /createEmployeeRoutes\(\s*kernel/, 'the static shell never receives a kernel');
  assert.doesNotMatch(server, /employee-api/, 'the legacy projection API is gone');
  assert.doesNotMatch(server, /assignTask|startWorkerRun|setEmployeeEnabled/, 'the shell never coordinates');
});

test('the live adapter exposes only Experience reads and the Founder enable/disable control', () => {
  const adapter = source['adapter.mjs'];
  assert.match(adapter, /\/experience\/companies\//);
  assert.match(adapter, /\/experience\/employees\//);
  assert.match(adapter, /\/experience\/works\//);
  assert.doesNotMatch(adapter, /assignTask|startWorkerRun|completeWorkerRun|requestReview/, 'assign and start are not reachable from the lobby adapter');
  assert.match(adapter, /setEmployeeEnabled/);
});

test('the Employee domain vocabulary is availability and role, not transport or lifecycle words', () => {
  const domain = source['domain.mjs'];
  assert.match(domain, /AVAILABLE/);
  assert.match(domain, /WORKING/);
  assert.match(domain, /DISABLED/);
  assert.doesNotMatch(domain, /\bIDLE\b|\bONLINE\b|\bOFFLINE\b|\bDISCONNECTED\b|\bRUNNING\b|\bFAILED\b/);
  const app = source['app.mjs'];
  assert.match(app, /执行中|审核中|返工中/);
  assert.doesNotMatch(app, /statusNames\s*=\s*\{[^}]*idle/);
});

test('every recorded Activity kind has product language: the UI never renders a raw kind', async () => {
  const { EVENTS, LEGACY_LIFECYCLE_KINDS } = await import('../../packages/runtime/events.mjs');
  const app = source['app.mjs'];
  for (const kind of [...Object.values(EVENTS), ...LEGACY_LIFECYCLE_KINDS]) {
    assert.ok(app.includes(`'${kind}'`) || app.includes(`${kind}:`) || app.includes(`'${kind}':`), `activityNames must cover ${kind}`);
  }
  assert.doesNotMatch(app, /activityNames\[record\.kind\]\s*\?\?\s*record\.kind/, 'unknown kinds must fail closed');
});
