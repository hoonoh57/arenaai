export type VerifyRow = {
  code: string;
  name: string;
  matched: boolean;
  searchPrice: number | null;
  endPrice: number | null;
  volume?: number;
  returnPct: number | null;
};

export type VerifySummary = {
  matched: number;
  upCount: number;
  upRatio: number | null;
  avgReturn: number | null;
  rows: VerifyRow[];
};

export function holdEndDate(searchYmd: string, holdDays: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(searchYmd) || !Number.isInteger(holdDays) || holdDays < 1 || holdDays > 3650) {
    throw new Error('검색시점과 수익률기간을 확인하세요.');
  }
  const ms = Date.parse(`${searchYmd}T00:00:00+09:00`) + holdDays * 86400000;
  if (!Number.isFinite(ms)) throw new Error('검색시점을 확인하세요.');
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

export function barReturn(search: number, end: number): number | null {
  if (!(search > 0) || !(end > 0)) return null;
  return ((end - search) / search) * 100;
}

export function summarizeVerify(rows: VerifyRow[]): VerifySummary {
  const hit = rows.filter((r) => r.matched);
  const rets = hit.map((r) => r.returnPct).filter((v): v is number => v !== null && Number.isFinite(v));
  const upCount = rets.filter((v) => v > 0).length;
  const avgReturn = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : null;
  const upRatio = hit.length ? (upCount / hit.length) * 100 : null;
  return {matched: hit.length, upCount, upRatio, avgReturn, rows: hit};
}
