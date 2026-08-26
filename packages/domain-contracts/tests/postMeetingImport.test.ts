import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const source = {
  id: 'source-artifact-203',
  customerId: 'customer-203',
  matterId: 'matter-203',
  title: '8 月 26 日客户会谈',
  kind: 'uploaded_file',
  fingerprint: 'a'.repeat(64),
  aclVersion: 1,
  version: 1,
  occurredAt: '2026-08-26T10:00:00.000Z',
};

describe('SAAS-203 post-meeting source import contracts', () => {
  it('accepts exactly one Feishu Minutes link/token and exact Customer/Matter anchors', () => {
    const request = schema('PostMeetingFeishuImportRequestSchema');
    expect(request, 'PostMeetingFeishuImportRequestSchema must be exported').toBeDefined();

    expect(request!.safeParse({
      url: 'https://acme.feishu.cn/minutes/obcnAbc_1234567890',
      customerId: 'customer-203',
      matterId: 'matter-203',
    }).success).toBe(true);
    expect(request!.safeParse({
      url: 'obcnAbc_1234567890',
      customerId: 'customer-203',
      matterId: 'matter-203',
    }).success).toBe(true);

    for (const url of [
      'http://acme.feishu.cn/minutes/obcnAbc_1234567890',
      'https://evil.example/minutes/obcnAbc_1234567890',
      'https://acme.feishu.cn/wiki/obcnAbc_1234567890',
      'short',
    ]) {
      expect(request!.safeParse({
        url, customerId: 'customer-203', matterId: 'matter-203',
      }).success).toBe(false);
    }
    expect(request!.safeParse({
      url: 'obcnAbc_1234567890', customerId: 'customer-203', matterId: 'matter-203',
      accountId: 'parallel-anchor',
    }).success).toBe(false);
    expect(request!.safeParse({
      url: 'obcnAbc_1234567890', customerId: 'customer-203',
    }).success).toBe(false);
  });

  it('parses bounded upload metadata without accepting body or file fields', () => {
    const metadata = schema('PostMeetingUploadMetadataSchema');
    expect(metadata, 'PostMeetingUploadMetadataSchema must be exported').toBeDefined();

    expect(metadata!.safeParse({
      customerId: 'customer-203', matterId: 'matter-203',
      occurredAt: '2026-08-26T10:00:00.000Z',
    }).success).toBe(true);
    expect(metadata!.safeParse({
      customerId: 'customer-203', matterId: 'matter-203', occurredAt: null,
    }).success).toBe(true);
    expect(metadata!.safeParse({
      customerId: 'customer-203', matterId: 'matter-203', occurredAt: '2026-08-26',
    }).success).toBe(false);
    expect(metadata!.safeParse({
      customerId: 'customer-203', matterId: 'matter-203', body: 'private transcript',
    }).success).toBe(false);
    expect(metadata!.safeParse({ customerId: 'customer-203', matterId: '' }).success).toBe(false);
  });

  it('returns one strict source receipt rather than count or private content', () => {
    const receipt = schema('PostMeetingSourceImportReceiptSchema');
    expect(receipt, 'PostMeetingSourceImportReceiptSchema must be exported').toBeDefined();

    expect(receipt!.safeParse({ source, replayed: false }).success).toBe(true);
    expect(receipt!.safeParse({ source, replayed: true }).success).toBe(true);
    expect(receipt!.safeParse({ source: { ...source, body: 'private transcript' }, replayed: false }).success).toBe(false);
    expect(receipt!.safeParse({ source, replayed: false, saved: 1, skipped: 0 }).success).toBe(false);
    expect(receipt!.safeParse({ source: { ...source, fingerprint: 'not-a-digest' }, replayed: false }).success).toBe(false);
  });
});

