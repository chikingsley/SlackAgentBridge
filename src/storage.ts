import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const configHome = path.join(os.homedir(), '.config/ccs');
export function save(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function lock(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process lock; inspect it before restarting');
    try { process.kill(pid, 0); throw new Error(`Already running (PID ${pid})`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      fs.unlinkSync(file);
    }
  }
  fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}
export function argument(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name} value`);
  return value;
}
