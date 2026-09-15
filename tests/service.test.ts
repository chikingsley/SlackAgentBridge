import { test, expect } from 'vitest';
import { startControl } from '../src/service.js';
test('background service stops only through its fresh private loopback token', async () => {
  let stopped = false;
  const control = await startControl(async () => { stopped = true; });
  try {
    const url = `http://127.0.0.1:${control.port}`;
    expect((await fetch(url + '/stop', { method: 'POST' })).status).toBe(403);
    expect(stopped).toBe(false);
    expect((await fetch(url + '/stop', { method: 'POST', headers: { Authorization: `Bearer ${control.token}` } })).status).toBe(200);
    expect(stopped).toBe(true);
  } finally { control.close(); }
});
