import {readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync} from 'node:fs';
import {join} from 'node:path';
import type {Candle} from './core';
import {aggregateTickBars} from '../shared/ticks';

const barCache = new Map<string, {mtimeMs: number; bars: Candle[]}>();

export function clearBarCache() {
  barCache.clear();
}
const CACHE_MAX = 400;
const MINUTE_TAIL_BYTES = 96 * 1024;
const MINUTE_MAX_BARS = 800;

function cacheSet(key: string, value: {mtimeMs: number; bars: Candle[]}) {
  if (barCache.has(key)) barCache.delete(key);
  barCache.set(key, value);
  while (barCache.size > CACHE_MAX) {
    const oldest = barCache.keys().next().value;
    if (oldest === undefined) break;
    barCache.delete(oldest);
  }
}

function readCsvTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  if (size <= maxBytes) return readFileSync(file, 'utf8');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function barsDir(): string {
  return process.env.BARS_DIR || join(process.cwd(), 'data', 'bars');
}

function parseTime(raw: string): number {
  const t = raw.trim();
  if (/^\d{14}$/.test(t)) {
    const ms = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+09:00`);
    return Number.isFinite(ms) ? ms / 1000 : NaN;
  }
  if (/^\d{8}$/.test(t)) {
    const ms = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T09:00:00+09:00`);
    return Number.isFinite(ms) ? ms / 1000 : NaN;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

export function parseBarFile(text: string): Candle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const out: Candle[] = [];
  for (const line of lines) {
    const parts = line.split(/[, \t]+/);
    if (parts[0]?.toLowerCase().includes('time') || parts[0]?.includes('일자')) continue;
    if (parts.length < 5) continue;
    const time = parseTime(parts[0]);
    const open = Number(parts[1]), high = Number(parts[2]), low = Number(parts[3]), close = Number(parts[4]);
    const volume = parts[5] !== undefined ? Number(parts[5]) : undefined;
    const marketCap = parts[6] !== undefined ? Number(parts[6]) : undefined;
    if (!Number.isFinite(time) || !(open > 0) || !(close > 0) || high < low) continue;
    out.push({
      time, open, high, low, close,
      ...(Number.isFinite(volume) ? {volume} : {}),
      ...(Number.isFinite(marketCap) && marketCap > 0 ? {marketCap} : {}),
    });
  }
  const sorted = out.sort((a, b) => a.time - b.time).filter((x, i, a) => i === 0 || x.time !== a[i - 1].time);
  let cap: number | undefined;
  for (const c of sorted) {
    if (typeof c.marketCap === 'number' && c.marketCap > 0) cap = c.marketCap;
    else if (cap) c.marketCap = cap;
  }
  return sorted;
}

export function listLocalCodes(tf: 'D' | '1' = 'D'): string[] {
  const dir = join(barsDir(), tf);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.replace(/\.(csv|txt)$/i, ''))
    .filter((c) => /^\d{6}$/.test(c));
}

export function loadLocalBars(code: string, tf: string): Candle[] {
  if (!/^\d{6}$/.test(code)) return [];
  const native = tf === 'D' || tf === 'W' || tf === 'M' ? 'D' : '1';
  const file = ['csv', 'txt'].map((ext) => join(barsDir(), native, `${code}.${ext}`)).find((p) => existsSync(p));
  if (!file) return [];
  const mtimeMs = statSync(file).mtimeMs;
  const cacheKey = `${file}:${native}`;
  const hit = barCache.get(cacheKey);
  let bars: Candle[];
  if (hit && hit.mtimeMs === mtimeMs) bars = hit.bars;
  else {
    const raw = native === '1' ? readCsvTail(file, MINUTE_TAIL_BYTES) : readFileSync(file, 'utf8');
    bars = parseBarFile(raw);
    if (native === '1' && bars.length > MINUTE_MAX_BARS) bars = bars.slice(-MINUTE_MAX_BARS);
    cacheSet(cacheKey, {mtimeMs, bars});
  }
  if (tf === 'D' || tf === '1' || tf.startsWith('T')) return bars;
  const minutes = Number(tf);
  if (!Number.isFinite(minutes) || minutes <= 1) return bars;
  const bucket = minutes * 60;
  const groups = new Map<number, Candle[]>();
  for (const b of bars) {
    const key = Math.floor(b.time / bucket) * bucket;
    const g = groups.get(key) || [];
    g.push(b);
    groups.set(key, g);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  const flat: Candle[] = [];
  for (const g of ordered) {
    const last = g[g.length - 1];
    flat.push({
      time: last.time,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: last.close,
      volume: g.every((x) => typeof x.volume === 'number') ? g.reduce((s, x) => s + (x.volume || 0), 0) : undefined,
    });
  }
  void aggregateTickBars;
  return flat;
}
