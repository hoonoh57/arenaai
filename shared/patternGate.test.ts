import {test} from 'node:test';
import assert from 'node:assert/strict';
import {delayedEntry, judgePattern, sessionSlice} from './patternGate';
import type {Candle} from '../server/core';

const t0 = Date.parse('2026-11-12T00:00:00+09:00') / 1000;

function bars(n: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({length: n}, (_, i) => {
    const close = closeAt(i);
    const open = close * (i % 2 ? 0.999 : 1.001);
    return {time: t0 + 8 * 3600 + i * 60, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close};
  });
}

test('당일 봉이 짧으면 이전 구간을 거슬러 보고 표본부족으로 막지 않는다', () => {
  const y = bars(20, () => 100).map((b) => ({...b, time: b.time - 86400}));
  const today = bars(3, () => 101);
  const c = [...y, ...today];
  assert.notEqual(judgePattern(c, c.length - 1).tag, '표본부족');
});

test('시가 대비 1.09 부근이면 VI근접 건너뜀', () => {
  const c = bars(20, (i) => 100 + i * 0.01);
  c[0].open = 100;
  const last = c[c.length - 1];
  last.open = 100;
  last.close = 109;
  last.high = 109.2;
  assert.equal(judgePattern(c).tag, 'VI근접');
});

test('지수 폭락·120이평 하락이면 건너뜀', () => {
  const c = bars(20, () => 100);
  assert.equal(judgePattern(c, 19, undefined, {indexRet: -0.03}).tag, '지수급변');
  assert.equal(judgePattern(c, 19, undefined, {ma120Slope: -0.001}).tag, '지수하락추세');
});

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

test('건너뜀 뒤 거래량·봉 급증이면 이평 없이 지연 진입', () => {
  const c = bars(40, (i) => 100 + Math.sin(i) * 0.12);
  for (const b of c) b.volume = 100;
  const last = c[c.length - 1];
  last.open = 100;
  last.close = 103;
  last.high = 103.4;
  last.low = 99.8;
  last.volume = 400;
  last.strength = 180;
  for (const b of c.slice(0, -1)) b.strength = 90;
  const sig = (i: number) => i === 20;
  assert.equal(judgePattern(c, 20).allow, false);
  const late = delayedEntry(c, c.length - 1, sig);
  assert.equal(late?.allow, true);
  assert.equal(late?.delayed, true);
});

test('건너뜀 바로 다음 봉이 종가·고저 상향이면 즉시 매수', () => {
  const c = bars(22, () => 100);
  c[20].high = 100.2;
  c[20].low = 99.8;
  c[20].close = 100;
  c[21].open = 100.05;
  c[21].low = 100;
  c[21].high = 100.6;
  c[21].close = 100.5;
  const late = delayedEntry(c, 21, (i) => i === 20);
  assert.equal(late?.allow, true);
});

test('건너뜀 뒤 같은 봉에 이평이 다시 나와도 양봉 급등이면 확인 매수', () => {
  const c = bars(40, (i) => 100 + Math.sin(i) * 0.12);
  for (const b of c) b.volume = 100;
  const last = c[c.length - 1];
  last.open = 100;
  last.close = 103;
  last.high = 103.4;
  last.low = 99.8;
  last.volume = 400;
  const sig = (i: number) => i === 20 || i === c.length - 1;
  const late = delayedEntry(c, c.length - 1, sig);
  assert.equal(late?.allow, true);
  assert.equal(late?.tag, '확인매수');
});
