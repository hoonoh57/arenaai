import {writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Candle} from '../core';
import {RealtimeHub} from './hub';
import {HUB_OP_TARGETS, type HubOpName} from './hubOps';
import {DESK_MAX} from '../../shared/desk';
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

export type LabUnitRow = {
  code: string;
  name?: string;
  ms: number;
  ok: boolean;
  bars?: number;
  firstAt?: string;
  firstClose?: number;
  lastAt?: string;
  lastClose?: number;
  simulated?: boolean;
  waitMs?: number;
};

let unitLive: LabUnitLive | null = null;
const unitTimes: number[] = [];
let unitRows: LabUnitRow[] = [];

export function getLabUnitLive(): LabUnitLive | null {
  return unitLive ? {...unitLive} : null;
}

function beginUnits(caseId: string, unit: string, total: number, parallel: number, note: string): void {
  unitTimes.length = 0;
  unitRows = [];
  unitLive = {caseId, unit, done: 0, total, lastCode: '', lastOk: true, lastMs: 0, avgMs: 0, etaMs: 0, parallel, note};
}

function kstBar(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return new Date(sec * 1000).toLocaleString('sv-SE', {timeZone: 'Asia/Seoul'}).replace('T', ' ');
}

function barSpan(candles: Candle[]): Pick<LabUnitRow, 'bars' | 'firstAt' | 'firstClose' | 'lastAt' | 'lastClose'> {
  if (!candles.length) return {bars: 0};
  const a = candles[0];
  const b = candles[candles.length - 1];
  return {
    bars: candles.length,
    firstAt: kstBar(a.time),
    firstClose: a.close,
    lastAt: kstBar(b.time),
    lastClose: b.close,
  };
}

