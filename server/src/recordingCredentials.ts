import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeishuApp, FeishuToken } from './feishu.js';
import { dec, enc } from './ai.js';
import type { DbClient } from './mutation/scopeGuards.js';
import type { FeishuImportProvider } from './postMeeting/feishuImport.js';
import type {
  PostMeetingFeishuProviderConfigRequest,
  PostMeetingFeishuProviderStatus,
  PostMeetingRecordingCredentialStatusResponse,
} from '@jianghu/domain-contracts';

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const OAUTH_CLOCK_SKEW_MS = 30_000;

const OAuthStateSchema = z.object({
  tenantId: z.string().min(1).max(500),
  userId: z.string().min(1).max(500),
  issuedAt: z.number().int().nonnegative(),
  nonce: z.string().uuid(),
}).strict();

export type FeishuOAuthState = z.infer<typeof OAuthStateSchema>;

export class RecordingCredentialsError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'RecordingCredentialsError';
  }
}

function validOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url;
  } catch {
    return null;
  }
}

export function resolvePublicBaseUrl(value: string | undefined): string {
  const parsed = value ? validOrigin(value.trim()) : null;
  if (!parsed) throw new RecordingCredentialsError('public_base_url_invalid', 500);
  return parsed.origin;
}

export function feishuOAuthRedirectUri(publicBaseUrl: string): string {
  return `${resolvePublicBaseUrl(publicBaseUrl)}/api/recording/oauth/feishu/callback`;
}

export function createFeishuOAuthState(
  input: { tenantId: string; userId: string },
  now = new Date(),
): string {
  return enc(JSON.stringify(OAuthStateSchema.parse({
    ...input,
    issuedAt: now.getTime(),
    nonce: randomUUID(),
  })));
}

export function parseFeishuOAuthState(
  ciphertext: string,
  now = new Date(),
): FeishuOAuthState {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)
      || Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext) {
      throw new RecordingCredentialsError('feishu_oauth_state_invalid', 400);
    }
    const parsed = OAuthStateSchema.parse(JSON.parse(dec(ciphertext)));
    const age = now.getTime() - parsed.issuedAt;
    if (age < -OAUTH_CLOCK_SKEW_MS || age > OAUTH_STATE_TTL_MS) {
      throw new RecordingCredentialsError('feishu_oauth_state_invalid', 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof RecordingCredentialsError) throw error;
    throw new RecordingCredentialsError('feishu_oauth_state_invalid', 400);
  }
}

export async function getFeishuApp(db: DbClient, tenantId: string): Promise<FeishuApp | null> {
  const row = await db.recordingProviderConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: 'feishu' } },
  });
  if (!row?.enabled || !row.appId || !row.appSecretEnc) return null;
  const appSecret = dec(row.appSecretEnc);
  return appSecret ? { appId: row.appId, appSecret } : null;
}

export async function readFeishuProviderStatus(
  db: DbClient,
  tenantId: string,
  publicBaseUrl: string,
): Promise<PostMeetingFeishuProviderStatus> {
  const row = await db.recordingProviderConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: 'feishu' } },
    select: { appId: true, appSecretEnc: true, enabled: true },
  });
  return {
    configured: Boolean(row?.appId && row?.appSecretEnc),
    appId: row?.appId ?? '',
    hasSecret: Boolean(row?.appSecretEnc),
    enabled: row?.enabled ?? true,
    redirectUri: feishuOAuthRedirectUri(publicBaseUrl),
  };
}

export async function configureFeishuProvider(
  db: DbClient,
  tenantId: string,
  input: PostMeetingFeishuProviderConfigRequest,
): Promise<void> {
  const current = await db.recordingProviderConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider: 'feishu' } },
    select: { appSecretEnc: true },
  });
  const appSecretEnc = input.appSecret
    ? enc(input.appSecret)
    : current?.appSecretEnc ?? '';
  if (!appSecretEnc) throw new RecordingCredentialsError('feishu_provider_secret_required', 400);
  await db.recordingProviderConfig.upsert({
    where: { tenantId_provider: { tenantId, provider: 'feishu' } },
    update: { appId: input.appId, appSecretEnc, enabled: true },
    create: {
      tenantId,
      provider: 'feishu',
      appId: input.appId,
      appSecretEnc,
      enabled: true,
    },
  });
}

