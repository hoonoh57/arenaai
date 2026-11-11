import 'dotenv/config';
import express from 'express';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import WebSocket from 'ws';
import {Kiwoom} from './kiwoom';
import type {Candle, Stock, Weights} from './core';
import {evaluate} from '../shared/formula';
import {loadFormulas, saveFormulas} from './formulas';
import {backtest} from '../shared/backtest';
import {AuditLog} from './realtime/audit';
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

const audit = new AuditLog({capacity: positiveInt('AUDIT_CAPACITY', 2000)});
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
    strengthSnapshot: (code: string) => api.strengthSnapshot(code),
  },
  quoteBudget: positiveInt('KIWOOM_QUOTE_BUDGET', 40),
  quoteTtlMs: positiveNumber('QUOTE_TTL_MS', 30000),
  maxSubscriptions: caps.limits.maxSubscriptions,
});

let config = {condition: '', count: 4, weights: {change: 40, strength: 35, value: 25} as Weights, running: false};
let conditions: {seq: string; name: string}[] = [];
let formulas = loadFormulas();
let ranking: Stock[] = [];
let updatedAt: number | null = null;
let error = '';
let busy = false;
let revision = 0;

/** Signal evaluation is delegated to the hub; formulas stay in the app layer. */
function currentEvaluator() {
  const system = formulas.find((f) => f.enabled && f.kind === 'system');
  if (!system) return null;
  return (code: string, closed: Candle[]) => {
    void code;
    if (!closed.length) return null;
    const buy = evaluate(system.expression, closed, system.variables, formulas).at(-1);
    const sell = system.exitExpression ? evaluate(system.exitExpression, closed, system.variables, formulas).at(-1) : false;
    return {buy: Boolean(buy), sell: Boolean(sell)};
  };
}

function syncSignals(): void {
  hub.setSignalEvaluator(config.running ? currentEvaluator() : null);
}

function applyRanking(result: {ranking: Stock[]; selected: Stock[]; warnings: Record<string, string>}): void {
  ranking = result.ranking;
  updatedAt = Date.now();
  for (const [code, reason] of Object.entries(result.warnings)) cache.setWarning(code, reason);
}

async function refreshRanking(): Promise<void> {
  const result = await bridge.computeRanking({seq: config.condition, count: config.count, weights: config.weights});
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
  }, 1000);
  rankingTimer.unref?.();
}
cache.onUpdate(() => scheduleRanking());

async function applyConfig(next: typeof config): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    config = next;
    revision += 1;
    syncSignals();
    const result = await bridge.apply({seq: config.condition, count: config.count, weights: config.weights});
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
    candles: bridge.candlesByCode(ranking.slice(0, config.count).map((s) => s.code)),
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
    orderMode: 'simulation-only',
  }),
);
app.get('/api/audit', (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({error: 'limit은 1~500이어야 합니다.'});
  res.json({entries: audit.list(limit), counts: audit.counts()});
});
app.post('/api/risk/reset', (_req, res) => {
  risk.resetDay();
  audit.record('risk', '운영자가 당일 위험 카운터를 초기화했습니다.');
  res.json({ok: true, risk: risk.snapshot()});
});
app.put('/api/formulas', (req, res) => {
  try {
    const updated = saveFormulas(req.body.formulas);
    formulas = updated;
    revision += 1;
    syncSignals();
    bridge.reevaluate(ranking.slice(0, config.count).map((s) => s.code));
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
app.post('/api/conditions', async (_req, res) => {
  try {
    conditions = await bridge.loadConditions();
    res.json({conditions});
  } catch (e) {
    res.status(502).json({error: e instanceof Error ? e.message : '조회 실패'});
  }
});
app.post('/api/config', async (req, res) => {
  const {condition, count, weights, running} = req.body;
  if (
    typeof condition !== 'string' ||
    !conditions.some((c) => c.seq === condition) ||
    !Number.isInteger(count) || count < 1 || count > 10 ||
    typeof running !== 'boolean' ||
    !weights ||
    !['change', 'strength', 'value'].every((k) => typeof weights[k] === 'number' && Number.isFinite(weights[k]) && weights[k] >= 0 && weights[k] <= 100) ||
    weights.change + weights.strength + weights.value <= 0
  ) {
    res.status(400).json({error: '설정값을 확인하세요.'});
    return;
  }
  if (condition !== config.condition) {
    ranking = [];
    updatedAt = null;
    error = '';
  }
  try {
    await applyConfig({condition, count, weights: {change: weights.change, strength: weights.strength, value: weights.value}, running});
    res.json({ok: true, realtime: bridge.status().hub});
  } catch (e) {
    res.status(502).json({error: e instanceof Error ? e.message : '설정 적용 실패'});
  }
});
app.post('/api/refresh', (_req, res) => {
  void (async () => {
    try {
      const result = await bridge.syncSubscriptions({seq: config.condition, count: config.count, weights: config.weights});
      applyRanking(result);
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : '갱신 실패';
    }
  })();
  res.json({ok: true});
});

const server = createServer(app);
const vite = await createViteServer({server: {middlewareMode: true, allowedHosts: true}, appType: 'spa'});
app.use(vite.middlewares);
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Dashboard listening on ${process.env.PORT || 3000} (${mode})`));

/**
 * Startup: bring up the single realtime session. A configured condition is then restored.
 * No full re-poll loop exists any more: quotes arrive over the session, and only the
 * selected codes' candles are refreshed (governed REST) on a slow timer or when a tick
 * shows a new minute has started.
 */
void (async () => {
  try {
    await hub.start();
  } catch (e) {
    error = e instanceof Error ? e.message : '실시간 연결 실패';
  }
  hub.onReady(async () => {
    try {
      if (!config.condition) return;
      const result = await bridge.syncSubscriptions({seq: config.condition, count: config.count, weights: config.weights});
      applyRanking(result);
    } catch (e) {
      error = e instanceof Error ? e.message : '재연결 복구 실패';
    }
  });
})();

const candleSyncMs = positiveInt('CANDLE_SYNC_MS', 60000);

/**
 * Slow maintenance tick. It does NOT re-poll the whole condition list: it only aligns
 * subscriptions with the current selection and refreshes the ≤10 selected codes'
 * candles (the one data set that is REST-only), all through the governed lane.
 */
async function maintenanceTick(): Promise<void> {
  if (!config.condition || !hub.isReady) return;
  try {
    const result = await bridge.syncSubscriptions({seq: config.condition, count: config.count, weights: config.weights});
    applyRanking(result);
    for (const stock of result.selected) {
      try {
        await bridge.refreshChart(stock.code);
      } catch (e) {
        cache.setWarning(stock.code, e instanceof Error ? e.message : '분봉 갱신 실패');
      }
    }
    error = '';
  } catch (e) {
    error = e instanceof Error ? e.message : '주기 유지보수 실패';
  }
}

const candleTimer = setInterval(() => void maintenanceTick(), candleSyncMs);
candleTimer.unref?.();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    audit.record('state', `프로세스 종료 신호(${signal})를 받았습니다.`);
    hub.stop();
    server.close(() => process.exit(0));
  });
}

