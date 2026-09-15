import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppServer } from './app-server.js';
import { DirectRelay } from './relay.js';
import { Journal } from './binding.js';

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
export const hubConfigSchema = z.object({
  workspaceDomain: z.string().regex(/^[a-z0-9-]+\.slack\.com$/),
  channelIds: z.array(slackId).min(1),
  allowedUserIds: z.array(slackId).min(1),
  workspaceRoot: z.string().min(1),
  codexPath: z.string().optional(),
}).strict();
export type HubConfig = z.infer<typeof hubConfigSchema>;
const agentSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  channelId: slackId, ownerId: slackId, threadId: z.string().min(8), cwd: z.string(),
  collaboratorIds: z.array(slackId).default([]),
});
type Agent = z.infer<typeof agentSchema>;
const stateSchema = z.object({ agents: z.array(agentSchema), roots: z.record(z.string(), z.string()) });
export type SlackInput = {
  id: string; channel: string; user: string; text: string; ts: string;
  threadTs?: string; botId?: string; subtype?: string; hasFiles?: boolean;
};
type Post = (channel: string, text: string, root: string) => Promise<void>;
type Connection = { receive: DirectRelay['receive']; close: () => Promise<void> };
export type AgentBackend = {
  create: (cwd: string) => Promise<string>;
  connect: (agent: Agent, post: (text: string, root?: string) => Promise<void>) => Promise<Connection>;
};

/** Native Codex owns each explicitly registered conversation. No task discovery. */
export function nativeBackend(config: HubConfig, stateFile: string): AgentBackend {
  const starting = new Map<string, AppServer>();
  return {
    async create(cwd) {
      const rpc = new AppServer(config.codexPath);
      try {
        await rpc.start();
        const result = await rpc.request('thread/start', {
          cwd, approvalPolicy: 'on-request', sandbox: 'read-only',
          developerInstructions: 'You are a named agent connected to Slack. Answer the current user directly and concisely. Your final answer is delivered to their Slack thread. Do not seek other conversations or send messages through other services. Work only in the supplied workspace unless the owner explicitly authorizes otherwise.',
        });
        const id = result.thread?.id;
        if (typeof id !== 'string' || !id) throw new Error('Codex did not return a task ID');
        starting.set(id, rpc);
        return id;
      } catch (error) { await rpc.close(); throw error; }
    },
    async connect(agent, post) {
      const existing = starting.get(agent.threadId);
      const rpc = existing || new AppServer(config.codexPath);
      starting.delete(agent.threadId);
      try {
        if (!existing) await rpc.start();
        const relay = new DirectRelay(rpc, agent,
          new Journal(`${stateFile}.${agent.threadId}.delivery.json`), post,
          error => console.error('Agent delivery failed:', error instanceof Error ? error.message : 'unknown'));
        if (!existing) await relay.connect();
        return { receive: event => relay.receive(event), close: () => rpc.close() };
      } catch (error) { await rpc.close(); throw error; }
    },
  };
}

/** Only explicit mentions and known reply threads can dispatch a prompt. */
export class AgentHub {
  private state: z.infer<typeof stateSchema>;
  private connections = new Map<string, Connection>();
  private journal: Journal;
  private queue = Promise.resolve();

  constructor(private config: HubConfig, private botId: string,
    private stateFile: string, private backend: AgentBackend, private post: Post) {
    this.state = stateSchema.parse(fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { agents: [], roots: {} });
    this.journal = new Journal(stateFile + '.events.json');
  }

  receive(event: SlackInput): Promise<void> {
    if (!this.config.channelIds.includes(event.channel) || !this.config.allowedUserIds.includes(event.user)
      || event.botId || (event.subtype && event.subtype !== 'file_share') || !event.id) return Promise.resolve();
    const task = this.queue.then(() => this.dispatch(event));
    this.queue = task.catch(error => console.error(error instanceof Error ? error.message : 'Slack dispatch failed'));
    return task;
  }

