import {COORD_CLOCK, COORD_STATES, type CoordEvent, type CoordPhase, type CoordSnapshot, type CoordState, type CoordStock} from '../../shared/coordinator';
import type {CybosBroker} from '../cybosBroker';

const MAX_EVENTS = 400;

export class Coordinator {
  private phase: CoordPhase = 'idle';
  private halt = false;
  private readonly stocks = new Map<string, CoordStock>();
  private events: CoordEvent[] = [];

  constructor(private readonly cybos: CybosBroker) {}

  snapshot(): CoordSnapshot {
    const counts = Object.fromEntries(COORD_STATES.map((s) => [s, 0])) as Record<CoordState, number>;
    for (const s of this.stocks.values()) counts[s.state] += 1;
    return {
      role: {desk: '중앙관리자(책상·창)', coordinator: '허브 감독 모듈'},
      phase: this.phase,
      clockLabel: COORD_CLOCK[this.phase],
      halt: this.halt,
      stocks: [...this.stocks.values()].sort((a, b) => b.at - a.at),
      events: this.events.slice(-200).reverse(),
      counts,
    };
  }

  reset(): CoordSnapshot {
    this.phase = 'idle';
    this.halt = false;
    this.stocks.clear();
    this.events = [];
    this.log('idle', '감독 초기화');
    return this.snapshot();
  }

  setPhase(phase: CoordPhase, note: string): CoordSnapshot {
    if (this.halt && phase !== 'idle') return this.snapshot();
    this.phase = phase;
    this.log(phase, note);
    return this.snapshot();
  }

  haltNow(note: string): CoordSnapshot {
    this.halt = true;
    this.phase = 'halt';
    for (const s of this.stocks.values()) {
      if (s.state === 'trading' || s.state === 'live') this.transit(s.code, 'halted', note);
    }
    this.log('halt', note);
    return this.snapshot();
  }

  resume(note: string): CoordSnapshot {
    this.halt = false;
    this.phase = 'ready_wait';
    this.log('ready_wait', note);
    return this.snapshot();
  }

  detect(codes: {code: string; name?: string}[], note: string): CoordSnapshot {
    if (this.halt) return this.snapshot();
    this.phase = 'nxt_scan';
    for (const row of codes) {
      const code = row.code.replace(/\D/g, '').slice(0, 6);
      if (!/^\d{6}$/.test(code) || this.stocks.has(code)) continue;
      this.stocks.set(code, {
        code,
        name: row.name || this.cybos.nameOf(code),
        state: 'detected',
        bars: 0,
        ms: 0,
        note,
        at: Date.now(),
      });
      this.log('nxt_scan', note, code, undefined, 'detected');
    }
    return this.snapshot();
  }

  async downloadReady(): Promise<CoordSnapshot> {
    if (this.halt) return this.snapshot();
    const list = [...this.stocks.values()].filter((s) => s.state === 'detected' || s.state === 'downloading').map((s) => s.code);
    if (!list.length) {
      this.log('downloading', '다운로드할 detected 없음');
      return this.snapshot();
    }
    this.phase = 'downloading';
    for (const c of list) this.transit(c, 'downloading', 'CYBOS 분봉');
    const pages = await this.cybos.chartPages(list, {timeframe: '1', summary: true});
    const by = new Map(pages.map((p) => [p.code, p]));
    for (const c of list) {
      const p = by.get(c);
      const bars = p?.bars || 0;
      const ok = Boolean(p?.ok && bars > 0);
      const why = (p?.reason || '봉 없음').replace(/\s+/g, ' ').slice(0, 80);
      this.transit(c, ok ? 'ready' : 'excluded', ok ? `봉 ${bars} · ${p?.ms || 0}ms` : why);
      const s = this.stocks.get(c);
      if (s) {
        s.bars = bars;
        s.ms = p?.ms || 0;
        s.name = p?.name || s.name;
      }
    }
    this.phase = 'ready_wait';
    this.log('ready_wait', `ready ${this.count('ready')} · excluded ${this.count('excluded')}`);
    return this.snapshot();
  }

  private count(st: CoordState): number {
    return [...this.stocks.values()].filter((s) => s.state === st).length;
  }

  private transit(code: string, to: CoordState, note: string): void {
    const s = this.stocks.get(code);
    if (!s) return;
    const from = s.state;
    s.state = to;
    s.note = note;
    s.at = Date.now();
    this.log(this.phase, note, code, from, to);
  }

  private log(phase: CoordPhase, note: string, code?: string, from?: CoordState, to?: CoordState): void {
    this.events.push({at: Date.now(), phase, code, from, to, note});
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
  }
}
