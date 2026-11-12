import 'dotenv/config';
import express from 'express';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import WebSocket from 'ws';
import {Kiwoom} from './kiwoom';
import type {Candle, Stock, Weights} from './core';
import {evaluate} from '../shared/formula';
import {listLocalCodes, loadLocalBars} from './localBars';
import {syncCybosOnStart} from './syncCybos';
import {CONDITION_CATALOG, SAMPLE_0150} from '../shared/conditionCatalog';
import {compileCombo} from '../shared/localConditions';
import {loadLocalConditions, saveLocalConditions} from './localConditions';
import {loadFormulas, saveFormulas} from './formulas';
import {loadDesks, saveDesks} from './desks';
import {backtest} from '../shared/backtest';
import {barReturn, DAY_HOLD_PRESETS, HOLD_PRESETS, indexAtOrBefore, maxReturnFrom, parseSearchAt, returnAfterBars, returnAfterMinutes, summarizeVerify, type VerifyRow} from '../shared/verify';
import {AuditLog} from './realtime/audit';
import {appendAuditFile, loadAppConfig, readAuditFiles, saveAppConfig, listAuditDays, setTradeSession} from './appState';
import {DemandBridge} from './realtime/bridge';
import {SharedCache} from './realtime/cache';
import {RealtimeHub, type WsLike} from './realtime/hub';
import {LimitGovernor, RealtimeCaps} from './realtime/limits';
import {RiskManager} from './realtime/risk';
import {wsUrl} from './realtime/protocol';

const mode = process.env.KIWOOM_MODE || 'real';
if (!['mock', 'real'].includes(mode)) throw new Error('Invalid KIWOOM_MODE');
const interval = Number(process.env.KIWOOM_REQUEST_INTERVAL_MS || 300);
if (!Number.isFinite(interval) || interval < 200) throw new Error('KIWOOM_REQUEST_INTERVAL_MS must be >= 200');

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Local request budgets. The numeric Kiwoom quota is NOT published (only error codes
 * 1700/1701/1702 are documented), so these are conservative, overridable values — see
 * README "중앙 제한" for the unverified list.
 */
const governor = new LimitGovernor({
  total: {capacity: positiveInt('KIWOOM_TOTAL_BURST', 10), refillPerSecond: 1000 / interval},
  perApi: {capacity: positiveInt('KIWOOM_API_BURST', 5), refillPerSecond: 1000 / Math.max(interval, 200)},
  order: {capacity: 1, refillPerSecond: 0.2},
  penaltyMs: positiveInt('KIWOOM_PENALTY_MS', 1000),
  maxWaitMs: positiveInt('KIWOOM_MAX_WAIT_MS', 15000),
});

const audit = new AuditLog({capacity: positiveInt('AUDIT_CAPACITY', 2000), sink: appendAuditFile});
const cache = new SharedCache({
  maxCodes: positiveInt('CACHE_MAX_CODES', 200),
  candleCapacity: positiveInt('CANDLE_CAPACITY', 1200),
});
const caps = new RealtimeCaps({
  maxConnections: 1,
  maxSubscriptions: positiveInt('KIWOOM_REALTIME_MAX_SUBSCRIPTIONS', 100),
  maxItemsPerPacket: positiveInt('KIWOOM_REALTIME_MAX_ITEMS_PER_PACKET', 10),
});

const api = new Kiwoom(mode as 'mock' | 'real', governor, {
  onEvent: (event) => audit.record(event.kind === 'rate-limit' ? 'limit' : 'error', event.message, event.detail),
});

const hub = new RealtimeHub({
  url: wsUrl(mode as 'mock' | 'real'),
  // NOTE: forceRefresh does not bypass the governor — token issuance is queued like any
  // other REST call inside the Kiwoom client.
  getToken: (force = false) => api.accessToken(force),
  governor,
  cache,
  audit,
  caps,
  broker: api,
  orderBroker: {
    stockOrder: (input) => api.stockOrder(input),
    cancelStock: (input) => api.cancelStock(input),
  },
  allowBrokerOrders: mode === 'mock',
  createSocket: (url) => new WebSocket(url) as unknown as WsLike,
  logger: (level, message) => (level === 'error' ? console.error(message) : console.log(message)),
});

/**
 * Risk guard rails for the in-app simulation. These limits are local policy: Kiwoom
 * publishes no verified order-count or loss-limit rules for this project.
 */
const risk = new RiskManager({
  maxPositions: positiveInt('RISK_MAX_POSITIONS', 4),
  maxEntriesPerCode: positiveInt('RISK_MAX_ENTRIES_PER_CODE', 3),
  maxEntriesPerDay: positiveInt('RISK_MAX_ENTRIES_PER_DAY', 20),
  maxConsecutiveLosses: positiveInt('RISK_MAX_CONSECUTIVE_LOSSES', 3),
  cooldownMs: positiveNumber('RISK_COOLDOWN_MS', 5 * 60_000),
  maxDailyLossPct: positiveNumber('RISK_MAX_DAILY_LOSS_PCT', 3),
  startEquity: positiveNumber('RISK_START_EQUITY', 10_000_000),
  maxEntriesPerMinute: positiveInt('RISK_MAX_ENTRIES_PER_MINUTE', 10),
});

