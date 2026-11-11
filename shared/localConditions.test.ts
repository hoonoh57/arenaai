import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileCombo, nextLetter, SAMPLE_SAVED} from './localConditions';

test('알파벳 조건을 결합식으로 전개한다', () => {
  const expr = compileCombo(SAMPLE_SAVED.rows, SAMPLE_SAVED.combo);
  assert.match(expr, /HLRATE\(10\)/);
  assert.match(expr, /NEARHIGH/);
  assert.equal(nextLetter(SAMPLE_SAVED.rows), 'J');
});
