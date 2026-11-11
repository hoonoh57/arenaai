import {test} from 'node:test';
import assert from 'node:assert/strict';
import {barReturn, holdEndDate, summarizeVerify} from './verify';

test('수익률기간만큼 종료일을 더한다', () => {
  assert.equal(holdEndDate('2026-01-10', 20), '2026-01-30');
  assert.throws(() => holdEndDate('2026-13-01', 1));
});

test('성과요약은 포착 종목의 평균·상승비율이다', () => {
  const s = summarizeVerify([
    {code: '1', name: 'a', matched: true, searchPrice: 100, endPrice: 110, returnPct: 10},
    {code: '2', name: 'b', matched: true, searchPrice: 100, endPrice: 90, returnPct: -10},
    {code: '3', name: 'c', matched: false, searchPrice: 100, endPrice: 120, returnPct: null},
  ]);
  assert.equal(s.matched, 2);
  assert.equal(s.upCount, 1);
  assert.equal(s.upRatio, 50);
  assert.equal(s.avgReturn, 0);
  assert.equal(barReturn(100, 110), 10);
});
