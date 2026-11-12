import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {signedReturn, summarizeByFilter, type KpiClosed, type KpiOpen, type KpiSide, type KpiSummary} from '../../shared/patternKpi';
import {maRegime, type MaLeg, type MaRegime} from '../../shared/maRoundTrip';

const path = () => process.env.PATTERN_KPI_PATH || 'data/pattern-kpi.json';

type FileShape = {open: KpiOpen[]; closed: KpiClosed[]; maLegs?: MaLeg[]};

function loadFile(): FileShape {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as FileShape;
    return {open: Array.isArray(raw.open) ? raw.open : [], closed: Array.isArray(raw.closed) ? raw.closed : [], maLegs: Array.isArray(raw.maLegs) ? raw.maLegs : []};
  } catch {
    return {open: [], closed: []};
  }
}

export class PatternKpiStore {
  private open: KpiOpen[] = [];
  private closed: KpiClosed[] = [];
  private maLegs: MaLeg[] = [];

  constructor() {
    const f = loadFile();
    this.open = f.open;
    this.closed = f.closed.slice(-2000);
    this.maLegs = (f.maLegs || []).slice(-2000);
  }

  private persist(): void {
    mkdirSync(dirname(path()), {recursive: true});
    writeFileSync(path(), JSON.stringify({open: this.open, closed: this.closed.slice(-2000), maLegs: this.maLegs.slice(-2000)}, null, 2), {mode: 0o600});
  }

  /**
   * 신호 봉 종가로 다리를 연다. 같은 종목에 반대(또는 다음) 신호가 오면
   * 그 종가와의 등락률을 필터 KPI에 누적한다.
   */
  record(input: {code: string; side: KpiSide; close: number; time: number; filters: string[]}): KpiClosed | null {
    if (!/^\d{6}$/.test(input.code) || !(input.close > 0) || !(input.time > 0)) return null;
    const prev = this.open.find((o) => o.code === input.code);
    let closed: KpiClosed | null = null;
    if (prev) {
      closed = {
        code: prev.code,
        side: prev.side,
        filters: prev.filters,
        entryTime: prev.entryTime,
        entryClose: prev.entryClose,
        exitTime: input.time,
        exitClose: input.close,
        signedPct: signedReturn(prev.side, prev.entryClose, input.close),
      };
      this.closed.push(closed);
      this.open = this.open.filter((o) => o.code !== input.code);
    }
    this.open.push({code: input.code, side: input.side, filters: input.filters.filter(Boolean), entryTime: input.time, entryClose: input.close});
    this.persist();
    return closed;
  }

  ingestMaLegs(legs: MaLeg[]): number {
    const seen = new Set(this.maLegs.map((l) => `${l.code}|${l.entryTime}`));
    let n = 0;
    for (const leg of legs) {
      const key = `${leg.code}|${leg.entryTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.maLegs.push(leg);
      this.closed.push({
        code: leg.code,
        side: 'buy',
        filters: ['ma-cross', 'skip001'],
        entryTime: leg.entryTime,
        entryClose: leg.entryClose,
        exitTime: leg.exitTime,
        exitClose: leg.exitClose,
        signedPct: leg.signedPct,
      });
      n += 1;
    }
    if (n) this.persist();
    return n;
  }

  maSummary(): MaRegime {
    return maRegime(this.maLegs);
  }

  snapshot(): {open: KpiOpen[]; summaries: KpiSummary[]; ma: MaRegime} {
    return {open: this.open, summaries: summarizeByFilter(this.closed), ma: this.maSummary()};
  }
}
