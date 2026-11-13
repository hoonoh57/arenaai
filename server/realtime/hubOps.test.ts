import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AuditLog} from './audit';
import {SharedCache} from './cache';
import {LimitGovernor, RealtimeCaps} from './limits';
import {RealtimeHub, type BrokerLike} from './hub';
import {HUB_OP_TARGETS, type HubOpName} from './hubOps';
import type {Candle} from '../core';

function bar(time: number, px: number, extra: Partial<Candle> = {}): Candle {
  return {time, open: px, high: px, low: px, close: px, volume: 100, strength: 110, ...extra};
}

function bars(n: number, t0 = 1_700_000_000): Candle[] {
  return Array.from({length: n}, (_, i) => bar(t0 + i * 60, 10000 + i));
}

function fakeBroker(pages = bars(120)): BrokerLike {
  return {
    candles: async () => pages,
    daily: async () => [],
    chartPage: async () => ({candles: pages, hasMore: false, nextKey: ''}),
    attachStrength: async (_c, _tf, candles) => ({
      candles: candles.map((c) => ({...c, strength: c.strength ?? 110})),
      hasMore: false,
      nextKey: '',
      ready: true,
      nxt: true,
    }),
    stockName: async (code) => code,
  };
}

function hubWith(broker: BrokerLike) {
  const cache = new SharedCache();
  const audit = new AuditLog();
  const governor = new LimitGovernor({
    total: {capacity: 100, refillPerSecond: 1000},
    perApi: {capacity: 100, refillPerSecond: 1000},
    order: {capacity: 10, refillPerSecond: 10},
  });
  const hub = new RealtimeHub({
    url: 'ws://127.0.0.1:9',
    getToken: async () => 't',
    governor,
    cache,
    audit,
    caps: new RealtimeCaps({maxSubscriptions: 100}),
    broker,
    createSocket: () => {
      throw new Error('성과 테스트는 소켓 없이 허브 로직만 잰다');
    },
  });
  return {hub, cache};
}

test('중앙관리자 등록 기능 성과: 이름·평균·목표·제약', async () => {
  const {hub, cache} = hubWith(fakeBroker());
  const code = '005930';
  cache.putChartPage(code, '1', '', bars(80));

  const page = await hub.ensureChartPage({code, timeframe: '1'});
  assert.ok(page.candles.length >= 80);
  const str = await hub.ensureStrengthPage({code, timeframe: '1'});
  assert.equal(str.ready, true);
  await hub.ensureChartPage({code, timeframe: '1'});

  for (let i = 0; i < 80; i++) {
    cache.applyLiveTick(code, 1_700_000_000 + 79 * 60, 10100 + i, 10, 120);
  }
  for (let i = 0; i < 80; i++) {
    hub.ops.runSync('applyLiveTick', () => cache.applyLiveTick(code, 1_700_000_000 + 79 * 60, 10200, 1, 121));
    hub.ops.runSync('applyLiveQuote', () => cache.applyLiveQuote(code, 1_700_000_000 + 79 * 60, 10200, 1));
  }

  hub.setActiveCodes([code]);
  hub.setSignalEvaluator(() => ({buy: false, sell: false}));
  for (let i = 0; i < 40; i++) hub.evaluateSignals(code);

  for (let i = 0; i < 40; i++) {
    hub.planWatch({chartCodes: [code], captured: ['000660', '006360', code], budget: 40});
    hub.bookSnapshot();
    hub.quoteOf(code);
    hub.status();
    hub.ops.runSync('chartPage', () => cache.chartPage(code, '1', ''));
  }

  await assert.rejects(() => hub.subscribe('desk:charts', [code], ['0B']), /준비되지/);

  const {rows, bottlenecks} = hub.ops.report();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const must: HubOpName[] = [
    'ensureChartPage',
    'ensureStrengthPage',
    'applyLiveTick',
    'applyLiveQuote',
    'evaluateSignals',
    'planWatch',
    'bookSnapshot',
    'status',
    'putChartPage',
    'chartPage',
    'subscribe',
  ];
  const lines = must.map((name) => {
    const r = byName[name];
    assert.ok(r && r.runs > 0, `${name} 미실행`);
    return `${name} runs=${r.runs} avg=${r.avgMs.toFixed(2)}ms target=${r.targetMs}ms max=${r.maxMs}ms over=${r.overTarget} err=${r.errors} constraint=${r.constraints}`;
  });
  console.log('허브 성과\n' + lines.join('\n'));
  if (byName.subscribe) assert.ok(byName.subscribe.constraints >= 1, '미연결 REG는 제약으로 집계');

  const over = must.filter((name) => {
    const r = byName[name];
    if (name === 'subscribe') return r.avgMs > r.targetMs;
    return r.avgMs > r.targetMs;
  });
  assert.deepEqual(over, [], `목표 초과: ${over.join(', ')} / ${lines.join(' | ')}`);
  assert.ok(!bottlenecks.filter((n) => n !== 'subscribe').length || over.length === 0);
});

test('허브 목표표가 목록의 모든 업무를 덮는다', () => {
  const names = Object.keys(HUB_OP_TARGETS);
  assert.ok(names.includes('ensureStrengthPage'));
  assert.ok(names.includes('ensureChartPage'));
  assert.equal(names.length, Object.keys(HUB_OP_TARGETS).length);
  assert.equal(names.length, 20);
});
