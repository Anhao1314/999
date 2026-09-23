import test from 'node:test';
import assert from 'node:assert/strict';
import { workIntentText } from '../../apps/workspace/domain.mjs';
test('structured research shows only business fields and preserves ordinary intent', () => {
 const intent=JSON.stringify({requestKind:'MarketEntryResearch.v0',market:'US',category:'automatic pet feeder',candidateCount:1,requestId:'internal-identifier',webReadApproved:true});
 assert.equal(workIntentText(intent),'目标市场：US · 研究品类：automatic pet feeder · 1 个候选产品');
 assert.equal(workIntentText('  让发布信息能被一句话讲清楚。 '),'让发布信息能被一句话讲清楚。');
 assert.equal(workIntentText(null),'');
});
test('unknown structured requests do not invent a business goal or display internal fields', () => {
 assert.equal(workIntentText('{"requestKind":"Future.v1","requestId":"internal"}'),'已记录结构化工作目标；任务与交付详情可在工作线中查看。');
});
