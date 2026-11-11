/**
 * Kiwoom realtime (WebSocket) protocol helpers.
 *
 * Everything here is derived from the official repository
 * https://github.com/Kiwoom-Securities/Kiwoom-REST-API
 * (client `kiwoom/core/ws_client.py`, `kiwoom/realtime/packets.py`,
 * `kiwoom/realtime/events.py`) and from the packaged API spec
 * `kiwoom/_data/kiwoom_api_spec.json`.
 *
 * Verified wire facts:
 *  - endpoint:  real wss://api.kiwoom.com:10000 , mock wss://mockapi.kiwoom.com:10000
 *               path `/api/dostk/websocket`
 *  - login:     send {"trnm":"LOGIN","token":<access token>}; the server answers a
 *               LOGIN frame with `return_code`/`return_msg`. No other frame may
 *               arrive before that ack.
 *  - keepalive: the server may send a PING frame (JSON dict with trnm PING, or a
 *               bare "PING" string). The client must echo the same packet back.
 *               The official client connects with `ping_interval=None`.
 *  - register:  {"trnm":"REG","grp_no":"1","refresh":"1","data":[{"item":[..],"type":[..]}]}
 *  - unregister:{"trnm":"REMOVE","grp_no":"1","data":[{"item":[..],"type":[..]}]}
 *  - realtime:  {"trnm":"REAL","data":[{"item":"005930","type":"0B","values":{"10":"..",..}}]}
 *
 * NOT published anywhere we could verify, and therefore never asserted as fact:
 *  - the numeric per-API / total / group request quotas (only the error codes
 *    1700 / 1701 / 1702 are documented), and
 *  - the maximum number of realtime registrations or connections.
 * Both are configuration values in this project (see `limits.ts`).
 */
import type {Candle} from '../core';

export const WS_PATH = '/api/dostk/websocket';

/** Realtime base URL per environment. Verified from the official client. */
export function wsBaseUrl(mode: 'mock' | 'real'): string {
  return mode === 'real' ? 'wss://api.kiwoom.com:10000' : 'wss://mockapi.kiwoom.com:10000';
}

export function wsUrl(mode: 'mock' | 'real'): string {
  return wsBaseUrl(mode) + WS_PATH;
}

/**
 * Realtime type codes. The ids and their names come straight from the official
 * spec `apis` keys (e.g. `주식체결(0B)`).
 */
export const REALTIME_TYPES = {
  '0A': '주식기세',
  '0B': '주식체결',
  '0D': '주식호가잔량',
  '0U': '업종등락',
  '0g': '주식종목정보',
  '0J': '업종지수',
  '00': '주문체결',
  '04': '잔고',
  ka10173: '조건검색 요청 실시간',
} as const;

export type RealtimeType = keyof typeof REALTIME_TYPES;

/**
 * FID (field id) → meaning, taken from the spec field rows we actually use.
 * The whole 0B row set is 43 fields; only these are decoded.
 */
export const FID = {
  tradeTime: '20', // 체결시간
  price: '10', // 현재가
  change: '12', // 등락율
  tradeVolume: '15', // 거래량 (단일 체결)
  cumVolume: '13', // 누적거래량
  cumValue: '14', // 누적거래대금 (백만원 단위는 API 별로 상이, 아래 주석 참조)
  dayOpen: '16', // 시가
  dayHigh: '17', // 고가
  dayLow: '18', // 저가
  sign: '25', // 전일대비기호 (1 상한 2 상승 3 보합 4 하한 5 하락)
  strength: '228', // 체결강도
  sellVolume: '1030', // 매도체결량
  buyVolume: '1031', // 매수체결량
  buyRatio: '1032', // 매수비율
  netBuyVolume: '1314', // 순매수체결량 (단일 체결 기준)
  instantValue: '1313', // 순간거래대금
  upperLimit: '305', // 상한가 (0g)
  lowerLimit: '306', // 하한가 (0g)
  basePrice: '307', // 기준가 (0g)
  upCount: '252', // 상승종목수 (0U)
  flatCount: '253', // 보합종목수 (0U)
  downCount: '255', // 하락종목수 (0U)
  upperCount: '251', // 상한종목수 (0U)
  lowerCount: '254', // 하한종목수 (0U)
  condSeq: '841', // 일련번호 (ka10173)
  code: '9001', // 종목코드
  condAction: '843', // 삽입삭제 구분 (ka10173)
  side: '907', // 매도/수 구분
} as const;

