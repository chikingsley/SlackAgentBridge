import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export type RpcId = string | number;
export type RpcMessage = {
  id?: RpcId; method?: string; params?: Record<string, any>;
  result?: any; error?: { code: number; message: string };
};

/** Codex's documented JSON-RPC-over-stdio transport, with no PTY or shell. */
export class AppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<RpcId, {
    resolve: (value: any) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stopped = false;

  constructor(private readonly executable = 'codex',
    private readonly args = ['app-server', '--listen', 'stdio://'],
    private readonly timeoutMs = 30_000) { super(); }

  async start(): Promise<void> {
    if (this.child) throw new Error('App Server client is already started');
    const env = { ...process.env };
    // This process is a client, not a child agent of the task launching it.
    for (const key of ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
      'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']) delete env[key];
    this.child = spawn(this.executable, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env,
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex App Server disconnected')));
    this.child.stdin.on('error', error => this.fail(error));
    // Drain stderr without leaking local configuration or credentials into Slack/logs.
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Invalid App Server JSON response')); this.child?.kill(); }
    });
    await this.request('initialize', {
      clientInfo: { name: 'slack_agent_bridge', title: 'Slack Agent Bridge', version: '2.1.0' },
    });
    this.send({ method: 'initialized', params: {} });
  }

  private receive(message: RpcMessage): void {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  }

  private send(message: RpcMessage): void {
    if (!this.child || this.stopped || !this.child.stdin.writable)
      throw new Error('Codex App Server is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server ${method} timed out; it was not retried`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  respond(id: RpcId, result: unknown): void { this.send({ id, result }); }
  reject(id: RpcId, message = 'Unsupported client request'): void {
    this.send({ id, error: { code: -32601, message } });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  async close(): Promise<void> {
    this.fail(new Error('App Server client closed'));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // The Windows Codex launcher wraps the real executable. Stop only our
        // owned process tree, rather than leaving the app-server child behind.
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error', () => { child.kill(); resolve(); });
          killer.on('exit', () => resolve());
        } else { child.kill(); resolve(); }
      }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
