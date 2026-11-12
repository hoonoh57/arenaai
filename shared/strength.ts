export type StrengthTick = {time: number; qty: number; strength: number};
export type StrengthBar = {time: number; open: number; high: number; low: number; close: number; volume?: number; strength?: number};

const SMALL_LOT = 10;
const NEUTRAL = 50;
const MIN_RUN = 3;
const SPIKE_HIGH = 200;
const SPIKE_LOW = 20;

export function parseStrengthTime(value: unknown, hintSec: number): number {
  const t = String(value ?? '').trim();
  if (/^\d{14}$/.test(t)) {
    const ms = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+09:00`);
    return Number.isFinite(ms) ? ms / 1000 : NaN;
  }
  if (!/^\d{6}$/.test(t) || !Number.isFinite(hintSec)) return NaN;
  const day = new Date((hintSec + 9 * 3600) * 1000);
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  const ms = Date.parse(`${y}-${m}-${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00`);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

export function parseStrengthTicks(rows: unknown, hintSec: number): StrengthTick[] {
  if (!Array.isArray(rows)) return [];
  const out: StrengthTick[] = [];
  let cursor = hintSec;
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const raw = r.cntr_tm ?? r.dt ?? r.date;
    const stamp = String(raw ?? '').trim();
    let time = parseStrengthTime(raw, cursor);
    if (/^\d{6}$/.test(stamp) && Number.isFinite(time) && Number.isFinite(cursor) && time > cursor + 120) time -= 86400;
    if (/^\d{6}$/.test(stamp) && Number.isFinite(time)) cursor = time;
    const qtyText = String(r.trde_qty ?? r.cntr_qty ?? '').trim().replace(/,/g, '');
    const strText = String(r.cntr_str ?? '').trim().replace(/,/g, '');
    const qty = /^[+-]?\d+(\.\d+)?$/.test(qtyText) ? Number(qtyText) : 0;
    const strength = /^[+-]?\d+(\.\d+)?$/.test(strText) ? Math.abs(Number(strText)) : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(strength)) continue;
    out.push({time, qty, strength});
  }
  if (out.length >= 2 && out[0].time > out[out.length - 1].time) out.reverse();
  return out.filter((x, i, a) => i === 0 || x.time !== a[i - 1].time || x.qty !== a[i - 1].qty);
}

/** 1~10주 등 소량 연속 매수(또는 동일 방향)로 튀는 체결강도를 50으로 둔다. */
export function correctSmallLotStrength(ticks: StrengthTick[], maxLot = SMALL_LOT): StrengthTick[] {
  const n = ticks.length;
  const small = ticks.map((t) => Math.abs(t.qty) > 0 && Math.abs(t.qty) <= maxLot);
  const sign = ticks.map((t) => (t.qty > 0 ? 1 : t.qty < 0 ? -1 : 0));
  return ticks.map((t, i) => {
    if (!small[i]) return t;
    let run = 1;
    for (let j = i - 1; j >= 0 && small[j] && sign[j] === sign[i] && sign[i] !== 0; j--) run++;
    for (let j = i + 1; j < n && small[j] && sign[j] === sign[i] && sign[i] !== 0; j++) run++;
    const spike = t.strength >= SPIKE_HIGH || t.strength <= SPIKE_LOW;
    if (run >= MIN_RUN || spike) return {...t, strength: NEUTRAL};
    return t;
  });
}

export function timeframeSeconds(tf: string): number {
  if (tf === 'D') return 86400;
  if (tf === 'W') return 7 * 86400;
  if (tf === 'M') return 30 * 86400;
  if (tf.startsWith('T')) return 1;
  const n = Number(tf);
  return Number.isFinite(n) && n > 0 ? n * 60 : 60;
}

export function alignStrengthToCandles<T extends StrengthBar>(candles: T[], ticks: StrengthTick[], timeframe: string): T[] {
  if (!candles.length || !ticks.length) return candles;
  const interval = timeframeSeconds(timeframe);
  let j = 0;
  return candles.map((c, i) => {
    const start = i === 0 ? c.time - interval : candles[i - 1].time;
    const end = c.time;
    while (j < ticks.length && ticks[j].time <= start) j++;
    let last: StrengthTick | undefined;
    let k = j;
    while (k < ticks.length && ticks[k].time <= end) {
      last = ticks[k];
      k++;
    }
    if (!last) return c;
    const raw = last.strength;
    return {...c, strength: raw === 0 ? undefined : raw};
  });
}

/** 봉마다 강도를 붙인 뒤 0·빈칸은 앞·뒤 유효값으로 채워 차트 전체에 그린다. */
export function fillStrengthOnCandles<T extends StrengthBar>(candles: T[], ticks: StrengthTick[], timeframe: string): T[] {
  const aligned = alignStrengthToCandles(candles, ticks, timeframe);
  const fwd = carryStrength(aligned.map((c) => c.strength));
  const first = fwd.find((v) => v !== null) ?? null;
  return aligned.map((c, i) => {
    const v = fwd[i] ?? first;
    return v === null ? c : {...c, strength: v};
  });
}

/** 0·결측은 직전 유효 강도로 채운다. 맨 앞이 비면 그대로 비운다. */
export function carryStrength(values: Array<number | null | undefined>): Array<number | null> {
  let last: number | null = null;
  return values.map((v) => {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
      last = v;
      return v;
    }
    return last;
  });
}

export function strengthPageBudget(barCount: number): number {
  const n = Number.isFinite(barCount) ? Math.max(1, Math.min(500, Math.floor(barCount))) : 1;
  return Math.min(16, Math.max(1, Math.ceil(n / 20)));
}
