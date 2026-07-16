import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type Fixture = {
  journeyB: {
    accountName: string; wrongOpportunityName: string; correctOpportunityName: string;
    visitTopic: string; targetPersonName: string; duplicatePersonName: string;
  };
  journeyC: {
    accountName: string; opportunityName: string; concurrentNameA: string; concurrentNameB: string;
  };
};

const auth = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});
const oid = (prefix: string, value: number) => `${prefix}_${value.toString(16).padStart(32, '0')}`;

describe('INT-502 sanitized internal release journeys B and C', () => {
  let context: TestContext;
  let fixture: Fixture;

  beforeEach(async () => {
    context = await createTestContext();
    fixture = JSON.parse(await readFile(new URL('./fixtures/internal-release-journeys.json', import.meta.url), 'utf8')) as Fixture;
  });
  afterEach(async () => context.cleanup());

  it('journey B repairs a wrong opportunity, merges a duplicate person, and leaves one audit per correction', async () => {
    const accountId = oid('acc', 0xb1);
    const wrongOpportunityId = oid('opp', 0xb2);
    const correctOpportunityId = oid('opp', 0xb3);
    const visitId = oid('visit', 0xb4);
    const targetPersonId = oid('p', 0xb5);
    const duplicatePersonId = oid('p', 0xb6);
    await context.prisma.account.create({ data: {
      id: accountId, tenantId: context.tenant.id, name: fixture.journeyB.accountName, customerType: 2,
    } });
    await context.prisma.opportunity.createMany({ data: [{
      id: wrongOpportunityId, tenantId: context.tenant.id, accountId, name: fixture.journeyB.wrongOpportunityName,
      customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    }, {
      id: correctOpportunityId, tenantId: context.tenant.id, accountId, name: fixture.journeyB.correctOpportunityName,
      customerType: 2, pipelineStage: '需求引导', engageStage: '方案可研',
    }] });
    await context.prisma.visitNote.create({ data: {
      id: visitId, tenantId: context.tenant.id, accountId, opportunityId: wrongOpportunityId,
      topic: fixture.journeyB.visitTopic, origin: 'workbuddy', createdBy: context.owner.id,
    } });
    await context.prisma.person.createMany({ data: [{
      id: targetPersonId, tenantId: context.tenant.id, accountId, name: fixture.journeyB.targetPersonName, title: '平台主管',
    }, {
      id: duplicatePersonId, tenantId: context.tenant.id, accountId, name: fixture.journeyB.duplicatePersonName, title: '平台主管',
    }] });
    await context.prisma.note.create({ data: {
      id: oid('note', 0xb7), tenantId: context.tenant.id, accountId, opportunityId: correctOpportunityId,
      personId: duplicatePersonId, content: '脱敏重复人物关联记录', source: 'workbuddy', createdBy: context.owner.id,
    } });

    const rebind = await context.app.inject({
      method: 'POST', url: '/api/repair/rebind', headers: auth(context.token),
      payload: { kind: 'visitNote', id: visitId, accountId, opportunityId: correctOpportunityId },
    });
    expect(rebind.statusCode, rebind.body).toBe(200);
    expect(await context.prisma.visitNote.findUniqueOrThrow({ where: { id: visitId } }))
      .toMatchObject({ accountId, opportunityId: correctOpportunityId });

    const mergePayload = {
      targetPersonId,
      sourcePersonId: duplicatePersonId,
      roleConflictByOpportunity: {},
    };
    const mergeHeaders = auth(context.token, { 'idempotency-key': 'int-502-journey-b-person-merge' });
    const firstMerge = await context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: mergeHeaders, payload: mergePayload });
    const replayMerge = await context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: mergeHeaders, payload: mergePayload });
    expect(firstMerge.statusCode, firstMerge.body).toBe(200);
    expect(replayMerge.json()).toEqual(firstMerge.json());
    expect(await context.prisma.person.findUniqueOrThrow({ where: { id: duplicatePersonId } }))
      .toMatchObject({ archiveReason: 'merged_duplicate', mergedIntoPersonId: targetPersonId });
    expect(await context.prisma.note.findFirstOrThrow({ where: { tenantId: context.tenant.id } }))
      .toMatchObject({ personId: targetPersonId, opportunityId: correctOpportunityId });
    expect(await context.prisma.auditEvent.count({ where: {
      tenantId: context.tenant.id, action: 'rebind', entityId: visitId,
    } })).toBe(1);
    expect(await context.prisma.auditEvent.count({ where: {
      tenantId: context.tenant.id, action: 'person_merge', entityId: targetPersonId,
    } })).toBe(1);
  });

  it('journey C recovers an unknown response, serializes two members, then archives and restores', async () => {
    const accountId = oid('acc', 0xc1);
    await context.prisma.account.create({ data: {
      id: accountId, tenantId: context.tenant.id, name: fixture.journeyC.accountName, customerType: 2,
    } });
    const member = await context.prisma.user.create({ data: {
      tenantId: context.tenant.id, email: 'int-502-member@example.test', passwordHash: 'unused', name: 'Release Member', role: 'member',
    } });
    const memberToken = context.app.jwt.sign({ userId: member.id, tenantId: context.tenant.id, role: 'member' });
    const payload = {
      accountId, name: fixture.journeyC.opportunityName, personIds: [], withEdges: false, skeleton: [],
    };
    const headers = auth(context.token, { 'idempotency-key': 'int-502-journey-c-offline-replay' });
    const responseLostToClient = await context.app.inject({ method: 'POST', url: '/api/commands/opportunity-skeleton', headers, payload });
    expect(responseLostToClient.statusCode, responseLostToClient.body).toBe(200);
    const recovered = await context.app.inject({ method: 'POST', url: '/api/commands/opportunity-skeleton', headers, payload });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ replayed: true, opportunityId: responseLostToClient.json().opportunityId });
    const opportunityId = recovered.json().opportunityId as string;
    expect(await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id, accountId } })).toBe(1);

    const concurrent = await Promise.all([
      context.app.inject({
        method: 'PATCH', url: `/api/repair/opportunity/${opportunityId}`, headers: auth(context.token),
        payload: { baseVersion: 0, name: fixture.journeyC.concurrentNameA },
      }),
      context.app.inject({
        method: 'PATCH', url: `/api/repair/opportunity/${opportunityId}`, headers: auth(memberToken),
        payload: { baseVersion: 0, name: fixture.journeyC.concurrentNameB },
      }),
    ]);
    expect(concurrent.map((result) => result.statusCode).sort()).toEqual([200, 409]);

    const archived = await context.app.inject({
      method: 'POST', url: `/api/archive/opportunity/${opportunityId}`, headers: auth(memberToken),
      payload: { reason: 'INT-502 脱敏回滚演练' },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const restored = await context.app.inject({
      method: 'POST', url: `/api/archive/opportunity/${opportunityId}/restore`, headers: auth(context.token),
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await context.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } }))
      .toMatchObject({ archivedAt: null, archivedBy: null, archiveReason: '' });
    expect(await context.prisma.auditEvent.findMany({
      where: { tenantId: context.tenant.id, entityId: opportunityId, action: { in: ['archive', 'restore'] } },
      orderBy: { createdAt: 'asc' }, select: { action: true },
    })).toEqual([{ action: 'archive' }, { action: 'restore' }]);
  });
});
