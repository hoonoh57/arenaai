import React, {useEffect, useRef} from 'react';
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
  hintRef.current = visibleHint;
  countCb.current = onVisibleCount;
  pickCb.current = onPick;
  formulasRef.current = formulas;
  dataRef.current = data;
  overlayRef.current = overlay;
  logRef.current = logScale;
  gridRef.current = grid;
  const formulaSig = formulas.filter((f) => f.enabled).map((f) => f.id).join(',');
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
        bars.forEach((c, i) => {
          if (c.time + 60 > Math.floor(Date.now() / 1000)) return;
          if (values[i] && exits[i]) return;
          if (values[i]) markers.push({time: c.time as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: f.color, text: f.kind === 'system' ? '매수' : f.name});
          if (exits[i]) markers.push({time: c.time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: '#ed6b72', text: '매도'});
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
    });
    chart.subscribeClick((param) => {
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
    chartRef.current?.priceScale('right').applyOptions({mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal});
  }, [grid, logScale]);

  useEffect(() => {
    paint();
  }, [dataSig, formulaSig, overlaySig]);

  return <div ref={host} className="chart" style={{height, width: '100%', minHeight: 120}} onContextMenu={onContextMenu} />;
}
