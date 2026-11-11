import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignStrengthToCandles, carryStrength, fillStrengthOnCandles, correctSmallLotStrength, parseStrengthTicks, strengthPageBudget} from './strength';

test('소량 연속 매수 체결강도는 50으로 보정한다', () => {
  const ticks = [
    {time: 1, qty: 100, strength: 80},
    {time: 2, qty: 3, strength: 420},
    {time: 3, qty: 5, strength: 800},
    {time: 4, qty: 2, strength: 990},
    {time: 5, qty: 200, strength: 110},
  ];
  const out = correctSmallLotStrength(ticks);
  assert.equal(out[0].strength, 80);
  assert.equal(out[1].strength, 50);
  assert.equal(out[2].strength, 50);
  assert.equal(out[3].strength, 50);
  assert.equal(out[4].strength, 110);
});

test('소량 한 틱이어도 이상치 강도는 50', () => {
  assert.equal(correctSmallLotStrength([{time: 1, qty: 1, strength: 999}])[0].strength, 50);
  assert.equal(correctSmallLotStrength([{time: 1, qty: 8, strength: 5}])[0].strength, 50);
  assert.equal(correctSmallLotStrength([{time: 1, qty: 50, strength: 999}])[0].strength, 999);
});

test('체결강도 틱을 분봉 시각에 맞춘다', () => {
  const bars: {time: number; open: number; high: number; low: number; close: number; strength?: number}[] = [
    {time: 100, open: 1, high: 1, low: 1, close: 1},
    {time: 160, open: 1, high: 1, low: 1, close: 1},
    {time: 220, open: 1, high: 1, low: 1, close: 1},
  ];
  const ticks = [
    {time: 90, qty: 10, strength: 70},
    {time: 100, qty: 10, strength: 81},
    {time: 150, qty: 10, strength: 90},
    {time: 160, qty: 10, strength: 95},
  ];
  const aligned = alignStrengthToCandles(bars, ticks, '1');
  assert.equal(aligned[0].strength, 81);
  assert.equal(aligned[1].strength, 95);
  assert.equal(aligned[2].strength, undefined);
});

test('0 체결강도는 직전 값을 이어받는다', () => {
  assert.deepEqual(carryStrength([80, 0, null, 90, 0]), [80, 80, 80, 90, 90]);
  assert.deepEqual(carryStrength([0, 0, 70]), [null, null, 70]);
});

test('체결강도를 전 봉에 이어 그린다', () => {
  const bars: {time: number; open: number; high: number; low: number; close: number; strength?: number}[] = [
    {time: 100, open: 1, high: 1, low: 1, close: 1},
    {time: 160, open: 1, high: 1, low: 1, close: 1},
    {time: 220, open: 1, high: 1, low: 1, close: 1},
  ];
  const filled = fillStrengthOnCandles(bars, [{time: 160, qty: 20, strength: 88}], '1');
  assert.deepEqual(filled.map((c) => c.strength), [88, 88, 88]);
});

test('페이지 수는 차트 봉 수에 비례하고 최대 16', () => {
  assert.equal(strengthPageBudget(10), 1);
  assert.equal(strengthPageBudget(200), 10);
  assert.equal(strengthPageBudget(900), 16);
});

test('6자리 체결시각은 힌트 날짜의 KST로 붙인다', () => {
  const hint = Date.parse('2026-01-15T06:00:00Z') / 1000;
  const ticks = parseStrengthTicks([{cntr_tm: '150000', trde_qty: '+3', cntr_str: '120.5'}], hint);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].qty, 3);
  assert.equal(ticks[0].strength, 120.5);
  assert.equal(new Date(ticks[0].time * 1000).toISOString(), '2026-01-15T06:00:00.000Z');
});
