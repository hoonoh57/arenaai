/**
 * Central limit management.
 *
 * Officially documented constraints (verified in
 * https://github.com/Kiwoom-Securities/Kiwoom-REST-API error table):
 *   1700 허용된 API 요청 개수를 초과하였습니다 (per API id)
 *   1701 허용된 전체 요청 개수를 초과하였습니다 (total)
 *   1702 허용된 그룹 요청 개수를 초과하였습니다 (group)
 *
 * The numeric quota behind those codes is NOT published in the spec repository, and
 * neither is the maximum realtime registration/connection count. Every number below is
 * therefore a local, configurable budget — not a Kiwoom guarantee. They are deliberately
 * conservative and overridable from `.env`.
 */

export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([1700, 1701, 1702]);

/**
 * Token-expiry codes that warrant a one-shot credential refresh + retry.
 * Taken from the official client constant `AUTH_RETRY_RETURN_CODES`.
 */
export const AUTH_RETRY_CODES: ReadonlySet<number> = new Set([8005, 8031, 8103]);

export type ReturnCodeClass = 'rate-limit' | 'auth-expired' | 'other';

export function classifyReturnCode(code: number | null): ReturnCodeClass {
  if (code === null) return 'other';
  if (RATE_LIMIT_CODES.has(code)) return 'rate-limit';
  if (AUTH_RETRY_CODES.has(code)) return 'auth-expired';
  return 'other';
}

/** Kiwoom sometimes hides the specific code inside return_msg (`[8005:..]`, `CODE=8005`). */
export function embeddedReturnCode(message: unknown): number | null {
  const match = /\[(\d{3,5}):|CODE=(\d{3,5})/.exec(String(message ?? ''));
  return match ? Number(match[1] ?? match[2]) : null;
}

export function classifyMessage(code: number | null, message: unknown, httpStatus?: number): ReturnCodeClass {
  if (httpStatus === 429 || /\bHTTP\s*429\b/i.test(String(message ?? ''))) return 'rate-limit';
  const direct = classifyReturnCode(code);
  if (direct !== 'other') return direct;
  return classifyReturnCode(embeddedReturnCode(message));
}

export type BucketConfig = {capacity: number; refillPerSecond: number};

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly config: BucketConfig, now: number) {
    if (!Number.isFinite(config.capacity) || config.capacity <= 0) throw new Error('토큰 용량은 0보다 커야 합니다.');
    if (!Number.isFinite(config.refillPerSecond) || config.refillPerSecond <= 0) throw new Error('토큰 보충 속도는 0보다 커야 합니다.');
    this.tokens = config.capacity;
    this.last = now;
  }

  get capacity(): number {
    return this.config.capacity;
  }

  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  /** Milliseconds until one token is available (0 when available now). */
  waitMs(now: number): number {
    return this.waitMsFor(1, now);
  }

  waitMsFor(n: number, now: number): number {
    this.refill(now);
    if (n <= 0 || this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.config.refillPerSecond) * 1000);
  }

  take(now: number): void {
    this.refill(now);
    if (this.tokens < 1) throw new Error('토큰이 없습니다.');
    this.tokens -= 1;
  }

  private refill(now: number): void {
    if (now <= this.last) return;
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.config.capacity, this.tokens + elapsed * this.config.refillPerSecond);
    this.last = now;
  }
}

