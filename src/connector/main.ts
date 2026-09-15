import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { call, connectorConfig } from './client.js';
import { jobSchema, type Job } from '../gateway/protocol.js';
import { argument, configHome, lock, save } from '../storage.js';
import { AppServer } from '../direct/app-server.js';
import { DirectRelay } from '../direct/relay.js';
import { Journal, type Binding } from '../direct/binding.js';
import { startControl } from '../service.js';

async function main() {
  const file = path.resolve(argument('config', path.join(configHome, 'connector.json'))!);
  const unlock = lock(file + '.lock');
  const config = connectorConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const connections = new Map<string, { rpc: AppServer; relay: DirectRelay; binding: Binding }>();
  let stopped = false;
  let jobs = Promise.resolve();
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  const close = async () => {
    if (stopped) return; stopped = true;
    await call(config.url, config.token, '/disconnect', {}).catch(() => {});
    await jobs;
    await Promise.all([...connections.values()].map(c => c.rpc.close()));
    save(file + '.status.json', { ready: false, pid: process.pid }); unlock();
    control?.close();
  };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  async function dispatch(job: Job) {
    const local = config.agents.find(a => a.name === job.name && a.threadId === job.threadId);
    if (!local || job.ownerId !== config.ownerId || job.channelId !== config.channelId) throw new Error('Gateway job does not match a locally selected agent');
    let connection = connections.get(local.name);
    if (!connection) {
      const rpc = new AppServer(config.codexPath);
      const binding: Binding = { threadId: local.threadId, channelId: config.channelId, ownerId: config.ownerId, collaboratorIds: job.collaboratorIds };
      await rpc.start();
      const relay = new DirectRelay(rpc, binding, new Journal(`${file}.${local.name}.delivery.json`), async (text, root) => {
        if (!root) throw new Error('Missing Slack reply root');
        await call(config.url, config.token, '/output', { id: randomUUID(), name: local.name, threadId: local.threadId, root, text });
      }, () => console.error(`Output delivery failed for ${local.name}; not replayed`));
      try { await relay.connect(); } catch (error) { await rpc.close(); throw error; }
      connection = { rpc, binding, relay }; connections.set(local.name, connection);
    }
    connection.binding.collaboratorIds = job.collaboratorIds;
    await connection.relay.receive({ ...job.event, threadTs: job.event.threadTs || job.event.ts });
  }
  try {
    for (const a of config.agents) await call(config.url, config.token, '/register', { name: a.name, threadId: a.threadId });
    console.log(`Connector ready for ${config.agents.map(a => a.name).join(', ') || 'no agents (stop and add one first)'}`);
    control = await startControl(close);
    save(file + '.status.json', { ready: true, pid: process.pid, names: config.agents.map(a => a.name), control });
    while (!stopped) {
      try {
        const { job } = z.object({ job: jobSchema.nullable() }).parse(await call(config.url, config.token, '/poll', {}));
        if (job && !stopped) jobs = jobs.then(() => dispatch(job)).catch(async () => {
          console.error(`Dispatch failed for ${job.name}; not replayed`);
          await call(config.url, config.token, '/output', { id: randomUUID(), name: job.name, threadId: job.threadId,
            root: job.event.threadTs || job.event.ts, text: 'The local Codex task could not accept this request. Check the connector on its computer; nothing was retried.' }).catch(() => {});
        });
      } catch (error) {
        if (error instanceof Error && /not authorized/.test(error.message)) throw error;
        console.error('Gateway unavailable; reconnecting without replaying work');
      }
      await delay(1000);
    }
    await jobs;
  } finally { await close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
