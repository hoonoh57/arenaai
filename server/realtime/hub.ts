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

export type SignalEvaluator = (code: string, closed: Candle[]) => {buy: boolean; sell: boolean} | null;

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
};

type Subscription = {item: string; type: string; owners: Set<string>};

export type HubStatus = {
  state: HubState;
  connected: boolean;
  reconnects: number;
  lastFrameAt: number | null;
  lastError: string | null;
  subscriptions: number;
  subscriptionsByType: Record<string, number>;
  pendingRequests: number;
  candlesRefreshed: number;
  duplicatesDropped: number;
  caps: RealtimeLimits & {verified: false};
  lastLoginAt: number | null;
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
  private readonly debounceMs: number;
  private readonly pending = new Map<string, {resolve: (frame: RealtimeFrame) => void; reject: (error: Error) => void; timer: any}>();
  private readonly refreshTimers = new Map<string, any>();
  private readonly positions = new Map<string, {side: 'long'; entryPrice: number; entryTime: number}>();
  private readonly events: SimulatedEvent[] = [];
  private loginWaiter: {resolve: () => void; reject: (error: Error) => void} | null = null;
  private watchdog: any = null;
  private reconnectTimer: any = null;
  private subChain: Promise<void> = Promise.resolve();
  private attempt = 0;
  private reconnects = 0;
  private lastFrameAt: number | null = null;
  private lastLoginAt: number | null = null;
  private lastError: string | null = null;
  private candlesRefreshed = 0;
  private duplicatesDropped = 0;
  private activeCodes = new Set<string>();
  private evaluator: SignalEvaluator | null = null;
  private readonly readyHandlers = new Set<() => void | Promise<void>>();

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
    this.staleMs = deps.staleMs ?? 60000;
    this.debounceMs = deps.candleRefreshDebounceMs ?? 2000;
    this.dedup = new KeyedDedup({ttlMs: 5000, max: 20000});
    this.signalDedup = new SignalDedup(deps.signalDedupSize ?? 20000);
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

  /** Only these codes are evaluated for simulated signals. */
  setActiveCodes(codes: readonly string[]): void {
    this.activeCodes = new Set(codes);
  }

  positionsSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.positions.keys()].map((code) => [code, 1]));
  }

  eventsSnapshot(limit = 50): SimulatedEvent[] {
    return this.events.slice(0, limit);
  }

  status(): HubStatus {
    const byType: Record<string, number> = {};
    for (const sub of this.subscriptions.values()) byType[sub.type] = (byType[sub.type] ?? 0) + 1;
    return {
      state: this.state,
      connected: this.state === 'ready',
      reconnects: this.reconnects,
      lastFrameAt: this.lastFrameAt,
      lastError: this.lastError,
      subscriptions: this.subscriptions.size,
      subscriptionsByType: byType,
      pendingRequests: this.pending.size,
      candlesRefreshed: this.candlesRefreshed,
      duplicatesDropped: this.duplicatesDropped,
      caps: {...this.caps.limits, verified: false},
      lastLoginAt: this.lastLoginAt,
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
    const socket = createSocket(this.deps.url);
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
        this.maybeRefreshCandles(quote, today);
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
      if (event.type === 'ka10173') {
        const capture = conditionEvent(event, today);
        if (capture) {
          this.cache.applyCondition(capture);
          this.audit.record('state', '조건검색 포착 종목이 갱신되었습니다.', capture);
        }
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
   * Simulated signal evaluation for one code, on closed bars only.
   * One event per (code, closed bar, side) — enforced by the dedup set.
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
    if (result.buy) this.applySignal(code, last, 'buy');
    if (result.sell) this.applySignal(code, last, 'sell');
  }

  private applySignal(code: string, bar: Candle, side: 'buy' | 'sell'): void {
    const key = `${code}|${bar.time}|${side}`;
    if (!this.signalDedup.claim(key)) return;
    if (side === 'buy') {
      if (this.positions.has(code)) return;
      this.positions.set(code, {side: 'long', entryPrice: bar.close, entryTime: bar.time});
      this.audit.record('position', '모의 매수 포지션을 열었습니다.', {code, price: bar.close, barTime: bar.time});
      this.pushEvent({time: this.now(), code, side: '모의 매수', price: bar.close});
      return;
    }
    const position = this.positions.get(code);
    if (!position) return;
    this.positions.delete(code);
    this.audit.record('position', '모의 매도로 포지션을 청산했습니다.', {
      code,
      entryPrice: position.entryPrice,
      exitPrice: bar.close,
      barTime: bar.time,
    });
    this.pushEvent({time: this.now(), code, side: '모의 매도', price: bar.close});
  }

  private pushEvent(event: SimulatedEvent): void {
    this.events.unshift(event);
    if (this.events.length > 50) this.events.length = 50;
    this.audit.record('order', '주문 없음: 모의 이벤트만 기록했습니다.', {code: event.code, side: event.side});
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
