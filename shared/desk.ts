/**
 * Virtual desks modelled after Kiwoom HTS (영웅문) 가상화면 1–8.
 * Layout and common variables live here; market data never originates here.
 */

export const DESK_MIN = 1;
export const DESK_MAX = 8;
/** 멀티차트 칸 수. 3×n 등 분할과 무관하게 한 화면에 16종목까지. */
export const MULTI_CHART_MAX = 16;
export const WINDOW_KINDS = ['chart', 'multi-chart', 'scanner', 'search150', 'captures', 'verify', 'tr', 'events', 'book', 'logs', 'hub-lab', 'hub-spec'] as const;
export const GLOBAL_LOG_ID = 'win-global-logs';
export type WindowKind = (typeof WINDOW_KINDS)[number];
export type WindowState = 'normal' | 'minimized' | 'maximized';

export type CommonVars = {code: string; name: string; strategyId: string};

export type ChildWindow = {
  id: string;
  kind: WindowKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  state: WindowState;
  restore?: {x: number; y: number; w: number; h: number};
  /** When true, parent common-variable changes do not overwrite this window. */
  locked: boolean;
  code?: string;
  /** System formula id. Locked windows keep this when the desk strategy changes. */
  strategyId?: string;
  timeframe?: string;
  baseDate?: string;
  visibleBars?: number;
  formulaOpen?: boolean;
  enabledFormulas?: string[];
  /** 지표 id → 패널 번호(0=가격, 1+=서브). 드래그·오버레이 위치. */
  indicatorPanes?: Record<string, number>;
  /** 줌·스크롤·패널 높이. 재시작·화면 이동 후 복원. */
  chartView?: {
    from?: number;
    to?: number;
    paneStretch?: number[];
    magnet?: boolean;
    selectedPane?: number;
  };
  compareMode?: 'replace' | 'overlay';
  overlayCode?: string;
  /** 멀티차트 열 수 (1~4). */
  gridCols?: number;
  syncCharts?: boolean;
  drawings?: ChartDrawing[];
  yMode?: 'price' | 'percent';
  daySep?: boolean;
  refLines?: {prev?: boolean; open?: boolean; vi?: boolean};
};

export type ChartDrawing = {
  id: string;
  kind: 'hline' | 'vline' | 'trend' | 'text' | 'target' | 'stop' | 'entry';
  t1: number;
  p1: number;
  t2?: number;
  p2?: number;
  text?: string;
  color: string;
};

export type VirtualDesk = {
  id: string;
  number: number;
  name: string;
  vars: CommonVars;
  windows: ChildWindow[];
};

export type DeskWorkspace = {active: number; desks: VirtualDesk[]};

export const KIND_TITLE: Record<WindowKind, string> = {
  chart: '종목 차트',
  'multi-chart': '멀티차트',
  scanner: '실시간 조건검색',
  search150: '[0150] 조건검색',
  captures: '조건검색 포착',
  tr: '키움 REST TR',
  events: '모의 이벤트',
  verify: '[1516] 성과검증',
  book: '주문 대시보드',
  logs: '전역 로그',
  'hub-lab': '중앙관리자 테스트랩',
  'hub-spec': '중앙관리자 스펙',
};

const CODE = /^\d{6}$/;

export function emptyVars(): CommonVars {
  return {code: '', name: '', strategyId: ''};
}

export function mockTradeDesk(): VirtualDesk {
  return {
    id: 'desk-3-trade',
    number: 3,
    name: '모의매매',
    vars: emptyVars(),
    windows: [
      {id: 'win-trade-scanner', kind: 'scanner', title: '실시간 점수', x: 8, y: 8, w: 360, h: 620, z: 1, state: 'normal', locked: false},
      {id: 'win-trade-multi', kind: 'multi-chart', title: '멀티차트', x: 376, y: 8, w: 780, h: 620, z: 2, state: 'normal', locked: false, gridCols: 3, timeframe: '1', syncCharts: true},
      {id: 'win-trade-book', kind: 'book', title: '보유·미체결', x: 1164, y: 8, w: 400, h: 420, z: 3, state: 'normal', locked: false},
      {id: GLOBAL_LOG_ID, kind: 'logs', title: '전역 로그', x: 1164, y: 436, w: 400, h: 280, z: 4, state: 'normal', locked: false},
    ],
  };
}

