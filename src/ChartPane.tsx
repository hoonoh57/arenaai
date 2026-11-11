import React, {useEffect, useMemo, useState} from 'react';
import type {Candle} from '../server/core';
import type {Formula} from '../shared/formula';
import type {ChildWindow, VirtualDesk} from '../shared/desk';
import {Chart} from './ChartView';

const TF = [
  {id: '1', label: '1분'},
  {id: '3', label: '3분'},
  {id: '5', label: '5분'},
  {id: '10', label: '10분'},
  {id: '15', label: '15분'},
  {id: '30', label: '30분'},
  {id: '60', label: '60분'},
  {id: 'D', label: '일봉'},
];

async function post(path: string, body?: unknown) {
  const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '요청 실패');
  return d;
}

function mergeBars(oldBars: Candle[], incoming: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const bar of [...oldBars, ...incoming]) map.set(bar.time, bar);
  return [...map.values()].sort((a, b) => a.time - b.time);
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
}) {
  const code = win.locked ? win.code || '' : desk.vars.code || win.code || '';
  const [codeText, setCodeText] = useState(code);
  const [name, setName] = useState(rankingName || '');
  const [bars, setBars] = useState<Candle[]>(cached);
  const [nextKey, setNextKey] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const timeframe = win.timeframe || '1';
  const baseDate = win.baseDate || '';
  const visibleBars = win.visibleBars || 200;
  const formulaOpen = win.formulaOpen !== false;
  const enabled = new Set(win.enabledFormulas ?? formulas.filter((f) => f.enabled && f.kind !== 'function').map((f) => f.id));

  useEffect(() => setCodeText(code), [code]);
  useEffect(() => {
    if (rankingName) setName(rankingName);
  }, [rankingName]);

  const load = async (opts: {code?: string; timeframe?: string; baseDate?: string; append?: boolean} = {}) => {
    const useCode = opts.code ?? codeText;
    if (!/^\d{6}$/.test(useCode)) return;
    setBusy(true);
    try {
      const d = await post('/api/chart', {
        code: useCode,
        timeframe: opts.timeframe ?? timeframe,
        baseDate: opts.baseDate ?? baseDate,
        nextKey: opts.append ? nextKey : '',
      });
      setName(d.name || useCode);
      setBars((prev) => (opts.append ? mergeBars(prev, d.candles || []) : d.candles || []));
      setHasMore(Boolean(d.hasMore));
      setNextKey(d.nextKey || '');
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
    if (next.length === 6 || next === '') {
      patchWin({code: next || undefined});
      if (!win.locked) onCommonCode?.(next);
    }
  };

  const shown = bars.slice(Math.max(0, bars.length - visibleBars));
  const applied = formulas.map((f) => (f.kind === 'function' ? f : {...f, enabled: enabled.has(f.id)}));
  const groups = [
    {kind: 'indicator', label: '지표'},
    {kind: 'signal', label: '신호'},
    {kind: 'highlight', label: '강세'},
    {kind: 'system', label: '전략'},
  ] as const;

  return (
    <div className={'chart-work' + (formulaOpen ? ' dock-on' : '')}>
      <aside className="chart-dock">
        <div className="dock-head">수식</div>
        {groups.map((g) => (
          <div key={g.kind} className="dock-group">
            <b>{g.label}</b>
            {formulas.filter((f) => f.kind === g.kind).map((f) => (
              <label key={f.id} className="dock-item">
                <input
                  type="checkbox"
                  checked={enabled.has(f.id)}
                  onChange={() => {
                    const next = new Set(enabled);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    patchWin({enabledFormulas: [...next]});
                  }}
                />
                <span style={{color: f.color || '#cfe3d3'}}>{f.name}</span>
              </label>
            ))}
            {!formulas.some((f) => f.kind === g.kind) && <small>없음</small>}
          </div>
        ))}
      </aside>
      <div className="chart-main">
        <div className="chart-toolbar" onMouseDown={(e) => e.stopPropagation()}>
          <button className="dock-toggle" title="수식 탭" onClick={() => patchWin({formulaOpen: !formulaOpen})}>
            {formulaOpen ? '⟨' : '⟩'}
          </button>
          <input className="code-in" value={codeText} maxLength={6} placeholder="종목" onChange={(e) => commitCode(e.target.value)} />
          <span className="chart-name">{name || '종목명'}</span>
          <select
            value={timeframe}
            onChange={(e) => {
              patchWin({timeframe: e.target.value});
            }}
          >
            {TF.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={baseDate}
            onChange={(e) => patchWin({baseDate: e.target.value})}
          />
          <span className="bar-count">
            {shown.length}/{bars.length}
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
          <button className="hts-tool" disabled={busy || !/^\d{6}$/.test(codeText)} onClick={() => void load()}>
            조회
          </button>
        </div>
        {shown.length ? (
          <Chart data={shown} formulas={applied} chartHeight={Math.max(160, (win.h || 380) - 72)} grid={grid} logScale={logScale} />
        ) : (
          <div className="empty-chart">{busy ? '조회 중…' : '종목코드를 입력하고 조회하세요. 가상 시세는 만들지 않습니다.'}</div>
        )}
      </div>
    </div>
  );
}
