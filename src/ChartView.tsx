import React, {useEffect, useRef, useState} from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  LineStyle,
  PriceScaleMode,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type LogicalRange,
} from 'lightweight-charts';
import type {Candle} from '../server/core';
import {evaluate, seriesColors, type Formula} from '../shared/formula';
import {delayedEntry, delayedExit, judgePattern, patternMarkerText} from '../shared/patternGate';
import type {DelayContext, FilterEnabled} from '../shared/patternFilters';
import type {ChartDrawing} from '../shared/desk';

export function Chart({
  data,
  formulas,
  overlay,
  chartHeight,
  grid,
  logScale,
  visibleHint,
  onVisibleCount,
  onContextMenu,
  onPick,
  drawings = [],
  drawTool = 'cursor',
  yMode = 'price',
  daySep,
  refLines,
  onDrawings,
  patternFilters,
  delayContext,
}: {
  data: Candle[];
  formulas: Formula[];
  overlay?: Candle[];
  chartHeight: number;
  grid: boolean;
  logScale: boolean;
  visibleHint?: number;
  onVisibleCount?: (n: number) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPick?: (formulaId: string | null) => void;
  drawings?: ChartDrawing[];
  drawTool?: string;
  yMode?: 'price' | 'percent';
  daySep?: boolean;
  refLines?: {prev?: boolean; open?: boolean; vi?: boolean};
  onDrawings?: (next: ChartDrawing[]) => void;
  patternFilters?: FilterEnabled;
  delayContext?: DelayContext;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const extras = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
  const markersRef = useRef<{setMarkers: (m: SeriesMarker<UTCTimestamp>[]) => void} | null>(null);
  const rangeRef = useRef<LogicalRange | null>(null);
  const meta = useRef({len: 0, first: 0});
  const hintRef = useRef(visibleHint);
  const countCb = useRef(onVisibleCount);
  const pickCb = useRef(onPick);
  const formulasRef = useRef(formulas);
  const dataRef = useRef(data);
  const overlayRef = useRef(overlay);
  const logRef = useRef(logScale);
  const gridRef = useRef(grid);
  const drawToolRef = useRef(drawTool);
  const drawingsRef = useRef(drawings);
  const onDrawingsRef = useRef(onDrawings);
  const pendingRef = useRef<{t: number; p: number} | null>(null);
  const [frame, setFrame] = useState(0);
  hintRef.current = visibleHint;
  countCb.current = onVisibleCount;
  pickCb.current = onPick;
  formulasRef.current = formulas;
  dataRef.current = data;
  overlayRef.current = overlay;
  logRef.current = logScale;
  gridRef.current = grid;
  drawToolRef.current = drawTool;
  drawingsRef.current = drawings;
  onDrawingsRef.current = onDrawings;
  const formulaSig = formulas.filter((f) => f.enabled).map((f) => f.id).join(',');
  const filterSig = patternFilters ? Object.keys(patternFilters).filter((k) => patternFilters[k]).join(',') : '';
  const dataSig = data.length ? `${data.length}:${data[0].time}:${data[data.length - 1].close}:${data[data.length - 1].time}` : '0';
  const overlaySig = overlay?.length ? `${overlay.length}:${overlay[0].time}` : '0';
  const height = Math.max(120, chartHeight);

  const paint = () => {
    const chart = chartRef.current;
    const series = candleRef.current;
    const bars = dataRef.current;
    const formulas = formulasRef.current;
    const overlay = overlayRef.current;
    if (!chart || !series || !bars.length) return;
    const prepend = meta.current.first !== 0 && bars[0].time < meta.current.first;
    const added = prepend ? Math.max(0, bars.length - meta.current.len) : 0;
    if (rangeRef.current && added) {
      rangeRef.current = {from: (rangeRef.current.from as number) + added, to: (rangeRef.current.to as number) + added} as LogicalRange;
    }
    meta.current = {len: bars.length, first: bars[0].time};
    for (const extra of extras.current) {
      try {
        chart.removeSeries(extra);
      } catch {
        /* gone */
      }
    }
    extras.current = [];
    const highlights = formulas.filter((f) => f.enabled && f.kind === 'highlight').map((f) => ({formula: f, values: evaluate(f.expression, bars, f.variables, formulas)}));
    series.setData(
      bars.map((c, i) => {
        const h = highlights.find((item) => item.values[i]);
        return {...c, time: c.time as UTCTimestamp, ...(h ? {color: h.formula.color, wickColor: h.formula.color} : {})};
      }),
    );
    if (overlay?.length) {
      const line = chart.addSeries(LineSeries, {color: '#e8bd64', lineWidth: 1, title: '추', priceLineVisible: false, lastValueVisible: true, priceScaleId: 'left'});
      chart.applyOptions({leftPriceScale: {visible: true, borderVisible: false}});
      line.setData(overlay.map((c) => ({time: c.time as UTCTimestamp, value: c.close})));
      extras.current.push(line);
    }
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const f of formulas.filter((x) => x.enabled && x.kind !== 'function')) {
      const values = evaluate(f.expression, bars, f.variables, formulas);
      if (f.kind === 'indicator') {
        const paneIndex = f.pane === 'separate' ? chart.addPane().paneIndex() : 0;
        const lines = [{name: f.name, expression: f.expression, color: f.color, alternateColor: f.alternateColor, ...f.primaryLine, visible: f.primaryLine?.visible !== false}, ...(f.extraLines || [])];
        const styles = {solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted};
        let baselineAdded = false;
        for (const lineSpec of lines.filter((l) => l.visible)) {
          const common = {title: f.id, color: lineSpec.color, priceLineVisible: false, lastValueVisible: false};
          const line =
            lineSpec.type === 'histogram'
              ? chart.addSeries(HistogramSeries, common, paneIndex)
              : chart.addSeries(LineSeries, {...common, lineWidth: lineSpec.width || 1, lineStyle: styles[lineSpec.style || 'solid']}, paneIndex);
          const vals = lineSpec.expression === f.expression ? values : evaluate(lineSpec.expression, bars, f.variables, formulas);
          const colorSrc = lineSpec.colorMode === 'st' ? evaluate(lineSpec.expression.replace(/^\s*ST\s*\(/i, 'STDIR('), bars, f.variables, formulas) : vals;
          const colors = seriesColors(colorSrc, lineSpec.color, lineSpec);
          line.setData(vals.map((value, i) => (value === null ? {time: bars[i].time as UTCTimestamp} : {time: bars[i].time as UTCTimestamp, value, color: colors[i]})));
          extras.current.push(line);
          if (!baselineAdded) {
            for (const base of f.baselines || []) line.createPriceLine({price: base.value, color: base.color, lineWidth: base.width || 1, lineStyle: styles[base.style || 'dashed'], axisLabelVisible: true, title: '기준선'});
            baselineAdded = true;
          }
        }
      }
      if (f.kind === 'signal' || f.kind === 'system') {
        const exits = f.kind === 'system' ? evaluate(f.exitExpression, bars, f.variables, formulas) : [];
        let lastSkip = -1;
        let delayedUsed = false;
        bars.forEach((c, i) => {
          const step = bars.length >= 2 ? Math.max(60, bars[bars.length - 1].time - bars[bars.length - 2].time) : 60;
          if (c.time + step > Math.floor(Date.now() / 1000)) return;
          if (values[i] && exits[i]) return;
          if (values[i]) {
            if (f.kind === 'system') {
              const v = judgePattern(bars, i, patternFilters, delayContext);
              const late = !v.allow && lastSkip >= 0 && !delayedUsed ? delayedEntry(bars, i, (j) => Boolean(values[j]), patternFilters, delayContext) : null;
              const take = v.allow || Boolean(late?.allow);
              if (take) {
                lastSkip = -1;
                if (late?.allow) delayedUsed = true;
              } else if (v.tag !== '급등후횡보') lastSkip = i;
              else lastSkip = -1;
              const shown = late?.allow ? late : v;
              markers.push({
                time: c.time as UTCTimestamp,
                position: 'belowBar',
                shape: 'arrowUp',
                color: take ? f.color : '#718395',
                text: patternMarkerText(take ? 'buy' : 'skip', shown),
              });
            } else markers.push({time: c.time as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: f.color, text: f.name});
          } else if (f.kind === 'system' && lastSkip >= 0 && !delayedUsed) {
            const late = delayedEntry(bars, i, (j) => Boolean(values[j]), patternFilters, delayContext);
            if (late?.allow) {
              delayedUsed = true;
              lastSkip = -1;
              markers.push({
                time: c.time as UTCTimestamp,
                position: 'belowBar',
                shape: 'arrowUp',
                color: f.color,
                text: patternMarkerText('buy', late),
              });
            }
          }
          if (exits[i]) markers.push({time: c.time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: '#ed6b72', text: '매도'});
          else if (f.kind === 'system') {
            const lateSell = delayedExit(bars, i, (j) => Boolean(exits[j]), patternFilters);
            if (lateSell?.allow) markers.push({time: c.time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: '#ed6b72', text: patternMarkerText('sell', lateSell)});
          }
        });
      }
    }
    const sorted = markers.sort((a, b) => Number(a.time) - Number(b.time));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(series, []);
    markersRef.current?.setMarkers(sorted);
    if (!rangeRef.current) {
      const hint = Math.min(bars.length, Math.max(20, hintRef.current || 200));
      rangeRef.current = {from: bars.length - hint, to: bars.length - 1} as LogicalRange;
    }
    chart.timeScale().setVisibleLogicalRange(rangeRef.current);
  };

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      height,
      layout: {background: {type: ColorType.Solid, color: '#111923'}, textColor: '#718395'},
      localization: {timeFormatter: (t: number | string | object) => new Date(Number(t) * 1000).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'})},
      grid: {vertLines: {color: '#1a2733', visible: gridRef.current}, horzLines: {color: '#1a2733', visible: gridRef.current}},
      rightPriceScale: {borderVisible: false},
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: number | string | object) =>
          new Date(Number(t) * 1000).toLocaleTimeString('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false}),
      },
      crosshair: {vertLine: {color: '#516576'}, horzLine: {color: '#516576'}},
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#ed6b72',
      downColor: '#5d96e8',
      borderVisible: false,
      wickUpColor: '#ed6b72',
      wickDownColor: '#5d96e8',
    });
    chart.priceScale('right').applyOptions({mode: logRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal});
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      rangeRef.current = range;
      countCb.current?.(Math.max(1, Math.round((range.to as number) - (range.from as number))));
      setFrame((n) => n + 1);
    });
    chart.subscribeClick((param) => {
      const tool = drawToolRef.current;
      const price = param.point && series.coordinateToPrice(param.point.y);
      const time = param.time !== undefined ? Number(param.time) : NaN;
      if (tool && tool !== 'cursor' && Number.isFinite(time) && price !== null && price !== undefined) {
        const color = tool === 'stop' ? '#ed6b72' : tool === 'target' ? '#a8ec6a' : tool === 'entry' ? '#e8bd64' : '#b9ef78';
        const make = (kind: ChartDrawing['kind'], extra: Partial<ChartDrawing> = {}): ChartDrawing => ({
          id: `${kind}-${Date.now()}`,
          kind,
          t1: time,
          p1: price,
          color,
          ...extra,
        });
        if (tool === 'trend') {
          if (!pendingRef.current) pendingRef.current = {t: time, p: price};
          else {
            const a = pendingRef.current;
            pendingRef.current = null;
            onDrawingsRef.current?.([...(drawingsRef.current || []), make('trend', {t2: time, p2: price, t1: a.t, p1: a.p})]);
          }
        } else if (tool === 'text') {
          const text = window.prompt('메모', '') || '';
          if (text) onDrawingsRef.current?.([...(drawingsRef.current || []), make('text', {text})]);
        } else if (tool === 'hline' || tool === 'vline' || tool === 'target' || tool === 'stop' || tool === 'entry') {
          onDrawingsRef.current?.([...(drawingsRef.current || []), make(tool)]);
        }
        return;
      }
      const id = param.hoveredSeries ? ((param.hoveredSeries as {options?: () => {title?: string}}).options?.().title ?? null) : null;
      pickCb.current?.(id);
    });
    chartRef.current = chart;
    candleRef.current = series;
    paint();
    const ro = new ResizeObserver(() => {
      const box = host.current?.getBoundingClientRect();
      if (!box || box.width < 8 || box.height < 8) return;
      chart.applyOptions({width: Math.floor(box.width), height: Math.floor(box.height)});
      if (rangeRef.current) chart.timeScale().setVisibleLogicalRange(rangeRef.current);
    });
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      extras.current = [];
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      grid: {vertLines: {visible: grid}, horzLines: {visible: grid}},
    });
    chartRef.current?.priceScale('right').applyOptions({
      mode: yMode === 'percent' ? PriceScaleMode.Percentage : logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [grid, logScale, yMode]);

  useEffect(() => {
    paint();
  }, [dataSig, formulaSig, overlaySig, filterSig]);

  const chart = chartRef.current;
  const series = candleRef.current;
  const xy = (time: number, price: number) => {
    if (!chart || !series) return null;
    const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    const y = series.priceToCoordinate(price);
    if (x === null || y === null) return null;
    return {x, y};
  };
  const auto: ChartDrawing[] = [];
  if (daySep && data.length) {
    let day = 0;
    for (const c of data) {
      const d = new Date((c.time + 9 * 3600) * 1000);
      const key = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      if (key !== day) {
        day = key;
        auto.push({id: `day-${key}`, kind: 'vline', t1: c.time, p1: c.close, color: '#3a4a55'});
      }
    }
  }
  if (data.length && refLines?.open) {
    const last = data[data.length - 1];
    const ld = new Date((last.time + 9 * 3600) * 1000);
    const key = ld.getUTCFullYear() * 10000 + (ld.getUTCMonth() + 1) * 100 + ld.getUTCDate();
    const open = data.find((c) => {
      const d = new Date((c.time + 9 * 3600) * 1000);
      return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate() === key;
    });
    if (open) auto.push({id: 'open-ref', kind: 'hline', t1: open.time, p1: open.open, color: '#6ab0c8'});
  }
  if (data.length && refLines?.prev) {
    const prev = data.find((c) => c.previousDay?.close)?.previousDay?.close;
    if (prev) auto.push({id: 'prev-ref', kind: 'hline', t1: data[0].time, p1: prev, color: '#e8bd64'});
  }
  if (data.length && refLines?.vi) {
    const prev = data.find((c) => c.previousDay?.close)?.previousDay?.close || data[0].close;
    auto.push({id: 'vi-up', kind: 'hline', t1: data[0].time, p1: prev * 1.1, color: '#ed6b72'});
    auto.push({id: 'vi-dn', kind: 'hline', t1: data[0].time, p1: prev * 0.9, color: '#5d96e8'});
  }
  const allDraw = [...auto, ...drawings];
  const box = host.current?.getBoundingClientRect();
  const w = box?.width || 0;
  const hbox = box?.height || height;
  void frame;
  return (
    <div className="chart-host" style={{height, width: '100%', minHeight: 120, position: 'relative'}} onContextMenu={onContextMenu}>
      <div ref={host} className="chart" style={{height: '100%', width: '100%'}} />
      <svg className="chart-draw" width={w} height={hbox} style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
        {allDraw.map((d) => {
          if (d.kind === 'hline') {
            const a = xy(data[0]?.time || d.t1, d.p1);
            const b = xy(data[data.length - 1]?.time || d.t1, d.p1);
            if (!a || !b) return null;
            return <line key={d.id} x1={0} x2={w} y1={a.y} y2={a.y} stroke={d.color} strokeDasharray={d.id.startsWith('vi') ? '4 3' : undefined} />;
          }
          if (d.kind === 'vline') {
            const a = xy(d.t1, d.p1);
            if (!a) return null;
            return <line key={d.id} x1={a.x} x2={a.x} y1={0} y2={hbox} stroke={d.color} strokeDasharray="3 3" />;
          }
          if (d.kind === 'trend' && d.t2 !== undefined && d.p2 !== undefined) {
            const a = xy(d.t1, d.p1);
            const b = xy(d.t2, d.p2);
            if (!a || !b) return null;
            return <line key={d.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={d.color} strokeWidth={1.5} />;
          }
          if (d.kind === 'text') {
            const a = xy(d.t1, d.p1);
            if (!a) return null;
            return (
              <text key={d.id} x={a.x} y={a.y} fill={d.color} fontSize={11}>
                {d.text}
              </text>
            );
          }
          const a = xy(d.t1, d.p1);
          if (!a) return null;
          const mark = d.kind === 'entry' ? '●' : d.kind === 'stop' ? '▼' : '▲';
          return (
            <text key={d.id} x={a.x} y={a.y} fill={d.color} fontSize={12}>
              {mark}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
