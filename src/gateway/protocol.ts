import { z } from 'zod';

export const slackId = z.string().regex(/^[CUWG][A-Z0-9]+$/);
export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const timestamp = z.string().regex(/^\d+\.\d+$/);
export const registration = z.object({ name: alias, threadId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/) }).strict();
export const inputSchema = z.object({
  id: z.string().min(1).max(200), channel: slackId, user: slackId,
  text: z.string().max(30000), ts: timestamp, threadTs: timestamp.optional(),
  botId: z.string().optional(), subtype: z.string().optional(), hasFiles: z.boolean().optional(),
});
export type Input = z.infer<typeof inputSchema>;
export const jobSchema = z.object({
  name: alias, threadId: registration.shape.threadId, event: inputSchema,
  ownerId: slackId, channelId: slackId, collaboratorIds: z.array(slackId),
});
export type Job = z.infer<typeof jobSchema>;
export const outputSchema = z.object({
  id: z.string().min(1).max(200), name: alias, threadId: registration.shape.threadId,
  root: timestamp, text: z.string().min(1).max(60000),
}).strict();
export const gatewayConfig = z.object({
  workspaceDomain: z.string().regex(/^[a-z0-9-]+\.slack\.com$/),
  channelIds: z.array(slackId).min(1), allowedUserIds: z.array(slackId).min(1),
  publicUrl: z.string().url(), port: z.number().int().min(1024).max(65535).default(8877),
}).strict();
export type GatewayConfig = z.infer<typeof gatewayConfig>;

export function safeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Gateway URL must be an origin without credentials, query or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    throw new Error('Remote connections require HTTPS');
  return url.origin;
}
