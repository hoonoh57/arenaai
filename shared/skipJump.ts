import type {Candle} from '../server/core';

/** 실패한 이평 진입 봉 피처. 지연봉이 이 봉투를 넘는지가 적응 문턱. */
export type SkipFeat = {
  close: number;
  high: number;
  low: number;
  range: number;
  barRet: number;
  volume: number;
  strength: number;
  strengthAccel: number;
  turnover: number;
  vsMa5: number;
  prevRet: number;
  maAlign: number;
};

export type JumpReport = {
  ok: boolean;
  jump: number;
  beats: number;
  parts: string[];
};

export function smaAt(candles: Candle[], at: number, n = 5): number {
  if (at + 1 < n) return 0;
  let s = 0;
  for (let i = at - n + 1; i <= at; i++) s += candles[i].close;
  return s / n;
}

export function skipFeatAt(candles: Candle[], at: number): SkipFeat {
  const c = candles[at];
  const ma5 = smaAt(candles, at, 5);
  const ma20 = smaAt(candles, at, 20);
  const ma60 = smaAt(candles, at, 60);
  let align = 0;
  if (ma5 > 0 && ma20 > 0 && ma5 > ma20) align += 1;
  if (ma20 > 0 && ma60 > 0 && ma20 > ma60) align += 1;
  if (c.close > ma5 && ma5 > 0) align += 1;
  const str = c.strength ?? 0;
  const str1 = at > 0 ? candles[at - 1].strength ?? 0 : 0;
  const str2 = at > 1 ? candles[at - 2].strength ?? 0 : 0;
  const strengthAccel = str - 2 * str1 + str2;
  const prev = at > 0 ? candles[at - 1].close : 0;
  return {
    close: c.close,
    high: c.high,
    low: c.low,
    range: c.high - c.low,
    barRet: c.open > 0 ? (c.close - c.open) / c.open : 0,
    volume: c.volume ?? 0,
    strength: str,
    strengthAccel,
    turnover: c.turnover ?? 0,
    vsMa5: ma5 > 0 ? (c.close - ma5) / ma5 : 0,
    prevRet: prev > 0 ? (c.close - prev) / prev : 0,
    maAlign: align,
  };
}

export function skipFeat(c: Candle): SkipFeat {
  return {
    close: c.close,
    high: c.high,
    low: c.low,
    range: c.high - c.low,
    barRet: c.open > 0 ? (c.close - c.open) / c.open : 0,
    volume: c.volume ?? 0,
    strength: c.strength ?? 0,
    strengthAccel: 0,
    turnover: c.turnover ?? 0,
    vsMa5: 0,
    prevRet: c.open > 0 ? (c.close - c.open) / c.open : 0,
    maAlign: 0,
  };
}

export function failEnvelope(fails: SkipFeat[]): SkipFeat {
  const n = fails.length || 1;
  const mx = (pick: (f: SkipFeat) => number) => fails.reduce((m, f) => Math.max(m, pick(f)), -Infinity);
  const avg = (pick: (f: SkipFeat) => number) => fails.reduce((s, f) => s + pick(f), 0) / n;
  return {
    close: mx((f) => f.close),
    high: mx((f) => f.high),
    low: avg((f) => f.low),
    range: mx((f) => f.range),
    barRet: mx((f) => f.barRet),
    volume: mx((f) => f.volume),
    strength: mx((f) => f.strength),
    strengthAccel: mx((f) => f.strengthAccel),
    turnover: mx((f) => f.turnover),
    vsMa5: mx((f) => f.vsMa5),
    prevRet: mx((f) => f.prevRet),
    maAlign: mx((f) => f.maAlign),
  };
}

function ratio(now: number, fail: number): number {
  if (!(fail > 0) || !(now > 0)) return 1;
  return now / fail;
}

