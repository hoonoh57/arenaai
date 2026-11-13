import {rank, type Candle, type Stock, type Weights} from '../core';
import {AuditLog} from './audit';
import {SharedCache} from './cache';
import {RealtimeHub} from './hub';
import type {BrokerLike} from './hub';
import {kstDate, type Quote} from './protocol';
import {planSubscriptions} from './plan';
import {parseConditionRow} from '../kiwoom';

export type StrengthSnapshot = {strength: number | null; value: number | null; change?: number | null};

export type BridgeBroker = BrokerLike & {
  conditions?: never;
  /** ka10046 fallback when a captured code has no realtime quote yet. */
  strengthSnapshot?: (code: string) => Promise<StrengthSnapshot>;
};

export type BridgeConfig = {seq: string; count: number; weights: Weights; chartCodes?: readonly string[]};

export type BridgeOptions = {
  hub: RealtimeHub;
  cache: SharedCache;
  audit: AuditLog;
  broker: BridgeBroker;
  now?: () => number;
  /** How long a REST fallback snapshot stays valid. */
  fallbackTtlMs?: number;
  /** Extra captured codes that get a realtime 0B subscription for ranking. */
  quoteBudget?: number;
  /** Max ka10046 fallback calls per ranking pass (each one is a governed REST call). */
  fallbackBudget?: number;
  /** Quotes older than this are treated as missing (never ranked as if live). */
  quoteTtlMs?: number;
  /** Hard subscription cap; defaults to the hub's reported cap. */
  maxSubscriptions?: number;
};

export type RankingResult = {ranking: Stock[]; selected: Stock[]; warnings: Record<string, string>};

