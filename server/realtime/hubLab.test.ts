import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HUB_OP_TARGETS} from './hubOps';
import {isOfficialHubOp, LAB_CASES, runHubLab} from './hubLab';

test('테스트랩 목록이 허브 목표표와 1:1', () => {
  const ids = LAB_CASES.map((c) => c.id).sort();
  const ops = Object.keys(HUB_OP_TARGETS).sort();
  assert.deepEqual(ids, ops);
  for (const id of ops) assert.equal(isOfficialHubOp(id), true);
  assert.equal(isOfficialHubOp('not-a-fn'), false);
});

test('실허브 없으면 가짜 합격이 없다', async () => {
  const report = await runHubLab(null, 'all', {codes: 4, deadlineMs: 1000});
  assert.equal(report.results.length, LAB_CASES.length);
  assert.ok(report.results.every((r) => r.pass === false));
  assert.ok(report.results.every((r) => /가짜/.test(r.detail)));
});
