/** 창·수요가 중앙관리자에 넣는 표준 요청. 키움 REST/WSS는 창이 치지 않는다. */

export const HUB_ASK_OPS = [
  'chart',
  'strength',
  'live',
  'quote',
  'name',
  'watch',
  'book',
  'buy',
  'sell',
  'flatten',
  'cancel',
  'system',
] as const;

export type HubAskOp = (typeof HUB_ASK_OPS)[number];

export type HubAsk = {
  /** 창 식별. 예 desk:chart, desk:book, pane:주문 */
  owner: string;
  op: HubAskOp;
  code?: string;
  timeframe?: string;
  baseDate?: string;
  nextKey?: string;
  items?: readonly string[];
  types?: readonly string[];
  fresh?: boolean;
  qty?: number;
  orderType?: 'market' | 'limit';
  limitPrice?: number;
  orderId?: string;
};

export type HubAskReply = {
  ok: boolean;
  /** 총량 보호로 REST/REG를 안 보냄. 캐시·장부는 있을 수 있음 */
  held: boolean;
  reason?: string;
  candles: unknown[];
  hasMore: boolean;
  nextKey: string;
  quote: unknown;
  name?: string;
  ready?: boolean;
  nxt?: boolean;
  book?: unknown;
  order?: unknown;
  orders?: unknown[];
  cancelled?: number;
  status?: unknown;
  quota?: unknown;
};

