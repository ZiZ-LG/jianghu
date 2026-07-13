import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import { enc } from '../src/ai.js';
import { reportWecomBindConflicts } from '../scripts/report-wecom-bind-conflicts.js';
const outbound = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/security/outboundUrl.js', () => ({
  deploymentOutboundPolicy: () => ({}),
  fetchOutbound: outbound.fetch,
}));
import { getAccessToken, handleWecomEvent, pushProposalCard, tokenCacheKey } from '../src/wecom.js';

const event = (userid: string, key: string) => `<xml><FromUserName><![CDATA[${userid}]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[template_card_event]]></Event><EventKey><![CDATA[${key}]]></EventKey></xml>`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('INT-107 WeCom authorization', () => {
  it('isolates access-token cache entries by tenant and corp', async () => {
    expect(tokenCacheKey('tenant-a', 'corp')).not.toBe(tokenCacheKey('tenant-b', 'corp'));
    expect(tokenCacheKey('tenant-a', 'corp')).toBe('tenant-a\u0000corp');
    outbound.fetch
      .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0, access_token: 'token-a', expires_in: 7200 }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0, access_token: 'token-b', expires_in: 7200 }) });
    const corp = `corp-${randomUUID()}`;
    await expect(getAccessToken('tenant-a', corp, 'secret-a')).resolves.toBe('token-a');
    await expect(getAccessToken('tenant-b', corp, 'secret-b')).resolves.toBe('token-b');
    expect(outbound.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['deleted', 'unbound', 'viewer'] as const)('freshly rejects %s callback actors', async (mode) => {
    const context = await createTestContext();
    try {
      const user = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@test.invalid`, passwordHash: 'x', name: 'Actor', role: 'member' } });
      await context.prisma.weComConfig.create({ data: { tenantId: context.tenant.id, corpId: 'corp', agentId: '1', secretEnc: 'invalid-but-unused' } });
      await context.prisma.weComUserBind.create({ data: { id: `wb-${mode}`, tenantId: context.tenant.id, userId: user.id, wecomUserid: `wx-${mode}` } });
      await context.prisma.account.create({ data: { id: `acc-${mode}`, tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.person.create({ data: { id: `p-${mode}`, tenantId: context.tenant.id, accountId: `acc-${mode}`, name: 'P', title: 'T' } });
      await context.prisma.changeProposal.create({ data: {
        id: `cp-${mode}`, tenantId: context.tenant.id, accountId: `acc-${mode}`, entityKind: 'person', entityId: `p-${mode}`,
        field: 'title', oldValue: 'T', newValue: 'Changed', status: 'pending', dedupeKey: `dedupe-${mode}`,
      } });
      if (mode === 'deleted') await context.prisma.user.delete({ where: { id: user.id } });
      if (mode === 'unbound') await context.prisma.weComUserBind.delete({ where: { id: `wb-${mode}` } });
      if (mode === 'viewer') await context.prisma.user.update({ where: { id: user.id }, data: { role: 'viewer' } });
      await handleWecomEvent(context.tenant.id, event(`wx-${mode}`, `cp:accept:cp-${mode}`));
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: `cp-${mode}` } })).status).toBe('pending');
    } finally { await context.cleanup(); }
  });

  it('does not authorize a bind or configuration from another tenant', async () => {
    const context = await createTestContext();
    try {
      const otherTenant = await context.prisma.tenant.create({ data: { id: `tenant-${randomUUID()}`, name: 'Other' } });
      const other = await context.prisma.user.create({ data: { tenantId: otherTenant.id, email: `${randomUUID()}@test.invalid`, passwordHash: 'x', name: 'Other', role: 'owner' } });
      await context.prisma.weComConfig.create({ data: { tenantId: context.tenant.id, corpId: 'corp-a', agentId: '1', secretEnc: 'unused' } });
      await context.prisma.weComUserBind.create({ data: { id: 'wb-cross', tenantId: otherTenant.id, userId: other.id, wecomUserid: 'wx-cross' } });
      await context.prisma.account.create({ data: { id: 'acc-cross', tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'p-cross', tenantId: context.tenant.id, accountId: 'acc-cross', name: 'P', title: 'T' } });
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-cross', tenantId: context.tenant.id, accountId: 'acc-cross', entityKind: 'person', entityId: 'p-cross',
        field: 'title', oldValue: 'T', newValue: 'Changed', status: 'pending', dedupeKey: 'dedupe-cross',
      } });
      await handleWecomEvent(context.tenant.id, event('wx-cross', 'cp:accept:cp-cross'));
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-cross' } })).status).toBe('pending');
    } finally { await context.cleanup(); }
  });

  it('allows a currently bound editor and records the fresh actor', async () => {
    const context = await createTestContext();
    try {
      const user = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@test.invalid`, passwordHash: 'x', name: 'Actor', role: 'member' } });
      await context.prisma.weComConfig.create({ data: { tenantId: context.tenant.id, corpId: 'corp', agentId: '1', secretEnc: 'unused' } });
      await context.prisma.weComUserBind.create({ data: { id: 'wb-ok', tenantId: context.tenant.id, userId: user.id, wecomUserid: 'wx-ok' } });
      await context.prisma.account.create({ data: { id: 'acc-ok', tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'p-ok', tenantId: context.tenant.id, accountId: 'acc-ok', name: 'P', title: 'T' } });
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-ok', tenantId: context.tenant.id, accountId: 'acc-ok', entityKind: 'person', entityId: 'p-ok',
        field: 'title', oldValue: 'T', newValue: 'Changed', status: 'pending', dedupeKey: 'dedupe-ok',
      } });
      await handleWecomEvent(context.tenant.id, event('wx-ok', 'cp:accept:cp-ok'));
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-ok' } })).status).toBe('accepted');
      expect((await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-ok' } })).title).toBe('Changed');
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-reject-ok', tenantId: context.tenant.id, accountId: 'acc-ok', entityKind: 'person', entityId: 'p-ok',
        field: 'title', oldValue: 'Changed', newValue: 'No', status: 'pending', dedupeKey: 'dedupe-reject-ok',
      } });
      await handleWecomEvent(context.tenant.id, event('wx-ok', 'cp:reject:cp-reject-ok'));
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-reject-ok' } })).status).toBe('rejected');
    } finally { await context.cleanup(); }
  });

  it('rejects duplicate manual binds and reports pre-migration conflicts without guessing', async () => {
    const context = await createTestContext();
    try {
      const first = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'A', role: 'member' } });
      const second = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'B', role: 'member' } });
      const t1 = context.app.jwt.sign({ userId: first.id, tenantId: context.tenant.id, role: 'member' });
      const t2 = context.app.jwt.sign({ userId: second.id, tenantId: context.tenant.id, role: 'member' });
      expect((await context.app.inject({ method: 'PUT', url: '/api/wecom/bind', headers: auth(t1), payload: { wecomUserid: 'same-wx' } })).statusCode).toBe(200);
      expect((await context.app.inject({ method: 'PUT', url: '/api/wecom/bind', headers: auth(t2), payload: { wecomUserid: 'same-wx' } })).statusCode).toBe(409);
      const fake = { weComUserBind: { findMany: async () => [
        { id: 'b1', tenantId: 't', userId: 'u1', wecomUserid: 'dup', createdAt: new Date() },
        { id: 'b2', tenantId: 't', userId: 'u2', wecomUserid: 'dup', createdAt: new Date() },
      ] } } as any;
      expect(await reportWecomBindConflicts(fake)).toEqual([{ tenantId: 't', wecomUserid: 'dup', conflicts: [{ bindId: 'b1', userId: 'u1' }, { bindId: 'b2', userId: 'u2' }] }]);
    } finally { await context.cleanup(); }
  });

  it('keeps OAuth exchange pending until the original authenticated user confirms once', async () => {
    const context = await createTestContext();
    try {
      const user = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'OAuth', role: 'member' } });
      const wrong = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'Wrong', role: 'member' } });
      const token = context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role: 'member' });
      const wrongToken = context.app.jwt.sign({ userId: wrong.id, tenantId: context.tenant.id, role: 'member' });
      const corp = `corp-${randomUUID()}`;
      await context.prisma.weComConfig.create({ data: { tenantId: context.tenant.id, corpId: corp, agentId: '1', secretEnc: enc('secret') } });
      const start = await context.app.inject({ method: 'GET', url: '/api/wecom/oauth/start', headers: auth(token) });
      expect(start.statusCode).toBe(200);
      const state = new URL(start.json().url).searchParams.get('state')!;
      const requestId = start.json().requestId as string;
      expect(requestId).toBeTruthy();
      expect(start.json().url).not.toContain(requestId);
      outbound.fetch.mockReset();
      outbound.fetch
        .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0, access_token: 'oauth-token', expires_in: 7200 }) })
        .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0, userid: 'oauth-attacker' }) });
      const callback = await context.app.inject({ method: 'GET', url: `/api/wecom/oauth/callback?code=code&state=${state}` });
      expect(callback.body).toContain('等待原江湖会话确认');
      expect(await context.prisma.weComUserBind.findFirst({ where: { tenantId: context.tenant.id, userId: user.id } })).toBeNull();

      const wrongStatus = await context.app.inject({ method: 'GET', url: `/api/wecom/oauth/status?requestId=${requestId}`, headers: auth(wrongToken) });
      expect(wrongStatus.statusCode).toBe(404);
      const wrongConfirm = await context.app.inject({ method: 'POST', url: '/api/wecom/oauth/confirm', headers: auth(wrongToken), payload: { requestId } });
      expect(wrongConfirm.statusCode).toBe(404);
      expect(await context.prisma.weComUserBind.findFirst({ where: { tenantId: context.tenant.id, userId: user.id } })).toBeNull();

      const status = await context.app.inject({ method: 'GET', url: `/api/wecom/oauth/status?requestId=${requestId}`, headers: auth(token) });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ status: 'pending', wecomUserid: 'oauth-attacker' });
      const confirm = await context.app.inject({ method: 'POST', url: '/api/wecom/oauth/confirm', headers: auth(token), payload: { requestId } });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toEqual({ ok: true, wecomUserid: 'oauth-attacker' });
      expect((await context.prisma.weComUserBind.findFirstOrThrow({ where: { tenantId: context.tenant.id, userId: user.id } })).wecomUserid).toBe('oauth-attacker');
      const replay = await context.app.inject({ method: 'POST', url: '/api/wecom/oauth/confirm', headers: auth(token), payload: { requestId } });
      expect(replay.statusCode).toBe(409);

      await context.prisma.weComOAuthState.create({ data: {
        id: 'expired-state', requestId: 'expired-request', tenantId: context.tenant.id, userId: user.id,
        pendingWecomUserid: 'expired-wx', pendingAt: new Date(), expiresAt: new Date(Date.now() - 1000),
      } });
      const expired = await context.app.inject({ method: 'POST', url: '/api/wecom/oauth/confirm', headers: auth(token), payload: { requestId: 'expired-request' } });
      expect(expired.statusCode).toBe(410);
    } finally { await context.cleanup(); }
  });

  it('rechecks the current role when confirming a pending OAuth bind', async () => {
    const context = await createTestContext();
    try {
      const user = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'OAuth downgrade', role: 'member' } });
      const token = context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role: 'member' });
      await context.prisma.weComOAuthState.create({ data: {
        id: 'downgrade-state', requestId: 'downgrade-request', tenantId: context.tenant.id, userId: user.id,
        pendingWecomUserid: 'downgrade-wx', pendingAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      } });
      await context.prisma.user.update({ where: { id: user.id }, data: { role: 'viewer' } });
      const confirm = await context.app.inject({ method: 'POST', url: '/api/wecom/oauth/confirm', headers: auth(token), payload: { requestId: 'downgrade-request' } });
      expect(confirm.statusCode).toBe(403);
      expect(await context.prisma.weComUserBind.findFirst({ where: { tenantId: context.tenant.id, userId: user.id } })).toBeNull();
    } finally { await context.cleanup(); }
  });

  it('does not push proposal content to deleted or viewer binds', async () => {
    const context = await createTestContext();
    try {
      const viewer = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'V', role: 'viewer' } });
      const deleted = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: 'D', role: 'member' } });
      await context.prisma.weComConfig.create({ data: { tenantId: context.tenant.id, corpId: `corp-${randomUUID()}`, agentId: '1', secretEnc: enc('secret'), callbackToken: 'token' } });
      await context.prisma.weComUserBind.createMany({ data: [
        { id: 'wb-viewer-push', tenantId: context.tenant.id, userId: viewer.id, wecomUserid: 'wx-viewer-push' },
        { id: 'wb-deleted-push', tenantId: context.tenant.id, userId: deleted.id, wecomUserid: 'wx-deleted-push' },
      ] });
      await context.prisma.user.delete({ where: { id: deleted.id } });
      await context.prisma.account.create({ data: { id: 'acc-push', tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.changeProposal.create({ data: { id: 'cp-push', tenantId: context.tenant.id, accountId: 'acc-push', entityKind: 'person', entityId: 'missing', field: 'title', oldValue: 'a', newValue: 'b', dedupeKey: 'push-key' } });
      outbound.fetch.mockReset();
      await pushProposalCard(context.tenant.id, 'cp-push');
      expect(outbound.fetch).not.toHaveBeenCalled();
    } finally { await context.cleanup(); }
  });
});
