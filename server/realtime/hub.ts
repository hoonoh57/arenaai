import type {Candle, PreviousDay} from '../core';
import type {Quote} from './protocol';
import {
  conditionEvent,
  decodeEvents,
  isPing,
  kstDate,
  loginPacket,
  parseFrame,
  pingEcho,
  quoteFromEvent,
  registerPacket,
  removePacket,
  returnCode,
  sectorFromEvent,
  stockInfoFromEvent,
  type ParsedFrame,
  type RealtimeFrame,
} from './protocol';
import {AuditLog} from './audit';
import {SharedCache} from './cache';
import {classifyMessage, LimitGovernor, RealtimeCaps, type RealtimeLimits} from './limits';
import {KeyedDedup, SignalDedup} from './ring';
import {ChartGate} from './chartGate';
import {HubOps} from './hubOps';
import {planSubscriptions} from './plan';
import {signalDataStatus} from '../data-quality';
import {SimulationBook, type BookHooks, type MockOrderBroker} from './book';

export type HubState = 'idle' | 'connecting' | 'logging-in' | 'ready' | 'reconnecting' | 'closed';

export type WsLike = {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  on(event: 'open' | 'message' | 'error' | 'close', handler: (...args: any[]) => void): void;
  removeAllListeners?(): void;
};

export type WsFactory = (url: string) => WsLike;

export type BrokerLike = {
  candles(code: string): Promise<Candle[]>;
  daily(code: string, baseDate: string): Promise<{date: string; open?: number; high?: number; low?: number; close?: number}[]>;
  chartPage?: (input: {
    code: string;
    timeframe: string;
    baseDate?: string;
    nextKey?: string;
    singlePage?: boolean;
  }) => Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}>;
  attachStrength?: (
    code: string,
    timeframe: string,
    candles: Candle[],
    nextKey?: string,
  ) => Promise<{candles: Candle[]; hasMore: boolean; nextKey: string; ready: boolean; nxt: boolean}>;
  stockName?: (code: string) => Promise<string>;
};

export type SignalEvaluator = (code: string, closed: Candle[]) => {buy: boolean; sell: boolean; score?: number; filters?: string[]} | null;

/**
 * Optional guards around the simulated position. `canEnter` may only *block*; exits are
 * never gated because a risk system must not trap a position.
 */
export type PositionHooks = BookHooks;

export type HubDeps = {
  url: string;
  getToken: (force?: boolean) => Promise<string>;
  governor: LimitGovernor;
  cache: SharedCache;
  audit: AuditLog;
  broker?: BrokerLike;
  createSocket?: WsFactory;
  caps?: RealtimeCaps;
  now?: () => number;
  random?: () => number;
  logger?: (level: 'info' | 'error', message: string) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  loginTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** No frame at all for this long → treat the link as dead and reconnect. */
  staleMs?: number;
  candleRefreshDebounceMs?: number;
  signalDedupSize?: number;
  orderBroker?: MockOrderBroker;
  allowBrokerOrders?: boolean;
  onKpi?: (ev: {code: string; side: 'buy' | 'sell'; close: number; time: number; filters: string[]}) => void;
};

type Subscription = {item: string; type: string; owners: Set<string>};

export type HubStatus = {
  state: HubState;
  connected: boolean;
  reconnects: number;
  lastFrameAt: number | null;
  lastDataAt: number | null;
  lastError: string | null;
  subscriptions: number;
  subscriptionsByType: Record<string, number>;
  pendingRequests: number;
  candlesRefreshed: number;
  duplicatesDropped: number;
  caps: RealtimeLimits & {verified: false};
  lastLoginAt: number | null;
  silentMs: number | null;
  dataSilentMs: number | null;
  warnAfterMs: number;
  emergency: boolean;
  link: 'ok' | 'warn' | 'dead';
  rest: {
    used: number;
    left: number;
    cap: number;
    refillPerSecond: number;
    waitForOneMs: number;
    cooldownMs: number;
    acquired: number;
    maxWaitMs: number;
  };
  wss: {used: number; left: number; cap: number; packet: number};
};

export type SimulatedEvent = {time: number; code: string; side: string; price: number};

/**
 * Central realtime manager.
 *
 * Owns the single WebSocket session (login, keepalive, reconnect, register/unregister),
 * the shared cache writes, limit accounting, duplicate suppression, simulated signal
 * processing and the audit trail. Demand logic must go through `bridge.ts` instead of
 * touching the broker directly.
 */
export class RealtimeHub {
  private state: HubState = 'idle';
  private socket: WsLike | null = null;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly caps: RealtimeCaps;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly governor: LimitGovernor;
  private readonly cache: SharedCache;
  private readonly audit: AuditLog;
  private readonly dedup: KeyedDedup;
  private readonly signalDedup: SignalDedup;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly loginTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly staleMs: number;
  private readonly warnMs: number;
  private url: string;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, {resolve: (frame: RealtimeFrame) => void; reject: (error: Error) => void; timer: any}>();
  private readonly refreshTimers = new Map<string, any>();
  private readonly events: SimulatedEvent[] = [];
  readonly book: SimulationBook;
  readonly ops: HubOps;
  private readonly chartGate = new ChartGate();
  private loginWaiter: {resolve: () => void; reject: (error: Error) => void} | null = null;
  private watchdog: any = null;
  private reconnectTimer: any = null;
  private subChain: Promise<void> = Promise.resolve();
  private attempt = 0;
  private reconnects = 0;
  private lastFrameAt: number | null = null;
  private lastDataAt: number | null = null;
  private lastLoginAt: number | null = null;
  private lastError: string | null = null;
  private candlesRefreshed = 0;
  private duplicatesDropped = 0;
  private activeCodes = new Set<string>();
  private evaluator: SignalEvaluator | null = null;
  bestScoreOnly = false;
  private pendingBuys = new Map<string, {bar: Candle; score: number; filters: string[]}>();
  private kpiFilters = new Map<string, string[]>();
  private bestTimer: ReturnType<typeof setTimeout> | null = null;
  orderQty = 1;
  private readonly readyHandlers = new Set<() => void | Promise<void>>();
  private hooks: PositionHooks = {};

