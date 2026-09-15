import http from 'node:http';
import { z } from 'zod';
import type { Router } from './router.js';

export function createApi(router: Router): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/health') { res.end('{"ready":true}'); return; }
      if (req.method !== 'POST' || !['/enroll', '/register', '/unregister', '/poll', '/output', '/disconnect'].includes(req.url || '')) {
        res.writeHead(404).end('{"error":"Not found"}'); return;
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (req.url !== '/enroll') router.authenticate(token);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 128000) throw new Error('Request too large');
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: unknown = JSON.parse(raw || '{}');
      let result: unknown = { ok: true };
      switch (req.url) {
        case '/enroll': result = router.enroll(z.object({ code: z.string().min(40).max(100) }).strict().parse(body).code); break;
        case '/register': result = router.register(token, body); break;
        case '/unregister': router.unregister(token, z.object({ name: z.string().min(1).max(40) }).strict().parse(body).name); break;
        case '/poll': result = { job: router.poll(token) }; break;
        case '/output': await router.output(token, body); break;
        case '/disconnect': router.disconnect(token); break;
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ error: error instanceof z.ZodError ? 'Invalid request'
        : error instanceof Error ? error.message : 'Request failed' }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
