import React, {useEffect, useState} from 'react';
import {CONDITION_CATALOG, FUNCTION_HELP, type ConditionItem} from '../shared/conditionCatalog';
import {compileCombo, defaultCombo, nextLetter, SAMPLE_SAVED, type ConditionRow, type SavedCondition} from '../shared/localConditions';

async function post(path: string, body: unknown) {
  const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || '요청 실패');
  return d;
}

function fmt(n: number) {
  return n.toLocaleString('ko-KR');
}

export function Search150Pane({setNotice, onCode}: {setNotice: (v: string) => void; onCode: (code: string) => void}) {
  const [rows, setRows] = useState<ConditionRow[]>(SAMPLE_SAVED.rows);
  const [combo, setCombo] = useState(SAMPLE_SAVED.combo);
  const [name, setName] = useState(SAMPLE_SAVED.name);
  const [savedId, setSavedId] = useState(SAMPLE_SAVED.id);
  const [saved, setSaved] = useState<SavedCondition[]>([SAMPLE_SAVED]);
  const [picked, setPicked] = useState<ConditionItem | null>(null);
  const [editLetter, setEditLetter] = useState('');
  const [filter, setFilter] = useState('');
  const [timeframe, setTimeframe] = useState('D');
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<{code: string; close: number; time: number}[]>([]);
  const [scanned, setScanned] = useState(0);
  const expression = compileCombo(rows, combo);

  useEffect(() => {
    void fetch('/api/local-conditions')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.saved) && d.saved.length) setSaved(d.saved);
      })
      .catch(() => {});
  }, []);

  const addRow = (item: ConditionItem) => {
    setPicked(item);
    if (item.available === false || !item.expression) return;
    setRows((cur) => {
      try {
        const letter = nextLetter(cur);
        const next = [...cur, {letter, label: item.name, expression: item.expression, enabled: true}];
        setCombo((c) => (c.trim() ? `${c} and ${letter}` : letter));
        return next;
      } catch (e) {
        setNotice((e as Error).message);
        return cur;
      }
    });
  };

  const patchRow = (letter: string, patch: Partial<ConditionRow>) => {
    setRows((cur) => cur.map((r) => (r.letter === letter ? {...r, ...patch} : r)));
  };

  const removeRow = (letter: string) => {
    setRows((cur) => cur.filter((r) => r.letter !== letter));
    setCombo((c) => c.replace(new RegExp(`\\b(and|or)?\\s*${letter}\\b`, 'gi'), '').replace(/^\s*(and|or)\s+/i, '').trim());
    if (editLetter === letter) setEditLetter('');
  };

  const moveRow = (letter: string, dir: -1 | 1) => {
    setRows((cur) => {
      const i = cur.findIndex((r) => r.letter === letter);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const loadSaved = (s: SavedCondition) => {
    setSavedId(s.id);
    setName(s.name);
    setRows(s.rows);
    setCombo(s.combo);
    if (s.timeframe) setTimeframe(s.timeframe);
  };

  const persist = async (list: SavedCondition[]) => {
    const d = await fetch('/api/local-conditions', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({saved: list}),
    }).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    setSaved(d.saved);
  };

  const saveCurrent = async () => {
    try {
      const id = savedId && saved.some((s) => s.id === savedId) ? savedId : `c${Date.now()}`;
      const rec: SavedCondition = {id, name: name.trim() || '내조건식', rows, combo, timeframe: timeframe === '1' ? '1' : 'D'};
      const rest = saved.filter((s) => s.id !== id);
      await persist([...rest, rec]);
      setSavedId(id);
      setNotice(`저장: ${rec.name}`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const saveAsNew = async () => {
    try {
      const rec: SavedCondition = {id: `c${Date.now()}`, name: (name.trim() || '내조건식') + '_복사', rows, combo, timeframe: timeframe === '1' ? '1' : 'D'};
      await persist([...saved, rec]);
      setSavedId(rec.id);
      setName(rec.name);
      setNotice(`새로 저장: ${rec.name}`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const removeSaved = async (id: string) => {
    try {
      await persist(saved.filter((s) => s.id !== id));
      if (savedId === id) setSavedId('');
      setNotice('삭제했습니다.');
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const d = await post('/api/local-scan', {expression, timeframe});
      setHits(d.hits || []);
      setScanned(d.scanned || 0);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tree = CONDITION_CATALOG.filter((c) => !filter || c.name.includes(filter) || c.group.includes(filter));
  const groups = [...new Set(tree.map((c) => c.group))];

  const editing = rows.find((r) => r.letter === editLetter);

  return (
    <div className="search150">
      <aside className="s150-tree">
        <div className="s150-group-title">조건 목록 (클릭=추가)</div>
        <input placeholder="조건 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {groups.map((g) => (
          <div key={g} className="s150-group">
            <div className="s150-group-title">{g}</div>
            {tree.filter((c) => c.group === g).map((c) => (
              <button key={c.id} type="button" className={`${picked?.id === c.id ? 'on' : ''} ${c.available === false ? 'off' : ''}`} onClick={() => addRow(c)} title={c.hint}>
                {c.name}{c.available === false ? ' (불가)' : ''}
              </button>
            ))}
          </div>
        ))}
        <div className="s150-group">
          <div className="s150-group-title">함수 요약</div>
          {FUNCTION_HELP.map((f) => (
            <div key={f.name} className="s150-fn">
              <b>{f.name}</b>
              <span>{f.desc}</span>
              <code>{f.example}</code>
            </div>
          ))}
        </div>
      </aside>
      <aside className="s150-mine">
        <div className="s150-group-title">내조건식</div>
        {saved.map((s) => (
          <div key={s.id} className="s150-saved">
            <button type="button" className={savedId === s.id ? 'on' : ''} onClick={() => loadSaved(s)}>{s.name}</button>
            <button type="button" className="s150-x" onClick={() => void removeSaved(s.id)}>삭제</button>
          </div>
        ))}
      </aside>
      <div className="s150-main">
        {picked && (
          <div className="s150-help">
            <strong>{picked.name}</strong>
            <p>{picked.hint}</p>
            {picked.expression ? <p>식: <code>{picked.expression}</code></p> : null}
            <p>예: {picked.example}</p>
            <button type="button" disabled={picked.available === false} onClick={() => addRow(picked)}>표에 추가</button>
          </div>
        )}
        {editing && (
          <div className="s150-help">
            <strong>조건 {editing.letter} 수정</strong>
            <input value={editing.label} onChange={(e) => patchRow(editing.letter, {label: e.target.value})} />
            <textarea rows={3} value={editing.expression} onChange={(e) => patchRow(editing.letter, {expression: e.target.value})} />
          </div>
        )}
        <table className="s150-table">
          <thead>
            <tr><th>√</th><th>지표</th><th>내용</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.letter} className={editLetter === r.letter ? 'on' : ''} onClick={() => setEditLetter(r.letter)}>
                <td><input type="checkbox" checked={r.enabled} onChange={(e) => patchRow(r.letter, {enabled: e.target.checked})} /></td>
                <td>{r.letter}</td>
                <td>{r.label}<div className="s150-mini"><code>{r.expression}</code></div></td>
                <td className="s150-ops">
                  <button type="button" onClick={(e) => { e.stopPropagation(); moveRow(r.letter, -1); }}>▲</button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); moveRow(r.letter, 1); }}>▼</button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); removeRow(r.letter); }}>X</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="v16-row">
          <span>조건식</span>
          <input className="s150-combo" value={combo} onChange={(e) => setCombo(e.target.value)} />
          <button type="button" onClick={() => setCombo((c) => `${c} and `.trimEnd())}>and</button>
          <button type="button" onClick={() => setCombo((c) => `${c} or `)}>or</button>
          <button type="button" onClick={() => setCombo((c) => `(${c})`)}>( )</button>
          <button type="button" onClick={() => setCombo(defaultCombo(rows))}>A and B…</button>
        </div>
        <div className="v16-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="조건식 이름" />
          <button type="button" onClick={() => void saveCurrent()}>저장</button>
          <button type="button" onClick={() => void saveAsNew()}>다른이름 저장</button>
          <button type="button" onClick={() => { setRows([]); setCombo(''); setName('새조건식'); setSavedId(''); }}>새로작성</button>
        </div>
        <div className="v16-row">
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            <option value="D">일봉</option>
            <option value="1">1분</option>
            <option value="5">5분</option>
            <option value="60">60분</option>
          </select>
          <button className="v16-run" style={{width: 'auto', padding: '6px 16px'}} disabled={busy} onClick={() => void run()}>{busy ? '검색 중…' : '검색'}</button>
          <span>스캔 {scanned} · 결과 {hits.length}</span>
        </div>
        <p className="s150-mini">전개: {expression}</p>
        <div className="s150-hits">
          {hits.map((h) => (
            <button key={h.code} className="rank-row" onClick={() => onCode(h.code)}>
              <b>{h.code}</b>
              <span>{fmt(Math.round(h.close))}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