  private async dispatch(event: SlackInput): Promise<void> {
    const mention = `<@${this.botId}>`;
    const addressed = event.text.includes(mention);
    const root = event.threadTs || event.ts;
    if (!/^\d+\.\d+$/.test(root)) return;
    const rootKey = `${event.channel}:${root}`;
    const boundId = this.state.roots[rootKey];
    if (!addressed && !boundId) return;
    if (!this.journal.claim(event.id)) return;
    try {
      let text = event.text.replaceAll(mention, '').trim()
        .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      let agent = this.state.agents.find(a => a.threadId === boundId && a.channelId === event.channel);
      if (!agent) {
        if (!addressed) return;
        const [command, name, ...rest] = text.split(/\s+/);
        if (command === 'help' || !command) {
          await this.post(event.channel, 'Mention me with “new name” to create an agent, “list” to see your agents, or “name your question” to talk to one. Reply in its thread to continue. Only configured people and channels are connected.', root);
          return;
        }
        if (command === 'list') {
          const names = this.state.agents.filter(a => a.channelId === event.channel
            && (a.ownerId === event.user || a.collaboratorIds.includes(event.user))).map(a => a.name);
          await this.post(event.channel, names.length ? `Your agents: ${names.join(', ')}` : 'No agents yet. Mention me with “new name”.', root);
          return;
        }
        if (command === 'share') {
          const target = this.state.agents.find(a => a.channelId === event.channel && a.name === name);
          if (!target || target.ownerId !== event.user) throw new Error('Only an agent’s owner can share it.');
          const userId = /^<@([UW][A-Z0-9]+)>$/.exec(rest.join(' '))?.[1];
          if (!userId || !this.config.allowedUserIds.includes(userId))
            throw new Error('Use “share name @person” with a person explicitly authorized in this bridge’s configuration.');
          if (!target.collaboratorIds.includes(userId)) target.collaboratorIds.push(userId);
          this.save();
          // The existing relay holds the same agent object, so permission changes
          // apply immediately without interrupting its current native turn.
          await this.post(event.channel, `Agent “${name}” now accepts prompts from ${userId}. Its owner still controls approvals and stop.`, root);
          return;
        }
        if (command === 'new') {
          if (!name || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Use “new name” with a lowercase name, digits or hyphens.');
          if (this.state.agents.some(a => a.channelId === event.channel && a.name === name)) throw new Error('That agent name already exists in this channel.');
          if (this.state.agents.length >= 20) throw new Error('This bridge has reached its configured limit of 20 agents.');
          const cwd = path.join(path.resolve(this.config.workspaceRoot), event.user, name);
          fs.mkdirSync(cwd, { recursive: true });
          const threadId = await this.backend.create(cwd);
          agent = { name, ownerId: event.user, channelId: event.channel, threadId, cwd, collaboratorIds: [] };
          this.state.agents.push(agent);
          this.state.roots[rootKey] = threadId;
          this.save();
          await this.connection(agent);
          await this.post(event.channel, `Agent “${name}” is ready. Reply here to continue, or mention me with “${name} your question”.\nCodex task: ${threadId}`, root);
          text = rest.join(' ');
          if (!text) return;
        } else {
          agent = this.state.agents.find(a => a.channelId === event.channel && a.name === command);
          if (!agent) throw new Error('Unknown agent. Mention me with “list” or “new name”.');
          if (agent.ownerId !== event.user && !agent.collaboratorIds.includes(event.user)) throw new Error('That agent belongs to another person. Its owner can share it, or you can create your own with “new name”.');
          this.state.roots[rootKey] = agent.threadId;
          this.save();
          text = text.slice(command.length).trim();
        }
      }
      if (agent.ownerId !== event.user && !agent.collaboratorIds.includes(event.user)) throw new Error('Only this agent’s owner or explicitly shared collaborators can send it prompts.');
      if (!text) throw new Error('Add a question or reply in this thread.');
      const connection = await this.connection(agent);
      await connection.receive({ id: event.id, channel: event.channel, user: event.user,
        text, threadTs: root, hasFiles: event.hasFiles });
    } catch (error) {
      await this.post(event.channel, error instanceof Error ? error.message : 'Request failed; not retried.', root);
    } finally { this.journal.done(event.id); }
  }

  private async connection(agent: Agent): Promise<Connection> {
    let connection = this.connections.get(agent.threadId);
    if (!connection) {
      connection = await this.backend.connect(agent, async (text, root) => {
        if (!root || this.state.roots[`${agent.channelId}:${root}`] !== agent.threadId)
          throw new Error('No explicit Slack reply destination for this output');
        await this.post(agent.channelId, text, root);
      });
      this.connections.set(agent.threadId, connection);
    }
    return connection;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  async close(): Promise<void> {
    await this.queue;
    await Promise.all([...this.connections.values()].map(c => c.close()));
  }
}