export function jumpVsFail(now: SkipFeat, env: SkipFeat, need: number): JumpReport {
  const parts: string[] = [];
  let beats = 0;
  const volR = ratio(now.volume, env.volume);
  const strR = ratio(now.strength, env.strength);
  const rngR = ratio(now.range, env.range);
  const turnR = ratio(now.turnover, env.turnover);
  const retR = env.barRet > 0 ? now.barRet / env.barRet : now.barRet > 0.01 ? 2 : 1;
  const pxR = env.high > 0 ? now.close / env.high : 1;
  if (volR >= 1.5) {
    beats += 1;
    parts.push('거래량초월');
  }
  if (strR >= 1.2) {
    beats += 1;
    parts.push('강도레벨초월');
  }
  if (now.strengthAccel > Math.max(0, env.strengthAccel) && now.strengthAccel > 0) {
    beats += 1;
    parts.push('강도가속');
  }
  if (now.maAlign >= 3 && now.maAlign > env.maAlign) {
    beats += 1;
    parts.push('이평정배열');
  }
  if (rngR >= 1.5) {
    beats += 1;
    parts.push('변동초월');
  }
  if (turnR >= 1.5) {
    beats += 1;
    parts.push('대금초월');
  }
  if (now.barRet >= Math.max(0.008, env.barRet * 1.4) && now.barRet > 0) {
    beats += 1;
    parts.push('봉초월');
  }
  if (now.close > env.high) {
    beats += 1;
    parts.push('실패고점돌파');
  }
  if (now.prevRet > 0) {
    beats += 1;
    parts.push('직전대비+');
  }
  if (now.vsMa5 > 0) {
    beats += 1;
    parts.push('5이격+');
  }
  const jump =
    Math.log(Math.max(1e-6, volR)) +
    Math.log(Math.max(1e-6, strR)) +
    Math.log(Math.max(1e-6, rngR)) +
    Math.log(Math.max(1e-6, Math.max(pxR, 0.5))) +
    Math.log(Math.max(1e-6, Math.max(retR, 0.5))) +
    (now.maAlign - env.maAlign) * 0.15 +
    Math.max(0, now.strengthAccel) * 0.01 +
    Math.max(0, now.prevRet) * 80 +
    Math.max(0, now.vsMa5) * 40;
  const gapDown = now.vsMa5 < 0 || now.prevRet <= 0;
  const ok = !gapDown && beats >= 2 && jump >= need;
  return {ok, jump, beats, parts};
}

export const STR_ALPHA = 1.08;

export function strengthSma(candles: Candle[], at: number, n = 5): number {
  let s = 0;
  let k = 0;
  for (let i = Math.max(0, at - n + 1); i <= at; i++) {
    const v = candles[i].strength;
    if (typeof v === 'number' && v > 0) {
      s += v;
      k += 1;
    }
  }
  return k ? s / k : 0;
}

/** 음봉·강도 미달은 지연 불가. */
export function delayHardGates(candles: Candle[], at: number): {ok: boolean; parts: string[]} {
  const last = candles[at];
  if (!last) return {ok: false, parts: []};
  const parts: string[] = [];
  if (last.close < last.open) return {ok: false, parts: ['음봉']};
  const str = last.strength ?? 0;
  const prev = at > 0 ? candles[at - 1].strength ?? 0 : 0;
  const sma5 = strengthSma(candles, at, 5);
  const haveStr = str > 0 && (prev > 0 || sma5 > 0);
  if (haveStr) {
    if (prev > 0 && str < prev * STR_ALPHA) return {ok: false, parts: ['강도알파미달']};
    if (sma5 > 0 && str < sma5) return {ok: false, parts: ['강도5이평미달']};
    parts.push('강도확인');
  }
  parts.push('양봉');
  return {ok: true, parts};
}

export function adaptiveJumpNeed(loserJumps: number[], nMul = 1): number {
  const base = 1.2;
  if (loserJumps.length < 3) return base * Math.max(0.5, nMul);
  const avg = loserJumps.reduce((s, x) => s + x, 0) / loserJumps.length;
  return Math.max(base, avg) * Math.max(0.5, nMul);
}
