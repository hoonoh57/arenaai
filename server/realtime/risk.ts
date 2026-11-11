/**
 * Risk management for simulated entries.
 *
 * This module only ever *restricts*: it can block a new simulated entry, but it never
 * produces, sizes or submits an order. Live order submission does not exist in this
 * project, so every limit here is a guard rail for the in-app simulation and for the
 * order plumbing that would be reused later.
 *
 * Limits are local configuration, not Kiwoom values: Kiwoom publishes no order-count,
 * sizing or loss-limit rules that this project has verified.
 */

export type RiskLimits = {
  /** Maximum simultaneously simulated long positions. */
  maxPositions: number;
  /** Maximum entries per code per day. */
  maxEntriesPerCode: number;
  /** Maximum entries per day across all codes. */
  maxEntriesPerDay: number;
  /** Stop entering after this many consecutive losing exits. */
  maxConsecutiveLosses: number;
  /** No new entry for this long after a losing exit. */
  cooldownMs: number;
  /** Stop entering when realised PnL drops below -maxDailyLossPct of startEquity. */
  maxDailyLossPct: number;
  startEquity: number;
  /** Rolling one-minute cap on entry requests (order-lane protection). */
  maxEntriesPerMinute: number;
};

export type RiskDecision = {ok: boolean; reason: string};

export type RiskSnapshot = {
  day: string;
  positions: number;
  entriesToday: number;
  entriesByCode: Record<string, number>;
  realisedPnl: number;
  realisedPct: number;
  consecutiveLosses: number;
  cooldownRemainingMs: number;
  blocked: boolean;
  limits: RiskLimits;
};

export type RiskIntent = {code: string; price: number; at: number};

const DEFAULTS: RiskLimits = {
  maxPositions: 4,
  maxEntriesPerCode: 3,
  maxEntriesPerDay: 20,
  maxConsecutiveLosses: 3,
  cooldownMs: 5 * 60_000,
  maxDailyLossPct: 3,
  startEquity: 10_000_000,
  maxEntriesPerMinute: 10,
};

function kstDay(at: number): string {
  return new Date(at + 9 * 3600000).toISOString().slice(0, 10);
}

export class RiskManager {
  private readonly limits: RiskLimits;
  private readonly now: () => number;
  private day: string;
  private positions = new Set<string>();
  private entriesToday = 0;
  private readonly entriesByCode = new Map<string, number>();
  private realisedPnl = 0;
  private consecutiveLosses = 0;
  private cooldownUntil = 0;
  private entryTimes: number[] = [];

  constructor(limits: Partial<RiskLimits> = {}, now: () => number = Date.now) {
    const merged = {...DEFAULTS, ...limits};
    for (const [key, value] of Object.entries(merged)) {
      if (!Number.isFinite(value as number) || (value as number) < 0) throw new Error(`위험 한도 값이 올바르지 않습니다: ${key}`);
    }
    if (!Number.isInteger(merged.maxPositions) || merged.maxPositions < 1) throw new Error('최대 보유 종목 수는 1 이상이어야 합니다.');
    if (merged.startEquity <= 0) throw new Error('기준 자본은 0보다 커야 합니다.');
    this.limits = merged;
    this.now = now;
    this.day = kstDay(now());
  }

  get currentLimits(): RiskLimits {
    return {...this.limits};
  }

  /** Roll the daily counters when the KST date changes. */
  private rollDay(at: number): void {
    const day = kstDay(at);
    if (day === this.day) return;
    this.day = day;
    this.entriesToday = 0;
    this.entriesByCode.clear();
    this.realisedPnl = 0;
    this.consecutiveLosses = 0;
    this.cooldownUntil = 0;
    this.entryTimes = [];
    // Positions survive the day boundary: they are real (simulated) holdings.
  }

  private rollingEntries(at: number): number {
    this.entryTimes = this.entryTimes.filter((time) => at - time < 60_000);
    return this.entryTimes.length;
  }

