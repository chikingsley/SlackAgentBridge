import { EventEmitter } from 'node:events';
import { test, expect } from 'vitest';
import { initializeTask } from '../src/connector/initialize.js';

test('fresh tasks complete their first turn before closing, including notification-before-response', async () => {
  class Rpc extends EventEmitter {
    async request(method: string, params: Record<string, unknown>) {
      expect(method).toBe('turn/start'); expect(params.threadId).toBe('selected');
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'other-turn', status: 'failed' } } });
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'selected', turn: { id: 'init', status: 'completed' } } });
      return { turn: { id: 'init' } };
    }
  }
  const rpc = new Rpc(); await initializeTask(rpc, 'selected');
  expect(rpc.listenerCount('notification')).toBe(0);
});
test('failed initialization does not present an unusable task as ready', async () => {
  class Rpc extends EventEmitter {
    async request() {
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'selected', turn: { id: 'init', status: 'failed' } } });
      return { turn: { id: 'init' } };
    }
  }
  await expect(initializeTask(new Rpc(), 'selected')).rejects.toThrow(/did not complete/);
});
