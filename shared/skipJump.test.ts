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
    vsMa5: 0.002,
    prevRet: 0.002,
    maAlign: 1,
    ...over,
  };
}

test('5이평 아래·직전대비 음은 지연 불가', () => {
  const env = failEnvelope([f()]);
  const same = jumpVsFail(f({close: 100.2, high: 100.4, barRet: 0.003, vsMa5: -0.02, prevRet: -0.01}), env, 1.2);
  assert.equal(same.ok, false);
});

test('직전대비가 0이면 지연 불가', () => {
  const env = failEnvelope([f()]);
  const now = f({close: 104, high: 104.5, barRet: 0.02, volume: 400, strength: 160, turnover: 4e7, range: 2, vsMa5: 0.01, prevRet: 0, maAlign: 3, strengthAccel: 20});
  assert.equal(jumpVsFail(now, env, 1.2).ok, false);
});

test('실패 고점·거래량·강도·정배열·직전대비·5이격을 넘으면 지연', () => {
  const env = failEnvelope([f(), f({volume: 120, strength: 90})]);
  const now = f({
    close: 104,
    high: 104.5,
    barRet: 0.02,
    volume: 400,
    strength: 160,
    turnover: 4e7,
    range: 2,
    vsMa5: 0.01,
    prevRet: 0.01,
    maAlign: 3,
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
