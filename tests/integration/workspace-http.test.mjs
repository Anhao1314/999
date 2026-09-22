import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempStoreDir } from '../support/kernel.mjs';
import { seedEmptyWorkspaceFixture, seedWorkspaceFixture } from '../support/workspace-fixture.mjs';
import { startRuntime } from '../../scripts/lib/runtime-process.mjs';

// One live Runtime, driven entirely through the canonical command seam. The
// Workspace itself owns no write route: this test proves the homepage's only
// Runtime coupling is the Experience API — reads that never mutate truth.
test('founder workspace: static shell, projection reads, no writes, no activity', async () => {
  const dir = tempStoreDir();
  let runtime;
  try {
    runtime = await startRuntime({ dir });
    const facts = await seedWorkspaceFixture((command, input) => runtime.command(command, input));

    // --- the static shell ---
    const page = await fetch(`${runtime.base}/workspace`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /工作台/);
    const asset = await fetch(`${runtime.base}/workspace-assets/app.mjs`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const styles = await fetch(`${runtime.base}/workspace-assets/styles.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(`${runtime.base}/workspace-assets/server.mjs`)).status, 404);
    assert.equal((await fetch(`${runtime.base}/workspace-assets/%2e%2e/server.mjs`)).status, 404);

    // --- local-origin gate and GET-only shell ---
    assert.equal((await fetch(`${runtime.base}/workspace`, { headers: { origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(`${runtime.base}/workspace`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${runtime.base}/workspace`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${runtime.base}/workspace-assets/app.mjs`, { method: 'POST' })).status, 404);

    // --- no route ever lived at /; it now points at the product home ---
    const root = await fetch(`${runtime.base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/workspace');

    // --- the projection the homepage renders ---
    const workspace = await runtime.json(`/experience/companies/${facts.company.id}/workspace`);
    assert.equal(workspace.runtime.available, true);
    assert.equal(workspace.attention.count, 1);
    assert.equal(workspace.attention.items[0].kind, 'DECISION_REQUIRED');
    assert.equal(workspace.attention.items[0].work.id, facts.work.id);
    assert.deepEqual(workspace.attention.items[0].actions.map((action) => action.kind), ['ACCEPT']);
    assert.equal(workspace.primaryWork.selection, 'FOUNDER_ATTENTION');
    assert.equal(workspace.primaryWork.lineage.work.status, 'READY_FOR_DECISION');
    assert.equal(workspace.primaryWork.lineage.founderBoundary.waitingForFounder, true);
    assert.equal(workspace.primaryWork.lineage.founderBoundary.decision, null);

    // --- the AI Workforce and Company Pulse widgets ---
    assert.deepEqual(
      { employees: workspace.workforce.employees, working: workspace.workforce.working, available: workspace.workforce.available, disabled: workspace.workforce.disabled },
      { employees: 4, working: 1, available: 2, disabled: 1 },
    );
    assert.deepEqual(workspace.workforce.onDuty.map((card) => card.employeeId), [facts.employees.busy.id]);
    assert.equal(workspace.pulse.activeWorks, 2);
    assert.equal(workspace.pulse.readyForDecision, 1);
    assert.equal(workspace.pulse.founderAttentionCount, 1);
    assert.equal(workspace.pulse.employeesWorking, 1);

    // --- recent deliveries: a Reviewer PASS is not a Founder acceptance ---
    const delivery = workspace.recentDeliveries.find((entry) => entry.artifactId === facts.artifact.id);
    assert.equal(delivery.reviewState, 'PASS');
    assert.equal(delivery.acceptedState, 'NOT_ACCEPTED');
    assert.match(delivery.title, /定位说明/);

    // --- the endpoints the Inspector reads ---
    const detail = await runtime.json(`/experience/employees/${facts.employees.busy.id}`);
    assert.equal(detail.availability, 'WORKING');
    assert.equal(detail.currentRole, 'EXECUTION');
    const lineage = await runtime.json(`/experience/works/${facts.work.id}/lineage`);
    assert.ok(lineage.steps.some((step) => step.role === 'REVIEW'));
    assert.equal(lineage.founderBoundary.decision, null);

    // --- reading the Workspace creates no Activity and no business row ---
    const before = await runtime.json('/status');
    for (let index = 0; index < 3; index += 1) {
      await fetch(`${runtime.base}/workspace`);
      await runtime.json(`/experience/companies/${facts.company.id}/workspace`);
      await fetch(`${runtime.base}/workspace-assets/styles.css`);
    }
    const after = await runtime.json('/status');
    assert.deepEqual(after.counts, before.counts, 'the homepage is a pure read');

    // --- the merged Lobby is unaffected ---
    assert.equal((await fetch(`${runtime.base}/employees`)).status, 200);
  } finally {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a company with no Work projects an honest empty canvas, not a fabricated one', async () => {
  const dir = tempStoreDir();
  let runtime;
  try {
    runtime = await startRuntime({ dir });
    const facts = await seedEmptyWorkspaceFixture((command, input) => runtime.command(command, input));
    const workspace = await runtime.json(`/experience/companies/${facts.company.id}/workspace`);
    assert.equal(workspace.primaryWork, null);
    assert.equal(workspace.attention.count, 0);
    assert.equal(workspace.pulse.works, 0);
    assert.equal(workspace.recentDeliveries.length, 0);
    assert.equal(workspace.workforce.employees, 1);
    assert.equal((await fetch(`${runtime.base}/workspace`)).status, 200);
  } finally {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workspace switch disables the shell without touching the rest of the Runtime', async () => {
  const dir = tempStoreDir();
  let runtime;
  try {
    runtime = await startRuntime({ dir, extraEnv: { FLOWCREDIT_WORKSPACE_UI: '0' } });
    const company = await runtime.command('createCompany', { name: 'No shell' });
    assert.equal((await fetch(`${runtime.base}/workspace`)).status, 404);
    assert.equal((await fetch(`${runtime.base}/`)).status, 404);
    assert.equal((await fetch(`${runtime.base}/employees`)).status, 200);
    const workspace = await runtime.json(`/experience/companies/${company.id}/workspace`);
    assert.equal(workspace.runtime.available, true);
  } finally {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