export function ensureMockTradeWorkspace(workspace: DeskWorkspace): DeskWorkspace {
  const desks = [...workspace.desks];
  const idx = desks.findIndex((d) => d.number === 3);
  if (idx < 0) {
    if (desks.length >= DESK_MAX) return workspace;
    desks.push(mockTradeDesk());
  } else if (desks[idx].windows.length === 0) {
    const layout = mockTradeDesk();
    desks[idx] = {...layout, id: desks[idx].id, name: desks[idx].name || layout.name, vars: desks[idx].vars};
  }
  return {active: workspace.active, desks: desks.sort((a, b) => a.number - b.number)};
}

export function defaultWorkspace(): DeskWorkspace {
  return ensureMockTradeWorkspace({
    active: 3,
    desks: [
      {id: 'desk-1', number: 1, name: '가상화면 1', vars: emptyVars(), windows: []},
      mockTradeDesk(),
    ],
  });
}

export function nextDeskNumber(desks: readonly VirtualDesk[]): number | null {
  const used = new Set(desks.map((desk) => desk.number));
  for (let number = DESK_MIN; number <= DESK_MAX; number += 1) {
    if (!used.has(number)) return number;
  }
  return null;
}

export function createDesk(desks: readonly VirtualDesk[], name?: string): VirtualDesk {
  const number = nextDeskNumber(desks);
  if (number === null) throw new Error(`가상화면은 ${DESK_MAX}개까지입니다.`);
  const trimmed = (name ?? `가상화면 ${number}`).trim().slice(0, 40);
  if (!trimmed) throw new Error('가상화면 이름을 입력하세요.');
  return {id: `desk-${number}-${Date.now()}`, number, name: trimmed, vars: emptyVars(), windows: []};
}

export function renameDesk(desk: VirtualDesk, name: string): VirtualDesk {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error('가상화면 이름을 입력하세요.');
  return {...desk, name: trimmed};
}

