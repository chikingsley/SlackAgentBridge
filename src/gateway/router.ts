import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { Journal } from '../direct/binding.js';
import { registration, outputSchema, type Input, type Job, type GatewayConfig } from './protocol.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const deviceSchema = z.object({ id: z.string(), hash: z.string(), ownerId: z.string(), channelId: z.string(), revoked: z.boolean() });
const agentSchema = registration.extend({ deviceId: z.string(), ownerId: z.string(), channelId: z.string(), collaboratorIds: z.array(z.string()) });
const stateSchema = z.object({
  devices: z.array(deviceSchema), agents: z.array(agentSchema),
  invites: z.array(z.object({ hash: z.string(), ownerId: z.string(), channelId: z.string(), expires: z.number() })),
  roots: z.record(z.string(), z.string()),
});
type Device = z.infer<typeof deviceSchema>;
type Agent = z.infer<typeof agentSchema>;
export type Post = (channel: string, text: string, root: string) => Promise<void>;

/** Gateway has no Codex process or local execution fallback. */
export class Router {
  private state: z.infer<typeof stateSchema>;
  private journal: Journal;
  private online = new Map<string, number>();
  private queues = new Map<string, Job[]>();
  private chain = Promise.resolve();
  constructor(private config: GatewayConfig, private botId: string, private file: string,
    private post: Post, private ephemeral: (channel: string, user: string, text: string) => Promise<void>) {
    this.state = stateSchema.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { devices: [], agents: [], invites: [], roots: {} });
    this.journal = new Journal(file + '.events.json');
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  invite(ownerId: string, channelId: string): string {
    if (!this.config.allowedUserIds.includes(ownerId) || !this.config.channelIds.includes(channelId)) throw new Error('Not authorized');
    const code = randomBytes(32).toString('base64url');
    this.state.invites = this.state.invites.filter(i => i.expires > Date.now() && !(i.ownerId === ownerId && i.channelId === channelId));
    this.state.invites.push({ hash: hash(code), ownerId, channelId, expires: Date.now() + 600_000 });
    this.save(); return code;
  }
  enroll(code: string) {
    const i = this.state.invites.findIndex(i => i.hash === hash(code) && i.expires > Date.now());
    if (i < 0) throw new Error('Invalid or expired invitation');
    const invite = this.state.invites.splice(i, 1)[0];
    if (!this.config.allowedUserIds.includes(invite.ownerId) || !this.config.channelIds.includes(invite.channelId)) throw new Error('Not authorized');
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), hash: hash(token), ownerId: invite.ownerId, channelId: invite.channelId, revoked: false };
    this.state.devices.push(device); this.save();
    return { token, deviceId: device.id, ownerId: device.ownerId, channelId: device.channelId };
  }
  authenticate(token: string): Device {
    const d = this.state.devices.find(d => !d.revoked && d.hash === hash(token));
    if (!d || !this.config.allowedUserIds.includes(d.ownerId) || !this.config.channelIds.includes(d.channelId)) throw new Error('Connector not authorized');
    return d;
  }
  register(token: string, value: unknown) {
    const d = this.authenticate(token), input = registration.parse(value);
    const prior = this.state.agents.find(a => a.channelId === d.channelId && a.name === input.name);
    if (prior) {
      if (prior.deviceId !== d.id || prior.threadId !== input.threadId) throw new Error('Alias is already registered to a different connector or task');
      return prior;
    }
    if (this.state.agents.length >= 100) throw new Error('Agent limit reached');
    const agent = { ...input, deviceId: d.id, ownerId: d.ownerId, channelId: d.channelId, collaboratorIds: [] };
    this.state.agents.push(agent); this.save(); return agent;
  }
  unregister(token: string, name: string): void {
    const d = this.authenticate(token);
    const a = this.state.agents.find(a => a.deviceId === d.id && a.name === name);
    if (!a) return;
    const key = this.key(a);
    this.state.agents = this.state.agents.filter(a => this.key(a) !== key);
    for (const [root, target] of Object.entries(this.state.roots)) if (target === key) delete this.state.roots[root];
    this.save();
  }
  poll(token: string): Job | null {
    const d = this.authenticate(token);
    this.online.set(d.id, Date.now());
    const queue = this.queues.get(d.id);
    // Claim once. A lost response must never start the same work again.
    let job: Job | undefined;
    while ((job = queue?.shift())) {
      const a = this.state.agents.find(a => a.deviceId === d.id && a.name === job!.name && a.threadId === job!.threadId);
      if (a && (a.ownerId === job.event.user || a.collaboratorIds.includes(job.event.user)))
        return { ...job, collaboratorIds: [...a.collaboratorIds] };
    }
    return null;
  }
  disconnect(token: string): void {
    const d = this.authenticate(token); this.online.delete(d.id); this.queues.delete(d.id);
  }
  async output(token: string, value: unknown): Promise<void> {
    const d = this.authenticate(token), out = outputSchema.parse(value);
    const a = this.state.agents.find(a => a.deviceId === d.id && a.name === out.name && a.threadId === out.threadId);
    if (!a || this.state.roots[`${a.channelId}:${out.root}`] !== this.key(a)) throw new Error('Output has no authorized destination');
    const key = `out:${d.id}:${out.id}`;
    if (!this.journal.claim(key)) return;
    await this.post(a.channelId, out.text, out.root); this.journal.done(key);
  }
  private key(a: Agent) { return `${a.deviceId}:${a.name}:${a.threadId}`; }
  receive(e: Input): Promise<void> {
    const next = this.chain.then(() => this.dispatch(e));
    this.chain = next.catch(() => {}); return next;
  }
  private async dispatch(e: Input) {
    if (!this.config.allowedUserIds.includes(e.user) || !this.config.channelIds.includes(e.channel)
      || e.botId || (e.subtype && e.subtype !== 'file_share')) return;
    const mention = `<@${this.botId}>`, root = e.threadTs || e.ts;
    const bound = this.state.roots[`${e.channel}:${root}`];
    if (!e.text.includes(mention) && !bound) return;
    if (!this.journal.claim(`in:${e.id}`)) return;
    try {
      let text = e.text.replaceAll(mention, '').trim().replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      let a = this.state.agents.find(a => this.key(a) === bound);
      if (!a) {
        const [command, name, person] = text.split(/\s+/);
        if (command === 'connect') {
          const code = this.invite(e.user, e.channel);
          await this.ephemeral(e.channel, e.user, `On YOUR computer, in the cloned bridge repository, run:\nnpm run connect -- --url ${this.config.publicUrl} --invite ${code}\nThis private invitation expires in 10 minutes and works once. Then add a named agent locally with npm run agent -- --name my-agent --cwd /your/workspace and run npm run start:connector.`);
          return;
        }
        if (command === 'list') {
          const list = this.state.agents.filter(a => a.channelId === e.channel && (a.ownerId === e.user || a.collaboratorIds.includes(e.user)))
            .map(a => `${a.name} — ${this.isOnline(a.deviceId) ? 'online' : 'offline'} (owner ${a.ownerId})`);
          await this.post(e.channel, list.join('\n') || 'No agents registered. Mention me with “connect” to connect your computer.', root); return;
        }
        if (command === 'share' || command === 'unshare' || command === 'revoke' || command === 'remove') {
          a = this.state.agents.find(a => a.channelId === e.channel && a.name === name);
          if (!a || a.ownerId !== e.user) throw new Error('Only the owner can change this agent’s access');
          if (command === 'remove') {
            const key = this.key(a);
            this.state.agents = this.state.agents.filter(agent => this.key(agent) !== key);
            for (const [root, target] of Object.entries(this.state.roots)) if (target === key) delete this.state.roots[root];
            this.save(); await this.post(e.channel, 'Agent unregistered. Stop its connector and remove its local entry before restarting. The native task remains on its computer.', root); return;
          }
          if (command === 'revoke') {
            const d = this.state.devices.find(d => d.id === a!.deviceId)!; d.revoked = true;
            this.online.delete(d.id); this.queues.delete(d.id);
            this.save(); await this.post(e.channel, 'Connector revoked. It can no longer receive work or send output.', root); return;
          }
          const user = /^<@([UW][A-Z0-9]+)>$/.exec(person || '')?.[1];
          if (!user || !this.config.allowedUserIds.includes(user)) throw new Error('Choose an explicitly authorized Slack member');
          a.collaboratorIds = a.collaboratorIds.filter(id => id !== user);
          if (command === 'share') a.collaboratorIds.push(user);
          this.save(); await this.post(e.channel, `Updated prompt access for ${a.name}. Approvals remain owner-only.`, root); return;
        }
        if (!command || command === 'help' || command === 'new') {
          await this.post(e.channel, 'Use “connect” to pair your own computer privately, “list” to see agents, or “agent-name your question”. Reply in its Slack thread to continue. Create/select tasks on your own computer with npm run agent. Owners can “share name @person”, “unshare name @person”, or “revoke name”.', root); return;
        }
        a = this.state.agents.find(a => a.channelId === e.channel && a.name === command);
        if (!a) throw new Error('Unknown agent. Use “list” or connect and register one from your computer.');
        text = text.slice(command.length).trim();
      }
      if (a.ownerId !== e.user && !a.collaboratorIds.includes(e.user)) throw new Error('This agent has not been shared with you');
      if (!text) throw new Error('Add a question');
      if (!this.isOnline(a.deviceId)) throw new Error('This agent’s computer is offline. Nothing was sent; try again when its connector is running.');
      const queue = this.queues.get(a.deviceId) || [];
      if (queue.length >= 10) throw new Error('Connector queue is full; try again later');
      this.state.roots[`${e.channel}:${root}`] = this.key(a); this.save();
      queue.push({ name: a.name, threadId: a.threadId, ownerId: a.ownerId, channelId: a.channelId,
        collaboratorIds: [...a.collaboratorIds], event: { ...e, text, threadTs: root } });
      this.queues.set(a.deviceId, queue);
    } catch (error) { await this.post(e.channel, error instanceof Error ? error.message : 'Request failed; not retried', root); }
    finally { this.journal.done(`in:${e.id}`); }
  }
  private isOnline(id: string) { return Date.now() - (this.online.get(id) || 0) < 10000; }
}