export async function listRecordingCredentialStatuses(
  db: DbClient,
  tenantId: string,
  userId: string,
): Promise<PostMeetingRecordingCredentialStatusResponse> {
  const actor = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!actor) throw new RecordingCredentialsError('recording_credential_actor_invalid', 401);
  const rows = await db.recordingCredential.findMany({
    where: { tenantId, userId },
    orderBy: { source: 'asc' },
    select: { source: true, status: true, expiresAt: true, updatedAt: true },
  });
  return {
    credentials: rows.map((row) => ({
      source: row.source,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function resolveFeishuAccessToken(
  db: DbClient,
  tenantId: string,
  userId: string,
  provider: FeishuImportProvider,
  now = new Date(),
): Promise<string> {
  const actor = await db.user.findFirst({
    where: { id: userId, tenantId }, select: { role: true },
  });
  if (!actor || !['owner', 'admin', 'member', 'viewer'].includes(actor.role)) {
    throw new RecordingCredentialsError('recording_credential_actor_invalid', 401);
  }
  if (actor.role === 'viewer') throw new RecordingCredentialsError('viewer_write_denied', 403);
  const row = await db.recordingCredential.findUnique({
    where: { tenantId_userId_source: { tenantId, userId, source: 'feishu' } },
  });
  if (!row || row.status !== 'active' || !row.accessTokenEnc) {
    throw new RecordingCredentialsError('feishu_credential_missing', 400);
  }
  const accessToken = dec(row.accessTokenEnc);
  const refreshToken = dec(row.refreshTokenEnc);
  if (!accessToken) throw new RecordingCredentialsError('feishu_credential_missing', 400);
  if (!row.expiresAt || row.expiresAt.getTime() >= now.getTime() + 60_000) return accessToken;
  if (!refreshToken) throw new RecordingCredentialsError('feishu_credential_expired', 400);
  const app = await getFeishuApp(db, tenantId);
  if (!app) throw new RecordingCredentialsError('feishu_provider_not_configured', 400);
  let refreshed: FeishuToken;
  try {
    refreshed = await provider.refreshAccessToken(app, refreshToken);
  } catch {
    throw new RecordingCredentialsError('feishu_token_refresh_failed', 502, true);
  }
  if (!refreshed.accessToken
    || (refreshed.expiresAt !== null && Number.isNaN(refreshed.expiresAt.getTime()))) {
    throw new RecordingCredentialsError('feishu_token_refresh_failed', 502, true);
  }
  await saveRecordingCredential(db, tenantId, userId, 'feishu', {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || refreshToken,
    expiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}

export interface RecordingCredentialValue {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
}

export async function saveRecordingCredential(
  db: DbClient,
  tenantId: string,
  userId: string,
  source: string,
  token: RecordingCredentialValue,
): Promise<void> {
  if (!token.accessToken
    || (token.expiresAt !== null && Number.isNaN(token.expiresAt.getTime()))) {
    throw new RecordingCredentialsError('recording_credential_value_invalid', 400);
  }
  const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!user) throw new RecordingCredentialsError('recording_credential_actor_invalid', 404);
  const data = {
    accessTokenEnc: enc(token.accessToken),
    refreshTokenEnc: enc(token.refreshToken),
    expiresAt: token.expiresAt,
    status: 'active',
  };
  await db.recordingCredential.upsert({
    where: { tenantId_userId_source: { tenantId, userId, source } },
    update: data,
    create: {
      id: `rc_${randomUUID().replaceAll('-', '')}`,
      tenantId,
      userId,
      source,
      ...data,
    },
  });
}

export function asRecordingCredentialValue(token: FeishuToken): RecordingCredentialValue {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
  };
}
