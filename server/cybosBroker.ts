import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {join} from 'node:path';
import type {Candle} from './core';
import type {BrokerLike} from './realtime/hub';

type CybosReply = {
  ok?: boolean;
  held?: boolean;
  reason?: string;
  candles?: Candle[];
  hasMore?: boolean;
  nextKey?: string;
  admin?: boolean;
  connected?: boolean;
  bars?: number;
  ms?: number;
  codes?: string[];
  names?: Record<string, string>;
  units?: (CybosReply & {code?: string; ms?: number})[];
};

const WORKERS = 1;

/**
 * 64비트 파이썬 엔트리(scripts/cybos_hub.py). COM은 그 안에서만.
 * 관리자·연결 실패는 held. 창은 이 모듈을 직접 부르지 않는다.
 */
type Job = {resolve: (v: CybosReply) => void; reject: (e: Error) => void};

class CybosWorker {
  child: ChildProcessWithoutNullStreams | null = null;
  queue: Job[] = [];
  busy = 0;
  constructor(
    private readonly py: string,
    private readonly script: string,
  ) {}

  ask(body: Record<string, unknown>): Promise<CybosReply> {
    const child = this.ensure();
    this.busy += 1;
    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve: (v) => {
          this.busy = Math.max(0, this.busy - 1);
          resolve(v);
        },
        reject: (e) => {
          this.busy = Math.max(0, this.busy - 1);
          reject(e);
        },
      });
      child.stdin.write(`${JSON.stringify(body)}\n`);
    });
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.py, [this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'},
    });
    child.stdout.setEncoding('utf8');
    this.child = child;
    let buf = '';
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const job = this.queue.shift();
        if (!job) continue;
        try {
          job.resolve(JSON.parse(line) as CybosReply);
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error('CYBOS JSON'));
        }
      }
    });
    child.on('error', (e) => {
      this.child = null;
      while (this.queue.length) this.queue.shift()?.reject(e instanceof Error ? e : new Error('CYBOS spawn'));
    });
    child.on('exit', () => {
      this.child = null;
      while (this.queue.length) this.queue.shift()?.reject(new Error('CYBOS 프로세스 종료'));
    });
    child.stderr.on('data', () => {
      /* COM 로그 */
    });
    return child;
  }
}

export class CybosBroker implements BrokerLike {
  private readonly workers: CybosWorker[];
  private readonly py: string;
  private readonly script: string;
  private readonly names = new Map<string, string>();
  private readonly listCache = new Map<string, {at: number; codes: string[]}>();

  constructor(opts: {python?: string; cwd?: string} = {}) {
    this.py = opts.python || process.env.CYBOS_PYTHON32 || process.env.CYBOS_PYTHON || 'python';
    this.script = join(opts.cwd || process.cwd(), 'scripts', 'cybos_hub.py');
    this.workers = Array.from({length: WORKERS}, () => new CybosWorker(this.py, this.script));
  }

