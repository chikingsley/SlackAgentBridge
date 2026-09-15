import type { AppServer, RpcMessage } from '../direct/app-server.js';

/** Native empty tasks are not persisted until their first completed turn. */
export async function initializeTask(rpc: Pick<AppServer, 'request'> & {
  on(event: string, listener: (message: RpcMessage) => void): unknown;
  off(event: string, listener: (message: RpcMessage) => void): unknown;
}, threadId: string): Promise<void> {
  let turnId: string | undefined;
  const completed = new Map<string, string>();
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // The notification may arrive before the turn/start RPC response.
  const check = () => {
    if (!turnId || !completed.has(turnId)) return;
    if (completed.get(turnId) === 'completed') resolve();
    else reject(new Error('Native task initialization did not complete'));
  };
  const listener = (message: RpcMessage) => {
    if (message.method === 'turn/completed' && message.params?.threadId === threadId) {
      completed.set(message.params.turn.id, message.params.turn.status); check();
    }
  };
  const timeout = setTimeout(() => reject(new Error('Task initialization timed out; inspect the native task before retrying')), 90000);
  rpc.on('notification', listener);
  try {
    // Attach rejection handler immediately, even if RPC startup itself times out.
    const start = rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Initialize this explicitly selected Slack agent. Do not use tools. Reply exactly BRIDGE_READY.', text_elements: [] }] })
      .then(result => { turnId = result.turn.id; check(); });
    await Promise.all([start, done]);
  } finally { clearTimeout(timeout); rpc.off('notification', listener); }
}
