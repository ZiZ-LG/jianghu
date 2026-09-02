import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntelligenceItemCommandSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import {
  executeIntelligenceItemCommand,
  intelligenceItemDetail,
  listIntelligenceItems,
} from '../src/intelligenceFocus/service.js';
import {
  referenceFingerprint,
  sourceArtifactIdempotencyDomain,
} from '../src/sourceArtifacts/model.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
const learnedAt = '2026-08-27T12:00:00.000Z';

describe('SAAS-206 IntelligenceItem service authority', () => {
  let test: TestContext;
  let ctx: CommandContext;
  const customerId = 'customer-206-intel';
  const matterId = 'matter-206-intel';
  const personId = 'person-206-intel';

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner', channel: 'web',
      requestId: randomUUID(), assertionMode: 'user_asserted',
    };
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: '情报客户', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '情报事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId: customerId, name: '关键人', title: '负责人',
    } });
    await test.prisma.matterParticipant.create({ data: {
      tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId,
    } });
  });
  afterEach(async () => test.cleanup());

  function createCommand(id = 'intel-206') {
    return IntelligenceItemCommandSchema.parse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: {
        id, customerId, matterId, statement: '客户报告预算评审将在下周完成。',
        source: { description: '销售本人在客户会议中记录' },
        learnedAt, confidence: 0.7,
        targets: [{ kind: 'matter', id: matterId }, { kind: 'person', id: personId }],
      },
    });
  }

  const execute = async (command: ReturnType<typeof IntelligenceItemCommandSchema.parse>) => (
    test.prisma.$transaction((tx) => executeIntelligenceItemCommand(tx, ctx, policy, command))
  );

  it('creates a human-confirmed reported item with canonical refs and body-free audit', async () => {
    const evidenceBefore = await test.prisma.evidenceEvent.count();
    const receipt = await execute(createCommand());
    expect(receipt).toEqual({
      type: 'CREATE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206', customerId, matterId,
      assertionType: 'reported', sourceKind: 'manual', status: 'active', version: 0, undoable: false,
    });
    const row = await test.prisma.intelligenceItem.findUniqueOrThrow({ where: { id: 'intel-206' } });
    expect(row).toMatchObject({
      tenantId: test.tenant.id, customerId, matterId, assertionType: 'reported', sourceKind: 'manual',
      sourceRefId: null, sourceRefVersion: null, createdByUserId: test.owner.id, version: 0,
    });
    expect(JSON.parse(row.targetRefs)).toEqual([
      { kind: 'matter', id: matterId }, { kind: 'person', id: personId },
    ]);
    expect(await test.prisma.evidenceEvent.count()).toBe(evidenceBefore);
    const audit = await test.prisma.auditEvent.findFirstOrThrow({ where: { entityId: row.id } });
    expect(audit.action).toBe('intelligence_item_create');
    expect(audit.metadata).not.toContain(row.statement);
    expect(audit.metadata).not.toContain(row.sourceDescription);
    expect(audit.changedFields).not.toContain(row.statement);
  });

  it('reloads current role/scope and rejects viewer, machine, cross-parent and stale writes without side effects', async () => {
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    await expect(execute(createCommand())).rejects.toMatchObject({ code: 'viewer_write_denied', statusCode: 403 });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'owner' } });
    ctx = { ...ctx, assertionMode: 'machine_proposed' };
    await expect(execute(createCommand())).rejects.toMatchObject({ code: 'human_confirmation_required', statusCode: 403 });
    ctx = { ...ctx, assertionMode: 'user_asserted' };

    const bad = createCommand('intel-cross-parent');
    if (bad.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    bad.item.targets = [{ kind: 'person', id: 'other-person' }];
    await expect(execute(bad)).rejects.toMatchObject({ scopedNotFound: true });
    expect(await test.prisma.intelligenceItem.count()).toBe(0);
    expect(await test.prisma.auditEvent.count()).toBe(0);
  });

  it('requires exact approved Evidence/Interaction snapshots and never promotes Intelligence into Evidence', async () => {
    await test.prisma.evidenceEvent.create({ data: {
      id: 'evidence-206', tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId,
      personId, signalKey: 'intro_referral', direction: 1, status: 'approved', rawContent: '正式证据正文',
    } });
    const evidenceCommand = createCommand('intel-evidence');
    if (evidenceCommand.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    evidenceCommand.item.source = {
      kind: 'evidence', description: '引用已审核证据', refId: 'evidence-206', refVersion: 0,
    };
    const evidenceCount = await test.prisma.evidenceEvent.count();
    await execute(evidenceCommand);
    expect(await test.prisma.evidenceEvent.count()).toBe(evidenceCount);

    const stale = createCommand('intel-evidence-stale');
    if (stale.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    stale.item.source = {
      kind: 'evidence', description: '错误快照', refId: 'evidence-206', refVersion: 1,
    };
    await expect(execute(stale)).rejects.toMatchObject({ code: 'intelligence_source_version_conflict' });
    await test.prisma.evidenceEvent.update({ where: { id: 'evidence-206' }, data: { status: 'pending_review' } });
    const pending = createCommand('intel-evidence-pending');
    if (pending.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    pending.item.source = {
      kind: 'evidence', description: '尚未审核', refId: 'evidence-206', refVersion: 0,
    };
    await expect(execute(pending)).rejects.toMatchObject({ scopedNotFound: true });

    const source = 'saas-206-interaction-test';
    const externalRef = 'interaction-source-206';
    const idempotencyDomain = sourceArtifactIdempotencyDomain(test.owner.id);
    await test.prisma.sourceArtifact.create({ data: {
      id: 'source-interaction-206', tenantId: test.tenant.id, accountId: customerId, matterId,
      personId: null, backingKind: 'external_reference', backingId: 'source-interaction-206',
      artifactKind: 'external_reference', source, externalRef, idempotencyDomain,
      title: '会议来源', fingerprintKind: 'reference_sha256_v1',
      sourceFingerprint: referenceFingerprint({ idempotencyDomain, source, externalRef }),
      retentionState: 'reference_only', createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await test.prisma.interaction.create({ data: {
      id: 'interaction-206', tenantId: test.tenant.id, accountId: customerId, matterId,
      sourceArtifactId: 'source-interaction-206', activityKind: 'meeting',
      occurredAt: new Date('2026-08-27T10:00:00.000Z'), confirmedByUserId: test.owner.id, version: 2,
    } });
    const interaction = createCommand('intel-interaction');
    if (interaction.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    interaction.item.source = {
      kind: 'interaction', description: '引用确认后的会议活动', refId: 'interaction-206', refVersion: 2,
    };
    await expect(execute(interaction)).resolves.toMatchObject({ sourceKind: 'interaction' });
    const staleInteraction = createCommand('intel-interaction-stale');
    if (staleInteraction.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    staleInteraction.item.source = {
      kind: 'interaction', description: '错误活动快照', refId: 'interaction-206', refVersion: 1,
    };
    await expect(execute(staleInteraction))
      .rejects.toMatchObject({ code: 'intelligence_source_version_conflict' });
    await test.prisma.sourceArtifact.update({
      where: { id: 'source-interaction-206' }, data: { retentionState: 'deleted' },
    });
    const deletedSource = createCommand('intel-interaction-deleted');
    if (deletedSource.type !== 'CREATE_INTELLIGENCE_ITEM') throw new Error('fixture');
    deletedSource.item.source = {
      kind: 'interaction', description: '已删除来源', refId: 'interaction-206', refVersion: 2,
    };
    await expect(execute(deletedSource)).rejects.toMatchObject({ scopedNotFound: true });
  });

  it('enforces CAS update/archive/restore and current-scope list/direct reads', async () => {
    await execute(createCommand());
    await execute(IntelligenceItemCommandSchema.parse({
      type: 'UPDATE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206', expectedVersion: 0,
      changes: { confidence: 0.9 },
    }));
    await expect(execute(IntelligenceItemCommandSchema.parse({
      type: 'UPDATE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206', expectedVersion: 0,
      changes: { confidence: 0.8 },
    }))).rejects.toMatchObject({ code: 'intelligence_item_version_conflict', statusCode: 409 });
    await execute(IntelligenceItemCommandSchema.parse({
      type: 'ARCHIVE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206', expectedVersion: 1,
      reason: '信息已经过期',
    }));
    await expect(listIntelligenceItems(test.prisma, ctx, policy, {
      customerId, matterId, includeArchived: false, cursor: null, limit: 50,
    })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(intelligenceItemDetail(test.prisma, ctx, policy, 'intel-206'))
      .resolves.toMatchObject({ item: { status: 'archived', version: 2 } });
    await execute(IntelligenceItemCommandSchema.parse({
      type: 'RESTORE_INTELLIGENCE_ITEM', intelligenceItemId: 'intel-206', expectedVersion: 2,
    }));
    await expect(listIntelligenceItems(test.prisma, ctx, policy, {
      customerId, matterId, includeArchived: false, cursor: null, limit: 50,
    })).resolves.toMatchObject({ items: [{ id: 'intel-206', status: 'active', version: 3 }] });

    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    await expect(intelligenceItemDetail(test.prisma, ctx, policy, 'intel-206')).resolves.toBeNull();
  });

  it('fails closed when structured storage is no longer canonical', async () => {
    await execute(createCommand());
    await test.prisma.intelligenceItem.update({
      where: { id: 'intel-206' },
      data: { targetRefs: ' [{"kind":"matter","id":"matter-206-intel"}]' },
    });
    await expect(intelligenceItemDetail(test.prisma, ctx, policy, 'intel-206'))
      .rejects.toMatchObject({ code: 'intelligence_item_storage_invalid', statusCode: 409 });
  });
});
