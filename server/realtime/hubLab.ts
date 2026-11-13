import {writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Candle} from '../core';
import {AuditLog} from './audit';
import {SharedCache} from './cache';
import {LimitGovernor, RealtimeCaps} from './limits';
import {RealtimeHub, type BrokerLike} from './hub';
import {RiskManager} from './risk';
import {HUB_OP_TARGETS, type HubOpName} from './hubOps';
import {DESK_MAX, MULTI_CHART_MAX} from '../../shared/desk';

export type LabCase = {
  id: HubOpName;
  title: string;
  group: string;
};

/** 이곳에 없는 허브 기능은 정식 사용 거부. */
export const LAB_CASES: LabCase[] = [
  {id: 'ensureChartPage', title: '차트 페이지 1장', group: 'REST'},
  {id: 'ensureStrengthPage', title: '체결강도 1장', group: 'REST'},
  {id: 'putChartPage', title: '공유 캐시 기록', group: '캐시'},
  {id: 'chartPage', title: '공유 캐시 읽기', group: '캐시'},
  {id: 'getQuote', title: '최근 체결 읽기', group: '캐시'},
  {id: 'applyLiveTick', title: '체결→봉', group: 'WSS'},
  {id: 'applyLiveQuote', title: '체결→1분 링', group: 'WSS'},
  {id: 'subscribe', title: '0B 구독(미연결 제약)', group: 'WSS'},
  {id: 'unsubscribe', title: '구독 해제', group: 'WSS'},
  {id: 'evaluateSignals', title: '신호 평가', group: '전략'},
  {id: 'bookSnapshot', title: '보유·미체결 스냅샷', group: '주문'},
  {id: 'planWatch', title: '감시 종목 계획', group: '조건식'},
  {id: 'status', title: '허브 상태', group: '감독'},
  {id: 'conditionOne', title: '단일 조건검색 요청·종목 편성', group: '조건식'},
  {id: 'conditionMany', title: '여러 조건검색·다종목 편성', group: '조건식'},
  {id: 'liveMany', title: '다종목 실시간 갱신', group: 'WSS'},
  {id: 'orderDuplicate', title: '중복 주문 거절', group: '주문'},
  {id: 'orderOverLimit', title: '제약 초과 주문 거절', group: '주문'},
  {id: 'chartRefreshBudget', title: '최대 차트 수 리프레시 예산', group: 'REST'},
  {id: 'demandWindowCap', title: '실시간 수요창 최대 개수', group: '감독'},
];

const OFFICIAL = new Set(LAB_CASES.map((c) => c.id));

export function isOfficialHubOp(name: string): boolean {
  return OFFICIAL.has(name as HubOpName) && name in HUB_OP_TARGETS;
}

export type LabCaseResult = {
  id: HubOpName;
  title: string;
  group: string;
  ms: number;
  targetMs: number;
  ok: boolean;
  pass: boolean;
  detail: string;
  constraints: number;
};

export type LabReport = {
  at: number;
  scope: 'all' | HubOpName;
  results: LabCaseResult[];
  bottlenecks: string[];
  missingOfficial: string[];
  liveMeters?: ReturnType<RealtimeHub['ops']['report']>;
};

const REPORT_PATH = process.env.HUB_LAB_PATH || 'data/hub-lab-reports.json';

function bar(time: number, px: number): Candle {
  return {time, open: px, high: px, low: px, close: px, volume: 100, strength: 110};
}
function bars(n: number, t0 = 1_700_000_000): Candle[] {
  return Array.from({length: n}, (_, i) => bar(t0 + i * 60, 10000 + i));
}