function uniqueCodesForPlan(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || !/^\d{6}$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * The only surface demand logic (dashboard routes, charts, strategy) may use.
 *
 * A chart never touches the Kiwoom client or the WebSocket directly: it asks the bridge,
 * which asks the central hub, which owns connection, subscription, limit and audit state.
 */
export class DemandBridge {
  private readonly hub: RealtimeHub;
  private readonly cache: SharedCache;
  private readonly audit: AuditLog;
  private readonly broker: BridgeBroker;
  private readonly now: () => number;
  private readonly fallbackTtlMs: number;
  private readonly quoteBudget: number;
  private readonly fallbackBudget: number;
  private readonly quoteTtlMs: number;
  private readonly maxSubscriptions?: number;
  private rotationCursor = 0;
  private lastPlan = {watched: 0, skipped: 0};
  private readonly fallback = new Map<string, {at: number; snapshot: StrengthSnapshot}>();
  private readonly captureSnapshot = new Map<string, {price: number; change: number}>();
  private readonly names = new Map<string, string>();
  private config: BridgeConfig | null = null;
  private watched: string[] = [];
  private conditionsCache: {seq: string; name: string}[] = [];
  lastSearch: {seq: string; rows: number; sample: Record<string, unknown>[]} = {seq: '', rows: 0, sample: []};

  constructor(options: BridgeOptions) {
    this.hub = options.hub;
    this.cache = options.cache;
    this.audit = options.audit;
    this.broker = options.broker;
    this.now = options.now ?? Date.now;
    this.fallbackTtlMs = options.fallbackTtlMs ?? 10000;
    this.quoteBudget = options.quoteBudget ?? 40;
    this.fallbackBudget = options.fallbackBudget ?? 20;
    this.quoteTtlMs = options.quoteTtlMs ?? 30000;
    this.lastSearch = {seq: '', rows: 0, sample: []};
    this.maxSubscriptions = options.maxSubscriptions;
    if (!Number.isFinite(this.quoteTtlMs) || this.quoteTtlMs < 0) throw new Error('시세 신선도 한도가 올바르지 않습니다.');
    if (!Number.isFinite(this.fallbackTtlMs) || this.fallbackTtlMs < 0) throw new Error('REST 대체 데이터 TTL이 올바르지 않습니다.');
  }

  /** Condition list via the central session (CNSRLST). */
  async loadConditions(): Promise<{seq: string; name: string}[]> {
    const frame = await this.hub.request({trnm: 'CNSRLST'}, 'CNSRLST');
    const rows = Array.isArray(frame.data) ? frame.data : [];
    const list: {seq: string; name: string}[] = [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        const seq = String(row[0] ?? '').trim();
        const name = String(row[1] ?? '').trim();
        if (seq && name) list.push({seq, name});
      } else if (row && typeof row === 'object') {
        const record = row as Record<string, unknown>;
        const seq = String(record.seq ?? '').trim();
        const name = String(record.name ?? '').trim();
        if (seq && name) list.push({seq, name});
      }
    }
    if (!list.length) throw new Error('조건식 목록 응답이 비어 있습니다.');
    this.conditionsCache = list;
    this.audit.record('state', '조건식 목록을 조회했습니다.', {count: list.length});
    return list;
  }

  conditions(): {seq: string; name: string}[] {
    return [...this.conditionsCache];
  }

  /**
   * Apply a configuration: capture the condition (initial list + realtime insert/delete),
   * then prime candles for the selected codes through the governed REST lane.
   */
  async apply(config: BridgeConfig): Promise<RankingResult> {
    if (!this.hub.isReady) throw new Error('실시간 세션이 준비되지 않았습니다.');
    if (!config.seq) throw new Error('조건식을 선택하세요.');
    this.config = config;
    this.cache.clearCaptures(config.seq);
    this.cache.clearCandles();
    this.fallback.clear();
    this.audit.record('state', '조건검색을 다시 시작합니다.', {seq: config.seq, count: config.count});

    const snapshot = await this.hub.request(
      {trnm: 'CNSRREQ', seq: config.seq, search_type: '0', stex_tp: 'K', cont_yn: 'N', next_key: ''},
      'CNSRREQ',
    );
    try {
      await this.hub.request({trnm: 'CNSRREQ', seq: config.seq, search_type: '1', stex_tp: 'K'}, 'CNSRREQ');
    } catch {
      /* 실시간 구독 실패해도 스냅샷은 보여 준다 */
    }
    const rows = flattenSearchRows(snapshot.data);
    this.lastSearch = {seq: config.seq, rows: rows.length, sample: rows.slice(0, 2)};
    this.captureSnapshot.clear();
    for (const record of rows) {
      const code = String(record['9001'] ?? record.stk_cd ?? record.code ?? '').trim().replace(/^A(?=\d{6}$)/, '');
      if (!/^\d{6}$/.test(code)) continue;
      // 조건검색 응답은 등락률(고정소수점)·현재가를 함께 주므로 초기 표시에 사용한다.
      // 실시간 체결이 도착하면 0B 값이 우선한다.
      try {
        const parsed = parseConditionRow(record);
        if (parsed) {
          this.names.set(parsed.code, parsed.name);
          this.captureSnapshot.set(parsed.code, {price: parsed.price, change: parsed.change});
        }
      } catch {
        /* 값을 해석할 수 없으면 순위에서 제외하고 경고로 남긴다 */
      }
      this.cache.applyCondition({seq: config.seq, code, action: 'insert', time: null});
    }
    this.audit.record('state', '조건검색 초기 목록을 수신했습니다.', {codes: this.cache.capturedCodes(config.seq).length});
    return this.syncSubscriptions(config);
  }

  /**
   * Re-align realtime subscriptions with the current selection and re-prime missing
   * candles. Safe to call repeatedly (after every tick, reconnect or config change).
   */
  async syncSubscriptions(config: BridgeConfig = this.requireConfig(), opts?: {rotate?: boolean}): Promise<RankingResult> {
    const ranking = await this.computeRanking(config);
    const selectedCodes = ranking.selected.map((stock) => stock.code);
    const pinned = uniqueCodesForPlan([...(config.chartCodes || []), ...selectedCodes]);
    const plan = planSubscriptions({
      selected: pinned,
      captured: this.cache.capturedCodes(config.seq),
      maxSubscriptions: this.maxSubscriptions ?? this.hub.status().caps?.maxSubscriptions ?? 100,
      budget: this.quoteBudget,
      cursor: opts?.rotate === false ? 0 : this.rotationCursor,
    });
    if (opts?.rotate !== false) this.rotationCursor = plan.cursor;
    this.lastPlan = {watched: plan.watch.length, skipped: plan.skipped};
    const desired = plan.watch;

    const added = desired.filter((code) => !this.watched.includes(code));
    const removed = this.watched.filter((code) => !desired.includes(code));
    if (added.length) await this.hub.subscribe('bridge:quotes', added, ['0B']);
    if (removed.length) await this.hub.unsubscribe('bridge:quotes', removed, ['0B']);
    this.watched = desired;

    this.hub.setActiveCodes([...new Set([...selectedCodes, ...config.chartCodes])]);
    return this.computeRanking(config);
  }

  private requireConfig(): BridgeConfig {
    if (!this.config) throw new Error('조건검색 설정이 없습니다.');
    return this.config;
  }

  /**
   * Weighted ranking from shared cache values. A captured code participates only when
   * 등락률·체결강도·누적거래대금 are all known; otherwise it is reported as a warning
   * instead of being ranked with a guessed value.
   */
  async computeRanking(config: BridgeConfig = this.requireConfig()): Promise<RankingResult> {
    const warnings: Record<string, string> = {};
    const codes = this.cache.capturedCodes(config.seq);
    const items: Omit<Stock, 'score'>[] = [];
    let fallbackCalls = 0;
    for (const code of codes) {
      const quote = this.freshQuote(code);
      const captured = this.captureSnapshot.get(code);
      let change = quote?.changePct ?? captured?.change ?? null;
      let strength = quote?.strength ?? null;
      let value = quote?.cumValue ?? null;
      if ((strength === null || value === null) && this.broker.strengthSnapshot) {
        // 실시간 체결이 아직 도착하지 않은 종목만, 한 번의 계산에서 정해진 횟수까지만 조회한다.
        const cached = this.fallback.get(code);
        const fresh = cached !== undefined && this.now() - cached.at <= this.fallbackTtlMs;
        if (fresh) {
          strength = strength ?? cached.snapshot.strength;
          value = value ?? cached.snapshot.value;
        } else if (fallbackCalls < this.fallbackBudget) {
          fallbackCalls += 1;
          const snapshot = await this.snapshotFallback(code);
          strength = strength ?? snapshot.strength;
          value = value ?? snapshot.value;
        }
      }
      if (change === null || strength === null || value === null) {
        warnings[code] = '실시간 시세·체결강도·누적거래대금 대기';
        continue;
      }
      items.push({
        code,
        name: this.names.get(code) ?? code,
        price: quote?.price ?? captured?.price ?? 0,
        change,
        strength,
        value,
      });
    }
    const scored = items.length ? rank(items, config.weights, config.count) : [];
    const scoredCodes = new Set(scored.map((stock) => stock.code));
    const waiting: Stock[] = [];
    for (const code of codes) {
      if (scoredCodes.has(code) || waiting.length + scored.length >= config.count) continue;
      waiting.push({
        code,
        name: this.names.get(code) ?? code,
        price: this.freshQuote(code)?.price ?? this.captureSnapshot.get(code)?.price ?? 0,
        change: this.freshQuote(code)?.changePct ?? this.captureSnapshot.get(code)?.change ?? 0,
        strength: this.freshQuote(code)?.strength ?? 0,
        value: this.freshQuote(code)?.cumValue ?? 0,
        score: -1,
      });
    }
    const ranking = [...scored, ...waiting];
    if (!ranking.length) return {ranking: [], selected: [], warnings};
    const wanted = (config.chartCodes ?? []).filter((code) => /^\d{6}$/.test(code));
    const byCode = new Map(ranking.map((stock) => [stock.code, stock]));
    const selected = wanted.map((code) => byCode.get(code)).filter((stock): stock is Stock => Boolean(stock));
    return {ranking, selected, warnings};
  }

  /** A quote is only usable while it is fresh; stale data is reported, never ranked. */
  private freshQuote(code: string): Quote | undefined {
    const quote = this.cache.getQuote(code);
    if (!quote) return undefined;
    if (this.now() - quote.receivedAt > this.quoteTtlMs) return undefined;
    return quote;
  }

  async snapshotFallback(code: string): Promise<StrengthSnapshot> {
    const cached = this.fallback.get(code);
    if (cached && this.now() - cached.at <= this.fallbackTtlMs) return cached.snapshot;
    if (!this.broker.strengthSnapshot) return {strength: null, value: null};
    const snapshot = await this.broker.strengthSnapshot(code);
    this.fallback.set(code, {at: this.now(), snapshot});
    return snapshot;
  }

  candles(code: string): Candle[] {
    return this.cache.candles(code);
  }

  candlesByCode(codes: readonly string[]): Record<string, Candle[]> {
    const result: Record<string, Candle[]> = {};
    for (const code of codes) {
      const candles = this.cache.candles(code);
      if (candles.length) result[code] = candles;
    }
    return result;
  }

  chartPages(): Record<string, Candle[]> {
    return this.cache.chartPages();
  }

  warnings(): Record<string, string> {
    return this.cache.warnings();
  }

  capturedList(): {code: string; name: string}[] {
    if (!this.config) return [];
    return this.cache.capturedCodes(this.config.seq).map((code) => ({code, name: this.names.get(code) ?? code}));
  }

  /** Simulated positions/events owned by the central manager. */
  positions(): Record<string, number> {
    return this.hub.positionsSnapshot();
  }

  events(limit = 50) {
    return this.hub.eventsSnapshot(limit);
  }

  /** Refresh one chart's candles on demand (still governed by the central REST lane). */
  async refreshChart(code: string): Promise<Candle[]> {
    const today = kstDate(this.now());
    return this.hub.refreshCandles(code, {baseDate: today});
  }

  /** Re-run simulated signal evaluation for the active codes (e.g. after a formula save). */
  reevaluate(codes: readonly string[]): void {
    for (const code of codes) this.hub.evaluateSignals(code);
  }

  status() {
    return {
      hub: this.hub.status(),
      cache: this.cache.stats(),
      watched: this.watched.length,
      rotation: {cursor: this.rotationCursor, watched: this.lastPlan.watched, skipped: this.lastPlan.skipped},
      quoteTtlMs: this.quoteTtlMs,
      captured: this.config ? this.cache.capturedCodes(this.config.seq).length : 0,
      lastSearch: this.lastSearch,
      fallbackTtlMs: this.fallbackTtlMs,
      capabilities: this.cache.capabilities(),
    };
  }
}

function flattenSearchRows(raw: unknown): Record<string, unknown>[] {
  const lists: unknown[] = [];
  if (Array.isArray(raw)) lists.push(raw);
  else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['data', 'output', 'list', 'stk_cd_list']) {
      if (Array.isArray(obj[key])) lists.push(obj[key]);
    }
    if (!lists.length) lists.push([raw]);
  }
  const rows: Record<string, unknown>[] = [];
  for (const list of lists) {
    for (const row of list as unknown[]) {
      if (Array.isArray(row)) {
        const code = String(row[0] ?? '').trim();
        const name = String(row[1] ?? '').trim();
        rows.push({'9001': code, '302': name, '10': row[2], '12': row[3]});
      } else if (row && typeof row === 'object') {
        const rec = row as Record<string, unknown>;
        if (rec.values && typeof rec.values === 'object') rows.push(rec.values as Record<string, unknown>);
        else rows.push(rec);
      } else if (typeof row === 'string' && /^\d{6}$/.test(row.replace(/^A/, ''))) {
        rows.push({'9001': row});
      }
    }
  }
  return rows;
}
