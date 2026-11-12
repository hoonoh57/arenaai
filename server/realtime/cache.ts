import type {Candle} from '../core';
import {CandleRing} from './ring';
import type {ConditionEvent, Quote, SectorSnapshot, StockInfo} from './protocol';

/**
 * Shared cache for every demand logic (charts, scanner, strategy).
 *
 * Field availability is stated explicitly in `capabilities()`. Data that Kiwoom does
 * not publish is never synthesised here:
 *  - per-bar 거래대금(turnover): no realtime type carries it and `ka10080` has no such
 *    field, so bars keep `turnover` undefined and the formula field `ACCOUNT` stays null.
 *  - 투자자별(기관/외국인) 순매수: REST only (e.g. ka10051). Realtime only exposes
 *    `1314 순매수체결량`, which is a single-trade quantity, not investor net buying.
 *  - 섹터별 주도종목: Kiwoom has no such API at all; only 0J/0U sector index/width are
 *    available, so this cache exposes sector index snapshots only.
 */

export type CacheOptions = {
  maxCodes?: number;
  candleCapacity?: number;
  now?: () => number;
};

export type CacheWarning = {code: string; reason: string};

export class SharedCache {
  private readonly quotesByCode = new Map<string, Quote>();
  private readonly infoByCode = new Map<string, StockInfo>();
  private readonly candlesByCode = new Map<string, CandleRing>();
  private readonly sectorsByCode = new Map<string, SectorSnapshot>();
  private readonly captures = new Map<string, Map<string, {action: 'insert' | 'delete'; at: number}>>();
  private readonly warningMap = new Map<string, string>();
  private readonly listeners = new Set<(event: {kind: string; code?: string; lastTime?: number | null}) => void>();
  private readonly maxCodes: number;
  private readonly candleCapacity: number;
  private readonly now: () => number;
  private quoteVersion = 0;
  private candleVersion = 0;

