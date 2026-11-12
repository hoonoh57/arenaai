import type {Candle} from '../server/core';

export type PatternVerdict = {
  score: number;
  allow: boolean;
  tag: string;
  reasons: string[];
};

const ENTER_MIN = 65;

function kst(sec: number) {
  const t = new Date((sec + 9 * 3600) * 1000);
  return {
    day: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  };
}

/** 최신 봉과 같은 날 08:00 이후(NXT) 봉만. */
export function sessionSlice(candles: Candle[], at: number): Candle[] {
  if (at < 0 || at >= candles.length) return [];
  const day = kst(candles[at].time).day;
  return candles.filter((c, i) => i <= at && kst(c.time).day === day && kst(c.time).hour >= 8);
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 0;
  return (a - b) / b;
}

function swings(bars: Candle[]): number {
  let n = 0;
  for (let i = 2; i < bars.length; i++) {
    const up = bars[i].close > bars[i - 1].close;
    const prev = bars[i - 1].close > bars[i - 2].close;
    if (up !== prev) n += 1;
  }
  return n;
}

function rangePct(bars: Candle[]): number {
  if (!bars.length) return 0;
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const mid = (hi + lo) / 2;
  return mid > 0 ? (hi - lo) / mid : 0;
}

/**
 * 사람 눈으로 보는 당일 경로: 급등 후 내리막 횡보는 금지,
 * 긴 횡보 뒤 강한 돌파는 가점. 지표 신호와 곱해 쓸 점수.
 */
export function judgePattern(candles: Candle[], at = candles.length - 1): PatternVerdict {
  const session = sessionSlice(candles, at);
  const reasons: string[] = [];
  let score = 50;
  if (session.length < 8) {
    return {score: 40, allow: false, tag: '표본부족', reasons: ['당일 봉이 적어 판정하지 않음']};
  }
  const last = session[session.length - 1];
  const first = session[0];
  const peak = session.reduce((m, b) => (b.high > m.high ? b : m), first);
  const trough = session.reduce((m, b) => (b.low < m.low ? b : m), first);
  const run = pct(peak.high, first.open);
  const drop = pct(peak.high, last.close);
  const fromLow = pct(last.close, trough.low);
  const recent = session.slice(-16);
  const chop = rangePct(recent) < 0.04 && swings(recent) >= 4;
  const base = session.slice(Math.max(0, session.length - 40), Math.max(0, session.length - 5));
  const tightBase = base.length >= 18 && rangePct(base) <= 0.028;
  const baseHigh = base.length ? Math.max(...base.map((b) => b.high)) : last.high;
  const bounceBars = session.slice(-3);
  const upCount = bounceBars.filter((b) => b.close >= b.open).length;
  const strongBounce = bounceBars.length === 3 && upCount >= 2 && last.close > last.open && last.close > baseHigh;

  if (run >= 0.06 && drop >= 0.025 && chop) {
    score = 12;
    reasons.push('급등 후 내리막 횡보');
    return {score, allow: false, tag: '급등후횡보', reasons};
  }
  if (run >= 0.1 && last.close < peak.high * 0.96 && last.time - peak.time > 20 * 60) {
    score -= 20;
    reasons.push('고점 대비 되돌림');
  }
  if (tightBase && strongBounce) {
    score += 28;
    reasons.push('장기횡보 돌파');
  } else if (tightBase && fromLow >= 0.015) {
    score += 12;
    reasons.push('횡보 구간 반등');
  }
  if (pct(last.close, first.open) < 0.03 && pct(last.close, Math.max(...session.map((b) => b.high))) > -0.012) {
    score += 8;
    reasons.push('당일 아직 덜 뻗음');
  }
  if (pct(last.close, first.open) >= 0.08 && pct(last.close, peak.high) > -0.008) {
    score -= 18;
    reasons.push('이미 고점 근처');
  }
  score = Math.max(0, Math.min(100, score));
  const allow = score >= ENTER_MIN;
  if (!reasons.length) reasons.push(allow ? '경로 중립·지표 대기' : '자리 확신 부족');
  const tag = tightBase && strongBounce ? '횡보돌파' : allow ? `신뢰${score}` : '보류';
  return {score, allow, tag, reasons};
}

export function patternMarkerText(side: 'buy' | 'skip', v: PatternVerdict): string {
  if (side === 'skip') return `건너뜀${v.score} ${v.tag}`;
  return `매수${v.score} ${v.tag}`;
}

export const PATTERN_ENTER_MIN = ENTER_MIN;
