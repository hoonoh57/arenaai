/**
 * 중앙관리자에 등록된 업무의 소요시간과 제약(한도·거절)을 모은다.
 * 수요 로직보다 먼저 이 숫자로 병목을 본다.
 */

export type HubOpName =
  | 'ensureChartPage'
  | 'ensureStrengthPage'
  | 'applyLiveTick'
  | 'applyLiveQuote'
  | 'subscribe'
  | 'unsubscribe'
  | 'evaluateSignals'
  | 'bookSnapshot'
  | 'planWatch'
  | 'status'
  | 'putChartPage'
  | 'chartPage'
  | 'getQuote';

export type HubOpTarget = {targetMs: number; note: string};

export const HUB_OP_TARGETS: Record<HubOpName, HubOpTarget> = {
  ensureChartPage: {targetMs: 50, note: '게이트 히트는 캐시. REST는 governor 대기 별도'},
  ensureStrengthPage: {targetMs: 50, note: '한 페이지. 창 루프 금지'},
  applyLiveTick: {targetMs: 8, note: '열린 종목 페이지에 체결 반영'},
  applyLiveQuote: {targetMs: 5, note: '1분 링'},
  subscribe: {targetMs: 15, note: '이미 있으면 REG 없음'},
  unsubscribe: {targetMs: 15, note: '소유자 0일 때만 REMOVE'},
  evaluateSignals: {targetMs: 25, note: '확정 봉만'},
  bookSnapshot: {targetMs: 5, note: '보유·미체결'},
  planWatch: {targetMs: 8, note: '차트 종목 고정, 조건식은 잔여 슬롯'},
  status: {targetMs: 3, note: '감독 스냅샷'},
  putChartPage: {targetMs: 5, note: '공유 캐시 기록'},
  chartPage: {targetMs: 3, note: '공유 캐시 읽기'},
  getQuote: {targetMs: 2, note: '최근 체결'},
};

export type HubOpStats = {
  name: HubOpName;
  targetMs: number;
  runs: number;
  errors: number;
  constraints: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  overTarget: number;
};

function empty(name: HubOpName): HubOpStats {
  return {
    name,
    targetMs: HUB_OP_TARGETS[name].targetMs,
    runs: 0,
    errors: 0,
    constraints: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    overTarget: 0,
  };
}

export class HubOps {
  private readonly byName = new Map<HubOpName, HubOpStats>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    for (const name of Object.keys(HUB_OP_TARGETS) as HubOpName[]) this.byName.set(name, empty(name));
  }

  noteConstraint(name: HubOpName): void {
    const row = this.byName.get(name);
    if (row) row.constraints += 1;
  }

  runSync<T>(name: HubOpName, task: () => T): T {
    const row = this.row(name);
    const t0 = this.now();
    try {
      const out = task();
      this.finish(row, t0, false);
      return out;
    } catch (e) {
      this.finish(row, t0, true);
      this.flagConstraint(row, e);
      throw e;
    }
  }

  async run<T>(name: HubOpName, task: () => Promise<T> | T): Promise<T> {
    const row = this.row(name);
    const t0 = this.now();
    try {
      const out = await task();
      this.finish(row, t0, false);
      return out;
    } catch (e) {
      this.finish(row, t0, true);
      this.flagConstraint(row, e);
      throw e;
    }
  }

  private row(name: HubOpName): HubOpStats {
    const row = this.byName.get(name) ?? empty(name);
    this.byName.set(name, row);
    return row;
  }

  private flagConstraint(row: HubOpStats, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (/한도|제한|TRNM|대기|초과|준비되지/.test(msg)) row.constraints += 1;
  }

  private finish(row: HubOpStats, t0: number, error: boolean): void {
    const ms = Math.max(0, this.now() - t0);
    row.runs += 1;
    if (error) row.errors += 1;
    row.totalMs += ms;
    row.lastMs = ms;
    if (ms > row.maxMs) row.maxMs = ms;
    if (ms > row.targetMs) row.overTarget += 1;
  }

  snapshot(): HubOpStats[] {
    return [...this.byName.values()].map((r) => ({...r}));
  }

  report(): {
    rows: Array<HubOpStats & {avgMs: number; bottleneck: boolean}>;
    bottlenecks: string[];
  } {
    const rows = this.snapshot().map((r) => {
      const avgMs = r.runs ? r.totalMs / r.runs : 0;
      const bottleneck = r.runs > 0 && (avgMs > r.targetMs || r.overTarget / r.runs > 0.2 || r.constraints > 0);
      return {...r, avgMs, bottleneck};
    });
    return {rows, bottlenecks: rows.filter((r) => r.bottleneck).map((r) => r.name)};
  }
}
