import React, {useEffect, useState} from 'react';

type Case = {id: string; title: string; group: string};
type Row = {id: string; title: string; group: string; ok: boolean; ms: number; detail: string};

export function CybosLabPane() {
  const [cases, setCases] = useState<Case[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('005930');
  const [count, setCount] = useState(1);

  useEffect(() => {
    void fetch('/api/hub/cybos-lab')
      .then((r) => r.json())
      .then((d) => setCases(d.cases || []))
      .catch((e) => setErr(String(e)));
  }, []);

  const run = async (id: string) => {
    setBusy(true);
    setErr('');
    try {
      const codes = code.split(/[,\s]+/).filter((c) => /^\d{6}$/.test(c));
      const d = await fetch('/api/hub/cybos-lab', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id, codes, count}),
      }).then((r) => r.json());
      const next = (d.results || []) as Row[];
      setRows((prev) => {
        const map = new Map(prev.map((x) => [x.id, x]));
        for (const x of next) map.set(x.id, x);
        return [...map.values()];
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '실행 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hub-spec" style={{overflow: 'auto', height: '100%', padding: 10}}>
      <h3>CYBOS 검증</h3>
      <p className="hub-spec-note">창은 COM을 치지 않는다. 관리자 파이썬만. 하나씩 또는 일괄. 가짜 합격 없음.</p>
      <div className="v16-row">
        <span>종목</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="005930,000660" />
        <span>일괄수</span>
        <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        <button disabled={busy} onClick={() => void run('all')}>
          일괄
        </button>
      </div>
      {err ? <p className="hub-spec-note">{err}</p> : null}
      <table>
        <thead>
          <tr>
            <th>항목</th>
            <th>그룹</th>
            <th></th>
            <th>결과</th>
            <th>ms</th>
            <th>내용</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const r = rows.find((x) => x.id === c.id);
            return (
              <tr key={c.id}>
                <td>{c.title}</td>
                <td>{c.group}</td>
                <td>
                  <button disabled={busy} onClick={() => void run(c.id)}>
                    실행
                  </button>
                </td>
                <td>{r ? (r.ok ? '통과' : '실패') : '-'}</td>
                <td>{r ? r.ms : ''}</td>
                <td>{r?.detail || ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
