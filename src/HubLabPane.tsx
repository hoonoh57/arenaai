import React, {useEffect, useRef, useState} from 'react';
import {LAB_PARAM_DEFAULT, LAB_PARAM_FIELDS, LAB_PARAM_PRESETS, clampLabParams, type LabParams} from '../shared/hubLabParams';

type LabCase = {id: string; title: string; group: string};
type LabReport = {
  at: number;
  scope: string;
  params?: LabParams;
  results: {
    id: string;
    title: string;
    group: string;
    ms: number;
    targetMs: number;
    ok: boolean;
    pass: boolean;
    onTarget?: boolean;
    gapMs?: number;
    detail: string;
    constraints: number;
    units?: {code: string; name?: string; ms: number; ok: boolean; bars?: number; firstAt?: string; firstClose?: number; lastAt?: string; lastClose?: number; simulated?: boolean; waitMs?: number; held?: boolean}[];
    perTargetMs?: number;
  }[];
  bottlenecks: string[];
  missingOfficial?: string[];
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  return `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`;
}

function estimateCaseMs(id: string, p: LabParams): number {
  const rest = Math.max(p.restDelayMs, 8) + p.restIntervalMs;
  const batches = Math.ceil(p.codes / Math.max(1, p.chartConcurrency));
  if (id === 'ensureChartPage') return batches * rest;
  if (id === 'ensureStrengthPage') return batches * rest * 2;
  if (id === 'liveMany' || id === 'applyLiveTick' || id === 'applyLiveQuote') return Math.max(30, p.codes * p.ticks * 0.2);
  if (id === 'conditionMany' || id === 'conditionOne' || id === 'planWatch') return Math.max(20, p.conditions * p.captured * 0.05);
  if (id === 'evaluateSignals') return Math.max(20, p.codes * 2);
  if (id === 'orderDuplicate' || id === 'orderOverLimit') return Math.max(15, p.orders * 2);
  return 80;
}

function workText(id: string, title: string, p: LabParams): string {
  if (id === 'ensureChartPage') return `${title}: ${p.codes}종목 분봉을 허브가 받는 중 (병렬 ${p.chartConcurrency}, 간격 ${p.restIntervalMs}ms)`;
  if (id === 'ensureStrengthPage') return `${title}: ${p.codes}종목 체결강도 1장씩 허브 큐`;
  if (id === 'liveMany') return `${title}: ${p.codes}종목 × ${p.ticks}틱 × 피드 ${p.feedsPerCode}`;
  if (id === 'applyLiveTick' || id === 'applyLiveQuote') return `${title}: 최근 봉에 체결 ${p.ticks}회`;
  if (id === 'conditionMany') return `${title}: 조건 ${p.conditions} × 포착 ${p.captured}`;
  if (id === 'conditionOne' || id === 'planWatch') return `${title}: 포착 ${p.captured}를 감시 ${p.watchBudget} 슬롯에 편성`;
  if (id === 'orderDuplicate' || id === 'orderOverLimit') return `${title}: 주문 ${p.orders}회 / 보유한도 ${p.maxPositions}`;
  if (id === 'chartRefreshBudget') return `${title}: 종목 ${p.codes} · 주기 ${p.refreshMs}ms vs REST 예산`;
  if (id === 'demandWindowCap') return `${title}: 창 ${p.windows}개가 한 허브를 쓰는지`;
  if (id === 'evaluateSignals') return `${title}: ${p.codes}종목 신호`;
  return `${title} 실행 중`;
}

type Overlay = {
  kind: 'run' | 'load' | 'done' | 'error';
  title: string;
  work?: string;
  i?: number;
  n?: number;
  elapsed?: number;
  eta?: number;
  expected?: number;
  log?: {title: string; ms: number; pass: boolean; detail: string; targetMs?: number}[];
};

type Quota = {
  rest: {used: number; left: number; cap: number; refillPerSecond: number; waitForOneMs: number; cooldownMs: number; acquired: number; maxWaitMs: number};
  wss: {used: number; left: number; cap: number; packet: number};
};

