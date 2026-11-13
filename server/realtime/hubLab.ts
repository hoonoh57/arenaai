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
import {clampLabParams, type LabParams} from '../../shared/hubLabParams';

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

export type LabUnitLive = {
  caseId: string;
  unit: string;
  done: number;
  total: number;
  lastCode: string;
  lastOk: boolean;
  lastMs: number;
  avgMs: number;
  etaMs: number;
  parallel: number;
  note: string;
};

let unitLive: LabUnitLive | null = null;
const unitTimes: number[] = [];

export function getLabUnitLive(): LabUnitLive | null {
  return unitLive ? {...unitLive} : null;
}

function beginUnits(caseId: string, unit: string, total: number, parallel: number, note: string): void {
  unitTimes.length = 0;
  unitLive = {caseId, unit, done: 0, total, lastCode: '', lastOk: true, lastMs: 0, avgMs: 0, etaMs: 0, parallel, note};
}

function markUnit(code: string, ok: boolean, ms: number): void {
  if (!unitLive) return;
  unitTimes.push(Math.max(0, ms));
  const avg = unitTimes.reduce((a, b) => a + b, 0) / unitTimes.length;
  const done = unitTimes.length;
  const remain = Math.max(0, unitLive.total - done);
  const par = Math.max(1, unitLive.parallel);
  unitLive = {
    ...unitLive,
    done,
    lastCode: code,
    lastOk: ok,
    lastMs: ms,
    avgMs: avg,
    etaMs: avg * Math.ceil(remain / par),
  };
}

