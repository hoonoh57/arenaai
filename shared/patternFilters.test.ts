import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterOn, filtersFromFormulas, normalizeFilterEnabled, skip001Threshold} from './patternFilters';
import {judgePattern} from './patternGate';
import type {Candle} from '../server/core';

const t0 = Date.parse('2026-11-12T00:00:00+09:00') / 1000;
function bars(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({length: n}, (_, i) => {
    const close = closeAt(i);
    return {time: t0 + 8 * 3600 + i * 60, open: close, high: close * 1.002, low: close * 0.998, close};
  });
}

test('필터 끄면 급등후횡보 금지가 풀린다', () => {
  const c = bars(80, (i) => {
    if (i < 20) return 100 + i * 1.2;
    if (i < 40) return 124 - (i - 20) * 0.6;
    return 112 + Math.sin(i) * 0.4;
  });
  assert.equal(judgePattern(c).allow, false);
  const off = normalizeFilterEnabled({['skip-chop']: false});
  assert.equal(filterOn(off, 'skip-chop'), false);
  assert.equal(judgePattern(c, c.length - 1, off).tag === '급등후횡보', false);
});

test('수식관리자에서 끈 건너뜀은 차트 필터에도 꺼진다', () => {
  const f = filtersFromFormulas([{id: 'skip001', enabled: false}, {id: 'delayed-buy', enabled: true}]);
  assert.equal(f.skip001, false);
  assert.equal(f['delayed-buy'], true);
});

test('skip001 배수 N을 올리면 지연 진입 문턱이 높아진다', () => {
  assert.equal(skip001Threshold(50, 1.2), 60);
  assert.ok(skip001Threshold(50, 2) > skip001Threshold(50, 1.2));
});
