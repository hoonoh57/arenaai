/**
 * In-process simulated book. It never sends a Kiwoom order.
 * Market orders fill only at a last *observed* price (quote or candle close).
 * Limit orders stay working until a realtime quote crosses the limit.
 */

import type {AuditLog} from './audit';
import type {SharedCache} from './cache';

export type BookHooks = {
  canEnter?: (intent: {code: string; price: number; at: number}) => {allowed: boolean; reason?: string};
  onOpen?: (intent: {code: string; price: number; at: number}) => void;
  onClose?: (result: {code: string; entryPrice: number; exitPrice: number; at: number}) => void;
};

export type BookSide = 'buy' | 'sell';
export type BookType = 'market' | 'limit';
export type BookStatus = 'working' | 'filled' | 'cancelled';
export type BookSource = 'signal' | 'manual';
export type FillMode = 'assumed' | 'kiwoom-mock';

export type MockOrderBroker = {
  stockOrder(input: {side: BookSide; code: string; qty: number; type: BookType; limitPrice?: number | null}): Promise<{ordNo: string}>;
  cancelStock(input: {code: string; origOrdNo: string; qty?: number}): Promise<{ordNo: string}>;
};

export type SimOrder = {
  id: string;
  code: string;
  side: BookSide;
  type: BookType;
  qty: number;
  limitPrice: number | null;
  status: BookStatus;
  source: BookSource;
  createdAt: number;
  updatedAt: number;
  fillPrice: number | null;
  fillAt: number | null;
  reason: string;
  brokerOrdNo?: string;
};

export type SimHolding = {
  code: string;
  qty: number;
  avgPrice: number;
  openedAt: number;
};

export type BookSnapshot = {
  holdings: SimHolding[];
  working: SimOrder[];
  recent: SimOrder[];
  assumedFill: boolean;
  brokerOrders: boolean;
  fillMode: FillMode;
};

export type BookDeps = {
  cache: SharedCache;
  audit: AuditLog;
  now?: () => number;
  hooks?: () => BookHooks;
  broker?: MockOrderBroker;
  fillMode?: FillMode;
  allowBroker?: boolean;
};

const CODE = /^\d{6}$/;

export class SimulationBook {
  private readonly cache: SharedCache;
  private readonly audit: AuditLog;
  private readonly now: () => number;
  private readonly hooks: () => BookHooks;
  private broker?: MockOrderBroker;
  private readonly allowBroker: boolean;
  private fillMode: FillMode;
  private readonly holdings = new Map<string, SimHolding>();
  private readonly orders = new Map<string, SimOrder>();
  private seq = 1;

  constructor(deps: BookDeps) {
    this.cache = deps.cache;
    this.audit = deps.audit;
    this.now = deps.now ?? Date.now;
    this.hooks = deps.hooks ?? (() => ({}));
    this.broker = deps.broker;
    this.allowBroker = deps.allowBroker ?? false;
    this.fillMode = deps.fillMode ?? 'assumed';
  }

  get mode(): FillMode {
    return this.fillMode;
  }

  setBroker(broker: MockOrderBroker | undefined): void {
    this.broker = broker;
  }

  setFillMode(mode: FillMode): FillMode {
    if (mode !== 'assumed' && mode !== 'kiwoom-mock') throw new Error('체결 모드는 assumed 또는 kiwoom-mock 입니다.');
    if (mode === 'kiwoom-mock' && !this.allowBroker) throw new Error('키움 모의계좌 주문은 KIWOOM_MODE=mock 일 때만 켤 수 있습니다. 실전 주문은 전송하지 않습니다.');
    if (mode === 'kiwoom-mock' && !this.broker) throw new Error('모의 주문 브로커가 없습니다.');
    this.fillMode = mode;
    this.audit.record('state', mode === 'assumed' ? '가정 체결 모드입니다. 키움 주문을 보내지 않습니다.' : '키움 모의계좌 주문 모드입니다. mockapi 주문 TR만 사용합니다.', {fillMode: mode});
    return this.fillMode;
  }

  /** Last observed price. Never synthesised. */
  lastPrice(code: string): number | null {
    const quote = this.cache.getQuote(code);
    if (quote && Number.isFinite(quote.price) && quote.price > 0) return quote.price;
    const candle = this.cache.candles(code).at(-1);
    if (candle && Number.isFinite(candle.close) && candle.close > 0) return candle.close;
    return null;
  }

  has(code: string): boolean {
    return this.holdings.has(code);
  }

  holding(code: string): SimHolding | undefined {
    const row = this.holdings.get(code);
    return row ? {...row} : undefined;
  }

