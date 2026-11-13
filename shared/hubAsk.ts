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
export const HUB_WINDOW_ROUTES = {
  chart: {method: 'POST', path: '/api/chart', op: 'chart'},
  live: {method: 'GET', path: '/api/live-bars', op: 'live'},
  buy: {method: 'POST', path: '/api/book/buy', op: 'buy'},
  sell: {method: 'POST', path: '/api/book/sell', op: 'sell'},
  flatten: {method: 'POST', path: '/api/book/flatten', op: 'flatten'},
  cancel: {method: 'POST', path: '/api/book/cancel', op: 'cancel'},
  state: {method: 'GET', path: '/api/state', op: 'system'},
} as const;
