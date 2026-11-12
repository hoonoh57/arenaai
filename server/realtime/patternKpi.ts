import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {signedReturn, summarizeByFilter, type KpiClosed, type KpiOpen, type KpiSide, type KpiSummary} from '../../shared/patternKpi';

const path = () => process.env.PATTERN_KPI_PATH || 'data/pattern-kpi.json';

type FileShape = {open: KpiOpen[]; closed: KpiClosed[]};

function loadFile(): FileShape {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as FileShape;
    return {open: Array.isArray(raw.open) ? raw.open : [], closed: Array.isArray(raw.closed) ? raw.closed : []};
  } catch {
    return {open: [], closed: []};
  }
}

export class PatternKpiStore {
  private open: KpiOpen[] = [];
  private closed: KpiClosed[] = [];

  constructor() {
    const f = loadFile();
    this.open = f.open;
    this.closed = f.closed.slice(-2000);
  }

  private persist(): void {
    mkdirSync(dirname(path()), {recursive: true});
    writeFileSync(path(), JSON.stringify({open: this.open, closed: this.closed.slice(-2000)}, null, 2), {mode: 0o600});
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

  snapshot(): {open: KpiOpen[]; summaries: KpiSummary[]} {
    return {open: this.open, summaries: summarizeByFilter(this.closed)};
  }
}
