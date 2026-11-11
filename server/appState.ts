import {mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {AuditEntry} from './realtime/audit';

const dir = () => process.env.STATE_DIR || join(process.cwd(), 'data');
const configPath = () => join(dir(), 'app-config.json');
const logDir = () => join(dir(), 'logs');

export function loadAppConfig<T extends Record<string, unknown>>(): Partial<T> {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveAppConfig(value: unknown): void {
  mkdirSync(dir(), {recursive: true});
  writeFileSync(configPath(), JSON.stringify(value, null, 2), {mode: 0o600});
}

function stamp(at: number): string {
  const kst = new Date(at + 9 * 3600_000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

export function isTradeLog(category: string): boolean {
  return category === 'order' || category === 'signal' || category === 'position';
}

export function appendAuditFile(entry: AuditEntry): void {
  mkdirSync(logDir(), {recursive: true});
  const name = `${stamp(entry.at)}-${isTradeLog(entry.category) ? 'trade' : 'system'}.jsonl`;
  appendFileSync(join(logDir(), name), `${JSON.stringify(entry)}\n`);
}

export function readAuditFiles(tab: 'system' | 'trade', day = stamp(Date.now())): AuditEntry[] {
  const file = join(logDir(), `${day}-${tab}.jsonl`);
  try {
    return readFileSync(file, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry)
      .reverse();
  } catch {
    return [];
  }
}

export function listAuditDays(): string[] {
  try {
    const names = readdirSync(logDir());
    const days = new Set<string>();
    for (const n of names) {
      const m = n.match(/^(\d{8})-(system|trade)\.jsonl$/);
      if (m) days.add(m[1]);
    }
    return [...days].sort().reverse();
  } catch {
    return [];
  }
}
