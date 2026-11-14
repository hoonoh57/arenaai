/**
 * 시세·주문 provider. 창은 고르지 않고 허브만 모드를 바꾼다.
 * trade(주문·조건·0B)와 bulk(대량 봉·강도·MarketEye)를 나눈다.
 */

export const MARKET_PROVIDERS = ['kiwoom', 'cybos', 'other'] as const;
export type MarketProvider = (typeof MARKET_PROVIDERS)[number];

export type ProviderLane = 'trade' | 'bulk' | 'quote';

export type CapBand = {
  concurrency: number;
  burst: number;
  windowSec: number;
  pageRows: number;
  codesPerCall: number;
  subscribe: number;
};

export type LabBand = {codes: number; deadlineMs: number};

export type ProviderSpec = {
  id: MarketProvider;
  title: string;
  lanes: readonly ProviderLane[];
  /** 운영 기본 */
  standard: CapBand;
  /** 넘기면 held. Plus/키움 쪽 상한 */
  max: CapBand;
  lab: {standard: LabBand; extreme: LabBand};
  note: string;
};

export const PROVIDER_SPECS: Record<MarketProvider, ProviderSpec> = {
  kiwoom: {
    id: 'kiwoom',
    title: '키움 REST/WSS',
    lanes: ['trade', 'quote', 'bulk'],
    standard: {concurrency: 4, burst: 10, windowSec: 1, pageRows: 1, codesPerCall: 1, subscribe: 100},
    max: {concurrency: 4, burst: 10, windowSec: 1, pageRows: 1, codesPerCall: 1, subscribe: 100},
    lab: {standard: {codes: 16, deadlineMs: 14000}, extreme: {codes: 16, deadlineMs: 20000}},
    note: '주문·조건·0B 전용. 분봉 1장 1.5~12초. 100종목 이력 REST 불가.',
  },
  cybos: {
    id: 'cybos',
    title: 'CYBOS Plus (64bit→32bit COM)',
    lanes: ['bulk', 'quote'],
    standard: {concurrency: 4, burst: 60, windowSec: 15, pageRows: 2000, codesPerCall: 200, subscribe: 100},
    max: {concurrency: 4, burst: 60, windowSec: 15, pageRows: 2000, codesPerCall: 200, subscribe: 400},
    lab: {standard: {codes: 16, deadlineMs: 8000}, extreme: {codes: 100, deadlineMs: 30000}},
    note: '관리자 필수. 15초 60건. MarketEye 200. 표준 16종·극한 100종 분봉. 봉은 reverse만.',
  },
  other: {
    id: 'other',
    title: '기타(미배선)',
    lanes: ['bulk'],
    standard: {concurrency: 1, burst: 1, windowSec: 1, pageRows: 1, codesPerCall: 1, subscribe: 0},
    max: {concurrency: 1, burst: 1, windowSec: 1, pageRows: 1, codesPerCall: 1, subscribe: 0},
    lab: {standard: {codes: 1, deadlineMs: 1000}, extreme: {codes: 1, deadlineMs: 1000}},
    note: '허브가 held. 창이 직접 호출 금지.',
  },
};

export type HubProviderMode = {
  trade: MarketProvider;
  bulk: MarketProvider;
  quote: MarketProvider;
};

export function parseProviderMode(env: {
  MARKET_TRADE_PROVIDER?: string;
  MARKET_BULK_PROVIDER?: string;
  MARKET_QUOTE_PROVIDER?: string;
} = {}): HubProviderMode {
  const one = (v: string | undefined, fb: MarketProvider): MarketProvider =>
    MARKET_PROVIDERS.includes(v as MarketProvider) ? (v as MarketProvider) : fb;
  return {
    trade: one(env.MARKET_TRADE_PROVIDER, 'kiwoom'),
    bulk: one(env.MARKET_BULK_PROVIDER, 'kiwoom'),
    quote: one(env.MARKET_QUOTE_PROVIDER, 'kiwoom'),
  };
}

export function capFor(id: MarketProvider, kind: 'standard' | 'max' = 'standard'): CapBand {
  return PROVIDER_SPECS[id][kind];
}
