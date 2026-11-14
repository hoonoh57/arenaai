/**
 * 키움·CYBOS 공통. 시세는 최근→과거로 오고, 초가 없는 틱(hhmm)이 있다.
 * sort / time unique 제거 금지. 전부 받은 뒤 reverse 한 번만.
 */

export function newestFirstToChrono<T>(rows: readonly T[]): T[] {
  const out = rows.slice();
  if (out.length >= 2) out.reverse();
  return out;
}

/** pages[0] = 첫 수신 = 가장 최근. 이어 붙인 뒤 한 번만 reverse. */
export function concatNewestPages<T>(pages: readonly (readonly T[])[]): T[] {
  const all: T[] = [];
  for (const p of pages) all.push(...p);
  return newestFirstToChrono(all);
}

/** YYYYMMDD + hhmm(+optional ss) → 키움과 같은 KST unix 초. 봉 종료시각. */
export function kstBarUnix(date: number | string, hhmm = 0, second = 0): number {
  const d = String(date).replace(/\D/g, '').padStart(8, '0').slice(0, 8);
  const hm = Number(hhmm);
  const h = Math.floor(hm / 100);
  const min = hm % 100;
  const s = Math.max(0, Math.min(59, Number(second) || 0));
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${pad2(h)}:${pad2(min)}:${pad2(s)}+09:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** reverse 이후(오래된→최신) 같은 hhmm 틱에 초를 붙여 키움 time과 맞춘다. sort 없음. */
export function stampTickUnix(
  rows: readonly {date: number | string; hhmm: number | string}[],
): number[] {
  const out: number[] = [];
  let prevKey = '';
  let sec = 0;
  for (const r of rows) {
    const d = String(r.date).replace(/\D/g, '').slice(0, 8);
    const hm = String(Number(r.hhmm)).padStart(4, '0');
    const key = `${d}${hm}`;
    if (key === prevKey) sec = Math.min(59, sec + 1);
    else {
      prevKey = key;
      sec = 0;
    }
    out.push(kstBarUnix(d, Number(hm), sec));
  }
  return out;
}