  qty(code: string): number {
    return this.holdings.get(code)?.qty ?? 0;
  }

  /**
   * Place a simulated order. Market fills immediately when a price exists;
   * otherwise it waits as 미체결 until a quote arrives. Limit always waits.
   */
  place(input: {
    code: string;
    side: BookSide;
    type: BookType;
    qty?: number;
    limitPrice?: number | null;
    source?: BookSource;
    priceHint?: number;
  }): SimOrder {
    if (!CODE.test(input.code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
    const qty = input.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1) throw new Error('수량은 1 이상 정수여야 합니다.');
    if (this.fillMode === 'assumed' && input.side === 'sell' && this.qty(input.code) < qty) throw new Error('모의 보유 수량이 부족합니다.');
    if (input.side === 'buy' && this.has(input.code) && input.source === 'signal') {
      throw new Error('이미 모의 보유 중인 종목입니다.');
    }
    let limitPrice: number | null = null;
    if (input.type === 'limit') {
      const limit = input.limitPrice;
      if (!Number.isFinite(limit) || (limit as number) <= 0) throw new Error('지정가는 0보다 커야 합니다.');
      limitPrice = limit as number;
    }
    const at = this.now();
    const order: SimOrder = {
      id: `sim-${this.seq++}`,
      code: input.code,
      side: input.side,
      type: input.type,
      qty,
      limitPrice,
      status: 'working',
      source: input.source ?? 'manual',
      createdAt: at,
      updatedAt: at,
      fillPrice: null,
      fillAt: null,
      reason: '미체결',
      brokerOrdNo: undefined,
    };
    this.orders.set(order.id, order);
    this.audit.record('order', this.fillMode === 'assumed' ? '가정 체결 주문을 접수했습니다. 키움으로 전송하지 않았습니다.' : '키움 모의 주문을 준비했습니다.', {
      id: order.id,
      code: order.code,
      side: order.side,
      type: order.type,
      fillMode: this.fillMode,
    });
    if (this.fillMode === 'assumed') {
      const hint = input.priceHint && input.priceHint > 0 ? input.priceHint : this.lastPrice(input.code);
      if (order.type === 'market' && hint) this.fill(order, hint, '시장가 가정 체결');
      else if (order.type === 'limit' && hint && this.crosses(order, hint)) this.fill(order, hint, '지정가 즉시 가정 체결');
    }
    return {...this.orders.get(order.id)!};
  }

  async submit(input: Parameters<SimulationBook['place']>[0]): Promise<SimOrder> {
    const order = this.place(input);
    if (this.fillMode !== 'kiwoom-mock') return order;
    if (!this.broker) throw new Error('모의 주문 브로커가 없습니다.');
    const live = this.orders.get(order.id);
    if (!live) return order;
    try {
      const {ordNo} = await this.broker.stockOrder({
        side: live.side,
        code: live.code,
        qty: live.qty,
        type: live.type,
        limitPrice: live.limitPrice,
      });
      live.brokerOrdNo = ordNo;
      live.reason = '키움 모의계좌 접수';
      live.updatedAt = this.now();
      this.audit.record('order', '키움 모의 주문을 전송했습니다.', {id: live.id, ordNo, code: live.code, side: live.side});
      const px = this.lastPrice(live.code);
      if (px && (live.type === 'market' || !live.limitPrice)) {
        this.fill(live, px, '키움 모의 시장가 체결 반영');
      }
    } catch (error) {
      live.status = 'cancelled';
      live.reason = error instanceof Error ? error.message : '모의 주문 실패';
      live.updatedAt = this.now();
      this.audit.record('error', '키움 모의 주문 전송 실패', {id: live.id, error: live.reason});
      throw error;
    }
    return {...live};
  }

  /** Called on every realtime quote. Fills working orders that the quote satisfies. */
  onQuote(code: string, price: number): SimOrder[] {
    if (this.fillMode !== 'assumed' && this.fillMode !== 'kiwoom-mock') return [];
    if (!Number.isFinite(price) || price <= 0) return [];
    const filled: SimOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== 'working' || order.code !== code) continue;
      if (order.type === 'market' || this.crosses(order, price)) {
        this.fill(order, price, order.type === 'market' ? '시세 도착 후 시장가 가정 체결' : '지정가 도달 가정 체결');
        filled.push({...order});
      }
    }
    return filled;
  }

  async cancel(id: string): Promise<SimOrder> {
    const order = this.orders.get(id);
    if (!order) throw new Error('주문을 찾을 수 없습니다.');
    if (order.status !== 'working') throw new Error('미체결 주문만 취소할 수 있습니다.');
    if (this.fillMode === 'kiwoom-mock') {
      if (!order.brokerOrdNo) throw new Error('키움 주문번호가 없어 취소할 수 없습니다.');
      if (!this.broker) throw new Error('모의 주문 브로커가 없습니다.');
      await this.broker.cancelStock({code: order.code, origOrdNo: order.brokerOrdNo});
    }
    order.status = 'cancelled';
    order.updatedAt = this.now();
    order.reason = '사용자 취소';
    this.audit.record('order', this.fillMode === 'kiwoom-mock' ? '키움 모의 취소를 전송했습니다.' : '가정 체결 미체결을 취소했습니다.', {id, code: order.code});
    return {...order};
  }

  async cancelAll(code?: string): Promise<number> {
    let n = 0;
    for (const order of [...this.orders.values()]) {
      if (order.status !== 'working') continue;
      if (code && order.code !== code) continue;
      await this.cancel(order.id);
      n += 1;
    }
    return n;
  }

  async buy(code: string, type: BookType = 'market', limitPrice?: number, qty?: number): Promise<SimOrder> {
    const size = qty ?? 1;
    return this.submit({code, side: 'buy', type, qty: size, limitPrice, source: 'manual'});
  }

  async sell(code: string, type: BookType = 'market', limitPrice?: number, qty?: number): Promise<SimOrder> {
    const holding = this.holdings.get(code);
    const size = qty ?? holding?.qty ?? 1;
    if (this.fillMode === 'assumed' && !holding) throw new Error('모의 보유 종목이 아닙니다.');
    return this.submit({code, side: 'sell', type, qty: size, limitPrice, source: 'manual'});
  }

  async flatten(type: BookType = 'market'): Promise<SimOrder[]> {
    const out: SimOrder[] = [];
    for (const holding of [...this.holdings.values()]) {
      out.push(await this.sell(holding.code, type, undefined, holding.qty));
    }
    return out;
  }

  snapshot(): BookSnapshot {
    const working = [...this.orders.values()].filter((o) => o.status === 'working').sort((a, b) => b.createdAt - a.createdAt);
    const recent = [...this.orders.values()].filter((o) => o.status !== 'working').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    return {
      holdings: [...this.holdings.values()].map((row) => ({...row})),
      working,
      recent,
      assumedFill: this.fillMode === 'assumed',
      brokerOrders: this.fillMode === 'kiwoom-mock',
      fillMode: this.fillMode,
    };
  }

  private crosses(order: SimOrder, price: number): boolean {
    if (order.type !== 'limit' || order.limitPrice === null) return false;
    if (order.side === 'buy') return price <= order.limitPrice;
    return price >= order.limitPrice;
  }

  private fill(order: SimOrder, price: number, reason: string): void {
    if (order.status !== 'working') return;
    const at = this.now();
    if (order.side === 'buy') {
      const decision = this.hooks().canEnter?.({code: order.code, price, at});
      if (decision && !decision.allowed) {
        order.status = 'cancelled';
        order.updatedAt = at;
        order.reason = decision.reason ?? '위험 한도';
        this.audit.record('risk', '모의 매수 가정 체결을 위험 한도로 취소했습니다.', {id: order.id, code: order.code, reason: order.reason});
        return;
      }
      const existing = this.holdings.get(order.code);
      if (existing) {
        const qty = existing.qty + order.qty;
        existing.avgPrice = (existing.avgPrice * existing.qty + price * order.qty) / qty;
        existing.qty = qty;
      } else {
        this.holdings.set(order.code, {code: order.code, qty: order.qty, avgPrice: price, openedAt: at});
      }
      this.hooks().onOpen?.({code: order.code, price, at});
    } else {
      const holding = this.holdings.get(order.code);
      if (!holding || holding.qty < order.qty) {
        order.status = 'cancelled';
        order.updatedAt = at;
        order.reason = '보유 수량 부족';
        return;
      }
      holding.qty -= order.qty;
      this.hooks().onClose?.({code: order.code, entryPrice: holding.avgPrice, exitPrice: price, at});
      if (holding.qty === 0) this.holdings.delete(order.code);
    }
    order.status = 'filled';
    order.fillPrice = price;
    order.fillAt = at;
    order.updatedAt = at;
    order.reason = reason;
    this.audit.record('position', `모의 ${order.side === 'buy' ? '매수' : '매도'} 가정 체결`, {
      id: order.id,
      code: order.code,
      price,
      qty: order.qty,
      assumed: true,
    });
  }
}
