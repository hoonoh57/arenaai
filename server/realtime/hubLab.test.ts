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

test('전체 랩 실행·저장', async () => {
  const report = await runHubLab(null, 'all');
  assert.equal(report.results.length, LAB_CASES.length);
  assert.equal(report.missingOfficial.length, 0);
  const fail = report.results.filter((r) => !r.ok);
  assert.deepEqual(fail.map((r) => r.id), [], fail.map((r) => `${r.id}:${r.detail}`).join('; '));
  const dup = report.results.find((r) => r.id === 'orderDuplicate');
  assert.ok(dup && dup.constraints >= 1, '중복주문은 제약으로 잡혀야 함');
  const over = report.results.find((r) => r.id === 'orderOverLimit');
  assert.ok(over && over.constraints >= 1, '한도초과 주문은 제약으로 잡혀야 함');
});