function markUnit(code: string, ok: boolean, ms: number, extra: Partial<LabUnitRow> = {}): void {
  if (!unitLive) return;
  unitRows.push({code, ok, ms: Math.max(0, ms), ...extra});
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

function endUnits(): LabUnitRow[] {
  const rows = unitRows.slice();
  unitLive = null;
  unitRows = [];
  unitTimes.length = 0;
  return rows;
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
  units?: LabUnitRow[];
  perTargetMs?: number;
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

async function runOne(
  id: HubOpName,
  live: RealtimeHub,
  p: LabParams,
  realCodes: string[],
  captured: string[],
  windowCount: number,
): Promise<{detail: string; constraints: number; units?: LabUnitRow[]}> {
  const list = realCodes.slice(0, p.codes);
  const none = {detail: '실종목이 없습니다. 가짜 코드는 쓰지 않습니다.', constraints: 1, units: [] as LabUnitRow[]};
  if (!list.length && id !== 'status' && id !== 'bookSnapshot' && id !== 'demandWindowCap' && id !== 'chartRefreshBudget' && id !== 'unsubscribe') {
    return none;
  }
  if (id === 'ensureChartPage') {
    const wall0 = Date.now();
    const need = list.length;
    const gate = live.restAllowed(Math.min(need, p.chartConcurrency));
    const workers = gate.ok ? Math.min(p.chartConcurrency, Math.max(1, Math.floor(gate.left) || 1)) : 1;
    beginUnits(id, '종목', list.length, workers, '캐시 없이 신규 분봉 · REST 총량 보호');
    await pool(list, workers, async (c) => {
      const t = Date.now();
      const allow = live.restAllowed(1);
      if (!allow.ok) {
        markUnit(c, false, Date.now() - t, {name: c, bars: 0, simulated: false, waitMs: Date.now() - wall0});
        return;
      }
      try {
        const page = await live.ensureChartPage({code: c, timeframe: '1', fresh: true});
        const name = await live.stockName(c).catch(() => c);
        const span = barSpan(page.candles);
        const waitMs = Date.now() - wall0;
        const got = (span.bars || 0) > 0 && Boolean(span.firstAt && span.lastAt);
        markUnit(c, got, Date.now() - t, {name, ...span, simulated: false, waitMs});
      } catch {
        markUnit(c, false, Date.now() - t, {name: c, bars: 0, simulated: false, waitMs: Date.now() - wall0});
      }
    });
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    const inTime = units.filter((u) => u.ok && (u.waitMs || u.ms) <= p.deadlineMs).length;
    const perSec = p.deadlineMs > 0 ? (inTime / p.deadlineMs) * 1000 : 0;
    return {
      detail: `캐시 없이 신규 REST · 받음 ${units.length - fail}/${units.length} · 한도 ${p.deadlineMs}ms 안 ${inTime}종목 · 1초당 약 ${perSec.toFixed(1)}종목${inTime < units.length ? ' · 한도 내 전원 불가 → 분봉 REST만으로는 부족' : ''}`,
      constraints: fail + (inTime < units.length ? 1 : 0),
      units,
    };
  }
  if (id === 'ensureStrengthPage') {
    const gate = live.restAllowed(2);
    const workers = gate.ok ? Math.min(p.chartConcurrency, Math.max(1, Math.floor(gate.left) || 1)) : 1;
    beginUnits(id, '종목', list.length, workers, '체결강도 · REST 총량 보호');
    await pool(list, workers, async (c) => {
      const t = Date.now();
      const allow = live.restAllowed(2);
      if (!allow.ok) {
        markUnit(c, false, 0, {name: c, bars: 0, simulated: false});
        return;
      }
      try {
        await live.ensureChartPage({code: c, timeframe: '1'});
        const s = await live.ensureStrengthPage({code: c, timeframe: '1'});
        const name = await live.stockName(c).catch(() => c);
        const span = barSpan(s.candles);
        markUnit(c, s.ready && (span.bars || 0) > 0, Date.now() - t, {name, ...span, simulated: false});
      } catch {
        markUnit(c, false, Date.now() - t, {name: c, bars: 0, simulated: false});
      }
    });
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `강도 ${units.length - fail}/${units.length}`, constraints: fail, units};
  }
  if (id === 'putChartPage' || id === 'chartPage') {
    beginUnits(id, '종목', list.length, 1, '허브 캐시');
    for (const c of list) {
      const t = Date.now();
      const page = live.pageOf(c, '1', '');
      const span = barSpan(page);
      const name = (await live.stockName(c).catch(() => c)) || c;
      markUnit(c, (span.bars || 0) > 0, Date.now() - t, {name, ...span});
    }
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `캐시 ${units.length - fail}/${units.length} 실봉`, constraints: fail, units};
  }
  if (id === 'getQuote') {
    beginUnits(id, '종목', list.length, 1, '실시간 시세');
    for (const c of list) {
      const t = Date.now();
      const q = live.quoteOf(c);
      const name = (await live.stockName(c).catch(() => c)) || c;
      const ok = Boolean(q && q.price > 0);
      markUnit(c, ok, Date.now() - t, {
        name,
        bars: ok ? 1 : 0,
        firstAt: q?.time ? kstBar(q.time) : '',
        firstClose: q?.price,
        lastAt: q?.time ? kstBar(q.time) : '',
        lastClose: q?.price,
      });
    }
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `시세 ${units.length - fail}/${units.length}`, constraints: fail, units};
  }
  if (id === 'applyLiveTick' || id === 'applyLiveQuote') {
    beginUnits(id, '종목', list.length, 1, '체결 반영');
    for (const c of list) {
      const t = Date.now();
      const q = live.touchQuote(c);
      const page = live.pageOf(c, '1', '');
      const span = barSpan(page);
      const name = (await live.stockName(c).catch(() => c)) || c;
      markUnit(c, Boolean(q && q.price > 0 && (span.bars || 0) > 0), Date.now() - t, {name, ...span});
    }
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `체결반영 ${units.length - fail}/${units.length}`, constraints: fail, units};
  }
  if (id === 'subscribe') {
    const w = live.wssAllowed(0);
    if (!w.ok) return {detail: w.reason || 'WSS 한도', constraints: 1};
    const add = Math.min(list.length, w.left);
    if (!add) return {detail: `WSS 잔여 0/${live.quota().wss.cap}. REG 정지`, constraints: 1};
    try {
      await live.subscribe('hub-lab', list.slice(0, add), ['0B']);
      return {detail: `실구독 시도 ${add} · 잔여 ${live.quota().wss.left}/${live.quota().wss.cap}`, constraints: 0};
    } catch (e) {
      live.ops.noteConstraint('subscribe');
      return {detail: e instanceof Error ? e.message : '거절', constraints: 1};
    }
  }
  if (id === 'unsubscribe') {
    await live.unsubscribe('hub-lab', list.length ? list : realCodes, ['0B']);
    return {detail: '랩 소유만 해제. 데스크 구독은 유지', constraints: 0};
  }
  if (id === 'evaluateSignals') {
    beginUnits(id, '종목', list.length, 1, '신호');
    for (const c of list) {
      const t = Date.now();
      const page = live.pageOf(c, '1', '');
      live.evaluateSignals(c);
      const span = barSpan(page);
      const name = (await live.stockName(c).catch(() => c)) || c;
      markUnit(c, (span.bars || 0) > 0, Date.now() - t, {name, ...span});
    }
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `신호 ${units.length - fail}/${units.length}`, constraints: fail, units};
  }
  if (id === 'bookSnapshot') {
    const snap = live.bookSnapshot();
    return {
      detail: `보유 ${snap.holdings.length} 미체결 ${snap.working.length}`,
      constraints: 0,
      units: snap.holdings.map((h) => ({
        code: h.code,
        name: h.code,
        ms: 0,
        ok: true,
        bars: h.qty,
        lastClose: h.avgPrice,
      })),
    };
  }
  if (id === 'planWatch' || id === 'conditionOne') {
    const cap = captured.slice(0, p.captured);
    const plan = live.planWatch({chartCodes: list, captured: cap, selected: list.slice(0, 1), budget: p.watchBudget});
    return {detail: `실차트 ${list.length} 실포착 ${cap.length} 감시 ${plan.watch.length} 건너뜀 ${plan.skipped}`, constraints: cap.length ? 0 : 1};
  }
  if (id === 'conditionMany') {
    const cap = captured.slice(0, p.captured);
    let watch = 0;
    let skipped = 0;
    live.ops.runSync('conditionMany', () => {
      for (let s = 0; s < p.conditions; s++) {
        const plan = live.planWatch({chartCodes: list, captured: cap, budget: p.watchBudget});
        watch = plan.watch.length;
        skipped = plan.skipped;
      }
    });
    return {detail: `조건 ${p.conditions}회 실포착 ${cap.length} 감시 ${watch} 건너뜀 ${skipped}`, constraints: cap.length ? 0 : 1};
  }
  if (id === 'liveMany') {
    beginUnits(id, '종목', list.length, 1, '다종목 시세');
    for (const c of list) {
      const t = Date.now();
      const q = live.touchQuote(c);
      const page = live.pageOf(c, '1', '');
      const span = barSpan(page);
      const name = (await live.stockName(c).catch(() => c)) || c;
      markUnit(c, Boolean(q && (span.bars || 0) > 0), Date.now() - t, {name, ...span});
    }
    const units = endUnits();
    const fail = units.filter((u) => !u.ok).length;
    return {detail: `다종목 ${units.length - fail}/${units.length}`, constraints: fail, units};
  }
  if (id === 'orderDuplicate') {
    const snap = live.bookSnapshot();
    const held = snap.holdings;
    if (!held.length) return {detail: '실보유 없음. 가짜 주문은 넣지 않습니다.', constraints: 1, units: []};
    return {
      detail: `실보유 ${held.length}종목은 추가 신호매수 거절 대상`,
      constraints: held.length,
      units: held.map((h) => ({code: h.code, ms: 0, ok: true, bars: h.qty, lastClose: h.avgPrice})),
    };
  }
  if (id === 'orderOverLimit') {
    const snap = live.bookSnapshot();
    const n = snap.holdings.length;
    const over = n >= p.maxPositions;
    return {detail: `실보유 ${n} / 한도 ${p.maxPositions}`, constraints: over ? 1 : 0};
  }
  if (id === 'chartRefreshBudget') {
    const charts = list.length;
    const perMin = charts * (60_000 / p.refreshMs);
    const restPerMin = (1000 / Math.max(50, p.restIntervalMs || 300)) * 60;
    const tight = perMin > restPerMin;
    return {
      detail: `실차트 ${charts} × ${(60000 / p.refreshMs).toFixed(1)}회/분 = ${perMin.toFixed(0)} , REST≈${restPerMin.toFixed(0)}/분`,
      constraints: tight ? 1 : 0,
    };
  }
  if (id === 'demandWindowCap') {
    const cap = DESK_MAX * 16;
    const over = windowCount > cap;
    return {detail: `실제 창 ${windowCount} / 상한 ${cap}`, constraints: over ? 1 : 0};
  }
  if (id === 'status') {
    const st = live.status();
    return {detail: `state ${st.state} 구독 ${st.subscriptions} silent ${st.silentMs}`, constraints: st.emergency ? 1 : 0};
  }
  throw new Error(`미등록 기능: ${id}`);
}

