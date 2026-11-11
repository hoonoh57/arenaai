/**
 * Virtual desks modelled after Kiwoom HTS (영웅문) 가상화면 1–8.
 * Layout and common variables live here; market data never originates here.
 */

export const DESK_MIN = 1;
export const DESK_MAX = 8;
/** 멀티차트 칸 수. 3×n 등 분할과 무관하게 한 화면에 16종목까지. */
export const MULTI_CHART_MAX = 16;
export const WINDOW_KINDS = ['chart', 'multi-chart', 'scanner', 'captures', 'tr', 'events', 'book'] as const;
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
  captures: '조건검색 포착',
  tr: '키움 REST TR',
  events: '모의 이벤트',
  book: '주문 대시보드',
};

const CODE = /^\d{6}$/;

export function emptyVars(): CommonVars {
  return {code: '', name: '', strategyId: ''};
}

export function defaultWorkspace(): DeskWorkspace {
  return {
    active: 1,
    desks: [{id: 'desk-1', number: 1, name: '가상화면 1', vars: emptyVars(), windows: []}],
  };
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
  if (desk.windows.length >= 16) throw new Error('한 화면에 자식창은 16개까지입니다.');
  const z = desk.windows.reduce((max, win) => Math.max(max, win.z), 0) + 1;
  const window: ChildWindow = {
    id: `win-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: KIND_TITLE[kind],
    x: 24 + (offset % 6) * 28,
    y: 24 + (offset % 6) * 28,
    w: kind === 'multi-chart' ? 720 : kind === 'scanner' || kind === 'captures' ? 380 : 520,
    h: kind === 'scanner' || kind === 'captures' ? 560 : kind === 'multi-chart' ? 480 : 380,
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
    formulaOpen: Boolean(win.formulaOpen),
    enabledFormulas: Array.isArray(win.enabledFormulas) ? win.enabledFormulas.filter((id): id is string => typeof id === 'string').slice(0, 50) : undefined,
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

export function replaceDesk(workspace: DeskWorkspace, desk: VirtualDesk): DeskWorkspace {
  return {...workspace, desks: workspace.desks.map((item) => (item.id === desk.id ? desk : item))};
}

export function activeDesk(workspace: DeskWorkspace): VirtualDesk {
  return workspace.desks.find((desk) => desk.number === workspace.active) ?? workspace.desks[0];
}