type UnitLive = {
  idle?: boolean;
  unit?: string;
  done?: number;
  total?: number;
  lastCode?: string;
  lastOk?: boolean;
  lastMs?: number;
  avgMs?: number;
  etaMs?: number;
  parallel?: number;
  note?: string;
};

async function j<T>(url: string, init?: RequestInit, timeoutMs = 0): Promise<T> {
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? window.setTimeout(() => ac.abort(), timeoutMs) : 0;
  try {
    const r = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...init, signal: ac.signal});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`한도 ${timeoutMs}ms를 넘겨 끊었습니다. 16종목 분봉이 수 분이 걸리면 실패입니다. 추가 테스트가 아니라 이 병목부터 고치세요.`);
    }
    throw e;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

export function HubLabPane() {
  const [cases, setCases] = useState<LabCase[]>([]);
  const [reports, setReports] = useState<LabReport[]>([]);
  const [current, setCurrent] = useState<LabReport | null>(null);
  const [pick, setPick] = useState<'all' | string>('all');
  const [params, setParams] = useState<LabParams>(LAB_PARAM_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const [unit, setUnit] = useState<UnitLive | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [inspect, setInspect] = useState<null | {
    loading?: boolean;
    err?: string;
    code?: string;
    name?: string;
    bars?: number;
    strengthBars?: number;
    firstAt?: string;
    lastAt?: string;
    issues?: string[];
    quote?: {price: number; strength?: number; at?: string} | null;
    candles?: {at: string; open: number; high: number; low: number; close: number; volume: number; strength: number | null}[];
  }>(null);
  const runStarted = useRef(0);
  const caseStarted = useRef(0);

  useEffect(() => {
    if (!overlay || (overlay.kind !== 'run' && overlay.kind !== 'load')) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [overlay?.kind]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const d = await fetch('/api/hub/lab/live').then((r) => r.json());
        if (stop) return;
        if (d.quota) setQuota(d.quota);
        if (overlay?.kind === 'run' && !d.idle) setUnit(d);
      } catch {
        /* */
      }
    };
    const id = window.setInterval(() => void pull(), 200);
    void pull();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [overlay?.kind, overlay?.title]);

  const load = async (silent = false) => {
    if (!silent) {
      setBusy(true);
      setOverlay({kind: 'load', title: '저장 보고서를 읽는 중'});
    }
    try {
      const d = await j<{cases: LabCase[]; reports: LabReport[]}>('/api/hub/lab');
      setCases(d.cases);
      setReports(d.reports);
      if (d.reports[0]) setCurrent(d.reports[0]);
    } finally {
      if (!silent) {
        setBusy(false);
        setOverlay(null);
      }
    }
  };

  useEffect(() => {
    void load().catch((e) => {
      setErr((e as Error).message);
      setOverlay({kind: 'error', title: (e as Error).message});
      setBusy(false);
    });
  }, []);

  const run = async (id: 'all' | string) => {
    const bodyParams = clampLabParams(params);
    const queue = id === 'all' ? cases : cases.filter((c) => c.id === id);
    if (!queue.length) {
      setOverlay({kind: 'error', title: '실행할 기능이 없습니다'});
      return;
    }
    setBusy(true);
    setErr('');
    const log: Overlay['log'] = [];
    const expectedAll = queue.reduce((s, c) => s + estimateCaseMs(c.id, bodyParams), 0);
    runStarted.current = Date.now();
    const merged: LabReport = {
      at: Date.now(),
      scope: id,
      params: bodyParams,
      results: [],
      bottlenecks: [],
    };
    try {
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        const expected = estimateCaseMs(c.id, bodyParams);
        const remainExpect = queue.slice(i).reduce((s, x) => s + estimateCaseMs(x.id, bodyParams), 0);
        caseStarted.current = Date.now();
        setOverlay({
          kind: 'run',
          title: c.title,
          work: workText(c.id, c.title, bodyParams),
          i: i + 1,
          n: queue.length,
          elapsed: 0,
          eta: remainExpect,
          expected,
          log,
        });
        const report = await j<LabReport>(
          '/api/hub/lab',
          {method: 'POST', body: JSON.stringify({id: c.id, params: bodyParams})},
          bodyParams.deadlineMs + Math.ceil(bodyParams.codes / Math.max(1, bodyParams.chartConcurrency)) * 4000 + 8000,
        );
        const row = report.results[0];
        const per = row?.perTargetMs ?? bodyParams.deadlineMs;
        if (row?.units?.length) {
          for (const u of row.units) {
            log.push({
              title: `${u.name || ''} ${u.code}`.trim(),
              ms: u.ms,
              pass: u.ok && !u.simulated,
              detail: `${u.held ? '총량보류 · ' : ''}봉 ${u.bars ?? 0} · 첫 ${u.firstAt || '-'} 종가 ${u.firstClose ?? '-'} · 끝 ${u.lastAt || '-'} 종가 ${u.lastClose ?? '-'} · 실측 ${fmtMs(u.ms)} · 목표 ${fmtMs(per)}${(u.waitMs || u.ms) > per ? ' · 목표초과(비교)' : ' · 목표이내'}`,
              targetMs: per,
            });
          }
          log.push({
            title: `${c.title} 합계 ${row.units.length}종목`,
            ms: row.ms,
            pass: Boolean(row.pass),
            detail: `실측 ${fmtMs(row.ms)} / 목표 ${fmtMs(row.targetMs)} · 차이 ${row.gapMs != null && row.gapMs > 0 ? '+' : ''}${fmtMs(row.gapMs || row.ms - row.targetMs)} · 목표${row.onTarget ? '이내' : '초과(비교)'}`,
            targetMs: row.targetMs,
          });
        } else {
          log.push({
            title: c.title,
            ms: row?.ms ?? Date.now() - caseStarted.current,
            pass: row ? row.ok && row.pass : false,
            detail: row?.detail || '',
            targetMs: row?.targetMs,
          });
        }
        merged.results.push(...report.results);
        merged.params = report.params || bodyParams;
        merged.at = report.at;
        const elapsed = Date.now() - runStarted.current;
        const avg = elapsed / (i + 1);
        const eta = avg * (queue.length - i - 1);
        setCurrent({...merged, bottlenecks: merged.results.filter((r) => r.onTarget === false).map((r) => r.id)});
        setOverlay({
          kind: 'run',
          title: c.title,
          work: workText(c.id, c.title, bodyParams),
          i: i + 1,
          n: queue.length,
          elapsed,
          eta,
          expected,
          log: [...log],
        });
      }
      merged.bottlenecks = merged.results.filter((r) => !r.pass).map((r) => r.id);
      setCurrent(merged);
      setOverlay({
        kind: 'done',
        title: (() => {
          const stocks = merged.results.flatMap((r) => r.units || []);
          const okN = stocks.filter((u) => u.ok && !u.simulated).length;
          const slow = merged.results.filter((r) => r.onTarget === false).length;
          if (stocks.length) {
            return `끝 · 실측 통과 ${okN}/${stocks.length} · 목표 ${fmtMs(bodyParams.deadlineMs)} 대비 초과 ${slow}건(비교) · 벽시계 ${fmtMs(Date.now() - runStarted.current)}`;
          }
          return merged.results.every((r) => r.pass) ? `끝 · ${merged.results.length}기능 실측 통과 · 목표 대비 초과 ${slow}건` : `끝 · 실측 실패`;
        })(),
        i: queue.length,
        n: queue.length,
        elapsed: Date.now() - runStarted.current,
        eta: 0,
        expected: expectedAll,
        log,
      });
      await load(true);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      setOverlay({kind: 'error', title: msg, log, elapsed: Date.now() - runStarted.current});
    } finally {
      setBusy(false);
    }
  };

  const setNum = (key: keyof LabParams, value: string) => {
    setParams((prev) => clampLabParams({...prev, [key]: Number(value)}));
  };

  const shown = current;
  return (
    <div className="hub-lab">
      {overlay ? (
        <div className={'hub-lab-overlay' + (overlay.kind === 'error' ? ' err' : overlay.kind === 'done' ? ' ok' : '')}>
          <div>
            <b>{overlay.kind === 'run' ? '측정 중' : overlay.kind === 'load' ? '불러오는 중' : overlay.kind === 'done' ? '완료' : '오류'}</b>
            {quota ? (
              <p>
                REST {quota.rest.used.toFixed(1)}/{quota.rest.cap} 소모 잔여 {quota.rest.left.toFixed(1)}
                {quota.rest.waitForOneMs > 0 ? ` · 대기 ${quota.rest.waitForOneMs}ms` : ''}
                {' · '}WSS {quota.wss.used}/{quota.wss.cap} 잔여 {quota.wss.left}
              </p>
            ) : null}
            <p className="hub-lab-work">{overlay.work || overlay.title}</p>
            {unit && unit.total ? (
              <p>
                {unit.note || overlay.title} · <b>{unit.done}/{unit.total}</b>
                {unit.unit || '종목'}
                {unit.lastCode ? ` · 방금 ${unit.lastCode} ${unit.lastOk === false ? '실패' : '성공'} ${fmtMs(unit.lastMs || 0)}` : ''}
              </p>
            ) : null}
            {unit && unit.done ? (
              <p>
                1{unit.unit || '종목'} 평균 {fmtMs(unit.avgMs || 0)}
                {unit.parallel && unit.parallel > 1 ? ` · 병렬 ${unit.parallel}` : ''}
                {unit.etaMs != null ? ` · 남은 ${unit.unit} 기준 이 단계는 앞으로 약 ${fmtMs(unit.etaMs)} 뒤 끝남` : ''}
              </p>
            ) : null}
            {overlay.kind === 'run' || overlay.kind === 'load' ? (
              <p>
                이 단계 경과 {fmtMs((overlay.kind === 'run' ? nowTick || Date.now() : Date.now()) - (caseStarted.current || runStarted.current || Date.now()))}
                {overlay.expected ? ` · 시작 시 예상 ${fmtMs(overlay.expected)}` : ''}
              </p>
            ) : null}
            <p>
              기능 {overlay.i}/{overlay.n} · 전체 경과 {fmtMs((overlay.elapsed || 0) + (overlay.kind === 'run' && caseStarted.current ? Math.max(0, (nowTick || Date.now()) - caseStarted.current) : 0))}
              {overlay.kind === 'run' && overlay.eta != null ? ` · 다음 기능들 예상 ${fmtMs(overlay.eta)}` : ''}
            </p>
            <p className="hub-lab-wait">
              {overlay.kind === 'run'
                ? unit?.etaMs
                  ? `지금 단계는 약 ${fmtMs(unit.etaMs)} 뒤 끝납니다. 그다음 기능으로 넘어갑니다. 창이 멈춘 것이 아닙니다.`
                  : '닫기·클릭 불가. 허브가 이 건을 끝낼 때까지 기다립니다.'
                : overlay.kind === 'load'
                  ? '저장을 읽는 중'
                  : ''}
            </p>
            {overlay.log?.length ? (
              <ol className="hub-lab-live">
                {overlay.log.map((line, i) => (
                  <li key={i} className={line.pass ? 'ok' : 'bad'}>
                    {line.pass ? '성공' : '실패'} · {line.title} · 실적 {fmtMs(line.ms)}
                    {line.targetMs != null ? ` / 목표 ${fmtMs(line.targetMs)}` : ''}
                    {line.detail ? ` · ${line.detail}` : ''}
                  </li>
                ))}
              </ol>
            ) : null}
            {overlay.kind === 'error' || overlay.kind === 'done' ? (
              <button className="hts-tool" onClick={() => setOverlay(null)}>
                확인
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {quota ? (
        <div className={'hub-lab-quota' + (quota.rest.left < 1 || quota.wss.left < 1 ? ' tight' : '')}>
          <span>
            REST 총량 {quota.rest.used.toFixed(1)}/{quota.rest.cap} 소모 · 잔여 {quota.rest.left.toFixed(1)}
            {quota.rest.waitForOneMs > 0 ? ` · 다음 ${quota.rest.waitForOneMs}ms 대기` : ''}
            {quota.rest.cooldownMs > 0 ? ` · 쿨다운 ${quota.rest.cooldownMs}ms` : ''}
            · 초당 +{quota.rest.refillPerSecond.toFixed(2)}
          </span>
          <span>
            WSS 구독 {quota.wss.used}/{quota.wss.cap} · 잔여 {quota.wss.left} · 패킷당 {quota.wss.packet}
          </span>
          <span>잔여 0이면 랩은 추가 REST/REG를 보내지 않습니다. 시스템 리셋 방지.</span>
        </div>
      ) : null}
      <p className="hub-lab-lead">
        목표는 {params.deadlineMs}ms입니다. 합격은 허브 총량이 허용한 범위의 실데이터 수신입니다. 목표 초과는 비교·병목이지 실측 실패가 아닙니다.
      </p>
      <div className="hub-lab-presets">
        {LAB_PARAM_PRESETS.map((pr) => (
          <button key={pr.id} className="hts-tool" disabled={busy} onClick={() => setParams(pr.params)}>
            {pr.label}
          </button>
        ))}
      </div>
      <div className="hub-lab-params">
        {LAB_PARAM_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={params[f.key]}
              disabled={busy}
              title={`${f.hint} (${f.min}–${f.max})`}
              onChange={(e) => setNum(f.key, e.target.value)}
            />
            <small>
              {f.min}–{f.max}
            </small>
          </label>
        ))}
      </div>
      <div className="hub-lab-tools">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
          <option value="all">전체</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.group} · {c.title}
            </option>
          ))}
        </select>
        <button className="hts-tool" disabled={busy} onClick={() => void run(pick)}>
          {busy ? '측정 중' : '이 파라미터로 실행'}
        </button>
        <button className="hts-tool" disabled={busy} onClick={() => void load().catch((e) => setOverlay({kind: 'error', title: (e as Error).message}))}>
          저장 불러오기
        </button>
      </div>
      {err ? <div className="hub-lab-err">{err}</div> : null}
      <div className="hub-lab-grid">
        {cases.map((c) => {
          const row = shown?.results.find((r) => r.id === c.id);
          return (
            <button key={c.id} className={'hub-lab-card' + (row && !row.pass ? ' bad' : row?.pass ? ' ok' : '')} onClick={() => void run(c.id)} disabled={busy}>
              <b>{c.title}</b>
              <small>{c.group}</small>
              {row ? (
                <span>
                  {row.units?.length
                    ? `${row.units.filter((u) => u.ok).length}/${row.units.length}종목 ${fmtMs(row.ms)} / 목표 ${fmtMs(row.targetMs)}`
                    : `${fmtMs(row.ms)} / 목표 ${fmtMs(row.targetMs)}`}{' '}
                  {row.pass ? '실측통과' : '실패'}
                  {row.onTarget === false ? ' · 목표초과' : ''}
                </span>
              ) : (
                <span>미측정</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="hub-lab-report">
        <h4>보고서</h4>
        {!shown ? (
          <p>아직 실행하지 않았습니다.</p>
        ) : (
          <>
            <p>
              {new Date(shown.at).toLocaleString('ko-KR')} · {shown.scope === 'all' ? '전체' : shown.scope} · 목표 {shown.params?.deadlineMs ?? shown.results[0]?.targetMs}ms · 목표 대비{' '}
              {shown.bottlenecks.length ? shown.bottlenecks.join(', ') : '이내'}
            </p>
            {shown.params ? (
              <p className="hub-lab-detail">
                종목 {shown.params.codes} · 창 {shown.params.windows} · 병렬 {shown.params.chartConcurrency} · 간격 {shown.params.restIntervalMs}ms · 틱 {shown.params.ticks} · 조건 {shown.params.conditions}×{shown.params.captured} · 주문 {shown.params.orders}/{shown.params.maxPositions}
              </p>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th>기능</th>
                  <th>ms</th>
                  <th>목표</th>
                  <th>제약</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {shown.results.flatMap((r) => {
                  const head = (
                    <tr key={r.id} className={r.pass ? '' : 'bad'}>
                      <td>
                        {r.title}
                        <div className="hub-lab-detail">{r.detail}</div>
                      </td>
                      <td>{r.ms}</td>
                      <td>{r.targetMs}</td>
                      <td>{r.constraints}</td>
                      <td>{r.pass ? (r.onTarget ? '실측통과·목표이내' : '실측통과·목표초과') : '실패'}</td>
                    </tr>
                  );
                  const kids = (r.units || []).map((u) => (
                    <tr
                      key={`${r.id}-${u.code}`}
                      className={'hub-lab-unit' + (u.ok && !u.simulated ? '' : ' bad')}
                      onClick={() => {
                        setInspect({loading: true, code: u.code, name: u.name});
                        void j<{
                          code: string;
                          name: string;
                          bars: number;
                          strengthBars: number;
                          firstAt: string;
                          lastAt: string;
                          issues: string[];
                          quote: {price: number; strength?: number; at?: string} | null;
                          candles: {at: string; open: number; high: number; low: number; close: number; volume: number; strength: number | null}[];
                        }>(`/api/hub/lab/inspect?code=${u.code}`)
                          .then((d) => setInspect(d))
                          .catch((e) => setInspect({code: u.code, name: u.name, err: (e as Error).message}));
                      }}
                    >
                      <td>
                        └ {u.name || ''} {u.code}
                        <div className="hub-lab-detail">
                          봉 {u.bars ?? 0} · 첫 {u.firstAt || '-'} {u.firstClose ?? '-'} · 끝 {u.lastAt || '-'} {u.lastClose ?? '-'} · 실측 {u.waitMs ?? u.ms}ms / 목표 {r.perTargetMs || r.targetMs}ms
                          {u.held ? ' · 총량보류' : ''}
                          {u.simulated ? ' · 가짜(불합격)' : ''}
                        </div>
                      </td>
                      <td>{u.ms}</td>
                      <td>{r.perTargetMs || r.targetMs}</td>
                      <td>{u.ok ? 0 : 1}</td>
                      <td>{u.held ? '총량보류' : u.ok && !u.simulated ? ((u.waitMs || u.ms) <= (r.perTargetMs || r.targetMs) ? '실측·목표이내' : '실측·목표초과') : '실패'}</td>
                    </tr>
                  ));
                  return [head, ...kids];
                })}
              </tbody>
            </table>
          </>
        )}
        {reports.length > 1 ? (
          <p className="hub-lab-hist">
            저장 {reports.length}건
            {reports.slice(0, 8).map((r) => (
              <button key={r.at} className="hts-tool" onClick={() => setCurrent(r)}>
                {new Date(r.at).toLocaleTimeString('ko-KR')}
              </button>
            ))}
          </p>
        ) : null}
      </div>
      {inspect ? (
        <div className="hub-lab-dialog" onClick={() => setInspect(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <b>
              {inspect.name || ''} {inspect.code} 수신 데이터
            </b>
            {inspect.loading ? (
              <p>허브 캐시를 읽는 중</p>
            ) : inspect.err ? (
              <p className="hub-lab-err">{inspect.err}</p>
            ) : (
              <>
                <p>
                  봉 {inspect.bars ?? 0} · 강도있는 봉 {inspect.strengthBars ?? 0} · 첫 {inspect.firstAt || '-'} · 끝 {inspect.lastAt || '-'}
                  {inspect.quote ? ` · 시세 ${inspect.quote.price} ${inspect.quote.at || ''}` : ' · 시세 없음'}
                </p>
                <p>{inspect.issues?.length ? `정합 ${inspect.issues.join(' · ')}` : '정합: 시간순·OHLC 이상 없음'}</p>
                <div className="hub-lab-bars">
                  <table>
                    <thead>
                      <tr>
                        <th>시각</th>
                        <th>시</th>
                        <th>고</th>
                        <th>저</th>
                        <th>종</th>
                        <th>거래량</th>
                        <th>강도</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(inspect.candles || []).map((c, i) => (
                        <tr key={`${c.at}-${i}`}>
                          <td>{c.at}</td>
                          <td>{c.open}</td>
                          <td>{c.high}</td>
                          <td>{c.low}</td>
                          <td>{c.close}</td>
                          <td>{c.volume}</td>
                          <td>{c.strength ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <button className="hts-tool" onClick={() => setInspect(null)}>
              닫기
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
