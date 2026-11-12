import React, {useEffect, useRef, useState} from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  LineStyle,
  PriceScaleMode,
  CrosshairMode,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type LogicalRange,
} from 'lightweight-charts';
import type {Candle} from '../server/core';
import {seriesColors, type Formula} from '../shared/formula';
import {chartHub, corePercent, createChartRuntime} from '../shared/chart';
import './chart/register';
import {delayedAfterSkip, delayedExit, judgePattern, patternMarkerText} from '../shared/patternGate';
import {filtersFromFormulas, PATTERN_FILTERS, type DelayContext, type FilterEnabled} from '../shared/patternFilters';
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
  magnet = true,
  yMode = 'price',
  daySep,
  refLines,
  onDrawings,
  patternFilters,
  delayContext,
  strengthReady,
  strengthLabel,
  paneById,
  selectedPane = 0,
  onSelectPane,
  onMoveIndicator,
  viewState,
  onViewState,
  seriesKey,
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
  magnet?: boolean;
  yMode?: 'price' | 'percent';
  daySep?: boolean;
  refLines?: {prev?: boolean; open?: boolean; vi?: boolean};
  onDrawings?: (next: ChartDrawing[]) => void;
  patternFilters?: FilterEnabled;
  delayContext?: DelayContext;
  strengthReady?: boolean;
  strengthLabel?: string;
  paneById?: Record<string, number>;
  selectedPane?: number;
  onSelectPane?: (slot: number) => void;
  onMoveIndicator?: (id: string, slot: number) => void;
  viewState?: {from?: number; to?: number; paneStretch?: number[]; magnet?: boolean; selectedPane?: number};
  onViewState?: (s: {from: number; to: number; paneStretch?: number[]}) => void;
  seriesKey?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const extras = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
  const markersRef = useRef<{setMarkers: (m: SeriesMarker<UTCTimestamp>[]) => void} | null>(null);
  const rangeRef = useRef<LogicalRange | null>(
    viewState && Number.isFinite(viewState.from) && Number.isFinite(viewState.to)
      ? ({from: viewState.from as number, to: viewState.to as number} as LogicalRange)
      : null,
  );
  const viewCb = useRef(onViewState);
  viewCb.current = onViewState;
  const stretchRef = useRef(viewState?.paneStretch);
  const stretchApplied = useRef(0);
  const extraSlotsRef = useRef<number[]>([]);
  const paneIdxRef = useRef(new Map<number, number>([[0, 0]]));
  const legendFnRef = useRef<(slot: number) => {id: string; name: string; param: string; color: string}[]>(() => []);
  const meta = useRef({len: 0, first: 0});
  const hintRef = useRef(visibleHint);
  const countCb = useRef(onVisibleCount);
  const pickCb = useRef(onPick);
  const formulasRef = useRef(formulas);
  const dataRef = useRef(data);
  const overlayRef = useRef(overlay);
  const overlaySeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const scaleLock = useRef(false);
  const seriesKeyRef = useRef(seriesKey);
  const fitScale = useRef(false);
  const skipSync = useRef(false);
  if (seriesKey && seriesKey !== seriesKeyRef.current) {
    seriesKeyRef.current = seriesKey;
    fitScale.current = true;
    skipSync.current = true;
    rangeRef.current = null;
    meta.current = {len: 0, first: 0};
  }
  const logRef = useRef(logScale);
  const gridRef = useRef(grid);
  const drawToolRef = useRef(drawTool);
  const magnetRef = useRef(magnet);
  const drawingsRef = useRef(drawings);
  const onDrawingsRef = useRef(onDrawings);
  const yModeRef = useRef(yMode);
  yModeRef.current = yMode;
  const refLinesRef = useRef(refLines);
  refLinesRef.current = refLines;
  const priceLinesRef = useRef<{remove?: () => void}[]>([]);
  const pendingRef = useRef<{t: number; p: number} | null>(null);
  const runtimeRef = useRef(createChartRuntime('desk-chart'));
  const valuesById = useRef<Record<string, (number | null)[]>>({});
  const paneByIdRef = useRef(paneById);
  paneByIdRef.current = paneById;
  const [frame, setFrame] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [legends, setLegends] = useState<{slot: number; top: number; height: number; items: {id: string; name: string; param: string; color: string}[]}[]>([]);
  hintRef.current = visibleHint;
  countCb.current = onVisibleCount;
  pickCb.current = onPick;
  formulasRef.current = formulas;
  dataRef.current = data;
  overlayRef.current = overlay;
  logRef.current = logScale;
  gridRef.current = grid;
  drawToolRef.current = drawTool;
  magnetRef.current = magnet;
  drawingsRef.current = drawings;
  onDrawingsRef.current = onDrawings;
  const formulaSig = formulas
    .filter((f) => f.enabled)
    .map((f) => `${f.id}:${f.name}:${f.expression}:${JSON.stringify(f.variables || {})}:${f.pane || ''}:${f.paneShare || ''}:${paneById?.[f.id] ?? ''}`)
    .join('|');
  const filterSig = patternFilters ? Object.keys(patternFilters).filter((k) => patternFilters[k]).join(',') : '';
  const dataSig = data.length ? `${data.length}:${data[0].time}:${data[data.length - 1].close}:${data[data.length - 1].time}` : '0';
  const overlaySig = overlay?.length ? `${overlay.length}:${overlay[0].time}` : '0';
  const height = Math.max(120, chartHeight);

  const emitView = (save = true) => {
    const chart = chartRef.current as (IChartApi & {panes?: () => {getHeight?: () => number}[]}) | null;
    if (!chart) return;
    let stretch: number[] | undefined;
    try {
      const panes = chart.panes?.() || [];
      const hs = panes.map((p) => p.getHeight?.() || 1);
      const sum = hs.reduce((a, b) => a + b, 0) || 1;
      stretch = hs.map((h) => h / sum);
      stretchRef.current = stretch;
      let top = 0;
      const order = [0, ...extraSlotsRef.current];
      setLegends(
        order.map((slot, i) => {
          const pi = paneIdxRef.current.get(slot) ?? i;
          const ph = panes[pi]?.getHeight?.() || Math.max(72, Math.round(height / Math.max(1, order.length)));
          const row = {slot, top, height: ph, items: legendFnRef.current(slot)};
          top += ph;
          return row;
        }),
      );
    } catch {
      /* view */
    }
    syncAllPriceScales();
    if (!save) return;
    const range = rangeRef.current;
    if (range) viewCb.current?.({from: Number(range.from), to: Number(range.to), paneStretch: stretch});
  };

  const syncAllPriceScales = () => {
    if (scaleLock.current || skipSync.current) return;
    type ScaleVis = {
      getVisibleRange?: () => {from: number; to: number} | null;
      setVisibleRange?: (r: {from: number; to: number}) => void;
      setAutoScale?: (on: boolean) => void;
    };
    const chart = chartRef.current;
    const over = overlaySeriesRef.current;
    const oBars = overlayRef.current;
    const bars = dataRef.current;
    if (!chart || !over || !oBars?.length || !bars.length) return;
    const right = chart.priceScale('right') as ScaleVis;
    const left = over.priceScale() as ScaleVis;
    const rv = right.getVisibleRange?.();
    const o0 = oBars[0].close;
    const m0 = bars[0].close;
    if (!rv || !(o0 > 0) || !(m0 > 0)) return;
    const pctOn = yModeRef.current === 'percent';
    const next = pctOn
      ? {from: rv.from, to: rv.to}
      : {from: (o0 * rv.from) / m0, to: (o0 * rv.to) / m0};
    if (!(next.to > next.from)) return;
    if (!pctOn && (next.from <= 0 || next.to <= 0 || rv.from <= 0 || rv.to <= 0)) return;
    scaleLock.current = true;
    try {
      left.setAutoScale?.(false);
      left.setVisibleRange?.(next);
    } catch {
      /* scale */
    }
    scaleLock.current = false;
  };

  const applyRefLines = () => {
    const series = candleRef.current;
    const bars = dataRef.current;
    if (!series || !bars.length) return;
    for (const line of priceLinesRef.current) {
      try {
        (series as ISeriesApi<'Candlestick'> & {removePriceLine?: (l: unknown) => void}).removePriceLine?.(line);
      } catch {
        /* line */
      }
    }
    priceLinesRef.current = [];
    const pctOn = yModeRef.current === 'percent';
    const refPx = bars[0].close > 0 ? bars[0].close : 1;
    const ax = (px: number) => corePercent(px, refPx, pctOn);
    const dayKey = (t: number) => {
      const d = new Date((t + 9 * 3600) * 1000);
      return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    };
    const hourKst = (t: number) => new Date((t + 9 * 3600) * 1000).getUTCHours();
    const today = dayKey(bars[bars.length - 1].time);
    const same = bars.filter((c) => dayKey(c.time) === today);
    const openBar = same.find((c) => hourKst(c.time) >= 9) || same[0] || bars[0];
    const openPx = openBar.open;
    const addPx = (price: number, color: string, title: string, dashed = false) => {
      const line = series.createPriceLine({
        price: ax(price),
        color,
        lineWidth: 1,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title,
      });
      priceLinesRef.current.push(line);
    };
    const refs = refLinesRef.current;
    if (refs?.open) addPx(openPx, '#6ab0c8', '시가');
    if (refs?.prev) {
      const prev = bars.find((c) => c.previousDay?.close)?.previousDay?.close;
      if (prev) addPx(prev, '#e8bd64', '전일');
    }
    if (refs?.vi && openPx > 0) {
      addPx(openPx * 1.1, '#ed6b72', 'VI+10', true);
      addPx(openPx * 0.9, '#5d96e8', 'VI-10', true);
    }
  };

  const paint = () => {
    const chart = chartRef.current;
    const series = candleRef.current;
    const bars = dataRef.current;
    const formulas = formulasRef.current;
    const overlay = overlayRef.current;
    if (!chart || !series || !bars.length) return;
    if (fitScale.current) {
      fitScale.current = false;
      rangeRef.current = null;
      meta.current = {len: 0, first: 0};
      skipSync.current = true;
      window.setTimeout(() => {
        skipSync.current = false;
      }, 400);
    }
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
    runtimeRef.current.paintAddons({bars, formulas, paneById: paneByIdRef.current});
    const pctOn = yModeRef.current === 'percent';
    const refPx = bars[0].close > 0 ? bars[0].close : 1;
    const ax = (px: number) => corePercent(px, refPx, pctOn);
    series.applyOptions({
      priceFormat: pctOn
        ? {type: 'custom', minMove: 0.01, formatter: (p: number) => `${p.toFixed(2)}%`}
        : {type: 'price', precision: 0, minMove: 1},
    });
    const highlights = formulas.filter((f) => f.enabled && f.kind === 'highlight').map((f) => ({formula: f, values: chartHub.evaluate(f.expression, bars, f.variables, formulas)}));
    series.setData(
      bars.map((c, i) => {
        const h = highlights.find((item) => item.values[i]);
        return {
          time: c.time as UTCTimestamp,
          open: ax(c.open),
          high: ax(c.high),
          low: ax(c.low),
          close: ax(c.close),
          ...(h ? {color: h.formula.color, wickColor: h.formula.color} : {}),
        };
      }),
    );
    overlaySeriesRef.current = null;
    if (overlay?.length) {
      const o0 = overlay[0].close > 0 ? overlay[0].close : 1;
      const line = chart.addSeries(LineSeries, {
        color: '#e8bd64',
        lineWidth: 1,
        title: '추',
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: pctOn ? 'right' : 'left',
      });
      chart.applyOptions({leftPriceScale: {visible: !pctOn, borderVisible: false}});
      line.setData(
        overlay.map((c) => ({
          time: c.time as UTCTimestamp,
          value: pctOn ? corePercent(c.close, o0, true) : c.close,
        })),
      );
      extras.current.push(line);
      overlaySeriesRef.current = line;
    } else {
      chart.applyOptions({leftPriceScale: {visible: false}});
    }
    applyRefLines();
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    const inds = formulas.filter((x) => x.enabled && x.kind === 'indicator');
    const slotOf: Record<string, number> = {};
    const valMap: Record<string, (number | null)[]> = {};
    const pxMid = (() => {
      const px = bars.map((c) => c.close).filter((c) => c > 0).sort((a, b) => a - b);
      return px.length ? px[Math.floor(px.length / 2)] : 0;
    })();
    const pinHit: Record<number, number> = {};
    for (const f of inds) {
      const p = paneByIdRef.current?.[f.id];
      if (typeof p === 'number' && p > 0) pinHit[p] = (pinHit[p] || 0) + 1;
    }
    for (const f of inds) {
      const values = chartHub.evaluate(f.expression, bars, f.variables, formulas);
      valMap[f.id] = values;
      const pinned = paneByIdRef.current?.[f.id];
      const sample = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v !== 0);
      const mv = sample.length ? Math.abs([...sample].sort((a, b) => a - b)[Math.floor(sample.length / 2)]) : 0;
      const priceLike = mv > 0 && pxMid > 0 && mv > pxMid * 0.2 && mv < pxMid * 4;
      const separate = f.pane === 'separate' || (!priceLike && f.pane !== 'price');
      if (!separate) {
        slotOf[f.id] = 0;
        continue;
      }
      if (f.paneShare === 'overlay') {
        slotOf[f.id] = typeof pinned === 'number' && pinned > 0 ? pinned : 1;
        continue;
      }
      if (typeof pinned === 'number' && pinned > 0 && pinHit[pinned] === 1) {
        slotOf[f.id] = pinned;
        continue;
      }
      slotOf[f.id] = -1;
    }
    const taken = new Set(Object.values(slotOf).filter((s) => s > 0));
    let next = 1;
    for (const f of inds) {
      if (slotOf[f.id] !== -1) continue;
      while (taken.has(next)) next += 1;
      slotOf[f.id] = next;
      taken.add(next);
      next += 1;
    }
    valuesById.current = valMap;
    const extraSlots = [...new Set(Object.values(slotOf).filter((s) => s > 0))].sort((a, b) => a - b);
    const chartEx = chart as IChartApi & {
      panes: () => {getHeight?: () => number; paneIndex?: () => number; setStretchFactor?: (n: number) => void}[];
      removePane: (n: number) => void;
    };
    let have = 1;
    try {
      have = Math.max(1, chartEx.panes?.().length || 1);
    } catch {
      have = 1;
    }
    const need = 1 + extraSlots.length;
    while (have < need) {
      try {
        chart.addPane();
        have += 1;
      } catch {
        break;
      }
    }
    while (have > need) {
      try {
        chartEx.removePane(have - 1);
        have -= 1;
      } catch {
        break;
      }
    }
    const paneIdx = new Map<number, number>([[0, 0]]);
    extraSlots.forEach((s, i) => paneIdx.set(s, i + 1));
    extraSlotsRef.current = extraSlots;
    paneIdxRef.current = paneIdx;
    try {
      const panes = chartEx.panes?.() || [];
      const saved = stretchRef.current;
      if (saved && saved.length === panes.length) {
        panes.forEach((p, i) => p.setStretchFactor?.(Math.max(0.15, saved[i] || 1)));
      } else if (!saved || saved.length !== panes.length) {
        if (!saved) {
          panes[0]?.setStretchFactor?.(Math.max(2, extraSlots.length + 1));
          for (let i = 1; i < panes.length; i++) panes[i]?.setStretchFactor?.(1);
        }
      }
      stretchApplied.current = panes.length;
    } catch {
      /* stretch */
    }
    for (const f of formulas.filter((x) => x.enabled && x.kind !== 'function')) {
      const values = valMap[f.id] || chartHub.evaluate(f.expression, bars, f.variables, formulas);
      if (f.kind === 'indicator') {
        const separate = (slotOf[f.id] ?? 0) > 0;
        const paneIndex = paneIdx.get(slotOf[f.id] ?? 0) ?? 0;
        const lines = [{name: f.name, expression: f.expression, color: f.color, alternateColor: f.alternateColor, ...f.primaryLine, visible: f.primaryLine?.visible !== false}, ...(f.extraLines || [])];
        const styles = {solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted};
        let baselineAdded = false;
        while (((chartEx.panes?.() || []).length) <= paneIndex) {
          try {
            chart.addPane();
          } catch {
            break;
          }
        }
        const paneApi = (chartEx.panes?.() || [])[paneIndex] as {addSeries?: (def: unknown, opts: object) => ISeriesApi<'Line' | 'Histogram'>} | undefined;
        const putSeries = (def: typeof LineSeries | typeof HistogramSeries, opts: object) => {
          if (paneIndex > 0 && typeof paneApi?.addSeries === 'function') return paneApi.addSeries(def, opts);
          return chart.addSeries(def as typeof LineSeries, opts as never, paneIndex);
        };
        for (const lineSpec of lines.filter((l) => l.visible)) {
          const common = {
            title: (f.name || f.id).slice(0, 12),
            color: lineSpec.color,
            priceLineVisible: false,
            lastValueVisible: true,
            priceScaleId: 'right',
          };
          const line =
            lineSpec.type === 'histogram'
              ? putSeries(HistogramSeries, common)
              : putSeries(LineSeries, {...common, lineWidth: lineSpec.width || 1, lineStyle: styles[lineSpec.style || 'solid']});
          const vals = lineSpec.expression === f.expression ? values : chartHub.evaluate(lineSpec.expression, bars, f.variables, formulas);
          const colorSrc = lineSpec.colorMode === 'st' ? chartHub.evaluate(lineSpec.expression.replace(/^\s*ST\s*\(/i, 'STDIR('), bars, f.variables, formulas) : vals;
          const colors = seriesColors(colorSrc, lineSpec.color, lineSpec);
          const overlayPx = !separate && lineSpec.type !== 'histogram';
          line.setData(vals.map((value, i) => {
            const gap = value === null || (f.id === 'cntrstr' && (value === 0 || value === 50));
            if (gap) return {time: bars[i].time as UTCTimestamp};
            const v = overlayPx ? ax(value) : value;
            return {time: bars[i].time as UTCTimestamp, value: v, color: colors[i]};
          }));
          if (separate) {
            try {
              line.priceScale().applyOptions({
                visible: true,
                borderVisible: false,
                autoScale: true,
              });
            } catch {
              /* scale */
            }
          }
          extras.current.push(line);
          if (!baselineAdded) {
            for (const base of f.baselines || []) line.createPriceLine({price: base.value, color: base.color, lineWidth: base.width || 1, lineStyle: styles[base.style || 'dashed'], axisLabelVisible: true, title: '기준선'});
            baselineAdded = true;
          }
        }
      }
      if (PATTERN_FILTERS.some((p) => p.id === f.id)) continue;
      if (f.kind === 'signal' || f.kind === 'system') {
        const exits = f.kind === 'system' ? chartHub.evaluate(f.exitExpression, bars, f.variables, formulas) : [];
        const gates = filtersFromFormulas(formulas, patternFilters);
        let lastSkip = -1;
        bars.forEach((c, i) => {
          const step = bars.length >= 2 ? Math.max(60, bars[bars.length - 1].time - bars[bars.length - 2].time) : 60;
          if (c.time + step > Math.floor(Date.now() / 1000)) return;
          if (values[i] && exits[i]) return;
          if (f.kind !== 'system') {
            if (values[i]) markers.push({time: c.time as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: f.color, text: f.name});
            return;
          }
          const v = values[i] ? judgePattern(bars, i, gates, delayContext) : null;
          const late = lastSkip >= 0 && i > lastSkip ? delayedAfterSkip(bars, lastSkip, i, gates, delayContext) : null;
          if (late?.allow) {
            lastSkip = -1;
            markers.push({
              time: c.time as UTCTimestamp,
              position: 'belowBar',
              shape: 'arrowUp',
              color: f.color,
              text: patternMarkerText('buy', late),
            });
          } else if (v && !v.allow) {
            lastSkip = v.tag === '급등후횡보' ? -1 : i;
            markers.push({
              time: c.time as UTCTimestamp,
              position: 'belowBar',
              shape: 'arrowUp',
              color: '#718395',
              text: patternMarkerText('skip', v),
            });
          } else if (v?.allow) {
            lastSkip = -1;
            markers.push({
              time: c.time as UTCTimestamp,
              position: 'belowBar',
              shape: 'arrowUp',
              color: f.color,
              text: patternMarkerText('buy', v),
            });
          }
          if (exits[i]) markers.push({time: c.time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: '#ed6b72', text: '매도'});
          else if (f.kind === 'system') {
            const lateSell = delayedExit(bars, i, (j) => Boolean(exits[j]), gates);
            if (lateSell?.allow) markers.push({time: c.time as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: '#ed6b72', text: patternMarkerText('sell', lateSell)});
          }
        });
      }
    }
    legendFnRef.current = (slot: number) =>
      inds
        .filter((x) => slotOf[x.id] === slot)
        .map((x) => ({
          id: x.id,
          name: x.name,
          param: Object.entries(x.variables || {})
            .map(([k, v]) => `${k} ${v}`)
            .join(' '),
          color: x.color,
        }));
    emitView();
    requestAnimationFrame(emitView);
    const sorted = markers.sort((a, b) => Number(a.time) - Number(b.time));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(series, []);
    markersRef.current?.setMarkers(sorted);
    if (!rangeRef.current) {
      const hint = Math.min(bars.length, Math.max(20, hintRef.current || 200));
      rangeRef.current = {from: bars.length - hint, to: bars.length - 1} as LogicalRange;
    }
    chart.timeScale().setVisibleLogicalRange(rangeRef.current);
    if (skipSync.current) {
      const lows = bars.map((c) => ax(c.low)).filter((v) => Number.isFinite(v) && (pctOn || v > 0));
      const highs = bars.map((c) => ax(c.high)).filter((v) => Number.isFinite(v) && (pctOn || v > 0));
      if (lows.length && highs.length) {
        let lo = Math.min(...lows);
        let hi = Math.max(...highs);
        if (lo === hi) {
          lo = pctOn ? lo - 1 : lo * 0.99;
          hi = pctOn ? hi + 1 : hi * 1.01;
        }
        const pad = (hi - lo) * 0.06;
        lo = pctOn ? lo - pad : Math.max(0, lo - pad);
        try {
          const right = chart.priceScale('right') as {setAutoScale?: (on: boolean) => void; setVisibleRange?: (r: {from: number; to: number}) => void};
          right.setAutoScale?.(false);
          right.setVisibleRange?.({from: lo, to: hi + pad});
        } catch {
          /* fit */
        }
      }
    }
    requestAnimationFrame(() => syncAllPriceScales());
  };

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      height,
      layout: {background: {type: ColorType.Solid, color: '#111923'}, textColor: '#718395'},
      localization: {timeFormatter: (t: number | string | object) => new Date(Number(t) * 1000).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'})},
      grid: {vertLines: {color: '#1a2733', visible: gridRef.current}, horzLines: {color: '#1a2733', visible: gridRef.current}},
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: number | string | object) =>
          new Date(Number(t) * 1000).toLocaleTimeString('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false}),
      },
      rightPriceScale: {borderVisible: false, visible: true},
      crosshair: {
        mode: magnetRef.current ? CrosshairMode.MagnetOHLC : CrosshairMode.Normal,
        vertLine: {color: '#516576', labelVisible: true, labelBackgroundColor: '#1c2a35'},
        horzLine: {color: '#516576', labelVisible: true, labelBackgroundColor: '#1c2a35'},
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#ed6b72',
      downColor: '#5d96e8',
      borderVisible: false,
      wickUpColor: '#ed6b72',
      wickDownColor: '#5d96e8',
    });
    chart.priceScale('right').applyOptions({mode: PriceScaleMode.Normal});
    chart.subscribeCrosshairMove((param) => {
      const t = param.time !== undefined ? Number(param.time) : NaN;
      if (!Number.isFinite(t)) {
        setHoverIdx(-1);
        return;
      }
      const list = dataRef.current;
      let bi = -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i].time === t) {
          bi = i;
          break;
        }
      }
      setHoverIdx(bi);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      rangeRef.current = range;
      countCb.current?.(Math.max(1, Math.round((range.to as number) - (range.from as number))));
      setFrame((n) => n + 1);
      try {
        const panes = (chart as IChartApi & {panes: () => {getHeight?: () => number}[]}).panes?.() || [];
        const hs = panes.map((p) => p.getHeight?.() || 1);
        const sum = hs.reduce((a, b) => a + b, 0) || 1;
        viewCb.current?.({from: Number(range.from), to: Number(range.to), paneStretch: hs.map((h) => h / sum)});
      } catch {
        viewCb.current?.({from: Number(range.from), to: Number(range.to)});
      }
    });
    chart.subscribeClick((param) => {
      const tool = drawToolRef.current;
      let price = param.point && series.coordinateToPrice(param.point.y);
      let time = param.time !== undefined ? Number(param.time) : NaN;
      const barsNow = dataRef.current;
      if (magnetRef.current && barsNow.length && Number.isFinite(time) && price !== null && price !== undefined) {
        let bi = 0;
        let best = Infinity;
        for (let i = 0; i < barsNow.length; i++) {
          const d = Math.abs(barsNow[i].time - time);
          if (d < best) {
            best = d;
            bi = i;
          }
        }
        const b = barsNow[bi];
        time = b.time;
        const pctOn = yModeRef.current === 'percent';
        const refPx = barsNow[0].close > 0 ? barsNow[0].close : 1;
        const axp = (px: number) => (pctOn ? 100 * (px / refPx - 1) : px);
        const cands = [b.open, b.high, b.low, b.close].map(axp);
        price = cands.reduce((p, x) => (Math.abs(x - price!) < Math.abs(p - price!) ? x : p));
      }
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
      const title = param.hoveredSeries ? ((param.hoveredSeries as {options?: () => {title?: string}}).options?.().title ?? null) : null;
      const hit = title ? formulasRef.current.find((f) => f.id === title || f.name === title || f.name.slice(0, 12) === title) : null;
      pickCb.current?.(hit?.id ?? title);
    });
    chartRef.current = chart;
    candleRef.current = series;
    paint();
    const onPtr = (e: PointerEvent) => {
      if (e.type === 'pointermove' && e.buttons === 0) return;
      emitView(e.type !== 'pointermove');
    };
    const el = host.current;
    el.addEventListener('pointermove', onPtr);
    el.addEventListener('pointerup', onPtr);
    window.addEventListener('pointerup', onPtr, true);
    window.addEventListener('pointermove', onPtr, true);
    const ro = new ResizeObserver(() => {
      const box = host.current?.getBoundingClientRect();
      if (!box || box.width < 8 || box.height < 8) return;
      chart.applyOptions({width: Math.floor(box.width), height: Math.floor(box.height)});
      if (rangeRef.current) chart.timeScale().setVisibleLogicalRange(rangeRef.current);
      emitView();
    });
    ro.observe(el);
    return () => {
      emitView();
      el.removeEventListener('pointermove', onPtr);
      el.removeEventListener('pointerup', onPtr);
      window.removeEventListener('pointerup', onPtr, true);
      window.removeEventListener('pointermove', onPtr, true);
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
      crosshair: {mode: magnet ? CrosshairMode.MagnetOHLC : CrosshairMode.Normal},
    });
    chartRef.current?.priceScale('right').applyOptions({
      mode: logScale && yMode !== 'percent' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [grid, logScale, yMode, magnet]);

  useEffect(() => {
    paint();
  }, [dataSig, formulaSig, overlaySig, filterSig, strengthReady, yMode, logScale]);

  useEffect(() => {
    applyRefLines();
  }, [refLines?.vi, refLines?.open, refLines?.prev]);

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
  const allDraw = [...auto, ...drawings];
  const box = host.current?.getBoundingClientRect();
  const w = box?.width || 0;
  const hbox = box?.height || height;
  void frame;
  return (
    <div className="chart-host" style={{height, width: '100%', minHeight: 120, position: 'relative'}} onContextMenu={onContextMenu}>
      <div ref={host} className="chart" style={{height: '100%', width: '100%'}} />
      {legends.map((row) => (
        <div
          key={row.slot}
          className={'pane-legend' + (selectedPane === row.slot ? ' on' : '')}
          style={{top: row.top}}
        >
          <button
            className="lg pane-hit"
            title="패널 선택 · 여기로 드롭하면 오버레이"
            onClick={(e) => {
              e.stopPropagation();
              onSelectPane?.(row.slot);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              if (id) onMoveIndicator?.(id, row.slot);
            }}
          >
            {row.slot === 0 ? '가격' : `패널${row.slot}`}
          </button>
          {row.items.map((it) => {
            const raw = hoverIdx >= 0 ? valuesById.current[it.id]?.[hoverIdx] : undefined;
            const hv = typeof raw === 'number' && Number.isFinite(raw) ? raw.toFixed(2) : '';
            return (
              <button
                key={it.id}
                draggable
                className="lg"
                style={{color: it.color}}
                title="드래그하여 패널 이동 · 클릭하여 변수 수정"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPane?.(row.slot);
                  onPick?.(it.id);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', it.id);
                }}
              >
                {it.name}
                {it.param ? ` ${it.param}` : ''}
                {hv ? ` ${hv}` : ''}
              </button>
            );
          })}
        </div>
      ))}
      {formulas.some((f) => f.enabled && f.id === 'cntrstr') && strengthReady === false ? (
        <div className="strength-pending">체결강도 다운로드 중 · 최근봉→{strengthLabel || '세션 시작'} 확인 전 · 전략 미사용</div>
      ) : null}
      <svg className="chart-draw" width={w} height={hbox} style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
        {allDraw.map((d) => {
          if (d.kind === 'hline') {
            const a = xy(data[0]?.time || d.t1, d.p1);
            const b = xy(data[data.length - 1]?.time || d.t1, d.p1);
            const priceH = legends[0]?.height || hbox;
            if (!a || !b || a.y < 0 || a.y > priceH) return null;
            return <line key={d.id} x1={0} x2={w} y1={a.y} y2={a.y} stroke={d.color} />;
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
