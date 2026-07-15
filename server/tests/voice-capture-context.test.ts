import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function registerTenant(test: TestContext, label: string): Promise<{ tenantId: string; token: string }> {
  const response = await test.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `${label}-${randomUUID()}@example.test`,
      password: 'test-password',
      name: `${label} Owner`,
      tenantName: `${label} Tenant`,
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ token: string; tenant: { id: string } }>();
  return { tenantId: body.tenant.id, token: body.token };
}

async function seedCaptureTree(test: TestContext, tenantId: string, prefix: string) {
  const accountId = `acc-${prefix}`;
  const opportunityId = `opp-${prefix}`;
  const personId = `person-${prefix}`;
  await test.prisma.account.create({ data: { id: accountId, tenantId, name: `Account ${prefix}`, customerType: 2 } });
  await test.prisma.opportunity.create({ data: {
    id: opportunityId, tenantId, accountId, name: `Opportunity ${prefix}`, customerType: 2,
    pipelineStage: '线索', engageStage: '需求调研立项',
  } });
  await test.prisma.person.create({ data: { id: personId, tenantId, accountId, name: `Person ${prefix}`, title: '负责人' } });
  return { accountId, opportunityId, personId };
}

describe('voice capture person context', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('accepts a person in the tenant account and keeps the context from creating a formal person', async () => {
    const tree = await seedCaptureTree(test, test.tenant.id, 'valid');

    const response = await test.app.inject({
      method: 'POST', url: '/api/voice/extract', headers: {
        authorization: `Bearer ${test.token}`, 'idempotency-key': 'voice-person-valid-key',
      },
      payload: { text: '虚构拜访记录', ...tree },
    });

    expect(response.statusCode).toBe(200);
    expect(await test.prisma.visitNote.findMany({ where: { tenantId: test.tenant.id } })).toEqual([
      expect.objectContaining({ accountId: tree.accountId, opportunityId: tree.opportunityId }),
    ]);
    expect(await test.prisma.person.count({ where: { tenantId: test.tenant.id } })).toBe(1);
    expect(await test.prisma.personSuggestion.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('fails closed identically for a cross-tenant person before any command or visit side effect', async () => {
    const own = await seedCaptureTree(test, test.tenant.id, 'own');
    const foreignTenant = await registerTenant(test, 'foreign');
    const foreign = await seedCaptureTree(test, foreignTenant.tenantId, 'foreign');
    const beforeCommands = await test.prisma.commandRun.count();

    const response = await test.app.inject({
      method: 'POST', url: '/api/voice/extract', headers: {
        authorization: `Bearer ${test.token}`, 'idempotency-key': 'voice-person-foreign-key',
      },
      payload: { text: '虚构拜访记录', accountId: own.accountId, opportunityId: own.opportunityId, personId: foreign.personId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '资源不存在' });
    expect(await test.prisma.commandRun.count()).toBe(beforeCommands);
    expect(await test.prisma.visitNote.count()).toBe(0);
  });

  it('fails closed identically for a person from another account before any command or visit side effect', async () => {
    const selected = await seedCaptureTree(test, test.tenant.id, 'selected');
    const other = await seedCaptureTree(test, test.tenant.id, 'other');
    const beforeCommands = await test.prisma.commandRun.count();

    const response = await test.app.inject({
      method: 'POST', url: '/api/voice/extract', headers: {
        authorization: `Bearer ${test.token}`, 'idempotency-key': 'voice-person-other-account-key',
      },
      payload: { text: '虚构拜访记录', accountId: selected.accountId, opportunityId: selected.opportunityId, personId: other.personId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '资源不存在' });
    expect(await test.prisma.commandRun.count()).toBe(beforeCommands);
    expect(await test.prisma.visitNote.count()).toBe(0);
  });

  it('keeps accepting legacy voice payloads without personId', async () => {
    const tree = await seedCaptureTree(test, test.tenant.id, 'legacy');
    const response = await test.app.inject({
      method: 'POST', url: '/api/voice/extract', headers: {
        authorization: `Bearer ${test.token}`, 'idempotency-key': 'voice-legacy-context-key',
      },
      payload: { text: '虚构旧客户端记录', accountId: tree.accountId, opportunityId: tree.opportunityId },
    });

    expect(response.statusCode).toBe(200);
  });

  it('discards only its reservation when the parent is archived after preflight but before transactional recheck', async () => {
    const tree = await seedCaptureTree(test, test.tenant.id, 'archive-race');
    let archiveOnPrepare = true;
    test.prisma.$use(async (params, next) => {
      if (archiveOnPrepare && params.model === 'AiConfig' && params.action === 'findUnique') {
        archiveOnPrepare = false;
        await test.prisma.account.update({
          where: { id: tree.accountId },
          data: { archivedAt: new Date(), archivedBy: test.owner.id, archiveReason: '虚构竞态归档' },
        });
      }
      return next(params);
    });

    const response = await test.app.inject({
      method: 'POST', url: '/api/voice/extract', headers: {
        authorization: `Bearer ${test.token}`, 'idempotency-key': 'voice-parent-archive-race-key',
      },
      payload: { text: '虚构拜访记录', ...tree },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '资源不存在' });
    expect(await test.prisma.commandRun.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.visitNote.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });
});