if (mode === 'mock') {
  try {
    hub.book.setFillMode('kiwoom-mock');
  } catch (e) {
    console.log(`모의 주문 모드 기본값 실패: ${e instanceof Error ? e.message : e}`);
  }
}

hub.setPositionHooks({
  canEnter: ({code, price, at}) => {
    const decision = risk.canEnter({code, price, at});
    return {allowed: decision.ok, reason: decision.reason};
  },
  onOpen: ({code, price, at}) => risk.onEntry(code, price, at),
  onClose: ({code, entryPrice, exitPrice, at}) => risk.onExit(code, exitPrice - entryPrice, at),
});

const bridge = new DemandBridge({
  hub,
  cache,
  audit,
  // Bound methods only: spreading a class instance would drop its prototype.
  broker: {
    candles: (code: string) => api.candles(code),
    daily: (code: string, baseDate: string) => api.daily(code, baseDate),
  },
  fallbackBudget: 0,
  quoteBudget: positiveInt('KIWOOM_QUOTE_BUDGET', 40),
  quoteTtlMs: positiveNumber('QUOTE_TTL_MS', 30000),
  maxSubscriptions: caps.limits.maxSubscriptions,
});

const REFRESH_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
type AppConfig = {
  condition: string;
  count: number;
  weights: Weights;
  running: boolean;
  refreshMs: number;
  chartCodes: string[];
  /** Default system formula for checked codes without an override. */
  strategyId: string;
  strategyByCode: Record<string, string>;
  tradeByCode: Record<string, 'wait' | 'run' | 'stop' | 'backtest'>;
  autoTopCharts: boolean;
  tradeMode: 'auto' | 'semi';
  orderQty: number;
  tradeSlots: number;
  lockedCodes: string[];
};
const savedCfg = loadAppConfig<AppConfig>();
let config: AppConfig = {
  condition: typeof savedCfg.condition === 'string' ? savedCfg.condition : '',
  count: Number.isInteger(savedCfg.count) ? savedCfg.count as number : 10,
  weights: savedCfg.weights && typeof savedCfg.weights === 'object' ? savedCfg.weights as AppConfig['weights'] : {change: 40, strength: 35, value: 25},
  running: Boolean(savedCfg.running),
  refreshMs: Number.isInteger(savedCfg.refreshMs) ? savedCfg.refreshMs as number : 60_000,
  chartCodes: Array.isArray(savedCfg.chartCodes) ? savedCfg.chartCodes.filter((c): c is string => typeof c === 'string') : [],
  strategyId: typeof savedCfg.strategyId === 'string' ? savedCfg.strategyId : '',
  strategyByCode: savedCfg.strategyByCode && typeof savedCfg.strategyByCode === 'object' ? savedCfg.strategyByCode as AppConfig['strategyByCode'] : {},
  tradeByCode: savedCfg.tradeByCode && typeof savedCfg.tradeByCode === 'object' ? savedCfg.tradeByCode as AppConfig['tradeByCode'] : {},
  autoTopCharts: savedCfg.autoTopCharts !== false,
  tradeMode: savedCfg.tradeMode === 'semi' ? 'semi' : 'auto',
  orderQty: Number.isInteger(savedCfg.orderQty) ? savedCfg.orderQty as number : 1,
  tradeSlots: Number.isInteger(savedCfg.tradeSlots) ? savedCfg.tradeSlots as number : 4,
  lockedCodes: Array.isArray(savedCfg.lockedCodes) ? savedCfg.lockedCodes.filter((c): c is string => typeof c === 'string' && /^\d{6}$/.test(c)) : [],
};
setTradeSession(config.running && config.tradeMode === 'auto');

function bridgeCfg() {
  return {seq: config.condition, count: config.count, weights: config.weights, chartCodes: config.chartCodes};
}

function normalizeChartCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('차트 종목 목록이 올바르지 않습니다.');
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !/^\d{6}$/.test(value) || seen.has(value)) continue;
    seen.add(value);
    codes.push(value);
  }
  if (codes.length > 16) throw new Error('멀티차트는 최대 16종목입니다.');
  return codes;
}
let conditions: {seq: string; name: string}[] = [];
let formulas = loadFormulas();
let localConditions = loadLocalConditions();
let ranking: Stock[] = [];
let updatedAt: number | null = null;
let error = '';
let busy = false;
let revision = 0;

/** Signal evaluation is delegated to the hub; formulas stay in the app layer. */
function systemById(id: string) {
  return formulas.find((f) => f.id === id && f.kind === 'system');
}

function strategyFor(code: string) {
  const override = config.strategyByCode[code];
  if (override) return systemById(override);
  if (config.strategyId) return systemById(config.strategyId);
  return formulas.find((f) => f.enabled && f.kind === 'system') ?? null;
}

function currentEvaluator() {
  return (code: string, closed: Candle[]) => {
    if (!closed.length) return null;
    if (config.tradeMode !== 'auto') return null;
    if ((config.tradeByCode[code] ?? 'wait') !== 'run') return null;
    const system = strategyFor(code);
    if (!system) return null;
    const buy = evaluate(system.expression, closed, system.variables, formulas).at(-1);
    const sell = system.exitExpression ? evaluate(system.exitExpression, closed, system.variables, formulas).at(-1) : false;
    return {buy: Boolean(buy), sell: Boolean(sell)};
  };
}