function fakeBroker(pages = bars(80)): BrokerLike {
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

function labHub() {
  const cache = new SharedCache();
  const audit = new AuditLog();
  const governor = new LimitGovernor({
    total: {capacity: 10, refillPerSecond: 1000 / 300},
    perApi: {capacity: 5, refillPerSecond: 1000 / 300},
    order: {capacity: 1, refillPerSecond: 0.2},
  });
  const hub = new RealtimeHub({
    url: 'ws://127.0.0.1:9',
    getToken: async () => 'lab',
    governor,
    cache,
    audit,
    caps: new RealtimeCaps({maxSubscriptions: 100, maxItemsPerPacket: 10}),
    broker: fakeBroker(),
    createSocket: () => {
      throw new Error('테스트랩은 키움 소켓을 열지 않습니다');
    },
  });
  return {hub, cache, governor};
}

function codes(n: number): string[] {
  return Array.from({length: n}, (_, i) => String(100000 + i).slice(-6));
}

async function runOne(id: HubOpName, hub: RealtimeHub, cache: SharedCache): Promise<{detail: string; constraints: number}> {
  const t0 = 1_700_000_000;
  const code = '005930';
  if (id === 'ensureChartPage') {
    const p = await hub.ensureChartPage({code, timeframe: '1'});
    return {detail: `봉 ${p.candles.length}`, constraints: 0};
  }
  if (id === 'ensureStrengthPage') {
    await hub.ensureChartPage({code, timeframe: '1'});
    const s = await hub.ensureStrengthPage({code, timeframe: '1'});
    return {detail: `ready=${s.ready}`, constraints: s.ready ? 0 : 1};
  }
  if (id === 'putChartPage') {
    hub.ops.runSync('putChartPage', () => cache.putChartPage(code, '1', '', bars(40)));
    return {detail: '기록', constraints: 0};
  }
  if (id === 'chartPage') {
    cache.putChartPage(code, '1', '', bars(40));
    const n = hub.ops.runSync('chartPage', () => cache.chartPage(code, '1', '')).length;
    return {detail: `읽기 ${n}`, constraints: 0};
  }
  if (id === 'getQuote') {
    hub.quoteOf(code);
    return {detail: '시세', constraints: 0};
  }
  if (id === 'applyLiveTick' || id === 'applyLiveQuote') {
    cache.putChartPage(code, '1', '', bars(20));
    for (let i = 0; i < 20; i++) {
      hub.ops.runSync('applyLiveTick', () => cache.applyLiveTick(code, t0 + 19 * 60, 10100, 1, 120));
      hub.ops.runSync('applyLiveQuote', () => cache.applyLiveQuote(code, t0 + 19 * 60, 10100, 1));
    }
    return {detail: '20틱', constraints: 0};
  }
  if (id === 'subscribe') {
    try {
      await hub.subscribe('lab', [code], ['0B']);
      return {detail: 'REG', constraints: 0};
    } catch (e) {
      hub.ops.noteConstraint('subscribe');
      return {detail: e instanceof Error ? e.message : '거절', constraints: 1};
    }
  }
  if (id === 'unsubscribe') {
    await hub.unsubscribe('lab', [code], ['0B']);
    return {detail: '해제', constraints: 0};
  }
  if (id === 'evaluateSignals') {
    cache.mergeCandles(code, bars(30));
    hub.setActiveCodes([code]);
    hub.setSignalEvaluator(() => ({buy: false, sell: false}));
    for (let i = 0; i < 20; i++) hub.evaluateSignals(code);
    return {detail: '20회', constraints: 0};
  }
  if (id === 'bookSnapshot') {
    hub.bookSnapshot();
    return {detail: '장부', constraints: 0};
  }
  if (id === 'planWatch' || id === 'conditionOne') {
    const plan = hub.ops.runSync('conditionOne', () =>
      hub.planWatch({chartCodes: [code], captured: codes(12), selected: [code], budget: 40}),
    );
    return {detail: `감시 ${plan.watch.length} 건너뜀 ${plan.skipped}`, constraints: 0};
  }
  if (id === 'conditionMany') {
    let watch = 0;
    hub.ops.runSync('conditionMany', () => {
      for (let s = 0; s < 5; s++) {
        const plan = hub.planWatch({chartCodes: codes(4), captured: codes(80), budget: 40});
        watch = plan.watch.length;
      }
    });
    return {detail: `5회 편성 감시 ${watch}`, constraints: 0};
  }
  if (id === 'liveMany') {
    const list = codes(16);
    hub.ops.runSync('liveMany', () => {
      for (const c of list) {
        cache.putChartPage(c, '1', '', bars(10));
        for (let i = 0; i < 10; i++) cache.applyLiveTick(c, t0 + 9 * 60, 10000, 1, 100);
      }
    });
    return {detail: '16종목×10틱', constraints: 0};
  }
  if (id === 'orderDuplicate') {
    cache.setQuote({
      code,
      time: t0,
      price: 10000,
      changePct: 0,
      strength: 100,
      cumVolume: 1,
      cumValue: 1,
      dayOpen: 10000,
      dayHigh: 10000,
      dayLow: 10000,
      tradeVolume: 1,
      netBuyVolume: 0,
      buyVolume: 1,
      sellVolume: 0,
      source: '0B',
      receivedAt: Date.now(),
    });
    let second = '';
    hub.ops.runSync('orderDuplicate', () => {
      hub.book.place({code, side: 'buy', type: 'market', qty: 1, source: 'signal', priceHint: 10000});
      try {
        hub.book.place({code, side: 'buy', type: 'market', qty: 1, source: 'signal', priceHint: 10000});
        second = '중복 허용됨';
      } catch (e) {
        second = e instanceof Error ? e.message : '거절';
        hub.ops.noteConstraint('orderDuplicate');
      }
    });
    const okDup = /보유/.test(second);
    return {detail: second, constraints: okDup ? 1 : 0};
  }
  if (id === 'orderOverLimit') {
    const risk = new RiskManager({maxPositions: 2, maxEntriesPerDay: 2, maxEntriesPerCode: 1, maxEntriesPerMinute: 2});
    let blocked = '';
    hub.ops.runSync('orderOverLimit', () => {
      risk.onEntry('000001', 100, Date.now());
      risk.onEntry('000002', 100, Date.now());
      const d = risk.canEnter({code: '000003', price: 100, at: Date.now()});
      blocked = d.ok ? '한도 미적용' : d.reason;
      if (!d.ok) hub.ops.noteConstraint('orderOverLimit');
    });
    return {detail: blocked, constraints: blocked.includes('최대') ? 1 : 0};
  }
  if (id === 'chartRefreshBudget') {
    const minRefresh = 15_000;
    const charts = MULTI_CHART_MAX;
    const perMin = charts * (60_000 / minRefresh);
    const restPerMin = (1000 / 300) * 60;
    const tight = perMin > restPerMin;
    hub.ops.runSync('chartRefreshBudget', () => undefined);
    if (tight) hub.ops.noteConstraint('chartRefreshBudget');
    return {
      detail: `차트 ${charts} × ${(60000 / minRefresh).toFixed(0)}회/분 = ${perMin.toFixed(0)} , REST≈${restPerMin.toFixed(0)}/분`,
      constraints: tight ? 1 : 0,
    };
  }
  if (id === 'demandWindowCap') {
    const perDesk = 16;
    const total = DESK_MAX * perDesk;
    hub.ops.runSync('demandWindowCap', () => undefined);
    return {detail: `화면 ${DESK_MAX} × 창 ${perDesk} = ${total}. 소켓은 1`, constraints: 0};
  }
  if (id === 'status') {
    hub.status();
    return {detail: hub.currentState, constraints: 0};
  }
  throw new Error(`미등록 기능: ${id}`);
}

export async function runHubLab(live: RealtimeHub | null, scope: 'all' | HubOpName = 'all'): Promise<LabReport> {
  const missingOfficial = (Object.keys(HUB_OP_TARGETS) as HubOpName[]).filter((n) => !OFFICIAL.has(n));
  if (scope !== 'all' && !isOfficialHubOp(scope)) throw new Error(`정식 등록되지 않은 기능은 측정·사용할 수 없습니다: ${scope}`);
  const {hub, cache} = labHub();
  const pick = scope === 'all' ? LAB_CASES : LAB_CASES.filter((c) => c.id === scope);
  const results: LabCaseResult[] = [];
  for (const c of pick) {
    const t0 = Date.now();
    let detail = '';
    let constraints = 0;
    let ok = true;
    try {
      const out = await runOne(c.id, hub, cache);
      detail = out.detail;
      constraints = out.constraints;
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - t0;
    const targetMs = HUB_OP_TARGETS[c.id].targetMs;
    results.push({
      id: c.id,
      title: c.title,
      group: c.group,
      ms,
      targetMs,
      ok,
      pass: ok && ms <= targetMs,
      detail,
      constraints,
    });
  }
  const report: LabReport = {
    at: Date.now(),
    scope,
    results,
    bottlenecks: results.filter((r) => !r.pass).map((r) => r.id),
    missingOfficial,
    liveMeters: live ? live.ops.report() : undefined,
  };
  saveReport(report);
  return report;
}

function saveReport(report: LabReport): void {
  mkdirSync(dirname(REPORT_PATH), {recursive: true});
  const prev = loadReports();
  const next = [report, ...prev].slice(0, 40);
  writeFileSync(REPORT_PATH, JSON.stringify(next, null, 2));
}

export function loadReports(): LabReport[] {
  if (!existsSync(REPORT_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
