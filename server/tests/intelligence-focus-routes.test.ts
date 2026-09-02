import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-206 dedicated IntelligenceItem/StakeholderFocus routes', () => {
  let test: TestContext;
  const customerId = 'customer-206-routes';
  const matterId = 'matter-206-routes';
  const personId = 'person-206-routes';
  const headers = (key?: string) => ({
    authorization: `Bearer ${test.token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: '路由客户', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '路由事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId: customerId, name: '路由关键人', title: '负责人',
    } });
    await test.prisma.matterParticipant.create({ data: {
      tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId,
    } });
  });
  afterEach(async () => test.cleanup());

  const intelligencePayload = (id = 'intel-206-route') => ({
    type: 'CREATE_INTELLIGENCE_ITEM',
    item: {
      id, customerId, matterId, statement: '用户明确确认的路由情报正文',
      source: { description: '用户人工记录的来源说明' },
      learnedAt: '2026-08-28T00:00:00.000Z', confidence: 0.75,
      targets: [{ kind: 'person', id: personId }],
    },
  });

  it('requires a strict idempotency key and returns body-free replay-safe intelligence receipts', async () => {
    const missingKey = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item', headers: headers(), payload: intelligencePayload(),
    });
    expect(missingKey.statusCode, missingKey.body).toBe(400);

    const first = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item',
      headers: headers('saas-206-route-intel-create'), payload: intelligencePayload(),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      type: 'CREATE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206-route',
      status: 'active', version: 0, replayed: false, undoable: false,
    });
    expect(first.body).not.toContain('路由情报正文');
    expect(first.body).not.toContain('人工记录');

    const replay = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item',
      headers: headers('saas-206-route-intel-create'), payload: intelligencePayload(),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ intelligenceItemId: 'intel-206-route', replayed: true });
    const changedPayload = intelligencePayload();
    changedPayload.item.statement = '同一幂等键下不同的情报正文';
    const conflict = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item',
      headers: headers('saas-206-route-intel-create'), payload: changedPayload,
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_key_reused' });
    expect(await test.prisma.intelligenceItem.count()).toBe(1);
    expect(await test.prisma.auditEvent.count({ where: { entityKind: 'intelligence_item' } })).toBe(1);
  });

  it('re-authorizes completed replay and denies a database-role downgrade before new CommandRun/Audit writes', async () => {
    const key = 'saas-206-route-replay-auth';
    const created = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item', headers: headers(key), payload: intelligencePayload(),
    });
    expect(created.statusCode, created.body).toBe(200);
    const beforeRuns = await test.prisma.commandRun.count();
    const beforeAudits = await test.prisma.auditEvent.count();
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });

    const replay = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item', headers: headers(key), payload: intelligencePayload(),
    });
    expect(replay.statusCode, replay.body).toBe(403);
    expect(replay.json()).toMatchObject({ code: 'viewer_write_denied' });
    const newWrite = await test.app.inject({
      method: 'POST', url: '/api/commands/intelligence-item',
      headers: headers('saas-206-route-viewer-new'), payload: intelligencePayload('intel-viewer-denied'),
    });
    expect(newWrite.statusCode, newWrite.body).toBe(403);
    expect(await test.prisma.commandRun.count()).toBe(beforeRuns);
    expect(await test.prisma.auditEvent.count()).toBe(beforeAudits);
  });

  it('exposes stable strict list/detail reads and hides revoked/cross-tenant IDs', async () => {
    for (const [id, key] of [['intel-route-a', 'saas-206-route-a'], ['intel-route-b', 'saas-206-route-b']]) {
      const response = await test.app.inject({
        method: 'POST', url: '/api/commands/intelligence-item', headers: headers(key),
        payload: intelligencePayload(id),
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const firstPage = await test.app.inject({
      method: 'GET',
      url: `/api/intelligence-items?customerId=${customerId}&matterId=${matterId}&limit=1`,
      headers: headers(),
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await test.app.inject({
      method: 'GET',
      url: `/api/intelligence-items?customerId=${customerId}&matterId=${matterId}&limit=1&cursor=${firstPage.json().nextCursor}`,
      headers: headers(),
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    const detail = await test.app.inject({
      method: 'GET', url: '/api/intelligence-items/intel-route-a', headers: headers(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ item: { id: 'intel-route-a', targets: [{ kind: 'person', id: personId }] } });

    for (const url of [
      `/api/intelligence-items?customerId=${customerId}&matterId=${matterId}&limit=51`,
      `/api/intelligence-items?customerId=${customerId}&matterId=${matterId}&includeArchived=no`,
      `/api/intelligence-items?customerId=${customerId}&matterId=${matterId}&unexpected=1`,
      '/api/intelligence-items/bad%20id',
    ]) {
      const invalid = await test.app.inject({ method: 'GET', url, headers: headers() });
      expect(invalid.statusCode, `${url}: ${invalid.body}`).toBe(400);
    }

    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const hidden = await test.app.inject({
      method: 'GET', url: '/api/intelligence-items/intel-route-a', headers: headers(),
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const missing = await test.app.inject({
      method: 'GET', url: '/api/intelligence-items/missing-item', headers: headers(),
    });
    expect(hidden.json()).toEqual(missing.json());
  });

  it('sets/replaces/retires focus only through its dedicated idempotent command endpoint', async () => {
    const setPayload = {
      type: 'SET_STAKEHOLDER_FOCUS',
      focus: {
        id: 'focus-route-a', customerId, matterId, personId,
        desiredChange: '确认评审前置条件', rationale: '该负责人主持评审',
        evidenceGap: '尚需确认具体日期', basisRefs: [], validUntil: '2099-09-10T00:00:00.000Z',
      },
      expectedCurrentFocusId: null,
      expectedCurrentFocusVersion: null,
    };
    const first = await test.app.inject({
      method: 'POST', url: '/api/commands/stakeholder-focus',
      headers: headers('saas-206-route-focus-set'), payload: setPayload,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      type: 'SET_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-route-a',
      personId, status: 'active', version: 0, replayed: false,
    });
    expect(first.body).not.toContain('评审前置');
    const detail = await test.app.inject({
      method: 'GET', url: '/api/stakeholder-focuses/focus-route-a', headers: headers(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ item: { id: 'focus-route-a', status: 'active' } });

    const retired = await test.app.inject({
      method: 'POST', url: '/api/commands/stakeholder-focus',
      headers: headers('saas-206-route-focus-retire'),
      payload: {
        type: 'RETIRE_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-route-a', expectedVersion: 0,
        reason: '本轮聚焦结束',
      },
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json()).toMatchObject({ status: 'retired', version: 1, replayed: false });
    const list = await test.app.inject({
      method: 'GET',
      url: `/api/stakeholder-focuses?customerId=${customerId}&matterId=${matterId}&includeRetired=true`,
      headers: headers(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ id: 'focus-route-a', status: 'retired', version: 1 }] });
  });

  it('fails closed when commercial Free lacks sales.workspace', async () => {
    await test.cleanup();
    test = await createTestContext({ productAccess: { edition: 'commercial' } });
    const response = await test.app.inject({
      method: 'GET', url: '/api/intelligence-items?customerId=x&matterId=y', headers: headers(),
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ code: 'capability_denied' });
  });
});
