import { z } from 'zod';
import { safeEndpoint, registration, slackId } from '../gateway/protocol.js';

export const connectorConfig = z.object({
  url: z.string(), token: z.string().min(40), deviceId: z.string(), ownerId: slackId, channelId: slackId,
  codexPath: z.string().optional(),
  agents: z.array(registration.extend({ cwd: z.string() })),
}).strict();
export type ConnectorConfig = z.infer<typeof connectorConfig>;
export async function call(url: string, token: string, route: string, body: unknown): Promise<unknown> {
  const response = await fetch(safeEndpoint(url) + route, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error || 'Gateway request failed');
  return value;
}
