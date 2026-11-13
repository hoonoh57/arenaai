/** 테스트랩 부하 파라미터. 허용 범위는 실전 상한보다 넓게 잡아 극한을 재본다. */

export type LabParams = {
  /** 동시에 차트·강도·시세를 붙일 종목 수 */
  codes: number;
  /** 동시에 연 수요창 수 (차트+조건+주문 등) */
  windows: number;
  /** 종목당 동시에 붙는 데이터 종류 수 (봉, 강도, 0B, 가상 SOX, 가상 외인) */
  feedsPerCode: number;
  /** 분봉 REST를 몇 종목 병렬로 넣을지 */
  chartConcurrency: number;
  /** 종목 사이 REST 간격(ms). 0이면 한 번에 */
  restIntervalMs: number;
  /** 가짜 REST 한 건 지연(ms). 한도 체감용 */
  restDelayMs: number;
  /** 종목당 체결 틱 수 */
  ticks: number;
  /** 조건식 개수 */
  conditions: number;
  /** 조건식당 포착 종목 */
  captured: number;
  /** 감시 슬롯 예산 */
  watchBudget: number;
  /** 동시 주문 시도 */
  orders: number;
  /** 위험 최대 보유 */
  maxPositions: number;
  /** 합격 한도(ms). 이 안이면 시나리오 통과 */
  deadlineMs: number;
  /** 차트 리프레시 주기(ms) */
  refreshMs: number;
};

export const LAB_PARAM_FIELDS: {
  key: keyof LabParams;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  {key: 'codes', label: '동시 종목', min: 1, max: 200, step: 1, hint: '차트·전략에 올리는 종목'},
  {key: 'windows', label: '동시 수요창', min: 1, max: 128, step: 1, hint: '8화면×16=128'},
  {key: 'feedsPerCode', label: '종목당 피드', min: 1, max: 8, step: 1, hint: '봉·강도·0B·SOX·외인 등'},
  {key: 'chartConcurrency', label: '차트 병렬', min: 1, max: 32, step: 1, hint: 'ka10080 동시 요청'},
  {key: 'restIntervalMs', label: 'REST 간격 ms', min: 0, max: 2000, step: 50, hint: '0=한 번에'},
  {key: 'restDelayMs', label: 'REST 지연 ms', min: 0, max: 500, step: 10, hint: '가짜 네트워크'},
  {key: 'ticks', label: '종목당 틱', min: 1, max: 500, step: 1, hint: '실시간 갱신 횟수'},
  {key: 'conditions', label: '조건식 수', min: 1, max: 20, step: 1, hint: '동시 조건검색'},
  {key: 'captured', label: '식당 포착', min: 1, max: 500, step: 1, hint: '포착 종목 팽창'},
  {key: 'watchBudget', label: '감시 슬롯', min: 1, max: 100, step: 1, hint: '0B 구독 상한과 맞춤'},
  {key: 'orders', label: '주문 시도', min: 1, max: 80, step: 1, hint: '중복·한도 포함'},
  {key: 'maxPositions', label: '최대 보유', min: 1, max: 16, step: 1, hint: '위험 한도'},
  {key: 'deadlineMs', label: '목표 ms', min: 50, max: 5000, step: 50, hint: '비교용 목표. 총량 허용 실측과 나란히 봄'},
  {key: 'refreshMs', label: '차트 주기 ms', min: 5000, max: 300000, step: 1000, hint: '리프레시 예산'},
];

export const LAB_PARAM_DEFAULT: LabParams = {
  codes: 16,
  windows: 16,
  feedsPerCode: 5,
  chartConcurrency: 4,
  restIntervalMs: 300,
  restDelayMs: 0,
  ticks: 20,
  conditions: 1,
  captured: 40,
  watchBudget: 40,
  orders: 8,
  maxPositions: 4,
  deadlineMs: 1000,
  refreshMs: 15000,
};

export const LAB_PARAM_PRESETS: {id: string; label: string; params: LabParams}[] = [
  {id: 'desk16', label: '실전 16창', params: {...LAB_PARAM_DEFAULT}},
  {
    id: 'extreme',
    label: '극한',
    params: {
      codes: 64,
      windows: 128,
      feedsPerCode: 8,
      chartConcurrency: 16,
      restIntervalMs: 0,
      restDelayMs: 0,
      ticks: 80,
      conditions: 8,
      captured: 200,
      watchBudget: 100,
      orders: 40,
      maxPositions: 4,
      deadlineMs: 1000,
      refreshMs: 15000,
    },
  },
  {
    id: 'rest-tight',
    label: 'REST 빽빽',
    params: {
      ...LAB_PARAM_DEFAULT,
      codes: 16,
      chartConcurrency: 16,
      restIntervalMs: 0,
      restDelayMs: 40,
      deadlineMs: 1000,
    },
  },
];

export function clampLabParams(raw: Partial<LabParams> | null | undefined): LabParams {
  const base = {...LAB_PARAM_DEFAULT, ...(raw || {})};
  const out = {...LAB_PARAM_DEFAULT};
  for (const f of LAB_PARAM_FIELDS) {
    let n = Number((base as LabParams)[f.key]);
    if (!Number.isFinite(n)) n = LAB_PARAM_DEFAULT[f.key];
    n = Math.min(f.max, Math.max(f.min, f.step >= 1 ? Math.round(n) : n));
    (out as unknown as Record<string, number>)[f.key] = n;
  }
  return out;
}
