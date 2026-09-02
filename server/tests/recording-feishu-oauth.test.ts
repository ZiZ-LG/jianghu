import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dec, enc } from '../src/ai.js';
import {
  RecordingCredentialsError,
  createFeishuOAuthState,
  parseFeishuOAuthState,
  resolveFeishuAccessToken,
  resolvePublicBaseUrl,
  saveRecordingCredential,
} from '../src/recordingCredentials.js';
import type { FeishuImportProvider } from '../src/postMeeting/feishuImport.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-203 Feishu provider credentials and OAuth hardening', () => {
  let test: TestContext;
  let provider: FeishuImportProvider;

  beforeEach(async () => {
    provider = {
      exchangeAuthorizationCode: vi.fn(async () => ({
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
        expiresAt: new Date(Date.now() + 7_200_000),
      })),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(),
    };
    test = await createTestContext({
      feishuImportProvider: provider,
      publicBaseUrl: 'http://localhost:3001',
    });
  });

  afterEach(async () => test.cleanup());

  it('exports one tenant/user-scoped credential and OAuth-state authority', async () => {
    const module = await import('../src/recordingCredentials.js').catch(() => null);

    expect(module).not.toBeNull();
    expect(typeof module?.resolvePublicBaseUrl).toBe('function');
    expect(typeof module?.createFeishuOAuthState).toBe('function');
    expect(typeof module?.parseFeishuOAuthState).toBe('function');
    expect(typeof module?.resolveFeishuAccessToken).toBe('function');
  });

  it.each([
    ['https://crm.lake2ocean.top', 'https://crm.lake2ocean.top'],
    ['https://crm.lake2ocean.top/', 'https://crm.lake2ocean.top'],
    ['http://localhost:3001', 'http://localhost:3001'],
    ['http://127.0.0.1:3001/', 'http://127.0.0.1:3001'],
  ])('accepts only an HTTPS or loopback origin %#', (input, expected) => {
    expect(resolvePublicBaseUrl(input)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'http://crm.lake2ocean.top',
    'https://crm.lake2ocean.top/path',
    'https://user:pass@crm.lake2ocean.top',
    'javascript:alert(1)',
  ])('fails closed on invalid public base URL %#', (input) => {
    expect(() => resolvePublicBaseUrl(input)).toThrowError(RecordingCredentialsError);
  });

  it('round-trips a strict encrypted OAuth state for ten minutes only', () => {
    const issuedAt = new Date('2026-08-26T15:00:00.000Z');
    const state = createFeishuOAuthState({
      tenantId: test.tenant.id, userId: test.owner.id,
    }, issuedAt);

    expect(state).not.toContain(test.tenant.id);
    expect(state).not.toContain(test.owner.id);
    expect(parseFeishuOAuthState(state, new Date(issuedAt.getTime() + 599_999))).toMatchObject({
      tenantId: test.tenant.id,
      userId: test.owner.id,
      issuedAt: issuedAt.getTime(),
      nonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(() => parseFeishuOAuthState(state, new Date(issuedAt.getTime() + 600_001)))
      .toThrowError(RecordingCredentialsError);
    expect(() => parseFeishuOAuthState(`${state}tampered`, issuedAt))
      .toThrowError(RecordingCredentialsError);
    expect(() => parseFeishuOAuthState(
      enc(JSON.stringify({ t: test.tenant.id, u: test.owner.id, ts: issuedAt.getTime() })),
      issuedAt,
    )).toThrowError(RecordingCredentialsError);
  });

  it('returns an active creator-owned token without provider or plaintext persistence', async () => {
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(),
    };
    await saveRecordingCredential(
      test.prisma,
      test.tenant.id,
      test.owner.id,
      'feishu',
      {
        accessToken: 'active-access-token',
        refreshToken: 'active-refresh-token',
        expiresAt: new Date('2026-08-26T17:00:00.000Z'),
      },
    );

    await expect(resolveFeishuAccessToken(
      test.prisma,
      test.tenant.id,
      test.owner.id,
      provider,
      new Date('2026-08-26T16:00:00.000Z'),
    )).resolves.toBe('active-access-token');
    expect(provider.refreshAccessToken).not.toHaveBeenCalled();
    const stored = await test.prisma.recordingCredential.findFirstOrThrow();
    expect(stored.accessTokenEnc).not.toContain('active-access-token');
    expect(stored.refreshTokenEnc).not.toContain('active-refresh-token');
    expect(dec(stored.accessTokenEnc)).toBe('active-access-token');
  });

  it('refreshes an expiring token with the exact tenant app and persists only ciphertext', async () => {
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(async () => ({
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        expiresAt: new Date('2026-08-26T19:00:00.000Z'),
      })),
      fetchMinute: vi.fn(),
    };
    await test.prisma.recordingProviderConfig.create({ data: {
      tenantId: test.tenant.id,
      provider: 'feishu',
      appId: 'app-id',
      appSecretEnc: enc('app-secret'),
      enabled: true,
    } });
    await saveRecordingCredential(test.prisma, test.tenant.id, test.owner.id, 'feishu', {
      accessToken: 'expired-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: new Date('2026-08-26T15:59:30.000Z'),
    });

    await expect(resolveFeishuAccessToken(
      test.prisma,
      test.tenant.id,
      test.owner.id,
      provider,
      new Date('2026-08-26T16:00:00.000Z'),
    )).resolves.toBe('fresh-access-token');
    expect(provider.refreshAccessToken).toHaveBeenCalledWith(
      { appId: 'app-id', appSecret: 'app-secret' },
      'old-refresh-token',
    );
    const stored = await test.prisma.recordingCredential.findFirstOrThrow();
    expect(dec(stored.accessTokenEnc)).toBe('fresh-access-token');
    expect(dec(stored.refreshTokenEnc)).toBe('fresh-refresh-token');
    expect(JSON.stringify(stored)).not.toContain('fresh-access-token');
    expect(JSON.stringify(stored)).not.toContain('fresh-refresh-token');
  });

  it('rejects missing, revoked, cross-tenant and viewer credentials with stable codes', async () => {
    const provider: FeishuImportProvider = {
      exchangeAuthorizationCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchMinute: vi.fn(),
    };
    await expect(resolveFeishuAccessToken(
      test.prisma, test.tenant.id, test.owner.id, provider,
    )).rejects.toMatchObject({ code: 'feishu_credential_missing', statusCode: 400 });

    await saveRecordingCredential(test.prisma, test.tenant.id, test.owner.id, 'feishu', {
      accessToken: 'token', refreshToken: 'refresh', expiresAt: null,
    });
    await test.prisma.recordingCredential.updateMany({ data: { status: 'revoked' } });
    await expect(resolveFeishuAccessToken(
      test.prisma, test.tenant.id, test.owner.id, provider,
    )).rejects.toMatchObject({ code: 'feishu_credential_missing', statusCode: 400 });

    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    await expect(resolveFeishuAccessToken(
      test.prisma, test.tenant.id, test.owner.id, provider,
    )).rejects.toMatchObject({ code: 'viewer_write_denied', statusCode: 403 });
    await expect(resolveFeishuAccessToken(
      test.prisma, 'another-tenant', test.owner.id, provider,
    )).rejects.toMatchObject({ code: 'recording_credential_actor_invalid', statusCode: 401 });
  });

  it('configures one tenant Feishu app with write-only secret and strict safe status', async () => {
    const headers = { authorization: `Bearer ${test.token}` };
    const empty = await test.app.inject({
      method: 'GET', url: '/api/recording/provider/feishu', headers,
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({
      configured: false,
      appId: '',
      hasSecret: false,
      enabled: true,
      redirectUri: 'http://localhost:3001/api/recording/oauth/feishu/callback',
    });

    const configured = await test.app.inject({
      method: 'PUT',
      url: '/api/recording/provider/feishu',
      headers,
      payload: { appId: 'cli_app_id', appSecret: 'private-app-secret' },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toEqual({
      ok: true,
      redirectUri: 'http://localhost:3001/api/recording/oauth/feishu/callback',
    });
    expect(configured.body).not.toContain('private-app-secret');
    const stored = await test.prisma.recordingProviderConfig.findUniqueOrThrow({
      where: { tenantId_provider: { tenantId: test.tenant.id, provider: 'feishu' } },
    });
    expect(stored.appSecretEnc).not.toContain('private-app-secret');
    expect(dec(stored.appSecretEnc)).toBe('private-app-secret');

    const preserve = await test.app.inject({
      method: 'PUT',
      url: '/api/recording/provider/feishu',
      headers,
      payload: { appId: 'cli_app_id_v2' },
    });
    expect(preserve.statusCode, preserve.body).toBe(200);
    await expect(test.prisma.recordingProviderConfig.findUniqueOrThrow({
      where: { tenantId_provider: { tenantId: test.tenant.id, provider: 'feishu' } },
    })).resolves.toMatchObject({ appId: 'cli_app_id_v2', appSecretEnc: stored.appSecretEnc });

    const unknownKey = await test.app.inject({
      method: 'PUT',
      url: '/api/recording/provider/feishu',
      headers,
      payload: { appId: 'cli_app_id_v3', unexpected: 'value' },
    });
    expect(unknownKey.statusCode).toBe(400);
    const safeStatus = await test.app.inject({
      method: 'GET', url: '/api/recording/provider/feishu', headers,
    });
    expect(safeStatus.json()).toMatchObject({
      configured: true, appId: 'cli_app_id_v2', hasSecret: true, enabled: true,
    });
    expect(safeStatus.body).not.toContain('private-app-secret');
    expect(safeStatus.body).not.toContain(stored.appSecretEnc);
  });

  it('returns only the current user credential status and never token material', async () => {
    await saveRecordingCredential(test.prisma, test.tenant.id, test.owner.id, 'feishu', {
      accessToken: 'credential-status-access',
      refreshToken: 'credential-status-refresh',
      expiresAt: new Date('2026-08-27T00:00:00.000Z'),
    });
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/recording/credentials',
      headers: { authorization: `Bearer ${test.token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().credentials).toEqual([{
      source: 'feishu',
      status: 'active',
      expiresAt: '2026-08-27T00:00:00.000Z',
      updatedAt: expect.any(String),
    }]);
    expect(response.body).not.toContain('credential-status-access');
    expect(response.body).not.toContain('credential-status-refresh');
    expect(response.body).not.toContain('TokenEnc');
  });

  it('starts OAuth with a strict ten-minute encrypted state and exact redirect authority', async () => {
    await test.prisma.recordingProviderConfig.create({ data: {
      tenantId: test.tenant.id,
      provider: 'feishu',
      appId: 'oauth-app-id',
      appSecretEnc: enc('oauth-app-secret'),
      enabled: true,
    } });
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/recording/oauth/feishu/start',
      headers: { authorization: `Bearer ${test.token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    const authUrl = new URL(response.json().authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    );
    expect(authUrl.searchParams.get('client_id')).toBe('oauth-app-id');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/recording/oauth/feishu/callback',
    );
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(parseFeishuOAuthState(state!)).toMatchObject({
      tenantId: test.tenant.id, userId: test.owner.id,
    });
    expect(response.body).not.toContain('oauth-app-secret');
  });

  it('exchanges a valid callback once, persists encrypted token fields and returns safe HTML', async () => {
    await test.prisma.recordingProviderConfig.create({ data: {
      tenantId: test.tenant.id,
      provider: 'feishu',
      appId: 'oauth-app-id',
      appSecretEnc: enc('oauth-app-secret'),
      enabled: true,
    } });
    const state = createFeishuOAuthState({
      tenantId: test.tenant.id, userId: test.owner.id,
    });
    const callback = () => test.app.inject({
      method: 'GET',
      url: `/api/recording/oauth/feishu/callback?code=${encodeURIComponent('private-oauth-code')}&state=${encodeURIComponent(state)}`,
    });

    const first = await callback();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toContain('text/html');
    expect(first.body).toContain('飞书妙记已授权');
    expect(first.body).not.toContain('private-oauth-code');
    expect(first.body).not.toContain('oauth-access-token');
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledWith(
      { appId: 'oauth-app-id', appSecret: 'oauth-app-secret' },
      'private-oauth-code',
      'http://localhost:3001/api/recording/oauth/feishu/callback',
    );
    const stored = await test.prisma.recordingCredential.findFirstOrThrow();
    expect(dec(stored.accessTokenEnc)).toBe('oauth-access-token');
    expect(dec(stored.refreshTokenEnc)).toBe('oauth-refresh-token');
    expect(JSON.stringify(stored)).not.toContain('oauth-access-token');
    expect(JSON.stringify(stored)).not.toContain('oauth-refresh-token');

    const replay = await callback();
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain('飞书妙记已授权');
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it('uses one generic escaped failure page for malformed, expired, revoked-actor and provider errors', async () => {
    await test.prisma.recordingProviderConfig.create({ data: {
      tenantId: test.tenant.id,
      provider: 'feishu',
      appId: 'oauth-app-id',
      appSecretEnc: enc('oauth-app-secret'),
      enabled: true,
    } });
    const expired = createFeishuOAuthState(
      { tenantId: test.tenant.id, userId: test.owner.id },
      new Date(Date.now() - 10 * 60_000 - 1),
    );
    const malformed = await test.app.inject({
      method: 'GET', url: '/api/recording/oauth/feishu/callback?code=raw-code&state=raw-state',
    });
    const expiredResponse = await test.app.inject({
      method: 'GET',
      url: `/api/recording/oauth/feishu/callback?code=raw-code&state=${encodeURIComponent(expired)}`,
    });

    const viewerState = createFeishuOAuthState({ tenantId: test.tenant.id, userId: test.owner.id });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const viewer = await test.app.inject({
      method: 'GET',
      url: `/api/recording/oauth/feishu/callback?code=raw-code&state=${encodeURIComponent(viewerState)}`,
    });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'owner' } });

    const rawMarker = 'RAW-OAUTH-PROVIDER-SECRET';
    vi.mocked(provider.exchangeAuthorizationCode).mockRejectedValueOnce(new Error(rawMarker));
    const providerState = createFeishuOAuthState({ tenantId: test.tenant.id, userId: test.owner.id });
    const providerFailure = await test.app.inject({
      method: 'GET',
      url: `/api/recording/oauth/feishu/callback?code=raw-code&state=${encodeURIComponent(providerState)}`,
    });

    const failures = [malformed, expiredResponse, viewer, providerFailure];
    expect(failures.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect(new Set(failures.map((response) => response.body)).size).toBe(1);
    for (const response of failures) {
      expect(response.body).toContain('飞书授权失败');
      expect(response.body).not.toContain('raw-code');
      expect(response.body).not.toContain('raw-state');
      expect(response.body).not.toContain(rawMarker);
      expect(response.body).not.toContain(test.tenant.id);
      expect(response.body).not.toContain(test.owner.id);
    }
  });
});