function normalizeStrategyId(id: unknown): string {
  if (id === undefined || id === null || id === '') return '';
  if (typeof id !== 'string') throw new Error('전략 ID가 올바르지 않습니다.');
  if (!systemById(id)) throw new Error('시스템 수식이 아닙니다. 수식 관리자에서 시스템트레이딩 수식을 만드세요.');
  return id;
}

function syncSignals(): void {
  const anyRun = config.chartCodes.some((code) => (config.tradeByCode[code] ?? 'wait') === 'run');
  hub.setSignalEvaluator(anyRun ? currentEvaluator() : null);
}

function applyRanking(result: {ranking: Stock[]; selected: Stock[]; warnings: Record<string, string>}): void {
  ranking = result.ranking;
  updatedAt = Date.now();
  for (const [code, reason] of Object.entries(result.warnings)) cache.setWarning(code, reason);
  void followTopCharts();
}

let followBusy = false;
async function followTopCharts(): Promise<void> {
  if (!config.autoTopCharts || followBusy) return;
  const slots = Math.min(8, Math.max(1, config.tradeSlots));
  const snap = hub.book.snapshot();
  const held = new Set([...snap.holdings.map((h) => h.code), ...snap.working.map((o) => o.code), ...config.lockedCodes]);
  const keep = config.chartCodes.filter((c) => held.has(c));
  const ranked = ranking.filter((s) => Number.isFinite(s.score) && s.score >= 0 && !held.has(s.code)).map((s) => s.code);
  const captured = bridge.capturedList().map((r) => r.code).filter((c) => !held.has(c));
  const pool = ranked.length ? ranked : captured;
  const fill = pool.slice(0, Math.max(0, slots - keep.length));
  const top = [...keep, ...fill];
  if (!top.length) return;
  if (top.join(',') === config.chartCodes.join(',')) return;
  followBusy = true;
  try {
    const tradeByCode = {...config.tradeByCode};
    for (const code of fill) {
      if (config.running && config.tradeMode === 'auto') tradeByCode[code] = 'run';
      else if (!tradeByCode[code]) tradeByCode[code] = 'wait';
    }
    config = {...config, chartCodes: top, tradeByCode};
    hub.orderQty = config.orderQty;
    saveAppConfig(config);
    syncSignals();
    const result = await bridge.syncSubscriptions(bridgeCfg());
    ranking = result.ranking;
    updatedAt = Date.now();
    const todayOpen = Math.floor(Date.parse(`${new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'})}T08:00:00+09:00`) / 1000);
    for (const code of fill) {
      if (!cache.candles(code).length) {
        const local = loadLocalBars(code, '1');
        if (local.length) cache.mergeCandles(code, local);
      }
      const last = cache.lastCandleTime(code) ?? 0;
      if (last >= todayOpen) continue;
      try {
        await bridge.refreshChart(code);
      } catch {
        /* 한 번만 오늘 봉을 채움. 실패해도 갭 신호는 품질검사에서 막음 */
      }
    }
    if (config.tradeMode === 'auto') bridge.reevaluate(top);
  } catch (e) {
    error = e instanceof Error ? e.message : '상위 종목 차트 갱신 실패';
  } finally {
    followBusy = false;
  }
}

async function refreshRanking(): Promise<void> {
  const result = await bridge.computeRanking(bridgeCfg());
  applyRanking(result);
}

let rankingTimer: NodeJS.Timeout | null = null;
function scheduleRanking(): void {
  if (rankingTimer) return;
  rankingTimer = setTimeout(() => {
    rankingTimer = null;
    if (!config.condition) return;
    void refreshRanking().catch((e: unknown) => {
      error = e instanceof Error ? e.message : '순위 계산 오류';
    });
  }, 5000);
  rankingTimer.unref?.();
}
cache.onUpdate(() => scheduleRanking());

async function applyConfig(next: typeof config): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    config = next;
    revision += 1;
    hub.orderQty = config.orderQty;
    syncSignals();
    saveAppConfig(config);
    setTradeSession(config.running && config.tradeMode === 'auto');
    const result = await bridge.apply(bridgeCfg());
    applyRanking(result);
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : '설정 적용 오류';
    throw e;
  } finally {
    busy = false;
  }
}

