import { z } from 'zod';
import { PostMeetingSourceOptionSchema } from './postMeeting.js';

const entityId = z.string().trim().min(1).max(500);
const boundedText = z.string().trim().min(1).max(2_000);
const openKey = z.string().trim().min(1).max(80);
const utcInstant = z.string().datetime({ offset: true });
const minuteToken = /^[A-Za-z0-9_-]{8,200}$/;

function isFeishuMinuteInput(value: string): boolean {
  if (minuteToken.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'feishu.cn' && !hostname.endsWith('.feishu.cn')) return false;
    const match = url.pathname.match(/^\/minutes\/([^/]+)\/?$/);
    return Boolean(match?.[1] && minuteToken.test(match[1]));
  } catch {
    return false;
  }
}

function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isFeishuAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'accounts.feishu.cn'
      && url.pathname === '/open-apis/authen/v1/authorize';
  } catch {
    return false;
  }
}

export const PostMeetingFeishuImportRequestSchema = z.object({
  url: boundedText.refine(isFeishuMinuteInput, 'invalid Feishu Minutes link or token'),
  customerId: entityId,
  matterId: entityId,
}).strict();

export const PostMeetingUploadMetadataSchema = z.object({
  customerId: entityId,
  matterId: entityId,
  occurredAt: utcInstant.nullable().optional(),
}).strict();

export const PostMeetingSourceImportReceiptSchema = z.object({
  source: PostMeetingSourceOptionSchema,
  replayed: z.boolean(),
}).strict();

const safeRedirectUri = boundedText.refine(
  isHttpsOrLoopbackUrl,
  'redirect URI must use HTTPS or a loopback HTTP origin',
);

export const PostMeetingFeishuProviderStatusSchema = z.object({
  configured: z.boolean(),
  appId: z.string().trim().max(200),
  hasSecret: z.boolean(),
  enabled: z.boolean(),
  redirectUri: safeRedirectUri,
}).strict();

export const PostMeetingFeishuProviderConfigRequestSchema = z.object({
  appId: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const PostMeetingFeishuProviderConfigReceiptSchema = z.object({
  ok: z.literal(true),
  redirectUri: safeRedirectUri,
}).strict();

const credentialStatus = z.object({
  source: openKey,
  status: openKey,
  expiresAt: utcInstant.nullable(),
  updatedAt: utcInstant,
}).strict();

export const PostMeetingRecordingCredentialStatusResponseSchema = z.object({
  credentials: z.array(credentialStatus).max(20),
}).strict();

export const PostMeetingFeishuOAuthStartResponseSchema = z.object({
  authUrl: boundedText.refine(isFeishuAuthorizationUrl, 'invalid Feishu authorization URL'),
}).strict();

export const PostMeetingSourceLifecycleReceiptSchema = z.object({
  id: entityId,
  aclVersion: z.number().int().min(1).max(2_147_483_647),
  visibility: z.enum(['private', 'matter_shared', 'owner_admin_only']),
  retentionState: z.enum(['available', 'degraded', 'deleted', 'reference_only']),
  contentAvailable: z.boolean(),
  backingPresent: z.boolean(),
  replayed: z.boolean(),
}).strict();

export type PostMeetingFeishuImportRequest = z.infer<typeof PostMeetingFeishuImportRequestSchema>;
export type PostMeetingUploadMetadata = z.infer<typeof PostMeetingUploadMetadataSchema>;
export type PostMeetingSourceImportReceipt = z.infer<typeof PostMeetingSourceImportReceiptSchema>;
export type PostMeetingFeishuProviderStatus = z.infer<typeof PostMeetingFeishuProviderStatusSchema>;
export type PostMeetingFeishuProviderConfigRequest = z.infer<typeof PostMeetingFeishuProviderConfigRequestSchema>;
export type PostMeetingFeishuProviderConfigReceipt = z.infer<typeof PostMeetingFeishuProviderConfigReceiptSchema>;
export type PostMeetingRecordingCredentialStatusResponse = z.infer<typeof PostMeetingRecordingCredentialStatusResponseSchema>;
export type PostMeetingFeishuOAuthStartResponse = z.infer<typeof PostMeetingFeishuOAuthStartResponseSchema>;
export type PostMeetingSourceLifecycleReceipt = z.infer<typeof PostMeetingSourceLifecycleReceiptSchema>;