export type GovernorOptions = {
  total: BucketConfig;
  perApi: BucketConfig;
  order: BucketConfig;
  /** Longest a single acquire() may wait before failing. */
  maxWaitMs?: number;
  /** Cooldown after a documented rate-limit error code. */
  penaltyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type GovernorStats = {
  acquired: number;
  waited: number;
  penalties: number;
  cooldownMs: number;
  orderRequests: number;
};

export type RestBudget = GovernorStats & {
  used: number;
  left: number;
  cap: number;
  refillPerSecond: number;
  waitForOneMs: number;
  maxWaitMs: number;
};

/**
 * Serialises and paces every REST request: one total bucket, one bucket per API id,
 * and a separate order lane so an order can never be starved by background reads.
 */
export class LimitGovernor {
  private readonly total: TokenBucket;
  private readonly order: TokenBucket;
  private readonly perApi = new Map<string, TokenBucket>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly penaltyMs: number;
  private cooldownUntil = 0;
  private stats: GovernorStats = {acquired: 0, waited: 0, penalties: 0, cooldownMs: 0, orderRequests: 0};

  constructor(private readonly options: GovernorOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.maxWaitMs = options.maxWaitMs ?? 15000;
    this.penaltyMs = options.penaltyMs ?? 1000;
    const start = this.now();
    this.total = new TokenBucket(options.total, start);
    this.order = new TokenBucket(options.order, start);
  }

  private bucket(apiId: string): TokenBucket {
    if (typeof apiId !== 'string' || !apiId.trim()) throw new Error('API ID가 필요합니다.');
    let bucket = this.perApi.get(apiId);
    if (!bucket) {
      bucket = new TokenBucket(this.options.perApi, this.now());
      this.perApi.set(apiId, bucket);
    }
    return bucket;
  }

  /** Reserve one slot for `apiId`. Resolves when the request may be sent. */
  async acquire(apiId: string, lane: 'read' | 'order' = 'read'): Promise<void> {
    const bucket = this.bucket(apiId);
    const started = this.now();
    for (;;) {
      const now = this.now();
      if (now < this.cooldownUntil) {
        const wait = Math.min(this.cooldownUntil - now, 250);
        if (this.now() - started + wait > this.maxWaitMs) throw new Error('키움 요청 대기 한도를 초과했습니다.');
        await this.sleep(wait);
        this.stats.waited += 1;
        continue;
      }
      const reserve = lane === 'order' || this.total.capacity < 3 ? 0 : 1;
      const need = Math.max(
        bucket.waitMs(now),
        this.total.waitMsFor(1 + reserve, now),
        lane === 'order' ? this.order.waitMs(now) : 0,
      );
      if (need === 0) {
        bucket.take(now);
        this.total.take(now);
        if (lane === 'order') {
          this.order.take(now);
          this.stats.orderRequests += 1;
        }
        this.stats.acquired += 1;
        return;
      }
      if (now - started + need > this.maxWaitMs) throw new Error('키움 요청 대기 한도를 초과했습니다.');
      await this.sleep(need);
      this.stats.waited += 1;
    }
  }

  /** Called after a documented rate-limit code to pause every lane briefly. */
  penalize(): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.penaltyMs);
    this.stats.penalties += 1;
  }

  snapshot(): GovernorStats & {cooldownMs: number} {
    return {...this.stats, cooldownMs: Math.max(0, this.cooldownUntil - this.now())};
  }

  budget(): RestBudget {
    const now = this.now();
    const left = this.total.available(now);
    const cap = this.total.capacity;
    const cool = Math.max(0, this.cooldownUntil - now);
    return {
      ...this.stats,
      cooldownMs: cool,
      used: Math.max(0, cap - left),
      left,
      cap,
      refillPerSecond: this.options.total.refillPerSecond,
      waitForOneMs: Math.max(this.total.waitMs(now), cool),
      maxWaitMs: this.maxWaitMs,
    };
  }

  /** n개 REST를 지금 내면 대기 ms. 한도를 넘으면 Infinity. */
  waitFor(n: number): number {
    const now = this.now();
    const cool = Math.max(0, this.cooldownUntil - now);
    const wait = this.total.waitMsFor(Math.max(0, n), now);
    return cool + wait;
  }

  canSendNow(n = 1): boolean {
    return this.waitFor(n) === 0;
  }
}

export type RealtimeLimits = {
  maxConnections: number;
  maxSubscriptions: number;
  maxItemsPerPacket: number;
};

/**
 * Realtime registration/connection caps. No official numeric limit was found in the
 * spec repository, so these are local safety budgets (`.env` overridable) and are
 * reported to the operator as unverified.
 */
export class RealtimeCaps {
  readonly limits: RealtimeLimits;
  constructor(limits: Partial<RealtimeLimits> = {}) {
    const merged: RealtimeLimits = {
      maxConnections: limits.maxConnections ?? 1,
      maxSubscriptions: limits.maxSubscriptions ?? 100,
      maxItemsPerPacket: limits.maxItemsPerPacket ?? 10,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`실시간 제한값이 올바르지 않습니다: ${key}`);
    }
    this.limits = merged;
  }

  assertConnection(count: number): void {
    if (count > this.limits.maxConnections) {
      throw new Error(`실시간 동시 연결 제한(${this.limits.maxConnections})을 초과했습니다.`);
    }
  }

  assertAddition(current: number, adding: number): void {
    if (current + adding > this.limits.maxSubscriptions) {
      throw new Error(`실시간 구독 제한(${this.limits.maxSubscriptions})을 초과했습니다: ${current}+${adding}`);
    }
  }

  assertPacket(items: number): void {
    if (items > this.limits.maxItemsPerPacket) {
      throw new Error(`실시간 등록 패킷당 종목 수(${this.limits.maxItemsPerPacket})를 초과했습니다.`);
    }
  }
}

/**
 * Order gate. It exists so order traffic would be *rate managed* in the same place as
 * everything else — but live order submission is not implemented in this project, so
 * every attempt is refused instead of being silently dropped or faked.
 */
export class OrderGate {
  private readonly governor: LimitGovernor;
  constructor(governor: LimitGovernor) {
    this.governor = governor;
  }

  /** Reserve the order lane. Never returns: submitting an order is not implemented. */
  async submit(): Promise<never> {
    await this.governor.acquire('kt10000', 'order');
    throw new Error('실거래·모의계좌 주문 전송은 구현되지 않았습니다. 주문은 전송되지 않습니다.');
  }
}
