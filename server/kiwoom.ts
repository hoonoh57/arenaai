import {LimitGovernor, classifyMessage} from './realtime/limits';
import type {Candle, PreviousDay, Stock} from './core';
import {alignStrengthToCandles, correctSmallLotStrength, parseStrengthTicks, strengthSyncStatus, type StrengthTick} from '../shared/strength';
import {aggregateTickBars, parseTickTimeframe} from '../shared/ticks';

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

export function kstClock(sec: number): {day: number; hour: number; minute: number} {
  const t = new Date((sec + 9 * 3600) * 1000);
  return {day: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(), hour: t.getUTCHours(), minute: t.getUTCMinutes()};
}

/** NXT 등 08시 세션이 최신 거래일에 있는지. */
export function hasMorningSession(candles: Candle[], hour = 8): boolean {
  if (!candles.length) return false;
  const last = kstClock(candles[candles.length - 1].time);
  return candles.some((c) => {
    const p = kstClock(c.time);
    return p.day === last.day && p.hour === hour;
  });
}

/** 최신 봉이 속한 날의 NXT 08:30 또는 KRX 09:00까지 체결강도가 왔는지. */
export function reachedSessionOpen(times: number[], lastSec: number, hour: number, minute: number): boolean {
  if (!times.length || !Number.isFinite(lastSec)) return false;
  const last = kstClock(lastSec);
  return times.some((t) => {
    const p = kstClock(t);
    if (p.day !== last.day) return false;
    return p.hour < hour || (p.hour === hour && p.minute <= minute);
  });
}

const strengthBuf = new Map<string, {ticks: StrengthTick[]; nextKey: string; reached: boolean; nxt: boolean}>();

function strengthBufKey(code: string, lastSec: number): string {
  const p = kstClock(lastSec);
  return `${code}|${p.day}`;
}

function mergeTicks(older: StrengthTick[], newer: StrengthTick[]): StrengthTick[] {
  const seen = new Set(newer.map((t) => `${t.time}:${t.qty}`));
  return [...older.filter((t) => !seen.has(`${t.time}:${t.qty}`)), ...newer];
}

