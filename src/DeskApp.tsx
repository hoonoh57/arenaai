import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {Candle, Stock, Weights} from '../server/core';
import type {Formula} from '../shared/formula';
import {
  KIND_TITLE,
  MULTI_CHART_MAX,
  WINDOW_KINDS,
  placeGlobalLog,
  moveWindow,
  activeDesk,
  createDesk,
  defaultWorkspace,
  focusWindow,
  insertWindow,
  patchWindow,
  removeWindow,
  renameDesk,
  replaceDesk,
  setWindowState,
  syncVars,
  toggleLock,
  validateWorkspace,
  type ChildWindow,
  type DeskWorkspace,
  type VirtualDesk,
  type WindowKind,
} from '../shared/desk';
import {Chart} from './ChartView';
import {ChartPane} from './ChartPane';
import {FormulaManager} from './FormulaManager';
import {PineImport} from './PineImport';
import {DAY_HOLD_PRESETS, HOLD_PRESETS, parseSearchAt} from '../shared/verify';
import {Search150Pane} from './Search150Pane';
import {VerifyCompare} from './VerifyCompare';
import type {SavedCondition} from '../shared/localConditions';
import {PATTERN_FILTERS} from '../shared/patternFilters';

type Config = {condition: string; count: number; weights: Weights; running: boolean; refreshMs: number; chartCodes: string[]; strategyId: string; strategyByCode: Record<string, string>; tradeByCode: Record<string, 'wait' | 'run' | 'stop' | 'backtest'>; autoTopCharts?: boolean; tradeMode?: 'auto' | 'semi'; orderQty?: number; tradeSlots?: number; lockedCodes?: string[]; patternFilters?: Record<string, boolean>; skip001N?: number};
type State = {
  mode: string;
  config: Config;
  conditions: {seq: string; name: string}[];
  ranking: Stock[];
  captured: {code: string; name: string}[];
  lastSearch?: {seq: string; rows: number; sample: Record<string, unknown>[]};
  candles: Record<string, Candle[]>;
  updatedAt: number | null;
  error: string;
  busy: boolean;
  positions: Record<string, number>;
  events: {time: number; code: string; side: string; price: number}[];
  formulas: Formula[];
  dataWarnings: Record<string, string>;
  realtime?: {
    hub: {
      state: string;
      subscriptions: number;
      reconnects: number;
      duplicatesDropped: number;
      caps: {maxSubscriptions: number; verified: boolean};
      silentMs?: number | null;
      dataSilentMs?: number | null;
      warnAfterMs?: number;
      emergency?: boolean;
      link?: 'ok' | 'warn' | 'dead';
      lastError?: string | null;
    };
    watched: number;
    captured: number;
    rotation?: {skipped: number};
  };
  risk?: {blocked: boolean; positions: number; entriesToday: number; realisedPct: number; consecutiveLosses: number; limits: {maxPositions: number}};
  book?: {
    holdings: {code: string; qty: number; avgPrice: number; openedAt: number}[];
    working: {id: string; code: string; side: string; type: string; qty: number; limitPrice: number | null; reason: string}[];
    recent: {id: string; code: string; side: string; status: string; fillPrice: number | null; reason: string; updatedAt: number}[];
    assumedFill: boolean;
    brokerOrders: boolean;
    fillMode?: 'assumed' | 'kiwoom-mock';
  };
  patternKpi?: {summaries: {filterId: string; n: number; avgPct: number; score: number; ready: boolean}[]};
  market?: {indexRet?: number; ma120Slope?: number};
};

const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
async function post(path: string, body?: unknown) {
  const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '요청 실패');
  return d;
}
async function put(path: string, body: unknown) {
  const r = await fetch(path, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '요청 실패');
  return d;
}

const TOOLS: {kind: WindowKind; label: string}[] = WINDOW_KINDS.map((kind) => ({kind, label: KIND_TITLE[kind]}));

function queuedChart(code: string, timeframe: string, withStrength = false) {
  return post('/api/chart', {code, timeframe, withStrength});
}

