import { randomUUID } from 'node:crypto';
import type { AppServer, RpcMessage, RpcId } from './app-server.js';
import type { Binding, Journal } from './binding.js';

type Post = (text: string, threadTs?: string) => Promise<void>;
type RelayRpc = Pick<AppServer, 'request' | 'respond' | 'reject'> & {
  on(event: string, listener: (...args: any[]) => void): unknown;
};
type PendingApproval = { id: RpcId; turnId: string; kind: 'approval' | 'answer'; questionId?: string };

/** One explicitly selected Codex conversation and one owner/channel. */
export class DirectRelay {
  private active: string | null = null;
  private starting = false;
  private ownedTurns = new Set<string>();
  private completedTurns = new Set<string>();
  private pending = new Map<string, PendingApproval>();
  private inputQueue = Promise.resolve();
  private outputQueue = Promise.resolve();
  private disconnected = false;
  private startingRoot?: string;
  private turnRoots = new Map<string, string | undefined>();

  constructor(private rpc: RelayRpc,
    private binding: Binding, private journal: Journal, private post: Post,
    private onFailure: (error: unknown) => void = () => {}) {
    rpc.on('notification', (message: RpcMessage) => {
      // Claim turn ownership synchronously, before a following item arrives.
      const p = message.params || {};
      if (p.threadId === binding.threadId && message.method === 'turn/started') {
        this.active = p.turn.id;
        if (this.starting) {
          this.ownedTurns.add(p.turn.id);
          this.turnRoots.set(p.turn.id, this.startingRoot);
        }
      }
      this.outputQueue = this.outputQueue.then(() => this.notification(message)).catch(onFailure);
    });
    rpc.on('request', (message: RpcMessage) => {
      this.outputQueue = this.outputQueue.then(() => this.serverRequest(message)).catch(onFailure);
    });
    rpc.on('disconnect', () => { this.disconnected = true; this.pending.clear(); });
  }

  async connect(): Promise<void> {
    const result = await this.rpc.request('thread/resume', {
      threadId: this.binding.threadId, excludeTurns: true,
    });
    if (result.thread?.id !== this.binding.threadId) throw new Error('Codex returned a different task');
    // An already-running desktop turn is not owned by this bridge.
    if (result.thread.status?.type === 'active') this.active = 'external';
  }

  flush(): Promise<void> { return this.outputQueue; }

  receive(event: { id: string; user?: string; channel?: string; text?: string;
    bot_id?: string; subtype?: string; hasFiles?: boolean; threadTs?: string }): Promise<void> {
    if ((event.user !== this.binding.ownerId && !this.binding.collaboratorIds?.includes(event.user || '')) || event.channel !== this.binding.channelId
      || event.bot_id || (event.subtype && event.subtype !== 'file_share') || !event.id) return Promise.resolve();
    const task = this.inputQueue.then(async () => {
      const key = `in:${event.id}`;
      if (!this.journal.claim(key)) return;
      try {
        if (this.disconnected) throw new Error('Codex disconnected. Restart the bridge before sending a new message.');
        if (event.hasFiles) throw new Error('This direct connection currently accepts text. Files were not sent to Codex.');
        const text = event.text?.trim();
        if (!text) { this.journal.done(key); return; }
        if (event.user !== this.binding.ownerId && (/^(approve|deny|answer)\s/.test(text)
          || text === '/sab-stop' || text === 'sab stop'))
          throw new Error('Only the agent owner can approve, answer interactions, or stop this agent.');
        if (text === '/sab-status' || text === 'sab status') {
          await this.post(`Codex task ${this.binding.threadId}: ${this.active ? 'working' : 'ready'}.`, event.threadTs);
        } else if (text === '/sab-stop' || text === 'sab stop') {
          if (this.active && this.ownedTurns.has(this.active)) {
            await this.rpc.request('turn/interrupt', { threadId: this.binding.threadId, turnId: this.active });
          } else await this.post('No turn started by this bridge is running.', event.threadTs);
        } else if (/^(approve|deny|answer)\s/.test(text)) {
          await this.answer(text, event.threadTs);
        } else if (text.startsWith('/sab-')) {
          await this.post('Direct mode supports /sab-status and /sab-stop. Send ordinary text to the selected agent.', event.threadTs);
        } else {
          if (this.active || this.starting) throw new Error('This agent is busy. Wait for it to finish before sending another message.');
          this.starting = true;
          this.startingRoot = event.threadTs;
          try {
            const result = await this.rpc.request('turn/start', {
              threadId: this.binding.threadId,
              input: [{ type: 'text', text: event.user === this.binding.ownerId ? text
                : `[Slack collaborator ${event.user}; not the agent owner]\n${text}`, text_elements: [] }],
            });
            if (!this.completedTurns.has(result.turn.id)) {
              this.active = result.turn.id;
              this.ownedTurns.add(result.turn.id);
              this.turnRoots.set(result.turn.id, event.threadTs);
            }
          } catch (error) {
            // A missing response does not prove that turn/start failed to execute.
            // Require reconnection instead of allowing another blind submission.
            this.disconnected = true;
            throw error;
          } finally { this.starting = false; }
        }
        this.journal.done(key);
      } catch (error) {
        // The durable claim remains: a timeout may have reached Codex already.
        await this.post(error instanceof Error ? error.message : 'Request failed; it was not retried.', event.threadTs);
      }
    });
    this.inputQueue = task.catch(this.onFailure);
    return task;
  }