  constructor(options: CacheOptions = {}) {
    this.maxCodes = options.maxCodes ?? 200;
    this.candleCapacity = options.candleCapacity ?? 1200;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxCodes) || this.maxCodes < 1) throw new Error('캐시 종목 수 한도가 올바르지 않습니다.');
  }

  /** Subscribe to cache mutations. Returns an unsubscribe function. */
  onUpdate(listener: (event: {kind: string; code?: string; lastTime?: number | null}) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: {kind: string; code?: string; lastTime?: number | null}): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken consumer must not break the shared cache */
      }
    }
  }

  private prune(map: Map<string, unknown>): void {
    while (map.size > this.maxCodes) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  setQuote(quote: Quote): void {
    this.quotesByCode.delete(quote.code);
    this.quotesByCode.set(quote.code, quote);
    this.prune(this.quotesByCode);
    this.quoteVersion += 1;
    this.emit({kind: 'quote', code: quote.code});
  }

  getQuote(code: string): Quote | undefined {
    return this.quotesByCode.get(code);
  }

  quoteList(): Quote[] {
    return [...this.quotesByCode.values()];
  }

  quoteVersionCount(): number {
    return this.quoteVersion;
  }

  setStockInfo(info: StockInfo): void {
    this.infoByCode.delete(info.code);
    this.infoByCode.set(info.code, info);
    this.prune(this.infoByCode);
    this.emit({kind: 'info', code: info.code});
  }

  getStockInfo(code: string): StockInfo | undefined {
    return this.infoByCode.get(code);
  }

  /** Merge REST-sourced candles into the per-code ring. */
  mergeCandles(code: string, candles: readonly Candle[]): void {
    let ring = this.candlesByCode.get(code);
    if (!ring) {
      ring = new CandleRing(this.candleCapacity);
      this.candlesByCode.set(code, ring);
      this.prune(this.candlesByCode);
    }
    ring.merge(candles);
    this.candleVersion += 1;
    this.emit({kind: 'candles', code, lastTime: ring.lastTime()});
  }

  candles(code: string): Candle[] {
    return this.candlesByCode.get(code)?.toArray() ?? [];
  }

  lastCandleTime(code: string): number | null {
    return this.candlesByCode.get(code)?.lastTime() ?? null;
  }

  applyLiveQuote(code: string, time: number, price: number, volume?: number): 'update' | 'new' | 'none' {
    const ring = this.candlesByCode.get(code);
    if (!ring) return 'none';
    const result = ring.applyQuote(time, price, volume);
    if (result !== 'none') {
      this.candleVersion += 1;
      this.emit({kind: 'candles', code, lastTime: ring.lastTime()});
    }
    return result;
  }

  clearCandles(code?: string): void {
    if (code) this.candlesByCode.delete(code);
    else this.candlesByCode.clear();
    this.candleVersion += 1;
  }

  candleVersionCount(): number {
    return this.candleVersion;
  }

  setSector(snapshot: SectorSnapshot): void {
    this.sectorsByCode.delete(snapshot.indexCode);
    this.sectorsByCode.set(snapshot.indexCode, snapshot);
    this.prune(this.sectorsByCode);
    this.emit({kind: 'sector', code: snapshot.indexCode});
  }

  sectorList(): SectorSnapshot[] {
    return [...this.sectorsByCode.values()];
  }

  applyCondition(event: ConditionEvent): void {
    let set = this.captures.get(event.seq);
    if (!set) {
      set = new Map();
      this.captures.set(event.seq, set);
    }
    if (event.action === 'delete') set.delete(event.code);
    else set.set(event.code, {action: event.action, at: event.time ?? this.now()});
    this.prune(this.captures);
    this.emit({kind: 'capture', code: event.code});
  }

  /** Currently captured codes for a condition, in arrival order. */
  capturedCodes(seq: string): string[] {
    return [...(this.captures.get(seq)?.keys() ?? [])];
  }

  clearCaptures(seq?: string): void {
    if (seq) this.captures.delete(seq);
    else this.captures.clear();
  }

  setWarning(code: string, reason: string): void {
    this.warningMap.set(code, reason);
  }

  getWarning(code: string): string | undefined {
    return this.warningMap.get(code);
  }

  clearWarning(code: string): void {
    this.warningMap.delete(code);
  }

  warnings(): Record<string, string> {
    return Object.fromEntries(this.warningMap);
  }

  stats(): {codes: number; quotes: number; candles: number; captureSets: number; sectors: number; warnings: number} {
    let candleCount = 0;
    for (const ring of this.candlesByCode.values()) candleCount += ring.ring.size;
    return {
      codes: new Set([...this.quotesByCode.keys(), ...this.candlesByCode.keys()]).size,
      quotes: this.quotesByCode.size,
      candles: candleCount,
      captureSets: this.captures.size,
      sectors: this.sectorsByCode.size,
      warnings: this.warningMap.size,
    };
  }

  /**
   * What the bridge/UI is allowed to claim. `verified` means "documented in the
   * official spec repo"; `unavailable` fields are never populated.
   */
  capabilities() {
    return {
      realtime: {
        '0B': {name: '주식체결', provides: ['현재가', '등락율', '체결강도(228)', '누적거래량', '누적거래대금', '당일 OHLC', '순매수체결량(1314)'], verified: true},
        '0A': {name: '주식기세', provides: ['현재가', '등락율', '누적거래량', '누적거래대금', '당일 OHLC'], verified: true},
        '0g': {name: '주식종목정보', provides: ['상한가', '하한가', '기준가'], verified: true},
        '0J': {name: '업종지수', provides: ['업종 현재가', '등락율'], verified: true},
        '0U': {name: '업종등락', provides: ['상승/하락/보합 종목수', '상한/하한 종목수'], verified: true},
        ka10173: {name: '조건검색 요청 실시간', provides: ['종목코드', '삽입삭제 구분'], verified: true},
      },
      unavailable: {
        barTurnover: '분봉·실시간 어디에도 봉별 거래대금 필드가 없어 ACCOUNT는 계속 null입니다.',
        investorNetBuy: '투자자별 순매수는 REST 전용입니다. 실시간 1314는 단일 체결의 순매수량입니다.',
        sectorLeaders: '키움 명세에 섹터별 주도종목 API가 존재하지 않습니다. 업종지수/등락만 제공됩니다.',
      },
    };
  }
}
