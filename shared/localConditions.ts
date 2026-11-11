export type ConditionRow = {
  letter: string;
  label: string;
  expression: string;
  enabled: boolean;
};

export type SavedCondition = {
  id: string;
  name: string;
  rows: ConditionRow[];
  combo: string;
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRST';

export function nextLetter(rows: ConditionRow[]): string {
  const used = new Set(rows.map((r) => r.letter));
  const ch = [...LETTERS].find((c) => !used.has(c));
  if (!ch) throw new Error('조건은 최대 20개입니다.');
  return ch;
}

export function compileCombo(rows: ConditionRow[], combo: string): string {
  const enabled = rows.filter((r) => r.enabled && r.expression.trim());
  if (!combo.trim()) {
    return enabled.map((r) => `(${r.expression})`).join(' AND ') || '1';
  }
  let s = combo;
  for (const r of [...enabled].sort((a, b) => b.letter.localeCompare(a.letter))) {
    s = s.replace(new RegExp(`\\b${r.letter}\\b`, 'g'), `(${r.expression})`);
  }
  s = s.replace(/\bAND\b/gi, 'AND').replace(/\bOR\b/gi, 'OR').replace(/\bNOT\b/gi, 'NOT');
  return s;
}

export function defaultCombo(rows: ConditionRow[]): string {
  return rows.filter((r) => r.enabled).map((r) => r.letter).join(' and ');
}

export const SAMPLE_SAVED: SavedCondition = {
  id: 'sample-5pct',
  name: '5%_기준버전(로컬)',
  combo: '(A and B and (C or D) and E and F) or ((G or H) and I)',
  rows: [
    {letter: 'A', label: '거래대금 추정 50억↑', expression: 'ACCOUNT >= 5000000000', enabled: true},
    {letter: 'B', label: '10봉 저가대비고가 20%↑', expression: 'HLRATE(10) >= 20', enabled: true},
    {letter: 'C', label: '신고가 1% 근접', expression: 'NEARHIGH(5, 1, 1)', enabled: true},
    {letter: 'D', label: '신고가 5% 근접', expression: 'NEARHIGH(5, 1, 5)', enabled: true},
    {letter: 'E', label: '전봉대비 종가 +2%', expression: 'ROC(CLOSE, 1) >= 2', enabled: true},
    {letter: 'F', label: '종가 1000~500000', expression: 'INRANGE(CLOSE, 1000, 500000)', enabled: true},
    {letter: 'G', label: '시가대비 +5.5%', expression: '(CLOSE - OPEN) / OPEN * 100 >= 5.5', enabled: true},
    {letter: 'H', label: '거래대금 추정 100억↑', expression: 'ACCOUNT >= 10000000000', enabled: true},
    {letter: 'I', label: '거래량 200만↑', expression: 'VOLUME >= 2000000', enabled: true},
  ],
};
