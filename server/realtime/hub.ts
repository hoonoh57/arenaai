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

  positionsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.book.snapshot().holdings.map((row) => [row.code, row.qty]));
  }

  eventsSnapshot(limit = 50): SimulatedEvent[] {
    return this.events.slice(0, limit);
  }

  status(): HubStatus {
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
    };
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
          const bar = this.cache.applyLiveQuote(quote.code, quote.time, quote.price, quote.tradeVolume ?? undefined);
          this.cache.applyLiveTick(quote.code, quote.time, quote.price, quote.tradeVolume ?? undefined, quote.strength ?? undefined);
          if (bar === 'new') this.evaluateSignals(quote.code);
        } else if (quote.price > 0) {
          this.cache.applyLiveTick(quote.code, Math.floor(receivedAt / 1000), quote.price, quote.tradeVolume ?? undefined, quote.strength ?? undefined);
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
    if (typeof owner !== 'string' || !owner.trim()) throw new Error('구독 소유자 식별자가 필요합니다.');
    if (!items.length || !types.length) throw new Error('구독할 종목과 타입이 필요합니다.');
    const keys: {key: string; item: string; type: string}[] = [];
    let additions = 0;
    for (const type of types) {
      for (const item of items) {
        const key = `${type}|${item}`;
        const existing = this.subscriptions.get(key);
        if (existing) existing.owners.add(owner);
        else additions += 1;
        keys.push({key, item, type});
      }
    }
    this.caps.assertAddition(
      [...this.subscriptions.values()].filter((sub) => sub.owners.size > 0).length,
      additions,
    );
    const toRegister = keys.filter(({key}) => !this.subscriptions.has(key));
    for (const {key, item, type} of toRegister) this.subscriptions.set(key, {item, type, owners: new Set([owner])});
    if (!toRegister.length) return;
    try {
      await this.withSubscriptionLock(async () => {
        for (const type of types) {
          const pendingItems = toRegister.filter((entry) => entry.type === type).map((entry) => entry.item);
          for (const chunk of chunked(pendingItems, this.caps.limits.maxItemsPerPacket)) {
            if (!this.isReady) throw new Error('실시간 세션이 준비되지 않았습니다.');
            this.caps.assertPacket(chunk.length);
            await this.sendAndAwait('REG', registerPacket(chunk, [type]));
          }
        }
      });
      this.audit.record('subscription', '실시간 구독을 등록했습니다.', {type: types.join(','), items: toRegister.length, owner});
    } catch (error) {
      for (const {key, item, type} of toRegister) {
        const sub = this.subscriptions.get(`${type}|${item}`);
        if (sub) {
          sub.owners.delete(owner);
          if (!sub.owners.size) this.subscriptions.delete(key);
        }
      }
      this.audit.record('error', '실시간 구독 등록에 실패했습니다.', {error: error instanceof Error ? error.message : '오류'});
      throw error;
    }
  }

  /** Drop one owner's interest; the packet is sent only when nobody else needs it. */
  async unsubscribe(owner: string, items: readonly string[], types: readonly string[]): Promise<void> {
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
