import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { AppServer } from './app-server.js';
import { readBinding, Journal, verifyWorkspace } from './binding.js';
import { DirectRelay } from './relay.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const defaultConfig = path.join(os.homedir(), '.config', 'ccs', 'direct-agent.json');

async function main(): Promise<void> {
  if (args.includes('--help')) {
    console.log(`Usage: npm run direct -- [--config PATH]\n       npm run direct -- --probe --thread TASK_ID [--codex PATH]\n\nDirect mode connects one Slack channel to one existing Codex task.\nConfig: ${defaultConfig}\nEnvironment: SLACK_BOT_TOKEN, SLACK_APP_TOKEN\nNo tmux, terminal UI, history import, or Codex installation is required.`);
    return;
  }
  if (args.includes('--probe')) {
    const probeConfig = path.resolve(option('--config') || defaultConfig);
    const threadId = option('--thread') || (fs.existsSync(probeConfig)
      ? JSON.parse(fs.readFileSync(probeConfig, 'utf8')).threadId : undefined);
    if (!threadId) throw new Error('--probe requires --thread TASK_ID');
    const rpc = new AppServer(option('--codex'));
    try {
      await rpc.start();
      const account = await rpc.request('account/read', { refreshToken: false });
      const attach = args.includes('--attach');
      const result = await rpc.request(attach ? 'thread/resume' : 'thread/read',
        attach ? { threadId, excludeTurns: true } : { threadId, includeTurns: false });
      if (result.thread?.id !== threadId) throw new Error('Unexpected task identity');
      console.log(JSON.stringify({ connected: true, transport: 'stdio',
        accountType: account.account?.type || 'unavailable', threadId: result.thread.id,
        attached: attach, historyImported: false, turnStarted: false }, null, 2));
    } finally { await rpc.close(); }
    return;
  }

  const configPath = path.resolve(option('--config') || defaultConfig);
  const binding = readBinding(configPath);
  const envFile = path.join(path.dirname(configPath), 'env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = /^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)=([A-Za-z0-9-]+)\s*$/.exec(line);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token || !appToken) throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN before starting the Slack connection.');

  // One direct Socket Mode consumer per app on this host, regardless of config path.
  const lockKey = createHash('sha256').update(appToken).digest('hex').slice(0, 24);
  const lockPath = path.join(os.homedir(), '.config', 'ccs', `direct-${lockKey}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error(`A direct bridge lock exists at ${lockPath}. Check its process before removing a stale lock.`); }
  fs.writeFileSync(lock, String(process.pid));

  const rpc = new AppServer(binding.codexPath);
  const socket = new SocketModeClient({ appToken, logLevel: 'error' as any });
  const slack = new WebClient(token, { retryConfig: { retries: 0 } });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await socket.disconnect().catch(() => {});
    await rpc.close();
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  };
  const fail = (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Direct bridge failed');
    process.exitCode = 1;
    void close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  rpc.on('disconnect', () => { if (!closing) fail(new Error('Codex disconnected; restart the bridge. No messages will be replayed.')); });

  try {
    // Read-only checks before attaching the agent or consuming any Slack event.
    const identity = await slack.auth.test();
    verifyWorkspace(binding.workspaceDomain, identity.url);
    const channel = await slack.conversations.info({ channel: binding.channelId });
    if (!channel.channel?.is_private || !channel.channel?.is_member)
      throw new Error('Invite the Slack app to the selected private channel first.');
    const post = async (text: string) => {
      // Limit mentions and disable automatic link/media unfurling.
      const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      for (let offset = 0; offset < escaped.length; offset += 3000) {
        await slack.chat.postMessage({ channel: binding.channelId,
          text: escaped.slice(offset, offset + 3000), mrkdwn: false,
          unfurl_links: false, unfurl_media: false });
      }
    };
    const relay = new DirectRelay(rpc, binding,
      new Journal(configPath + '.delivery.json'), post, fail);
    await rpc.start();
    await relay.connect();
    socket.on('message', async ({ event, body, ack }: any) => {
      await ack();
      void relay.receive({ id: body.event_id || '', user: event.user,
        channel: event.channel, text: typeof event.text === 'string'
          ? event.text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : undefined,
        bot_id: event.bot_id,
        subtype: event.subtype, hasFiles: Boolean(event.files?.length) }).catch(fail);
    });
    socket.on('slash_commands', async ({ body, ack }: any) => {
      await ack();
      void relay.receive({ id: `command:${body.trigger_id}`, user: body.user_id,
        channel: body.channel_id, text: body.command }).catch(fail);
    });
    socket.on('app_home_opened', async ({ ack }: any) => { await ack(); });
    socket.on('interactive', async ({ ack }: any) => { await ack(); });
    socket.on('error', fail);
    await socket.start();
    console.log(`Direct bridge ready: ${binding.channelId} → Codex task ${binding.threadId}`);
  } catch (error) { await close(); throw error; }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
