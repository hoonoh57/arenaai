import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {Candle} from '../server/core';
import type {Formula} from '../shared/formula';
import type {ChildWindow, VirtualDesk} from '../shared/desk';
import {Chart} from './ChartView';
import {DRAW_TOOLS} from '../shared/chartMenu';
import {TradeBar} from './chart/TradeBar';

const TF = [
  {id: 'T1', label: '1틱'},
  {id: 'T3', label: '3틱'},
  {id: 'T5', label: '5틱'},
  {id: 'T10', label: '10틱'},
  {id: 'T30', label: '30틱'},
  {id: 'T60', label: '60틱'},
  {id: 'T120', label: '120틱'},
  {id: 'T240', label: '240틱'},
  {id: 'T720', label: '720틱'},
  {id: '1', label: '1분'},
  {id: '3', label: '3분'},
  {id: '5', label: '5분'},
  {id: '10', label: '10분'},
  {id: '15', label: '15분'},
  {id: '30', label: '30분'},
  {id: '45', label: '45분'},
  {id: '60', label: '60분'},
  {id: 'D', label: '일봉'},
  {id: 'W', label: '주봉'},
  {id: 'M', label: '월봉'},
];

async function post(path: string, body?: unknown) {
  const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '요청 실패');
  return d;
}

const fetchCool = new Map<string, number>();
function chartTooSoon(key: string, ms = 25_000): boolean {
  const at = fetchCool.get(key) || 0;
  if (Date.now() - at < ms) return true;
  fetchCool.set(key, Date.now());
  return false;
}

function mergeBars(oldBars: Candle[], olderPage: Candle[]): Candle[] {
  const seen = new Set(oldBars.map((b) => b.time));
  return [...olderPage.filter((b) => !seen.has(b.time)), ...oldBars];
}

function mergeStrengthOnto(price: Candle[], withStr: Candle[]): Candle[] {
  if (!price.length) return withStr;
  const map = new Map(withStr.map((c) => [c.time, c.strength]));
  return price.map((c) => {
    const s = map.get(c.time);
    return typeof s === 'number' && s > 0 ? {...c, strength: s} : c;
  });
}

