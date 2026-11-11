import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {SAMPLE_SAVED, type SavedCondition} from '../shared/localConditions';

const path = process.env.LOCAL_CONDITIONS_PATH || 'data/conditions0150.json';

function validate(value: unknown): SavedCondition[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error('로컬 조건식은 최대 80개입니다.');
  const ids = new Set<string>();
  const out: SavedCondition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as SavedCondition;
    if (typeof v.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v.id)) throw new Error('조건식 ID가 올바르지 않습니다.');
    if (ids.has(v.id)) throw new Error('조건식 ID 중복');
    ids.add(v.id);
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 60) throw new Error('조건식 이름을 확인하세요.');
    if (typeof v.combo !== 'string' || v.combo.length > 500) throw new Error('조건식 결합이 너무 깁니다.');
    if (!Array.isArray(v.rows) || v.rows.length > 20) throw new Error('조건 행은 최대 20개입니다.');
    const rows = v.rows.map((r) => ({
      letter: String(r.letter || '').slice(0, 1).toUpperCase(),
      label: String(r.label || '').slice(0, 80),
      expression: String(r.expression || '').slice(0, 500),
      enabled: Boolean(r.enabled),
    }));
    const timeframe = v.timeframe === '1' ? '1' : 'D';
    out.push({id: v.id, name: v.name.trim(), combo: v.combo, rows, timeframe});
  }
  return out;
}

export function loadLocalConditions(): SavedCondition[] {
  try {
    const stored = validate(JSON.parse(readFileSync(path, 'utf8')));
    if (!stored.some((s) => s.id === SAMPLE_SAVED.id)) return [SAMPLE_SAVED, ...stored];
    return stored;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [SAMPLE_SAVED];
    throw new Error(`로컬 조건식을 불러올 수 없습니다: ${e instanceof Error ? e.message : '오류'}`);
  }
}

export function saveLocalConditions(value: unknown): SavedCondition[] {
  const list = validate(value);
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(list, null, 2), {mode: 0o600});
  renameSync(tmp, path);
  return list;
}
