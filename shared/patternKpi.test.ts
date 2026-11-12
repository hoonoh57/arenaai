import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kpiScore, signedReturn, summarizeByFilter} from './patternKpi';

test('매수는 상승이 +, 매도는 하락이 +', () => {
  assert.equal(signedReturn('buy', 100, 110), 0.1);
  assert.equal(signedReturn('sell', 100, 90), 0.1);
  assert.equal(signedReturn('sell', 100, 110), -0.1);
});

test('표본이 쌓이면 평균 등락으로 점수를 낸다', () => {
  const s = kpiScore([0.02, 0.02, 0.02, 0.02, 0.02]);
  assert.equal(s.ready, true);
  assert.equal(s.score, 60);
  const by = summarizeByFilter([
    {code: '000001', side: 'buy', filters: ['delayed-buy'], entryTime: 1, entryClose: 100, exitTime: 2, exitClose: 110, signedPct: 0.1},
    {code: '000001', side: 'buy', filters: ['delayed-buy'], entryTime: 3, entryClose: 100, exitTime: 4, exitClose: 90, signedPct: -0.1},
  ]);
  assert.equal(by[0].filterId, 'delayed-buy');
  assert.equal(by[0].n, 2);
  assert.equal(by[0].avgPct, 0);
});