export function insertWindow(desk: VirtualDesk, kind: WindowKind, offset = desk.windows.length): VirtualDesk {
  if (!WINDOW_KINDS.includes(kind)) throw new Error('등록되지 않은 자식창입니다.');
  if (kind === 'logs' && desk.windows.some((w) => w.id === GLOBAL_LOG_ID || w.kind === 'logs')) return desk;
  if (desk.windows.length >= 16) throw new Error('한 화면에 자식창은 16개까지입니다.');
  const z = desk.windows.reduce((max, win) => Math.max(max, win.z), 0) + 1;
  const window: ChildWindow = {
    id: kind === 'logs' ? GLOBAL_LOG_ID : `win-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: KIND_TITLE[kind],
    x: 24 + (offset % 6) * 28,
    y: 24 + (offset % 6) * 28,
    w: kind === 'hub-lab' || kind === 'hub-spec' || kind === 'multi-chart' || kind === 'verify' || kind === 'search150' ? 720 : kind === 'scanner' || kind === 'captures' ? 380 : 520,
    h: kind === 'hub-lab' || kind === 'hub-spec' || kind === 'scanner' || kind === 'captures' || kind === 'verify' || kind === 'search150' ? 560 : kind === 'multi-chart' ? 480 : 380,
    z,
    state: 'normal',
    locked: false,
    code: desk.vars.code || undefined,
    strategyId: desk.vars.strategyId || undefined,
  };
  return {...desk, windows: [...desk.windows, window]};
}

export function removeWindow(desk: VirtualDesk, id: string): VirtualDesk {
  return {...desk, windows: desk.windows.filter((win) => win.id !== id)};
}

export function patchWindow(desk: VirtualDesk, id: string, patch: Partial<ChildWindow>): VirtualDesk {
  return {
    ...desk,
    windows: desk.windows.map((win) => (win.id === id ? {...win, ...patch, id: win.id, kind: win.kind} : win)),
  };
}

export function focusWindow(desk: VirtualDesk, id: string): VirtualDesk {
  const top = desk.windows.reduce((max, win) => Math.max(max, win.z), 0) + 1;
  return patchWindow(desk, id, {z: top});
}

export function setWindowState(desk: VirtualDesk, id: string, state: WindowState): VirtualDesk {
  const win = desk.windows.find((item) => item.id === id);
  if (!win) return desk;
  if (state === 'maximized' || state === 'minimized') {
    const restore = win.state === 'normal' ? {x: win.x, y: win.y, w: win.w, h: win.h} : win.restore;
    return patchWindow(desk, id, {state, restore});
  }
  const restore = win.restore;
  if (!restore) return patchWindow(desk, id, {state: 'normal'});
  return patchWindow(desk, id, {state: 'normal', x: restore.x, y: restore.y, w: restore.w, h: restore.h});
}

export function toggleLock(desk: VirtualDesk, id: string): VirtualDesk {
  const win = desk.windows.find((item) => item.id === id);
  if (!win) return desk;
  if (win.locked) {
    return patchWindow(desk, id, {locked: false, code: desk.vars.code || win.code, strategyId: desk.vars.strategyId || win.strategyId});
  }
  return patchWindow(desk, id, {locked: true, code: win.code || desk.vars.code, strategyId: win.strategyId || desk.vars.strategyId});
}

/**
 * Push common variables into unlocked child windows. Locked windows keep their own code.
 */
export function syncVars(desk: VirtualDesk, vars: CommonVars): VirtualDesk {
  const code = typeof vars.code === 'string' && CODE.test(vars.code) ? vars.code : vars.code === '' ? '' : desk.vars.code;
  const name = typeof vars.name === 'string' ? vars.name.slice(0, 40) : desk.vars.name;
  const strategyId = typeof vars.strategyId === 'string' ? vars.strategyId.slice(0, 80) : desk.vars.strategyId;
  const next = {code, name, strategyId};
  return {
    ...desk,
    vars: next,
    windows: desk.windows.map((win) => (win.locked ? win : {...win, code: next.code || undefined, strategyId: next.strategyId || undefined})),
  };
}

export function setWindowCode(desk: VirtualDesk, id: string, code: string): VirtualDesk {
  const win = desk.windows.find((item) => item.id === id);
  if (!win) return desk;
  if (win.locked) throw new Error('잠긴 자식창의 종목은 부모 공통변수로 바꾸지 않습니다.');
  if (code && !CODE.test(code)) throw new Error('종목코드는 6자리 숫자여야 합니다.');
  return patchWindow(desk, id, {code});
}

export function validateWorkspace(value: unknown): DeskWorkspace {
  if (!value || typeof value !== 'object') throw new Error('가상화면 데이터가 올바르지 않습니다.');
  const raw = value as DeskWorkspace;
  if (!Array.isArray(raw.desks) || raw.desks.length < 1 || raw.desks.length > DESK_MAX) throw new Error('가상화면은 1~8개여야 합니다.');
  const numbers = new Set<number>();
  const desks = raw.desks.map((desk) => {
    if (!desk || typeof desk !== 'object') throw new Error('가상화면이 올바르지 않습니다.');
    if (!Number.isInteger(desk.number) || desk.number < DESK_MIN || desk.number > DESK_MAX) throw new Error('가상화면 번호는 1~8입니다.');
    if (numbers.has(desk.number)) throw new Error('가상화면 번호가 중복됩니다.');
    numbers.add(desk.number);
    if (typeof desk.id !== 'string' || !desk.id) throw new Error('가상화면 ID가 없습니다.');
    if (typeof desk.name !== 'string' || !desk.name.trim()) throw new Error('가상화면 이름이 없습니다.');
    const vars = desk.vars && typeof desk.vars === 'object' ? desk.vars : emptyVars();
    const code = typeof vars.code === 'string' && (vars.code === '' || CODE.test(vars.code)) ? vars.code : '';
    const windows = Array.isArray(desk.windows) ? desk.windows : [];
    if (windows.length > 16) throw new Error('한 화면에 자식창은 16개까지입니다.');
    return {
      id: desk.id.slice(0, 80),
      number: desk.number,
      name: desk.name.trim().slice(0, 40),
      vars: {
        code,
        name: typeof vars.name === 'string' ? vars.name.slice(0, 40) : '',
        strategyId: typeof vars.strategyId === 'string' ? vars.strategyId.slice(0, 80) : '',
      },
      windows: windows.map(validateWindow),
    };
  });
  const active = Number.isInteger(raw.active) && desks.some((desk) => desk.number === raw.active) ? raw.active : desks[0].number;
  return {active, desks: desks.sort((a, b) => a.number - b.number)};
}

function validateWindow(win: ChildWindow): ChildWindow {
  if (!win || typeof win !== 'object') throw new Error('자식창이 올바르지 않습니다.');
  if (typeof win.id !== 'string' || !win.id) throw new Error('자식창 ID가 없습니다.');
  if (!WINDOW_KINDS.includes(win.kind)) throw new Error('알 수 없는 자식창 종류입니다.');
  const num = (value: unknown, fallback: number) => (Number.isFinite(value) ? Number(value) : fallback);
  const state: WindowState = win.state === 'minimized' || win.state === 'maximized' ? win.state : 'normal';
  return {
    id: win.id.slice(0, 80),
    kind: win.kind,
    title: typeof win.title === 'string' && win.title.trim() ? win.title.trim().slice(0, 40) : KIND_TITLE[win.kind],
    x: Math.max(0, num(win.x, 24)),
    y: Math.max(0, num(win.y, 24)),
    w: Math.min(1600, Math.max(240, num(win.w, 480))),
    h: Math.min(1200, Math.max(160, num(win.h, 320))),
    z: Math.max(1, num(win.z, 1)),
    state,
    restore: win.restore,
    locked: Boolean(win.locked),
    code: typeof win.code === 'string' && (win.code === '' || CODE.test(win.code)) ? win.code : undefined,
    strategyId: typeof win.strategyId === 'string' ? win.strategyId.slice(0, 80) : undefined,
    timeframe: typeof win.timeframe === 'string' ? win.timeframe.slice(0, 8) : undefined,
    baseDate: typeof win.baseDate === 'string' ? win.baseDate.slice(0, 10) : undefined,
    visibleBars: Number.isInteger(win.visibleBars) ? Math.min(2000, Math.max(20, win.visibleBars as number)) : undefined,
    formulaOpen: typeof win.formulaOpen === 'boolean' ? win.formulaOpen : undefined,
    enabledFormulas: Array.isArray(win.enabledFormulas) ? win.enabledFormulas.filter((id): id is string => typeof id === 'string').slice(0, 50) : undefined,
    indicatorPanes:
      win.indicatorPanes && typeof win.indicatorPanes === 'object' && !Array.isArray(win.indicatorPanes)
        ? Object.fromEntries(
            Object.entries(win.indicatorPanes)
              .filter((e): e is [string, number] => typeof e[0] === 'string' && Number.isFinite(e[1]))
              .slice(0, 40)
              .map(([k, v]) => [k.slice(0, 80), Math.max(0, Math.min(8, Math.round(Number(v))))]),
          )
        : undefined,
    chartView:
      win.chartView && typeof win.chartView === 'object'
        ? {
            from: Number.isFinite(win.chartView.from) ? Number(win.chartView.from) : undefined,
            to: Number.isFinite(win.chartView.to) ? Number(win.chartView.to) : undefined,
            paneStretch: Array.isArray(win.chartView.paneStretch)
              ? win.chartView.paneStretch.filter((n): n is number => Number.isFinite(n)).slice(0, 8)
              : undefined,
            magnet: typeof win.chartView.magnet === 'boolean' ? win.chartView.magnet : undefined,
            selectedPane: Number.isInteger(win.chartView.selectedPane) ? Math.max(0, Math.min(8, win.chartView.selectedPane as number)) : undefined,
          }
        : undefined,
    compareMode: win.compareMode === 'overlay' ? 'overlay' : win.compareMode === 'replace' ? 'replace' : undefined,
    overlayCode: typeof win.overlayCode === 'string' && CODE.test(win.overlayCode) ? win.overlayCode : undefined,
    gridCols: Number.isInteger(win.gridCols) ? Math.min(4, Math.max(1, win.gridCols as number)) : undefined,
    syncCharts: win.syncCharts === undefined ? undefined : Boolean(win.syncCharts),
    yMode: win.yMode === 'percent' ? 'percent' : win.yMode === 'price' ? 'price' : undefined,
    daySep: win.daySep === undefined ? undefined : Boolean(win.daySep),
    refLines: win.refLines && typeof win.refLines === 'object' ? {prev: Boolean(win.refLines.prev), open: Boolean(win.refLines.open), vi: Boolean(win.refLines.vi)} : undefined,
    drawings: Array.isArray(win.drawings)
      ? win.drawings
          .filter((d): d is ChartDrawing => !!d && typeof d === 'object' && typeof (d as ChartDrawing).id === 'string' && typeof (d as ChartDrawing).kind === 'string')
          .slice(0, 80)
      : undefined,
  };
}

export function moveWindow(workspace: DeskWorkspace, winId: string, toNumber: number): DeskWorkspace {
  let found: ChildWindow | undefined;
  const stripped = workspace.desks.map((desk) => {
    const hit = desk.windows.find((w) => w.id === winId);
    if (hit) found = hit;
    return {...desk, windows: desk.windows.filter((w) => w.id !== winId)};
  });
  if (!found) throw new Error('옮길 창을 찾지 못했습니다.');
  const target = stripped.find((d) => d.number === toNumber);
  if (!target) throw new Error('대상 가상화면이 없습니다.');
  if (target.windows.length >= 16) throw new Error('한 화면에 자식창은 16개까지입니다.');
  const z = target.windows.reduce((max, win) => Math.max(max, win.z), 0) + 1;
  const moved = {...found, z, x: 24, y: 24};
  const desks = stripped.map((d) => (d.number === toNumber ? {...d, windows: [...d.windows, moved]} : d));
  return {active: toNumber, desks};
}

/** 전역 로그는 한 개만. 다른 화면에 있으면 이 화면으로 옮긴다. */
export function placeGlobalLog(workspace: DeskWorkspace, toNumber: number): DeskWorkspace {
  const existing = workspace.desks.flatMap((d) => d.windows).find((w) => w.id === GLOBAL_LOG_ID || w.kind === 'logs');
  if (existing) return moveWindow(workspace, existing.id, toNumber);
  const target = workspace.desks.find((d) => d.number === toNumber);
  if (!target) throw new Error('대상 가상화면이 없습니다.');
  return replaceDesk({...workspace, active: toNumber}, insertWindow(target, 'logs'));
}

export function replaceDesk(workspace: DeskWorkspace, desk: VirtualDesk): DeskWorkspace {
  return {...workspace, desks: workspace.desks.map((item) => (item.id === desk.id ? desk : item))};
}

export function activeDesk(workspace: DeskWorkspace): VirtualDesk {
  return workspace.desks.find((desk) => desk.number === workspace.active) ?? workspace.desks[0];
}