function mergeCandlePages(older: Candle[], newer: Candle[]): Candle[] {
  const seen = new Set(newer.map((c) => c.time));
  return [...older.filter((c) => !seen.has(c.time)), ...newer];
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
  /* ka10080는 최근→과거. 시간순 그리려면 reverse만. sort 금지. */
  if (result.length >= 2 && result[0].time > result[result.length - 1].time) result.reverse();
  return result.filter((x, i, a) => i === 0 || x.time !== a[i - 1].time);
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
    const date = String(row?.dt ?? row?.date ?? row?.trd_dd ?? row?.yyyymmdd ?? '').replace(/-/g, '').slice(0, 8);
    if (!/^\d{8}$/.test(date) || seen.has(date)) continue;
    const y = Number(date.slice(0, 4));
    const mo = Number(date.slice(4, 6));
    const da = Number(date.slice(6, 8));
    const utc = Date.UTC(y, mo - 1, da);
    const chk = new Date(utc);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() + 1 !== mo || chk.getUTCDate() !== da) continue;
    seen.add(date);
    const optional = (value: unknown) => {
      try {
        const n = Math.abs(numeric(value, '일봉'));
        return n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };
    result.push({
      date,
      open: optional(row.open_pric ?? row.open),
      high: optional(row.high_pric ?? row.high),
      low: optional(row.low_pric ?? row.low),
      close: optional(row.cur_prc ?? row.close ?? row.stck_clpr),
    });
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
  private base: string;
  hostMode: 'mock' | 'real';
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

  setHostMode(mode: 'mock' | 'real'): void {
    if (mode !== 'mock' && mode !== 'real') throw new Error('호스트는 mock 또는 real 입니다.');
    this.hostMode = mode;
    this.base = mode === 'real' ? 'https://api.kiwoom.com' : 'https://mockapi.kiwoom.com';
    this.invalidateToken();
  }

  /** Access token for the realtime LOGIN packet (re-issued when expired or forced). */
  async accessToken(force = false): Promise<string> {
    return this.auth(force);
  }

  private async auth(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.expires) return this.token;
    const key =
      this.hostMode === 'real'
        ? process.env.KIWOOM_APP_KEY_REAL || process.env.KIWOOM_APP_KEY
        : process.env.KIWOOM_APP_KEY_MOCK || process.env.KIWOOM_APP_KEY;
    const secret =
      this.hostMode === 'real'
        ? process.env.KIWOOM_SECRET_KEY_REAL || process.env.KIWOOM_SECRET_KEY
        : process.env.KIWOOM_SECRET_KEY_MOCK || process.env.KIWOOM_SECRET_KEY;
    if (!key || !secret) throw new Error(this.hostMode === 'real' ? '.env에 KIWOOM_APP_KEY_REAL / SECRET 을 넣으세요.' : '.env에 KIWOOM_APP_KEY_MOCK / SECRET 을 넣으세요.');
    await this.governor.acquire('au10001', 'read');
    const r = await fetch(this.base + '/oauth2/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json;charset=UTF-8'},
      body: JSON.stringify({grant_type: 'client_credentials', appkey: key, secretkey: secret}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const d = (await r.json()) as any;
    if (!r.ok) throw new Error(`키움 인증 HTTP 오류: ${r.status}`);
    if (d.return_code !== undefined && Number(d.return_code) !== 0) {
      const msg = String(d.return_msg ?? '인증 실패');
      if (Number(d.return_code) === 821 || /8030/.test(msg)) {
        throw new Error(
          `AppKey가 ${this.hostMode === 'real' ? '실전' : '모의'} 호스트와 다릅니다. .env에 KIWOOM_APP_KEY_REAL / KIWOOM_APP_KEY_MOCK 을 구분해 넣으세요.`,
        );
      }
      throw new KiwoomApiError({returnCode: Number(d.return_code), returnMsg: msg});
    }
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

  private restChain: Promise<unknown> = Promise.resolve();

  async rest(path: string, id: string, body: object, extra: {contYn?: string; nextKey?: string} = {}): Promise<any> {
    const run = this.restChain.then(() => this.restOnce(path, id, body, extra));
    this.restChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async restOnce(path: string, id: string, body: object, extra: {contYn?: string; nextKey?: string} = {}): Promise<any> {
    let retriedRateLimit = false;
    let retriedAuth = false;
    for (;;) {
      await this.governor.acquire(id, 'read');
      try {
        return await this.send(path, id, body, extra);
      } catch (error) {
        const info = error instanceof KiwoomApiError ? error : null;
        if (!info) throw error;
        const kind = classifyMessage(info.returnCode, info.returnMsg, info.httpStatus);
        if (kind === 'rate-limit' && !retriedRateLimit) {
          retriedRateLimit = true;
          this.governor.penalize();
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
  /** 통합(_AL) 우선. NXT 08:00~20:00 분·틱을 포함한다. 실패 시 거래소 코드만. */
  private async chartRows(path: string, apiId: string, code: string, body: Record<string, string>, extra: {contYn?: string; nextKey?: string}, table: string): Promise<Candle[]> {
    try {
      const d = await this.rest(path, apiId, {...body, stk_cd: `${code}_AL`}, extra);
      const rows = d[table];
      if (Array.isArray(rows) && rows.length) return parseCandles(rows);
    } catch {
      /* fall back to KRX code */
    }
    const d = await this.rest(path, apiId, {...body, stk_cd: code}, extra);
    return parseCandles(d[table]);
  }

  async chartPage(input: {code: string; timeframe: string; baseDate?: string; nextKey?: string; singlePage?: boolean}): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}> {
    if (!/^\d{6}$/.test(input.code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
    const extra = input.nextKey ? {contYn: 'Y', nextKey: input.nextKey} : {};
    if (input.timeframe === 'D' || input.timeframe === 'W' || input.timeframe === 'M') {
      const apiId = input.timeframe === 'D' ? 'ka10081' : input.timeframe === 'W' ? 'ka10082' : 'ka10083';
      const tables =
        input.timeframe === 'D'
          ? ['stk_dt_pole_chart_qry']
          : input.timeframe === 'W'
            ? ['stk_wk_pole_chart_qry', 'stk_stk_pole_chart_qry', 'stk_week_pole_chart_qry']
            : ['stk_mth_pole_chart_qry', 'stk_mon_pole_chart_qry'];
      const base = (input.baseDate || '').replace(/-/g, '');
      const body: Record<string, string> = {stk_cd: input.code, upd_stkpc_tp: '1'};
      if (/^\d{8}$/.test(base)) body.base_dt = base;
      const d = await this.rest('/api/dostk/chart', apiId, body, extra);
      const rows =
        tables.map((t) => d[t]).find((x) => Array.isArray(x) && x.length) ||
        Object.values(d).find((x) => Array.isArray(x) && x.length && typeof x[0] === 'object');
      const candles = dailyToCandles(parseDailyRows(rows || []));
      return {candles, hasMore: this.lastContinuation.contYn === 'Y', nextKey: this.lastContinuation.nextKey};
    }
    const pullMore = async (candles: Candle[], hasMore: boolean, nextKey: string, load: (ex: {contYn?: string; nextKey?: string}) => Promise<Candle[]>): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}> => {
      if (input.singlePage || input.nextKey) return {candles, hasMore, nextKey};
      let bars = candles;
      let more = hasMore;
      let key = nextKey;
      let pages = 0;
      while (!hasMorningSession(bars) && more && key && pages < 5) {
        const older = await load({contYn: 'Y', nextKey: key});
        bars = mergeCandlePages(older, bars);
        more = this.lastContinuation.contYn === 'Y';
        key = this.lastContinuation.nextKey;
        pages++;
      }
      return {candles: bars, hasMore: more, nextKey: key};
    };
    if (input.timeframe.startsWith('T')) {
      const spec = parseTickTimeframe(input.timeframe);
      if (!spec) throw new Error('틱봉은 1/3/5/10/30 또는 30의 배수(최대 7200)만 지원합니다.');
      const load = (ex: {contYn?: string; nextKey?: string}) => this.chartRows('/api/dostk/chart', 'ka10079', input.code, {tic_scope: spec.native, upd_stkpc_tp: '1'}, ex, 'stk_tic_chart_qry');
      let candles = await load(extra);
      let hasMore = this.lastContinuation.contYn === 'Y';
      let nextKey = this.lastContinuation.nextKey;
      const packed = await pullMore(candles, hasMore, nextKey, load);
      candles = spec.group > 1 ? aggregateTickBars(packed.candles, spec.group) : packed.candles;
      return {candles, hasMore: packed.hasMore, nextKey: packed.nextKey};
    }
    const allowed = new Set(['1', '3', '5', '10', '15', '30', '45', '60']);
    if (!allowed.has(input.timeframe)) throw new Error('지원 차트: 틱·분·일·주·월. 초봉 API는 명세에 없습니다.');
    const load = (ex: {contYn?: string; nextKey?: string}) => this.chartRows('/api/dostk/chart', 'ka10080', input.code, {tic_scope: input.timeframe, upd_stkpc_tp: '1'}, ex, 'stk_min_pole_chart_qry');
    const first = await load(extra);
    return pullMore(first, this.lastContinuation.contYn === 'Y', this.lastContinuation.nextKey, load);
  }

  private readonly names = new Map<string, string>();

  async stockName(code: string): Promise<string> {
    if (!/^\d{6}$/.test(code)) return code;
    const cached = this.names.get(code);
    if (cached) return cached;
    const d = await this.rest('/api/dostk/stkinfo', 'ka10001', {stk_cd: code});
    const name = String(d.stk_nm ?? '').trim();
    if (name) this.names.set(code, name);
    return name || code;
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

  async strengthPage(input: {code: string; daily?: boolean; nextKey?: string; hintSec: number}): Promise<{ticks: StrengthTick[]; hasMore: boolean; nextKey: string; unified: boolean}> {
    if (!/^\d{6}$/.test(input.code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
    const extra = input.nextKey ? {contYn: 'Y', nextKey: input.nextKey} : {};
    const apiId = input.daily ? 'ka10047' : 'ka10046';
    let d: any;
    let unified = true;
    try {
      d = await this.rest('/api/dostk/mrkcond', apiId, {stk_cd: `${input.code}_AL`}, extra);
      if (!Array.isArray(d.cntr_str_tm || d.cntr_str_dy) || !(d.cntr_str_tm || d.cntr_str_dy).length) throw new Error('empty');
    } catch {
      unified = false;
      d = await this.rest('/api/dostk/mrkcond', apiId, {stk_cd: input.code}, extra);
    }
    const rows = d.cntr_str_tm || d.cntr_str_dy || [];
    return {
      ticks: parseStrengthTicks(rows, input.hintSec),
      hasMore: this.lastContinuation.contYn === 'Y',
      nextKey: this.lastContinuation.nextKey,
      unified,
    };
  }

  /**
   * 가격 차트와 맞추려면 최신 봉 날짜의 세션 시작(NXT 08:30 / KRX 09:00)까지 ka10046을 연속조회한다.
   * +이전은 nextKey 한 페이지만. 소량 연속 매수 이상치는 50으로 보정한다.
   */
  async attachStrength(code: string, timeframe: string, candles: Candle[], nextKey?: string): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string; ready: boolean; nxt: boolean}> {
    if (!candles.length) return {candles, hasMore: false, nextKey: '', ready: false, nxt: false};
    const daily = timeframe === 'D' || timeframe === 'W' || timeframe === 'M';
    const hint = candles[candles.length - 1].time;
    const bufKey = strengthBufKey(code, hint);
    const prev = strengthBuf.get(bufKey);
    const useKey = nextKey || prev?.nextKey || '';
    let page: {ticks: StrengthTick[]; hasMore: boolean; nextKey: string; unified: boolean};
    try {
      page = await this.strengthPage({code, daily, hintSec: prev?.ticks[0]?.time ?? hint, nextKey: useKey || undefined});
    } catch {
      const aligned0 = prev ? alignStrengthToCandles(candles, prev.ticks.filter((x) => x.strength > 0 && x.strength !== 50), timeframe) : candles;
      return {candles: aligned0, hasMore: Boolean(prev && !prev.reached), nextKey: prev?.nextKey || '', ready: Boolean(prev?.reached), nxt: Boolean(prev?.nxt)};
    }
    let ticks = mergeTicks(page.ticks, prev?.ticks || []);
    const nxt = page.unified || prev?.nxt || hasMorningSession(candles);
    const hour = nxt ? 8 : 9;
    const minute = nxt ? 30 : 0;
    const reached = daily || reachedSessionOpen(ticks.map((t) => t.time), hint, hour, minute);
    strengthBuf.set(bufKey, {ticks, nextKey: page.nextKey, reached, nxt});
    const aligned = alignStrengthToCandles(candles, ticks.filter((t) => t.strength > 0 && t.strength !== 50), timeframe);
    const sync = strengthSyncStatus(aligned);
    return {
      candles: aligned,
      hasMore: page.hasMore && !reached,
      nextKey: page.nextKey,
      ready: reached && sync.ready,
      nxt,
    };
  }
}

export type {Stock};
