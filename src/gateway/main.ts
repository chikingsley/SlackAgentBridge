import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { gatewayConfig, inputSchema, safeEndpoint } from './protocol.js';
import { Router } from './router.js';
import { createApi } from './http.js';
import { verifyWorkspace } from '../direct/binding.js';
import { configHome, argument, lock, save } from '../storage.js';
import { startControl } from '../service.js';

async function main() {
  const file = path.resolve(argument('config', path.join(configHome, 'gateway.json'))!);
  const config = gatewayConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  config.publicUrl = safeEndpoint(config.publicUrl);
  const env: Record<string, string | undefined> = { ...process.env };
  const envFile = path.join(path.dirname(file), 'env');
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)=([A-Za-z0-9-]+)\s*$/.exec(line);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
  if (!env.SLACK_APP_TOKEN || !env.SLACK_BOT_TOKEN) throw new Error('Missing Slack credentials');
  const unlock = lock(path.join(configHome, `direct-${createHash('sha256').update(env.SLACK_APP_TOKEN).digest('hex').slice(0, 24)}.lock`));
  const slack = new WebClient(env.SLACK_BOT_TOKEN, { retryConfig: { retries: 0 } });
  const socket = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });
  let api: ReturnType<typeof createApi> | undefined;
  let closing = false;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  const close = async () => {
    if (closing) return; closing = true;
    await socket.disconnect().catch(() => {});
    if (api) { api.closeAllConnections(); await new Promise<void>(resolve => api!.close(() => resolve())); }
    unlock(); save(file + '.status.json', { ready: false, pid: process.pid });
    control?.close();
  };
  process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
  try {
    const auth = await slack.auth.test(); verifyWorkspace(config.workspaceDomain, auth.url);
    if (!auth.user_id) throw new Error('No bot identity');
    for (const id of config.channelIds) {
      const { channel } = await slack.conversations.info({ channel: id });
      if (!channel?.is_private || !channel.is_member) throw new Error(`Bot must be invited to private channel ${id}`);
    }
    const router = new Router(config, auth.user_id, file + '.state.json', async (channel, text, root) => {
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      for (let i = 0; i < escaped.length; i += 3000) await slack.chat.postMessage({ channel, thread_ts: root,
        text: escaped.slice(i, i + 3000), mrkdwn: false, unfurl_links: false, unfurl_media: false });
    }, async (channel, user, text) => { await slack.chat.postEphemeral({ channel, user, text }); });
    api = createApi(router);
    await new Promise<void>((resolve, reject) => { api!.once('error', reject); api!.listen(config.port, '127.0.0.1', resolve); });
    socket.on('message', async ({ event, body, ack }) => {
      await ack();
      const input = inputSchema.safeParse({ id: body.event_id, channel: event.channel, user: event.user,
        text: event.text || '', ts: event.ts, threadTs: event.thread_ts, botId: event.bot_id,
        subtype: event.subtype, hasFiles: Boolean(event.files?.length) });
      if (input.success) await router.receive(input.data).catch(() => console.error('Slack response delivery failed; not retried'));
    });
    socket.on('slash_commands', async ({ ack }) => { await ack({ text: 'Mention Codex Agent with “help”, or reply “sab status” / “sab stop” in an agent thread.' }); });
    socket.on('interactive', async ({ ack }) => { await ack(); });
    socket.on('error', () => console.error('Slack connection error'));
    await socket.start();
    control = await startControl(close);
    save(file + '.status.json', { ready: true, pid: process.pid, url: config.publicUrl, control });
    console.log(`Gateway ready: ${config.publicUrl}. No Codex account runs on the gateway.`);
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
