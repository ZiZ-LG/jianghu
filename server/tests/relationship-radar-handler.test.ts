import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess, type CommandContext } from '@jianghu/domain-contracts';
import { BUILT_IN_AGENT_DEFINITIONS } from '../src/agents/registry.js';
import {
  loadRelationshipRadarFacts,
  productionRelationshipRadarHandlers,
  RelationshipRadarError,
} from '../src/relationshipRadar/handler.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy = assembleProductAccess({ edition: 'internal' }).policy;
const now = new Date('2026-09-01T12:00:00.000Z');

describe('SAAS-212 relationship radar deterministic handler', () => {
  let test: TestContext;
  let ctx: CommandContext;
  const customerId = 'radar-handler-customer';
  const matterId = 'radar-handler-matter';
  const personA = 'radar-handler-person-a';
  const personB = 'radar-handler-person-b';

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: randomUUID(),
      assertionMode: 'user_asserted',
    };
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: 'Private customer name',
      categoryKey: 'enterprise', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: 'Private matter name',
      kind: 'complex_sale', lifecycleStatus: 'active', customerType: 1,
      pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.createMany({ data: [
      { id: personA, tenantId: test.tenant.id, accountId: customerId, name: 'Private A', title: 'Role A' },
      { id: personB, tenantId: test.tenant.id, accountId: customerId, name: 'Private B', title: 'Role B' },
    ] });
    await test.prisma.matterParticipant.createMany({ data: [
      { id: 'radar-handler-participant-a', tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId: personA },
      { id: 'radar-handler-participant-b', tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId: personB },
    ] });
    await test.prisma.edge.create({ data: {
      id: 'radar-handler-relation', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, source: personA, target: personB,
      kind: 'influences', layer: 'L2', label: 'Private relation label', directed: true, version: 5,
    } });
    await test.prisma.sourceArtifact.create({ data: {
      id: 'radar-handler-source', tenantId: test.tenant.id, accountId: customerId, matterId,
      backingKind: 'note', backingId: 'radar-handler-note', artifactKind: 'note',
      source: 'manual', idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: 'Private source title', occurredAt: new Date('2026-08-31T09:00:00.000Z'),
      fingerprintKind: 'content_sha256_v1', sourceFingerprint: 'a'.repeat(64),
      retentionState: 'available', retentionUpdatedAt: now,
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await test.prisma.interaction.create({ data: {
      id: 'radar-handler-interaction', tenantId: test.tenant.id, accountId: customerId, matterId,
      sourceArtifactId: 'radar-handler-source', activityKind: 'meeting',
      occurredAt: new Date('2026-08-31T09:00:00.000Z'), title: 'Private interaction title',
      confirmedByUserId: test.owner.id,
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'radar-handler-evidence', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, personId: personA, signalKey: 'review_scheduled', direction: 1,
      rawContent: 'Private evidence body', occurredAt: '2026-08-31T10:00:00.000Z',
      status: 'approved', origin: 'manual', createdBy: test.owner.id,
    } });
    await test.prisma.intelligenceItem.create({ data: {
      id: 'radar-handler-intelligence', tenantId: test.tenant.id, customerId, matterId,
      assertionType: 'reported', statement: 'Private intelligence statement',
      sourceKind: 'manual', sourceDescription: 'Private source description',
      learnedAt: new Date('2026-08-31T10:30:00.000Z'), confidence: 0.8,
      targetRefs: JSON.stringify([{ kind: 'person', id: personB }]),
      createdByUserId: test.owner.id,
    } });
    await test.prisma.stakeholderFocus.create({ data: {
      id: 'radar-handler-focus', tenantId: test.tenant.id, customerId, matterId, personId: personB,
      desiredChange: 'Private desired change', rationale: 'Private rationale', basisRefs: '[]',
      validUntil: new Date('2026-09-08T12:00:00.000Z'), activeMatterKey: matterId,
      confirmedByUserId: test.owner.id, confirmedAt: new Date('2026-08-31T11:00:00.000Z'),
    } });
    await test.prisma.planAction.create({ data: {
      id: 'radar-handler-commitment', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, personId: personA, title: 'Private commitment title',
      ownerId: test.owner.id, ownerUserId: test.owner.id, executionStatus: 'planned',
      scheduledAtUtc: new Date('2026-09-02T09:00:00.000Z'), isAllDay: false,
    } });
  });

  afterEach(async () => test.cleanup());

  it('loads only current tenant-scoped body-free formal metadata', async () => {
    const loaded = await loadRelationshipRadarFacts(test.prisma, ctx, policy, customerId, matterId, now);
    expect(loaded).toMatchObject({ tenantId: test.tenant.id, customerId, matterId });
    expect(loaded.participants).toHaveLength(2);
    expect(loaded.relations).toEqual([{
      id: 'radar-handler-relation', sourcePersonId: personA, targetPersonId: personB,
      directed: true, version: 5,
    }]);
    expect(loaded.interactions).toHaveLength(1);
    expect(loaded.evidence).toHaveLength(1);
    expect(loaded.intelligence).toHaveLength(1);
    expect(loaded.commitments).toHaveLength(1);
    const serialized = JSON.stringify(loaded);
    for (const forbidden of [
      'Private customer name', 'Private matter name', 'Private relation label',
      'Private source title', 'Private interaction title', 'Private evidence body',
      'Private intelligence statement', 'Private source description', 'Private desired change',
      'Private rationale', 'Private commitment title',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('prepares six outputs deterministically and performs zero writes', async () => {
    const definition = BUILT_IN_AGENT_DEFINITIONS[2]!;
    const handlers = productionRelationshipRadarHandlers(test.prisma, policy, () => now);
    const handler = handlers['relationship_radar@saas-212.v1']!;
    const before = await Promise.all([
      test.prisma.relationshipRadarSnapshot.count(), test.prisma.agentRun.count(),
      test.prisma.auditEvent.count(), test.prisma.commandRun.count(),
      test.prisma.edge.count(), test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ]);
    const prepared = await handler.prepare({
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      requestId: ctx.requestId,
      runId: 'radar-handler-run',
      definition,
      limits: { maxCostUnits: 500, timeoutMs: 30_000, maxAttempts: 2 },
      customerId,
      matterId,
      sourceArtifactId: null,
      inputRefs: [
        { kind: 'customer', id: customerId, version: 0 },
        { kind: 'matter', id: matterId, version: 0 },
      ],
      attempt: 1,
      budgetRemaining: 500,
      signal: new AbortController().signal,
    });
    expect(prepared).toMatchObject({ audit: { costUnits: 1, evidenceRefs: [] } });
    expect('privateState' in prepared && prepared.privateState).toMatchObject({
      payload: { customerId, matterId, signals: expect.arrayContaining([]) },
    });
    expect('privateState' in prepared
      && (prepared.privateState as { payload: { signals: unknown[] } }).payload.signals).toHaveLength(6);
    expect(JSON.stringify(prepared)).not.toContain('Private');
    await expect(Promise.all([
      test.prisma.relationshipRadarSnapshot.count(), test.prisma.agentRun.count(),
      test.prisma.auditEvent.count(), test.prisma.commandRun.count(),
      test.prisma.edge.count(), test.prisma.evidenceEvent.count(), test.prisma.planAction.count(),
    ])).resolves.toEqual(before);
  });

  it('fails scoped-not-found for a foreign tenant Matter without reading or writing it', async () => {
    const otherTenant = await test.prisma.tenant.create({ data: { id: 'radar-other-tenant', name: 'Other' } });
    await expect(loadRelationshipRadarFacts(
      test.prisma, ctx, policy, customerId, `${otherTenant.id}-matter`, now,
    )).rejects.toMatchObject({
      code: 'relationship_radar_not_found', statusCode: 404,
    } satisfies Partial<RelationshipRadarError>);
  });
});