/** 창 HTTP. 모두 서버가 hub.ask로 위임. */
export const HUB_ASK_CATALOG: {
  op: HubAskOp;
  title: string;
  params: {name: string; type: string; required: boolean; note: string}[];
  returns: {name: string; type: string; note: string}[];
  http: string;
  note: string;
}[] = [
  {
    op: 'chart',
    title: '분봉/일봉 1장',
    params: [
      {name: 'owner', type: 'string', required: true, note: '창 ID. 예 desk:chart'},
      {name: 'code', type: 'string(6)', required: true, note: '종목코드'},
      {name: 'timeframe', type: "'1'|'D'", required: false, note: '기본 1'},
      {name: 'baseDate', type: 'string', required: false, note: '빈값=오늘'},
      {name: 'nextKey', type: 'string', required: false, note: '+이전 페이지만'},
    ],
    returns: [
      {name: 'candles', type: 'Candle[]', note: '{time,open,high,low,close,volume,strength}'},
      {name: 'hasMore', type: 'boolean', note: '이전 장 있음'},
      {name: 'nextKey', type: 'string', note: '다음 ask에 그대로'},
      {name: 'quote', type: 'Quote|null', note: '현재가'},
      {name: 'held', type: 'boolean', note: '총량 보류면 캐시'},
    ],
    http: 'POST /api/chart {code,timeframe,baseDate,nextKey,withStrength}',
    note: '한 페이지 reverse. sort 금지. 창은 REST 직접 금지.',
  },
  {
    op: 'strength',
    title: '체결강도 페이지',
    params: [
      {name: 'owner', type: 'string', required: true, note: ''},
      {name: 'code', type: 'string(6)', required: true, note: ''},
      {name: 'timeframe', type: 'string', required: false, note: ''},
      {name: 'nextKey', type: 'string', required: false, note: '허브가 08:30까지 페이징'},
    ],
    returns: [
      {name: 'candles', type: 'Candle[]', note: 'strength 채움'},
      {name: 'ready', type: 'boolean', note: '세션 시작까지'},
      {name: 'nxt', type: 'boolean', note: 'NXT 08:30 / KRX 09:00'},
      {name: 'held', type: 'boolean', note: '잔여 없으면 중단'},
    ],
    http: 'POST /api/chart {withStrength:true,strengthNextKey}',
    note: '페이징은 허브만. 창은 한 번만 요청.',
  },
  {
    op: 'live',
    title: '실시간 봉 합성',
    params: [
      {name: 'code', type: 'string(6)', required: true, note: ''},
      {name: 'timeframe', type: 'string', required: false, note: ''},
      {name: 'baseDate', type: 'string', required: false, note: ''},
    ],
    returns: [
      {name: 'candles', type: 'Candle[]', note: '캐시+0B 체결'},
      {name: 'quote', type: 'Quote|null', note: ''},
    ],
    http: 'GET /api/live-bars?code=&timeframe=&baseDate=',
    note: 'REST 없음. 폴링만.',
  },
  {
    op: 'quote',
    title: '시세',
    params: [{name: 'code', type: 'string(6)', required: true, note: ''}],
    returns: [{name: 'quote', type: 'Quote|null', note: 'price,strength,time,changePct'}],
    http: 'GET /api/state → 시세는 live-bars.quote',
    note: '',
  },
  {
    op: 'name',
    title: '종목명',
    params: [{name: 'code', type: 'string(6)', required: true, note: ''}],
    returns: [{name: 'name', type: 'string', note: ''}],
    http: 'POST /api/chart 회신의 name',
    note: '',
  },
  {
    op: 'watch',
    title: '실시간 구독',
    params: [
      {name: 'owner', type: 'string', required: true, note: ''},
      {name: 'items', type: 'string[]', required: true, note: '6자리 배열'},
      {name: 'types', type: "string[]", required: false, note: "기본 ['0B']"},
    ],
    returns: [
      {name: 'held', type: 'boolean', note: '상한이면 true, REG 안 함'},
      {name: 'reason', type: 'string', note: ''},
    ],
    http: '허브 subscribe. 창 전용 HTTP 없음',
    note: '이미 있으면 REG 없음. 재전송=TRNM.',
  },
  {
    op: 'book',
    title: '잔고·미체결',
    params: [{name: 'owner', type: 'string', required: true, note: ''}],
    returns: [{name: 'book', type: 'BookSnapshot', note: 'holdings[], working[], recent[], fillMode'}],
    http: 'GET /api/state → book',
    note: '폴링. REST 아님.',
  },
  {
    op: 'buy',
    title: '매수',
    params: [
      {name: 'code', type: 'string(6)', required: true, note: ''},
      {name: 'qty', type: 'number', required: false, note: '정수 ≥1'},
      {name: 'orderType', type: "'market'|'limit'", required: false, note: ''},
      {name: 'limitPrice', type: 'number', required: false, note: '지정가'},
    ],
    returns: [
      {name: 'order', type: 'SimOrder', note: 'status working|filled|cancelled'},
      {name: 'book', type: 'BookSnapshot', note: '실패해도 장부'},
    ],
    http: 'POST /api/book/buy {code,type,limitPrice,qty}',
    note: '신호 매수는 허브 applySignal. 창 가림과 무관.',
  },
  {
    op: 'sell',
    title: '매도',
    params: [
      {name: 'code', type: 'string(6)', required: true, note: ''},
      {name: 'qty', type: 'number', required: false, note: ''},
      {name: 'orderType', type: "'market'|'limit'", required: false, note: ''},
    ],
    returns: [
      {name: 'order', type: 'SimOrder', note: ''},
      {name: 'book', type: 'BookSnapshot', note: ''},
    ],
    http: 'POST /api/book/sell {code,type,limitPrice,qty}',
    note: '',
  },
  {
    op: 'flatten',
    title: '전량 청산',
    params: [{name: 'orderType', type: "'market'|'limit'", required: false, note: ''}],
    returns: [
      {name: 'orders', type: 'SimOrder[]', note: ''},
      {name: 'book', type: 'BookSnapshot', note: ''},
    ],
    http: 'POST /api/book/flatten {type}',
    note: '',
  },
  {
    op: 'cancel',
    title: '미체결 취소',
    params: [
      {name: 'orderId', type: 'string', required: false, note: '한 건'},
      {name: 'code', type: 'string(6)', required: false, note: '종목 전부'},
    ],
    returns: [
      {name: 'order', type: 'SimOrder', note: 'id 지정 시'},
      {name: 'cancelled', type: 'number', note: '일괄 시'},
      {name: 'book', type: 'BookSnapshot', note: ''},
    ],
    http: 'POST /api/book/cancel {id} 또는 {code}',
    note: '',
  },
  {
    op: 'system',
    title: '링크·총량·장부',
    params: [{name: 'owner', type: 'string', required: true, note: ''}],
    returns: [
      {name: 'status', type: 'HubStatus', note: 'state,link,silentMs,emergency,subscriptions'},
      {name: 'quota', type: '{rest,wss}', note: 'used/left/cap'},
      {name: 'book', type: 'BookSnapshot', note: ''},
    ],
    http: 'GET /api/state → realtime.hub, quota, book',
    note: '대시보드 폴링용.',
  },
];

export const HUB_WINDOW_ROUTES = {
  chart: {method: 'POST', path: '/api/chart', op: 'chart'},
  live: {method: 'GET', path: '/api/live-bars', op: 'live'},
  buy: {method: 'POST', path: '/api/book/buy', op: 'buy'},
  sell: {method: 'POST', path: '/api/book/sell', op: 'sell'},
  flatten: {method: 'POST', path: '/api/book/flatten', op: 'flatten'},
  cancel: {method: 'POST', path: '/api/book/cancel', op: 'cancel'},
  state: {method: 'GET', path: '/api/state', op: 'system'},
} as const;
