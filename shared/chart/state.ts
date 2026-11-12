import type {ChartDrawing, ChildWindow} from '../desk';

/** 차트 인스턴스 JSON. 창 상태와 분리해 저장·복원한다. */
export type ChartPersistV1 = {
  v: 1;
  code?: string;
  timeframe?: string;
  yMode?: 'price' | 'percent';
  magnet?: boolean;
  paneById?: Record<string, number>;
  drawings?: ChartDrawing[];
  enabledFormulas?: string[];
  visibleBars?: number;
  daySep?: boolean;
  refLines?: {prev?: boolean; open?: boolean; vi?: boolean};
  addons?: string[];
};

export function chartStateFromWindow(win: Pick<ChildWindow, 'code' | 'timeframe' | 'yMode' | 'indicatorPanes' | 'drawings' | 'enabledFormulas' | 'visibleBars' | 'daySep' | 'refLines'>): ChartPersistV1 {
  return {
    v: 1,
    code: win.code,
    timeframe: win.timeframe,
    yMode: win.yMode,
    paneById: win.indicatorPanes,
    drawings: win.drawings,
    enabledFormulas: win.enabledFormulas,
    visibleBars: win.visibleBars,
    daySep: win.daySep,
    refLines: win.refLines,
  };
}

export function windowPatchFromChartState(s: ChartPersistV1): Partial<ChildWindow> {
  if (!s || s.v !== 1) return {};
  return {
    code: s.code,
    timeframe: s.timeframe,
    yMode: s.yMode,
    indicatorPanes: s.paneById,
    drawings: s.drawings,
    enabledFormulas: s.enabledFormulas,
    visibleBars: s.visibleBars,
    daySep: s.daySep,
    refLines: s.refLines,
  };
}

export function parseChartPersist(raw: string | ChartPersistV1 | null | undefined): ChartPersistV1 | null {
  try {
    const s = typeof raw === 'string' ? (JSON.parse(raw) as ChartPersistV1) : raw;
    if (!s || s.v !== 1) return null;
    return s;
  } catch {
    return null;
  }
}
