/** 중앙관리자 = 책상(창·허브 UI). 코디네이터 = 허브 안 감독 모듈. 별칭이 아님. */

export const COORD_STATES = ['detected', 'downloading', 'ready', 'live', 'ranked', 'trading', 'excluded', 'halted'] as const;
export type CoordState = (typeof COORD_STATES)[number];

export const COORD_PHASES = ['idle', 'nxt_scan', 'downloading', 'ready_wait', 'krx_open', 'live', 'halt'] as const;
export type CoordPhase = (typeof COORD_PHASES)[number];

export type CoordStock = {
  code: string;
  name: string;
  state: CoordState;
  bars: number;
  ms: number;
  note: string;
  at: number;
};

export type CoordEvent = {
  at: number;
  phase: CoordPhase;
  code?: string;
  from?: CoordState;
  to?: CoordState;
  note: string;
};

export type CoordSnapshot = {
  role: {desk: string; coordinator: string};
  phase: CoordPhase;
  clockLabel: string;
  halt: boolean;
  stocks: CoordStock[];
  events: CoordEvent[];
  counts: Record<CoordState, number>;
};

export const COORD_CLOCK: Record<CoordPhase, string> = {
  idle: '대기',
  nxt_scan: '08:00 NXT 조건',
  downloading: 'CYBOS 이력 수신',
  ready_wait: '09:00 전 ready',
  krx_open: '09:00 KRX 증분',
  live: '0B·순위',
  halt: '감독 정지',
};
