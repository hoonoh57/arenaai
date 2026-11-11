import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {Candle, Stock, Weights} from '../server/core';
import type {Formula} from '../shared/formula';
import {
  KIND_TITLE,
  WINDOW_KINDS,
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

type Config = {condition: string; count: number; weights: Weights; running: boolean; refreshMs: number; chartCodes: string[]; strategyId: string; strategyByCode: Record<string, string>};
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
    hub: {state: string; subscriptions: number; reconnects: number; duplicatesDropped: number; caps: {maxSubscriptions: number; verified: boolean}};
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

export function DeskApp() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [notice, setNotice] = useState('');
  const [showFormulas, setShowFormulas] = useState(false);
  const [workspace, setWorkspace] = useState<DeskWorkspace>(defaultWorkspace);
  const [grid, setGrid] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [chartHeight, setChartHeight] = useState(250);
  const saveTimer = useRef<number | null>(null);
  const drag = useRef<{id: string; dx: number; dy: number; mode: 'move' | 'resize'} | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/state');
      const s = await r.json();
      setState(s);
      setDraft((d) =>
        d
          ? {...d, chartCodes: s.config.chartCodes || [], running: s.config.running, refreshMs: s.config.refreshMs || d.refreshMs || 60000, strategyId: s.config.strategyId || d.strategyId || '', strategyByCode: s.config.strategyByCode || {}}
          : s.config,
      );
    } catch {
      setNotice('서버에 연결할 수 없습니다.');
    }
  };

  useEffect(() => {
    void load();
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
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void put('/api/desks', next).catch((e) => setNotice((e as Error).message));
    }, 400);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 8 && workspace.desks.some((d) => d.number === n)) {
        e.preventDefault();
        persist({...workspace, active: n});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspace, persist]);

  const desk = activeDesk(workspace);
  const updateDesk = (next: VirtualDesk) => persist(replaceDesk({...workspace, active: next.number}, next));

  const addWindow = (kind: WindowKind) => updateDesk(insertWindow(desk, kind));
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
        updateDesk(patchWindow(current, session.id, {x: Math.max(0, e.clientX - session.dx), y: Math.max(0, e.clientY - session.dy)}));
      } else {
        updateDesk(patchWindow(current, session.id, {w: Math.max(280, e.clientX - win.x), h: Math.max(180, e.clientY - win.y)}));
      }
    };
    const up = () => {
      drag.current = null;
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
    if (!on && chartCodes.length >= 10) {
      setNotice('멀티차트는 최대 10종목입니다.');
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
            <button key={item.id} className={item.number === desk.number ? 'on' : ''} onClick={() => persist({...workspace, active: item.number})}>
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
        <button className="hts-tool" onClick={() => setShowFormulas(true)}>
          수식 관리자
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
            onChange={(e) => void setStrategy(e.target.value)}
          >
            <option value="">선택</option>
            {systems.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <span className="hts-desk-name">{desk.number}. {desk.name}</span>
        <span className="mode">
          <i /> {state.mode === 'mock' ? '모의 조회' : '실전 조회'}
        </span>
      </header>
      <div className="hts-workspace">
        {desk.windows
          .slice()
          .sort((a, b) => a.z - b.z)
          .map((win) => (
            <ChildFrame
              key={win.id}
              win={win}
              onFocus={() => updateDesk(focusWindow(desk, win.id))}
              onClose={() => updateDesk(removeWindow(desk, win.id))}
              onLock={() => updateDesk(toggleLock(desk, win.id))}
              onState={(st) => updateDesk(setWindowState(desk, win.id, st))}
              onDrag={(e, mode) => {
                updateDesk(focusWindow(desk, win.id));
                drag.current = {id: win.id, dx: e.clientX - win.x, dy: e.clientY - win.y, mode};
              }}
            >
              <Pane
                win={win}
                desk={desk}
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
                setStrategy={setStrategy}
                formulasFor={formulasFor}
                systems={systems}
                patchWin={(id, patch) => updateDesk(patchWindow(desk, id, patch))}
                onCommonCode={applyCode}
              />
            </ChildFrame>
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
      {(notice || state.error) && (
        <div className="notice" onClick={() => setNotice('')}>
          {notice || state.error} ×
        </div>
      )}
      {showFormulas && (
        <FormulaManager
          formulas={state.formulas}
          candles={state.candles[selected[0]?.code] || []}
          onClose={() => setShowFormulas(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function ChildFrame({
  win,
  children,
  onFocus,
  onClose,
  onLock,
  onState,
  onDrag,
}: {
  win: ChildWindow;
  children: React.ReactNode;
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
  setStrategy: (formulaId: string, code?: string) => Promise<void>;
  formulasFor: (code: string) => Formula[];
  systems: Formula[];
  patchWin: (id: string, patch: Partial<ChildWindow>) => void;
  onCommonCode: (code: string) => void;
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
        cached={state.candles[code] || []}
        grid={props.grid}
        logScale={props.logScale}
        patchWin={(patch) => props.patchWin(win.id, patch)}
        setNotice={props.setNotice}
        onCommonCode={props.onCommonCode}
      />
    );
  }
  if (win.kind === 'multi-chart') {
    const cellH = Math.max(140, Math.floor(((win.h || 480) - 72) / Math.max(1, Math.ceil(Math.max(selected.length, 1) / 2))) - 48);
    return (
      <div className="pane-multi">
        <div className="multi-bar">
          <select
            value={draft?.condition || ''}
            onChange={(e) => props.setDraft({...draft, condition: e.target.value})}
          >
            <option value="">조건식</option>
            {state.conditions.map((c) => (
              <option key={c.seq} value={c.seq}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            disabled={!draft?.condition}
            onClick={() => void props.update({condition: draft.condition})}
          >
            조건검색 실행
          </button>
          <button
            disabled={!state.captured?.length}
            onClick={() => {
              const codes = (state.captured || []).slice(0, 10).map((r) => r.code);
              void post('/api/charts', {codes}).then(() => props.load());
            }}
          >
            포착 종목 넣기
          </button>
        </div>
        <div className="chart-grid">
          {selected.map((s) => (
            <article className="chart-card" key={s.code}>
              <div className="chart-top">
                <div>
                  <b>{s.name}</b> <span className="stock-code">{s.code}</span>
                  <div className="price">
                    {fmt(s.price)} <span className={s.change >= 0 ? 'positive' : 'negative'}>{s.change.toFixed(2)}%</span>
                  </div>
                </div>
                {strategySelect(s.code)}
              </div>
              {state.candles[s.code]?.length ? (
                <Chart data={state.candles[s.code]} formulas={props.formulasFor(s.code)} chartHeight={cellH} grid={props.grid} logScale={props.logScale} />
              ) : (
                <div className="empty-chart">분봉을 불러오는 중이거나 조회에 실패했습니다.</div>
              )}
            </article>
          ))}
          {selected.length === 0 && <div className="empty">조건검색 실행 후 「포착 종목 넣기」를 누르거나, 조건검색 창에서 종목을 체크하세요.</div>}
        </div>
      </div>
    );
  }
  if (win.kind === 'scanner') return <ScannerPane {...props} />;
  if (win.kind === 'captures') return <CapturesPane state={state} draft={draft} setDraft={props.setDraft} update={props.update} onCode={props.onCommonCode} toggleChart={props.toggleChart} chartCodes={chartCodes} />;
  if (win.kind === 'tr') return <TrPane code={code} />;
  if (win.kind === 'book') return <BookPane state={state} load={props.load} setNotice={props.setNotice} />;
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
            <input type="checkbox" checked={chartCodes.includes(row.code)} onChange={() => void toggleChart(row.code)} />
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
              disabled={!chartCodes.includes(s.code) && chartCodes.length >= 10}
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
          ? '키움 모의계좌 주문(kt10000/01/03). 실전 주문 없음. 체결은 계좌 응답 기준.'
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
      <h3>모의 보유</h3>
      {book?.holdings.length ? book.holdings.map((h) => (
        <div className="rank-row" key={h.code}>
          <div className="rank-name">
            <b>{h.code}</b>
            <small>{h.qty}주 · 평균 {fmt(Math.round(h.avgPrice))}원</small>
          </div>
          <button className="text-button" onClick={() => void run('/api/book/sell', {code: h.code, type: 'market'})}>시장가 매도</button>
          <button className="text-button" onClick={() => {
            const limit = Number(window.prompt('지정 매도가', String(Math.round(h.avgPrice))));
            if (Number.isFinite(limit) && limit > 0) void run('/api/book/sell', {code: h.code, type: 'limit', limitPrice: limit});
          }}>지정 매도</button>
        </div>
      )) : <div className="empty-activity">모의 보유가 없습니다.</div>}
      <h3>미체결</h3>
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
      <h3>최근 가정 체결</h3>
      {book?.recent.filter((o) => o.status === 'filled').slice(0, 12).map((o) => (
        <div key={o.id}>{o.code} {o.side === 'buy' ? '매수' : '매도'} {o.fillPrice ? fmt(o.fillPrice) : ''}원 · {o.reason}</div>
      ))}
    </div>
  );
}
