import test from 'node:test';
import assert from 'node:assert/strict';
import { companyStageModel } from '../../apps/workspace/company-stage.mjs';

test('the stage groups only observed tasks and artifact handoffs', () => {
  const model = companyStageModel({
    graph: {
      nodes: [
        { taskId: 'nova', title: 'Research', role: 'EXECUTION', state: 'COMPLETED', employeeName: 'Nova', artifactIds: ['a'] },
        { taskId: 'echo', title: 'Insights', role: 'EXECUTION', state: 'INTERRUPTED', employeeName: 'Echo', artifactIds: [] },
        { taskId: 'mira', title: 'Brief', role: 'EXECUTION', state: 'OPEN', barrier: { required: 2, fulfilled: 1, ready: false }, artifactIds: [] },
      ],
      dependencies: [{ fromTaskId: 'nova', toTaskId: 'mira' }, { fromTaskId: 'echo', toTaskId: 'mira' }],
    },
    artifacts: [{ artifactId: 'a', title: 'Product research' }],
    founderBoundary: { waitingForFounder: false },
  });
  assert.deepEqual(model.contributors.map((task) => task.taskId), ['nova', 'echo']);
  assert.deepEqual(model.handoffs.map((task) => task.taskId), ['mira']);
  assert.equal(model.handoffs[0].inputs, 2);
  assert.equal(model.contributors[0].artifacts[0].title, 'Product research');
  assert.equal(model.contributors[1].artifacts.length, 0);
  assert.equal(model.reviews.length, 0);
  assert.equal(model.moment.kind, 'WAITING');
  assert.match(model.moment.text, /1\/2/);
});

test('a running WorkerRun alone receives a live activity claim', () => {
  const model = companyStageModel({
    graph: { nodes: [{ taskId: 'one', role: 'EXECUTION', title: 'Review sources', employeeName: 'Nova', workerRunState: 'RUNNING' }], dependencies: [] },
    artifacts: [],
  });
  assert.equal(model.moment.kind, 'RUNNING');
  assert.match(model.moment.text, /Nova正在处理/);
  assert.equal(model.deliveredCount, 0);
});

test('empty projections stay empty and never invent employees or evolution', () => {
  const model = companyStageModel(null);
  assert.equal(model.contributors.length, 0);
  assert.equal(model.handoffs.length, 0);
  assert.equal(model.deliveredCount, 0);
  assert.equal(model.moment.kind, 'QUIET');
  assert.equal(model.founderWaiting, false);
});
