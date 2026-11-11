import {LimitGovernor, classifyMessage} from './realtime/limits';
import type {Candle, PreviousDay, Stock} from './core';

type ObjectRow = Record<string, unknown>;

/**
 * Kiwoom REST client.
 *
 * Everything goes through the central `LimitGovernor` (no request bypasses it) and the
 * WebSocket session is owned by `RealtimeHub`, so this module is REST-only by design:
 * CNSRLST/CNSRREQ (조건식 목록/일반검색) run on the single realtime connection.
 */

function numeric(value: unknown, field: string): number {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text || !/^[+-]?\d+(\.\d+)?$/.test(text)) throw new Error(`키움 응답의 ${field} 값이 없습니다.`);
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`키움 응답의 ${field} 값이 유효하지 않습니다.`);
  return n;
}

function optionalNumber(value: unknown): number | null {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text || !/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function kstTimestamp(value: unknown): number {
  const t = String(value ?? '');
  if (!/^\d{14}$/.test(t)) return NaN;
  const ms = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+09:00`);
  if (!Number.isFinite(ms)) return NaN;
  const normalized = new Date(ms + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return normalized === t ? ms : NaN;
}

export function parseConditionRow(row: ObjectRow): {code: string; name: string; price: number; change: number} | null {
  const raw = String(row['9001'] ?? '');
  // Only common stock codes (A prefix or bare code); exclude ELW/ETN.
  if (!/^(A?\d{6})$/.test(raw)) return null;
  const rate = String(row['12'] ?? '').trim();
  // ka10172 documents fixed-width integer 000001500 as +1.50%.
  const change = numeric(rate, '등락률') / (rate.includes('.') ? 1 : 1000);
  return {code: raw.replace(/^A/, ''), name: String(row['302'] || raw), price: Math.abs(numeric(row['10'], '현재가')), change};
}

export function parseCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) throw new Error('분봉 응답 형식이 올바르지 않습니다.');
  const result: Candle[] = [];
  for (const x of rows) {
    try {
      const time = kstTimestamp(x.cntr_tm) / 1000;
      const open = Math.abs(numeric(x.open_pric, '시가')), high = Math.abs(numeric(x.high_pric, '고가')), low = Math.abs(numeric(x.low_pric, '저가')), close = Math.abs(numeric(x.cur_prc, '종가'));
      if (Number.isFinite(time) && open > 0 && low > 0 && high >= Math.max(open, close, low) && low <= Math.min(open, close)) result.push({time, open, high, low, close, ...(/^[+-]?\d+$/.test(String(x.trde_qty ?? '').trim()) ? {volume: Math.abs(Number(x.trde_qty))} : {})});
    } catch {
      /* invalid rows must not become fabricated candles */
    }
  }
  return result.sort((a, b) => a.time - b.time).filter((x, i, a) => i === 0 || x.time !== a[i - 1].time);
}

type DailyRow = PreviousDay;

export function dailyToCandles(rows: DailyRow[]): Candle[] {
  const result: Candle[] = [];
  for (const row of rows) {
    if (!row.open || !row.high || !row.low || !row.close) continue;
    const time = Date.parse(`${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}T00:00:00+09:00`) / 1000;
    if (!Number.isFinite(time)) continue;
    result.push({time, open: row.open, high: row.high, low: row.low, close: row.close});
  }
  return result.sort((a, b) => a.time - b.time);
}

export function parseDailyRows(rows: unknown): DailyRow[] {
  if (!Array.isArray(rows)) throw new Error('일봉 응답 형식이 올바르지 않습니다.');
  const result: DailyRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const date = String(row?.dt ?? '');
    if (!/^\d{8}$/.test(date)) throw new Error('일봉 일자가 올바르지 않습니다.');
    const t = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00+09:00`);
    if (!Number.isFinite(t) || new Date(t + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '') !== date || seen.has(date)) throw new Error('일봉 일자가 중복되거나 유효하지 않습니다.');
    seen.add(date);
    const optional = (value: unknown) => {
      try {
        const n = Math.abs(numeric(value, '일봉'));
        return n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };
    result.push({date, open: optional(row.open_pric), high: optional(row.high_pric), low: optional(row.low_pric), close: optional(row.cur_prc)});
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function attachPreviousDays(candles: Candle[], daily: DailyRow[]): Candle[] {
  // Require the current session row to exist; never jump over malformed or absent daily rows.
  const prev = new Map<string, DailyRow>();
  for (let i = 1; i < daily.length; i++) prev.set(daily[i].date, daily[i - 1]);
  return candles.map((c) => {
    const d = new Date((c.time + 9 * 3600) * 1000);
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const row = prev.get(date);
    return row ? {...c, previousDay: {...row}} : c;
  });
}

export type KiwoomErrorInfo = {returnCode: number | null; returnMsg: string; httpStatus?: number};

export class KiwoomApiError extends Error {
  readonly returnCode: number | null;
  readonly returnMsg: string;
  readonly httpStatus?: number;
  constructor(info: KiwoomErrorInfo) {
    super(`키움 API 오류 (${info.returnCode ?? 'HTTP'}): ${info.returnMsg}`);
    this.returnCode = info.returnCode;
    this.returnMsg = info.returnMsg;
    this.httpStatus = info.httpStatus;
  }
}

export type KiwoomOptions = {
  /** Called for every rate-limit / auth event so the audit trail stays complete. */
  onEvent?: (event: {kind: 'rate-limit' | 'auth-expired' | 'error'; message: string; detail?: Record<string, unknown>}) => void;
  timeoutMs?: number;
};

export class Kiwoom {
  private token = '';
  private expires = 0;
  private readonly base: string;
  readonly hostMode: 'mock' | 'real';
  private readonly governor: LimitGovernor;
  private readonly options: KiwoomOptions;
  private readonly timeoutMs: number;

  constructor(mode: 'mock' | 'real', governor: LimitGovernor, options: KiwoomOptions = {}) {
    this.governor = governor;
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.hostMode = mode;
    this.base = mode === 'real' ? 'https://api.kiwoom.com' : 'https://mockapi.kiwoom.com';
  }

  /** Force the next request to re-issue the access token. */
  invalidateToken(): void {
    this.token = '';
    this.expires = 0;
  }

  /** Access token for the realtime LOGIN packet (re-issued when expired or forced). */
  async accessToken(force = false): Promise<string> {
    return this.auth(force);
  }

  private async auth(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.expires) return this.token;
    const key = process.env.KIWOOM_APP_KEY;
    const secret = process.env.KIWOOM_SECRET_KEY;
    if (!key || !secret) throw new Error('.env에 키움 API 키를 설정하고 서버를 재시작하세요.');
    await this.governor.acquire('au10001', 'read');
    const r = await fetch(this.base + '/oauth2/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json;charset=UTF-8'},
      body: JSON.stringify({grant_type: 'client_credentials', appkey: key, secretkey: secret}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const d = (await r.json()) as any;
    if (!r.ok) throw new Error(`키움 인증 HTTP 오류: ${r.status}`);
    if (d.return_code !== undefined && Number(d.return_code) !== 0) throw new KiwoomApiError({returnCode: Number(d.return_code), returnMsg: String(d.return_msg ?? '인증 실패')});
    const expiry = kstTimestamp(d.expires_dt);
    if (!d.token || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('키움 토큰 또는 만료일이 유효하지 않습니다.');
    this.token = d.token;
    this.expires = expiry - 60000;
    return this.token;
  }

  lastContinuation: {contYn: string; nextKey: string} = {contYn: '', nextKey: ''};

  private async send(path: string, id: string, body: object, extra: {contYn?: string; nextKey?: string} = {}): Promise<any> {
    const token = await this.auth();
    const headers: Record<string, string> = {'Content-Type': 'application/json;charset=UTF-8', authorization: `Bearer ${token}`, 'api-id': id};
    if (extra.contYn) headers['cont-yn'] = extra.contYn;
    if (extra.nextKey) headers['next-key'] = extra.nextKey;
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const d = (await r.json()) as any;
    if (!r.ok) throw new KiwoomApiError({returnCode: null, returnMsg: `HTTP ${r.status}`, httpStatus: r.status});
    if (d.return_code !== undefined && Number(d.return_code) !== 0) throw new KiwoomApiError({returnCode: Number(d.return_code), returnMsg: String(d.return_msg ?? '요청 실패')});
    this.lastContinuation = {
      contYn: r.headers.get('cont-yn') || r.headers.get('Cont-Yn') || '',
      nextKey: r.headers.get('next-key') || r.headers.get('Next-Key') || '',
    };
    return d;
  }

  /**
   * Single entry point for REST calls.
   *
   * A documented rate-limit code (1700/1701/1702) or an expired token triggers exactly one
   * governed retry — never an unbounded retry loop, because an unverified quota must not
   * be hammered.
   */
  /**
   * Order-lane REST. Only the mock host is allowed to send kt1000x. Real host always throws.
   */
  async restOrder(path: string, id: string, body: object): Promise<any> {
    if (this.hostMode !== 'mock') throw new Error('실전 호스트에서는 주문을 전송하지 않습니다.');
    await this.governor.acquire(id, 'order');
    return this.send(path, id, body);
  }

  /**
   * kt10000 매수 / kt10001 매도. trde_tp 3=시장가, 0=보통(지정가).
   */
  async stockOrder(input: {side: 'buy' | 'sell'; code: string; qty: number; type: 'market' | 'limit'; limitPrice?: number | null; exchange?: string}): Promise<{ordNo: string}> {
    const id = input.side === 'buy' ? 'kt10000' : 'kt10001';
    const trde_tp = input.type === 'market' ? '3' : '0';
    const ord_uv = input.type === 'limit' && input.limitPrice ? String(Math.round(input.limitPrice)) : '';
    const d = await this.restOrder('/api/dostk/ordr', id, {
      dmst_stex_tp: input.exchange || 'KRX',
      stk_cd: input.code,
      ord_qty: String(input.qty),
      trde_tp,
      ord_uv,
      cond_uv: '',
    });
    const ordNo = String(d.ord_no ?? '').trim();
    if (!ordNo) throw new Error('키움 모의 주문번호가 없습니다.');
    return {ordNo};
  }

  /** kt10003 취소. cncl_qty '0' = 잔량 전부. */
  async cancelStock(input: {code: string; origOrdNo: string; qty?: number; exchange?: string}): Promise<{ordNo: string}> {
    const d = await this.restOrder('/api/dostk/ordr', 'kt10003', {
      dmst_stex_tp: input.exchange || 'KRX',
      orig_ord_no: input.origOrdNo,
      stk_cd: input.code,
      cncl_qty: input.qty ? String(input.qty) : '0',
    });
    return {ordNo: String(d.ord_no ?? input.origOrdNo)};
  }

  async rest(path: string, id: string, body: object, extra: {contYn?: string; nextKey?: string} = {}): Promise<any> {
    let retriedRateLimit = false;
    let retriedAuth = false;
    for (;;) {
      await this.governor.acquire(id, 'read');
      try {
        return await this.send(path, id, body, extra);
      } catch (error) {
        const info = error instanceof KiwoomApiError ? error : null;
        if (!info) throw error;
        const kind = classifyMessage(info.returnCode, info.returnMsg);
        if (kind === 'rate-limit' && !retriedRateLimit) {
          retriedRateLimit = true;
          this.governor.penalize();
          this.options.onEvent?.({kind: 'rate-limit', message: '키움 요청 한도 오류를 받아 잠시 대기 후 재시도합니다.', detail: {apiId: id, returnCode: info.returnCode}});
          continue;
        }
        if (kind === 'auth-expired' && !retriedAuth) {
          retriedAuth = true;
          this.invalidateToken();
          this.options.onEvent?.({kind: 'auth-expired', message: '토큰이 만료되어 재발급 후 재시도합니다.', detail: {apiId: id}});
          continue;
        }
        throw error;
      }
    }
  }

  async candles(code: string): Promise<Candle[]> {
    const page = await this.chartPage({code, timeframe: '1'});
    if (!page.candles.length) throw new Error(`${code} 유효한 분봉 데이터 없음`);
    return page.candles;
  }

  /**
   * Chart page for the desk toolbar. Minute bars use ka10080 tic_scope; daily uses ka10081.
   * `nextKey` requests the previous continuation page (older bars). Does not invent bars.
   */
  async chartPage(input: {code: string; timeframe: string; baseDate?: string; nextKey?: string}): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}> {
    if (!/^\d{6}$/.test(input.code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
    const extra = input.nextKey ? {contYn: 'Y', nextKey: input.nextKey} : {};
    if (input.timeframe === 'D') {
      const base = (input.baseDate || '').replace(/-/g, '');
      const body: Record<string, string> = {stk_cd: input.code, upd_stkpc_tp: '1'};
      if (/^\d{8}$/.test(base)) body.base_dt = base;
      const d = await this.rest('/api/dostk/chart', 'ka10081', body, extra);
      const candles = dailyToCandles(parseDailyRows(d.stk_dt_pole_chart_qry));
      return {candles, hasMore: this.lastContinuation.contYn === 'Y', nextKey: this.lastContinuation.nextKey};
    }
    const allowed = new Set(['1', '3', '5', '10', '15', '30', '45', '60']);
    if (!allowed.has(input.timeframe)) throw new Error('지원 분봉은 1/3/5/10/15/30/45/60분과 일봉입니다.');
    const body = {stk_cd: input.code, tic_scope: input.timeframe, upd_stkpc_tp: '1'};
    const d = await this.rest('/api/dostk/chart', 'ka10080', body, extra);
    const candles = parseCandles(d.stk_min_pole_chart_qry);
    return {candles, hasMore: this.lastContinuation.contYn === 'Y', nextKey: this.lastContinuation.nextKey};
  }

  async daily(code: string, baseDate: string): Promise<DailyRow[]> {
    const d = await this.rest('/api/dostk/chart', 'ka10081', {stk_cd: code, base_dt: baseDate, upd_stkpc_tp: '1'});
    return parseDailyRows(d.stk_dt_pole_chart_qry);
  }

  /**
   * ka10046 체결강도 snapshot. Used only as a fallback for captured codes that do not
   * (yet) have a realtime 0B quote; missing fields stay null.
   * 누적거래대금(acc_trde_prica)은 명세 단위(백만원) 그대로 반환한다.
   */
  async strengthSnapshot(code: string): Promise<{strength: number | null; value: number | null; change: number | null}> {
    const d = await this.rest('/api/dostk/mrkcond', 'ka10046', {stk_cd: code});
    const row = d.cntr_str_tm?.[0];
    if (!row) return {strength: null, value: null, change: null};
    const strength = optionalNumber(row.cntr_str);
    const value = optionalNumber(row.acc_trde_prica);
    return {strength: strength === null ? null : Math.abs(strength), value: value === null ? null : Math.abs(value), change: null};
  }
}

export type {Stock};
