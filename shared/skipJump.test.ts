import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveJumpNeed, delayHardGates, failEnvelope, jumpVsFail, skipFeat, type SkipFeat} from './skipJump';

function f(over: Partial<SkipFeat> = {}): SkipFeat {
  return {
    close: 100,
    high: 100.3,
    low: 99.7,
    range: 0.6,
    barRet: 0.002,
    volume: 100,
    strength: 80,
    strengthAccel: 0,
    turnover: 1e7,
    vsMa120: -0.01,
    vsMa5: 0.002,
    prevRet: 0.002,
    ma120Slope: 0,
    maAlign: 1,
    slopeReady: true,
    ...over,
  };
}

test('120이평 아래·실패봉과 같은 양봉은 지연 불가', () => {
  const env = failEnvelope([f()]);
  const same = jumpVsFail(f({close: 100.2, high: 100.4, barRet: 0.003, vsMa120: -0.02, ma120Slope: 0.0001}), env, 1.2);
  assert.equal(same.ok, false);
  assert.equal(same.belowMa120, true);
});

test('120이평 기울기가 음이면 지연 불가', () => {
  const env = failEnvelope([f({vsMa120: 0.01})]);
  const now = f({close: 104, high: 104.5, barRet: 0.02, volume: 400, strength: 160, turnover: 4e7, range: 2, vsMa120: 0.01, ma120Slope: -0.0002, maAlign: 4, strengthAccel: 20});
  assert.equal(jumpVsFail(now, env, 1.2).ok, false);
});

test('실패 고점·거래량·강도·정배열·양의 120기울기를 넘으면 지연', () => {
  const env = failEnvelope([f(), f({volume: 120, strength: 90, vsMa120: 0})]);
  const now = f({
    close: 104,
    high: 104.5,
    barRet: 0.02,
    volume: 400,
    strength: 160,
    turnover: 4e7,
    range: 2,
    vsMa120: 0.01,
    ma120Slope: 0.0004,
    maAlign: 4,
    strengthAccel: 25,
  });
  const j = jumpVsFail(now, env, 1.2);
  assert.equal(j.ok, true);
  assert.ok(j.beats >= 2);
});

test('음봉·강도알파 미달은 하드게이트에서 막힌다', () => {
  const t0 = 1_700_000_000;
  const c = Array.from({length: 130}, (_, i) => ({
    time: t0 + i * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100.2 + i * 0.02,
    volume: 100,
    strength: 80 + i * 0.1,
  }));
  const red = c.length - 1;
  c[red].open = 110;
  c[red].close = 108;
  assert.equal(delayHardGates(c, red).ok, false);
  c[red].open = 108;
  c[red].close = 110;
  c[red].strength = 50;
  c[red - 1].strength = 90;
  assert.equal(delayHardGates(c, red).ok, false);
});

test('손실 지연의 jump가 크면 다음 문턱이 올라간다', () => {
  assert.ok(adaptiveJumpNeed([2, 2.2, 1.8], 1) > adaptiveJumpNeed([], 1));
});