export type RealtimeFrame = {
  trnm: string;
  return_code?: number | string;
  return_msg?: string;
  data?: unknown;
  [key: string]: unknown;
};

/** Raw frame as received: either a decoded object or the literal "PING" text. */
export type ParsedFrame = RealtimeFrame | {trnm: 'PING'; raw: string};

export function loginPacket(token: string): {trnm: 'LOGIN'; token: string} {
  if (typeof token !== 'string' || !token.trim()) throw new Error('실시간 로그인에 사용할 토큰이 없습니다.');
  return {trnm: 'LOGIN', token};
}

export type RegisterOptions = {groupNo?: string; refresh?: '0' | '1'};

function validateItems(items: readonly string[], types: readonly string[]): void {
  if (!Array.isArray(items) || items.length === 0) throw new Error('실시간 등록 종목이 없습니다.');
  if (!Array.isArray(types) || types.length === 0) throw new Error('실시간 등록 타입이 없습니다.');
  for (const item of items) if (typeof item !== 'string' || !item.trim()) throw new Error('실시간 등록 종목 코드가 올바르지 않습니다.');
  for (const type of types) if (!(type in REALTIME_TYPES)) throw new Error(`지원하지 않는 실시간 타입입니다: ${type}`);
}

export type RegisterPacket = {
  trnm: 'REG';
  grp_no: string;
  refresh: '0' | '1';
  data: {item: string[]; type: string[]}[];
};

export function registerPacket(items: readonly string[], types: readonly string[], options: RegisterOptions = {}): RegisterPacket {
  validateItems(items, types);
  const groupNo = options.groupNo ?? '1';
  const refresh = options.refresh ?? '1';
  if (!/^\d{1,3}$/.test(groupNo)) throw new Error('실시간 그룹번호는 숫자여야 합니다.');
  return {trnm: 'REG', grp_no: groupNo, refresh, data: [{item: [...items], type: [...types]}]};
}

export type RemovePacket = {trnm: 'REMOVE'; grp_no: string; data: {item: string[]; type: string[]}[]};

export function removePacket(items: readonly string[], types: readonly string[], options: {groupNo?: string} = {}): RemovePacket {
  validateItems(items, types);
  const groupNo = options.groupNo ?? '1';
  if (!/^\d{1,3}$/.test(groupNo)) throw new Error('실시간 그룹번호는 숫자여야 합니다.');
  return {trnm: 'REMOVE', grp_no: groupNo, data: [{item: [...items], type: [...types]}]};
}

