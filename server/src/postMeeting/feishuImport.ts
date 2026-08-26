import { createHash } from 'node:crypto';
import {
  exchangeFeishuCode,
  getFeishuMinute,
  refreshFeishuToken,
  type FeishuApp,
  type FeishuToken,
} from '../feishu.js';
import type { PreparedPostMeetingSource } from './importModel.js';

export interface FeishuMinuteContent {
  title: string;
  transcript: string;
  durationSec: number;
  recordedAt: Date | null;
}

export interface FeishuImportProvider {
  exchangeAuthorizationCode(app: FeishuApp, code: string, redirectUri: string): Promise<FeishuToken>;
  refreshAccessToken(app: FeishuApp, refreshToken: string): Promise<FeishuToken>;
  fetchMinute(accessToken: string, minuteToken: string): Promise<FeishuMinuteContent>;
}

export const productionFeishuImportProvider: FeishuImportProvider = Object.freeze({
  exchangeAuthorizationCode: exchangeFeishuCode,
  refreshAccessToken: refreshFeishuToken,
  async fetchMinute(accessToken: string, minuteToken: string) {
    const minute = await getFeishuMinute(accessToken, minuteToken);
    return { ...minute, recordedAt: null };
  },
});

const MINUTE_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;
const MAX_TRANSCRIPT_CHARACTERS = 500_000;

export class FeishuImportError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'FeishuImportError';
  }
}

export function parseFeishuMinuteToken(input: string): string {
  const value = input.trim();
  if (MINUTE_TOKEN.test(value)) return value;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const match = url.pathname.match(/^\/minutes\/([^/]+)\/?$/);
    if (url.protocol !== 'https:'
      || (hostname !== 'feishu.cn' && !hostname.endsWith('.feishu.cn'))
      || !match?.[1]
      || !MINUTE_TOKEN.test(match[1])) {
      throw new FeishuImportError('post_meeting_feishu_identity_invalid');
    }
    return match[1];
  } catch (error) {
    if (error instanceof FeishuImportError) throw error;
    throw new FeishuImportError('post_meeting_feishu_identity_invalid');
  }
}

export async function prepareFeishuPostMeetingSource(input: {
  input: string;
  accessToken: string;
  provider: FeishuImportProvider;
}): Promise<PreparedPostMeetingSource> {
  const minuteToken = parseFeishuMinuteToken(input.input);
  let minute: FeishuMinuteContent;
  try {
    minute = await input.provider.fetchMinute(input.accessToken, minuteToken);
  } catch {
    throw new FeishuImportError('post_meeting_feishu_provider_failed', 502, true);
  }
  if (!minute
    || typeof minute.title !== 'string'
    || typeof minute.transcript !== 'string'
    || typeof minute.durationSec !== 'number'
    || (minute.recordedAt !== null && !(minute.recordedAt instanceof Date))) {
    throw new FeishuImportError('post_meeting_feishu_provider_invalid', 502, true);
  }
  const text = minute.transcript.trim();
  if (!text) throw new FeishuImportError('post_meeting_feishu_empty');
  if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new FeishuImportError('post_meeting_feishu_too_large');
  }
  if (!Number.isFinite(minute.durationSec)
    || minute.durationSec < 0
    || Math.round(minute.durationSec) > 2_147_483_647
    || (minute.recordedAt !== null && Number.isNaN(minute.recordedAt.getTime()))) {
    throw new FeishuImportError('post_meeting_feishu_metadata_invalid');
  }
  const normalizedTitle = minute.title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200) || '飞书妙记';
  return {
    source: 'feishu',
    externalRef: `feishu:${minuteToken}`,
    title: normalizedTitle,
    text,
    durationSec: Math.round(minute.durationSec),
    recordedAt: minute.recordedAt,
    contentFingerprint: createHash('sha256').update(text).digest('hex'),
  };
}