export function ChartPane({
  win,
  desk,
  formulas,
  rankingName,
  cached,
  grid,
  logScale,
  patchWin,
  setNotice,
  onReload,
  onCommonCode,
  patternFilters,
  delayContext,
  wssLink,
  active = true,
  tradeStatus,
  inPos,
  locked,
  strategyId,
  systems = [],
  onTrade,
  onStrategy,
  onBuy,
  onSell,
  onLock,
}: {
  win: ChildWindow;
  desk: VirtualDesk;
  formulas: Formula[];
  rankingName?: string;
  cached: Candle[];
  grid: boolean;
  logScale: boolean;
  patchWin: (patch: Partial<ChildWindow>) => void;
  setNotice: (v: string) => void;
  onReload?: () => Promise<void>;
  onCommonCode?: (code: string) => void;
  patternFilters?: import('../shared/patternFilters').FilterEnabled;
  delayContext?: import('../shared/patternFilters').DelayContext;
  wssLink?: 'ok' | 'warn' | 'dead';
  active?: boolean;
  tradeStatus?: 'wait' | 'run' | 'stop' | 'backtest';
  inPos?: boolean;
  locked?: boolean;
  strategyId?: string;
  systems?: Formula[];
  onTrade?: (status: 'wait' | 'run' | 'stop' | 'backtest') => void;
  onStrategy?: (id: string) => void;
  onBuy?: () => void;
  onSell?: () => void;
  onLock?: () => void;
}) {
  const code = win.locked ? win.code || '' : desk.vars.code || win.code || '';
  const [codeText, setCodeText] = useState(code);
  const [name, setName] = useState(rankingName || '');
  const [bars, setBars] = useState<Candle[]>(cached);
  const [nextKey, setNextKey] = useState('');
  const [strengthNextKey, setStrengthNextKey] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [strengthReady, setStrengthReady] = useState(false);
  const [strengthNxt, setStrengthNxt] = useState(false);
  const [strengthHasMore, setStrengthHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workMsg, setWorkMsg] = useState('');
  const [workErr, setWorkErr] = useState('');
  const [viewCount, setViewCount] = useState(win.visibleBars || 200);
  const [overlay, setOverlay] = useState<Candle[]>([]);
  const [mode, setMode] = useState<'replace' | 'overlay'>((win as {compareMode?: 'replace' | 'overlay'}).compareMode || 'replace');
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [drawTool, setDrawTool] = useState('cursor');
  const [magnet, setMagnet] = useState(win.chartView?.magnet !== false);
  const [varPatch, setVarPatch] = useState<Record<string, Record<string, number>>>({});
  const [selPane, setSelPane] = useState(win.chartView?.selectedPane || 0);
  const [liveWss, setLiveWss] = useState(wssLink || 'dead');
  const [livePx, setLivePx] = useState(0);
  const viewTimer = useRef(0);
  const paneById = win.indicatorPanes || {};
  const timeframe = win.timeframe || '1';
  const baseDate = win.baseDate || '';
  const visibleBars = win.visibleBars || 200;
  const formulaOpen = win.formulaOpen !== false;
  const enabled = new Set(win.enabledFormulas ?? formulas.filter((f) => f.enabled && f.kind !== 'system').map((f) => f.id));

  useEffect(() => setCodeText(code), [code]);
  useEffect(() => {
    if (rankingName) setName(rankingName);
  }, [rankingName]);

  const load = async (opts: {code?: string; timeframe?: string; baseDate?: string; append?: boolean; overlay?: boolean; force?: boolean; strengthOnly?: boolean} = {}) => {
    const useCode = opts.code ?? codeText;
    if (!/^\d{6}$/.test(useCode)) return;
    const coolKey = `${useCode}|${opts.timeframe ?? timeframe}|${opts.baseDate ?? baseDate}|${opts.append ? 'a' : '1'}`;
    if (!opts.append && !opts.force && !opts.strengthOnly && chartTooSoon(coolKey) && bars.length) return;
    setBusy(true);
    setWorkErr('');
    setWorkMsg(opts.strengthOnly ? '체결강도 이전 페이지를 받는 중' : opts.append ? '가격 이전 페이지를 받는 중' : '차트를 조회하는 중');
    try {
      const d = await post('/api/chart', {
        code: useCode,
        timeframe: opts.timeframe ?? timeframe,
        baseDate: opts.baseDate ?? baseDate,
        nextKey: opts.append && !opts.strengthOnly ? nextKey : '',
        strengthNextKey: opts.strengthOnly || opts.append ? strengthNextKey : '',
        withStrength: enabled.has('cntrstr') && (opts.timeframe ?? timeframe) !== 'D' && (opts.timeframe ?? timeframe) !== 'W' && (opts.timeframe ?? timeframe) !== 'M',
        strengthOnly: Boolean(opts.strengthOnly),
      });
      setName(d.name && d.name !== useCode ? d.name : d.name || useCode);
      const next = d.candles || [];
      if (opts.overlay) setOverlay(next);
      else if (opts.strengthOnly) setBars((prev) => mergeStrengthOnto(prev.length ? prev : next, next));
      else setBars((prev) => (opts.append ? mergeBars(prev, next) : next.length ? next : prev));
      setHasMore(Boolean(d.hasMore));
      setStrengthHasMore(Boolean(d.strengthHasMore));
      setNextKey(d.nextKey || '');
      setStrengthNextKey(d.strengthNextKey || '');
      setStrengthReady(Boolean(d.strengthReady));
      setStrengthNxt(Boolean(d.strengthNxt));
      if (d.warning) {
        setNotice(String(d.warning));
        setWorkErr(String(d.warning));
      } else setWorkMsg('');
    } catch (e) {
      const msg = (e as Error).message;
      setNotice(msg);
      setWorkErr(msg);
    } finally {
      setBusy(false);
      setWorkMsg('');
    }
  };

  useEffect(() => {
    if (!cached.length) return;
    setBars((prev) => {
      if (!prev.length) return cached;
      const a = cached[cached.length - 1];
      const b = prev[prev.length - 1];
      if (!a || !b) return cached;
      if (a.time === b.time && a.close > 0 && b.close > 0 && Math.abs(a.close / b.close - 1) < 0.35) {
        const next = prev.slice();
        next[next.length - 1] = {...b, ...a};
        return next;
      }
      if (a.close > 0 && b.close > 0 && Math.abs(a.close / b.close - 1) > 0.35) return cached;
      if (cached.length > prev.length + 2) return cached;
      return prev;
    });
  }, [cached]);

  useEffect(() => {
    if (!/^\d{6}$/.test(code)) return;
    setOverlay([]);
    setNextKey('');
    const period = timeframe === 'D' || timeframe === 'W' || timeframe === 'M';
    if (!period && cached.length) {
      setBars(cached);
      return;
    }
    setBars([]);
    void load({code, force: true});
  }, [code, timeframe, baseDate]);

  useEffect(() => {
    if (!/^\d{6}$/.test(code)) return;
    let stop = false;
    const pull = async () => {
      try {
        const q = new URLSearchParams({code, timeframe, baseDate});
        const d = await fetch(`/api/live-bars?${q}`).then((r) => r.json());
        if (stop) return;
        if (d.wss?.link) setLiveWss(d.wss.link);
        const px = Number(d.quote?.price);
        if (px > 0) setLivePx(px);
        setBars((prev) => {
          const str = Number(d.quote?.strength);
          const period = timeframe === 'D' || timeframe === 'W' || timeframe === 'M';
          if (period) {
            if (!(px > 0) || !prev.length) return prev;
            const last = prev[prev.length - 1];
            if (last.close === px) return prev;
            const next = prev.slice();
            next[next.length - 1] = {...last, close: px, high: Math.max(last.high, px), low: last.low > 0 ? Math.min(last.low, px) : px};
            return next;
          }
          if (Array.isArray(d.candles) && d.candles.length) {
            const kept = new Map(prev.map((c) => [c.time, c]));
            const next = (d.candles as Candle[]).map((c) => {
              const had = kept.get(c.time);
              if (typeof c.strength === 'number' && c.strength > 0) return c;
              if (had && typeof had.strength === 'number' && had.strength > 0) return {...c, strength: had.strength};
              return c;
            });
            if (px > 0) {
              const last = next[next.length - 1];
              next[next.length - 1] = {
                ...last,
                close: px,
                high: Math.max(last.high, px),
                low: last.low > 0 ? Math.min(last.low, px) : px,
                ...(str > 0 ? {strength: str} : {}),
              };
            }
            const a = next[next.length - 1];
            const b = prev[prev.length - 1];
            if (
              prev.length &&
              a &&
              b &&
              a.time === b.time &&
              a.close === b.close &&
              a.strength === b.strength &&
              a.volume === b.volume &&
              next.length === prev.length
            )
              return prev;
            return next;
          }
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if ((!(px > 0) || last.close === px) && (!(str > 0) || last.strength === str)) return prev;
          const next = prev.slice();
          next[next.length - 1] = {
            ...last,
            ...(px > 0 ? {close: px, high: Math.max(last.high, px), low: last.low > 0 ? Math.min(last.low, px) : px} : {}),
            ...(str > 0 ? {strength: str} : {}),
          };
          return next;
        });
      } catch {
        /* hub */
      }
    };
    const ms = 300;
    let inflight = false;
    const tick = () => {
      if (inflight || stop) return;
      inflight = true;
      void pull().finally(() => {
        inflight = false;
      });
    };
    const id = window.setInterval(tick, ms);
    tick();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [code, timeframe, baseDate]);

  useEffect(() => {
    if (!active || !/^\d{6}$/.test(code)) return;
    void fetch(`/api/live-bars?${new URLSearchParams({code, timeframe, baseDate})}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d.candles) || !d.candles.length) return;
        if (timeframe === 'D' || timeframe === 'W' || timeframe === 'M') return;
        const hubLast = d.candles[d.candles.length - 1] as Candle;
        setBars((prev) => {
          const mine = prev[prev.length - 1];
          if (mine && hubLast.time === mine.time && hubLast.close === mine.close && d.candles.length <= prev.length) return prev;
          return d.candles as Candle[];
        });
      })
      .catch(() => {});
  }, [active, code, timeframe, baseDate]);


  const commitCode = (value: string) => {
    const next = value.replace(/\D/g, '').slice(0, 6);
    setCodeText(next);
    if (next.length !== 6 && next !== '') return;
    if (mode === 'overlay' && next.length === 6) {
      void load({code: next, overlay: true});
      patchWin({overlayCode: next} as Partial<ChildWindow>);
      return;
    }
    patchWin({code: next || undefined});
    if (!win.locked) onCommonCode?.(next);
  };

  const applied = formulas.map((f) => ({
    ...f,
    enabled: enabled.has(f.id),
    variables: {...(f.variables || {}), ...(varPatch[f.id] || {})},
  }));
  const groups = [
    {kind: 'indicator', label: '지표'},
    {kind: 'signal', label: '신호'},
    {kind: 'highlight', label: '강세'},
    {kind: 'system', label: '시스템트레이딩'},
    {kind: 'function', label: '기타(함수)'},
  ] as const;
  const editor = formulas.find((f) => f.id === editId);

  return (
    <div className={'chart-work' + (formulaOpen ? ' dock-on' : '')} style={{height: '100%'}}>
      <aside className="chart-dock">
        <div className="dock-head">수식</div>
        {groups.map((g) => (
          <div key={g.kind} className="dock-group">
            <b>{g.label}</b>
            {formulas.filter((f) => f.kind === g.kind).map((f) => (
              <label key={f.id} className={'dock-item' + (editId === f.id ? ' on' : '')} onClick={() => setEditId(f.id)}>
                <input
                  type="checkbox"
                  checked={enabled.has(f.id)}
                  onChange={() => {
                    const next = new Set(enabled);
                    const panes = {...paneById};
                    if (next.has(f.id)) {
                      next.delete(f.id);
                      delete panes[f.id];
                    } else {
                      next.add(f.id);
                      if (f.kind === 'indicator') {
                        if (f.paneShare === 'overlay') panes[f.id] = selPane > 0 ? selPane : 1;
                        else if (f.pane === 'separate') {
                          const used = Object.values(panes);
                          panes[f.id] = Math.max(0, ...used, 0) + 1;
                        } else panes[f.id] = 0;
                      }
                    }
                    patchWin({enabledFormulas: [...next], indicatorPanes: panes});
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setEditId(f.id);
                  }}
                />
                <span style={{color: f.color || '#cfe3d3'}}>{f.name}</span>
              </label>
            ))}
            {!formulas.some((f) => f.kind === g.kind) && <small>수식 관리자에서 추가</small>}
          </div>
        ))}
      </aside>
      <div className="chart-main" style={{position: 'relative'}}>
        {(busy || workErr) ? (
          <div className={'work-overlay' + (!busy && workErr ? ' err' : '')}>
            <b>{busy ? (workMsg || '처리 중') : workErr}</b>
          </div>
        ) : null}
        <div className="chart-toolbar" onMouseDown={(e) => e.stopPropagation()}>
          <button className="dock-toggle" title="수식 탭" onClick={() => patchWin({formulaOpen: !formulaOpen})}>
            {formulaOpen ? '⟨' : '⟩'}
          </button>
          <button className={'mode-btn' + (mode === 'replace' ? ' on' : '')} title="현재 종목 교체" onClick={() => setMode('replace')}>
            전
          </button>
          <button className={'mode-btn' + (mode === 'overlay' ? ' on' : '')} title="비교 종목 오버레이" onClick={() => setMode('overlay')}>
            추
          </button>
          <input className="code-in" value={codeText} maxLength={6} placeholder="종목" onChange={(e) => commitCode(e.target.value)} />
          <span className="chart-name">{name || codeText || '종목명'}</span>
          <span className={'wss-pill mini ' + (liveWss || wssLink || 'dead')} title="중앙관리자 실시간 수신(이 창은 허브 시세만 표시)">
            {(liveWss || wssLink) === 'ok' ? 'WSS 수신' : (liveWss || wssLink) === 'warn' ? 'WSS 지연' : 'WSS 끊김'}
            {livePx > 0 ? ` ${livePx.toLocaleString('ko-KR')}` : ''}
          </span>
          {onTrade && onBuy && onSell ? (
            <TradeBar
              code={code}
              status={tradeStatus}
              inPos={inPos}
              locked={locked}
              strategyId={strategyId}
              systems={systems}
              onTrade={onTrade}
              onStrategy={onStrategy}
              onBuy={onBuy}
              onSell={onSell}
              onLock={onLock}
            />
          ) : null}
          <select value={TF.some((t) => t.id === timeframe) ? timeframe : timeframe.startsWith('T') ? timeframe : '1'} onChange={(e) => patchWin({timeframe: e.target.value})}>
            {TF.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
            {timeframe.startsWith('T') && !TF.some((t) => t.id === timeframe) && (
              <option value={timeframe}>{timeframe.slice(1)}틱</option>
            )}
          </select>
          <input
            className="vis-bars"
            style={{width: 52}}
            title="틱 주기(30의 배수)"
            placeholder="틱"
            defaultValue={timeframe.startsWith('T') ? timeframe.slice(1) : ''}
            key={timeframe}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!Number.isInteger(n) || n < 1) return;
              if ([1, 3, 5, 10].includes(n) || (n % 30 === 0 && n >= 30 && n <= 7200)) patchWin({timeframe: `T${n}`});
            }}
          />
          <label className="date-btn" title="기준 일자">
            📅
            <input type="date" value={baseDate} onChange={(e) => patchWin({baseDate: e.target.value})} />
          </label>
          <span className="bar-count">
            {viewCount}/{bars.length}
          </span>
          <input
            type="number"
            min={20}
            max={2000}
            className="vis-bars"
            value={visibleBars}
            onChange={(e) => patchWin({visibleBars: Number(e.target.value) || 200})}
            title="화면 표시 봉수"
          />
          <button className="hts-tool" disabled={!hasMore || busy} onClick={() => void load({append: true})} title="가격 이전 페이지">
            +이전
          </button>
          <button
            className={'hts-tool' + (strengthReady ? ' on' : '')}
            disabled={busy}
            onClick={() => void load({strengthOnly: true, force: true})}
            title={strengthReady ? '체결강도 세션 시작까지 채움' : '체결강도 이전 페이지를 한 장 더 붙입니다'}
          >
            {strengthReady ? '강도완료' : '강도+이전'}
          </button>
          <button className="hts-tool" disabled={busy || !/^\d{6}$/.test(codeText)} onClick={() => void load({force: true})}>
            조회
          </button>
          {DRAW_TOOLS.map((t) => (
            <button key={t.id} className={'hts-tool' + (drawTool === t.id ? ' on' : '')} onClick={() => setDrawTool(t.id)} title={t.menu}>
              {t.label}
            </button>
          ))}
          <button
            className={'hts-tool' + (magnet ? ' on' : '')}
            onClick={() => {
              setMagnet((v) => {
                const next = !v;
                patchWin({chartView: {...(win.chartView || {}), magnet: next, selectedPane: selPane}});
                return next;
              });
            }}
            title="자석: 봉 시고저종에 붙임"
          >
            자석
          </button>
          <button className={'hts-tool' + (win.yMode === 'percent' ? ' on' : '')} onClick={() => patchWin({yMode: win.yMode === 'percent' ? 'price' : 'percent'})} title="Y축 가격/등락률">
            {win.yMode === 'percent' ? '등락률' : '가격'}
          </button>
          <button className={'hts-tool' + (win.daySep ? ' on' : '')} onClick={() => patchWin({daySep: !win.daySep})} title="일 구분선">
            일선
          </button>
          <button className={'hts-tool' + (win.refLines?.prev ? ' on' : '')} onClick={() => patchWin({refLines: {...win.refLines, prev: !win.refLines?.prev}})} title="전일종가">
            전일
          </button>
          <button className={'hts-tool' + (win.refLines?.open ? ' on' : '')} onClick={() => patchWin({refLines: {...win.refLines, open: !win.refLines?.open}})} title="시가">
            시가
          </button>
          <button className={'hts-tool' + (win.refLines?.vi ? ' on' : '')} onClick={() => patchWin({refLines: {...win.refLines, vi: !win.refLines?.vi}})} title="VI 예상">
            VI
          </button>
          <button
            className="hts-tool"
            onClick={() => patchWin({drawings: (win.drawings || []).slice(0, -1)})}
            title="마지막 그림 삭제"
          >
            지우기
          </button>
        </div>
        {bars.length ? (
          <Chart
            data={bars}
            overlay={overlay}
            formulas={applied}
            patternFilters={patternFilters}
            delayContext={{
              ...(delayContext || {skip001N: 1.2, skip001Score: 50}),
              skip001N: applied.find((f) => f.id === 'skip001')?.variables?.N ?? delayContext?.skip001N ?? 1.2,
              strengthReady: enabled.has('cntrstr') ? strengthReady : true,
            }}
            strengthReady={enabled.has('cntrstr') ? strengthReady : true}
            strengthLabel={strengthNxt ? 'NXT 08:30' : 'KRX 09:00'}
            chartHeight={Math.max(160, (win.h || 380) - 56)}
            grid={grid}
            logScale={logScale}
            visibleHint={visibleBars}
            onVisibleCount={(n) => {
              if (Math.abs(n - viewCount) >= 1) setViewCount(n);
            }}
            onPick={(id) => {
              if (id && formulas.some((f) => f.id === id)) setEditId(id);
            }}
            drawings={win.drawings || []}
            drawTool={drawTool}
            magnet={magnet}
            seriesKey={`${code}|${timeframe}|${baseDate}`}
            viewState={win.chartView}
            onViewState={(s) => {
              patchWin({chartView: {...(win.chartView || {}), ...s, magnet, selectedPane: selPane}});
            }}
            paneById={paneById}
            selectedPane={selPane}
            onSelectPane={setSelPane}
            onMoveIndicator={(id, slot) => patchWin({indicatorPanes: {...paneById, [id]: slot}})}
            yMode={win.yMode === 'percent' ? 'percent' : 'price'}
            daySep={win.daySep}
            refLines={win.refLines}
            onDrawings={(next) => patchWin({drawings: next})}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({x: e.clientX, y: e.clientY});
            }}
          />
        ) : (
          <div className="empty-chart">{busy ? '조회 중…' : '종목코드를 입력하고 조회하세요. 가상 시세는 만들지 않습니다.'}</div>
        )}
        {menu && (
          <div className="ctx-menu" style={{left: menu.x, top: menu.y}} onMouseLeave={() => setMenu(null)}>
            <div className="g"><b>도구</b>
              {DRAW_TOOLS.map((t) => (
                <button key={t.id} className={drawTool === t.id ? 'on' : ''} onClick={() => { setDrawTool(t.id); setMenu(null); }}>{t.menu}</button>
              ))}
              <button className={magnet ? 'on' : ''} onClick={() => { setMagnet((v) => !v); setMenu(null); }}>{magnet ? '자석 끄기' : '자석 켜기'}</button>
            </div>
            <div className="g"><b>표시</b>
              <button className={win.yMode === 'percent' ? 'on' : ''} onClick={() => { patchWin({yMode: win.yMode === 'percent' ? 'price' : 'percent'}); setMenu(null); }}>{win.yMode === 'percent' ? '가격축' : '등락률축'}</button>
              <button className={win.daySep ? 'on' : ''} onClick={() => { patchWin({daySep: !win.daySep}); setMenu(null); }}>일 구분선</button>
              <button className={win.refLines?.prev ? 'on' : ''} onClick={() => { patchWin({refLines: {...win.refLines, prev: !win.refLines?.prev}}); setMenu(null); }}>전일종가</button>
              <button className={win.refLines?.open ? 'on' : ''} onClick={() => { patchWin({refLines: {...win.refLines, open: !win.refLines?.open}}); setMenu(null); }}>시가</button>
              <button className={win.refLines?.vi ? 'on' : ''} onClick={() => { patchWin({refLines: {...win.refLines, vi: !win.refLines?.vi}}); setMenu(null); }}>VI 예상</button>
              <button className={formulaOpen ? 'on' : ''} onClick={() => { patchWin({formulaOpen: !formulaOpen}); setMenu(null); }}>수식 탭</button>
            </div>
            <div className="g"><b>주기</b>
              {TF.map((t) => (
                <button key={t.id} className={timeframe === t.id ? 'on' : ''} onClick={() => { patchWin({timeframe: t.id}); setMenu(null); }}>{t.label}</button>
              ))}
            </div>
            <div className="g"><b>데이터</b>
              <button disabled={busy || !/^\d{6}$/.test(codeText)} onClick={() => { void load({force: true}); setMenu(null); }}>조회</button>
              <button disabled={!hasMore || busy} onClick={() => { void load({append: true}); setMenu(null); }}>+이전</button>
              <button disabled={busy} onClick={() => { void load({strengthOnly: true, force: true}); setMenu(null); }}>{strengthReady ? '강도완료' : '강도+이전'}</button>
              <button onClick={() => { setOverlay([]); setMenu(null); }}>추종목 제거</button>
            </div>
            <div className="g"><b>그림</b>
              <button onClick={() => { patchWin({drawings: (win.drawings || []).slice(0, -1)}); setMenu(null); }}>마지막 지우기</button>
              <button onClick={() => { patchWin({drawings: []}); setMenu(null); }}>그림 모두 삭제</button>
            </div>
            <div className="g">
              <button onClick={() => setMenu(null)}>닫기</button>
            </div>
          </div>
        )}
        {editor && editor.kind !== 'function' && (
          <div className="formula-pop">
            <b>{editor.name}</b>
            <label>
              삭제
              <button
                onClick={() => {
                  const next = new Set(enabled);
                  next.delete(editor.id);
                  patchWin({enabledFormulas: [...next]});
                  setEditId(null);
                }}
              >
                차트에서 제거
              </button>
            </label>
            {Object.entries({...(editor.variables || {}), ...(varPatch[editor.id] || {})}).map(([key, value]) => (
              <label key={key}>
                {key}
                <input
                  defaultValue={value}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setVarPatch((prev) => ({...prev, [editor.id]: {...(prev[editor.id] || {}), [key]: n}}));
                    const next = formulas.map((f) =>
                      f.id === editor.id ? {...f, variables: {...(f.variables || {}), ...(varPatch[editor.id] || {}), [key]: n}} : f,
                    );
                    void fetch('/api/formulas', {
                      method: 'PUT',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({formulas: next}),
                    })
                      .then((r) => r.json().then((d) => ({ok: r.ok, d})))
                      .then(({ok, d}) => {
                        if (!ok) throw new Error(d.error || '저장 실패');
                        return onReload?.();
                      })
                      .catch((err) => setNotice(err instanceof Error ? err.message : '지표변수 저장 실패'));
                  }}
                />
              </label>
            ))}
            <button onClick={() => setEditId(null)}>닫기</button>
          </div>
        )}
      </div>
    </div>
  );
}