export function DeskApp() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [notice, setNotice] = useState('');
  const [showFormulas, setShowFormulas] = useState(false);
  const [showSysTrade, setShowSysTrade] = useState(false);
  const [showPine, setShowPine] = useState(false);
  const [workspace, setWorkspace] = useState<DeskWorkspace>(defaultWorkspace);
  const [grid, setGrid] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [chartHeight, setChartHeight] = useState(250);
  const saveTimer = useRef<number | null>(null);
  const drag = useRef<{id: string; dx: number; dy: number; mode: 'move' | 'resize'} | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const load = async () => {
    try {
      const r = await fetch('/api/state');
      const s = await r.json();
      setState(s);
      setDraft((d) =>
        d
          ? {...d, chartCodes: s.config.chartCodes || [], running: s.config.running, refreshMs: s.config.refreshMs || d.refreshMs || 60000, strategyId: s.config.strategyId || d.strategyId || '', strategyByCode: s.config.strategyByCode || {}, tradeSlots: s.config.tradeSlots ?? d.tradeSlots ?? 4, tradeMode: s.config.tradeMode || d.tradeMode || 'auto', orderQty: s.config.orderQty ?? d.orderQty ?? 1, autoTopCharts: s.config.autoTopCharts !== false}
          : {...s.config, tradeByCode: s.config.tradeByCode || {}},
      );
    } catch {
      setNotice('서버에 연결할 수 없습니다.');
    }
  };

  useEffect(() => {
    void load();
    void post('/api/conditions').then(() => load()).catch(() => {});
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void fetch('/api/desks')
      .then((r) => r.json())
      .then((data) => setWorkspace(validateWorkspace(data)))
      .catch(() => setWorkspace(defaultWorkspace()));
  }, []);

  const persist = useCallback((next: DeskWorkspace) => {
    setWorkspace(next);
    workspaceRef.current = next;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void put('/api/desks', workspaceRef.current).catch((e) => setNotice((e as Error).message));
    }, 80);
  }, []);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void put('/api/desks', workspaceRef.current).catch(() => {});
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 8 && workspace.desks.some((d) => d.number === n)) {
        e.preventDefault();
        persist({...workspaceRef.current, active: n});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspace, persist]);

  const desk = activeDesk(workspace);
  const updateDesk = (next: VirtualDesk) => persist(replaceDesk(workspaceRef.current, next));
  const deskOf = (winId: string) =>
    workspaceRef.current.desks.find((d) => d.windows.some((w) => w.id === winId)) || activeDesk(workspaceRef.current);

  const addWindow = (kind: WindowKind) => {
    if (kind === 'logs') {
      try {
        persist(placeGlobalLog(workspace, desk.number));
      } catch (e) {
        setNotice((e as Error).message);
      }
      return;
    }
    updateDesk(insertWindow(desk, kind));
  };
  const addDesk = () => {
    try {
      const created = createDesk(workspace.desks);
      persist({active: created.number, desks: [...workspace.desks, created].sort((a, b) => a.number - b.number)});
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const deleteDesk = () => {
    if (workspace.desks.length === 1) {
      setNotice('마지막 가상화면은 삭제할 수 없습니다.');
      return;
    }
    const desks = workspace.desks.filter((item) => item.id !== desk.id);
    persist({active: desks[0].number, desks});
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const session = drag.current;
      if (!session) return;
      const current = activeDesk(workspace);
      const win = current.windows.find((w) => w.id === session.id);
      if (!win || win.state !== 'normal') return;
      if (session.mode === 'move') {
        setWorkspace(replaceDesk({...workspace, active: current.number}, patchWindow(current, session.id, {x: Math.max(0, e.clientX - session.dx), y: Math.max(0, e.clientY - session.dy)})));
      } else {
        setWorkspace(replaceDesk({...workspace, active: current.number}, patchWindow(current, session.id, {w: Math.max(280, e.clientX - win.x), h: Math.max(180, e.clientY - win.y)})));
      }
    };
    const up = () => {
      drag.current = null;
      persist(workspaceRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [workspace]);

  if (!state || !draft) return <div className="loading">가상 데스크를 준비하고 있습니다...</div>;

  const chartCodes = state.config.chartCodes || [];
  const selected = chartCodes
    .map((code) => state.ranking.find((s) => s.code === code) || {code, name: code, price: 0, change: 0, strength: 0, value: 0, score: 0})
    .filter((s) => s.code);
  const update = async (patch: Partial<Config> = {}) => {
    try {
      const next = {...draft, refreshMs: draft.refreshMs || 60000, chartCodes: draft.chartCodes || [], ...patch};
      await post('/api/config', next);
      setDraft(next);
      setNotice('설정이 적용되었습니다.');
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const toggleChart = async (code: string) => {
    const on = chartCodes.includes(code);
    if (!on && chartCodes.length >= MULTI_CHART_MAX) {
      setNotice(`멀티차트는 최대 ${MULTI_CHART_MAX}종목입니다.`);
      return;
    }
    try {
      await post('/api/charts', {codes: on ? chartCodes.filter((c) => c !== code) : [...chartCodes, code]});
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const applyCode = (code: string, strategyId = desk.vars.strategyId) => {
    try {
      updateDesk(syncVars(desk, {code, name: desk.vars.name, strategyId}));
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const systems = state.formulas.filter((f) => f.kind === 'system');
  const setTrade = async (code: string, status: 'wait' | 'run' | 'stop' | 'backtest') => {
    try {
      await post('/api/trade', {code, status});
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const setStrategy = async (formulaId: string, code?: string) => {
    try {
      await post('/api/strategy', {formulaId, code});
      if (!code) applyCode(desk.vars.code, formulaId);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const formulasFor = (code: string) => {
    const id = (state.config.strategyByCode || {})[code] || state.config.strategyId || systems.find((f) => f.enabled)?.id || '';
    return state.formulas.map((f) => (f.kind === 'system' ? {...f, enabled: f.id === id} : f));
  };


  return (
    <div className="hts">
      <header className="hts-bar">
        <div className="hts-brand">KIWOOM <span>VIRTUAL DESK</span></div>
        <div className="desk-tabs">
          {workspace.desks.map((item) => (
            <button key={item.id} className={item.number === desk.number ? 'on' : ''} onClick={() => persist({...workspaceRef.current, active: item.number})}>
              {item.number}
            </button>
          ))}
        </div>
        <button className="hts-tool" onClick={addDesk}>화면 추가</button>
        <button
          className="hts-tool"
          onClick={() => {
            const name = window.prompt('가상화면 이름', desk.name);
            if (name) updateDesk(renameDesk(desk, name));
          }}
        >
          이름
        </button>
        <button className="hts-tool danger" onClick={deleteDesk}>
          삭제
        </button>
        <span className="hts-sep" />
        {TOOLS.map((tool) => (
          <button key={tool.kind} className="hts-tool" onClick={() => addWindow(tool.kind)}>
            {tool.label}
          </button>
        ))}
        <button className="hts-tool" onClick={() => setShowSysTrade(true)}>
          시스템트레이딩
        </button>
        <button className="hts-tool" onClick={() => setShowFormulas(true)}>
          수식 관리자
        </button>
        <button className="hts-tool" onClick={() => setShowPine(true)}>
          파인 이식
        </button>
        <span className="hts-sep" />
        <label className="hts-var">
          공통 종목
          <CommonCode value={desk.vars.code} onCommit={(code) => applyCode(code)} />
        </label>
        <label className="hts-var">
          공통 전략
          <select
            value={desk.vars.strategyId || state.config.strategyId || ''}
            onChange={(e) => {
              void setStrategy(e.target.value);
              setShowSysTrade(true);
            }}
          >
            <option value="">선택</option>
            {systems.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <span className="hts-desk-name">{desk.number}. {desk.name}</span>
        <span className={'wss-pill ' + (state.realtime?.hub.link || (state.realtime?.hub.state === 'ready' ? 'ok' : 'dead'))} title={state.realtime?.hub.lastError || '중앙관리자 실시간(WSS)'}>
          <i />
          {state.realtime?.hub.link === 'ok'
            ? 'WSS 수신'
            : state.realtime?.hub.link === 'warn'
              ? 'WSS 지연'
              : 'WSS 끊김'}
          {typeof state.realtime?.hub.silentMs === 'number' ? ` ${Math.round(state.realtime.hub.silentMs / 1000)}초` : ''}
        </span>
        <span className="hts-lights" title="중앙 관리자 신호등">
          <i className={state.realtime?.hub.link === 'ok' ? 'go' : state.realtime?.hub.link === 'warn' ? 'wait' : 'stop'} title={`실시간 ${state.realtime?.hub.state || '없음'}`} />
          <i className={state.busy || !state.config.condition ? 'wait' : 'go'} title={state.config.condition ? '조건검색' : '조건식 없음'} />
          <i className={state.risk?.blocked ? 'stop' : state.config.running ? 'go' : 'wait'} title={state.config.running ? '모의매매' : '대기'} />
        </span>
        <span className={'mode' + (state.config.running ? ' trading' : '')}>
          <i /> {state.config.running ? '자동매매 중' : state.mode === 'mock' ? '모의 조회·주문' : '실전 조회(주문 없음)'}
        </span>
        <button type="button" className={'hts-tool' + (state.mode === 'mock' ? ' on' : '')} title="모의투자 API. 15:30 이후 체결강도가 없으면 실계좌와 비교하세요." onClick={() => { setNotice('모의계좌 인증 중…'); void post('/api/host', {mode: 'mock'}).then(() => load()).then(() => setNotice('모의계좌 인증 완료')).catch((e) => setNotice((e as Error).message)); }}>
          모의계좌 인증
        </button>
        <button type="button" className={'hts-tool' + (state.mode === 'real' ? ' on' : '')} title="실전 API. 조회만 하며 실전 주문은 보내지 않습니다." onClick={() => { setNotice('실계좌 인증 중…'); void post('/api/host', {mode: 'real'}).then(() => load()).then(() => setNotice('실계좌 인증 완료')).catch((e) => setNotice((e as Error).message)); }}>
          실계좌 인증
        </button>
      </header>
      <div className="hts-workspace">
        {workspace.desks.map((d) => (
          <div
            key={d.id}
            className="hts-desk-layer"
            style={{
              visibility: d.number === desk.number ? 'visible' : 'hidden',
              pointerEvents: d.number === desk.number ? 'auto' : 'none',
              zIndex: d.number === desk.number ? 1 : 0,
            }}
          >
            {d.windows
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((win) => (
                <ChildFrame
                  key={win.id}
                  win={win}
                  desks={workspace.desks}
                  deskNumber={d.number}
                  onMove={(n) => {
                    try {
                      persist(moveWindow(workspaceRef.current, win.id, n));
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                  onFocus={() => updateDesk(focusWindow(deskOf(win.id), win.id))}
                  onClose={() => updateDesk(removeWindow(deskOf(win.id), win.id))}
                  onLock={() => updateDesk(toggleLock(deskOf(win.id), win.id))}
                  onState={(st) => updateDesk(setWindowState(deskOf(win.id), win.id, st))}
                  onDrag={(e, mode) => {
                    updateDesk(focusWindow(deskOf(win.id), win.id));
                    drag.current = {id: win.id, dx: e.clientX - win.x, dy: e.clientY - win.y, mode};
                  }}
                >
                  <Pane
                    win={win}
                    desk={d}
                    state={state}
                    draft={draft}
                    setDraft={setDraft}
                    selected={selected}
                    chartCodes={chartCodes}
                    grid={grid}
                    logScale={logScale}
                    chartHeight={chartHeight}
                    setGrid={setGrid}
                    setLogScale={setLogScale}
                    setChartHeight={setChartHeight}
                    update={update}
                    toggleChart={toggleChart}
                    load={load}
                    setNotice={setNotice}
                    setShowFormulas={setShowFormulas}
                    setShowSysTrade={setShowSysTrade}
                    setStrategy={setStrategy}
                    setTrade={setTrade}
                    formulasFor={formulasFor}
                    systems={systems}
                    patchWin={(id, patch) => updateDesk(patchWindow(deskOf(id), id, patch))}
                    onCommonCode={applyCode}
                    active={d.number === desk.number}
                  />
                </ChildFrame>
              ))}
          </div>
        ))}
        {desk.windows.length === 0 && (
          <div className="hts-empty">
            툴바에서 차트·멀티차트·조건검색·TR 창을 이 가상화면({desk.number})에 넣으세요. Ctrl+1~8로 화면을 바꿉니다.
          </div>
        )}
        <div className="hts-taskbar">
          {desk.windows
            .filter((w) => w.state === 'minimized')
            .map((w) => (
              <button key={w.id} onClick={() => updateDesk(setWindowState(desk, w.id, 'normal'))}>
                {w.title}
              </button>
            ))}
        </div>
      </div>
      {state.realtime?.hub.emergency && (
        <div className="wss-emergency">
          <div>
            <b>실시간(WSS) 수신 중단</b>
            <p>
              중앙관리자가 {Math.round((state.realtime.hub.warnAfterMs || 30000) / 1000)}초 이상 시세를 받지 못했습니다.
              {state.realtime.hub.lastError ? ` (${state.realtime.hub.lastError})` : ''} 차트·신호는 멈춘 상태입니다. 앱을 다시 시작하세요.
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              앱 다시 시작
            </button>
          </div>
        </div>
      )}
      {(notice || state.error) && (
        <div className="notice" onClick={() => setNotice('')}>
          {notice || state.error} ×
        </div>
      )}
      {showSysTrade && draft && (
        <SystemTradePanel
          state={state}
          draft={draft}
          setDraft={setDraft}
          systems={systems}
          update={update}
          onDesign={() => {
            setShowSysTrade(false);
            setShowFormulas(true);
          }}
          onClose={() => setShowSysTrade(false)}
        />
      )}
      {showFormulas && (
        <FormulaManager
          formulas={state.formulas}
          candles={state.candles[selected[0]?.code] || []}
          onClose={() => setShowFormulas(false)}
          onSaved={load}
        />
      )}
      {showPine && <PineImport formulas={state.formulas} onClose={() => setShowPine(false)} onSaved={load} />}
    </div>
  );
}

function ChildFrame({
  win,
  children,
  desks,
  deskNumber,
  onMove,
  onFocus,
  onClose,
  onLock,
  onState,
  onDrag,
}: {
  win: ChildWindow;
  children: React.ReactNode;
  desks: {number: number; name: string}[];
  deskNumber: number;
  onMove: (n: number) => void;
  onFocus: () => void;
  onClose: () => void;
  onLock: () => void;
  onState: (state: ChildWindow['state']) => void;
  onDrag: (e: React.MouseEvent, mode: 'move' | 'resize') => void;
}) {
  if (win.state === 'minimized') return null;
  const maximized = win.state === 'maximized';
  const style: React.CSSProperties = maximized
    ? {left: 0, top: 0, width: '100%', height: '100%', zIndex: 900 + win.z}
    : {left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 10 + win.z};
  return (
    <div className={'child-win' + (maximized ? ' max' : '') + (win.locked ? ' locked' : '')} style={style} onMouseDown={onFocus}>
      <div className="child-title" onMouseDown={(e) => !maximized && onDrag(e, 'move')}>
        <b>
          {win.title}
          {win.code ? ` · ${win.code}` : ''}
        </b>
        <span>
          <select
            title="다른 가상화면으로 이동"
            value={deskNumber}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => onMove(Number(e.target.value))}
          >
            {desks.map((d) => (
              <option key={d.number} value={d.number}>{d.number}</option>
            ))}
          </select>
          <button title={win.locked ? '잠금 해제' : '공통변수 잠금'} onClick={onLock}>
            {win.locked ? '잠김' : '풀림'}
          </button>
          <button title="최소화" onClick={() => onState('minimized')}>
            —
          </button>
          <button title={maximized ? '원복' : '최대화'} onClick={() => onState(maximized ? 'normal' : 'maximized')}>
            {maximized ? '❐' : '□'}
          </button>
          <button title="삭제" className="close" onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      <div className={'child-body' + (win.kind === 'chart' || win.kind === 'multi-chart' ? ' fill-chart' : '')}>{children}</div>
      {!maximized && <div className="child-resize" onMouseDown={(e) => onDrag(e, 'resize')} />}
    </div>
  );
}

function Pane(props: {
  win: ChildWindow;
  desk: VirtualDesk;
  state: State;
  draft: Config;
  setDraft: React.Dispatch<React.SetStateAction<Config | null>>;
  selected: Stock[];
  chartCodes: string[];
  grid: boolean;
  logScale: boolean;
  chartHeight: number;
  setGrid: (v: boolean) => void;
  setLogScale: (v: boolean) => void;
  setChartHeight: (v: number) => void;
  update: (patch?: Partial<Config>) => Promise<void>;
  toggleChart: (code: string) => Promise<void>;
  load: () => Promise<void>;
  setNotice: (v: string) => void;
  setShowFormulas: (v: boolean) => void;
  setShowSysTrade: (v: boolean) => void;
  setStrategy: (formulaId: string, code?: string) => Promise<void>;
  setTrade: (code: string, status: 'wait' | 'run' | 'stop' | 'backtest') => Promise<void>;
  formulasFor: (code: string) => Formula[];
  systems: Formula[];
  patchWin: (id: string, patch: Partial<ChildWindow>) => void;
  onCommonCode: (code: string) => void;
  active?: boolean;
}) {
  const {win, state, draft, selected, chartCodes} = props;
  const code = win.locked ? win.code || '' : props.desk.vars.code || win.code || '';
  const strategySelect = (forCode: string) => (
    <select
      className="strategy-select"
      value={(state.config.strategyByCode || {})[forCode] || state.config.strategyId || ''}
      onChange={(e) => void props.setStrategy(e.target.value, forCode)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <option value="">전략 없음</option>
      {props.systems.map((f) => (
        <option key={f.id} value={f.id}>{f.name}</option>
      ))}
    </select>
  );
  if (win.kind === 'chart') {
    return (
      <ChartPane
        win={win}
        desk={props.desk}
        formulas={state.formulas}
        rankingName={state.ranking.find((s) => s.code === code)?.name}
        cached={
          state.candles[`${code}|${win.timeframe || '1'}|${win.baseDate || ''}`] ||
          state.candles[code] ||
          []
        }
        grid={props.grid}
        logScale={props.logScale}
        patchWin={(patch) => props.patchWin(win.id, patch)}
        setNotice={props.setNotice}
        onReload={props.load}
        onCommonCode={props.onCommonCode}
        wssLink={state.realtime?.hub.link}
        active={props.active !== false}
        patternFilters={state.config.patternFilters}
        delayContext={{
          skip001N: state.config.skip001N ?? 1.2,
          skip001Score: state.patternKpi?.summaries.find((s) => s.filterId === 'skip001' || s.filterId === 'delayed-buy')?.score ?? 50,
          indexRet: state.market?.indexRet,
          ma120Slope: state.market?.ma120Slope,
        }}
      />
    );
  }
  if (win.kind === 'multi-chart') {
    const cols = Math.min(4, Math.max(1, win.gridCols || (selected.length <= 1 ? 1 : selected.length <= 4 ? 2 : 3)));
    const rows = Math.max(1, Math.ceil(Math.max(selected.length, 1) / cols));
    const cellH = Math.max(110, Math.floor(((win.h || 480) - 36) / rows) - 26);
    const tf = win.timeframe || '1';
    return (
      <div className="pane-multi">
        <div className="chart-toolbar" onMouseDown={(e) => e.stopPropagation()}>
          <select value={String(cols)} onChange={(e) => props.patchWin(win.id, {gridCols: Number(e.target.value)})} title="화면 분할">
            <option value={1}>1화면</option>
            <option value={2}>2×n</option>
            <option value={3}>3×n (최대 {MULTI_CHART_MAX})</option>
            <option value={4}>4×n (최대 {MULTI_CHART_MAX})</option>
          </select>
          <select value={tf} onChange={(e) => props.patchWin(win.id, {timeframe: e.target.value})} title="공통 주기">
            {['1', '3', '5', '10', '15', '30', '60', 'D'].map((id) => (
              <option key={id} value={id}>
                {id === 'D' ? '일봉' : `${id}분`}
              </option>
            ))}
          </select>
          <select
            value={state.config.strategyId || ''}
            onChange={(e) => {
              void props.setStrategy(e.target.value);
              props.setShowSysTrade(true);
            }}
            title="공통 전략 · 시스템트레이딩 설정"
          >
            <option value="">전략 없음</option>
            {props.systems.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button className="hts-tool" onClick={() => props.setShowSysTrade(true)}>시스템트레이딩</button>
          <select value={draft?.condition || ''} onChange={(e) => props.setDraft({...draft, condition: e.target.value})} title="조건식">
            <option value="">조건식</option>
            {state.conditions.map((c) => (
              <option key={c.seq} value={c.seq}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="hts-tool" disabled={!draft?.condition} onClick={() => void props.update({condition: draft.condition})}>
            실행
          </button>
          <button
            className="hts-tool"
            disabled={!state.captured?.length}
            onClick={() => {
              const extra = (state.captured || []).map((r) => r.code).filter((c) => !chartCodes.includes(c));
              const merged = [...chartCodes, ...extra].slice(0, MULTI_CHART_MAX);
              void post('/api/charts', {codes: merged}).then(() => props.load());
            }}
          >
            포착넣기({MULTI_CHART_MAX})
          </button>
          <button className="hts-tool" onClick={() => props.setShowFormulas(true)}>
            수식
          </button>
          <button
            className={'hts-tool' + (win.syncCharts !== false ? ' on' : '')}
            title="주기·봉수·수식을 모든 칸에 맞춤"
            onClick={() => {
              props.patchWin(win.id, {syncCharts: true});
              if (state.config.strategyId) void props.setStrategy(state.config.strategyId);
              for (const s of selected) void props.setTrade(s.code, 'run');
            }}
          >
            {win.syncCharts === false ? '동기화꺼짐' : '동기화'}
          </button>
        </div>
        <div className="chart-grid multi-grid" style={{gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`}}>
          {selected.map((s) => (
            <article
              className={'chart-card mini' + (code === s.code ? ' current' : '')}
              key={s.code}
              onClick={() => props.onCommonCode(s.code)}
            >
              <div className="cell-head">
                <b>{s.name || s.code}</b>
                <span className="stock-code">{s.code}</span>
                <span className="cell-px">
                  {fmt(s.price)}{' '}
                  <em className={s.change >= 0 ? 'positive' : 'negative'}>
                    {s.change >= 0 ? '+' : ''}
                    {s.change.toFixed(2)}%
                  </em>
                </span>
                {(() => {
                  const st = (state.config.tradeByCode || {})[s.code] || 'wait';
                  const inPos = (state.book?.holdings || []).some((h) => h.code === s.code);
                  const label = inPos ? '매매중' : st === 'run' ? '적용' : st === 'backtest' ? '백테스트' : '대기';
                  const next = st === 'wait' || st === 'stop' ? 'run' : st === 'run' ? 'backtest' : 'wait';
                  return (
                    <button
                      className={'trade-tag ' + (inPos ? 'run' : st === 'run' ? 'run' : st === 'backtest' ? 'backtest' : 'wait')}
                      title="클릭: 대기 → 적용(자동매매) → 백테스트"
                      onClick={(e) => {
                        e.stopPropagation();
                        void props.setTrade(s.code, next);
                      }}
                    >
                      {label}
                    </button>
                  );
                })()}
                <button
                  className={'hts-tool' + ((state.config.lockedCodes || []).includes(s.code) || (state.book?.holdings || []).some((h) => h.code === s.code) ? ' on' : '')}
                  title="종목 잠금. 매매·미체결 중이면 순위에서 바뀌지 않습니다."
                  onClick={(e) => {
                    e.stopPropagation();
                    const on = !((state.config.lockedCodes || []).includes(s.code));
                    void post('/api/lock', {code: s.code, locked: on}).then(() => props.load()).catch((err) => props.setNotice((err as Error).message));
                  }}
                >
                  {(state.config.lockedCodes || []).includes(s.code) || (state.book?.holdings || []).some((h) => h.code === s.code) ? '잠김' : '풀림'}
                </button>
                <button
                  className="hts-tool"
                  title="시장 매수"
                  onClick={(e) => {
                    e.stopPropagation();
                    void post('/api/book/buy', {code: s.code, type: 'market'}).then(() => props.load()).catch((err) => props.setNotice((err as Error).message));
                  }}
                >
                  매수
                </button>
                <button
                  className="hts-tool"
                  title="시장 매도"
                  onClick={(e) => {
                    e.stopPropagation();
                    void post('/api/book/sell', {code: s.code, type: 'market'}).then(() => props.load()).catch((err) => props.setNotice((err as Error).message));
                  }}
                >
                  매도
                </button>
                <button
                  className="cell-x"
                  title="제외"
                  onClick={(e) => {
                    e.stopPropagation();
                    void props.toggleChart(s.code);
                  }}
                >
                  ×
                </button>
              </div>
              <StockMiniChart
                code={s.code}
                lastPrice={s.price}
                cached={state.candles[s.code] || []}
                formulas={props.formulasFor(s.code)}
                height={cellH}
                grid={props.grid}
                logScale={props.logScale}
                timeframe={tf}
                visibleHint={win.visibleBars || 200}
                onContext={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const st = (state.config.tradeByCode || {})[s.code] || 'wait';
                  const next = st === 'wait' ? 'run' : st === 'run' ? 'stop' : 'wait';
                  void props.setTrade(s.code, next);
                }}
              />
            </article>
          ))}
          {selected.length === 0 && <div className="empty">조건식 실행 후 포착넣기, 또는 조건검색에서 종목을 체크하세요.</div>}
        </div>
      </div>
    );
  }
  if (win.kind === 'scanner') return <ScannerPane {...props} />;
  if (win.kind === 'search150') return <Search150Pane setNotice={props.setNotice} onCode={props.onCommonCode} />;

  if (win.kind === 'captures') return <CapturesPane state={state} draft={draft} setDraft={props.setDraft} update={props.update} onCode={props.onCommonCode} toggleChart={props.toggleChart} chartCodes={chartCodes} />;
  if (win.kind === 'tr') return <TrPane code={code} />;
  if (win.kind === 'verify') {
    return <VerifyPane state={state} draft={draft} update={props.update} load={props.load} chartCodes={chartCodes} selected={selected} setNotice={props.setNotice} onCode={props.onCommonCode} />;
  }
  if (win.kind === 'book') return <BookPane state={state} load={props.load} setNotice={props.setNotice} />;
  if (win.kind === 'logs') return <LogsPane />;
  return (
    <div className="activity">
      {state.events.length ? (
        state.events.slice(0, 20).map((e, i) => (
          <div key={i}>
            {new Date(e.time).toLocaleTimeString('ko-KR')} {e.code} <b>{e.side}</b> {fmt(e.price)}원
          </div>
        ))
      ) : (
        <div className="empty-activity">모의 이벤트가 없습니다. 실제 주문은 전송되지 않습니다.</div>
      )}
    </div>
  );
}

function StockMiniChart({
  code,
  lastPrice,
  cached,
  formulas,
  height,
  grid,
  logScale,
  timeframe = '1',
  visibleHint,
  onContext,
}: {
  code: string;
  lastPrice?: number;
  cached: Candle[];
  formulas: Formula[];
  height: number;
  grid: boolean;
  logScale: boolean;
  timeframe?: string;
  visibleHint?: number;
  onContext?: (e: React.MouseEvent) => void;
}) {
  const [bars, setBars] = useState<Candle[]>(cached);
  const [wait, setWait] = useState(!cached.length);
  useEffect(() => {
    if (cached.length) {
      setBars(cached);
      setWait(false);
    }
  }, [cached]);
  useEffect(() => {
    if (!(lastPrice && lastPrice > 0)) return;
    setBars((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      if (last.close === lastPrice) return prev;
      const next = prev.slice();
      next[next.length - 1] = {...last, close: lastPrice, high: Math.max(last.high, lastPrice), low: Math.min(last.low, lastPrice)};
      return next;
    });
  }, [lastPrice]);
  useEffect(() => {
    if (!/^\d{6}$/.test(code)) return;
    if (bars.length) {
      setWait(false);
      return;
    }
    let stop = false;
    if (!cached.length) setWait(true);
    void queuedChart(code, timeframe, false)
      .then((d) => {
        if (!stop && d.candles?.length) {
          setBars(d.candles);
          setWait(false);
        } else if (!stop) setWait(false);
      })
      .catch(() => {
        if (!stop) setWait(false);
      });
    return () => {
      stop = true;
    };
  }, [code, timeframe]);
  if (!bars.length) return <div className="empty-chart">{wait ? '분봉 조회 대기(중앙 큐)…' : '분봉 없음. 한도 해제 후 다시 포착넣기.'}</div>;
  return (
    <Chart
      data={bars}
      formulas={formulas}
      chartHeight={height}
      grid={grid}
      logScale={logScale}
      visibleHint={visibleHint}
      onContextMenu={onContext}
      patternFilters={undefined}
    />
  );
}

function pct(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function VerifyPane({
  state,
  draft,
  update,
  load,
  chartCodes,
  selected,
  setNotice,
  onCode,
}: {
  state: State;
  draft: Config;
  update: (patch?: Partial<Config>) => Promise<void>;
  load: () => Promise<void>;
  chartCodes: string[];
  selected: Stock[];
  setNotice: (v: string) => void;
  onCode: (code: string) => void;
}) {
  const formulas = state.formulas.filter((f) => f.kind === 'signal' || f.kind === 'system');
  const [formulaId, setFormulaId] = useState('');
  const [conditionSeq, setConditionSeq] = useState(state.config.condition || '');
  const [localConds, setLocalConds] = useState<SavedCondition[]>([]);
  const [localConditionId, setLocalConditionId] = useState('');
  useEffect(() => {
    void fetch('/api/local-conditions').then((r) => r.json()).then((d) => {
      if (Array.isArray(d.saved)) {
        setLocalConds(d.saved);
        setLocalConditionId((id) => id || d.saved[0]?.id || '');
      }
    }).catch(() => {});
  }, []);
  const [searchDate, setSearchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [searchTime, setSearchTime] = useState('09:10');
  const [minute, setMinute] = useState(false);
  const [holdMinutes, setHoldMinutes] = useState(5);
  const [customMin, setCustomMin] = useState(10);
  const [minVolume, setMinVolume] = useState(0);
  const [minEok, setMinEok] = useState(0);
  const [maxEok, setMaxEok] = useState(0);
  const [listedOnly, setListedOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<'code' | 'name' | 'max' | 'vol' | string>('max');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [result, setResult] = useState<null | {
    formula: string;
    searchDate: string;
    searchTime: string;
    holdLabel: string;
    holdMinutes: number;
    extraCols: number[];
    matched: number;
    upCount: number;
    flatCount: number;
    downCount: number;
    upRatio: number | null;
    avgReturn: number | null;
    universe: number;
    rows: {code: string; name: string; returnPct: number | null; maxReturnPct: number | null; volume?: number; returns: Record<string, number | null>}[];
  }>(null);
  const codes = (
    state.captured?.length
      ? state.captured.map((s) => s.code)
      : chartCodes.length
        ? chartCodes
        : selected.length
          ? selected.map((s) => s.code)
          : state.ranking.map((s) => s.code)
  ).slice(0, 16);
  const condName = state.conditions.find((c) => c.seq === conditionSeq)?.name || '';
  const run = async () => {
    if (!localConditionId && !codes.length) return setNotice('로컬 0150 조건식을 고르거나, 조건검색 포착 종목을 넣으세요.');
    setBusy(true);
    try {
      const d = await post('/api/verify', {
        formulaId: formulaId || undefined,
        localConditionId: localConditionId || undefined,
        conditionName: condName || localConds.find((c) => c.id === localConditionId)?.name,
        searchDate,
        searchTime,
        minute,
        holdMinutes: holdMinutes === 0 ? customMin : holdMinutes,
        codes: localConditionId ? [] : codes,
        minVolume,
        minMarketCap: minEok > 0 ? minEok * 1e8 : 0,
        maxMarketCap: maxEok > 0 ? maxEok * 1e8 : 0,
        listedOnly,
      });
      setResult(d);
      setPicked([]);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cols = result?.extraCols?.length ? result.extraCols : minute ? [10, 30, holdMinutes || customMin] : [1, 5, holdMinutes || customMin];
  const toggle = (code: string) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : p.length >= 4 ? p : [...p, code]));
  const nameOf = (code: string, fallback: string) => {
    const n = state.ranking.find((s) => s.code === code)?.name;
    return n && n !== code ? n : fallback && fallback !== code ? fallback : code;
  };
  const clickSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'code' ? 1 : -1);
    }
  };
  const sortedRows = [...(result?.rows || [])].sort((a, b) => {
    const dir = sortDir;
    const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? -Infinity * dir : v);
    if (sortKey === 'code') return dir * a.code.localeCompare(b.code);
    if (sortKey === 'name') return dir * nameOf(a.code, a.name).localeCompare(nameOf(b.code, b.name), 'ko');
    if (sortKey === 'max') return dir * (num(a.maxReturnPct) - num(b.maxReturnPct));
    if (sortKey === 'vol') return dir * (num(a.volume) - num(b.volume));
    const col = Number(sortKey);
    if (Number.isFinite(col)) {
      const va = a.returns?.[String(col)] ?? a.returnPct;
      const vb = b.returns?.[String(col)] ?? b.returnPct;
      return dir * (num(va) - num(vb));
    }
    return 0;
  });
  const searchAt = result ? parseSearchAt(result.searchDate, minute ? result.searchTime : '15:30') : 0;
  return (
    <div className="verify-1516">
      <div className="v16-banner">
        <b>성과 검증이란?</b> 작성한 조건식이 시장대비 초과수익을 달성하는 우수한 조건식인지 검증합니다.
      </div>
      <div className="v16-grid">
        <div className="v16-left">
          <h4>성과 검증 시작하기</h4>
          <div className="v16-row">
            <span>조건</span>
            <select value={conditionSeq} onChange={(e) => setConditionSeq(e.target.value)}>
              <option value="">키움 조건식</option>
              {state.conditions.map((c) => (
                <option key={c.seq} value={c.seq}>{c.name}</option>
              ))}
            </select>
            <button type="button" onClick={async () => { try { await post('/api/conditions'); await load(); setNotice('서버 조건식 목록을 불러왔습니다.'); } catch (e) { setNotice((e as Error).message); } }}>목록</button>
            <button type="button" disabled={!conditionSeq || state.busy} onClick={() => void update({condition: conditionSeq})}>포착</button>
            <select value={localConditionId} onChange={(e) => {
              const id = e.target.value;
              setLocalConditionId(id);
              setFormulaId('');
              const s = localConds.find((c) => c.id === id);
              if (s?.timeframe) {
                setMinute(s.timeframe === '1');
                setHoldMinutes(s.timeframe === '1' ? 420 : 5);
              }
            }}>
              <option value="">로컬 0150</option>
              {localConds.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.timeframe === '1' ? ' (분)' : ' (일)'}</option>
              ))}
            </select>
            <select value={formulaId} onChange={(e) => { setFormulaId(e.target.value); if (e.target.value) setLocalConditionId(''); }}>
              <option value="">수식(신호)</option>
              {formulas.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <p className="v16-target">{localConditionId ? `로컬 조건식 · ${minute ? '분봉' : '일봉'} 전종목 검색` : `대상 ${codes.length}종목`} · {minute ? '분단위 검증' : '일단위 검증'}</p>
          <div className="v16-row">
            <span>검색시점</span>
            <input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} />
            {minute && <input type="time" value={searchTime} onChange={(e) => setSearchTime(e.target.value)} />}
            <label className="v16-check">
              <input type="checkbox" checked={minute} onChange={(e) => {
                const on = e.target.checked;
                setMinute(on);
                setHoldMinutes(on ? 420 : 5);
                setCustomMin(on ? 50 : 10);
              }} /> 분단위 검증
            </label>
          </div>
          <div className="v16-holds">
            <span>수익률기간</span>
            {(minute ? HOLD_PRESETS : DAY_HOLD_PRESETS).map((p) => (
              <button key={p.id} className={holdMinutes === p.id ? 'on' : ''} onClick={() => setHoldMinutes(p.id)}>{p.label}</button>
            ))}
            <button className={holdMinutes === 0 ? 'on' : ''} onClick={() => setHoldMinutes(0)}>기타</button>
            {holdMinutes === 0 && <input type="number" min={1} max={minute ? 2000 : 400} value={customMin} onChange={(e) => setCustomMin(Number(e.target.value) || 1)} />}
          </div>
          <div className="v16-row">
            <span>거르기</span>
            <label className="v16-check"><input type="checkbox" checked={listedOnly} onChange={(e) => setListedOnly(e.target.checked)} /> 검색일 봉 없는 종목 제외(상폐·정지 근사)</label>
          </div>
          <div className="v16-row">
            <span>거래량≥</span>
            <input type="number" min={0} value={minVolume} onChange={(e) => setMinVolume(Number(e.target.value) || 0)} />
            <span>시총억≥</span>
            <input type="number" min={0} value={minEok} onChange={(e) => setMinEok(Number(e.target.value) || 0)} />
            <span>≤</span>
            <input type="number" min={0} value={maxEok} onChange={(e) => setMaxEok(Number(e.target.value) || 0)} />
          </div>
          <button className="v16-run" disabled={busy} onClick={() => void run()}>{busy ? '검증 중…' : '성과 검증하기'}</button>
          <h4>성과 검증 결과</h4>
          {result ? (
            <>
              <p className="v16-summary">
                선택한 조건식을 {result.searchDate.replace(/-/g, '/')} {result.searchTime} 에 적용하여 검색된 종목을 {result.holdLabel} 간 보유시, 검색된종목 기간수익률은{' '}
                <b className={(result.avgReturn || 0) < 0 ? 'negative' : 'positive'}>{pct(result.avgReturn)}</b> 입니다. 코스피·코스닥 대비 수익률은 지수 REST가 없어 표시하지 않습니다.
              </p>
              <table className="v16-table">
                <thead><tr><th>시장별 종목비율</th><th>전체</th><th>상승</th><th>보합</th><th>하락</th><th>상승종목비율</th></tr></thead>
                <tbody>
                  <tr>
                    <td>전체({result.matched}종목)</td>
                    <td>{result.matched}</td>
                    <td>{result.upCount}</td>
                    <td>{result.flatCount}</td>
                    <td>{result.downCount}</td>
                    <td>{result.upRatio == null ? '—' : `${result.upRatio.toFixed(0)}%`}</td>
                  </tr>
                </tbody>
              </table>
              <table className="v16-table">
                <thead><tr><th>기간 수익률</th><th>검색된종목</th></tr></thead>
                <tbody>
                  <tr>
                    <td>{result.holdLabel}</td>
                    <td className={(result.avgReturn || 0) < 0 ? 'negative' : 'positive'}>{pct(result.avgReturn)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : <p className="empty">성과 검증하기를 실행하세요.</p>}
        </div>
        <div className="v16-right">
          <h4>검증결과 상세</h4>
          <p className="v16-detail-head">
            {result ? `${result.searchDate.replace(/-/g, '/')} ${result.searchTime} 시점에 해당조건으로 총 ${result.matched} 개의 종목이 검색되었습니다.` : '아직 검증하지 않았습니다.'}
          </p>
          <div className="v16-list">
            <div className="v16-list-head">
              <span />
              <button type="button" onClick={() => clickSort('code')}>종목코드{sortKey === 'code' ? (sortDir > 0 ? '▲' : '▼') : ''}</button>
              <button type="button" onClick={() => clickSort('name')}>종목명{sortKey === 'name' ? (sortDir > 0 ? '▲' : '▼') : ''}</button>
              {cols.map((m) => (
                <button key={m} type="button" onClick={() => clickSort(String(m))}>
                  {(minute ? HOLD_PRESETS : DAY_HOLD_PRESETS).find((p) => p.id === m)?.label || (minute ? `${m}분간` : `${m}일`)}
                  {sortKey === String(m) ? (sortDir > 0 ? '▲' : '▼') : ''}
                </button>
              ))}
              <button type="button" onClick={() => clickSort('max')}>기간 내 최고수익률{sortKey === 'max' ? (sortDir > 0 ? '▲' : '▼') : ''}</button>
              <button type="button" onClick={() => clickSort('vol')}>검색시점 거래량{sortKey === 'vol' ? (sortDir > 0 ? '▲' : '▼') : ''}</button>
            </div>
            {sortedRows.map((r) => (
              <div key={r.code} className={'v16-list-row' + (picked.includes(r.code) ? ' on' : '')}>
                <input type="checkbox" checked={picked.includes(r.code)} onChange={() => toggle(r.code)} />
                <span>{r.code}</span>
                <button type="button" onClick={() => onCode(r.code)}>{nameOf(r.code, r.name)}</button>
                {cols.map((m) => {
                  const v = r.returns?.[String(m)] ?? (m === (result?.holdMinutes || 0) ? r.returnPct : null);
                  return <span key={m} className={(v || 0) < 0 ? 'negative' : (v || 0) > 0 ? 'positive' : ''}>{pct(v)}</span>;
                })}
                <span className={(r.maxReturnPct || 0) > 0 ? 'positive' : ''}>{pct(r.maxReturnPct)}</span>
                <span>{r.volume ? fmt(r.volume) : '—'}</span>
              </div>
            ))}
          </div>
          <h4>차트 분석</h4>
          <p className="editor-hint">체크 종목 {picked.length}/4. 검색시점 종가를 0%로 두고 현재까지 비교합니다.</p>
          {picked.length > 0 && result && (
            <VerifyCompare
              codes={picked}
              names={Object.fromEntries(picked.map((c) => [c, nameOf(c, result.rows.find((x) => x.code === c)?.name || c)]))}
              searchAt={searchAt}
              timeframe={minute ? '1' : 'D'}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CapturesPane({
  state,
  draft,
  setDraft,
  update,
  onCode,
  toggleChart,
  chartCodes,
}: {
  state: State;
  draft: Config;
  setDraft: React.Dispatch<React.SetStateAction<Config | null>>;
  update: (patch?: Partial<Config>) => Promise<void>;
  onCode: (code: string) => void;
  toggleChart: (code: string) => Promise<void>;
  chartCodes: string[];
}) {
  const rows = state.captured?.length ? state.captured : state.ranking.map((s) => ({code: s.code, name: s.name}));
  return (
    <div className="scanner-pane">
      <p className="panel-desc">
        실시간 {state.realtime?.hub.state || '없음'} · 응답 {state.lastSearch?.rows ?? 0}행 · 포착 {rows.length}종목
      </p>
      <select value={draft.condition} onChange={(e) => setDraft({...draft, condition: e.target.value})}>
        <option value="">조건식 선택</option>
        {state.conditions.map((c) => (
          <option key={c.seq} value={c.seq}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="start" disabled={!draft.condition || state.busy} onClick={() => void update({condition: draft.condition})}>
        실행
      </button>
      {rows.map((row) => (
        <div key={row.code} className="rank-row">
          <label className="chart-check">
            <input
              type="checkbox"
              checked={chartCodes.includes(row.code)}
              disabled={!chartCodes.includes(row.code) && chartCodes.length >= MULTI_CHART_MAX}
              onChange={() => void toggleChart(row.code)}
            />
          </label>
          <button type="button" className="rank-name" onClick={() => onCode(row.code)}>
            <b>{row.name}</b>
            <small>{row.code}</small>
          </button>
        </div>
      ))}
      {!rows.length && (
        <div className="empty-activity">
          {state.error ||
            (state.lastSearch?.seq
              ? `조건식 ${state.lastSearch.seq} 응답 ${state.lastSearch.rows}행. 포착 종목이 없습니다.`
              : '조건식을 고른 뒤 실행을 누르세요.')}
        </div>
      )}
    </div>
  );
}

function ScannerPane(props: {
  state: State;
  draft: Config;
  setDraft: React.Dispatch<React.SetStateAction<Config | null>>;
  chartCodes: string[];
  update: (patch?: Partial<Config>) => Promise<void>;
  toggleChart: (code: string) => Promise<void>;
  load: () => Promise<void>;
  setNotice: (v: string) => void;
  setShowFormulas: (v: boolean) => void;
  onCommonCode: (code: string) => void;
}) {
  const {state, draft, chartCodes} = props;
  return (
    <div className="scanner-pane">
      <p className="panel-desc">
        가중 점수 상위 {state.config.count}종목 <span>● 체크 시 차트·매매</span>
        <br />
        실시간 {state.realtime?.hub.state || '없음'} · 포착 {state.captured?.length ?? state.realtime?.captured ?? 0}종목
      </p>
      <div className="table-head rank-head">
        <span></span>
        <span>순위 / 종목</span>
        <span>등락률</span>
        <span>점수</span>
      </div>
      {state.ranking.map((s, i) => (
        <div
          className={'rank-row' + (chartCodes.includes(s.code) ? ' on-chart' : '')}
          key={s.code}
          onClick={() => props.onCommonCode(s.code)}
        >
          <label className="chart-check">
            <input
              type="checkbox"
              checked={chartCodes.includes(s.code)}
              disabled={!chartCodes.includes(s.code) && chartCodes.length >= MULTI_CHART_MAX}
              onClick={(e) => e.stopPropagation()}
              onChange={() => void props.toggleChart(s.code)}
            />
          </label>
          <span className={'rank ' + (i < 3 ? 'top' : '')}>{String(i + 1).padStart(2, '0')}</span>
          <div className="rank-name">
            <b>{s.name}</b>
            <small>
              {s.code} {s.score < 0 ? '· 시세 대기' : `· 강도 ${s.strength.toFixed(1)} · 대금 ${fmt(s.value)}백만원`}
            </small>
          </div>
          <span className={s.change >= 0 ? 'positive' : 'negative'}>
            {s.change >= 0 ? '+' : ''}
            {s.change.toFixed(2)}%
          </span>
          <strong>{s.score < 0 ? '대기' : s.score.toFixed(1)}</strong>
        </div>
      ))}
      {!state.ranking.length && (
        <div className="empty-activity">
          {(state.captured || []).length
            ? `포착 ${state.captured.length}종목 · 시세 대기 중이거나 점수 계산 전입니다.`
            : state.realtime?.hub.state !== 'ready'
              ? '실시간 세션이 끊겨 조건검색을 받을 수 없습니다. 서버 연결을 확인하세요.'
              : '조건식을 적용하면 포착 종목이 표시됩니다.'}
        </div>
      )}
      <div className="panel settings">
        <label>
          조건검색식{' '}
          <button
            className="text-button"
            onClick={async () => {
              try {
                await post('/api/conditions');
                await props.load();
                props.setNotice('조건식 목록을 불러왔습니다.');
              } catch (e) {
                props.setNotice((e as Error).message);
              }
            }}
          >
            목록 불러오기
          </button>
        </label>
        <select
          value={draft.condition}
          onChange={(e) => {
            const condition = e.target.value;
            props.setDraft({...draft, condition});
            if (condition) void props.update({condition});
          }}
        >
          <option value="">조건식 선택</option>
          {state.conditions.map((c) => (
            <option key={c.seq} value={c.seq}>
              {c.name}
            </option>
          ))}
        </select>
        <label>
          점수 상위 표시 <b>{draft.count}개</b>
        </label>
        <input type="range" min={1} max={40} value={draft.count} onChange={(e) => props.setDraft({...draft, count: Number(e.target.value)})} />
        <label>목록 갱신 주기</label>
        <label>
          <input
            type="checkbox"
            checked={draft.autoTopCharts !== false}
            onChange={(e) => {
              const autoTopCharts = e.target.checked;
              props.setDraft({...draft, autoTopCharts});
              void post('/api/autotop', {autoTopCharts}).then(() => props.load()).catch((err) => props.setNotice((err as Error).message));
            }}
          />
          종목전환 {draft.autoTopCharts !== false ? '켜짐' : '꺼짐'}
        </label>
        <p className="editor-hint">끄면 왼쪽 순위가 바뀌어도 멀티차트 종목을 바꾸지 않습니다. 보유·잠금 종목은 항상 유지합니다.</p>
        <label>
          자동매매 종목 수 <b>{draft.tradeSlots ?? 4}개</b>
        </label>
        <input
          type="range"
          min={1}
          max={8}
          value={draft.tradeSlots ?? 4}
          onChange={(e) => props.setDraft({...draft, tradeSlots: Number(e.target.value)})}
        />
        {(draft.tradeSlots ?? 4) >= 6 && <p className="editor-hint">종목이 많으면 분봉 조회가 밀려 순위와 차트가 어긋날 수 있습니다.</p>}
        <button
          className={state.config.running ? 'stop' : 'start'}
          disabled={!draft.condition || state.busy}
          onClick={() => void props.update({condition: draft.condition, running: !state.config.running, refreshMs: draft.refreshMs || 60000, tradeSlots: draft.tradeSlots ?? 4, autoTopCharts: true, tradeMode: draft.tradeMode || 'auto'})}
        >
          {state.config.running ? '모의매매 정지' : '모의매매 시작'}
        </button>
        <button
          className="apply"
          disabled={!draft.condition || state.busy}
          onClick={() => void post('/api/recapture', {}).then(() => props.load()).catch((e) => props.setNotice((e as Error).message))}
        >
          재포착 (1분)
        </button>
        <select value={draft.refreshMs || 60000} onChange={(e) => props.setDraft({...draft, refreshMs: Number(e.target.value)})}>
          <option value={15000}>15초</option>
          <option value={30000}>30초</option>
          <option value={60000}>1분</option>
          <option value={120000}>2분</option>
          <option value={300000}>5분</option>
        </select>
        <label>순위 가중치</label>
        <div className="weights">
          {([['change', '등락률'], ['strength', '체결강도'], ['value', '거래대금']] as const).map(([k, label]) => (
            <div key={k}>
              <small>{label}</small>
              <div>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.weights[k]}
                  onChange={(e) => props.setDraft({...draft, weights: {...draft.weights, [k]: Number(e.target.value)}})}
                />
                <span>%</span>
              </div>
            </div>
          ))}
        </div>
        <button className="apply" onClick={() => void props.update()}>
          설정 적용
        </button>
        <button
          className={state.config.running ? 'stop' : 'start'}
          onClick={() => {
            if (!state.config.running && chartCodes.length === 0) {
              props.setNotice('목록에서 차트에 넣을 종목을 체크하세요.');
              return;
            }
            void props.update({running: !state.config.running});
          }}
        >
          {state.config.running ? '모의 전략 중지' : '모의 전략 시작'}
        </button>
        <div className="settings-note">체크한 종목만 멀티차트·모의매매 대상입니다. 실제 주문은 없습니다.</div>
      </div>
    </div>
  );
}

function CommonCode({value, onCommit}: {value: string; onCommit: (code: string) => void}) {
  const [text, setText] = useState(value || '');
  useEffect(() => setText(value || ''), [value]);
  return (
    <input
      value={text}
      maxLength={6}
      placeholder="005930"
      inputMode="numeric"
      autoComplete="off"
      onChange={(e) => {
        const next = e.target.value.replace(/\D/g, '').slice(0, 6);
        setText(next);
        if (next.length === 6 || next === '') onCommit(next);
      }}
    />
  );
}

function TrPane({code}: {code: string}) {
  const [id, setId] = useState('ka10080');
  const [local, setLocal] = useState(code);
  const [out, setOut] = useState('');
  useEffect(() => setLocal(code), [code]);
  return (
    <div className="tr-pane">
      <p>허용된 조회 TR만 호출합니다. 임의 REST 경로는 열지 않습니다.</p>
      <select value={id} onChange={(e) => setId(e.target.value)}>
        <option value="ka10171">ka10171 조건식 목록</option>
        <option value="ka10080">ka10080 분봉</option>
        <option value="ka10046">ka10046 체결강도</option>
      </select>
      <input value={local} placeholder="종목코드" maxLength={6} onChange={(e) => setLocal(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      <button
        className="apply"
        onClick={async () => {
          try {
            const d = await post('/api/tr', {id, code: local});
            setOut(JSON.stringify(d, null, 2));
          } catch (e) {
            setOut((e as Error).message);
          }
        }}
      >
        조회
      </button>
      <pre>{out || '결과가 여기에 표시됩니다.'}</pre>
    </div>
  );
}

function LogsPane() {
  const [tab, setTab] = useState<'system' | 'trade'>('trade');
  const [entries, setEntries] = useState<{at: number; category: string; message: string}[]>([]);
  const loadLogs = async () => {
    const r = await fetch(`/api/logs?tab=${tab}`);
    const d = await r.json();
    setEntries(d.entries || []);
  };
  useEffect(() => {
    void loadLogs();
    const t = setInterval(() => void loadLogs(), 4000);
    return () => clearInterval(t);
  }, [tab]);
  const saveFile = () => {
    const blob = new Blob([entries.map((e) => JSON.stringify(e)).join('\n')], {type: 'application/jsonl'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tab}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
  };
  return (
    <div className="book-pane">
      <div className="formula-tabs">
        <button className={tab === 'system' ? 'selected' : ''} onClick={() => setTab('system')}>시스템 로그</button>
        <button className={tab === 'trade' ? 'selected' : ''} onClick={() => setTab('trade')}>매매 로그</button>
      </div>
      <button className="hts-tool" onClick={saveFile}>파일 저장</button>
      <div className="log-list">
        {entries.map((e, i) => (
          <div key={i} className="log-row">
            <small>{new Date(e.at).toLocaleTimeString('ko-KR')}</small> [{e.category}] {e.message}
          </div>
        ))}
        {!entries.length && (
          <div className="empty-activity">
            오늘 매매/시스템 파일 로그가 없습니다. 차트 화살표는 수식 표시이며, 자동매매가 켜지고 확정 1분봉에서 신호가 나야 여기에 남습니다.
          </div>
        )}
      </div>
    </div>
  );
}

function SystemTradePanel({
  state,
  draft,
  setDraft,
  systems,
  update,
  onDesign,
  onClose,
}: {
  state: State;
  draft: Config;
  setDraft: React.Dispatch<React.SetStateAction<Config | null>>;
  systems: Formula[];
  update: (patch?: Partial<Config>) => Promise<void>;
  onDesign: () => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState(state.book?.fillMode === 'kiwoom-mock' ? 'mock' : 'virtual');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="formula-modal sys-trade" onClick={(e) => e.stopPropagation()}>
        <div className="formula-header">
          <div><h2>시스템트레이딩 설정</h2></div>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <p className="editor-hint">전략을 고르고 적용하면 멀티차트 공통으로 자동매매가 시작됩니다. 차트 라벨 클릭: 대기 → 적용 → 백테스트.</p>
        <label>
          시스템 수식
          <select value={draft.strategyId || ''} onChange={(e) => setDraft({...draft, strategyId: e.target.value})}>
            <option value="">선택</option>
            {systems.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className="hts-tool" onClick={onDesign}>전략 설계 (수식 관리자)</button>
        <label>
          주문 모드
          <select value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="virtual">가상 (가정 체결)</option>
            <option value="mock">모의 (키움 모의계좌)</option>
            <option value="real" disabled>실전 (주문 안 함)</option>
          </select>
        </label>
        <label>
          매매 방식
          <select value={draft.tradeMode || 'auto'} onChange={(e) => setDraft({...draft, tradeMode: e.target.value as 'auto' | 'semi'})}>
            <option value="auto">자동 (신호 시 주문)</option>
            <option value="semi">반자동 (차트 매수/매도 버튼)</option>
          </select>
        </label>
        <label>
          자동매매 종목 수 {draft.tradeSlots ?? 4} (1~8)
          <input type="range" min={1} max={8} value={draft.tradeSlots ?? 4} onChange={(e) => setDraft({...draft, tradeSlots: Number(e.target.value)})} />
        </label>
        {(draft.tradeSlots ?? 4) >= 6 && <p className="editor-hint">6개 이상이면 분봉 조회가 순위 갱신보다 늦을 수 있습니다.</p>}
        <label>
          1회 수량
          <input type="number" min={1} max={1000} value={draft.orderQty ?? 1} onChange={(e) => setDraft({...draft, orderQty: Number(e.target.value)})} />
        </label>
        <label>
          목록 갱신
          <select value={draft.refreshMs || 60000} onChange={(e) => setDraft({...draft, refreshMs: Number(e.target.value)})}>
            <option value={15000}>15초</option>
            <option value={30000}>30초</option>
            <option value={60000}>1분</option>
            <option value={120000}>2분</option>
            <option value={300000}>5분</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={draft.autoTopCharts !== false} onChange={(e) => setDraft({...draft, autoTopCharts: e.target.checked})} />
          진입 전 종목만 점수 순으로 교체 (매매 중 유지)
        </label>
        <div className="editor-hint">패턴 필터 (지표 신호 위에 적용)</div>
        {PATTERN_FILTERS.map((f) => (
          <label key={f.id} title={f.description}>
            <input
              type="checkbox"
              checked={draft.patternFilters ? draft.patternFilters[f.id] !== false : f.defaultOn}
              onChange={(e) => setDraft({...draft, patternFilters: {...(draft.patternFilters || Object.fromEntries(PATTERN_FILTERS.map((x) => [x.id, x.defaultOn]))), [f.id]: e.target.checked}})}
            />
            {f.name}
            {(() => {
              const k = state.patternKpi?.summaries.find((s) => s.filterId === f.id);
              if (!k) return null;
              const pct = (k.avgPct * 100).toFixed(2);
              return <small> · {k.n}건 {pct}% 점{k.score}{k.ready ? '' : ' (표본 부족)'}</small>;
            })()}
          </label>
        ))}
        <label>
          skip001 지연배수 N {draft.skip001N ?? 1.2} (높을수록 진입 자제)
          <input type="range" min={0.5} max={3} step={0.1} value={draft.skip001N ?? 1.2} onChange={(e) => setDraft({...draft, skip001N: Number(e.target.value)})} />
        </label>
        <div className="book-actions">
          <button
            className="apply"
            onClick={() => void update({
              strategyId: draft.strategyId,
              tradeMode: draft.tradeMode || 'auto',
              tradeSlots: draft.tradeSlots ?? 4,
              orderQty: draft.orderQty ?? 1,
              refreshMs: draft.refreshMs || 60000,
              autoTopCharts: draft.autoTopCharts !== false,
              patternFilters: draft.patternFilters,
              skip001N: draft.skip001N ?? 1.2,
              condition: draft.condition || state.config.condition,
              count: draft.count,
              weights: draft.weights,
              running: true,
            }).then(async () => {
              await post('/api/book/mode', {mode: host === 'mock' ? 'kiwoom-mock' : 'assumed'});
              onClose();
            })}
          >
            적용하고 자동매매 시작
          </button>
        </div>
      </div>
    </div>
  );
}

function BookPane({state, load, setNotice}: {state: State; load: () => Promise<void>; setNotice: (v: string) => void}) {
  const book = state.book;
  const run = async (path: string, body: unknown) => {
    try {
      await post(path, body);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  return (
    <div className="book-pane">
      <p className="panel-desc">
        {book?.fillMode === 'kiwoom-mock'
          ? '키움 모의 시장가는 접수 후 체결로 반영합니다. 지정가는 시세 도달 시 반영합니다.'
          : '가정 체결 · 키움 주문 없음 · 관측 가격만 사용'}
      </p>
      <label className="hts-var">
        체결 모드
        <select
          value={book?.fillMode || 'assumed'}
          onChange={(e) => void run('/api/book/mode', {mode: e.target.value})}
        >
          <option value="assumed">가정 체결</option>
          <option value="kiwoom-mock">키움 모의계좌 주문</option>
        </select>
      </label>
      <div className="book-actions">
        <button className="stop" onClick={() => void run('/api/book/flatten', {})}>일괄 청산(시장가 가정)</button>
        <button className="apply" onClick={() => void run('/api/book/cancel', {})}>미체결 일괄 취소</button>
      </div>
      <h3>보유현황</h3>
      {book?.holdings.length ? book.holdings.map((h) => {
        const live = state.ranking.find((s) => s.code === h.code);
        const px = live?.price || h.avgPrice;
        const pnl = h.avgPrice > 0 ? ((px - h.avgPrice) / h.avgPrice) * 100 : 0;
        return (
        <div className="rank-row" key={h.code}>
          <div className="rank-name">
            <b>{live?.name || h.code}</b>
            <small>{h.qty}주 · 평균 {fmt(Math.round(h.avgPrice))}원 · 현재 {fmt(Math.round(px))}원 · <span className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</span></small>
          </div>
          <button className="text-button" onClick={() => void run('/api/book/sell', {code: h.code, type: 'market'})}>시장가 매도</button>
          <button className="text-button" onClick={() => {
            const limit = Number(window.prompt('지정 매도가', String(Math.round(h.avgPrice))));
            if (Number.isFinite(limit) && limit > 0) void run('/api/book/sell', {code: h.code, type: 'limit', limitPrice: limit});
          }}>지정 매도</button>
        </div>
      ); }) : <div className="empty-activity">모의 보유가 없습니다.</div>}
      <h3>미체결현황</h3>
      {book?.working.length ? book.working.map((o) => (
        <div className="rank-row" key={o.id}>
          <div className="rank-name">
            <b>{o.code} {o.side === 'buy' ? '매수' : '매도'} {o.type === 'limit' ? '지정' : '시장'}</b>
            <small>{o.qty}주 {o.limitPrice ? `· ${fmt(o.limitPrice)}원` : ''} · {o.reason}</small>
          </div>
          <button className="text-button" onClick={() => void run('/api/book/cancel', {id: o.id})}>취소</button>
          <button className="text-button" onClick={() => void run('/api/book/cancel', {code: o.code})}>종목 일괄취소</button>
        </div>
      )) : <div className="empty-activity">미체결이 없습니다.</div>}
      <h3>체결</h3>
      {book?.recent.filter((o) => o.status === 'filled').slice(0, 12).map((o) => (
        <div key={o.id}>{o.code} {o.side === 'buy' ? '매수' : '매도'} {o.fillPrice ? fmt(o.fillPrice) : ''}원 · {o.reason}</div>
      ))}
    </div>
  );
}