  private pick(): CybosWorker {
    return this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b));
  }

  async chartPages(
    codes: string[],
    input: {timeframe: string; summary?: boolean; strength?: boolean} = {timeframe: '1'},
  ): Promise<{code: string; candles: Candle[]; bars: number; ok: boolean; reason?: string}[]> {
    const chunks: string[][] = Array.from({length: Math.min(WORKERS, Math.max(1, codes.length))}, () => []);
    codes.forEach((c, i) => chunks[i % chunks.length]!.push(c));
    const parts = await Promise.all(
      chunks.map((part, i) =>
        part.length
          ? this.workers[i]!.ask({
              op: input.strength ? 'strengths' : 'charts',
              codes: part,
              timeframe: input.timeframe,
              summary: Boolean(input.summary),
              workers: 4,
            })
          : Promise.resolve({units: []} as CybosReply),
      ),
    );
    return parts.flatMap((r) =>
      (r.units || []).map((u) => ({
        code: u.code || '',
        candles: u.candles || [],
        bars: u.bars || (u.candles || []).length,
        ok: Boolean(u.ok),
        reason: u.reason,
        ms: u.ms || 0,
        name: this.names.get(u.code || '') || u.code || '',
      })),
    );
  }

  nameOf(code: string): string {
    return this.names.get(code) || code;
  }

  async candles(code: string): Promise<Candle[]> {
    const p = await this.chartPage({code, timeframe: '1'});
    return p.candles;
  }

  async daily(code: string, baseDate: string): Promise<{date: string; open?: number; high?: number; low?: number; close?: number}[]> {
    const p = await this.chartPage({code, timeframe: 'D', baseDate});
    return p.candles.map((c) => {
      const d = new Date((c.time + 9 * 3600) * 1000);
      const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      return {date: ymd, open: c.open, high: c.high, low: c.low, close: c.close};
    });
  }

  async chartPage(input: {
    code: string;
    timeframe: string;
    baseDate?: string;
    nextKey?: string;
    singlePage?: boolean;
  }): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string}> {
    const r = await this.ask({op: 'chart', ...input});
    if (!r.ok) throw new Error(r.reason || 'CYBOS 차트 실패');
    return {candles: r.candles || [], hasMore: Boolean(r.hasMore), nextKey: r.nextKey || ''};
  }

  async attachStrength(
    code: string,
    timeframe: string,
    candles: Candle[],
    nextKey?: string,
  ): Promise<{candles: Candle[]; hasMore: boolean; nextKey: string; ready: boolean; nxt: boolean}> {
    const r = await this.ask({op: 'strength', code, timeframe, nextKey});
    const got = r.candles || [];
    const byTime = new Map(got.map((c) => [c.time, c]));
    const merged = candles.map((c) => {
      const s = byTime.get(c.time);
      return s && typeof s.strength === 'number' ? {...c, strength: s.strength} : c;
    });
    return {candles: merged.length ? merged : got, hasMore: Boolean(r.hasMore), nextKey: r.nextKey || '', ready: !r.hasMore, nxt: true};
  }

  async status(): Promise<CybosReply> {
    return this.ask({op: 'status'});
  }

  async listCodes(count: number, market: 'kospi' | 'kosdaq' | 'both' = 'both'): Promise<string[]> {
    const hit = this.listCache.get(market);
    if (hit && Date.now() - hit.at < 6 * 3600_000 && hit.codes.length) {
      return hit.codes.slice(0, Math.max(1, count));
    }
    const r = await this.ask({op: 'list', count, market});
    const codes = Array.isArray(r.codes) ? r.codes.filter((c) => /^\d{6}$/.test(c)) : [];
    const names = r.names || {};
    for (const [k, v] of Object.entries(names)) this.names.set(k, v);
    this.listCache.set(market, {at: Date.now(), codes});
    return codes;
  }

  async marketEye(codes: string[]): Promise<{code: string; price?: number; strength?: number}[]> {
    const r = await this.ask({op: 'eye', codes});
    if (!r.ok) throw new Error(r.reason || 'MarketEye 실패');
    const rows = (r as CybosReply & {rows?: {code: string; price?: number; strength?: number}[]}).rows;
    return Array.isArray(rows) ? rows : [];
  }

  private ask(body: Record<string, unknown>): Promise<CybosReply> {
    return this.pick().ask(body);
  }
}

export function routedBroker(trade: BrokerLike, bulk: BrokerLike): BrokerLike {
  return {
    candles: (code) => bulk.candles(code),
    daily: (code, d) => bulk.daily(code, d),
    chartPage: (input) => (bulk.chartPage ? bulk.chartPage(input) : trade.chartPage!(input)),
    attachStrength: (c, tf, bars, k) =>
      bulk.attachStrength ? bulk.attachStrength(c, tf, bars, k) : trade.attachStrength!(c, tf, bars, k),
    stockName: (code) => (trade.stockName ? trade.stockName(code) : Promise.resolve(code)),
  };
}
