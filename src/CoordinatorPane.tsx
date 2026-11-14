import React, {useEffect, useState} from 'react';
import type {CoordSnapshot} from '../shared/coordinator';
import {COORD_CLOCK, COORD_PHASES} from '../shared/coordinator';

export function CoordinatorPane() {
  const [snap, setSnap] = useState<CoordSnapshot | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const pull = async () => {
    try {
      const d = await fetch('/api/hub/coordinator').then((r) => r.json());
      setSnap(d);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '감독 조회 실패');
    }
  };

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), 1000);
    return () => window.clearInterval(id);
  }, []);

  const act = async (op: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const d = await fetch('/api/hub/coordinator', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({op, ...extra}),
      }).then((r) => r.json());
      if (d.error) setErr(d.error);
      else setSnap(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '감독 실행 실패');
    } finally {
      setBusy(false);
    }
  };

  const c = snap?.counts;
  return (
    <div className="hub-spec" style={{overflow: 'auto', height: '100%', padding: 10}}>
      <h3>코디네이션</h3>
      <p className="hub-spec-note">
        중앙관리자는 책상입니다. 코디네이터는 허브 감독입니다. 창은 ask만. 경과·state는 여기 남습니다.
      </p>
      {err ? <p className="hub-lab-err">{err}</p> : null}
      <p>
        단계 <b>{snap ? COORD_CLOCK[snap.phase] : '…'}</b>
        {snap?.halt ? ' · 정지' : ''}
      </p>
      <div className="v16-row" style={{flexWrap: 'wrap', gap: 6}}>
        {COORD_PHASES.filter((p) => p !== 'halt' && p !== 'downloading').map((p) => (
          <button key={p} className={'hts-tool' + (snap?.phase === p ? ' on' : '')} disabled={busy} onClick={() => void act('phase', {phase: p, note: COORD_CLOCK[p]})}>
            {COORD_CLOCK[p]}
          </button>
        ))}
      </div>
      <div className="v16-row" style={{flexWrap: 'wrap', gap: 6, marginTop: 8}}>
        <button className="hts-tool" disabled={busy} onClick={() => void act('detect', {count: 16, market: 'kospi', note: 'NXT 포착 시뮬 16종'})}>
          포착 시뮬
        </button>
        <button className="hts-tool" disabled={busy} onClick={() => void act('download', {note: 'CYBOS ready'})}>
          이력 받아 ready
        </button>
        <button className="hts-tool" disabled={busy} onClick={() => void act('halt', {note: '감독 정지'})}>
          정지
        </button>
        <button className="hts-tool" disabled={busy} onClick={() => void act('resume', {note: '재개'})}>
          재개
        </button>
        <button className="hts-tool" disabled={busy} onClick={() => void act('reset')}>
          초기화
        </button>
      </div>
      {c ? (
        <p className="hub-lab-detail">
          detected {c.detected} · downloading {c.downloading} · ready {c.ready} · excluded {c.excluded} · live {c.live} · trading {c.trading} · halted {c.halted}
        </p>
      ) : null}
      <h4>종목</h4>
      <table>
        <thead>
          <tr>
            <th>코드</th>
            <th>이름</th>
            <th>state</th>
            <th>봉</th>
            <th>ms</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {(snap?.stocks || []).map((s) => (
            <tr key={s.code} className={s.state === 'excluded' || s.state === 'halted' ? 'bad' : ''}>
              <td>{s.code}</td>
              <td>{s.name}</td>
              <td>{s.state}</td>
              <td>{s.bars}</td>
              <td>{s.ms}</td>
              <td>{s.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>경과</h4>
      <ol className="hub-lab-live">
        {(snap?.events || []).slice(0, 80).map((e, i) => (
          <li key={`${e.at}-${i}`}>
            {new Date(e.at).toLocaleTimeString('ko-KR')} · {COORD_CLOCK[e.phase]}
            {e.code ? ` · ${e.code}` : ''}
            {e.from && e.to ? ` · ${e.from}→${e.to}` : ''}
            {e.note ? ` · ${e.note}` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}
