import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpWorkspaceAdapter } from '../../apps/workspace/adapter.mjs';
import { startRuntime } from '../../scripts/lib/runtime-process.mjs';
import { tempStoreDir } from '../support/kernel.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Runtime did not finish Founder Work in time');
}

test('Workspace product adapter creates one real Work and reads its reviewed Artifact', async () => {
  const dir = tempStoreDir();
  let runtime;
  try {
    runtime = await startRuntime({
      dir, coordination: true, workerBackend: 'test-worker',
      extraEnv: { FLOWCREDIT_PRODUCT_REPO: repository },
    });
    const adapter = new HttpWorkspaceAdapter({
      fetcher: (path, options) => fetch(`${runtime.base}${path}`, {
        ...options, headers: { ...options?.headers, origin: runtime.base },
      }),
    });
    const contextResponse = await fetch(`${runtime.base}/product/execution-context`, {
      headers: { origin: runtime.base },
    });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.available, true);
    const company = await runtime.command('createCompany', { name: 'Workspace Integration Proof' });
    await runtime.command('bootstrapWorkforce', {
      companyId: company.id,
      positions: [
        { id: 'workspace_operator_position', title: 'Operator', capabilities: ['work.execute'] },
        { id: 'workspace_reviewer_position', title: 'Reviewer', capabilities: ['work.review'] },
      ],
      employees: [
        { id: 'workspace_operator', positionId: 'workspace_operator_position', displayName: 'Operator', enabled: true },
        { id: 'workspace_reviewer', positionId: 'workspace_reviewer_position', displayName: 'Reviewer', enabled: true },
      ],
    });

    const input = {
      requestId: 'workspace_founder_request_1', companyId: company.id,
      title: 'Prepare a concise brief', intent: 'Summarize the project in one page',
      contextId: context.contextId,
    };
    const createFounderWork = async () => {
      const response = await fetch(`${runtime.base}/product/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: runtime.base },
        body: JSON.stringify({ command: 'CreateFounderWork', input }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const first = await createFounderWork();
    assert.equal(first.replayed, false);
    assert.equal((await createFounderWork()).replayed, true);

    const lineage = await until(async () => {
      const current = await adapter.lineage(first.work.id);
      return current.work.status === 'READY_FOR_DECISION' ? current : null;
    });
    assert.equal(lineage.founderBoundary.waitingForFounder, true);
    assert.equal(lineage.founderBoundary.decision, null);
    assert.ok(lineage.steps.some((step) => step.role === 'REVIEW'));
    assert.equal((await adapter.works(company.id)).filter((work) => work.id === first.work.id).length, 1);
    const projection = (await adapter.snapshot(company.id)).projection;
    assert.equal(projection.primaryWork.lineage.work.workId, first.work.id);
    assert.equal(projection.recentDeliveries.length, 1);
    assert.equal(projection.recentDeliveries[0].reviewState, 'PASS');
    assert.equal(projection.recentDeliveries[0].acceptedState, 'NOT_ACCEPTED');
    const status = await runtime.json('/status');
    assert.equal(status.counts.works, 1);
    assert.equal(status.counts.workerRuns, 2);
    assert.equal(status.counts.reviews, 1);
    assert.equal(status.counts.artifacts, 1);
  } finally {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
