import React, {useEffect, useMemo, useState} from 'react';
import type {Candle} from '../server/core';
import type {Formula} from '../shared/formula';
import type {ChildWindow, VirtualDesk} from '../shared/desk';
import {Chart} from './ChartView';

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
  onCommonCode,
  patternFilters,
  delayContext,
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
  onCommonCode?: (code: string) => void;
  patternFilters?: import('../shared/patternFilters').FilterEnabled;
  delayContext?: import('../shared/patternFilters').DelayContext;
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
  const [busy, setBusy] = useState(false);
  const [viewCount, setViewCount] = useState(win.visibleBars || 200);
  const [overlay, setOverlay] = useState<Candle[]>([]);
  const [mode, setMode] = useState<'replace' | 'overlay'>((win as {compareMode?: 'replace' | 'overlay'}).compareMode || 'replace');
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [drawTool, setDrawTool] = useState('cursor');
  const timeframe = win.timeframe || '1';
  const baseDate = win.baseDate || '';
  const visibleBars = win.visibleBars || 200;
  const formulaOpen = win.formulaOpen !== false;
  const enabled = new Set(win.enabledFormulas ?? formulas.filter((f) => f.enabled && f.kind !== 'system').map((f) => f.id));

  useEffect(() => setCodeText(code), [code]);
  useEffect(() => {
    if (rankingName) setName(rankingName);
  }, [rankingName]);

  const load = async (opts: {code?: string; timeframe?: string; baseDate?: string; append?: boolean; overlay?: boolean; force?: boolean} = {}) => {
    const useCode = opts.code ?? codeText;
    if (!/^\d{6}$/.test(useCode)) return;
    const coolKey = `${useCode}|${opts.timeframe ?? timeframe}|${opts.baseDate ?? baseDate}|${opts.append ? 'a' : '1'}`;
    if (!opts.append && !opts.force && chartTooSoon(coolKey) && bars.length) return;
    setBusy(true);
    try {
      const d = await post('/api/chart', {
        code: useCode,
        timeframe: opts.timeframe ?? timeframe,
        baseDate: opts.baseDate ?? baseDate,
        nextKey: opts.append ? nextKey : '',
        strengthNextKey: opts.append ? strengthNextKey : '',
        withStrength: enabled.has('cntrstr') && (opts.timeframe ?? timeframe) !== 'D' && (opts.timeframe ?? timeframe) !== 'W' && (opts.timeframe ?? timeframe) !== 'M',
      });
      setName(d.name && d.name !== useCode ? d.name : d.name || useCode);
      const next = d.candles || [];
      if (opts.overlay) setOverlay(next);
      else setBars((prev) => (opts.append ? mergeBars(prev, next) : next.length ? next : prev));
      setHasMore(Boolean(d.hasMore) || Boolean(d.strengthHasMore));
      setNextKey(d.nextKey || '');
      setStrengthNextKey(d.strengthNextKey || '');
      setStrengthReady(Boolean(d.strengthReady));
      setStrengthNxt(Boolean(d.strengthNxt));
      if (d.warning) setNotice(String(d.warning));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (/^\d{6}$/.test(code)) void load({code});
  }, [code, timeframe, baseDate]);

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

  const applied = formulas.map((f) => ({...f, enabled: enabled.has(f.id)}));
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
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    patchWin({enabledFormulas: [...next]});
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
      <div className="chart-main">
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
          <button className="hts-tool" disabled={!hasMore || busy} onClick={() => void load({append: true})} title="이전 페이지 추가">
            +이전
          </button>
          <button className="hts-tool" disabled={busy || !/^\d{6}$/.test(codeText)} onClick={() => void load({force: true})}>
            조회
          </button>
          {([
            ['cursor', '선택'],
            ['hline', '수평'],
            ['vline', '수직'],
            ['trend', '추세'],
            ['text', '메모'],
            ['target', '목표'],
            ['stop', '손절'],
            ['entry', '진입'],
          ] as const).map(([id, label]) => (
            <button key={id} className={'hts-tool' + (drawTool === id ? ' on' : '')} onClick={() => setDrawTool(id)} title={label}>
              {label}
            </button>
          ))}
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
            data={strengthReady ? bars : bars.map((c) => ({...c, strength: undefined}))}
            overlay={overlay}
            formulas={applied}
            patternFilters={patternFilters}
            delayContext={{...(delayContext || {skip001N: 1.2, skip001Score: 50}), strengthReady}}
            strengthReady={strengthReady}
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
            <button onClick={() => patchWin({formulaOpen: true})}>수식 탭</button>
            <button onClick={() => patchWin({timeframe: '1'})}>1분봉</button>
            <button onClick={() => patchWin({timeframe: 'D'})}>일봉</button>
            <button onClick={() => patchWin({timeframe: 'W'})}>주봉</button>
            <button onClick={() => patchWin({timeframe: 'M'})}>월봉</button>
            <button onClick={() => setOverlay([])}>추종목 제거</button>
            <button onClick={() => { setDrawTool('hline'); setMenu(null); }}>수평선</button>
            <button onClick={() => { setDrawTool('vline'); setMenu(null); }}>수직선</button>
            <button onClick={() => { setDrawTool('trend'); setMenu(null); }}>추세선</button>
            <button onClick={() => { setDrawTool('text'); setMenu(null); }}>텍스트</button>
            <button onClick={() => { setDrawTool('target'); setMenu(null); }}>목표선</button>
            <button onClick={() => { setDrawTool('stop'); setMenu(null); }}>손절선</button>
            <button onClick={() => { setDrawTool('entry'); setMenu(null); }}>진입마크</button>
            <button onClick={() => { patchWin({drawings: []}); setMenu(null); }}>그림 모두 삭제</button>
            <button onClick={() => setMenu(null)}>닫기</button>
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
            {Object.entries(editor.variables || {}).map(([key, value]) => (
              <label key={key}>
                {key}
                <input defaultValue={value} onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) {
                    /* variables live on the shared formula set; open 수식 관리자 to persist */
                    setNotice('지표변수 저장은 수식 관리자에서 합니다.');
                  }
                }} />
              </label>
            ))}
            <button onClick={() => setEditId(null)}>닫기</button>
          </div>
        )}
      </div>
    </div>
  );
}
