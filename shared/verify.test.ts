import {test} from 'node:test';
import assert from 'node:assert/strict';
import {barReturn, classifyMove, holdEndDate, maxReturnFrom, parseSearchAt, returnAfterMinutes, summarizeVerify} from './verify';

test('검색시점 KST와 보유 종료일', () => {
  assert.equal(parseSearchAt('2026-11-09', '09:10'), Date.parse('2026-11-09T09:10:00+09:00') / 1000);
  assert.equal(holdEndDate('2026-01-10', 20), '2026-01-30');
});

test('분 단위 수익률·최고수익·보합 분류', () => {
  const times = [100, 160, 220, 400];
  const closes = [100, 102, 110, 105];
  assert.equal(returnAfterMinutes(closes, times, 0, 1), 2);
  assert.equal(maxReturnFrom(closes, 0, 3), 10);
  assert.equal(classifyMove(0.01), 'flat');
  assert.equal(barReturn(100, 110), 10);
});

test('성과요약은 상승·보합·하락을 나눈다', () => {
  const s = summarizeVerify([
    {code: '1', name: 'a', matched: true, searchPrice: 100, endPrice: 110, returnPct: 10, maxReturnPct: 12, returns: {}},
    {code: '2', name: 'b', matched: true, searchPrice: 100, endPrice: 90, returnPct: -10, maxReturnPct: 0, returns: {}},
    {code: '3', name: 'c', matched: true, searchPrice: 100, endPrice: 100, returnPct: 0, maxReturnPct: 0, returns: {}},
    {code: '4', name: 'd', matched: false, searchPrice: 100, endPrice: 120, returnPct: null, maxReturnPct: null, returns: {}},
  ]);
  assert.equal(s.matched, 3);
  assert.equal(s.upCount, 1);
  assert.equal(s.downCount, 1);
  assert.equal(s.flatCount, 1);
});
