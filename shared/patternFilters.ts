export type PatternFilterId =
  | 'skip001'
  | 'skip-chop'
  | 'base-boost'
  | 'delayed-buy'
  | 'early-buy'
  | 'delayed-sell'
  | 'early-sell'
  | 'best-score';

export type PatternFilter = {
  id: PatternFilterId;
  name: string;
  defaultOn: boolean;
  description: string;
};

/** 발굴된 진입·청산 필터. 지표 신호 위에 켜고 끈다. */
export const PATTERN_FILTERS: PatternFilter[] = [
  {id: 'skip001', name: 'skip001 건너뜀', defaultOn: true, description: '횡보 첫 이평은 건너뛰고, 다음 봉 품질이 skip001 KPI×N 이상이면 지연 진입합니다.'},
  {id: 'skip-chop', name: '급등후횡보 금지', defaultOn: true, description: '이미 급등한 뒤 내리막 횡보면 이평 매수를 건너뜁니다.'},
  {id: 'base-boost', name: '횡보돌파 가점', defaultOn: true, description: '긴 횡보 뒤 양봉 돌파에 진입 점수를 올립니다.'},
  {id: 'delayed-buy', name: '지연 매수', defaultOn: true, description: '1차 이평을 건너뛴 뒤 거래량·강도·봉 급증이면 재돌파 없이 매수합니다.'},
  {id: 'early-buy', name: '조기 매수', defaultOn: false, description: '횡보 중 첫 이평도 들어가게 합니다. 끄면 1차는 건너뜁니다.'},
  {id: 'delayed-sell', name: '지연 매도', defaultOn: true, description: '1차 이평 매도를 건너뛴 뒤 급락·거래량 급증이면 매도합니다.'},
  {id: 'early-sell', name: '조기 매도', defaultOn: false, description: '횡보 중 첫 이평 매도도 나가게 합니다.'},
  {id: 'best-score', name: '최고점 종목만 진입', defaultOn: true, description: '같은 봉에 여러 종목이 매수이면 점수가 가장 높은 한 종목만 들어갑니다.'},
];

export type FilterEnabled = Record<string, boolean>;

export function defaultFilterEnabled(): FilterEnabled {
  return Object.fromEntries(PATTERN_FILTERS.map((f) => [f.id, f.defaultOn]));
}

export function normalizeFilterEnabled(raw: unknown): FilterEnabled {
  const next = defaultFilterEnabled();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;
  for (const f of PATTERN_FILTERS) {
    const v = (raw as Record<string, unknown>)[f.id];
    if (typeof v === 'boolean') next[f.id] = v;
  }
  return next;
}

export function filterOn(enabled: FilterEnabled | undefined, id: PatternFilterId): boolean {
  if (enabled && Object.prototype.hasOwnProperty.call(enabled, id)) return Boolean(enabled[id]);
  return PATTERN_FILTERS.find((f) => f.id === id)?.defaultOn ?? false;
}

export type DelayContext = {skip001N: number; skip001Score: number};

export function defaultDelayContext(): DelayContext {
  return {skip001N: 1.2, skip001Score: 50};
}

export function normalizeSkip001N(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1.2;
  return Math.min(5, Math.max(0.5, n));
}

/** 후속 봉 품질이 skip001 점수×N 이상이어야 지연 진입. N을 올리면 진입이 줄어든다. */
export function skip001Threshold(score: number, n: number): number {
  const s = Number.isFinite(score) ? Math.max(1, Math.min(100, score)) : 50;
  return Math.min(99, s * normalizeSkip001N(n));
}
