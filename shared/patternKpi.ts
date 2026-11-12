export type KpiSide = 'buy' | 'sell';

export type KpiClosed = {
  code: string;
  side: KpiSide;
  filters: string[];
  entryTime: number;
  entryClose: number;
  exitTime: number;
  exitClose: number;
  /** 매수는 상승 +, 매도는 하락 +. 반대면 음수(감점). */
  signedPct: number;
};

export type KpiOpen = {
  code: string;
  side: KpiSide;
  filters: string[];
  entryTime: number;
  entryClose: number;
};

export type KpiSummary = {
  filterId: string;
  n: number;
  avgPct: number;
  sumPct: number;
  score: number;
  ready: boolean;
  spanSec: number;
};

export function signedReturn(side: KpiSide, entryClose: number, exitClose: number): number {
  if (!(entryClose > 0) || !(exitClose > 0)) return 0;
  const raw = (exitClose - entryClose) / entryClose;
  return side === 'buy' ? raw : -raw;
}

/** 평균 등락률을 0~100 점수로. 표본 5건 또는 3일이면 평가 가능. */
export function kpiScore(samples: number[], spanSec = 0, minN = 5, minSpanSec = 3 * 86400): {n: number; avgPct: number; sumPct: number; score: number; ready: boolean; spanSec: number} {
  const n = samples.length;
  const sumPct = samples.reduce((s, x) => s + x, 0);
  const avgPct = n ? sumPct / n : 0;
  const score = Math.max(0, Math.min(100, Math.round(50 + avgPct * 500)));
  const ready = n >= minN || spanSec >= minSpanSec;
  return {n, avgPct, sumPct, score, ready, spanSec};
}

export function summarizeByFilter(closed: KpiClosed[], nowSec = Date.now() / 1000): KpiSummary[] {
  const by = new Map<string, KpiClosed[]>();
  for (const row of closed) {
    const ids = row.filters.length ? row.filters : ['signal'];
    for (const id of ids) {
      const list = by.get(id) || [];
      list.push(row);
      by.set(id, list);
    }
  }
  return [...by.entries()]
    .map(([filterId, rows]) => {
      const times = rows.flatMap((r) => [r.entryTime, r.exitTime]);
      const spanSec = times.length ? Math.max(...times) - Math.min(...times) : 0;
      return {filterId, ...kpiScore(rows.map((r) => r.signedPct), Math.max(spanSec, nowSec - Math.min(...times, nowSec)))};
    })
    .sort((a, b) => b.score - a.score || a.filterId.localeCompare(b.filterId));
}
