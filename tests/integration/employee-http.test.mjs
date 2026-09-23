import test from 'node:test';
import assert from 'node:assert/strict';
import { tempStoreDir } from '../support/kernel.mjs';
import { startRuntime } from '../../scripts/lib/runtime-process.mjs';
import { rmSync } from 'node:fs';

// One live Runtime, driven entirely through the canonical command seam. The
// Lobby itself gets no write route in production: this test proves the UI's
// only runtime coupling is the Experience API plus Founder controls.
test('employee lobby live mode: Experience reads, no manual scheduling, no direct DB route', async () => {
  const dir = tempStoreDir();
  let runtime;
  try {
    runtime = await startRuntime({ dir });
    const company = await runtime.command('createCompany', { name: 'Lobby integration' });
    const position = await runtime.command('createPosition', { companyId: company.id, title: 'Builder', capabilities: ['build'] });
    const reviewerPosition = await runtime.command('createPosition', { companyId: company.id, title: 'Reviewer', capabilities: ['review'] });
    const employee = await runtime.command('createEmployee', { companyId: company.id, positionId: position.id, displayName: 'Actual employee' });
    const reviewer = await runtime.command('createEmployee', { companyId: company.id, positionId: reviewerPosition.id, displayName: 'Actual reviewer' });
    const disabled = await runtime.command('createEmployee', { companyId: company.id, positionId: position.id, displayName: 'Disabled employee' });
    await runtime.command('setEmployeeEnabled', { employeeId: disabled.id, enabled: false });
    const work = await runtime.command('createWork', { companyId: company.id, title: 'Actual work', intent: 'verify the lobby transport' });
    const task = await runtime.command('createTask', { workId: work.id, title: 'Actual task', intent: 'verify', requiredCapabilities: ['build'] });
    await runtime.command('setTaskRequirements', { taskId: task.id, requiredCapabilities: ['build'], reviewCapabilities: ['review'] });

    // --- the static shell ---
    const page = await fetch(runtime.base + '/employees');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const employeePage = await page.text();
    assert.match(employeePage, /公司平面图/);
    assert.match(employeePage, /id="room-focus"/);
    assert.match(employeePage, /class="fc-home-link" href="\/workspace">← 返回公司首页<\/a>/);
    assert.equal((await fetch(runtime.base + '/workspace')).status, 200);
    assert.equal((await fetch(runtime.base + '/employee-assets/ui-tokens.css')).status, 200);
    assert.equal((await fetch(runtime.base + '/employee-assets/icons.mjs')).status, 200);
    assert.equal((await fetch(runtime.base + '/employee-assets/server.mjs')).status, 404);
    assert.equal((await fetch(runtime.base + '/employees', { headers: { origin: 'https://evil.invalid' } })).status, 403);

    // --- no production manual scheduling route ---
    assert.equal((await fetch(runtime.base + '/employee-api/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(runtime.base + '/employee-api/snapshot?companyId=' + company.id)).status, 404);

    // --- AVAILABLE / DISABLED ---
    let workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.deepEqual(workforce.summary, { employees: 3, working: 0, available: 2, disabled: 1 });
    const byId = (id) => workforce.employees.find((card) => card.employeeId === id);
    assert.equal(byId(employee.id).availability, 'AVAILABLE');
    assert.equal(byId(disabled.id).availability, 'DISABLED');
    assert.equal(workforce.employees.length, workforce.summary.employees);
    assert.equal(workforce.summary.working, workforce.employees.filter((card) => card.availability === 'WORKING').length);

    // --- WORKING / EXECUTION ---
    await runtime.command('assignTask', { taskId: task.id, employeeId: employee.id, reason: 'lobby test' });
    const run = await runtime.command('startWorkerRun', { taskId: task.id });
    workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    const working = byId(employee.id);
    assert.equal(working.availability, 'WORKING');
    assert.equal(working.condition, null);
    assert.equal(working.currentWork.role, 'EXECUTION');
    assert.equal(working.currentWork.workId, work.id);

    const detail = await runtime.json(`/experience/employees/${employee.id}`);
    assert.equal(detail.availability, 'WORKING');
    assert.equal(detail.currentRole, 'EXECUTION');
    assert.equal(detail.currentWork.taskId, task.id);
    assert.ok(Array.isArray(detail.recentActivity));

    // --- a delivery with no review and no Founder decision ---
    const artifact = await runtime.command('recordArtifact', {
      taskId: task.id,
      generation: run.generation,
      workerRunId: run.workerRun.id,
      kind: 'document',
      title: 'Lobby output',
      content: 'private body never shown by the lobby',
    });
    const detailWithDelivery = await runtime.json(`/experience/employees/${employee.id}`);
    const delivery = detailWithDelivery.recentDeliveries.find((entry) => entry.artifactId === artifact.id);
    assert.equal(delivery.reviewState, null);
    assert.equal(delivery.acceptedState, 'NOT_ACCEPTED');
    assert.ok(!JSON.stringify(detailWithDelivery).includes('private body'));

    // --- WORKING / REVIEW ---
    const handoff = await runtime.command('requestReview', { taskId: task.id, generation: run.generation });
    await runtime.command('assignTask', { taskId: handoff.reviewTask.id, employeeId: reviewer.id, reason: 'lobby review' });
    const reviewRun = await runtime.command('startWorkerRun', { taskId: handoff.reviewTask.id });
    workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(byId(reviewer.id).availability, 'WORKING');
    assert.equal(byId(reviewer.id).currentWork.role, 'REVIEW');

    // --- WORKING / REPAIR after one revision cycle ---
    const revision = await runtime.command('submitReview', {
      reviewTaskId: handoff.reviewTask.id,
      generation: reviewRun.generation,
      verdict: 'REQUEST_REVISION',
      summary: 'The downside case is missing.',
      findings: ['Add the downside case.'],
    });
    const repair = await runtime.command('createRepairTask', { reviewId: revision.review.id });
    const repairRun = await runtime.command('startWorkerRun', { taskId: repair.task.id });
    workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(byId(employee.id).availability, 'WORKING');
    assert.equal(byId(employee.id).currentWork.role, 'REPAIR');

    // --- Work lineage is readable and structural ---
    const replacement = await runtime.command('recordArtifact', {
      taskId: repair.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.workerRun.id,
      supersedesArtifactId: artifact.id,
      kind: 'document',
      title: 'Lobby output v2',
      content: 'private body never shown by the lobby, part two',
    });
    const secondHandoff = await runtime.command('requestReview', { taskId: repair.task.id, generation: repairRun.generation });
    await runtime.command('assignTask', { taskId: secondHandoff.reviewTask.id, employeeId: reviewer.id, reason: 'lobby review' });
    const secondReviewRun = await runtime.command('startWorkerRun', { taskId: secondHandoff.reviewTask.id });
    await runtime.command('submitReview', {
      reviewTaskId: secondHandoff.reviewTask.id,
      generation: secondReviewRun.generation,
      verdict: 'PASS',
      summary: 'The recommendation now matches the evidence.',
      findings: [],
    });
    const lineage = await runtime.json(`/experience/works/${work.id}/lineage`);
    const roles = lineage.steps.map((step) => step.role);
    assert.ok(roles.includes('EXECUTION'));
    assert.ok(roles.includes('REVIEW'));
    assert.ok(roles.includes('REPAIR'));
    assert.equal(lineage.founderBoundary.waitingForFounder, true, 'a PASSed work waits for the Founder, not for itself');
    assert.equal(lineage.founderBoundary.decision, null);
    const repairs = lineage.steps.filter((step) => step.role === 'REPAIR');
    assert.equal(repairs[0].repair.targetArtifactId, artifact.id);
    assert.ok(!JSON.stringify(lineage).includes('private body'));

    // --- multiple active runs fail closed as a diagnostic ---
    const work2 = await runtime.command('createWork', { companyId: company.id, title: 'Second work', intent: 'second concurrent attempt' });
    const task2 = await runtime.command('createTask', { workId: work2.id, title: 'Second task', intent: 'second concurrent attempt', requiredCapabilities: ['build'] });
    await runtime.command('assignTask', { taskId: task2.id, employeeId: employee.id, reason: 'lobby concurrency test' });
    await runtime.command('startWorkerRun', { taskId: task2.id });
    const work3 = await runtime.command('createWork', { companyId: company.id, title: 'Third work', intent: 'third concurrent attempt' });
    const task3 = await runtime.command('createTask', { workId: work3.id, title: 'Third task', intent: 'third concurrent attempt', requiredCapabilities: ['build'] });
    await runtime.command('assignTask', { taskId: task3.id, employeeId: employee.id, reason: 'lobby concurrency test' });
    await runtime.command('startWorkerRun', { taskId: task3.id });
    workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(byId(employee.id).availability, 'WORKING');
    assert.equal(byId(employee.id).condition, 'MULTIPLE_ACTIVE_RUNS');
    assert.equal(byId(employee.id).currentWork, null);

    // --- Founder control seam and origin gate ---
    assert.equal((await fetch(runtime.base + '/commands', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify({ command: 'setEmployeeEnabled', input: { employeeId: disabled.id, enabled: true } }) })).status, 403);
    const enabled = await runtime.command('setEmployeeEnabled', { employeeId: disabled.id, enabled: true });
    assert.equal(enabled.enabled, true);
    workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(byId(disabled.id).availability, 'AVAILABLE');

    // --- transport health never rewrites Employee states ---
    assert.ok(!JSON.stringify(workforce).match(/OFFLINE|IDLE|DISCONNECTED|RUNNING|FAILED/));
  } finally {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
