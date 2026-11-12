import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChartGate} from './chartGate';

test('동일 키는 REST를 한 번만 돌린다', async () => {
  const gate = new ChartGate(60_000);
  let n = 0;
  const load = () => {
    n += 1;
    return Promise.resolve({page: n});
  };
  const [a, b] = await Promise.all([gate.load('k', load), gate.load('k', load)]);
  assert.equal(n, 1);
  assert.equal(a.page, 1);
  assert.equal(b.page, 1);
  const c = await gate.load('k', load);
  assert.equal(n, 1);
  assert.equal(c.page, 1);
});
