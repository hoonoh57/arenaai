/**
 * Bounded, allocation-stable containers used by the central realtime manager.
 * Nothing here fabricates data: a full buffer drops the oldest entry and reports it.
 */

export class RingBuffer<T> {
  readonly capacity: number;
  private items: T[] = [];
  private dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('링버퍼 크기는 1 이상의 정수여야 합니다.');
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  /** Number of entries evicted because the buffer was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  push(value: T): void {
    this.items.push(value);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
      this.dropped += 1;
    }
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  toArray(): T[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

/**
 * Sorted, de-duplicated candle ring. Candles are only ever *stored* here; they are
 * never derived from ticks (a partial tick stream cannot reconstruct a bar).
 */
export class CandleRing {
  readonly ring: RingBuffer<{time: number; open: number; high: number; low: number; close: number; volume?: number}>;

  constructor(capacity: number) {
    this.ring = new RingBuffer(capacity);
  }

  /** Merge REST-sourced candles. Later data wins only for the same bar time. */
  merge(candles: readonly {time: number; open: number; high: number; low: number; close: number; volume?: number}[]): void {
    const byTime = new Map<number, {time: number; open: number; high: number; low: number; close: number; volume?: number}>();
    for (const candle of this.ring.toArray()) byTime.set(candle.time, candle);
    for (const candle of candles) byTime.set(candle.time, candle);
    const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
    this.ring.clear();
    for (const candle of sorted.slice(-this.ring.capacity)) this.ring.push(candle);
  }

  toArray() {
    return this.ring.toArray();
  }

  lastTime(): number | null {
    return this.ring.last()?.time ?? null;
  }

  /** 진행 중 1분봉만 0B 체결가로 갱신. 과거 봉을 만들지 않는다. */
  applyQuote(time: number, price: number, volume?: number): 'update' | 'new' | 'none' {
    if (!Number.isFinite(time) || !(price > 0)) return 'none';
    const bucket = Math.floor(time / 60) * 60;
    const last = this.ring.last();
    if (!last) return 'none';
    if (last.time === bucket) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      if (typeof volume === 'number' && volume > 0) last.volume = (last.volume || 0) + volume;
      return 'update';
    }
    if (bucket > last.time) {
      if (bucket - last.time > 180) return 'none';
      this.ring.push({time: bucket, open: price, high: price, low: price, close: price, ...(volume ? {volume} : {})});
      return 'new';
    }
    return 'none';
  }

  clear(): void {
    this.ring.clear();
  }
}

/**
 * Time-bounded duplicate suppressor. `seen(key)` returns true the first time a key
 * is observed and false while it is still inside the TTL window.
 */
export class KeyedDedup {
  private readonly expiry = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(options: {ttlMs: number; max?: number}) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) throw new Error('중복 제거 TTL이 올바르지 않습니다.');
    this.ttlMs = options.ttlMs;
    this.max = options.max ?? 5000;
  }

  get size(): number {
    return this.expiry.size;
  }

  seen(key: string, now: number): boolean {
    const previous = this.expiry.get(key);
    if (previous !== undefined && now - previous <= this.ttlMs) return false;
    if (previous !== undefined) this.expiry.delete(key);
    this.expiry.set(key, now);
    if (this.expiry.size > this.max) {
      // Map preserves insertion order: evict the oldest entries first.
      for (const oldest of this.expiry.keys()) {
        this.expiry.delete(oldest);
        if (this.expiry.size <= this.max) break;
      }
    }
    return true;
  }

  clear(): void {
    this.expiry.clear();
  }
}

/**
 * Bounded set used to guarantee one simulated signal/trade per (rule, code, bar, side).
 * Entries are never expired because a bar is immutable once closed; the oldest keys
 * are evicted only when the bound is reached.
 */
export class SignalDedup {
  private readonly keys = new Set<string>();
  constructor(private readonly max = 20000) {
    if (!Number.isInteger(max) || max < 1) throw new Error('신호 중복 제거 크기가 올바르지 않습니다.');
  }

  get size(): number {
    return this.keys.size;
  }

  /** Returns true when the key is new (caller may act on it). */
  claim(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.max) {
      for (const oldest of this.keys) {
        this.keys.delete(oldest);
        break;
      }
    }
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  clear(): void {
    this.keys.clear();
  }
}
