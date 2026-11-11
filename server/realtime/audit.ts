/**
 * Append-only audit trail owned by the central manager.
 * Every state transition, subscription change, REST throttle event, simulated signal
 * and simulated position change is recorded here so the operator can reconstruct what
 * happened — including the *absence* of orders.
 */
export type AuditCategory =
  | 'state'
  | 'connection'
  | 'subscription'
  | 'rest'
  | 'limit'
  | 'signal'
  | 'position'
  | 'order'
  | 'risk'
  | 'error';

export type AuditEntry = {
  id: number;
  at: number;
  category: AuditCategory;
  message: string;
  detail?: Record<string, unknown>;
};

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private nextId = 1;
  private readonly sink?: (entry: AuditEntry) => void;

  constructor(options: {capacity?: number; now?: () => number; sink?: (entry: AuditEntry) => void} = {}) {
    this.capacity = options.capacity ?? 2000;
    this.now = options.now ?? Date.now;
    this.sink = options.sink;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new Error('감사 로그 크기가 올바르지 않습니다.');
  }

  record(category: AuditCategory, message: string, detail?: Record<string, unknown>): AuditEntry {
    if (typeof message !== 'string' || !message.trim()) throw new Error('감사 로그 메시지가 필요합니다.');
    const entry: AuditEntry = {id: this.nextId++, at: this.now(), category, message, ...(detail ? {detail} : {})};
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    try {
      this.sink?.(entry);
    } catch {
      /* 파일 기록 실패는 메모리 로그를 막지 않는다 */
    }
    return entry;
  }

  today(tab: 'system' | 'trade'): AuditEntry[] {
    const trade = new Set<AuditCategory>(['order', 'signal', 'position']);
    return this.entries.filter((e) => (tab === 'trade' ? trade.has(e.category) : !trade.has(e.category))).reverse();
  }

  /** Newest first, bounded. */
  list(limit = 100): AuditEntry[] {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('감사 로그 조회 개수가 올바르지 않습니다.');
    return this.entries.slice(-limit).reverse();
  }

  get size(): number {
    return this.entries.length;
  }

  counts(): Partial<Record<AuditCategory, number>> {
    const result: Partial<Record<AuditCategory, number>> = {};
    for (const entry of this.entries) result[entry.category] = (result[entry.category] ?? 0) + 1;
    return result;
  }
}
