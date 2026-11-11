import React, {useEffect, useRef} from 'react';
import {createChart, ColorType, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp} from 'lightweight-charts';
import type {Candle} from '../server/core';

const COLORS = ['#ed6b72', '#5d96e8', '#e8bd64', '#a8ec6a'];

async function loadBars(code: string, timeframe: string): Promise<Candle[]> {
  const r = await fetch('/api/chart', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code, timeframe})});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '차트 실패');
  return d.candles || [];
}

export function VerifyCompare({
  codes,
  names,
  searchAt,
  timeframe,
}: {
  codes: string[];
  names: Record<string, string>;
  searchAt: number;
  timeframe: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !codes.length) return;
    const chart = createChart(el, {
      height: 220,
      layout: {background: {type: ColorType.Solid, color: '#0e151e'}, textColor: '#9eb4c4'},
      grid: {vertLines: {color: '#1c2a38'}, horzLines: {color: '#1c2a38'}},
      rightPriceScale: {borderColor: '#30404b'},
      timeScale: {borderColor: '#30404b', timeVisible: timeframe !== 'D'},
    });
    chartRef.current = chart;
    const series: ISeriesApi<'Line'>[] = [];
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const bars = await loadBars(code, timeframe).catch(() => []);
        if (cancelled) return;
        const from = bars.filter((c) => c.time >= searchAt);
        const base = from[0]?.close;
        if (!(base > 0)) continue;
        const line = chart.addSeries(LineSeries, {color: COLORS[i % COLORS.length], lineWidth: 2, title: names[code] || code});
        line.setData(from.map((c) => ({time: c.time as UTCTimestamp, value: ((c.close / base) - 1) * 100})));
        series.push(line);
        if (i === 0) {
          line.createPriceLine({price: 0, color: '#718395', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '검색'});
        }
      }
    })();
    const ro = new ResizeObserver(() => chart.applyOptions({width: el.clientWidth}));
    ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [codes.join(','), searchAt, timeframe]);

  if (!codes.length) return null;
  return (
    <div>
      <div className="v16-picked">
        {codes.map((c, i) => (
          <span key={c} style={{color: COLORS[i % COLORS.length]}}>{names[c] || c} {c}</span>
        ))}
      </div>
      <p className="editor-hint">검색시점 종가=0%. 세로(검색)는 0% 점선. 이후 종가 등락률로 비교합니다.</p>
      <div ref={host} />
    </div>
  );
}
