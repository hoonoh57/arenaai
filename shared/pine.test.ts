import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertPine} from './pine';
import {validateFormula} from './formula';

test('파인 SMA 플롯을 키움 SMA 지표로 옮긴다', () => {
  const src = `
//@version=5
indicator("My SMA", overlay=true)
len = input.int(20, "길이")
plot(ta.sma(close, len), title="MA")
`;
  const {formula, notes} = convertPine(src);
  assert.equal(formula.kind, 'indicator');
  assert.equal(formula.name, 'My SMA');
  assert.match(formula.expression, /PLOT\(SMA\(CLOSE/);
  assert.equal(formula.variables?.len, 20);
  validateFormula({id: 't', ...formula, enabled: false, color: '#a8ec6a', exitExpression: formula.exitExpression || ''});
  assert.ok(notes.length >= 1);
});

test('strategy.entry는 시스템 수식으로 분류한다', () => {
  const src = `
strategy("X")
if ta.crossover(ta.sma(close,5), ta.sma(close,20))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close,5), ta.sma(close,20))
    strategy.close("L")
`;
  const {formula} = convertPine(src);
  assert.equal(formula.kind, 'system');
  assert.match(formula.expression, /CROSSUP/);
  assert.match(formula.exitExpression, /CROSSDOWN/);
});
