import assert from 'node:assert/strict';
import test from 'node:test';
import {parseProviderMode, PROVIDER_SPECS} from './marketProvider';

test('기본은 키움 세 레인', () => {
  assert.deepEqual(parseProviderMode({}), {trade: 'kiwoom', bulk: 'kiwoom', quote: 'kiwoom'});
});

test('bulk만 cybos로 바꿔도 주문은 키움', () => {
  const m = parseProviderMode({MARKET_BULK_PROVIDER: 'cybos'});
  assert.equal(m.trade, 'kiwoom');
  assert.equal(m.bulk, 'cybos');
});

test('표준 한도는 최대를 넘지 않는다', () => {
  for (const s of Object.values(PROVIDER_SPECS)) {
    assert.ok(s.standard.concurrency <= s.max.concurrency);
    assert.ok(s.standard.burst <= s.max.burst);
    assert.ok(s.standard.subscribe <= s.max.subscribe);
    assert.ok(s.standard.codesPerCall <= s.max.codesPerCall);
  }
});
