import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AuditLog} from './audit';
import {DemandBridge} from './bridge';
import {SharedCache} from './cache';
import type {RealtimeHub} from './hub';
import type {Quote} from './protocol';

/**
 * Bridge tests use a fake hub: they verify how demand logic asks for and consumes data
 * (ranking rules, subscription alignment, fallback budget), not the wire protocol.
 */
function fakeHub(options: {data?: unknown[]; ready?: boolean} = {}) {
  const calls = {
    requests: [] as {packet: Record<string, unknown>; expected: string}[],
    subscribed: [] as {owner: string; items: string[]; types: string[]}[],
    unsubscribed: [] as {owner: string; items: string[]; types: string[]}[],
    refreshed: [] as string[],
    active: [] as string[][],
  };
  const hub = {
    isReady: options.ready ?? true,
    async request(packet: Record<string, unknown>, expected: string) {
      calls.requests.push({packet, expected});
      return {trnm: expected, return_code: 0, data: options.data ?? []};
    },
    async subscribe(owner: string, items: string[], types: string[]) {
      calls.subscribed.push({owner, items: [...items], types: [...types]});
    },
    async unsubscribe(owner: string, items: string[], types: string[]) {
      calls.unsubscribed.push({owner, items: [...items], types: [...types]});
    },
    async refreshCandles(code: string) {
      calls.refreshed.push(code);
      return [];
    },
    setActiveCodes(codes: string[]) {
      calls.active.push([...codes]);
    },
    positionsSnapshot() {
      return {};
    },
    eventsSnapshot() {
      return [];
    },
    status() {
      return {state: 'ready'};
    },
  };
  return {hub: hub as unknown as RealtimeHub, calls, raw: hub};
}

const quote = (code: string, price: number, changePct: number, strength: number, cumValue: number): Quote => ({
  code,
  time: null,
  price,
  changePct,
  strength,
  cumVolume: null,
  cumValue,
  dayOpen: null,
  dayHigh: null,
  dayLow: null,
  tradeVolume: null,
  netBuyVolume: null,
  buyVolume: null,
  sellVolume: null,
  source: '0B',
  receivedAt: Date.now(),
});

const config = {seq: '4', count: 2, weights: {change: 40, strength: 35, value: 25}};

test('조건검색 초기 목록은 중앙 세션 요청으로 받고 포착 종목으로 등록', async () => {
  const {hub, calls} = fakeHub({data: [{'9001': 'A005930', '302': '삼성전자', '10': '-000070000', '12': '000001500'}, {'9001': 'J123456'}]});
  const cache = new SharedCache();
  const bridge = new DemandBridge({hub, cache, audit: new AuditLog(), broker: {candles: async () => [], daily: async () => []}});
  const result = await bridge.apply(config);
  const request = calls.requests[0];
  assert.equal(request.packet.trnm, 'CNSRREQ');
  assert.equal(request.packet.seq, '4');
  assert.ok(calls.requests.some((item) => item.packet.search_type === '0'));
  assert.deepEqual(cache.capturedCodes('4'), ['005930'], 'ETF 등 비주식 코드는 제외');
  assert.equal(result.ranking.length, 1);
  assert.equal(result.ranking[0].code, '005930');
  assert.equal(result.ranking[0].score, -1, '시세 전에는 대기 항목으로 목록에 둔다');
  assert.equal(result.warnings['005930'], '실시간 시세·체결강도·누적거래대금 대기');
});

test('순위는 실시간 체결값으로 계산하고 선택 종목만 구독한다', async () => {
  const {hub, calls} = fakeHub({data: [{'9001': '005930', '302': 'A종목', '10': '100', '12': '1.0'}, {'9001': '000660', '302': 'B종목', '10': '200', '12': '2.0'}]});
  const cache = new SharedCache();
  const bridge = new DemandBridge({hub, cache, audit: new AuditLog(), broker: {candles: async () => [], daily: async () => []}});
  await bridge.apply(config);
  cache.setQuote(quote('005930', 100, 1, 100, 1000));
  cache.setQuote(quote('000660', 200, 2, 200, 2000));
  const listed = await bridge.computeRanking(config);
  assert.equal(listed.ranking.length, 2);
  assert.equal(listed.ranking[0].code, '000660');
  assert.equal(listed.selected.length, 0, '체크하지 않으면 차트 종목이 없다');

  const withCharts = {...config, chartCodes: ['005930']};
  const result = await bridge.computeRanking(withCharts);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].code, '005930');

  await bridge.syncSubscriptions(withCharts);
  assert.ok(calls.subscribed.some((call) => call.types.includes('0B') && call.items.includes('005930')));
  assert.deepEqual(calls.active.at(-1), ['005930']);
});

