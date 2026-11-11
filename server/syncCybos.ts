import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {clearBarCache} from './localBars';

function pythonBin(): string {
  const win = join(process.cwd(), '.venv', 'Scripts', 'python.exe');
  const nix = join(process.cwd(), '.venv', 'bin', 'python');
  if (existsSync(win)) return win;
  if (existsSync(nix)) return nix;
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function syncCybosOnStart(): void {
  const script = join(process.cwd(), 'scripts', 'sync_cybos.py');
  if (!existsSync(script)) {
    console.log('cybos sync skipped: no scripts/sync_cybos.py');
    return;
  }
  console.log('cybos sync start');
  const child = spawn(pythonBin(), [script], {cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout?.on('data', (b) => process.stdout.write(`[cybos] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[cybos] ${b}`));
  child.on('close', (code) => {
    clearBarCache();
    console.log(`cybos sync done code=${code}`);
  });
  child.on('error', (e) => console.log(`cybos sync error ${e.message}`));
}