  /**
   * Decide whether a new simulated entry is allowed. Exits are never gated.
   * Order of checks is deliberate: hard state limits first, then pacing.
   */
  canEnter(intent: RiskIntent): RiskDecision {
    const at = Number.isFinite(intent.at) ? intent.at : this.now();
    this.rollDay(at);
    if (!intent.code || !/^\d{6}$/.test(intent.code)) return {ok: false, reason: '종목 코드가 올바르지 않습니다.'};
    if (!Number.isFinite(intent.price) || intent.price <= 0) return {ok: false, reason: '가격이 올바르지 않습니다.'};
    if (this.positions.has(intent.code)) return {ok: false, reason: '이미 보유 중인 종목입니다.'};
    if (this.positions.size >= this.limits.maxPositions) return {ok: false, reason: `최대 보유 종목 수(${this.limits.maxPositions})에 도달했습니다.`};

    const lossLimit = -(this.limits.startEquity * this.limits.maxDailyLossPct) / 100;
    if (lossLimit < 0 && this.realisedPnl <= lossLimit) return {ok: false, reason: `당일 실현 손실 한도(${this.limits.maxDailyLossPct}%)를 초과했습니다.`};
    if (this.consecutiveLosses >= this.limits.maxConsecutiveLosses) return {ok: false, reason: `연속 손실 ${this.consecutiveLosses}회로 진입을 중단했습니다.`};
    if (at < this.cooldownUntil) return {ok: false, reason: `손실 후 대기 시간이 ${Math.ceil((this.cooldownUntil - at) / 1000)}초 남았습니다.`};
    if (this.entriesToday >= this.limits.maxEntriesPerDay) return {ok: false, reason: `일일 진입 횟수(${this.limits.maxEntriesPerDay})를 모두 사용했습니다.`};
    if ((this.entriesByCode.get(intent.code) ?? 0) >= this.limits.maxEntriesPerCode) {
      return {ok: false, reason: `종목당 진입 횟수(${this.limits.maxEntriesPerCode})를 모두 사용했습니다.`};
    }
    if (this.rollingEntries(at) >= this.limits.maxEntriesPerMinute) return {ok: false, reason: `분당 진입 요청(${this.limits.maxEntriesPerMinute})을 초과했습니다.`};
    return {ok: true, reason: ''};
  }

  /** Reserve the entry after `canEnter` approved it. */
  onEntry(code: string, _price: number, at: number): void {
    this.rollDay(at);
    this.positions.add(code);
    this.entriesToday += 1;
    this.entriesByCode.set(code, (this.entriesByCode.get(code) ?? 0) + 1);
    this.entryTimes.push(at);
  }

  /** Record an exit and update loss/cooldown state. PnL is per simulated share. */
  onExit(code: string, pnl: number, at: number): void {
    this.rollDay(at);
    this.positions.delete(code);
    if (!Number.isFinite(pnl)) return;
    this.realisedPnl += pnl;
    if (pnl < 0) {
      this.consecutiveLosses += 1;
      this.cooldownUntil = at + this.limits.cooldownMs;
      return;
    }
    if (pnl > 0) this.consecutiveLosses = 0;
  }

  /** Operator reset of daily counters (positions are kept). */
  resetDay(at = this.now()): void {
    this.entriesToday = 0;
    this.entriesByCode.clear();
    this.realisedPnl = 0;
    this.consecutiveLosses = 0;
    this.cooldownUntil = 0;
    this.entryTimes = [];
    this.day = kstDay(at);
  }

  snapshot(at = this.now()): RiskSnapshot {
    this.rollDay(at);
    const realisedPct = (this.realisedPnl / this.limits.startEquity) * 100;
    const lossLimit = -(this.limits.startEquity * this.limits.maxDailyLossPct) / 100;
    return {
      day: this.day,
      positions: this.positions.size,
      entriesToday: this.entriesToday,
      entriesByCode: Object.fromEntries(this.entriesByCode),
      realisedPnl: Math.round(this.realisedPnl * 100) / 100,
      realisedPct: Math.round(realisedPct * 100) / 100,
      consecutiveLosses: this.consecutiveLosses,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - at),
      blocked: (lossLimit < 0 && this.realisedPnl <= lossLimit) || this.consecutiveLosses >= this.limits.maxConsecutiveLosses,
      limits: this.currentLimits,
    };
  }
}
