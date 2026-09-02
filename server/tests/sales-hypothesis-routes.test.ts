import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('SAAS-207 dedicated SalesHypothesis routes', () => {
  let test: TestContext;
  const customerId = 'customer-207-routes';
  const matterId = 'matter-207-routes';
  const personId = 'person-207-routes';
  const headers = (key?: string) => ({
    authorization: `Bearer ${test.token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: '假设路由客户', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '假设路由事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId: customerId, name: '路由 CFO', title: 'CFO',
    } });
    await test.prisma.matterParticipant.create({ data: {
      tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId,
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'evidence-207-route', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, personId, signalKey: 'spec_alignment', direction: 1,
      status: 'approved', rawContent: '敏感证据正文绝不能进入命令回执', createdBy: test.owner.id,
    } });
  });
  afterEach(async () => test.cleanup());

  const createPayload = (id = 'hypothesis-207-route', revisionId = 'revision-207-route') => ({
    type: 'CREATE_SALES_HYPOTHESIS',
    hypothesis: {
      id, customerId, matterId, personId, ownerUserId: test.owner.id,
      nextReviewAt: '2099-09-15T00:00:00.000Z',
      revision: {
        id: revisionId, claim: '预算将在九月获得批准', reason: 'CFO 已提交董事会',
        expectedSignals: ['收到采购订单草案'], falsificationConditions: ['董事会取消预算议题'],
      },
    },
  });

  it('requires strict idempotency and returns body-free replay-safe receipts', async () => {
    const missingKey = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(), payload: createPayload(),
    });
    expect(missingKey.statusCode, missingKey.body).toBe(400);
    const key = 'saas-207-route-create';
    const first = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key), payload: createPayload(),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      type: 'CREATE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207-route',
      currentRevisionId: 'revision-207-route', currentRevisionNumber: 1,
      status: 'untested', version: 0,
      replayed: false, undoable: false,
    });
    for (const body of ['预算将在', 'CFO 已提交', '收到采购', '取消预算']) {
      expect(first.body).not.toContain(body);
    }
    const replay = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key), payload: createPayload(),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ salesHypothesisId: 'hypothesis-207-route', replayed: true });
    const changed = createPayload();
    changed.hypothesis.revision.claim = '同幂等键不同正文';
    const conflict = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key), payload: changed,
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_key_reused' });
    const run = await test.prisma.commandRun.findFirstOrThrow({ where: { kind: 'sales-hypothesis-command' } });
    expect(run.resultSummary).not.toContain('预算将在');
    expect(run.resultSummary).not.toContain('CFO 已提交');
  });

  it('re-authorizes replay and denies viewer before any new command/audit record', async () => {
    const key = 'saas-207-route-replay-auth';
    const created = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key), payload: createPayload(),
    });
    expect(created.statusCode, created.body).toBe(200);
    const beforeRuns = await test.prisma.commandRun.count();
    const beforeAudits = await test.prisma.auditEvent.count();
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const replay = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key), payload: createPayload(),
    });
    expect(replay.statusCode, replay.body).toBe(403);
    expect(replay.json()).toMatchObject({ code: 'viewer_write_denied' });
    const newWrite = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers('saas-207-viewer-new'),
      payload: createPayload('hypothesis-viewer', 'revision-viewer'),
    });
    expect(newWrite.statusCode, newWrite.body).toBe(403);
    expect(await test.prisma.commandRun.count()).toBe(beforeRuns);
    expect(await test.prisma.auditEvent.count()).toBe(beforeAudits);
  });

  it('exposes strict paginated list/detail and body-free current-revision suggestion reads', async () => {
    for (const [id, revisionId, key] of [
      ['hypothesis-route-a', 'revision-route-a', 'saas-207-create-a'],
      ['hypothesis-route-b', 'revision-route-b', 'saas-207-create-b'],
    ]) {
      const response = await test.app.inject({
        method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers(key),
        payload: createPayload(id, revisionId),
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const link = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers('saas-207-link-a'),
      payload: {
        type: 'LINK_HYPOTHESIS_EVIDENCE',
        link: {
          id: 'route-link-a', salesHypothesisId: 'hypothesis-route-a', expectedVersion: 0,
          expectedCurrentRevisionId: 'revision-route-a', evidenceId: 'evidence-207-route',
          evidenceVersion: 0, direction: 'supporting',
        },
      },
    });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.body).not.toContain('敏感证据正文');
    const first = await test.app.inject({
      method: 'GET', url: `/api/sales-hypotheses?customerId=${customerId}&matterId=${matterId}&limit=1`,
      headers: headers(),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await test.app.inject({
      method: 'GET',
      url: `/api/sales-hypotheses?customerId=${customerId}&matterId=${matterId}&limit=1&cursor=${first.json().nextCursor}`,
      headers: headers(),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items).toHaveLength(1);
    const detail = await test.app.inject({
      method: 'GET', url: '/api/sales-hypotheses/hypothesis-route-a?limit=1', headers: headers(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      item: { id: 'hypothesis-route-a' },
      revisions: [{ revision: { id: 'revision-route-a' }, evidenceLinks: [{ id: 'route-link-a' }] }],
    });
    const suggestion = await test.app.inject({
      method: 'GET', url: '/api/sales-hypotheses/hypothesis-route-a/status-suggestion', headers: headers(),
    });
    expect(suggestion.statusCode, suggestion.body).toBe(200);
    expect(suggestion.json()).toMatchObject({
      formalStatus: 'untested', suggestedStatus: 'supported', evidenceRefs: [{ evidenceId: 'evidence-207-route' }],
    });
    expect(suggestion.body).not.toContain('敏感证据正文');
  });

  it('fails closed on invalid transport, hidden direct IDs and missing capability', async () => {
    const invalidRequests: Array<{
      method: 'GET' | 'POST';
      url: string;
      payload?: unknown;
    }> = [
      { method: 'GET', url: `/api/sales-hypotheses?customerId=${customerId}&matterId=${matterId}&limit=51` },
      { method: 'GET', url: `/api/sales-hypotheses?customerId=${customerId}&matterId=${matterId}&includeRetired=no` },
      { method: 'GET', url: `/api/sales-hypotheses?customerId=${customerId}&matterId=${matterId}&unexpected=1` },
      { method: 'GET', url: '/api/sales-hypotheses/bad%20id' },
      { method: 'POST', url: '/api/commands/sales-hypothesis', payload: { type: 'UNKNOWN' } },
    ];
    for (const request of invalidRequests) {
      const response = await test.app.inject({
        method: request.method, url: request.url, headers: headers('saas-207-invalid'),
        ...(request.payload ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, `${request.url}: ${response.body}`).toBe(400);
    }
    const hiddenCreate = await test.app.inject({
      method: 'POST', url: '/api/commands/sales-hypothesis', headers: headers('saas-207-hidden-create'),
      payload: createPayload(),
    });
    expect(hiddenCreate.statusCode, hiddenCreate.body).toBe(200);
    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const hidden = await test.app.inject({
      method: 'GET', url: '/api/sales-hypotheses/hypothesis-207-route', headers: headers(),
    });
    const missing = await test.app.inject({
      method: 'GET', url: '/api/sales-hypotheses/missing', headers: headers(),
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(hidden.json()).toEqual(missing.json());

    await test.cleanup();
    test = await createTestContext({ productAccess: { edition: 'commercial' } });
    const denied = await test.app.inject({
      method: 'GET', url: '/api/sales-hypotheses?customerId=x&matterId=y', headers: headers(),
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'capability_denied' });
  });
});
