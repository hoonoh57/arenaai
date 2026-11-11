import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBarFile} from './localBars';
import {evaluate} from '../shared/formula';
import {SAMPLE_0150} from '../shared/conditionCatalog';

test('로컬 CSV 봉을 읽고 0150형 조건을 평가한다', () => {
  const text = `time,open,high,low,close,volume
20260102090000,10000,12000,9000,11000,3000000
20260103090000,11000,13000,10000,12500,2500000
20260105090000,12500,14000,11000,13800,4000000`;
  const bars = parseBarFile(text);
  assert.equal(bars.length, 3);
  assert.equal(evaluate('HLRATE(3)', bars).at(-1)! > 20, true);
  assert.equal(evaluate('INRANGE(CLOSE, 1000, 500000)', bars).at(-1), 1);
  assert.equal(evaluate(SAMPLE_0150, bars).at(-1), 1);
});
