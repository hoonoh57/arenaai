import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSubscriptions} from './plan';

test('선택 종목이 먼저 오고 구독 상한을 넘지 않는다', () => {
  const plan = planSubscriptions({
    selected: ['005930', '000660'],
    captured: ['005930', '000660', '035420', '051910'],
    maxSubscriptions: 3,
    budget: 5,
  });
  assert.deepEqual(plan.watch, ['005930', '000660', '035420']);
  assert.equal(plan.skipped, 1);
});

test('예산을 넘는 포착 종목은 로테이션으로 순환한다', () => {
  const captured = ['000001', '000002', '000003', '000004', '000005'];
  let cursor = 0;
  const seen = new Set<string>();
  for (let round = 0; round < 3; round += 1) {
    const plan = planSubscriptions({selected: ['005930'], captured, maxSubscriptions: 10, budget: 2, cursor});
    cursor = plan.cursor;
    for (const code of plan.watch.filter((code) => code !== '005930')) seen.add(code);
    assert.equal(plan.watch[0], '005930', '선택 종목은 항상 포함');
    assert.equal(plan.watch.length, 3);
  }
  assert.deepEqual([...seen].sort(), ['000001', '000002', '000003', '000004', '000005'], '모든 포착 종목이 한 번은 구독된다');
});

test('중복·비주식 코드는 걸러지고 건너뛴 수가 보고된다', () => {
  const plan = planSubscriptions({
    selected: ['005930', '005930', 'ETF001', 'A005930'],
    captured: ['005930', '000660', '000660', 'ELW123'],
    maxSubscriptions: 2,
    budget: 2,
  });
  assert.deepEqual(plan.watch, ['005930', '000660']);
  assert.deepEqual(plan.skipped, 0);
});

test('예산이 0이면 선택 종목만 구독하고 나머지는 건너뛴 것으로 보고', () => {
  const plan = planSubscriptions({selected: ['005930'], captured: ['000660', '035420'], maxSubscriptions: 10, budget: 0});
  assert.deepEqual(plan.watch, ['005930']);
  assert.equal(plan.skipped, 2);
});

test('잘못된 상한/예산은 거부하고 커서는 범위를 벗어나도 안전하다', () => {
  assert.throws(() => planSubscriptions({selected: [], captured: [], maxSubscriptions: 0, budget: 1}));
  assert.throws(() => planSubscriptions({selected: [], captured: [], maxSubscriptions: 1, budget: -1}));
  const plan = planSubscriptions({selected: [], captured: ['000001', '000002'], maxSubscriptions: 1, budget: 1, cursor: 999});
  assert.equal(plan.watch.length, 1);
  assert.ok(['000001', '000002'].includes(plan.watch[0]));
  assert.ok(plan.cursor === 0 || plan.cursor === 1);
});