describe('SAAS-203 Feishu credential and OAuth transport contracts', () => {
  it('exposes only bounded provider status and never a secret', () => {
    const status = schema('PostMeetingFeishuProviderStatusSchema');
    expect(status, 'PostMeetingFeishuProviderStatusSchema must be exported').toBeDefined();
    const safe = {
      configured: true,
      appId: 'cli_aabbccddeeff',
      hasSecret: true,
      enabled: true,
      redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
    };
    expect(status!.safeParse(safe).success).toBe(true);
    expect(status!.safeParse({ ...safe, appSecret: 'must-not-return' }).success).toBe(false);
    expect(status!.safeParse({ ...safe, accessToken: 'must-not-return' }).success).toBe(false);
    expect(status!.safeParse({ ...safe, redirectUri: 'javascript:alert(1)' }).success).toBe(false);
    expect(status!.safeParse({
      ...safe, redirectUri: 'http://localhost:3001/api/recording/oauth/feishu/callback',
    }).success).toBe(true);
  });

  it('keeps App Secret write-only and accepts only safe config receipts', () => {
    const request = schema('PostMeetingFeishuProviderConfigRequestSchema');
    const receipt = schema('PostMeetingFeishuProviderConfigReceiptSchema');
    expect(request, 'PostMeetingFeishuProviderConfigRequestSchema must be exported').toBeDefined();
    expect(receipt, 'PostMeetingFeishuProviderConfigReceiptSchema must be exported').toBeDefined();

    expect(request!.safeParse({ appId: 'cli_aabbccddeeff' }).success).toBe(true);
    expect(request!.safeParse({ appId: 'cli_aabbccddeeff', appSecret: 'replace-once' }).success).toBe(true);
    expect(request!.safeParse({ appId: '', appSecret: 'replace-once' }).success).toBe(false);
    expect(request!.safeParse({ appId: 'cli_aabbccddeeff', appSecret: '' }).success).toBe(false);
    expect(request!.safeParse({ appId: 'cli_aabbccddeeff', accessToken: 'forbidden' }).success).toBe(false);

    expect(receipt!.safeParse({
      ok: true,
      redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
    }).success).toBe(true);
    expect(receipt!.safeParse({
      ok: true,
      redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
      appSecret: 'must-not-return',
    }).success).toBe(false);
  });

  it('parses per-user credential metadata and a Feishu-only OAuth authorization URL', () => {
    const credentials = schema('PostMeetingRecordingCredentialStatusResponseSchema');
    const start = schema('PostMeetingFeishuOAuthStartResponseSchema');
    expect(credentials, 'PostMeetingRecordingCredentialStatusResponseSchema must be exported').toBeDefined();
    expect(start, 'PostMeetingFeishuOAuthStartResponseSchema must be exported').toBeDefined();

    expect(credentials!.safeParse({ credentials: [{
      source: 'feishu', status: 'active', expiresAt: '2026-08-26T12:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
    }, {
      source: 'getnote', status: 'active', expiresAt: null,
      updatedAt: '2026-08-26T10:00:00.000Z',
    }] }).success).toBe(true);
    expect(credentials!.safeParse({ credentials: [{
      source: 'feishu', status: 'active', expiresAt: null,
      updatedAt: '2026-08-26T10:00:00.000Z', accessToken: 'forbidden',
    }] }).success).toBe(false);

    expect(start!.safeParse({
      authUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_test',
    }).success).toBe(true);
    expect(start!.safeParse({
      authUrl: 'https://evil.example/open-apis/authen/v1/authorize?client_id=cli_test',
    }).success).toBe(false);
    expect(start!.safeParse({ authUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('SAAS-203 SourceArtifact lifecycle receipt contract', () => {
  it('returns only body-free CAS and retention state', () => {
    const receipt = schema('PostMeetingSourceLifecycleReceiptSchema');
    expect(receipt, 'PostMeetingSourceLifecycleReceiptSchema must be exported').toBeDefined();
    const safe = {
      id: 'source-artifact-203',
      aclVersion: 2,
      visibility: 'private',
      retentionState: 'degraded',
      contentAvailable: false,
      backingPresent: true,
      replayed: false,
    };
    expect(receipt!.safeParse(safe).success).toBe(true);
    expect(receipt!.safeParse({ ...safe, retentionState: 'unknown' }).success).toBe(false);
    expect(receipt!.safeParse({ ...safe, contentEnc: 'forbidden' }).success).toBe(false);
    expect(receipt!.safeParse({ ...safe, aclVersion: 0 }).success).toBe(false);
  });
});
