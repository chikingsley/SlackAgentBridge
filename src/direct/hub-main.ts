import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { AgentHub, hubConfigSchema, nativeBackend } from './hub.js';
import { verifyWorkspace } from './binding.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--config');
  const configPath = path.resolve(index >= 0 ? args[index + 1] : path.join(os.homedir(), '.config/ccs/agents.json'));
  const config = hubConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const envPath = path.join(path.dirname(configPath), 'env');
  const credentials: Record<string, string | undefined> = { ...process.env };
  if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)=([A-Za-z0-9-]+)\s*$/.exec(line);
    if (match && !credentials[match[1]]) credentials[match[1]] = match[2];
  }
  const token = credentials.SLACK_BOT_TOKEN, appToken = credentials.SLACK_APP_TOKEN;
  if (!token || !appToken) throw new Error('Missing Slack bot or app token');
  const lockPath = path.join(os.homedir(), '.config/ccs', `direct-${createHash('sha256').update(appToken).digest('hex').slice(0, 24)}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, String(process.pid));
  const slack = new WebClient(token, { retryConfig: { retries: 0 } });
  const socket = new SocketModeClient({ appToken, logLevel: 'error' as any });
  let hub: AgentHub | undefined;
  let closing = false;
  const statusPath = configPath + '.status.json';
  const close = async () => {
    if (closing) return;
    closing = true;
    await socket.disconnect().catch(() => {});
    await hub?.close();
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
    fs.writeFileSync(statusPath, JSON.stringify({ ready: false, pid: process.pid }));
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  try {
    const identity = await slack.auth.test();
    verifyWorkspace(config.workspaceDomain, identity.url);
    if (!identity.user_id) throw new Error('Slack bot identity unavailable');
    for (const id of config.channelIds) {
      const { channel } = await slack.conversations.info({ channel: id });
      if (!channel?.is_private || !channel.is_member) throw new Error(`Invite the bot to configured private channel ${id} first`);
    }
    const stateFile = configPath + '.state.json';
    hub = new AgentHub(config, identity.user_id, stateFile, nativeBackend(config, stateFile), async (channel, text, root) => {
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      for (let i = 0; i < escaped.length; i += 3000) await slack.chat.postMessage({
        channel, thread_ts: root, text: escaped.slice(i, i + 3000), mrkdwn: false,
        unfurl_links: false, unfurl_media: false,
      });
    });
    socket.on('message', async ({ event, body, ack }: any) => {
      await ack();
      await hub!.receive({ id: body.event_id || '', channel: event.channel || '', user: event.user || '',
        text: typeof event.text === 'string' ? event.text : '', ts: event.ts || '',
        threadTs: event.thread_ts, botId: event.bot_id, subtype: event.subtype,
        hasFiles: Boolean(event.files?.length),
      }).catch(error => console.error(error instanceof Error ? error.message : 'Slack delivery failed'));
    });
    socket.on('slash_commands', async ({ ack }: any) => {
      await ack({ text: 'Mention Codex Agent with “help”, or reply “sab status” / “sab stop” in an agent thread.' });
    });
    socket.on('interactive', async ({ ack }: any) => { await ack(); });
    socket.on('error', error => console.error('Slack connection:', error.message));
    await socket.start();
    fs.writeFileSync(statusPath, JSON.stringify({ ready: true, pid: process.pid,
      channelIds: config.channelIds, botUserId: identity.user_id, startedAt: new Date().toISOString() }, null, 2));
    console.log(`Agent bridge ready in ${config.workspaceDomain}; configured channels: ${config.channelIds.join(', ')}`);
  } catch (error) { await close(); throw error; }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
