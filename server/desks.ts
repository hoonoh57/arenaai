import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {defaultWorkspace, ensureLiveTradeWorkspace, ensureMockTradeWorkspace, validateWorkspace, type DeskWorkspace} from '../shared/desk';

const path = process.env.DESKS_PATH || 'data/desks.json';

export function loadDesks(): DeskWorkspace {
  try {
    const loaded = ensureLiveTradeWorkspace(ensureMockTradeWorkspace(validateWorkspace(JSON.parse(readFileSync(path, 'utf8')))));
    return loaded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultWorkspace();
    throw new Error(`가상화면을 불러올 수 없습니다: ${error instanceof Error ? error.message : '오류'}`);
  }
}

export function saveDesks(value: unknown): DeskWorkspace {
  const workspace = validateWorkspace(value);
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(workspace, null, 2), {mode: 0o600});
  renameSync(tmp, path);
  return workspace;
}