  private async notification(message: RpcMessage): Promise<void> {
    const p = message.params || {};
    if (p.threadId !== this.binding.threadId) return;
    if (message.method === 'serverRequest/resolved') {
      for (const [key, request] of this.pending) if (request.id === p.requestId) this.pending.delete(key);
      return;
    }
    if (message.method === 'turn/completed') {
      const id = p.turn?.id;
      this.completedTurns.add(id);
      if (this.active === id || this.active === 'external') this.active = null;
      for (const [key, request] of this.pending) if (request.turnId === id) this.pending.delete(key);
      if (!this.ownedTurns.has(id)) return;
      if (p.turn.status !== 'completed') {
        await this.once(`turn:${id}`, `Codex turn ${p.turn.status}.`, id);
      }
      this.ownedTurns.delete(id);
      this.turnRoots.delete(id);
      return;
    }
    if (!this.ownedTurns.has(p.turnId)) return;
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage'
      && typeof p.item.text === 'string' && p.item.text.trim()) {
      // Never mirror tools, command output, reasoning, or historical turns.
      await this.once(`out:${p.turnId}:${p.item.id}`, p.item.text, p.turnId);
    }
  }

  private async once(key: string, text: string, turnId: string): Promise<void> {
    if (!this.journal.claim(key)) return;
    await this.post(text, this.turnRoots.get(turnId));
    this.journal.done(key);
  }

  private async serverRequest(message: RpcMessage): Promise<void> {
    const p = message.params || {};
    if (message.id === undefined) return;
    if (p.threadId !== this.binding.threadId || !this.ownedTurns.has(p.turnId)) {
      this.rpc.reject(message.id, 'Request is outside this bridge-owned turn'); return;
    }
    const key = randomUUID().slice(0, 8);
    if (message.method === 'item/commandExecution/requestApproval'
      || message.method === 'item/fileChange/requestApproval') {
      this.pending.set(key, { id: message.id, turnId: p.turnId, kind: 'approval' });
      await this.post(`Codex requests approval: ${String(p.reason || p.command || 'file changes').slice(0, 2500)}\nReply \`approve ${key}\` or \`deny ${key}\`.`, this.turnRoots.get(p.turnId));
    } else if (message.method === 'item/tool/requestUserInput' && p.questions?.length === 1) {
      const question = p.questions[0];
      this.pending.set(key, { id: message.id, turnId: p.turnId, kind: 'answer', questionId: question.id });
      const options = (question.options || []).map((o: { label: string }) => o.label).join(' / ');
      await this.post(`${question.question}${options ? '\n' + options : ''}\nReply \`answer ${key} your answer\`.`, this.turnRoots.get(p.turnId));
    } else {
      this.rpc.reject(message.id, 'This request requires a supported Codex client');
      await this.post('Codex requested an interaction this bridge does not yet support. Continue that interaction in Codex.', this.turnRoots.get(p.turnId));
    }
  }

  private async answer(text: string, root?: string): Promise<void> {
    const match = /^(approve|deny|answer)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text);
    const request = match && this.pending.get(match[2]);
    if (!match || !request || !this.ownedTurns.has(request.turnId) || request.turnId !== this.active
      || this.turnRoots.get(request.turnId) !== root)
      throw new Error('That request is missing, expired, or belongs to a completed turn.');
    if (request.kind === 'approval' && (match[1] === 'approve' || match[1] === 'deny')) {
      this.rpc.respond(request.id, { decision: match[1] === 'approve' ? 'accept' : 'decline' });
    } else if (request.kind === 'answer' && match[1] === 'answer' && match[3]) {
      this.rpc.respond(request.id, { answers: { [request.questionId!]: { answers: [match[3]] } } });
    } else throw new Error('Use the response format shown with the request.');
    this.pending.delete(match[2]);
    await this.post('Response sent to Codex.', this.turnRoots.get(request.turnId));
  }
}
