import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CandleRing, KeyedDedup, RingBuffer, SignalDedup} from './ring';

test('링버퍼는 용량을 넘으면 가장 오래된 값을 버리고 보고', () => {
  const ring = new RingBuffer<number>(3);
  for (const value of [1, 2, 3, 4, 5]) ring.push(value);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  assert.equal(ring.size, 3);
  assert.equal(ring.droppedCount, 2);
  assert.equal(ring.last(), 5);
  assert.throws(() => new RingBuffer<number>(0));
});

test('캔들 링은 시간순 정렬·중복 제거·용량 제한을 지킨다', () => {
  const ring = new CandleRing(3);
  const candle = (time: number, close: number) => ({time, open: close, high: close, low: close, close});
  ring.merge([candle(180, 3), candle(60, 1)]);
  assert.deepEqual(ring.toArray().map((c) => c.time), [60, 180]);
  // 같은 봉 시각은 나중 값으로 대체되고 중복이 생기지 않는다.
  ring.merge([candle(60, 9)]);
  assert.deepEqual(ring.toArray().map((c) => c.close), [9, 3]);
  ring.merge([candle(240, 4), candle(300, 5)]);
  assert.deepEqual(ring.toArray().map((c) => c.time), [180, 240, 300]);
  assert.equal(ring.lastTime(), 300);
  ring.clear();
  assert.equal(ring.lastTime(), null);
});

test('중복 제거는 TTL 안에서는 중복으로 판정한다', () => {
  const dedup = new KeyedDedup({ttlMs: 1000, max: 3});
  assert.equal(dedup.seen('a', 0), true);
  assert.equal(dedup.seen('a', 500), false);
  assert.equal(dedup.seen('a', 1001), true);
  for (const key of ['b', 'c', 'd', 'e']) dedup.seen(key, 2000);
  assert.ok(dedup.size <= 3);
  assert.throws(() => new KeyedDedup({ttlMs: -1}));
});

test('신호 중복 제거는 동일 키를 한 번만 허용하고 상한을 지킨다', () => {
  const dedup = new SignalDedup(2);
  assert.equal(dedup.claim('005930:100:buy'), true);
  assert.equal(dedup.claim('005930:100:buy'), false);
  assert.equal(dedup.claim('005930:160:buy'), true);
  assert.equal(dedup.claim('005930:220:buy'), true);
  assert.equal(dedup.size, 2);
  assert.equal(dedup.has('005930:100:buy'), false);
});