function endUnits(): void {
  unitLive = null;
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
  params: LabParams;
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

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({length: Math.max(1, Math.min(n, items.length))}, async () => {
    for (;;) {
      const cur = i++;
      if (cur >= items.length) return;
      await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
}

function fakeBroker(pages = bars(80), delayMs = 0): BrokerLike {
  const wait = () => sleep(delayMs);
  return {
    candles: async () => {
      await wait();
      return pages;
    },
    daily: async () => {
      await wait();
      return [];
    },
    chartPage: async () => {
      await wait();
      return {candles: pages, hasMore: false, nextKey: ''};
    },
    attachStrength: async (_c, _tf, candles) => {
      await wait();
      return {
        candles: candles.map((c) => ({...c, strength: c.strength ?? 110})),
        hasMore: false,
        nextKey: '',
        ready: true,
        nxt: true,
      };
    },
    stockName: async (code) => code,
  };
}

function labHub(params: LabParams) {
  const cache = new SharedCache({maxCodes: Math.max(200, params.codes + 20)});
  const audit = new AuditLog();
  const governor = new LimitGovernor({
    total: {capacity: 10, refillPerSecond: 1000 / Math.max(50, params.restIntervalMs || 300)},
    perApi: {capacity: 5, refillPerSecond: 1000 / Math.max(50, params.restIntervalMs || 300)},
    order: {capacity: 1, refillPerSecond: 0.2},
  });
  const hub = new RealtimeHub({
    url: 'ws://127.0.0.1:9',
    getToken: async () => 'lab',
    governor,
    cache,
    audit,
    caps: new RealtimeCaps({maxSubscriptions: 100, maxItemsPerPacket: 10}),
    broker: fakeBroker(bars(80), params.restDelayMs),
    createSocket: () => {
      throw new Error('테스트랩은 키움 소켓을 열지 않습니다');
    },
  });
  return {hub, cache, governor};
}

function codes(n: number): string[] {
  return Array.from({length: n}, (_, i) => String(100000 + i).slice(-6));
}

async function runOne(id: HubOpName, hub: RealtimeHub, cache: SharedCache, p: LabParams): Promise<{detail: string; constraints: number}> {
  const t0 = 1_700_000_000;
  const list = codes(p.codes);
  const code = list[0] || '005930';
  const extraFeeds = (c: string, px: number) => {
    if (p.feedsPerCode < 4) return;
    cache.setQuote({
      code: c,
      time: t0,
      price: px,
      changePct: 0,
      strength: 110,
      cumVolume: 1,
      cumValue: 1,
      dayOpen: px,
      dayHigh: px,
      dayLow: px,
      tradeVolume: 1,
      netBuyVolume: p.feedsPerCode >= 5 ? 10 : 0,
      buyVolume: 1,
      sellVolume: 0,
      source: '0B',
      receivedAt: Date.now(),
    });
  };
  if (id === 'ensureChartPage') {
    let n = 0;
    beginUnits(id, '종목', list.length, p.chartConcurrency, '분봉 페이지');
    try {
      await pool(list, p.chartConcurrency, async (c) => {
        const t = Date.now();
        try {
          const page = await hub.ensureChartPage({code: c, timeframe: '1'});
          n = page.candles.length;
          markUnit(c, true, Date.now() - t);
        } catch {
          markUnit(c, false, Date.now() - t);
        }
      });
    } finally {
      endUnits();
    }
    return {detail: `종목 ${list.length} 병렬 ${p.chartConcurrency} 봉 ${n}`, constraints: 0};
  }
  if (id === 'ensureStrengthPage') {
    let ready = 0;
    beginUnits(id, '종목', list.length, p.chartConcurrency, '체결강도 페이지');
    try {
      await pool(list, p.chartConcurrency, async (c) => {
        const t = Date.now();
        try {
          await hub.ensureChartPage({code: c, timeframe: '1'});
          const s = await hub.ensureStrengthPage({code: c, timeframe: '1'});
          if (s.ready) ready += 1;
          markUnit(c, s.ready, Date.now() - t);
        } catch {
          markUnit(c, false, Date.now() - t);
        }
      });
    } finally {
      endUnits();
    }
    return {detail: `강도 완료 ${ready}/${list.length}`, constraints: ready === list.length ? 0 : 1};
  }
  if (id === 'putChartPage') {
    hub.ops.runSync('putChartPage', () => {
      for (const c of list) cache.putChartPage(c, '1', '', bars(40));
    });
    return {detail: `기록 ${list.length}`, constraints: 0};
  }
  if (id === 'chartPage') {
    for (const c of list) cache.putChartPage(c, '1', '', bars(40));
    let n = 0;
    hub.ops.runSync('chartPage', () => {
      for (const c of list) n += cache.chartPage(c, '1', '').length;
    });
    return {detail: `읽기 봉 ${n}`, constraints: 0};
  }
  if (id === 'getQuote') {
    for (const c of list) extraFeeds(c, 10000);
    for (const c of list) hub.quoteOf(c);
    return {detail: `시세 ${list.length}`, constraints: 0};
  }
  if (id === 'applyLiveTick' || id === 'applyLiveQuote') {
    cache.putChartPage(code, '1', '', bars(20));
    for (let i = 0; i < p.ticks; i++) {
      hub.ops.runSync('applyLiveTick', () => cache.applyLiveTick(code, t0 + 19 * 60, 10100, 1, 120));
      hub.ops.runSync('applyLiveQuote', () => cache.applyLiveQuote(code, t0 + 19 * 60, 10100, 1));
    }
    return {detail: `틱 ${p.ticks}`, constraints: 0};
  }
  if (id === 'subscribe') {
    try {
      await hub.subscribe('lab', list.slice(0, Math.min(list.length, 10)), ['0B']);
      return {detail: `REG ${Math.min(list.length, 10)}`, constraints: 0};
    } catch (e) {
      hub.ops.noteConstraint('subscribe');
      return {detail: e instanceof Error ? e.message : '거절', constraints: 1};
    }
  }
  if (id === 'unsubscribe') {
    await hub.unsubscribe('lab', list.slice(0, 10), ['0B']);
    return {detail: '해제', constraints: 0};
  }
  if (id === 'evaluateSignals') {
    hub.setActiveCodes(list);
    hub.setSignalEvaluator(() => ({buy: false, sell: false}));
    for (const c of list) cache.mergeCandles(c, bars(30));
    for (const c of list) hub.evaluateSignals(c);
    return {detail: `평가 ${list.length}`, constraints: 0};
  }
  if (id === 'bookSnapshot') {
    for (let i = 0; i < p.windows; i++) hub.bookSnapshot();
    return {detail: `창 ${p.windows}회`, constraints: 0};
  }
  if (id === 'planWatch' || id === 'conditionOne') {
    const plan = hub.ops.runSync('conditionOne', () =>
      hub.planWatch({chartCodes: list.slice(0, Math.min(16, list.length)), captured: codes(p.captured), selected: [code], budget: p.watchBudget}),
    );
    return {detail: `감시 ${plan.watch.length} 건너뜀 ${plan.skipped} 포착 ${p.captured}`, constraints: 0};
  }
  if (id === 'conditionMany') {
    let watch = 0;
    let skipped = 0;
    hub.ops.runSync('conditionMany', () => {
      for (let s = 0; s < p.conditions; s++) {
        const plan = hub.planWatch({chartCodes: list.slice(0, 4), captured: codes(p.captured), budget: p.watchBudget});
        watch = plan.watch.length;
        skipped = plan.skipped;
      }
    });
    return {detail: `조건 ${p.conditions}×포착 ${p.captured} 감시 ${watch} 건너뜀 ${skipped}`, constraints: skipped > 0 ? 1 : 0};
  }
  if (id === 'liveMany') {
    hub.ops.runSync('liveMany', () => {
      for (const c of list) {
        cache.putChartPage(c, '1', '', bars(10));
        for (let i = 0; i < p.ticks; i++) {
          cache.applyLiveTick(c, t0 + 9 * 60, 10000 + i, 1, 100);
          extraFeeds(c, 10000 + i);
        }
      }
    });
    return {detail: `${list.length}종목×${p.ticks}틱×피드 ${p.feedsPerCode}`, constraints: 0};
  }
  if (id === 'orderDuplicate') {
    extraFeeds(code, 10000);
    let rejected = 0;
    let placed = 0;
    hub.ops.runSync('orderDuplicate', () => {
      for (let i = 0; i < p.orders; i++) {
        const c = list[i % list.length];
        extraFeeds(c, 10000);
        try {
          hub.book.place({code: c, side: 'buy', type: 'market', qty: 1, source: 'signal', priceHint: 10000});
          placed += 1;
        } catch {
          rejected += 1;
          hub.ops.noteConstraint('orderDuplicate');
        }
      }
    });
    return {detail: `시도 ${p.orders} 체결 ${placed} 중복거절 ${rejected}`, constraints: rejected};
  }
  if (id === 'orderOverLimit') {
    const risk = new RiskManager({
      maxPositions: p.maxPositions,
      maxEntriesPerDay: p.maxPositions,
      maxEntriesPerCode: 1,
      maxEntriesPerMinute: Math.max(p.maxPositions, 1),
    });
    let blocked = 0;
    hub.ops.runSync('orderOverLimit', () => {
      for (let i = 0; i < p.orders; i++) {
        const c = String(100000 + i).slice(-6);
        const d = risk.canEnter({code: c, price: 100, at: Date.now()});
        if (d.ok) risk.onEntry(c, 100, Date.now());
        else {
          blocked += 1;
          hub.ops.noteConstraint('orderOverLimit');
        }
      }
    });
    return {detail: `시도 ${p.orders} 한도 ${p.maxPositions} 거절 ${blocked}`, constraints: blocked};
  }
  if (id === 'chartRefreshBudget') {
    const charts = Math.min(p.codes, MULTI_CHART_MAX);
    const perMin = charts * (60_000 / p.refreshMs);
    const restPerMin = (1000 / Math.max(50, p.restIntervalMs || 300)) * 60;
    const tight = perMin > restPerMin;
    hub.ops.runSync('chartRefreshBudget', () => undefined);
    if (tight) hub.ops.noteConstraint('chartRefreshBudget');
    return {
      detail: `차트 ${charts} × ${(60000 / p.refreshMs).toFixed(1)}회/분 = ${perMin.toFixed(0)} , REST≈${restPerMin.toFixed(0)}/분`,
      constraints: tight ? 1 : 0,
    };
  }
  if (id === 'demandWindowCap') {
    const cap = DESK_MAX * 16;
    const over = p.windows > cap;
    hub.ops.runSync('demandWindowCap', () => undefined);
    if (over) hub.ops.noteConstraint('demandWindowCap');
    return {detail: `요청 창 ${p.windows} / 상한 ${cap} (화면 ${DESK_MAX}×16). 소켓 1`, constraints: over ? 1 : 0};
  }
  if (id === 'status') {
    hub.status();
    return {detail: hub.currentState, constraints: 0};
  }
  throw new Error(`미등록 기능: ${id}`);
}

export async function runHubLab(live: RealtimeHub | null, scope: 'all' | HubOpName = 'all', raw?: Partial<LabParams>): Promise<LabReport> {
  const params = clampLabParams(raw);
  const missingOfficial = (Object.keys(HUB_OP_TARGETS) as HubOpName[]).filter((n) => !OFFICIAL.has(n));
  if (scope !== 'all' && !isOfficialHubOp(scope)) throw new Error(`정식 등록되지 않은 기능은 측정·사용할 수 없습니다: ${scope}`);
  const {hub, cache} = labHub(params);
  const pick = scope === 'all' ? LAB_CASES : LAB_CASES.filter((c) => c.id === scope);
  const results: LabCaseResult[] = [];
  for (const c of pick) {
    const started = Date.now();
    let detail = '';
    let constraints = 0;
    let ok = true;
    try {
      const out = await Promise.race([
        runOne(c.id, hub, cache, params),
        sleep(params.deadlineMs + 50).then(() => {
          throw new Error(
            `${c.title}: 합격 한도 ${params.deadlineMs}ms 안에 안 끝났습니다. ${params.codes}종목 분봉·강도가 이 안에 못 오면 실패입니다. 더 돌리지 말고 이 경로를 고치세요.`,
          );
        }),
      ]);
      detail = out.detail;
      constraints = out.constraints;
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;
    const targetMs = params.deadlineMs;
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
    params,
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
