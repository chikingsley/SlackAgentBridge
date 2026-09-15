import { test, expect, vi, type TestContext } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHub, type AgentBackend, type SlackInput } from '../../src/direct/hub.js';

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-hub-'));
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receives = new Map<string, ReturnType<typeof vi.fn>>();
  let sequence = 0;
  const backend: AgentBackend = {
    create: vi.fn(async () => `task-000${++sequence}`),
    connect: vi.fn(async (agent, post) => {
      const receive = vi.fn(async (event) => { await post(`answer:${event.text}`, event.threadTs); });
      receives.set(agent.threadId, receive);
      return { receive, close: async () => {} };
    }),
  };
  const config = { workspaceDomain: 'constructioncopilot.slack.com', channelIds: ['CTEST'],
    allowedUserIds: ['UOWNER', 'UOTHER'], workspaceRoot: path.join(dir, 'work') };
  const stateFile = path.join(dir, 'state.json');
  const post = vi.fn(async (_channel: string, _text: string, _root: string) => {});
  const hub = new AgentHub(config, 'UBOT', stateFile, backend, post);
  const event: SlackInput = { id: 'e1', channel: 'CTEST', user: 'UOWNER', ts: '100.001', text: '<@UBOT> new alpha' };
  return { hub, backend, receives, event, post, config, stateFile };
}

test('ignores unconfigured places, users, bots and ordinary channel conversation', async t => {
  const { hub, event, backend, post } = fixture(t);
  for (const patch of [{channel: 'COTHER'}, {user: 'USTRANGER'}, {botId: 'BBOT'}, {text: 'ordinary chat'}, {subtype: 'message_changed'}])
    await hub.receive({ ...event, ...patch });
  expect(backend.create).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

test('creates a named agent once; mentions and replies route to its exact task and Slack root', async t => {
  const { hub, event, backend, receives, post } = fixture(t);
  await hub.receive(event); await hub.receive(event);
  expect(backend.create).toHaveBeenCalledTimes(1);
  await hub.receive({ ...event, id: 'e2', ts: '100.002', text: '<@UBOT> alpha hello' });
  await hub.receive({ ...event, id: 'e3', ts: '100.003', threadTs: '100.002', text: 'follow-up' });
  expect(receives.get('task-0001')).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenLastCalledWith('CTEST', 'answer:follow-up', '100.002');
});

test('different agents preserve independent reply routes and ownership', async t => {
  const { hub, event, receives, post } = fixture(t);
  await hub.receive(event);
  await hub.receive({ ...event, id: 'e2', ts: '100.002', user: 'UOTHER', text: '<@UBOT> new beta' });
  await hub.receive({ ...event, id: 'e3', ts: '100.003', threadTs: '100.002', text: 'intrusion' });
  expect(receives.get('task-0002')).not.toHaveBeenCalled();
  expect(post.mock.calls.at(-1)?.[1]).toMatch(/Only this agent/);
  await hub.receive({ ...event, id: 'e4', ts: '100.004', threadTs: '100.001', text: 'alpha follow-up' });
  expect(receives.get('task-0001')).toHaveBeenCalledOnce();
  expect(post).toHaveBeenLastCalledWith('CTEST', 'answer:alpha follow-up', '100.001');
});

test('restart restores reply bindings and does not replay already claimed creation', async t => {
  const { hub, event, backend, config, stateFile, post } = fixture(t);
  await hub.receive(event); await hub.close();
  const restarted = new AgentHub(config, 'UBOT', stateFile, backend, post);
  await restarted.receive(event);
  await restarted.receive({ ...event, id: 'e2', ts: '100.002', threadTs: '100.001', text: 'continue' });
  expect(backend.create).toHaveBeenCalledOnce();
  expect(post).toHaveBeenLastCalledWith('CTEST', 'answer:continue', '100.001');
});

test('uncertain creation is never replayed and invalid names never create a workspace', async t => {
  const { hub, event, backend } = fixture(t);
  await hub.receive({ ...event, id: 'invalid', text: '<@UBOT> new ../../outside' });
  expect(backend.create).not.toHaveBeenCalled();
  vi.mocked(backend.create).mockRejectedValueOnce(new Error('timeout'));
  await hub.receive(event); await hub.receive(event);
  expect(backend.create).toHaveBeenCalledOnce();
});

test('only the owner may explicitly share an agent with another configured person', async t => {
  const { hub, event, receives, post } = fixture(t);
  await hub.receive(event);
  await hub.receive({ ...event, id: 'e2', ts: '100.002', user: 'UOTHER', text: '<@UBOT> share alpha <@UOTHER>' });
  expect(post.mock.calls.at(-1)?.[1]).toMatch(/Only an agent/);
  await hub.receive({ ...event, id: 'e3', ts: '100.003', text: '<@UBOT> share alpha <@UOTHER>' });
  await hub.receive({ ...event, id: 'e4', ts: '100.004', user: 'UOTHER', text: '<@UBOT> alpha a shared question' });
  expect(receives.get('task-0001')).toHaveBeenCalledWith(expect.objectContaining({user:'UOTHER',text:'a shared question',threadTs:'100.004'}));
  expect(post).toHaveBeenLastCalledWith('CTEST', 'answer:a shared question', '100.004');
});
