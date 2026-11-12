import type {Candle} from '../server/core';
import {kpiScore} from './patternKpi';

export type MaLeg = {
  code: string;
  entryTime: number;
  entryClose: number;
  exitTime: number;
  exitClose: number;
  signedPct: number;
  rangePct: number;
  bars: number;
};

export type MaRegime = {
  n: number;
  avgPct: number;
  avgLoserRange: number;
  loseRate: number;
  ready: boolean;
  score: number;
};

function rangePct(bars: Candle[], entry: number): number {
  if (!bars.length || !(entry > 0)) return 0;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  return (hi - lo) / entry;
}

export function extractMaLegs(code: string, candles: Candle[], buys: unknown[], sells: unknown[]): MaLeg[] {
  const out: MaLeg[] = [];
  let open: {i: number; close: number; time: number} | null = null;
  const n = Math.min(candles.length, buys.length, sells.length);
  for (let i = 0; i < n; i++) {
    const buy = Boolean(buys[i]);
    const sell = Boolean(sells[i]);
    if (buy && sell) continue;
    if (buy && !open) {
      open = {i, close: candles[i].close, time: candles[i].time};
      continue;
    }
    if (sell && open && candles[i].close > 0) {
      const slice = candles.slice(open.i, i + 1);
      out.push({
        code,
        entryTime: open.time,
        entryClose: open.close,
        exitTime: candles[i].time,
        exitClose: candles[i].close,
        signedPct: (candles[i].close - open.close) / open.close,
        rangePct: rangePct(slice, open.close),
        bars: i - open.i,
      });
      open = null;
    }
  }
  return out;
}

export function maRegime(legs: MaLeg[], lastN = 20): MaRegime {
  const recent = legs.slice(-lastN);
  const pcts = recent.map((l) => l.signedPct);
  const losers = recent.filter((l) => l.signedPct <= 0);
  const avgLoserRange = losers.length ? losers.reduce((s, l) => s + l.rangePct, 0) / losers.length : 0;
  const scored = kpiScore(pcts);
  return {
    n: recent.length,
    avgPct: scored.avgPct,
    avgLoserRange,
    loseRate: recent.length ? losers.length / recent.length : 0,
    ready: scored.ready || recent.length >= 5,
    score: scored.score,
  };
}

export const MA_MIN_EDGE = 0.003;
