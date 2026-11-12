import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractMaLegs, maRegime} from './maRoundTrip';
import type {Candle} from '../server/core';

function c(t: number, px: number): Candle {
  return {time: t, open: px, high: px * 1.01, low: px * 0.99, close: px};
}

test('이평 매수→매도 왕복 손익과 고저폭을 남긴다', () => {
  const candles = [c(1, 100), c(2, 101), c(3, 99), c(4, 98)];
  const legs = extractMaLegs('000001', candles, [true, false, false, false], [false, false, false, true]);
  assert.equal(legs.length, 1);
  assert.ok(legs[0].signedPct < 0);
});

test('최근 왕복이 전부 손실이면 레짐 점수가 50 미만', () => {
  const legs = Array.from({length: 6}, (_, i) => ({
    code: '000001',
    entryTime: i,
    entryClose: 100,
    exitTime: i + 1,
    exitClose: 99,
    signedPct: -0.01,
    rangePct: 0.012,
    bars: 3,
  }));
  const r = maRegime(legs);
  assert.equal(r.ready, true);
  assert.ok(r.avgPct < 0);
  assert.ok(r.score < 50);
});
