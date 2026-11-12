import type {Candle} from '../server/core';
import {filterOn, type DelayContext, type FilterEnabled} from './patternFilters';
import {adaptiveJumpNeed, delayHardGates, failEnvelope, jumpVsFail, skipFeatAt} from './skipJump';

export type PatternMarket = {indexRet?: number; ma120Slope?: number};

export type PatternVerdict = {
  score: number;
  allow: boolean;
  tag: string;
  reasons: string[];
  delayed?: boolean;
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

export function analysisWindow(candles: Candle[], at: number): Candle[] {
  const session = sessionSlice(candles, at);
  if (session.length >= 8) return session;
  if (at < 0) return [];
  for (let i = at; i >= 0; i--) {
    const slice = candles.slice(i, at + 1);
    if (slice.length >= 8 && rangePct(slice) >= 0.01) return slice;
    if (slice.length >= 40) return slice;
  }
  return candles.slice(0, at + 1);
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
export function judgePattern(candles: Candle[], at = candles.length - 1, filters?: FilterEnabled, market?: PatternMarket): PatternVerdict {
  const session = analysisWindow(candles, at);
  const reasons: string[] = [];
  let score = 50;
  if (session.length < 3) {
    return {score: 50, allow: true, tag: '대기', reasons: ['변동 구간을 아직 재는 중']};
  }
  const last = session[session.length - 1];
  const first = session[0];
  const dayOpen = sessionSlice(candles, at)[0]?.open || first.open;
  const prevClose = last.previousDay?.close;
  const gap = prevClose ? pct(dayOpen, prevClose) : 0;
  const vsOpen = pct(last.close, dayOpen);
  const barRet = pct(last.close, last.open);
  if ((vsOpen >= 0.085 && vsOpen <= 0.105) || (barRet >= 0.075 && barRet <= 0.11) || (gap >= 0.05 && vsOpen >= 0.06)) {
    return {score: 15, allow: false, tag: 'VI근접', reasons: [vsOpen >= 0.085 ? 'VI 근접 과열' : '갭상승 과열']};
  }
  if (typeof market?.indexRet === 'number' && Math.abs(market.indexRet) >= 0.02) {
    return {score: 18, allow: false, tag: '지수급변', reasons: [market.indexRet > 0 ? '지수 폭등' : '지수 폭락']};
  }
  if (typeof market?.ma120Slope === 'number' && market.ma120Slope <= 0) {
    return {score: 22, allow: false, tag: '지수하락추세', reasons: ['지수 120이평 하락 기울기']};
  }
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

  if (filterOn(filters, 'skip-chop') && run >= 0.06 && drop >= 0.025 && chop) {
    score = 12;
    reasons.push('급등 후 내리막 횡보');
    return {score, allow: false, tag: '급등후횡보', reasons};
  }
  if (run >= 0.1 && last.close < peak.high * 0.96 && last.time - peak.time > 20 * 60) {
    score -= 20;
    reasons.push('고점 대비 되돌림');
  }
  if (filterOn(filters, 'base-boost') && tightBase && strongBounce) {
    score += 28;
    reasons.push('장기횡보 돌파');
  } else if (filterOn(filters, 'base-boost') && tightBase && fromLow >= 0.015) {
    score += 12;
    reasons.push('횡보 구간 반등');
  }
  if (filterOn(filters, 'early-buy') && tightBase && !strongBounce) {
    score = Math.max(score, 66);
    reasons.push('조기 횡보 이평');
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
  if (!filterOn(filters, 'skip001')) score = Math.max(score, ENTER_MIN);
  const allow = score >= ENTER_MIN;
  if (!reasons.length) reasons.push(allow ? '경로 중립·지표 대기' : '자리 확신 부족');
  const tag = tightBase && strongBounce ? '횡보돌파' : allow ? `신뢰${score}` : '보류';
  return {score, allow, tag, reasons};
}

export function maSlope(closes: number[], period = 120, look = 10): number | undefined {
  if (closes.length < period + look) return undefined;
  const sma: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j];
    sma.push(s / period);
  }
  const a = sma[sma.length - look];
  const b = sma[sma.length - 1];
  if (!(a > 0)) return undefined;
  return (b - a) / a / look;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** 직전 횡보 대비 거래량·체결강도·봉 몸통·돌파가 급증했는지. */
export function measureSurge(session: Candle[]): {ok: boolean; parts: string[]; bonus: number} {
  if (session.length < 12) return {ok: false, parts: [], bonus: 0};
  const last = session[session.length - 1];
  const prev = session.slice(-16, -1);
  const avgRange = mean(prev.map((b) => b.high - b.low));
  const lastRange = last.high - last.low;
  const body = last.open > 0 ? (last.close - last.open) / last.open : 0;
  const vols = prev.map((b) => b.volume ?? 0).filter((v) => v > 0);
  const volOk = Boolean(last.volume && vols.length && last.volume >= 2 * median(vols));
  const rangeOk = avgRange > 0 && lastRange >= 2 * avgRange;
  const strs = prev.map((b) => b.strength).filter((s): s is number => typeof s === 'number' && s > 0);
  const strOk = typeof last.strength === 'number' && strs.length >= 3 && last.strength >= 1.25 * mean(strs);
  const broke = last.close > Math.max(...prev.slice(-5).map((b) => b.high));
  const retOk = body >= 0.012 || broke;
  const parts: string[] = [];
  if (volOk) parts.push('거래량급증');
  if (strOk) parts.push('강도급증');
  if (rangeOk) parts.push('변동급증');
  if (retOk) parts.push('봉급등');
  const ok = parts.length >= 2 || (retOk && (volOk || rangeOk)) || (retOk && strOk);
  return {ok, parts, bonus: Math.min(25, parts.length * 8)};
}

function confirmAfterSkip(session: Candle[], skip: Candle, nextBar: boolean): {ok: boolean; parts: string[]; bonus: number} {
  const surge = measureSurge(session);
  const last = session[session.length - 1];
  if (!last) return surge;
  const body = last.open > 0 ? (last.close - last.open) / last.open : 0;
  const prev = session.slice(-8, -1);
  const strPrev = mean(prev.map((b) => b.strength).filter((s): s is number => typeof s === 'number' && s > 0));
  const hhhl = last.high > skip.high && last.low >= skip.low;
  const strJump = typeof last.strength === 'number' && typeof skip.strength === 'number' && last.strength > skip.strength * 1.08;
  const strGap = typeof last.strength === 'number' && strPrev > 0 && last.strength >= strPrev * 1.1;
  const volJump = typeof last.volume === 'number' && typeof skip.volume === 'number' && skip.volume > 0 && last.volume >= skip.volume * 1.3;
  const turnJump = typeof last.turnover === 'number' && typeof skip.turnover === 'number' && skip.turnover > 0 && last.turnover >= skip.turnover * 1.3;
  const upClose = last.close > skip.close;
  const extra: string[] = [...surge.parts];
  if (hhhl) extra.push('고저상향');
  if (strJump || strGap) extra.push('강도이격');
  if (volJump || turnJump) extra.push('대금급증');
  if (body >= 0.005 && last.close >= last.open) extra.push('봉상승');
  if (upClose) extra.push('종가상향');
  const meaningful = hhhl || strJump || strGap || volJump || turnJump || (body >= 0.005 && last.close >= last.open) || last.close > skip.high;
  let quality = 40;
  if (hhhl) quality += 15;
  if (strJump || strGap) quality += 15;
  if (volJump || turnJump) quality += 12;
  if (body >= 0.005 && last.close >= last.open) quality += Math.min(15, 8 + body * 400);
  if (upClose) quality += 8;
  if (last.close > skip.high) quality += 10;
  quality = Math.max(0, Math.min(100, quality));
  const brokeHigh = last.high > skip.high;
  const green = last.close >= last.open;
  const ok = nextBar
    ? upClose || green || brokeHigh || meaningful
    : surge.ok || meaningful || upClose;
  return {ok, parts: extra, bonus: Math.min(25, extra.length * 8), quality};
}

/** Chart/평가기가 이미 알고 있는 건너뜀 봉 이후 확인. */
export function delayedAfterSkip(candles: Candle[], skipIndex: number, at: number, filters?: FilterEnabled, delay?: DelayContext): PatternVerdict | null {
  if (!filterOn(filters, 'delayed-buy')) return null;
  if (skipIndex < 0 || at <= skipIndex || at - skipIndex > 200 || at >= candles.length) return null;
  const skip = candles[skipIndex];
  const last = candles[at];
  if (!skip || !last) return null;
  const gates = delayHardGates(candles, at);
  if (!gates.ok) return null;
  const jumped = jumpVsFail(skipFeatAt(candles, at), failEnvelope([skipFeatAt(candles, skipIndex)]), delay?.jumpNeed ?? adaptiveJumpNeed([], delay?.skip001N ?? 1));
  const strBeat = (last.strength ?? 0) >= Math.max(skip.strength ?? 0, 1) * 1.08;
  const volBeat = (last.volume ?? 0) >= Math.max(skip.volume ?? 0, 1) * 1.3;
  if (jumped.belowMa120) return null;
  if (!strBeat && !volBeat) return null;
  if (jumped.beats < 2 && !jumped.ok) return null;
  const score = Math.max(ENTER_MIN, Math.min(100, 70 + jumped.beats * 6));
  return {score, allow: true, delayed: true, tag: '지연확인', reasons: [`${gates.parts.join('·')} ${jumped.parts.join('·')}`.trim()]};
}

/**
 * 횡보에서 이평 신호를 한 번 건너뛴 뒤, 급증이 나오면 재돌파 없이 지연 진입.
 * 급등 후 내리막 횡보 금지구간에는 지연 진입을 주지 않는다.
 */
export function delayedEntry(candles: Candle[], at: number, hadSignal: (i: number) => boolean, filters?: FilterEnabled, delay?: DelayContext): PatternVerdict | null {
  if (!filterOn(filters, 'delayed-buy')) return null;
  if (at < 1 || at >= candles.length) return null;
  let lastSkip = -1;
  for (let i = 0; i < at; i++) {
    if (!hadSignal(i)) continue;
    const j = judgePattern(candles, i, filters, delay);
    if (j.tag === '급등후횡보') {
      lastSkip = -1;
      continue;
    }
    if (!j.allow && j.tag !== '급등후횡보') lastSkip = i;
  }
  return delayedAfterSkip(candles, lastSkip, at, filters, delay);
}

export function delayedExit(candles: Candle[], at: number, hadExit: (i: number) => boolean, filters?: FilterEnabled): PatternVerdict | null {
  if (!filterOn(filters, 'delayed-sell')) return null;
  if (at < 1 || at >= candles.length) return null;
  if (filterOn(filters, 'early-sell')) return null;
  let lastSkip = -1;
  for (let i = 0; i < at; i++) {
    if (!hadExit(i)) continue;
    lastSkip = i;
  }
  if (lastSkip < 0 || at - lastSkip < 1 || at - lastSkip > 80) return null;
  if (hadExit(at)) return null;
  const session = sessionSlice(candles, at);
  const last = session[session.length - 1];
  if (!last || last.close >= last.open) return null;
  const surge = measureSurge(session);
  if (!surge.ok) return null;
  const score = Math.max(ENTER_MIN, Math.min(100, 70 + surge.bonus));
  return {score, allow: true, delayed: true, tag: '지연매도', reasons: [`매도 건너뜀 후 ${surge.parts.join('·')}`]};
}

export function patternMarkerText(side: 'buy' | 'skip' | 'sell', v: PatternVerdict): string {
  if (v.delayed && v.tag === '지연매도') return `지연매도${v.score}`;
  if (v.delayed) return `${v.tag === '확인매수' ? '확인매수' : '지연매수'}${v.score} ${v.tag}`;
  if (side === 'skip') return `건너뜀${v.score} ${v.tag}`;
  if (side === 'sell') return `매도${v.score}`;
  return `매수${v.score} ${v.tag}`;
}

export const PATTERN_ENTER_MIN = ENTER_MIN;
