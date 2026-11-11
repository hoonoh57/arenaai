export const HOLD_PRESETS = [
  {id: 1, label: '1분간'},
  {id: 3, label: '3분간'},
  {id: 5, label: '5분간'},
  {id: 10, label: '10분간'},
  {id: 15, label: '15분간'},
  {id: 30, label: '30분간'},
  {id: 60, label: '60분간'},
  {id: 420, label: '7시간'},
] as const;

export type VerifyRow = {
  code: string;
  name: string;
  matched: boolean;
  searchPrice: number | null;
  endPrice: number | null;
  volume?: number;
  returnPct: number | null;
  maxReturnPct: number | null;
  returns: Record<string, number | null>;
};

export type VerifySummary = {
  matched: number;
  upCount: number;
  flatCount: number;
  downCount: number;
  upRatio: number | null;
  avgReturn: number | null;
  rows: VerifyRow[];
};

export function parseSearchAt(date: string, time: string): number {
  const t = time && /^\d{2}:\d{2}$/.test(time) ? time : '09:00';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('검색시점을 확인하세요.');
  const ms = Date.parse(`${date}T${t}:00+09:00`);
  if (!Number.isFinite(ms)) throw new Error('검색시점을 확인하세요.');
  return Math.floor(ms / 1000);
}

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

export function classifyMove(ret: number | null): 'up' | 'flat' | 'down' | 'none' {
  if (ret === null || !Number.isFinite(ret)) return 'none';
  if (ret > 0.05) return 'up';
  if (ret < -0.05) return 'down';
  return 'flat';
}

export function indexAtOrBefore(times: number[], target: number): number {
  let idx = -1;
  for (let i = 0; i < times.length; i++) if (times[i] <= target) idx = i;
  return idx;
}

export function returnAfterMinutes(closes: number[], times: number[], searchIdx: number, minutes: number): number | null {
  if (searchIdx < 0 || searchIdx >= closes.length) return null;
  const target = times[searchIdx] + minutes * 60;
  const endIdx = indexAtOrBefore(times, target);
  if (endIdx < searchIdx) return null;
  return barReturn(closes[searchIdx], closes[endIdx]);
}

export function maxReturnFrom(closes: number[], searchIdx: number, endIdx: number): number | null {
  if (searchIdx < 0 || endIdx < searchIdx) return null;
  const start = closes[searchIdx];
  if (!(start > 0)) return null;
  let max = closes[searchIdx];
  for (let i = searchIdx; i <= endIdx && i < closes.length; i++) max = Math.max(max, closes[i]);
  return barReturn(start, max);
}

export function summarizeVerify(rows: VerifyRow[]): VerifySummary {
  const hit = rows.filter((r) => r.matched);
  const rets = hit.map((r) => r.returnPct);
  let upCount = 0,
    flatCount = 0,
    downCount = 0;
  const nums: number[] = [];
  for (const v of rets) {
    const c = classifyMove(v);
    if (c === 'up') upCount++;
    else if (c === 'flat') flatCount++;
    else if (c === 'down') downCount++;
    if (v !== null && Number.isFinite(v)) nums.push(v);
  }
  const avgReturn = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
  const upRatio = hit.length ? (upCount / hit.length) * 100 : null;
  return {matched: hit.length, upCount, flatCount, downCount, upRatio, avgReturn, rows: hit};
}