test('가중치에 따라 순위가 결정되고 결측 종목은 제외', async () => {
  const {hub} = fakeHub({data: [{'9001': '005930'}, {'9001': '000660'}, {'9001': '035420'}]});
  const cache = new SharedCache();
  const bridge = new DemandBridge({hub, cache, audit: new AuditLog(), broker: {candles: async () => [], daily: async () => []}});
  await bridge.apply({seq: '4', count: 3, weights: {change: 100, strength: 0, value: 0}});
  cache.setQuote(quote('005930', 1, 1, 10, 100));
  cache.setQuote(quote('000660', 1, 5, 10, 100));
  const result = await bridge.computeRanking({seq: '4', count: 3, weights: {change: 100, strength: 0, value: 0}});
  assert.equal(result.ranking[0].code, '000660');
  assert.ok(result.warnings['035420']);
});

test('REST 대체 조회는 한 번의 계산에서 예산만큼만 호출한다', async () => {
  const codes = Array.from({length: 5}, (_, index) => `00000${index}`);
  const {hub} = fakeHub({data: codes.map((code) => ({'9001': code}))});
  const cache = new SharedCache();
  let calls = 0;
  const bridge = new DemandBridge({
    hub,
    cache,
    audit: new AuditLog(),
    broker: {
      candles: async () => [],
      daily: async () => [],
      strengthSnapshot: async () => {
        calls += 1;
        return {strength: 100, value: 1000, change: null};
      },
    },
    fallbackBudget: 2,
  });
  await bridge.apply({seq: '4', count: 3, weights: {change: 0, strength: 50, value: 50}});
  calls = 0;
  const first = await bridge.computeRanking({seq: '4', count: 3, weights: {change: 0, strength: 50, value: 50}});
  assert.ok(calls <= 2, `한 번의 계산에서 예산(2)을 넘지 않아야 합니다: ${calls}`);
  assert.ok(first.ranking.length > 0, '시세 전에도 포착 종목은 목록에 둔다');
  // 캐시된 대체 값은 TTL 안에서 재사용된다.
  calls = 0;
  await bridge.computeRanking({seq: '4', count: 3, weights: {change: 0, strength: 50, value: 50}});
  assert.equal(calls, 0, 'TTL 안에서는 REST를 다시 호출하지 않는다');
});

test('오래된 실시간 시세는 순위에서 제외한다', async () => {
  const {hub} = fakeHub({data: [{'9001': '005930', '302': '삼성전자'}]});
  const cache = new SharedCache();
  const now = {t: 1_000_000};
  const bridge = new DemandBridge({
    hub,
    cache,
    audit: new AuditLog(),
    broker: {candles: async () => [], daily: async () => []},
    now: () => now.t,
    quoteTtlMs: 1000,
  });
  await bridge.apply({seq: '4', count: 1, weights: {change: 100, strength: 0, value: 0}});
  cache.setQuote({...quote('005930', 100, 1, 100, 1000), receivedAt: now.t - 500});
  const fresh = await bridge.computeRanking({seq: '4', count: 1, weights: {change: 100, strength: 0, value: 0}});
  assert.equal(fresh.ranking.length, 1);
  now.t += 2000;
  const stale = await bridge.computeRanking({seq: '4', count: 1, weights: {change: 100, strength: 0, value: 0}});
  assert.equal(stale.ranking.length, 1);
  assert.equal(stale.ranking[0].score, -1);
  assert.ok(stale.warnings['005930']);
});

test('세션이 준비되지 않으면 조건검색을 시작하지 않는다', async () => {
  const {hub} = fakeHub({ready: false});
  const bridge = new DemandBridge({hub, cache: new SharedCache(), audit: new AuditLog(), broker: {candles: async () => [], daily: async () => []}});
  await assert.rejects(() => bridge.apply(config), /준비되지 않았습니다/);
  assert.deepEqual(bridge.candles('005930'), []);
});
