import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../src/gateway/router.js';
import { safeEndpoint, type GatewayConfig, type Input } from '../src/gateway/protocol.js';
import { createApi } from '../src/gateway/http.js';
import { call } from '../src/connector/client.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-gateway-'));
  const config: GatewayConfig = { workspaceDomain: 'constructioncopilot.slack.com', channelIds: ['C123'], allowedUserIds: ['U123', 'U456'], publicUrl: 'https://gateway.example', port: 8877 };
  const messages: { channel: string; text: string; root: string }[] = [], privateMessages: string[] = [];
  const file = path.join(dir, 'state.json');
  const router = new Router(config, 'UBOT', file, async (channel, text, root) => { messages.push({ channel, text, root }); }, async (_c, _u, text) => { privateMessages.push(text); });
  const owner = router.enroll(router.invite('U123', 'C123'));
  const other = router.enroll(router.invite('U456', 'C123'));
  router.register(owner.token, { name: 'windows', threadId: 'thread-windows' });
  router.register(other.token, { name: 'hochi', threadId: 'thread-hochi' });
  router.poll(owner.token); router.poll(other.token);
  let id = 0;
  const input = (text: string, extra: Partial<Input> = {}): Input => ({ id: `Ev${++id}`, channel: 'C123', user: 'U123', ts: `${1000 + id}.123`, text, ...extra });
  return { router, owner, other, messages, privateMessages, input, dir, config, file };
}
test('pairing is single use, identity scoped, expires and contains no Slack tokens', t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  const code = s.router.invite('U123', 'C123');
  const d = s.router.enroll(code); expect(d.ownerId).toBe('U123');
  expect(() => s.router.enroll(code)).toThrow(/Invalid/);
  expect(() => s.router.invite('U789', 'C123')).toThrow();
  expect(() => s.router.authenticate('bad-token')).toThrow();
  expect(fs.readFileSync(s.file, 'utf8')).not.toContain(d.token);
  const expired = s.router.invite('U123', 'C123');
  const state = JSON.parse(fs.readFileSync(s.file, 'utf8')); state.invites[0].expires = 0;
  fs.writeFileSync(s.file, JSON.stringify(state));
  const restored = new Router(s.config, 'UBOT', s.file, async () => {}, async () => {});
  expect(() => restored.enroll(expired)).toThrow();
});
test('routes exact computer/task and ordinary replies; rejects cross-owner and wrong channel', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  await s.router.receive(s.input('<@UBOT> windows first', { ts: '1.123' }));
  expect(s.router.poll(s.owner.token)?.threadId).toBe('thread-windows');
  expect(s.router.poll(s.other.token)).toBeNull();
  await s.router.receive(s.input('continue', { threadTs: '1.123' }));
  expect(s.router.poll(s.owner.token)?.event.text).toBe('continue');
  await s.router.receive(s.input('<@UBOT> hochi steal'));
  expect(s.router.poll(s.other.token)).toBeNull();
  expect(s.messages.at(-1)?.text).toMatch(/not been shared/);
  await s.router.receive(s.input('<@UBOT> windows wrong', { channel: 'C999' }));
  expect(s.router.poll(s.owner.token)).toBeNull();
});
test('duplicate events do not run twice; offline/restart never falls back or replays', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  const e = s.input('<@UBOT> windows once');
  await s.router.receive(e); await s.router.receive(e);
  expect(s.router.poll(s.owner.token)).not.toBeNull(); expect(s.router.poll(s.owner.token)).toBeNull();
  s.router.disconnect(s.owner.token);
  await s.router.receive(s.input('<@UBOT> windows offline'));
  expect(s.messages.at(-1)?.text).toMatch(/offline/);
  const restored = new Router(s.config, 'UBOT', s.file, async () => {}, async () => {});
  await restored.receive(e); expect(restored.poll(s.owner.token)).toBeNull();
});
test('a connector cannot claim an alias or output destination from another device', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  expect(() => s.router.register(s.other.token, { name: 'windows', threadId: 'thread-windows' })).toThrow();
  await s.router.receive(s.input('<@UBOT> windows hello', { ts: '1.123' }));
  const out = { id: 'out-1', name: 'windows', threadId: 'thread-windows', root: '1.123', text: 'reply' };
  await expect(s.router.output(s.other.token, out)).rejects.toThrow();
  await expect(s.router.output(s.owner.token, { ...out, root: '2.123' })).rejects.toThrow();
  await s.router.output(s.owner.token, out); await s.router.output(s.owner.token, out);
  expect(s.messages.filter(m => m.text === 'reply')).toHaveLength(1);
});
test('sharing labels collaborator authority, unshare and revocation take effect', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  await s.router.receive(s.input('<@UBOT> share windows <@U456>'));
  await s.router.receive(s.input('<@UBOT> windows ask', { user: 'U456' }));
  const job = s.router.poll(s.owner.token)!;
  expect(job.ownerId).toBe('U123'); expect(job.event.user).toBe('U456'); expect(job.collaboratorIds).toEqual(['U456']);
  await s.router.receive(s.input('<@UBOT> unshare windows <@U456>'));
  await s.router.receive(s.input('<@UBOT> windows ask', { user: 'U456' }));
  expect(s.router.poll(s.owner.token)).toBeNull();
  await s.router.receive(s.input('<@UBOT> share windows <@U456>'));
  await s.router.receive(s.input('<@UBOT> windows queued', { user: 'U456' }));
  await s.router.receive(s.input('<@UBOT> unshare windows <@U456>'));
  expect(s.router.poll(s.owner.token)).toBeNull();
  await s.router.receive(s.input('<@UBOT> revoke windows'));
  expect(() => s.router.poll(s.owner.token)).toThrow(/not authorized/);
});
test('connect invitations are delivered privately, not to the channel', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  await s.router.receive(s.input('<@UBOT> connect'));
  expect(s.privateMessages).toHaveLength(1); expect(s.messages).toHaveLength(0);
});
test('HTTP connector enrollment, registration and dispatch works across the real transport', async t => {
  const s = setup(); const api = createApi(s.router);
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); fs.rmSync(s.dir, { recursive: true }); });
  const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const enrolled = await call(url, '', '/enroll', { code: s.router.invite('U123', 'C123') }) as { token: string };
  await call(url, enrolled.token, '/register', { name: 'third', threadId: 'third-thread' });
  await call(url, enrolled.token, '/poll', {});
  await s.router.receive(s.input('<@UBOT> third hello'));
  const result = await call(url, enrolled.token, '/poll', {}) as { job: { name: string } };
  expect(result.job.name).toBe('third');
  await expect(call(url, 'invalid', '/poll', {})).rejects.toThrow(/not authorized/);
});
test('remote plaintext, redirects with credentials, and URL credentials are refused', () => {
  expect(() => safeEndpoint('http://remote.example')).toThrow(/HTTPS/);
  expect(() => safeEndpoint('https://user:secret@example.com')).toThrow();
  expect(safeEndpoint('https://gateway.example')).toBe('https://gateway.example');
});
test('unregister removes only this connector’s agent and rejects its old output roots', async t => {
  const s = setup(); t.onTestFinished(() => fs.rmSync(s.dir, { recursive: true }));
  await s.router.receive(s.input('<@UBOT> windows once', { ts: '1.123' }));
  s.router.unregister(s.other.token, 'windows');
  expect(s.router.poll(s.owner.token)?.name).toBe('windows');
  s.router.unregister(s.owner.token, 'windows');
  await expect(s.router.output(s.owner.token, { id: 'out-1', name: 'windows', threadId: 'thread-windows', root: '1.123', text: 'stale' })).rejects.toThrow();
});