  constructor(private readonly deps: HubDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.governor = deps.governor;
    this.cache = deps.cache;
    this.audit = deps.audit;
    this.caps = deps.caps ?? new RealtimeCaps();
    this.reconnectBaseMs = deps.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? 30000;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? 10000;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15000;
    this.staleMs = deps.staleMs ?? 30_000;
    this.warnMs = Math.min(this.staleMs, 30_000);
    this.url = deps.url;
    this.debounceMs = deps.candleRefreshDebounceMs ?? 2000;
    this.dedup = new KeyedDedup({ttlMs: 5000, max: 20000});
    this.signalDedup = new SignalDedup(deps.signalDedupSize ?? 20000);
    this.ops = new HubOps(this.now);
    this.book = new SimulationBook({
      cache: this.cache,
      audit: this.audit,
      now: this.now,
      hooks: () => this.hooks,
      broker: deps.orderBroker,
      allowBroker: deps.allowBrokerOrders,
    });
    if (!Number.isFinite(this.reconnectBaseMs) || this.reconnectBaseMs < 10) throw new Error('재연결 기본 지연 시간이 올바르지 않습니다.');
    if (!Number.isFinite(this.staleMs) || this.staleMs < 1000) throw new Error('무응답 판정 시간이 올바르지 않습니다.');
  }

  get currentState(): HubState {
    return this.state;
  }

  /** Live connection + session established. */
  get isReady(): boolean {
    return this.state === 'ready';
  }

  setSignalEvaluator(evaluator: SignalEvaluator | null): void {
    this.evaluator = evaluator;
  }

  /**
   * Called after every successful (re)login and subscription restore, so demand logic
   * can refresh snapshots that may have gone stale while the link was down.
   */
  onReady(handler: () => void | Promise<void>): () => void {
    this.readyHandlers.add(handler);
    return () => this.readyHandlers.delete(handler);
  }

  setPositionHooks(hooks: PositionHooks): void {
    this.hooks = hooks;
  }

  noteBookOrder(order: {status: string; fillPrice: number | null; fillAt: number | null; code: string; side: 'buy' | 'sell'}): void {
    if (order.status !== 'filled' || !order.fillPrice) return;
    this.pushEvent({
      time: order.fillAt ?? this.now(),
      code: order.code,
      side: order.side === 'buy' ? '모의 매수 체결' : '모의 매도 체결',
      price: order.fillPrice,
    });
  }

  /** 신호 평가 종목. 차트 창 표시·가상화면과 무관하게 허브가 돌린다. */
  setActiveCodes(codes: readonly string[]): void {
    this.activeCodes = new Set(codes);
  }

