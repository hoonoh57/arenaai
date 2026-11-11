import React, {useState} from 'react';
import {kinds, validateFormula, type Formula, type Kind} from '../shared/formula';
import {convertPine, formulaFromPine} from '../shared/pine';

export function PineImport({formulas, onClose, onSaved}: {formulas: Formula[]; onClose: () => void; onSaved: () => Promise<void>}) {
  const [source, setSource] = useState(`//@version=5
indicator("간단 SMA", overlay=true)
len = input.int(20, "기간")
plot(ta.sma(close, len), title="MA")
`);
  const [kind, setKind] = useState<Kind | ''>('');
  const [message, setMessage] = useState('');
  const preview = (() => {
    try {
      return convertPine(source, kind || undefined);
    } catch (e) {
      return {error: (e as Error).message};
    }
  })();

  async function save() {
    try {
      if ('error' in preview) throw new Error(preview.error);
      const next = formulaFromPine(source, kind || undefined);
      validateFormula(next, [...formulas, next]);
      const r = await fetch('/api/formulas', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({formulas: [...formulas, next]}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '저장 실패');
      await onSaved();
      onClose();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '이식 실패');
    }
  }

  const ok = !('error' in preview);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="formula-modal pine-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="formula-header">
          <div>
            <div className="eyebrow">PINE → KIWOOM</div>
            <h2>파인스크립트 이식</h2>
            <p>TradingView 파인의 일부만 키움 수식(이 앱 문법)으로 옮깁니다. 리페인트·보안호출·루프는 이식하지 않습니다.</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pine-grid">
          <label>
            파인 원문
            <textarea className="formula-code pine-src" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <div>
            <label>
              수식 종류
              <select className="formula-select" value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
                <option value="">자동 판별</option>
                {(Object.keys(kinds) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {kinds[k]}
                  </option>
                ))}
              </select>
            </label>
            {ok ? (
              <>
                <p className="editor-hint">
                  {kinds[preview.formula.kind]} · {preview.formula.name}
                </p>
                <label>
                  변환된 수식
                  <textarea className="formula-code" readOnly value={preview.formula.expression} />
                </label>
                {preview.formula.kind === 'system' && (
                  <label>
                    청산
                    <textarea className="formula-code" readOnly value={preview.formula.exitExpression} />
                  </label>
                )}
                <div className="pine-notes">
                  {preview.notes.map((n, i) => (
                    <div key={i}>
                      {n.line ? `${n.line}: ` : ''}
                      {n.text}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="formula-message">{preview.error}</p>
            )}
          </div>
        </div>
        {message && <div className="formula-message">{message}</div>}
        <div className="formula-actions">
          <span>저장 시 수식 관리자에 비활성 항목으로 추가됩니다.</span>
          <button onClick={onClose}>취소</button>
          <button className="save-formula" onClick={() => void save()} disabled={!ok}>
            수식 관리자에 추가
          </button>
        </div>
      </div>
    </div>
  );
}
