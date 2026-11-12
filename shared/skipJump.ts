import type {Candle} from '../server/core';

/** 실패한 이평 진입(건너뜀) 봉의 피처. 지연봉이 이 봉투를 얼마나 넘는지가 적응 문턱. */
export type SkipFeat = {
  close: number;
  high: number;
  low: number;
  range: number;
  barRet: number;
  volume: number;
  strength: number;
  turnover: number;
  vsMa120: number;
};

export type JumpReport = {
  ok: boolean;
  jump: number;
  beats: number;
  parts: string[];
  belowMa120: boolean;
};

export function smaAt(candles: Candle[], at: number, n = 120): number {
  if (at + 1 < n) return 0;
  let s = 0;
  for (let i = at - n + 1; i <= at; i++) s += candles[i].close;
  return s / n;
}

export function skipFeat(c: Candle, ma120: number): SkipFeat {
  const range = c.high - c.low;
  return {
    close: c.close,
    high: c.high,
    low: c.low,
    range,
    barRet: c.open > 0 ? (c.close - c.open) / c.open : 0,
    volume: c.volume ?? 0,
    strength: c.strength ?? 0,
    turnover: c.turnover ?? 0,
    vsMa120: ma120 > 0 ? (c.close - ma120) / ma120 : 0,
  };
}

export function failEnvelope(fails: SkipFeat[]): SkipFeat {
  const n = fails.length || 1;
  const avg = (pick: (f: SkipFeat) => number) => fails.reduce((s, f) => s + pick(f), 0) / n;
  const mx = (pick: (f: SkipFeat) => number) => fails.reduce((m, f) => Math.max(m, pick(f)), 0);
  return {
    close: mx((f) => f.close),
    high: mx((f) => f.high),
    low: avg((f) => f.low),
    range: mx((f) => f.range),
    barRet: mx((f) => f.barRet),
    volume: mx((f) => f.volume),
    strength: mx((f) => f.strength),
    turnover: mx((f) => f.turnover),
    vsMa120: mx((f) => f.vsMa120),
  };
}

function ratio(now: number, fail: number): number {
  if (!(fail > 0) || !(now > 0)) return 1;
  return now / fail;
}

/**
 * 실패 피처 봉투 대비 현재 봉이 같은 가도인지, 새로 강한지.
 * jump = 각 피처 비율의 로그합. 1.0 ≈ 실패봉과 같음, 클수록 뛰어넘음.
 */
export function jumpVsFail(now: SkipFeat, env: SkipFeat, need: number): JumpReport {
  const belowMa120 = now.vsMa120 < 0;
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
    parts.push('강도초월');
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
  const jump =
    Math.log(Math.max(1e-6, volR)) +
    Math.log(Math.max(1e-6, strR)) +
    Math.log(Math.max(1e-6, rngR)) +
    Math.log(Math.max(1e-6, Math.max(pxR, 0.5))) +
    Math.log(Math.max(1e-6, Math.max(retR, 0.5)));
  const ok = !belowMa120 && beats >= 2 && jump >= need;
  return {ok, jump, beats, parts, belowMa120};
}

/** 손실 난 지연진입의 jump 평균을 문턱으로. 표본 없으면 약한 같은 가도는 막히게 1.2. */
export function adaptiveJumpNeed(loserJumps: number[], nMul = 1): number {
  const base = 1.2;
  if (loserJumps.length < 3) return base * Math.max(0.5, nMul);
  const avg = loserJumps.reduce((s, x) => s + x, 0) / loserJumps.length;
  return Math.max(base, avg) * Math.max(0.5, nMul);
}