const app = express();
app.use(express.json({limit: '16kb'}));
app.get('/api/state', (_req, res) =>
  res.json({
    mode,
    config,
    conditions,
    ranking,
    captured: bridge.capturedList(),
    lastSearch: bridge.lastSearch,
    candles: bridge.candlesByCode(config.chartCodes),
    updatedAt,
    error,
    busy,
    positions: bridge.positions(),
    events: bridge.events(),
    formulas,
    dataWarnings: bridge.warnings(),
    realtime: bridge.status(),
    risk: risk.snapshot(),
    audit: audit.list(20),
    orderMode: hub.book.mode === 'kiwoom-mock' ? 'kiwoom-mock' : 'assumed-fill',
    book: hub.book.snapshot(),
  }),
);
app.post('/api/chart', async (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const timeframe = typeof req.body?.timeframe === 'string' ? req.body.timeframe : '1';
    const baseDate = typeof req.body?.baseDate === 'string' ? req.body.baseDate : '';
    const nextKey = typeof req.body?.nextKey === 'string' ? req.body.nextKey : '';
    const localBars = !nextKey ? loadLocalBars(code, timeframe) : [];
    const liveBars = !nextKey && (timeframe === '1' || timeframe === 'D') ? cache.candles(code) : [];
    const mergeByTime = (...lists: Candle[][]) => {
      const map = new Map<number, Candle>();
      for (const list of lists) for (const c of list) map.set(c.time, c);
      return [...map.values()].sort((a, b) => a.time - b.time);
    };
    let candles = mergeByTime(localBars, liveBars);
    const todayOpen = Math.floor(Date.parse(`${new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Seoul'})}T08:00:00+09:00`) / 1000);
    if (!nextKey && timeframe === '1' && (candles.at(-1)?.time ?? 0) < todayOpen) {
      try {
        const page = await api.chartPage({code, timeframe, baseDate, nextKey: undefined});
        candles = mergeByTime(candles, page.candles);
        if (page.candles.length) cache.mergeCandles(code, page.candles);
      } catch {
        /* 오늘 봉 1회 보충 실패 시 공백 신호는 차단 */
      }
    }
    if (candles.length && !nextKey) {
      if (req.body?.withStrength) {
        try {
          candles = await api.attachStrength(code, timeframe, candles);
        } catch {
          /* keep */
        }
      }
      const listed = ranking.find((s) => s.code === code);
      const fetched = await api.stockName(code).catch(() => '');
      const name = fetched && fetched !== code ? fetched : listed?.name && listed.name !== code ? listed.name : fetched || listed?.name || code;
      res.json({code, name, candles, hasMore: false, nextKey: '', timeframe});
      return;
    }
    const page = await api.chartPage({code, timeframe, baseDate, nextKey: nextKey || undefined});
    candles = mergeByTime(candles, page.candles);
    if (timeframe === '1' && candles.length) cache.mergeCandles(code, candles);
    if (req.body?.withStrength) {
      try {
        candles = await api.attachStrength(code, timeframe, candles);
      } catch {
        /* 체결강도는 선택. 가격 봉은 그대로 반환 */
      }
    }
    const listed = ranking.find((s) => s.code === code);
    const fetched = await api.stockName(code).catch(() => '');
    const name = fetched && fetched !== code ? fetched : listed?.name && listed.name !== code ? listed.name : fetched || listed?.name || code;
    res.json({
      code,
      name,
      candles,
      hasMore: page.hasMore,
      nextKey: page.nextKey,
      timeframe,
    });
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '차트 조회 실패'});
  }
});
app.get('/api/audit', (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({error: 'limit은 1~500이어야 합니다.'});
  res.json({entries: audit.list(limit), counts: audit.counts()});
});
app.post('/api/book/mode', (req, res) => {
  try {
    const next = hub.book.setFillMode(req.body?.mode === 'kiwoom-mock' ? 'kiwoom-mock' : 'assumed');
    res.json({ok: true, fillMode: next, book: hub.book.snapshot()});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '체결 모드 변경 실패'});
  }
});
app.post('/api/book/buy', async (req, res) => {
  try {
    const {code, type, limitPrice, qty} = req.body ?? {};
    if (typeof code !== 'string') throw new Error('종목코드를 확인하세요.');
    const order = await hub.book.buy(code, type === 'limit' ? 'limit' : 'market', Number(limitPrice) || undefined, qty === undefined ? config.orderQty : Number(qty));
    hub.noteBookOrder(order);
    res.json({ok: true, order, book: hub.book.snapshot()});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '모의 매수 실패'});
  }
});
app.post('/api/book/sell', async (req, res) => {
  try {
    const {code, type, limitPrice, qty} = req.body ?? {};
    if (typeof code !== 'string') throw new Error('종목코드를 확인하세요.');
    const order = await hub.book.sell(code, type === 'limit' ? 'limit' : 'market', Number(limitPrice) || undefined, qty === undefined ? undefined : Number(qty));
    hub.noteBookOrder(order);
    res.json({ok: true, order, book: hub.book.snapshot()});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '모의 매도 실패'});
  }
});
app.post('/api/book/flatten', async (req, res) => {
  try {
    const orders = await hub.book.flatten(req.body?.type === 'limit' ? 'limit' : 'market');
    for (const order of orders) hub.noteBookOrder(order);
    res.json({ok: true, orders, book: hub.book.snapshot()});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '일괄 청산 실패'});
  }
});
app.post('/api/book/cancel', async (req, res) => {
  try {
    const id = req.body?.id;
    const code = req.body?.code;
    if (typeof id === 'string' && id) {
      res.json({ok: true, order: await hub.book.cancel(id), book: hub.book.snapshot()});
      return;
    }
    const n = await hub.book.cancelAll(typeof code === 'string' ? code : undefined);
    res.json({ok: true, cancelled: n, book: hub.book.snapshot()});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '미체결 취소 실패'});
  }
});
app.post('/api/risk/reset', (_req, res) => {
  risk.resetDay();
  audit.record('risk', '운영자가 당일 위험 카운터를 초기화했습니다.');
  res.json({ok: true, risk: risk.snapshot()});
});
app.get('/api/desks', (_req, res) => {
  try { res.json(loadDesks()); }
  catch (e) { res.status(500).json({error: e instanceof Error ? e.message : '가상화면 조회 실패'}); }
});
app.put('/api/desks', (req, res) => {
  try {
    const workspace = saveDesks(req.body);
    res.json(workspace);
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '가상화면 저장 실패'});
  }
});
app.post('/api/tr', async (req, res) => {
  const id = req.body?.id;
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  try {
    if (id === 'ka10171') {
      const list = await bridge.loadConditions();
      res.json({id, data: list});
      return;
    }
    if (id === 'ka10080') {
      if (!/^\d{6}$/.test(code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
      res.json({id, code, data: await api.candles(code)});
      return;
    }
    if (id === 'ka10046') {
      if (!/^\d{6}$/.test(code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
      res.json({id, code, data: await api.strengthSnapshot(code)});
      return;
    }
    res.status(400).json({error: '허용된 TR만 조회할 수 있습니다: ka10171, ka10080, ka10046'});
  } catch (e) {
    res.status(502).json({error: e instanceof Error ? e.message : 'TR 조회 실패'});
  }
});
app.put('/api/formulas', (req, res) => {
  try {
    const updated = saveFormulas(req.body.formulas);
    formulas = updated;
    revision += 1;
    syncSignals();
    bridge.reevaluate(config.chartCodes);
    res.json({formulas});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '수식 저장 실패'});
  }
});
app.post('/api/backtest', (req, res) => {
  try {
    const {code, feeBps, slippageBps, positionMode, stopLossPct, takeProfitPct, startDate, endDate} = req.body;
    const system = formulas.find((f) => f.enabled && f.kind === 'system');
    if (typeof code !== 'string') throw new Error('종목 코드를 확인하세요.');
    if (!system) throw new Error('활성 시스템 전략이 없습니다.');
    const candles = bridge.candles(code);
    if (!candles.length) throw new Error('현재 차트에 표시된 종목만 테스트할 수 있습니다.');
    const parseDate = (v: unknown, end: boolean): number | undefined => {
      if (v === undefined || v === '') return undefined;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('날짜 형식을 확인하세요.');
      const ms = Date.parse(`${v}T00:00:00+09:00`);
      if (!Number.isFinite(ms) || new Date(ms + 9 * 3600000).toISOString().slice(0, 10) !== v) throw new Error('유효한 날짜를 입력하세요.');
      return Math.floor(ms / 1000) + (end ? 86399 : 0);
    };
    const startTime = parseDate(startDate, false), endTime = parseDate(endDate, true);
    const closed = candles.filter((c) => c.time + 60 <= Math.floor(Date.now() / 1000));
    if (closed.length < 2) throw new Error('확정 1분봉이 부족합니다.');
    res.json({code, strategy: system.name, updatedAt, ...backtest(closed, system, formulas, feeBps, {slippageBps, positionMode, stopLossPct, takeProfitPct, startTime, endTime})});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '백테스트 실패'});
  }
});
app.post('/api/local-scan', (req, res) => {
  try {
    const expression = typeof req.body?.expression === 'string' ? req.body.expression : SAMPLE_0150;
    const timeframe = typeof req.body?.timeframe === 'string' ? req.body.timeframe : 'D';
    const listed = listLocalCodes(timeframe === 'D' ? 'D' : '1');
    const raw = Array.isArray(req.body?.codes) ? req.body.codes : listed;
    const codes = [...new Set(raw.filter((c: unknown) => typeof c === 'string' && /^\d{6}$/.test(c)))].slice(0, 5000) as string[];
    if (!codes.length) throw new Error(`로컬 봉이 없습니다. ${process.env.BARS_DIR || 'data/bars'}/D|1/종목.bar 를 Convert-CybosToBars.ps1 로 만드세요.`);
    const hits: {code: string; close: number; time: number}[] = [];
    for (const code of codes) {
      const bars = loadLocalBars(code, timeframe);
      if (bars.length < 2) continue;
      const v = evaluate(expression, bars);
      if (v.at(-1)) hits.push({code, close: bars[bars.length - 1].close, time: bars[bars.length - 1].time});
    }
    res.json({expression, timeframe, scanned: codes.length, hits, catalog: CONDITION_CATALOG});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '로컬 조건검색 실패'});
  }
});
app.get('/api/local-scan/catalog', (_req, res) => {
  res.json({catalog: CONDITION_CATALOG, sample: SAMPLE_0150, dir: process.env.BARS_DIR || 'data/bars', saved: localConditions});
});
app.get('/api/local-conditions', (_req, res) => {
  res.json({saved: localConditions});
});
app.put('/api/local-conditions', (req, res) => {
  try {
    localConditions = saveLocalConditions(req.body?.saved);
    res.json({saved: localConditions});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '조건식 저장 실패'});
  }
});
app.post('/api/verify', async (req, res) => {
  try {
    const formulaId = typeof req.body?.formulaId === 'string' ? req.body.formulaId : '';
    const formula = formulas.find((f) => f.id === formulaId && (f.kind === 'signal' || f.kind === 'system' || f.kind === 'highlight'));
    const localConditionId = typeof req.body?.localConditionId === 'string' ? req.body.localConditionId : '';
    const savedCond = localConditions.find((c) => c.id === localConditionId);
    const localExpr = savedCond ? compileCombo(savedCond.rows, savedCond.combo) : '';
    const conditionName = typeof req.body?.conditionName === 'string' ? req.body.conditionName.slice(0, 80) : '';
    const searchDate = typeof req.body?.searchDate === 'string' ? req.body.searchDate : '';
    const searchTime = typeof req.body?.searchTime === 'string' ? req.body.searchTime : '09:00';
    const minuteReq = Boolean(req.body?.minute);
    const tf = savedCond?.timeframe === '1' || savedCond?.timeframe === 'D' ? savedCond.timeframe : (minuteReq ? '1' : 'D');
    const minute = tf !== 'D';
    const holdMinutes = Number(req.body?.holdMinutes);
    const holdMax = minute ? 60 * 24 * 20 : 400;
    if (!Number.isInteger(holdMinutes) || holdMinutes < 1 || holdMinutes > holdMax) throw new Error('수익률기간을 확인하세요.');
    const searchAt = parseSearchAt(searchDate, minute ? searchTime : '15:30');
    const extraCols = minute
      ? [10, 30, holdMinutes].filter((v, i, a) => a.indexOf(v) === i)
      : [1, 5, holdMinutes].filter((v, i, a) => a.indexOf(v) === i);
    const minVolume = Number(req.body?.minVolume) || 0;
    const minMarketCap = Number(req.body?.minMarketCap) || 0;
    const maxMarketCap = Number(req.body?.maxMarketCap) || 0;
    const listedOnly = req.body?.listedOnly !== false;
    const raw = Array.isArray(req.body?.codes) ? req.body.codes : [];
    let codes = [...new Set(raw.filter((c: unknown) => typeof c === 'string' && /^\d{6}$/.test(c)))] as string[];
    if (localExpr) {
      if (!codes.length) codes = listLocalCodes(tf === 'D' ? 'D' : '1');
      codes = codes.slice(0, 5000);
    } else {
      codes = codes.slice(0, 16);
    }
    if (!codes.length) throw new Error('검증 종목이 없습니다. 로컬 0150을 고르거나 조건검색 포착 종목을 넣으세요.');
    const rows: VerifyRow[] = [];
    for (const code of codes) {
      const candles = localExpr ? loadLocalBars(code, tf) : (await api.chartPage({code, timeframe: tf})).candles;
      const listed = ranking.find((s) => s.code === code);
      const name = listed?.name && listed.name !== code ? listed.name : code;
      const empty: VerifyRow = {code, name, matched: false, searchPrice: null, endPrice: null, returnPct: null, maxReturnPct: null, returns: {}};
      if (candles.length < 2) {
        if (!localExpr) rows.push(empty);
        continue;
      }
      const times = candles.map((c) => c.time);
      const closes = candles.map((c) => c.close);
      const searchIdx = indexAtOrBefore(times, searchAt);
      const bar = searchIdx >= 0 ? candles[searchIdx] : undefined;
      if (listedOnly && bar) {
        const day = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
        if (day(bar.time) !== searchDate) {
          if (!localExpr) rows.push(empty);
          continue;
        }
      }
      if (minVolume > 0 && (bar?.volume || 0) < minVolume) continue;
      if (minMarketCap > 0 && (bar?.marketCap || 0) < minMarketCap) continue;
      if (maxMarketCap > 0 && (bar?.marketCap || 0) > maxMarketCap) continue;
      const holdEnd = minute
        ? indexAtOrBefore(times, searchAt + holdMinutes * 60)
        : searchIdx >= 0 ? searchIdx + holdMinutes : -1;
      const maxEnd = minute ? holdEnd : searchIdx >= 0 ? Math.min(Math.max(holdEnd, searchIdx), closes.length - 1) : -1;
      const matched = formula
        ? searchIdx >= 0 && Boolean(evaluate(formula.expression, candles, formula.variables, formulas)[searchIdx])
        : localExpr
          ? searchIdx >= 0 && Boolean(evaluate(localExpr, candles)[searchIdx])
          : searchIdx >= 0;
      if (localExpr && !matched) continue;
      const searchPrice = searchIdx >= 0 ? closes[searchIdx] : null;
      const returns: Record<string, number | null> = {};
      for (const m of extraCols) {
        returns[String(m)] = matched && searchIdx >= 0
          ? (minute ? returnAfterMinutes(closes, times, searchIdx, m) : returnAfterBars(closes, searchIdx, m))
          : null;
      }
      rows.push({
        code,
        name,
        matched,
        searchPrice,
        endPrice: holdEnd >= 0 && holdEnd < closes.length ? closes[holdEnd] : null,
        volume: bar?.volume,
        returnPct: matched && searchIdx >= 0
          ? (minute ? barReturn(searchPrice || 0, holdEnd >= 0 ? closes[holdEnd] : 0) : returnAfterBars(closes, searchIdx, holdMinutes))
          : null,
        maxReturnPct: matched ? maxReturnFrom(closes, searchIdx, maxEnd) : null,
        returns,
      });
      if (localExpr && rows.length >= 300) break;
    }
    const holdLabel = minute
      ? (HOLD_PRESETS.find((p) => p.id === holdMinutes)?.label || `${holdMinutes}분간`)
      : (DAY_HOLD_PRESETS.find((p) => p.id === holdMinutes)?.label || `${holdMinutes}일`);
    res.json({
      formula: formula?.name || savedCond?.name || conditionName || '조건식',
      searchDate,
      searchTime,
      searchAt,
      holdMinutes,
      holdLabel,
      minute,
      extraCols,
      ...summarizeVerify(rows),
      universe: rows.length,
    });
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '성과검증 실패'});
  }
});
app.post('/api/conditions', async (_req, res) => {
  try {
    conditions = await bridge.loadConditions();
    res.json({conditions});
  } catch (e) {
    res.status(502).json({error: e instanceof Error ? e.message : '조회 실패'});
  }
});
let lastRecapture = 0;
app.post('/api/recapture', async (_req, res) => {
  try {
    if (!config.condition) throw new Error('조건식을 선택하세요.');
    if (Date.now() - lastRecapture < 60_000) throw new Error('재포착은 1분에 한 번입니다.');
    lastRecapture = Date.now();
    await applyConfig({...config});
    res.json({ok: true, captured: bridge.capturedList(), ranking});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '재포착 실패'});
  }
});
app.post('/api/autotop', (req, res) => {
  config = {...config, autoTopCharts: req.body?.autoTopCharts !== false};
  saveAppConfig(config);
  res.json({ok: true, autoTopCharts: config.autoTopCharts});
});
app.post('/api/lock', (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!/^\d{6}$/.test(code)) throw new Error('종목코드가 올바르지 않습니다.');
    const on = req.body?.locked !== false;
    const lockedCodes = on ? [...new Set([...config.lockedCodes, code])] : config.lockedCodes.filter((c) => c !== code);
    config = {...config, lockedCodes};
    saveAppConfig(config);
    res.json({ok: true, lockedCodes});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '잠금 실패'});
  }
});
app.get('/api/logs', (req, res) => {
  const tab = req.query.tab === 'trade' ? 'trade' : 'system';
  const day = typeof req.query.day === 'string' && /^\d{8}$/.test(req.query.day) ? req.query.day : undefined;
  res.json({tab, days: listAuditDays(), entries: readAuditFiles(tab, day).slice(0, 500)});
});
app.post('/api/strategy', async (req, res) => {
  try {
    const formulaId = normalizeStrategyId(req.body?.formulaId);
    const code = req.body?.code;
    if (code === undefined || code === '') {
      config = {...config, strategyId: formulaId};
    } else {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
      const strategyByCode = {...config.strategyByCode};
      if (formulaId) strategyByCode[code] = formulaId;
      else delete strategyByCode[code];
      config = {...config, strategyByCode};
    }
    syncSignals();
    bridge.reevaluate(config.chartCodes);
    res.json({ok: true, config});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '전략 설정 실패'});
  }
});
app.post('/api/trade', async (req, res) => {
  try {
    const code = req.body?.code;
    const status = req.body?.status;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
    if (status !== 'wait' && status !== 'run' && status !== 'stop' && status !== 'backtest') throw new Error('상태는 대기/적용/백테스트입니다.');
    if (!config.chartCodes.includes(code)) throw new Error('멀티차트에 없는 종목입니다.');
    config = {...config, tradeByCode: {...config.tradeByCode, [code]: status}, running: status === 'run' || config.chartCodes.some((c) => (c === code ? status : config.tradeByCode[c]) === 'run')};
    syncSignals();
    if (status === 'run') bridge.reevaluate([code]);
    res.json({ok: true, config});
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '종목 전략 상태 변경 실패'});
  }
});
app.post('/api/charts', async (req, res) => {
  try {
    const chartCodes = normalizeChartCodes(req.body?.codes);
    if (config.running && chartCodes.length === 0) {
      res.status(400).json({error: '모의 매매 중에는 차트 종목을 모두 해제할 수 없습니다. 먼저 전략을 중지하세요.'});
      return;
    }
    const previous = config.chartCodes;
    const strategyByCode = {...config.strategyByCode};
    for (const code of previous) {
      if (!chartCodes.includes(code)) delete strategyByCode[code];
    }
    const tradeByCode = {...config.tradeByCode};
    for (const code of previous) {
      if (!chartCodes.includes(code)) delete tradeByCode[code];
    }
    for (const code of chartCodes) {
      if (!tradeByCode[code]) tradeByCode[code] = 'wait';
    }
    config = {...config, chartCodes, strategyByCode, tradeByCode, running: config.running && chartCodes.length > 0};
    syncSignals();
    if (config.condition) {
      const result = await bridge.syncSubscriptions(bridgeCfg());
      applyRanking(result);
    } else {
      hub.setActiveCodes(chartCodes);
    }
    const added = chartCodes.filter((code) => !previous.includes(code));
    res.json({ok: true, config, ranking});
    void (async () => {
      for (const code of added) {
        try {
          await bridge.refreshChart(code);
        } catch (e) {
          cache.setWarning(code, e instanceof Error ? e.message : '분봉 조회 실패');
        }
      }
      if (added.length) bridge.reevaluate(added);
    })();
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '차트 종목 설정 실패'});
  }
});
app.post('/api/config', async (req, res) => {
  const {condition, count, weights, running, refreshMs} = req.body;
  let chartCodes: string[];
  try {
    chartCodes = req.body.chartCodes === undefined ? config.chartCodes : normalizeChartCodes(req.body.chartCodes);
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : '차트 종목 설정 실패'});
    return;
  }
  if (
    typeof condition !== 'string' ||
    !conditions.some((c) => c.seq === condition) ||
    !Number.isInteger(count) || count < 1 || count > 40 ||
    typeof running !== 'boolean' ||
    !weights ||
    !['change', 'strength', 'value'].every((k) => typeof weights[k] === 'number' && Number.isFinite(weights[k]) && weights[k] >= 0 && weights[k] <= 100) ||
    weights.change + weights.strength + weights.value <= 0 ||
    !(REFRESH_MS as readonly number[]).includes(refreshMs)
  ) {
    res.status(400).json({error: '설정값을 확인하세요. 표시 종목 1~40, 갱신 주기 15/30/60/120/300초, 가중치 합 > 0.'});
    return;
  }
  const autoTopCharts = req.body.autoTopCharts === undefined ? config.autoTopCharts : Boolean(req.body.autoTopCharts);
  if (running && chartCodes.length === 0 && !autoTopCharts) {
    res.status(400).json({error: '멀티차트에 체크한 종목이 있어야 모의 매매를 시작할 수 있습니다.'});
    return;
  }
  if (condition !== config.condition) {
    updatedAt = null;
    error = '';
    chartCodes = [];
  }
  try {
    let strategyId = config.strategyId;
    let strategyByCode = condition !== config.condition ? {} : config.strategyByCode;
    try {
      if (req.body.strategyId !== undefined) strategyId = normalizeStrategyId(req.body.strategyId);
    } catch (e) {
      res.status(400).json({error: e instanceof Error ? e.message : '전략 설정 실패'});
      return;
    }
    const tradeMode = req.body.tradeMode === 'semi' ? 'semi' : req.body.tradeMode === 'auto' ? 'auto' : config.tradeMode;
    const orderQty = Number.isInteger(req.body.orderQty) && req.body.orderQty >= 1 && req.body.orderQty <= 1000 ? req.body.orderQty : config.orderQty;
    const tradeSlots = Number.isInteger(req.body.tradeSlots) && req.body.tradeSlots >= 1 && req.body.tradeSlots <= 8 ? req.body.tradeSlots : config.tradeSlots;
    const tradeByCode = {...(condition !== config.condition ? {} : config.tradeByCode)};
    for (const code of chartCodes) {
      if (running && tradeMode === 'auto') tradeByCode[code] = 'run';
      else if (!tradeByCode[code]) tradeByCode[code] = 'wait';
    }
    hub.orderQty = orderQty;
    const next: AppConfig = {
      condition,
      count,
      weights: {change: weights.change, strength: weights.strength, value: weights.value},
      running,
      refreshMs,
      chartCodes,
      strategyId,
      strategyByCode,
      tradeByCode,
      autoTopCharts,
      tradeMode,
      orderQty,
      tradeSlots,
      lockedCodes: config.lockedCodes,
    };
    await applyConfig(next);
    restartRefreshTimer();
    res.json({ok: true, config, realtime: bridge.status().hub});
  } catch (e) {
    res.status(502).json({error: e instanceof Error ? e.message : '설정 적용 실패'});
  }
});
app.post('/api/refresh', (_req, res) => {
  void (async () => {
    try {
      const result = await bridge.syncSubscriptions(bridgeCfg());
      applyRanking(result);
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : '갱신 실패';
    }
  })();
  res.json({ok: true});
});