/** Parse an inbound frame. Unparseable text is returned as a raw marker, never guessed. */
export function parseFrame(raw: unknown): ParsedFrame {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  const trimmed = text.trim();
  if (!trimmed) throw new Error('실시간 빈 메시지');
  if (trimmed.toUpperCase() === 'PING') return {trnm: 'PING', raw: trimmed};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('실시간 응답이 JSON이 아닙니다.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('실시간 응답 형식이 올바르지 않습니다.');
  const frame = parsed as RealtimeFrame;
  if (typeof frame.trnm !== 'string' || !frame.trnm.trim()) throw new Error('실시간 응답에 trnm이 없습니다.');
  return {...frame, trnm: frame.trnm.trim().toUpperCase()};
}

export function isPing(frame: ParsedFrame): boolean {
  return frame.trnm === 'PING';
}

/** Echo payload for a PING: the bare string must be echoed verbatim. */
export function pingEcho(frame: ParsedFrame): unknown {
  if ('raw' in frame) return frame.raw;
  return frame;
}

export function returnCode(frame: RealtimeFrame): number | null {
  const raw = frame.return_code;
  if (raw === undefined || raw === null || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

export type RealtimeEvent = {type: string; item: string; values: Record<string, string>};

/**
 * Expand a REAL frame into per-item events. Non-REAL frames yield an empty list;
 * malformed entries are dropped rather than synthesized.
 */
export function decodeEvents(frame: RealtimeFrame): RealtimeEvent[] {
  if (frame.trnm !== 'REAL' || !Array.isArray(frame.data)) return [];
  const events: RealtimeEvent[] = [];
  for (const entry of frame.data) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {item?: unknown; type?: unknown; values?: unknown};
    const item = typeof record.item === 'string' ? record.item.trim() : '';
    const type = typeof record.type === 'string' ? record.type.trim() : '';
    if (!item || !type) continue;
    const values: Record<string, string> = {};
    if (record.values && typeof record.values === 'object') {
      for (const [key, value] of Object.entries(record.values as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        values[key] = String(value);
      }
    }
    events.push({type, item: item.replace(/^A(?=\d{6}$)/, ''), values});
  }
  return events;
}

/** Kiwoom sends numbers as signed, zero-padded, sometimes comma-grouped strings. */
export function numeric(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/,/g, '');
  if (!text || !/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function absolute(raw: unknown): number | null {
  const value = numeric(raw);
  return value === null ? null : Math.abs(value);
}

/**
 * Percentage with sign.
 *
 * The realtime spec does not state the encoding of 등락율, while ka10172 documents a
 * zero-padded fixed-point integer (000001500 = +1.50%). A value with no decimal point and
 * at least 6 digits is therefore read with the same ×1000 convention; anything with a
 * decimal point is taken literally. The sign comes from the explicit `+`/`-` when present,
 * otherwise from the 전일대비기호 code (1 상한 2 상승 3 보합 4 하한 5 하락).
 */
export function changePercent(raw: unknown, signRaw: unknown): number | null {
  const value = numeric(raw);
  if (value === null) return null;
  const text = String(raw ?? '').trim();
  const fixedPoint = !text.includes('.') && /^[+-]?\d{6,}$/.test(text);
  const percent = fixedPoint ? value / 1000 : value;
  if (/^[+-]/.test(text)) return percent;
  const sign = String(signRaw ?? '').trim();
  if (sign === '4' || sign === '5') return -Math.abs(percent);
  if (sign === '3') return 0;
  return Math.abs(percent);
}

/** HHMMSS + KST business date → epoch seconds. Invalid clock values yield null. */
export function clockToSeconds(raw: unknown, kstDate: string): number | null {
  const text = String(raw ?? '').trim();
  if (!/^\d{6}$/.test(text)) return null;
  if (!/^\d{8}$/.test(kstDate)) return null;
  const hh = Number(text.slice(0, 2));
  const mm = Number(text.slice(2, 4));
  const ss = Number(text.slice(4, 6));
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const iso = `${kstDate.slice(0, 4)}-${kstDate.slice(4, 6)}-${kstDate.slice(6, 8)}T${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  if (normalized !== `${kstDate}${text}`) return null;
  return Math.floor(ms / 1000);
}

export type Quote = {
  code: string;
  /** 마지막 체결 시각(초). 체결시간 필드가 없으면 null. */
  time: number | null;
  price: number;
  changePct: number | null;
  strength: number | null;
  cumVolume: number | null;
  /** 0B `14` 누적거래대금. 단위는 키움 명세상 누적값이며 봉별 거래대금이 아니다. */
  cumValue: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  tradeVolume: number | null;
  /** 0B `1314` 순매수체결량: 단일 체결의 순매수량이며 투자자별 순매수가 아니다. */
  netBuyVolume: number | null;
  buyVolume: number | null;
  sellVolume: number | null;
  source: '0B' | '0A';
  receivedAt: number;
};

/**
 * Build a quote from a 0B (주식체결) or 0A (주식기세) event.
 * Only fields present in the spec are decoded; anything missing stays null.
 */
export function quoteFromEvent(event: RealtimeEvent, kstDate: string, receivedAt: number): Quote | null {
  if (event.type !== '0B' && event.type !== '0A') return null;
  const values = event.values;
  const price = absolute(values[FID.price]);
  if (price === null || price <= 0) return null;
  const source = event.type as '0B' | '0A';
  const trade = source === '0B';
  return {
    code: event.item,
    time: clockToSeconds(values[FID.tradeTime], kstDate),
    price,
    changePct: changePercent(values[FID.change], values[FID.sign]),
    strength: trade ? absolute(values[FID.strength]) : null,
    cumVolume: absolute(values[FID.cumVolume]),
    cumValue: absolute(values[FID.cumValue]),
    dayOpen: absolute(values[FID.dayOpen]),
    dayHigh: absolute(values[FID.dayHigh]),
    dayLow: absolute(values[FID.dayLow]),
    tradeVolume: trade ? absolute(values[FID.tradeVolume]) : null,
    netBuyVolume: trade ? numeric(values[FID.netBuyVolume]) : null,
    buyVolume: trade ? absolute(values[FID.buyVolume]) : null,
    sellVolume: trade ? absolute(values[FID.sellVolume]) : null,
    source,
    receivedAt,
  };
}

export type StockInfo = {code: string; upperLimit: number | null; lowerLimit: number | null; basePrice: number | null; receivedAt: number};

/** 0g 주식종목정보: 상한가/하한가/기준가만 디코드한다. */
export function stockInfoFromEvent(event: RealtimeEvent, receivedAt: number): StockInfo | null {
  if (event.type !== '0g') return null;
  const info = {
    code: event.item,
    upperLimit: absolute(event.values[FID.upperLimit]),
    lowerLimit: absolute(event.values[FID.lowerLimit]),
    basePrice: absolute(event.values[FID.basePrice]),
    receivedAt,
  };
  if (info.upperLimit === null && info.lowerLimit === null && info.basePrice === null) return null;
  return info;
}

export type SectorSnapshot = {
  indexCode: string;
  time: number | null;
  value: number | null;
  changePct: number | null;
  cumValue: number | null;
  upCount: number | null;
  downCount: number | null;
  flatCount: number | null;
  upperCount: number | null;
  lowerCount: number | null;
  receivedAt: number;
};

/**
 * 0J(업종지수)와 0U(업종등락)를 하나의 업종 스냅샷으로 합친다.
 * 두 타입은 서로 다른 프레임으로 도착하므로 없는 필드는 null로 남긴다.
 */
export function sectorFromEvent(event: RealtimeEvent, kstDate: string, receivedAt: number): SectorSnapshot | null {
  if (event.type !== '0J' && event.type !== '0U') return null;
  const counters = event.type === '0U';
  return {
    indexCode: event.item,
    time: clockToSeconds(event.values[FID.tradeTime], kstDate),
    value: absolute(event.values[FID.price]),
    changePct: changePercent(event.values[FID.change], event.values[FID.sign]),
    cumValue: absolute(event.values[FID.cumValue]),
    upCount: counters ? absolute(event.values[FID.upCount]) : null,
    downCount: counters ? absolute(event.values[FID.downCount]) : null,
    flatCount: counters ? absolute(event.values[FID.flatCount]) : null,
    upperCount: counters ? absolute(event.values[FID.upperCount]) : null,
    lowerCount: counters ? absolute(event.values[FID.lowerCount]) : null,
    receivedAt,
  };
}

export type ConditionEvent = {seq: string; code: string; action: 'insert' | 'delete'; time: number | null};

/**
 * ka10173(조건검색 요청 실시간) 이벤트.
 * 843 삽입삭제 구분은 명세상 코드값이며, 문서에 값의 의미가 명시되어 있지 않다.
 * 따라서 'I'/'D' 로 시작하는 경우만 해석하고 그 외는 null(무시)로 둔다.
 */
export function conditionEvent(event: RealtimeEvent, kstDate: string): ConditionEvent | null {
  if (event.type !== 'ka10173') return null;
  const seq = String(event.values[FID.condSeq] ?? '').trim();
  const code = String(event.values[FID.code] ?? '').trim().replace(/^A(?=\d{6}$)/, '');
  const flag = String(event.values[FID.condAction] ?? '').trim().toUpperCase();
  if (!seq || !/^\d{6}$/.test(code)) return null;
  let action: 'insert' | 'delete' | null = null;
  if (flag === 'I' || flag === '1' || flag === 'INSERT') action = 'insert';
  if (flag === 'D' || flag === '0' || flag === 'DELETE') action = 'delete';
  if (!action) return null;
  return {seq, code, action, time: clockToSeconds(event.values[FID.tradeTime], kstDate)};
}

/** KST business date (YYYYMMDD) for a given epoch ms. */
export function kstDate(nowMs: number): string {
  return new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Bar key for a closed minute candle; used for signal dedup. */
export function barKey(code: string, time: number): string {
  return `${code}:${time}`;
}

export type {Candle};
