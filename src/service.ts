import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configHome, argument } from './storage.js';

/** An authenticated, loopback-only stop control avoids force-killing native children. */
export async function startControl(stop: () => Promise<void>) {
  const token = randomBytes(32).toString('base64url');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/health') { res.end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(404).end(); return; }
    res.end('stopping'); void stop().catch(() => console.error('Service shutdown failed'));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: (server.address() as { port: number }).port, token, close: () => { server.close(); } };
}

async function main() {
  const action = process.argv[2], role = process.argv[3];
  if (!['start', 'stop'].includes(action) || !['gateway', 'connector'].includes(role)) throw new Error('Usage: service start|stop gateway|connector [--config PATH]');
  const file = path.resolve(argument('config', path.join(configHome, `${role}.json`))!);
  const statusFile = file + '.status.json';
  async function control(endpoint: string, method: string) {
    if (!fs.existsSync(statusFile)) return false;
    const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (!s.ready || !s.control || !Number.isInteger(s.control.port) || s.control.port < 1 || s.control.port > 65535) return false;
    try { const r = await fetch(`http://127.0.0.1:${s.control.port}${endpoint}`, { method,
      headers: { Authorization: `Bearer ${s.control.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' }); return r.ok; }
    catch { return false; }
  }
  if (action === 'stop') {
    if (!await control('/stop', 'POST')) throw new Error('Service is not running or its stop control is unavailable');
    for (let n = 0; n < 100; n++) {
      if (!await control('/health', 'GET')) { console.log(`${role} stopped`); return; }
      await delay(200);
    }
    throw new Error('Shutdown has not finished; inspect the service logs');
  }
  if (await control('/health', 'GET')) { console.log(`${role} is already running`); return; }
  if (!fs.existsSync(file)) throw new Error(`Configure ${role} before starting it`);
  const entry = fileURLToPath(new URL(`./${role}/main.js`, import.meta.url));
  const stdout = fs.openSync(file + '.stdout.log', 'a', 0o600), stderr = fs.openSync(file + '.stderr.log', 'a', 0o600);
  const child = spawn(process.execPath, [entry, '--config', file], { detached: true, windowsHide: true,
    stdio: ['ignore', stdout, stderr], shell: false });
  fs.closeSync(stdout); fs.closeSync(stderr);
  let error: Error | undefined; child.on('error', e => { error = e; }); child.unref();
  for (let n = 0; n < 100; n++) {
    if (error) throw error;
    if (await control('/health', 'GET')) { console.log(`${role} started in background. Logs: ${file}.stderr.log`); return; }
    if (child.exitCode !== null) break;
    await delay(200);
  }
  throw new Error(`Service did not become ready. Inspect ${file}.stderr.log before retrying.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
