import React, {useEffect, useState} from 'react';
import {LAB_PARAM_DEFAULT, LAB_PARAM_FIELDS, LAB_PARAM_PRESETS, clampLabParams, type LabParams} from '../shared/hubLabParams';

type LabCase = {id: string; title: string; group: string};
type LabReport = {
  at: number;
  scope: string;
  params?: LabParams;
  results: {id: string; title: string; group: string; ms: number; targetMs: number; ok: boolean; pass: boolean; detail: string; constraints: number}[];
  bottlenecks: string[];
  missingOfficial?: string[];
};

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...init});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d as T;
}

export function HubLabPane() {
  const [cases, setCases] = useState<LabCase[]>([]);
  const [reports, setReports] = useState<LabReport[]>([]);
  const [current, setCurrent] = useState<LabReport | null>(null);
  const [pick, setPick] = useState<'all' | string>('all');
  const [params, setParams] = useState<LabParams>(LAB_PARAM_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [overlay, setOverlay] = useState<{kind: 'run' | 'load' | 'done' | 'error'; title: string; i?: number; n?: number} | null>(null);

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
        setOverlay({kind: 'run', title: c.title, i: i + 1, n: queue.length});
        const report = await j<LabReport>('/api/hub/lab', {method: 'POST', body: JSON.stringify({id: c.id, params: bodyParams})});
        merged.results.push(...report.results);
        merged.params = report.params || bodyParams;
        merged.at = report.at;
        setCurrent({...merged, bottlenecks: merged.results.filter((r) => !r.pass).map((r) => r.id)});
      }
      merged.bottlenecks = merged.results.filter((r) => !r.pass).map((r) => r.id);
      setCurrent(merged);
      setOverlay({
        kind: 'done',
        title: merged.bottlenecks.length ? `끝 · 병목 ${merged.bottlenecks.length}` : `끝 · ${merged.results.length}건 통과`,
        i: queue.length,
        n: queue.length,
      });
      await load(true);
      window.setTimeout(() => setOverlay((o) => (o?.kind === 'done' ? null : o)), 1400);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      setOverlay({kind: 'error', title: msg});
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
            <p>{overlay.title}</p>
            {overlay.n ? (
              <p>
                {overlay.i}/{overlay.n}
                {overlay.kind === 'run' ? ' · 닫기·클릭 불가' : ''}
              </p>
            ) : overlay.kind === 'run' || overlay.kind === 'load' ? (
              <p>닫기·클릭 불가</p>
            ) : null}
            {overlay.kind === 'error' ? (
              <button className="hts-tool" onClick={() => setOverlay(null)}>
                확인
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="hub-lab-lead">
        실전 부하를 파라미터로 넣습니다. 동시 종목·창·REST 간격·포착 팽창·주문 한도를 극한까지 올려 {params.deadlineMs}ms 안 합격 여부를 봅니다. 미등록 기능은 거부합니다.
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
                  {row.ms}ms / {row.targetMs}ms {row.pass ? '통과' : '미달'} · 제약 {row.constraints}
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
              {new Date(shown.at).toLocaleString('ko-KR')} · {shown.scope === 'all' ? '전체' : shown.scope} · 합격한도 {shown.params?.deadlineMs ?? shown.results[0]?.targetMs}ms · 병목{' '}
              {shown.bottlenecks.length ? shown.bottlenecks.join(', ') : '없음'}
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
                  <th>한도</th>
                  <th>제약</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {shown.results.map((r) => (
                  <tr key={r.id} className={r.pass ? '' : 'bad'}>
                    <td>
                      {r.title}
                      <div className="hub-lab-detail">{r.detail}</div>
                    </td>
                    <td>{r.ms}</td>
                    <td>{r.targetMs}</td>
                    <td>{r.constraints}</td>
                    <td>{r.ok ? (r.pass ? '통과' : '목표초과') : '실패'}</td>
                  </tr>
                ))}
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
    </div>
  );
}
