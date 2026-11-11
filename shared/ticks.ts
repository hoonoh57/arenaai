import type {Candle} from '../server/core';

const NATIVE = new Set([1, 3, 5, 10, 30]);

export function parseTickTimeframe(tf: string): {native: string; group: number; ticks: number} | null {
  if (!/^T\d{1,5}$/.test(tf)) return null;
  const ticks = Number(tf.slice(1));
  if (!Number.isInteger(ticks) || ticks < 1) return null;
  if (NATIVE.has(ticks)) return {native: String(ticks), group: 1, ticks};
  if (ticks % 30 !== 0 || ticks > 7200) return null;
  return {native: '30', group: ticks / 30, ticks};
}

/** 오래된 불완전 묶음은 버리고, 최신 쪽부터 group개씩 OHLC를 합친다. */
export function aggregateTickBars(bars: Candle[], group: number): Candle[] {
  if (group <= 1) return bars;
  if (!bars.length) return [];
  const extra = bars.length % group;
  const out: Candle[] = [];
  for (let i = extra; i + group <= bars.length; i += group) {
    const slice = bars.slice(i, i + group);
    const last = slice[slice.length - 1];
    const vols = slice.map((s) => s.volume);
    out.push({
      time: last.time,
      open: slice[0].open,
      high: Math.max(...slice.map((s) => s.high)),
      low: Math.min(...slice.map((s) => s.low)),
      close: last.close,
      ...(vols.every((v) => typeof v === 'number') ? {volume: vols.reduce<number>((s, v) => s + (v || 0), 0)} : {}),
      ...(typeof last.strength === 'number' ? {strength: last.strength} : {}),
    });
  }
  return out;
}
