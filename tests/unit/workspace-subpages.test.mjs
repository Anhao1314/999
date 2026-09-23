import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBPAGES, filterWork, filterDeliveries } from '../../apps/workspace/subpages.mjs';

const work = (id, status, outcome, waiting = false, decision = null) => ({
  work: { id },
  lineage: { work: { status }, outcome: { state: outcome }, founderBoundary: { waitingForFounder: waiting, decision } },
});

test('shared shell defines all destinations and keeps hiring read only', () => {
  assert.deepEqual(Object.keys(SUBPAGES), ['work', 'artifacts', 'hiring', 'knowledge', 'settings']);
  assert.equal(SUBPAGES.work.source, 'LIVE');
  assert.equal(SUBPAGES.artifacts.source, 'LIVE');
  assert.equal(SUBPAGES.hiring.source, 'READ_ONLY');
  assert.equal(SUBPAGES.knowledge.source, 'READ_ONLY');
  for (const page of Object.values(SUBPAGES)) assert.ok(page.tabs.length > 0 && page.subtitle);
});

test('Work filters respect accepted, cancelled and Founder attention truth', () => {
  const works = [work('active', 'ACTIVE', 'NO_CANDIDATE'), work('needs', 'READY_FOR_DECISION', 'READY', true), work('accepted', 'READY_FOR_DECISION', 'ACCEPTED', false, { disposition: 'ACCEPTED' }), work('cancelled', 'CANCELLED', 'NO_CANDIDATE')];
  assert.deepEqual(filterWork(works, 'active').map((item) => item.work.id), ['active', 'needs']);
  assert.deepEqual(filterWork(works, 'needs').map((item) => item.work.id), ['needs']);
  assert.deepEqual(filterWork(works, 'completed').map((item) => item.work.id), ['accepted', 'cancelled']);
  assert.equal(filterWork(works, 'all').length, 4);
});

test('Delivery filters use review, acceptance and actual decision attention', () => {
  const deliveries = [
    { artifactId: 'a', workId: 'w', reviewState: 'PASS', acceptedState: 'NOT_ACCEPTED', decisionCandidate: true },
    { artifactId: 'b', workId: 'x', reviewState: 'PASS', acceptedState: 'ACCEPTED', decisionCandidate: false },
    { artifactId: 'c', workId: 'y', reviewState: null, acceptedState: 'NOT_ACCEPTED' },
  ];
  const attention = [{ kind: 'DECISION_REQUIRED', workId: 'w' }];
  assert.deepEqual(filterDeliveries(deliveries, 'needs', attention).map((item) => item.artifactId), ['a']);
  assert.deepEqual(filterDeliveries([{ ...deliveries[0], decisionCandidate: false }], 'needs', attention), []);
  assert.deepEqual(filterDeliveries(deliveries, 'reviewed', attention).map((item) => item.artifactId), ['a', 'b']);
  assert.deepEqual(filterDeliveries(deliveries, 'accepted', attention).map((item) => item.artifactId), ['b']);
  assert.equal(filterDeliveries(deliveries, 'all', attention).length, 3);
});
