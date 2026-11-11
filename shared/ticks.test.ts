import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateTickBars, parseTickTimeframe} from './ticks';

test('틱 주기는 네이티브와 30배수만 받는다', () => {
  assert.deepEqual(parseTickTimeframe('T30'), {native: '30', group: 1, ticks: 30});
  assert.deepEqual(parseTickTimeframe('T60'), {native: '30', group: 2, ticks: 60});
  assert.deepEqual(parseTickTimeframe('T720'), {native: '30', group: 24, ticks: 720});
  assert.deepEqual(parseTickTimeframe('T90'), {native: '30', group: 3, ticks: 90});
  assert.equal(parseTickTimeframe('T7'), null);
  assert.equal(parseTickTimeframe('60'), null);
});

test('30틱을 묶어 60틱 OHLC를 만든다', () => {
  const bars = Array.from({length: 5}, (_, i) => ({
    time: i + 1,
    open: 10 + i,
    high: 20 + i,
    low: 5 + i,
    close: 12 + i,
    volume: 10,
  }));
  const out = aggregateTickBars(bars, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, 3);
  assert.equal(out[0].open, 11);
  assert.equal(out[0].close, 14);
  assert.equal(out[0].high, 22);
  assert.equal(out[0].low, 6);
  assert.equal(out[0].volume, 20);
  assert.equal(out[1].time, 5);
});
