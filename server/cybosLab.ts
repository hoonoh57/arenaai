import type {CybosBroker} from './cybosBroker';
import {PROVIDER_SPECS} from '../shared/marketProvider';

export const CYBOS_LAB_CASES = [
  {id: 'admin', title: '관리자 권한', group: '연결'},
  {id: 'connect', title: 'CYBOS 연결', group: '연결'},
  {id: 'chartOne', title: '분봉 1종목', group: '봉'},
  {id: 'chartBatch', title: '분봉 일괄', group: '봉'},
  {id: 'tick', title: '틱 reverse(정렬 없음)', group: '봉'},
  {id: 'strength', title: '체결강도', group: '시세'},
  {id: 'eye', title: 'MarketEye', group: '시세'},
] as const;

export type CybosLabCaseId = (typeof CYBOS_LAB_CASES)[number]['id'];

function codesOf(raw: unknown, n: number): string[] {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x).replace(/\D/g, '').slice(0, 6)).filter((c) => /^\d{6}$/.test(c))
    : [];
  const uniq = [...new Set(list)];
  if (uniq.length) return uniq.slice(0, Math.max(1, n));
  return ['005930'].slice(0, Math.max(1, n));
}

export async function runCybosLab(
  broker: CybosBroker,
  id: string,
  input: {codes?: unknown; count?: number} = {},
): Promise<{id: string; title: string; group: string; ok: boolean; ms: number; detail: string}> {
  const meta = CYBOS_LAB_CASES.find((c) => c.id === id);
  const title = meta?.title || id;
  const group = meta?.group || '';
  const t0 = Date.now();
  const n = Math.min(PROVIDER_SPECS.cybos.max.codesPerCall, Math.max(1, Number(input.count) || 1));
  const codes = codesOf(input.codes, n);
  try {
    if (id === 'admin' || id === 'connect') {
      const s = await broker.status();
      const ok = id === 'admin' ? Boolean(s.admin) : Boolean(s.connected);
      return {id, title, group, ok, ms: Date.now() - t0, detail: s.reason || (ok ? '통과' : '실패')};
    }
    if (id === 'chartOne') {
      const p = await broker.chartPage({code: codes[0]!, timeframe: '1', singlePage: true});
      const ok = p.candles.length > 0;
      const last = p.candles[p.candles.length - 1];
      return {
        id,
        title,
        group,
        ok,
        ms: Date.now() - t0,
        detail: ok ? `${codes[0]} ${p.candles.length}봉 마지막 ${last?.time}` : '빈 페이지',
      };
    }
    if (id === 'chartBatch') {
      const got: string[] = [];
      for (const c of codes) {
        const p = await broker.chartPage({code: c, timeframe: '1', singlePage: true});
        if (p.candles.length) got.push(c);
      }
      return {
        id,
        title,
        group,
        ok: got.length === codes.length,
        ms: Date.now() - t0,
        detail: `요청 ${codes.length} · 수신 ${got.length} · 표준동시 ${PROVIDER_SPECS.cybos.standard.concurrency}`,
      };
    }
    if (id === 'tick') {
      const p = await broker.chartPage({code: codes[0]!, timeframe: 'T1', singlePage: true});
      let mono = true;
      for (let i = 1; i < p.candles.length; i++) if (p.candles[i]!.time < p.candles[i - 1]!.time) mono = false;
      const ok = p.candles.length > 1 && mono;
      return {
        id,
        title,
        group,
        ok,
        ms: Date.now() - t0,
        detail: ok ? `${p.candles.length}틱 시간 비감소(reverse만)` : '틱 없음 또는 역전(sort 의심)',
      };
    }
    if (id === 'strength') {
      const page = await broker.chartPage({code: codes[0]!, timeframe: '1', singlePage: true});
      const s = await broker.attachStrength(codes[0]!, '1', page.candles);
      const filled = s.candles.filter((c) => typeof c.strength === 'number' && c.strength > 0).length;
      return {
        id,
        title,
        group,
        ok: filled > 0,
        ms: Date.now() - t0,
        detail: `강도 ${filled}/${s.candles.length}봉`,
      };
    }
    if (id === 'eye') {
      const rows = await broker.marketEye(codes.slice(0, Math.min(codes.length, 200)));
      return {
        id,
        title,
        group,
        ok: rows.length > 0,
        ms: Date.now() - t0,
        detail: `MarketEye ${rows.length}종목 (최대 ${PROVIDER_SPECS.cybos.max.codesPerCall})`,
      };
    }
    return {id, title, group, ok: false, ms: Date.now() - t0, detail: '미등록 항목'};
  } catch (e) {
    return {id, title, group, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : '실패'};
  }
}