export async function runHubLab(
  live: RealtimeHub | null,
  scope: 'all' | HubOpName = 'all',
  raw?: Partial<LabParams>,
  realCodes: string[] = [],
  captured: string[] = [],
  windowCount = 0,
): Promise<LabReport> {
  const params = clampLabParams(raw);
  const missingOfficial = (Object.keys(HUB_OP_TARGETS) as HubOpName[]).filter((n) => !OFFICIAL.has(n));
  if (scope !== 'all' && !isOfficialHubOp(scope)) throw new Error(`정식 등록되지 않은 기능은 측정·사용할 수 없습니다: ${scope}`);
  const uniqReal = [...new Set(realCodes.filter((c) => /^\d{6}$/.test(c)))];
  const uniqCap = [...new Set(captured.filter((c) => /^\d{6}$/.test(c)))];
  if (!live) {
    return {
      at: Date.now(),
      scope,
      params,
      results: (scope === 'all' ? LAB_CASES : LAB_CASES.filter((c) => c.id === scope)).map((c) => ({
        id: c.id,
        title: c.title,
        group: c.group,
        ms: 0,
        targetMs: params.deadlineMs,
        ok: false,
        pass: false,
        detail: '실허브 없음. 가짜 측정은 하지 않습니다.',
        constraints: 1,
      })),
      bottlenecks: ['live'],
      missingOfficial,
    };
  }
  const pick = scope === 'all' ? LAB_CASES : LAB_CASES.filter((c) => c.id === scope);
  const results: LabCaseResult[] = [];
  for (const c of pick) {
    const started = Date.now();
    let detail = '';
    let constraints = 0;
    let ok = true;
    let units: LabUnitRow[] | undefined;
    try {
      const out = await runOne(c.id, live, params, uniqReal, uniqCap, windowCount);
      detail = out.detail;
      constraints = out.constraints;
      units = out.units;
      if ((c.id === 'ensureChartPage' || c.id === 'ensureStrengthPage') && (!units || !units.length)) ok = false;
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;
    const targetMs = params.deadlineMs;
    const perTargetMs = targetMs;
    const cold = c.id === 'ensureChartPage' || c.id === 'ensureStrengthPage';
    const unitFail = Boolean(
      units?.some((u) => !u.ok || (!cold && u.ms > perTargetMs)),
    );
    const inTime = cold
      ? Boolean(units?.length && units.every((u) => u.ok && (u.waitMs || u.ms) <= targetMs))
      : ms <= targetMs;
    const okAll = ok && !unitFail;
    results.push({
      id: c.id,
      title: c.title,
      group: c.group,
      ms,
      targetMs,
      ok: okAll,
      pass: okAll && inTime,
      detail,
      constraints,
      units,
      perTargetMs,
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
