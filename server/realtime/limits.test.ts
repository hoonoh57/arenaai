import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_RETRY_CODES,
  LimitGovernor,
  OrderGate,
  RATE_LIMIT_CODES,
  RealtimeCaps,
  TokenBucket,
  classifyMessage,
  classifyReturnCode,
  embeddedReturnCode,
} from './limits';

/** Virtual clock so pacing tests never sleep for real. */
function virtualClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('공식 오류코드 1700/1701/1702 및 인증 만료 코드 분류', () => {
  for (const code of RATE_LIMIT_CODES) assert.equal(classifyReturnCode(code), 'rate-limit');
  for (const code of AUTH_RETRY_CODES) assert.equal(classifyReturnCode(code), 'auth-expired');
  assert.equal(classifyReturnCode(null), 'other');
  assert.equal(classifyReturnCode(1505), 'other');
  // 상위 코드 3 + 메시지 내 코드
  assert.equal(embeddedReturnCode('[8005:Token이 유효하지 않습니다]'), 8005);
  assert.equal(embeddedReturnCode('CODE=1701'), 1701);
  assert.equal(classifyMessage(3, '[8005:Token이 유효하지 않습니다]'), 'auth-expired');
  assert.equal(classifyMessage(0, 'ok'), 'other');
});

test('토큰 버킷은 용량까지 보충되고 대기 시간을 계산', () => {
  const bucket = new TokenBucket({capacity: 2, refillPerSecond: 1}, 0);
  assert.equal(bucket.available(0), 2);
  bucket.take(0);
  bucket.take(0);
  assert.equal(bucket.waitMs(0), 1000);
  assert.equal(bucket.waitMs(500), 500);
  assert.equal(bucket.available(2000), 2);
  bucket.take(2000);
  bucket.take(2000);
  assert.throws(() => bucket.take(2000), /토큰이 없습니다/);
  assert.throws(() => new TokenBucket({capacity: 0, refillPerSecond: 1}, 0));
});

test('거버너가 요청 간격과 API별/전체 한도를 함께 지킨다', async () => {
  const clock = virtualClock();
  const governor = new LimitGovernor({
    total: {capacity: 2, refillPerSecond: 10},
    perApi: {capacity: 1, refillPerSecond: 1},
    order: {capacity: 1, refillPerSecond: 1},
    now: clock.now,
    sleep: clock.sleep,
    maxWaitMs: 60000,
  });
  const started = clock.now();
  await governor.acquire('ka10080');
  await governor.acquire('ka10080'); // 같은 API는 1/s → 최소 1000ms 대기
  assert.ok(clock.now() - started >= 1000);
  // 다른 API ID는 별도 버킷이므로 즉시 통과할 수 있다.
  const before = clock.now();
  await governor.acquire('ka10081');
  assert.equal(clock.now() - before, 0);
  const stats = governor.snapshot();
  assert.equal(stats.acquired, 3);
  assert.ok(stats.waited >= 1);
});

test('대기 한도를 넘으면 실패하고 무한 대기하지 않는다', async () => {
  const clock = virtualClock();
  const governor = new LimitGovernor({
    total: {capacity: 1, refillPerSecond: 0.001},
    perApi: {capacity: 1, refillPerSecond: 0.001},
    order: {capacity: 1, refillPerSecond: 1},
    now: clock.now,
    sleep: clock.sleep,
    maxWaitMs: 2000,
  });
  await governor.acquire('ka10080');
  await assert.rejects(() => governor.acquire('ka10080'), /대기 한도/);
});

test('주문 레인은 별도 버킷이며 실거래 주문은 전송되지 않는다', async () => {
  const clock = virtualClock();
  const governor = new LimitGovernor({
    total: {capacity: 50, refillPerSecond: 50},
    perApi: {capacity: 50, refillPerSecond: 50},
    order: {capacity: 1, refillPerSecond: 1},
    now: clock.now,
    sleep: clock.sleep,
    maxWaitMs: 5000,
  });
  const started = clock.now();
  await governor.acquire('ka10080', 'order');
  await governor.acquire('ka10080', 'order'); // 주문 레인은 1개/1000s → 대기 필요
  assert.ok(clock.now() - started >= 1000);
  assert.equal(governor.snapshot().orderRequests, 2);

  const gate = new OrderGate(governor);
  await assert.rejects(() => gate.submit(), /구현되지 않았습니다/);
});

test('한도 오류 코드는 전체 레인을 잠시 멈춘다', async () => {
  const clock = virtualClock();
  const governor = new LimitGovernor({
    total: {capacity: 5, refillPerSecond: 1000},
    perApi: {capacity: 5, refillPerSecond: 1000},
    order: {capacity: 5, refillPerSecond: 1000},
    penaltyMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
    maxWaitMs: 60000,
  });
  governor.penalize();
  assert.equal(governor.snapshot().cooldownMs, 3000);
  const started = clock.now();
  await governor.acquire('ka10080');
  assert.ok(clock.now() - started >= 3000);
  assert.equal(governor.snapshot().penalties, 1);
});

test('실시간 연결/구독/패킷 제한은 기본값이 검증되지 않았음을 명시', () => {
  const caps = new RealtimeCaps();
  assert.deepEqual(caps.limits, {maxConnections: 1, maxSubscriptions: 100, maxItemsPerPacket: 10});
  caps.assertConnection(1);
  assert.throws(() => caps.assertConnection(2), /동시 연결 제한/);
  caps.assertAddition(100, 0);
  assert.throws(() => caps.assertAddition(100, 1), /구독 제한/);
  assert.throws(() => caps.assertPacket(11), /패킷당/);
  assert.throws(() => new RealtimeCaps({maxSubscriptions: 0}));
});
