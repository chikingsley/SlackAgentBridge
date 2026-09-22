import { z } from 'zod';

export const slackId = z.string().regex(/^[CUWG][A-Z0-9]+$/);
export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const timestamp = z.string().regex(/^\d+\.\d+$/);
export const botIdentity = z.object({ userId: slackId, botId: z.string().regex(/^B[A-Z0-9]+$/) }).strict();
export const botCollaborator = botIdentity.extend({
  channelId: slackId, agentName: alias, maxTurnsPerThread: z.number().int().min(1).max(10).optional(),
}).strict();
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
  publicChannelIds: z.array(slackId).optional(),
  botCollaborators: z.array(botCollaborator).optional(),
  publicUrl: z.string().url(), port: z.number().int().min(1024).max(65535).default(8877),
}).strict().superRefine((config, context) => {
  if (config.publicChannelIds?.some(id => !config.channelIds.includes(id))
    || config.botCollaborators?.some(bot => !config.channelIds.includes(bot.channelId)))
    context.addIssue({ code: 'custom', message: 'Public channels and bot collaborators must use configured channels' });
  if (config.botCollaborators?.some(bot => config.allowedUserIds.includes(bot.userId)))
    context.addIssue({ code: 'custom', message: 'Keep bot identities separate from human owners' });
});
export type GatewayConfig = z.infer<typeof gatewayConfig>;

export function verifyChannel(config: GatewayConfig, id: string, channel?: { is_private?: boolean; is_member?: boolean }): void {
  if (!config.channelIds.includes(id) || !channel?.is_member
    || (!channel.is_private && !config.publicChannelIds?.includes(id)))
    throw new Error(`Invite the bot to the explicitly authorized channel ${id}; public channels require publicChannelIds`);
}

export function safeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Gateway URL must be an origin without credentials, query or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    throw new Error('Remote connections require HTTPS');
  return url.origin;
}
