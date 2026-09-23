import test from 'node:test';
import assert from 'node:assert/strict';
import { HIRING_CONTRACT, readCompanyHiring, positionRoster, candidatePhase } from '../../apps/workspace/company-hiring-domain.mjs';

const companyId = 'company-a';
const collection = items => ({ state: 'ready', items });
const envelope = patch => ({ hiring: { contract: HIRING_CONTRACT, companyId, demand: collection([]), openings: collection([]), candidates: collection([]), history: collection([]), ...patch } });

test('missing hiring projection stays unknown while explicit ready empty is zero', () => {
  assert.equal(readCompanyHiring({}, companyId).candidates.state, 'unavailable');
  assert.deepEqual(readCompanyHiring(envelope({}), companyId).candidates, { state: 'ready', items: [], reason: null });
});

test('cross-company, duplicate and incomplete candidates fail closed without making employees', () => {
  const valid = { id: 'candidate-1', companyId, displayName: 'Luna', positionId: 'position-1' };
  assert.equal(readCompanyHiring(envelope({ candidates: collection([valid]) }), 'company-b').candidates.state, 'unavailable');
  assert.equal(readCompanyHiring(envelope({ candidates: collection([valid, valid]) }), companyId).candidates.state, 'unavailable');
  assert.equal(readCompanyHiring(envelope({ candidates: collection([{ ...valid, trial: { title: 'Trial without Work' } }]) }), companyId).candidates.state, 'unavailable');
});

test('positions do not become openings and unstaffed roles do not imply hiring demand', () => {
  const roles = positionRoster([{ id: 'position-1', companyId, title: 'Researcher', capabilities: ['research.web'] }], [], companyId);
  assert.equal(roles.length, 1);
  assert.deepEqual(roles[0].employees, []);
  assert.equal(readCompanyHiring({}, companyId).openings.state, 'unavailable');
});

test('trial PASS waits for explicit decision and a hired identity needs an employee link', () => {
  const candidate = { trial: { workId: 'work-1', review: { verdict: 'PASS' } }, decisionRequired: true };
  assert.equal(candidatePhase(candidate), 'NEEDS_YOU');
  assert.equal(candidatePhase({ ...candidate, founderDecision: { disposition: 'HIRE' } }), 'DECIDED');
  assert.equal(candidatePhase({ ...candidate, founderDecision: { disposition: 'HIRE' }, employeeId: 'employee-1' }), 'HIRED');
  assert.equal(candidatePhase({ trial: { workId: 'work-1' } }), 'TRIAL_LINKED');
  assert.equal(candidatePhase({ trial: { workId: 'work-1', state: 'RUNNING' } }), 'IN_TRIAL');
});
