import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveJumpNeed, failEnvelope, jumpVsFail, skipFeat, type SkipFeat} from './skipJump';

function f(over: Partial<SkipFeat> = {}): SkipFeat {
  return {close: 100, high: 100.3, low: 99.7, range: 0.6, barRet: 0.002, volume: 100, strength: 80, turnover: 1e7, vsMa120: -0.01, ...over};
}

test('120이평 아래·실패봉과 같은 양봉은 지연 불가', () => {
  const env = failEnvelope([f()]);
  const same = jumpVsFail(f({close: 100.2, high: 100.4, barRet: 0.003, vsMa120: -0.02}), env, 1.2);
  assert.equal(same.ok, false);
  assert.equal(same.belowMa120, true);
});

test('실패 고점·거래량·강도를 한꺼번에 넘으면 지연', () => {
  const env = failEnvelope([f(), f({volume: 120, strength: 90})]);
  const now = f({close: 104, high: 104.5, barRet: 0.02, volume: 400, strength: 160, turnover: 4e7, range: 2, vsMa120: 0.01});
  const j = jumpVsFail(now, env, 1.2);
  assert.equal(j.ok, true);
  assert.ok(j.beats >= 2);
});

test('손실 지연의 jump가 크면 다음 문턱이 올라간다', () => {
  assert.ok(adaptiveJumpNeed([2, 2.2, 1.8], 1) > adaptiveJumpNeed([], 1));
});