  /** 창은 REST를 치지 않는다. 허브 게이트 한 장. */
  async ensureChartPage(input: {
    code: string;
    timeframe: string;
    baseDate?: string;
    nextKey?: string;
    fresh?: boolean;
  }): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}> {
    return this.ops.run('ensureChartPage', async () => {
      const broker = this.deps.broker;
      if (!broker?.chartPage) throw new Error('차트 REST가 허브에 없습니다.');
      const cached = this.ops.runSync('chartPage', () =>
        this.cache.chartPage(input.code, input.timeframe, input.baseDate || ''),
      );
      if (!input.fresh && cached.length && !this.restAllowed(1).ok) {
        return {candles: cached, hasMore: false, nextKey: ''};
      }
      if (!this.restAllowed(1).ok && !cached.length) {
        return {candles: [], hasMore: true, nextKey: ''};
      }
      const key = this.chartGate.key({
        kind: 'chart',
        code: input.code,
        timeframe: input.timeframe,
        baseDate: input.baseDate || '',
        nextKey: input.nextKey || '',
      });
      if (input.fresh) this.chartGate.drop(key);
      const page = await this.chartGate.load(key, () =>
        broker.chartPage!({
          code: input.code,
          timeframe: input.timeframe,
          baseDate: input.baseDate,
          nextKey: input.nextKey,
          singlePage: true,
        }),
      );
      if (page.candles.length) {
        this.ops.runSync('putChartPage', () => {
          this.cache.putChartPage(input.code, input.timeframe, input.baseDate || '', page.candles);
        });
      }
      return page;
    });
  }

  /** 체결강도. 08:30(NXT)/09:00(KRX)까지 빈 봉을 채우되, REST 총량이 허용하는 페이지만. */
  async ensureStrengthPage(input: {
    code: string;
    timeframe: string;
    baseDate?: string;
    nextKey?: string;
  }): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string; ready: boolean; nxt: boolean}> {
    return this.ops.run('ensureStrengthPage', async () => {
      const broker = this.deps.broker;
      if (!broker?.attachStrength) throw new Error('체결강도 REST가 허브에 없습니다.');
      let candles =
        this.ops.runSync('chartPage', () => this.cache.chartPage(input.code, input.timeframe, input.baseDate || '')) || [];
      let next = input.nextKey || '';
      let last = {candles, hasMore: false, nextKey: '', ready: false, nxt: false};
      for (let i = 0; i < 40; i++) {
        if (!this.restAllowed(1).ok) break;
        const key = this.chartGate.key({
          kind: 'strength',
          code: input.code,
          timeframe: input.timeframe,
          next,
        });
        const attached = await this.chartGate.load(key, () =>
          broker.attachStrength!(input.code, input.timeframe, candles, next || undefined),
        );
        last = attached;
        candles = attached.candles.length ? attached.candles : candles;
        if (attached.candles.length) {
          this.ops.runSync('putChartPage', () => {
            this.cache.putChartPage(input.code, input.timeframe, input.baseDate || '', attached.candles);
          });
        }
        const empty = candles.filter((c) => !(typeof c.strength === 'number' && c.strength > 0)).length;
        if (attached.ready || empty === 0) break;
        if (!attached.hasMore || !attached.nextKey || attached.nextKey === next) break;
        next = attached.nextKey;
      }
      return last;
    });
  }

  stockName(code: string): Promise<string> {
    return this.deps.broker?.stockName ? this.deps.broker.stockName(code) : Promise.resolve(code);
  }

  clearChartMemo(): void {
    this.chartGate.clear();
  }

  planWatch(input: {chartCodes: readonly string[]; captured: readonly string[]; selected?: readonly string[]; budget?: number}) {
    return this.ops.runSync('planWatch', () =>
      planSubscriptions({
        selected: [...input.chartCodes, ...(input.selected || [])],
        captured: input.captured,
        maxSubscriptions: this.caps.limits.maxSubscriptions,
        budget: input.budget ?? 40,
      }),
    );
  }

  bookSnapshot() {
    return this.ops.runSync('bookSnapshot', () => this.book.snapshot());
  }

  quoteOf(code: string) {
    return this.ops.runSync('getQuote', () => this.cache.getQuote(code));
  }

  pageOf(code: string, timeframe = '1', baseDate = '') {
    return this.ops.runSync('chartPage', () => this.cache.chartPage(code, timeframe, baseDate));
  }

  touchQuote(code: string) {
    return this.ops.runSync('applyLiveTick', () => {
      const q = this.cache.getQuote(code);
      if (!q || !(q.price > 0)) return null;
      const t = q.time ?? Math.floor(this.now() / 1000);
      this.cache.applyLiveTick(code, t, q.price, q.tradeVolume ?? undefined, q.strength ?? undefined);
      this.ops.runSync('applyLiveQuote', () => this.cache.applyLiveQuote(code, t, q.price, q.tradeVolume ?? undefined));
      return q;
    });
  }

  positionsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.book.snapshot().holdings.map((row) => [row.code, row.qty]));
  }

  eventsSnapshot(limit = 50): SimulatedEvent[] {
    return this.events.slice(0, limit);
  }

  status(): HubStatus {
    return this.ops.runSync('status', () => this.statusUnmetered());
  }

  private statusUnmetered(): HubStatus {
    const byType: Record<string, number> = {};
    for (const sub of this.subscriptions.values()) byType[sub.type] = (byType[sub.type] ?? 0) + 1;
    const now = this.now();
    const silentMs = this.lastFrameAt === null ? (this.lastLoginAt ? now - this.lastLoginAt : null) : now - this.lastFrameAt;
    const dataSilentMs = this.lastDataAt === null ? null : now - this.lastDataAt;
    const warnAfterMs = this.warnMs;
    let link: 'ok' | 'warn' | 'dead' = 'dead';
    if (this.state === 'ready' && silentMs !== null && silentMs < warnAfterMs) link = silentMs > warnAfterMs / 2 ? 'warn' : 'ok';
    else if (this.state === 'connecting' || this.state === 'logging-in' || this.state === 'reconnecting') link = 'warn';
    const emergency = this.state === 'closed' || (silentMs !== null && silentMs >= warnAfterMs);
    return {
      state: this.state,
      connected: this.state === 'ready',
      reconnects: this.reconnects,
      lastFrameAt: this.lastFrameAt,
      lastDataAt: this.lastDataAt,
      lastError: this.lastError,
      subscriptions: this.subscriptions.size,
      subscriptionsByType: byType,
      pendingRequests: this.pending.size,
      candlesRefreshed: this.candlesRefreshed,
      duplicatesDropped: this.duplicatesDropped,
      caps: {...this.caps.limits, verified: false},
      lastLoginAt: this.lastLoginAt,
      silentMs,
      dataSilentMs,
      warnAfterMs,
      emergency,
      link,
      rest: this.restBudget(),
      wss: this.wssBudget(),
    };
  }

  restBudget() {
    const b = this.governor.budget();
    return {
      used: b.used,
      left: b.left,
      cap: b.cap,
      refillPerSecond: b.refillPerSecond,
      waitForOneMs: b.waitForOneMs,
      cooldownMs: b.cooldownMs,
      acquired: b.acquired,
      maxWaitMs: b.maxWaitMs,
    };
  }

  wssBudget() {
    const cap = this.caps.limits.maxSubscriptions;
    const used = this.subscriptions.size;
    return {used, left: Math.max(0, cap - used), cap, packet: this.caps.limits.maxItemsPerPacket};
  }

  quota() {
    return {rest: this.restBudget(), wss: this.wssBudget()};
  }

  /** 총량을 넘기면 호출하지 말 것. 대기 한도를 넘으면 거절. */
  restAllowed(n = 1): {ok: boolean; waitMs: number; left: number; reason?: string} {
    const b = this.governor.budget();
    const waitMs = this.governor.waitFor(n);
    if (waitMs > b.maxWaitMs) {
      return {ok: false, waitMs, left: b.left, reason: `REST 잔여 ${b.left.toFixed(1)}/${b.cap} · 대기 ${waitMs}ms > 한도 ${b.maxWaitMs}ms. 초과 요청 정지`};
    }
    return {ok: true, waitMs, left: b.left};
  }

  /**
   * 수요 표준 요청. 차트·강도·시세·구독은 여기만. 총량 밖이면 held=true 와 캐시.
   */
  async ask(input: {
    owner: string;
    op:
      | 'chart'
      | 'strength'
      | 'live'
      | 'quote'
      | 'name'
      | 'watch'
      | 'book'
      | 'buy'
      | 'sell'
      | 'flatten'
      | 'cancel'
      | 'system';
    code?: string;
    timeframe?: string;
    baseDate?: string;
    nextKey?: string;
    items?: readonly string[];
    types?: readonly string[];
    fresh?: boolean;
    qty?: number;
    orderType?: 'market' | 'limit';
    limitPrice?: number;
    orderId?: string;
  }): Promise<{
    ok: boolean;
    held: boolean;
    reason?: string;
    candles: Candle[];
    hasMore: boolean;
    nextKey: string;
    quote: Quote | null;
    name?: string;
    ready?: boolean;
    nxt?: boolean;
    book?: ReturnType<RealtimeHub['bookSnapshot']>;
    order?: unknown;
    orders?: unknown[];
    cancelled?: number;
    status?: HubStatus;
    quota?: ReturnType<RealtimeHub['quota']>;
  }> {
    const tf = input.timeframe || '1';
    const base = input.baseDate || '';
    const code = input.code || '';
    const empty = {ok: false, held: false, candles: [] as Candle[], hasMore: false, nextKey: '', quote: null as Quote | null};
    try {
      if (input.op === 'name') {
        const name = code ? await this.stockName(code) : '';
        return {...empty, ok: true, name};
      }
      if (input.op === 'quote') {
        return {...empty, ok: true, quote: code ? this.quoteOf(code) : null};
      }
      if (input.op === 'watch') {
        const items = [...(input.items || [])].filter((c) => /^\d{6}$/.test(c));
        const types = input.types?.length ? [...input.types] : ['0B'];
        if (!items.length) return {...empty, ok: true, held: true, reason: '종목 없음'};
        const room = this.wssAllowed(0);
        if (!room.ok) return {...empty, ok: true, held: true, reason: room.reason};
        await this.subscribe(input.owner || 'demand', items, types);
        return {...empty, ok: true};
      }
      if (input.op === 'book' || input.op === 'system') {
        const book = this.bookSnapshot();
        return {
          ...empty,
          ok: true,
          book,
          status: input.op === 'system' ? this.status() : undefined,
          quota: input.op === 'system' ? this.quota() : undefined,
        };
      }
      if (input.op === 'buy' || input.op === 'sell') {
        if (!/^\d{6}$/.test(code)) return {...empty, reason: '종목코드', book: this.bookSnapshot()};
        const type = input.orderType === 'limit' ? 'limit' : 'market';
        const order =
          input.op === 'buy'
            ? await this.book.buy(code, type, input.limitPrice, input.qty)
            : await this.book.sell(code, type, input.limitPrice, input.qty);
        this.noteBookOrder(order);
        return {...empty, ok: true, order, book: this.bookSnapshot(), quote: this.quoteOf(code)};
      }
      if (input.op === 'flatten') {
        const orders = await this.book.flatten(input.orderType === 'limit' ? 'limit' : 'market');
        for (const order of orders) this.noteBookOrder(order);
        return {...empty, ok: true, orders, book: this.bookSnapshot()};
      }
      if (input.op === 'cancel') {
        if (input.orderId) {
          const order = await this.book.cancel(input.orderId);
          return {...empty, ok: true, order, book: this.bookSnapshot()};
        }
        const cancelled = await this.book.cancelAll(code && /^\d{6}$/.test(code) ? code : undefined);
        return {...empty, ok: true, cancelled, book: this.bookSnapshot()};
      }
      if (!/^\d{6}$/.test(code)) return {...empty, reason: '종목코드'};
      if (input.op === 'live') {
        return {
          ...empty,
          ok: true,
          candles: this.liveBars(code, tf, base),
          quote: this.quoteOf(code),
        };
      }
      if (input.op === 'chart') {
        const allow = this.restAllowed(1);
        if (!allow.ok && !input.fresh) {
          const candles = this.pageOf(code, tf, base);
          return {...empty, ok: candles.length > 0, held: true, reason: allow.reason, candles, quote: this.quoteOf(code)};
        }
        const page = await this.ensureChartPage({code, timeframe: tf, baseDate: base, nextKey: input.nextKey, fresh: input.fresh});
        return {...empty, ok: true, candles: page.candles, hasMore: page.hasMore, nextKey: page.nextKey, quote: this.quoteOf(code)};
      }
      if (input.op === 'strength') {
        const allow = this.restAllowed(1);
        if (!allow.ok) {
          const candles = this.pageOf(code, tf, base);
          return {...empty, ok: candles.length > 0, held: true, reason: allow.reason, candles, quote: this.quoteOf(code)};
        }
        const page = await this.ensureStrengthPage({code, timeframe: tf, baseDate: base, nextKey: input.nextKey});
        return {
          ...empty,
          ok: true,
          candles: page.candles,
          hasMore: page.hasMore,
          nextKey: page.nextKey,
          ready: page.ready,
          nxt: page.nxt,
          quote: this.quoteOf(code),
        };
      }
      return {...empty, reason: `미등록 수요: ${input.op}`};
    } catch (e) {
      const cached = code ? this.pageOf(code, tf, base) : [];
      return {
        ...empty,
        ok: cached.length > 0,
        held: true,
        reason: e instanceof Error ? e.message : '수요 거절',
        candles: cached,
        quote: code ? this.quoteOf(code) : null,
      };
    }
  }

  liveBars(code: string, timeframe = '1', baseDate = ''): Candle[] {
    const quote = this.cache.getQuote(code);
    let candles = this.cache.chartPage(code, timeframe, baseDate);
    if (timeframe === '1') {
      const ring = this.cache.candles(code);
      if (ring.length && (!candles.length || (ring[ring.length - 1].time > (candles.at(-1)?.time || 0)))) {
        const byTime = new Map(candles.map((c) => [c.time, c]));
        for (const c of ring) {
          const had = byTime.get(c.time);
          byTime.set(
            c.time,
            had
              ? {
                  ...had,
                  close: c.close,
                  high: Math.max(had.high, c.high),
                  low: had.low > 0 ? Math.min(had.low, c.low) : c.low,
                  ...(typeof c.volume === 'number' ? {volume: c.volume} : {}),
                  ...(typeof c.strength === 'number' ? {strength: c.strength} : {}),
                }
              : c,
          );
        }
        candles = [...byTime.values()].sort((a, b) => a.time - b.time);
        let lastStr: number | undefined;
        candles = candles.map((c) => {
          if (typeof c.strength === 'number' && c.strength > 0) lastStr = c.strength;
          else if (lastStr) return {...c, strength: lastStr};
          return c;
        });
      }
    }
    if (quote && quote.price > 0 && candles.length) {
      const last = candles[candles.length - 1];
      const str = typeof quote.strength === 'number' && quote.strength > 0 ? quote.strength : last.strength;
      if (last.close !== quote.price || str !== last.strength) {
        candles = candles.slice();
        candles[candles.length - 1] = {
          ...last,
          close: quote.price,
          high: Math.max(last.high, quote.price),
          low: last.low > 0 ? Math.min(last.low, quote.price) : quote.price,
          ...(typeof str === 'number' ? {strength: str} : {}),
        };
      }
    }
    return candles;
  }

  wssAllowed(add = 0): {ok: boolean; left: number; reason?: string} {
    const w = this.wssBudget();
    if (w.used + add > w.cap) {
      return {ok: false, left: w.left, reason: `WSS 구독 ${w.used}/${w.cap}. REG 정지`};
    }
    return {ok: true, left: w.left};
  }

  /** Start the manager: connect, login, and keep the session alive. */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'closed') throw new Error('종료된 실시간 관리자는 다시 시작할 수 없습니다.');
    await this.connect();
    this.startWatchdog();
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkStale(), Math.max(250, Math.min(5000, Math.floor(this.staleMs / 4))));
    this.watchdog.unref?.();
  }

  /** Exposed for tests and for the periodic tick; reconnects when the link is silent. */
  checkStale(): void {
    if (this.state !== 'ready') return;
    const seen = this.lastFrameAt ?? this.lastLoginAt ?? this.now();
    if (this.now() - seen <= this.staleMs) return;
    this.lastError = '실시간 무응답';
    this.audit.record('error', '실시간 메시지가 오래 도착하지 않아 연결을 재설정합니다.', {silentMs: this.now() - seen});
    this.forceReconnect('무응답');
  }

  private async connect(): Promise<void> {
    this.state = this.attempt === 0 ? 'connecting' : 'reconnecting';
    this.lastError = null;
    this.audit.record('connection', this.attempt === 0 ? '실시간 연결을 시작합니다.' : '실시간 재연결을 시도합니다.', {attempt: this.attempt});
    let token: string;
    try {
      token = await this.deps.getToken();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : '토큰 발급 실패';
      this.audit.record('error', '실시간 로그인 토큰을 얻지 못했습니다.', {error: this.lastError});
      this.scheduleReconnect();
      return;
    }
    // At most one credential-refresh retry: a token error must not become a login loop.
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      try {
        await this.openSession(token);
        this.state = 'ready';
        this.attempt = 0;
        this.lastLoginAt = this.now();
        this.lastFrameAt = this.now();
        this.audit.record('connection', '실시간 세션이 준비되었습니다.', {subscriptions: this.subscriptions.size});
        await this.resubscribeAll();
        for (const handler of this.readyHandlers) {
          try {
            await handler();
          } catch (error) {
            this.audit.record('error', '세션 준비 후속 작업이 실패했습니다.', {error: error instanceof Error ? error.message : '오류'});
          }
        }
        return;
      } catch (error) {
        const authExpired = (error as {authExpired?: boolean}).authExpired === true;
        this.lastError = error instanceof Error ? error.message : '실시간 세션 시작 실패';
        this.audit.record('error', '실시간 세션을 시작하지 못했습니다.', {error: this.lastError, authExpired});
        this.closeSocket();
        if (authExpired && authAttempt === 0) {
          this.audit.record('connection', '접근 토큰이 만료되어 재발급 후 다시 로그인합니다.');
          try {
            token = await this.deps.getToken(true);
          } catch (refreshError) {
            this.lastError = refreshError instanceof Error ? refreshError.message : '토큰 재발급 실패';
            this.audit.record('error', '토큰 재발급에 실패했습니다.', {error: this.lastError});
            this.scheduleReconnect();
            return;
          }
          this.state = 'logging-in';
          continue;
        }
        this.scheduleReconnect();
        return;
      }
    }
  }

  /** Open one socket and complete LOGIN. Throws with `authExpired` on token errors. */
  private async openSession(token: string): Promise<void> {
    const createSocket = this.deps.createSocket;
    if (!createSocket) {
      this.state = 'closed';
      throw new Error('WebSocket 구현이 주입되지 않았습니다.');
    }
    this.caps.assertConnection(1);
    const socket = createSocket(this.url);
    this.socket = socket;
    socket.on('message', (data: unknown) => this.handleMessage(data));
    socket.on('error', (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : 'WebSocket 오류';
      this.audit.record('error', 'WebSocket 오류가 발생했습니다.', {error: this.lastError});
    });
    socket.on('close', () => {
      if (this.state === 'closed' || this.socket !== socket) return;
      this.audit.record('connection', 'WebSocket 연결이 종료되었습니다.');
      this.failPending(new Error('실시간 연결이 종료되었습니다.'));
      this.scheduleReconnect();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('실시간 연결 시간 초과')), this.loginTimeoutMs);
      timer.unref?.();
      socket.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.state = 'logging-in';
    await this.login(token);
  }

  private async login(token: string): Promise<void> {
    const socket = this.socket;
    if (!socket) throw new Error('실시간 연결이 없습니다.');
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiter = null;
        reject(new Error('실시간 로그인 응답 시간 초과'));
      }, this.loginTimeoutMs);
      timer.unref?.();
      this.loginWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.loginWaiter = null;
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.loginWaiter = null;
          reject(error);
        },
      };
    });
    socket.send(JSON.stringify(loginPacket(token)));
    await ack;
  }

  private handleMessage(data: unknown): void {
    this.lastFrameAt = this.now();
    let frame: ParsedFrame;
    try {
      frame = parseFrame(data);
    } catch (error) {
      this.audit.record('error', '실시간 응답을 해석하지 못했습니다.', {error: error instanceof Error ? error.message : '오류'});
      return;
    }
    if (isPing(frame)) {
      try {
        const echo = pingEcho(frame);
        this.socket?.send(typeof echo === 'string' ? echo : JSON.stringify(echo));
      } catch (error) {
        this.audit.record('error', 'PING 응답 전송에 실패했습니다.', {error: error instanceof Error ? error.message : '오류'});
      }
      return;
    }
    if (frame.trnm === 'LOGIN') {
      const code = returnCode(frame);
      if (code !== null && code !== 0) {
        const error = Object.assign(new Error(String(frame.return_msg ?? `실시간 로그인 실패 (${code})`)), {
          authExpired: classifyMessage(code, frame.return_msg) === 'auth-expired',
          returnCode: code,
        });
        this.loginWaiter?.reject(error);
        return;
      }
      this.loginWaiter?.resolve();
      return;
    }
    if (frame.trnm === 'REAL') {
      this.handleReal(frame);
      return;
    }
    const response = frame as RealtimeFrame;
    const waiter = this.pending.get(response.trnm);
    if (waiter) {
      this.pending.delete(response.trnm);
      clearTimeout(waiter.timer);
      const code = returnCode(response);
      if (code !== null && code !== 0) {
        if (classifyMessage(code, response.return_msg) === 'rate-limit') this.governor.penalize();
        waiter.reject(new Error(`키움 실시간 요청 실패 (${code}): ${String(response.return_msg ?? '')}`));
        return;
      }
      waiter.resolve(response);
      return;
    }
    if (response.trnm === 'SYSTEM') {
      this.audit.record('state', '키움 SYSTEM 프레임을 수신했습니다.', {frame: response as Record<string, unknown>});
    }
  }

  private handleReal(frame: RealtimeFrame): void {
    this.lastDataAt = this.now();
    const today = kstDate(this.now());
    const receivedAt = this.now();
    for (const event of decodeEvents(frame)) {
      const dedupKey = `${event.type}|${event.item}|${event.values['20'] ?? ''}|${event.values['13'] ?? ''}|${event.values['10'] ?? ''}`;
      if (!this.dedup.seen(dedupKey, receivedAt)) {
        this.duplicatesDropped += 1;
        continue;
      }
      if (event.type === '0B' || event.type === '0A') {
        const quote = quoteFromEvent(event, today, receivedAt);
        if (!quote) {
          this.audit.record('error', '실시간 체결 값을 해석하지 못했습니다.', {type: event.type, item: event.item});
          continue;
        }
        this.cache.setQuote(quote);
        for (const fill of this.book.onQuote(quote.code, quote.price)) {
          this.pushEvent({time: fill.fillAt ?? receivedAt, code: fill.code, side: fill.side === 'buy' ? '모의 매수 체결' : '모의 매도 체결', price: fill.fillPrice ?? quote.price});
        }
        if (quote.time !== null) {
          const bar = this.ops.runSync('applyLiveQuote', () =>
            this.cache.applyLiveQuote(quote.code, quote.time!, quote.price, quote.tradeVolume ?? undefined),
          );
          this.ops.runSync('applyLiveTick', () =>
            this.cache.applyLiveTick(quote.code, quote.time!, quote.price, quote.tradeVolume ?? undefined, quote.strength ?? undefined),
          );
          if (bar === 'new') this.evaluateSignals(quote.code);
        } else if (quote.price > 0) {
          this.ops.runSync('applyLiveTick', () =>
            this.cache.applyLiveTick(quote.code, Math.floor(receivedAt / 1000), quote.price, quote.tradeVolume ?? undefined, quote.strength ?? undefined),
          );
        }
        continue;
      }
      if (event.type === '0g') {
        const info = stockInfoFromEvent(event, receivedAt);
        if (info) this.cache.setStockInfo(info);
        continue;
      }
      if (event.type === '0J' || event.type === '0U') {
        const sector = sectorFromEvent(event, today, receivedAt);
        if (sector) this.cache.setSector(sector);
        continue;
      }
      const capture = conditionEvent(event, today);
      if (capture) {
        this.cache.applyCondition(capture);
        continue;
      }
      // 00(주문체결)/04(잔고)/0D(호가) 등은 구독하지 않으며, 도착해도 캐시에 쓰지 않는다.
    }
  }

  /** A new minute has started → ask for that stock's candles (governed REST). */
  private maybeRefreshCandles(quote: Quote, today: string): void {
    void today;
    if (quote.time === null) return;
    const last = this.cache.lastCandleTime(quote.code);
    if (last === null) return;
    if (quote.time < last + 60) return;
    this.scheduleCandleRefresh(quote.code);
  }

  private scheduleCandleRefresh(code: string): void {
    if (this.refreshTimers.has(code)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(code);
      void this.refreshCandles(code).catch(() => undefined);
    }, this.debounceMs);
    timer.unref?.();
    this.refreshTimers.set(code, timer);
  }

  /** Fetch fresh candles for one code through the governed REST lane. */
  async refreshCandles(code: string, options: {baseDate?: string} = {}): Promise<Candle[]> {
    const broker = this.deps.broker;
    if (!broker) throw new Error('REST 브로커가 주입되지 않았습니다.');
    const minute = await broker.candles(code);
    if (!minute.length) throw new Error(`${code} 유효한 분봉 데이터 없음`);
    let merged: Candle[] = minute;
    if (options.baseDate) {
      const daily = await broker.daily(code, options.baseDate);
      const previous = previousDayMap(daily);
      merged = minute.map((candle) => {
        const key = kstDate(candle.time * 1000);
        const row = previous.get(key);
        return row ? {...candle, previousDay: row} : candle;
      });
    }
    this.cache.mergeCandles(code, merged);
    this.candlesRefreshed += 1;
    this.evaluateSignals(code);
    return merged;
  }

  /**
   * 종목 신호. 닫힌 봉만. 화면이 가려져 있어도 시세가 오면 평가한다.
   */
  evaluateSignals(code: string): void {
    this.ops.runSync('evaluateSignals', () => this.evaluateSignalsUnmetered(code));
  }

  private evaluateSignalsUnmetered(code: string): void {
    const evaluator = this.evaluator;
    if (!evaluator || !this.activeCodes.has(code)) return;
    const candles = this.cache.candles(code);
    const quality = signalDataStatus(candles, Math.floor(this.now() / 1000));
    if (!quality.ok) {
      this.cache.setWarning(code, quality.reason);
      return;
    }
    this.cache.clearWarning(code);
    const last = quality.closed.at(-1);
    if (!last) return;
    const result = evaluator(code, quality.closed);
    if (!result) return;
    if (result.buy && result.sell) {
      this.audit.record('signal', '동시 매수/매도 신호를 무시했습니다.', {code, barTime: last.time});
      return;
    }
    if (result.buy) {
      this.kpiFilters.set(`${code}|buy`, result.filters || []);
      if (this.bestScoreOnly) {
        this.pendingBuys.set(code, {bar: last, score: result.score ?? 50, filters: result.filters || []});
        if (this.bestTimer) clearTimeout(this.bestTimer);
        this.bestTimer = setTimeout(() => this.flushBestBuys(), 80);
      } else {
        this.audit.record('signal', '매수 신호', {code, barTime: last.time, price: last.close, score: result.score});
        this.applySignal(code, last, 'buy');
      }
    }
    if (result.sell) {
      this.kpiFilters.set(`${code}|sell`, result.filters || []);
      this.audit.record('signal', '매도 신호', {code, barTime: last.time, price: last.close});
      this.applySignal(code, last, 'sell');
    }
  }

  private flushBestBuys(): void {
    this.bestTimer = null;
    const items = [...this.pendingBuys.entries()];
    this.pendingBuys.clear();
    if (!items.length) return;
    items.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const [bestCode, best] = items[0];
    for (const [code, item] of items) {
      if (code === bestCode) {
        this.audit.record('signal', `매수 신호 최고점 ${best.score}`, {code, barTime: item.bar.time, price: item.bar.close, score: item.score});
        this.applySignal(code, item.bar, 'buy');
      } else {
        this.audit.record('signal', `점수 ${item.score} < ${best.score} 진입 안 함`, {code, barTime: item.bar.time, score: item.score});
      }
    }
  }

  private applySignal(code: string, bar: Candle, side: 'buy' | 'sell'): void {
    const key = `${code}|${bar.time}|${side}`;
    if (!this.signalDedup.claim(key)) return;
    const filters = this.pendingBuys.get(code)?.filters || this.kpiFilters.get(`${code}|${side}`) || [];
    try {
      this.deps.onKpi?.({code, side, close: bar.close, time: bar.time, filters});
    } catch {
      /* kpi must not block orders */
    }
    const input = {
      code,
      side,
      type: 'market' as const,
      qty: side === 'sell' ? this.book.qty(code) || this.orderQty : this.orderQty,
      source: 'signal' as const,
      priceHint: bar.close,
    };
    const onPlaced = (order: {status: string; fillPrice: number | null; fillAt: number | null; code: string; side: 'buy' | 'sell'}) => {
      this.noteBookOrder(order);
    };
    try {
      if (this.book.mode === 'assumed') onPlaced(this.book.place(input));
      else void this.book.submit(input).then(onPlaced).catch((error) => {
        this.audit.record('order', error instanceof Error ? error.message : '모의 주문 실패', {code, side, barTime: bar.time});
      });
    } catch (error) {
      this.audit.record('order', error instanceof Error ? error.message : '모의 주문 실패', {code, side, barTime: bar.time});
    }
  }

  private pushEvent(event: SimulatedEvent): void {
    this.events.unshift(event);
    if (this.events.length > 50) this.events.length = 50;
    this.audit.record('order', '키움 주문 없음: 가정 체결만 기록했습니다.', {code: event.code, side: event.side, assumed: true});
  }

  /** Register a demand (owner) for realtime types of the given items. Idempotent per owner. */
  async subscribe(owner: string, items: readonly string[], types: readonly string[]): Promise<void> {
    return this.ops.run('subscribe', () => this.subscribeUnmetered(owner, items, types));
  }

  private async subscribeUnmetered(owner: string, items: readonly string[], types: readonly string[]): Promise<void> {
    if (typeof owner !== 'string' || !owner.trim()) throw new Error('구독 소유자 식별자가 필요합니다.');
    if (!items.length || !types.length) throw new Error('구독할 종목과 타입이 필요합니다.');
    await this.withSubscriptionLock(async () => {
      let toRegister: {key: string; item: string; type: string}[] = [];
      let additions = 0;
      for (const type of types) {
        for (const item of items) {
          const key = `${type}|${item}`;
          const existing = this.subscriptions.get(key);
          if (existing) existing.owners.add(owner);
          else {
            additions += 1;
            toRegister.push({key, item, type});
          }
        }
      }
      if (!toRegister.length) return;
      const used = [...this.subscriptions.values()].filter((sub) => sub.owners.size > 0).length;
      const room = Math.max(0, this.caps.limits.maxSubscriptions - used);
      if (room <= 0) {
        this.audit.record('limit', '구독 상한. 추가 REG를 보내지 않습니다.', {owner, asked: additions});
        this.ops.noteConstraint('subscribe');
        return;
      }
      if (toRegister.length > room) {
        this.audit.record('limit', `구독 ${toRegister.length}→${room}. 초과분은 다음 회차`, {owner});
        toRegister = toRegister.slice(0, room);
        additions = toRegister.length;
      }
      for (const {key, item, type} of toRegister) this.subscriptions.set(key, {item, type, owners: new Set([owner])});
      try {
        for (const type of types) {
          const pendingItems = toRegister.filter((entry) => entry.type === type).map((entry) => entry.item);
          for (const chunk of chunked(pendingItems, this.caps.limits.maxItemsPerPacket)) {
            if (!this.isReady) throw new Error('실시간 세션이 준비되지 않았습니다.');
            this.caps.assertPacket(chunk.length);
            await this.sendAndAwait('REG', registerPacket(chunk, [type]));
          }
        }
        this.audit.record('subscription', '실시간 구독을 등록했습니다.', {type: types.join(','), items: toRegister.length, owner});
      } catch (error) {
        for (const {key} of toRegister) {
          const sub = this.subscriptions.get(key);
          if (sub) {
            sub.owners.delete(owner);
            if (!sub.owners.size) this.subscriptions.delete(key);
          }
        }
        this.audit.record('error', '실시간 구독 등록에 실패했습니다.', {error: error instanceof Error ? error.message : '오류'});
        throw error;
      }
    });
  }

  /** Drop one owner's interest; the packet is sent only when nobody else needs it. */
  async unsubscribe(owner: string, items: readonly string[], types: readonly string[]): Promise<void> {
    return this.ops.run('unsubscribe', () => this.unsubscribeUnmetered(owner, items, types));
  }

  private async unsubscribeUnmetered(owner: string, items: readonly string[], types: readonly string[]): Promise<void> {
    const toRemove: {item: string; type: string}[] = [];
    for (const type of types) {
      for (const item of items) {
        const key = `${type}|${item}`;
        const sub = this.subscriptions.get(key);
        if (!sub) continue;
        sub.owners.delete(owner);
        if (!sub.owners.size) {
          this.subscriptions.delete(key);
          toRemove.push({item, type});
        }
      }
    }
    if (!toRemove.length || !this.isReady) return;
    await this.withSubscriptionLock(async () => {
      for (const type of types) {
        const pendingItems = toRemove.filter((entry) => entry.type === type).map((entry) => entry.item);
        for (const chunk of chunked(pendingItems, this.caps.limits.maxItemsPerPacket)) {
          await this.sendAndAwait('REMOVE', removePacket(chunk, [type]));
        }
      }
    });
    this.audit.record('subscription', '실시간 구독을 해제했습니다.', {type: types.join(','), items: toRemove.length, owner});
  }

  /** Send a one-shot request (CNSRLST / CNSRREQ) and await the matching frame. */
  async request(packet: Record<string, unknown>, expectedTrnm: string): Promise<RealtimeFrame> {
    if (!this.isReady) throw new Error('실시간 세션이 준비되지 않았습니다.');
    return this.sendAndAwait(expectedTrnm, packet);
  }

  private async sendAndAwait(expectedTrnm: string, packet: Record<string, unknown> | object): Promise<RealtimeFrame> {
    const socket = this.socket;
    if (!socket) throw new Error('실시간 연결이 없습니다.');
    if (this.pending.has(expectedTrnm)) throw new Error(`이미 대기 중인 실시간 요청이 있습니다: ${expectedTrnm}`);
    const promise = new Promise<RealtimeFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectedTrnm);
        reject(new Error(`실시간 요청 시간 초과: ${expectedTrnm}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(expectedTrnm, {resolve, reject, timer});
    });
    socket.send(JSON.stringify(packet));
    return promise;
  }

  private withSubscriptionLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.subChain.then(task, task);
    this.subChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async resubscribeAll(): Promise<void> {
    const byType = new Map<string, string[]>();
    for (const sub of this.subscriptions.values()) {
      if (!sub.owners.size) continue;
      const list = byType.get(sub.type) ?? [];
      list.push(sub.item);
      byType.set(sub.type, list);
    }
    if (!byType.size) return;
    await this.withSubscriptionLock(async () => {
      for (const [type, items] of byType) {
        for (const chunk of chunked(items, this.caps.limits.maxItemsPerPacket)) {
          await this.sendAndAwait('REG', registerPacket(chunk, [type]));
        }
      }
    });
    this.audit.record('subscription', '재연결 후 실시간 구독을 복원했습니다.', {types: [...byType.keys()].length});
  }

  private failPending(error: Error): void {
    for (const [key, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(key);
    }
    this.loginWaiter?.reject(error);
  }

  /** Force a reconnect (watchdog, operator request, or fatal frame handling). */
  setWsUrl(url: string): void {
    if (!url) throw new Error('실시간 URL이 비었습니다.');
    this.url = url;
  }

  forceReconnect(reason: string): void {
    if (this.state === 'closed') return;
    this.audit.record('connection', '실시간 연결을 재설정합니다.', {reason});
    this.failPending(new Error(`실시간 연결 재설정: ${reason}`));
    this.state = 'reconnecting';
    this.closeSocket();
    this.scheduleReconnect();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.removeAllListeners?.();
      socket.terminate?.();
      socket.close();
    } catch {
      /* closing twice must not throw */
    }
  }

  private scheduleReconnect(): void {
    if (this.state === 'closed') return;
    if (this.reconnectTimer) return;
    this.reconnects += 1;
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    const jitter = Math.floor(this.random() * this.reconnectBaseMs);
    const delay = Math.min(this.reconnectMaxMs, exponential + jitter);
    this.attempt += 1;
    this.state = 'reconnecting';
    this.audit.record('connection', '실시간 재연결을 예약했습니다.', {delayMs: delay, attempt: this.attempt});
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop everything. Pending requests are rejected, subscriptions are dropped from memory. */
  stop(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.audit.record('state', '실시간 관리자를 종료했습니다.');
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.failPending(new Error('실시간 관리자가 종료되었습니다.'));
    this.closeSocket();
  }
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function previousDayMap(daily: readonly {date: string}[]): Map<string, PreviousDay> {
  const map = new Map<string, PreviousDay>();
  for (let index = 1; index < daily.length; index += 1) map.set(daily[index].date, daily[index - 1] as PreviousDay);
  return map;
}