const server = createServer(app);
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    allowedHosts: true,
    watch: {ignored: ['**/data/**', '**/.venv/**', '**/google_drive/**']},
  },
  appType: 'spa',
});
app.use(vite.middlewares);
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`Dashboard listening on ${process.env.PORT || 3000} (${mode})`);
  syncCybosOnStart();
});

/**
 * Startup: bring up the single realtime session. A configured condition is then restored.
 * No full re-poll loop exists any more: quotes arrive over the session, and only the
 * selected codes' candles are refreshed (governed REST) on a slow timer or when a tick
 * shows a new minute has started.
 */
async function restoreConditions(): Promise<void> {
  try {
    conditions = await bridge.loadConditions();
    audit.record('state', '조건식 목록을 자동 조회했습니다.', {count: conditions.length});
    if (!config.condition || !conditions.some((c) => c.seq === config.condition)) return;
    await applyConfig({...config});
  } catch (e) {
    error = e instanceof Error ? e.message : '조건식 복원 실패';
  }
}

void (async () => {
  hub.onReady(() => {
    void restoreConditions();
  });
  try {
    await hub.start();
  } catch (e) {
    error = e instanceof Error ? e.message : '실시간 연결 실패';
  }
  if (hub.isReady && !conditions.length) await restoreConditions();
})();

/**
 * User-configured refresh. Re-ranks the condition list from the live cache, keeps
 * subscriptions aligned, and refreshes candles only for checkbox-selected chart codes.
 */
async function maintenanceTick(): Promise<void> {
  if (!config.condition || !hub.isReady) return;
  try {
    const result = await bridge.syncSubscriptions(bridgeCfg());
    applyRanking(result);
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : '주기 유지보수 실패';
  }
}

let candleTimer: NodeJS.Timeout | null = null;
function restartRefreshTimer(): void {
  if (candleTimer) clearInterval(candleTimer);
  candleTimer = setInterval(() => void maintenanceTick(), config.refreshMs);
  candleTimer.unref?.();
}
restartRefreshTimer();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    audit.record('state', `프로세스 종료 신호(${signal})를 받았습니다.`);
    hub.stop();
    server.close(() => process.exit(0));
  });
}

