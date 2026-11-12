import {test} from 'node:test';
import assert from 'node:assert/strict';
import {judgePattern, sessionSlice} from './patternGate';
import type {Candle} from '../server/core';

const t0 = Date.parse('2026-11-12T00:00:00+09:00') / 1000;

function bars(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({length: n}, (_, i) => {
    const close = closeAt(i);
    const open = close * (i % 2 ? 0.999 : 1.001);
    return {time: t0 + 8 * 3600 + i * 60, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close};
  });
}

test('당일은 08시 이후 봉만 본다', () => {
  const extra: Candle = {time: t0 + 7 * 3600, open: 1, high: 1, low: 1, close: 1};
  const s = bars(10, () => 100);
  assert.equal(sessionSlice([extra, ...s], s.length).length, 10);
});

test('급등 후 내리막 횡보는 진입 금지', () => {
  const c = bars(80, (i) => {
    if (i < 20) return 100 + i * 1.2;
    if (i < 40) return 124 - (i - 20) * 0.6;
    return 112 + Math.sin(i) * 0.4;
  });
  const v = judgePattern(c);
  assert.equal(v.allow, false);
  assert.ok(v.tag.includes('횡보') || v.reasons.some((r) => r.includes('급등')));
});

test('긴 횡보 뒤 양봉 돌파는 가점', () => {
  const c = bars(50, (i) => (i < 44 ? 100 + Math.sin(i) * 0.15 : 101 + (i - 44) * 1.2));
  for (const b of c.slice(-3)) {
    b.open = b.close * 0.992;
    b.low = b.open;
    b.high = b.close;
  }
  const v = judgePattern(c);
  assert.ok(v.score >= 65, String(v.score + v.reasons.join(',')));
  assert.equal(v.allow, true);
});
