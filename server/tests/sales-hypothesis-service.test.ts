import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SalesHypothesisCommandSchema,
  SalesHypothesisDetailQuerySchema,
  SalesHypothesisListQuerySchema,
  type CapabilityPolicy,
  type CommandContext,
  type SalesHypothesisCommand,
} from '@jianghu/domain-contracts';
import {
  executeSalesHypothesisCommand,
  listSalesHypotheses,
  salesHypothesisDetail,
  salesHypothesisStatusSuggestion,
} from '../src/hypotheses/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
const now = new Date('2026-08-30T12:00:00.000Z');
const nextReviewAt = '2026-09-15T00:00:00.000Z';

describe('SAAS-207 SalesHypothesis human authority', () => {
  let test: TestContext;
  let ctx: CommandContext;
  const customerId = 'customer-207-hypothesis';
  const matterId = 'matter-207-hypothesis';
  const personId = 'person-207-hypothesis';
  const otherPersonId = 'person-207-hypothesis-other';

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
      id: customerId, tenantId: test.tenant.id, name: '假设客户', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '假设事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.createMany({ data: [
      { id: personId, tenantId: test.tenant.id, accountId: customerId, name: '关键人', title: 'CFO' },
      { id: otherPersonId, tenantId: test.tenant.id, accountId: customerId, name: '旁观人', title: 'PM' },
    ] });
    await test.prisma.matterParticipant.create({ data: {
      tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId,
    } });
    await test.prisma.evidenceEvent.createMany({ data: [
      {
        id: 'evidence-207-support', tenantId: test.tenant.id, accountId: customerId,
        opportunityId: matterId, personId, signalKey: 'spec_alignment', direction: 1,
        tier: 'strong', rawContent: '董事会纪要原文，不得进回执', occurredAt: '2026-08-29',
        status: 'approved', origin: 'manual', createdBy: test.owner.id,
      },
      {
        id: 'evidence-207-against', tenantId: test.tenant.id, accountId: customerId,
        opportunityId: matterId, personId, signalKey: 'spec_alignment', direction: -1,
        tier: 'mid', rawContent: '预算被削减原文，不得进回执', occurredAt: '2026-08-30',
        status: 'approved', origin: 'manual', createdBy: test.owner.id,
      },
    ] });
  });

  afterEach(async () => test.cleanup());

  const command = (value: unknown) => SalesHypothesisCommandSchema.parse(value);
  const createCommand = (id = 'hypothesis-207', revisionId = 'hypothesis-revision-207') => command({
    type: 'CREATE_SALES_HYPOTHESIS',
    hypothesis: {
      id, customerId, matterId, personId, ownerUserId: test.owner.id, nextReviewAt,
      revision: {
        id: revisionId,
        claim: '预算将在九月获得批准',
        reason: 'CFO 已把预算案提交董事会',
        expectedSignals: ['收到采购订单草案'],
        falsificationConditions: ['董事会取消预算议题'],
      },
    },
  });

  const execute = async (input: SalesHypothesisCommand) => test.prisma.$transaction(
    (tx) => executeSalesHypothesisCommand(tx, ctx, policy, input, now),
  );

  async function formalSnapshot() {
    return Promise.all([
      test.prisma.edge.findMany({ orderBy: { id: 'asc' } }),
      test.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } }),
      test.prisma.planAction.findMany({ orderBy: { id: 'asc' } }),
      test.prisma.stakeholderFocus.findMany({ orderBy: { id: 'asc' } }),
      test.prisma.methodologyEvaluation.findMany({ orderBy: { id: 'asc' } }),
      test.prisma.strategyRisk.findMany({ orderBy: { id: 'asc' } }),
    ]);
  }

  it('creates a complete formal hypothesis with body-free audit and zero unrelated formal writes', async () => {
    const before = await formalSnapshot();
    await expect(execute(createCommand())).resolves.toEqual({
      type: 'CREATE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207', customerId, matterId,
      currentRevisionId: 'hypothesis-revision-207', currentRevisionNumber: 1, evidenceLinkId: null,
      verificationCommitmentId: null, status: 'untested', version: 0, undoable: false,
    });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: 'hypothesis-207' } }))
      .resolves.toMatchObject({
        tenantId: test.tenant.id, customerId, matterId, personId, status: 'untested',
        ownerUserId: test.owner.id, nextReviewAt: new Date(nextReviewAt),
        currentRevisionId: 'hypothesis-revision-207', legacyStrategyRiskId: null,
        createdByUserId: test.owner.id, version: 0,
      });
    await expect(test.prisma.salesHypothesisRevision.findUniqueOrThrow({
      where: { id: 'hypothesis-revision-207' },
    })).resolves.toMatchObject({
      revisionNumber: 1, expectedSignals: '["收到采购订单草案"]',
      falsificationConditions: '["董事会取消预算议题"]', origin: 'user',
      createdByUserId: test.owner.id, createdAt: now,
    });
    const audit = await test.prisma.auditEvent.findFirstOrThrow({
      where: { entityKind: 'sales_hypothesis', entityId: 'hypothesis-207' },
    });
    expect(audit.metadata).not.toContain('预算将在');
    expect(audit.metadata).not.toContain('CFO 已把');
    expect(audit.metadata).not.toContain('收到采购');
    expect(audit.metadata).not.toContain('取消预算');
    expect(await formalSnapshot()).toEqual(before);
  });

  it('requires human assertion, sales capability, participant and tenant-local owner before writes', async () => {
    ctx = { ...ctx, assertionMode: 'machine_proposed' };
    await expect(execute(createCommand('hyp-machine', 'rev-machine')))
      .rejects.toMatchObject({ code: 'human_confirmation_required', statusCode: 403 });
    ctx = { ...ctx, assertionMode: 'user_asserted' };
    await expect(test.prisma.$transaction((tx) => executeSalesHypothesisCommand(
      tx, ctx, { entitlements: [], permissions: [] }, createCommand('hyp-no-cap', 'rev-no-cap'), now,
    ))).rejects.toMatchObject({ code: 'capability_denied', statusCode: 403 });
    await test.prisma.matterParticipant.deleteMany({ where: { personId } });
    await expect(execute(createCommand('hyp-no-person', 'rev-no-person')))
      .rejects.toMatchObject({ scopedNotFound: true });
    const invalidOwner = createCommand('hyp-owner', 'rev-owner');
    if (invalidOwner.type !== 'CREATE_SALES_HYPOTHESIS') throw new Error('fixture');
    invalidOwner.hypothesis.personId = null;
    invalidOwner.hypothesis.ownerUserId = 'cross-tenant-or-missing';
    await expect(execute(invalidOwner)).rejects.toMatchObject({ scopedNotFound: true });
    expect(await test.prisma.salesHypothesis.count()).toBe(0);
    expect(await test.prisma.auditEvent.count({ where: { entityKind: 'sales_hypothesis' } })).toBe(0);
  });

  it('uses CAS, preserves immutable revisions and links, and resets a revised judgment to untested', async () => {
    await execute(createCommand());
    await execute(command({
      type: 'SET_SALES_HYPOTHESIS_STATUS', salesHypothesisId: 'hypothesis-207',
      expectedVersion: 0, status: 'testing',
    }));
    await execute(command({
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'hypothesis-link-207', salesHypothesisId: 'hypothesis-207', expectedVersion: 1,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'supporting',
      },
    }));
    const oldRevision = await test.prisma.salesHypothesisRevision.findUniqueOrThrow({
      where: { id: 'hypothesis-revision-207' },
    });
    const oldLink = await test.prisma.hypothesisEvidenceLink.findUniqueOrThrow({
      where: { id: 'hypothesis-link-207' },
    });
    await expect(execute(command({
      type: 'REVISE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207', expectedVersion: 2,
      expectedCurrentRevisionId: 'hypothesis-revision-207', nextReviewAt: '2026-09-30T00:00:00.000Z',
      revision: {
        id: 'hypothesis-revision-207-v2', claim: '预算已进入最终审批', reason: '收到董事会排期',
        expectedSignals: ['收到正式批复'], falsificationConditions: ['审批会议再次取消'],
      },
    }))).resolves.toMatchObject({
      currentRevisionId: 'hypothesis-revision-207-v2', status: 'untested', version: 3,
    });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: 'hypothesis-207' } }))
      .resolves.toMatchObject({
        currentRevisionId: 'hypothesis-revision-207-v2', status: 'untested',
        statusConfirmedByUserId: null, statusConfirmedAt: null, version: 3,
      });
    expect(await test.prisma.salesHypothesisRevision.findUniqueOrThrow({
      where: { id: 'hypothesis-revision-207' },
    })).toEqual(oldRevision);
    expect(await test.prisma.hypothesisEvidenceLink.findUniqueOrThrow({
      where: { id: 'hypothesis-link-207' },
    })).toEqual(oldLink);
    await expect(execute(command({
      type: 'REVISE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207', expectedVersion: 2,
      expectedCurrentRevisionId: 'hypothesis-revision-207', nextReviewAt: '2026-10-01T00:00:00.000Z',
      revision: {
        id: 'hypothesis-revision-stale', claim: '过期修订', reason: '旧快照',
        expectedSignals: ['旧信号'], falsificationConditions: ['旧反证'],
      },
    }))).rejects.toMatchObject({ code: 'sales_hypothesis_version_conflict' });
    expect(await test.prisma.salesHypothesisRevision.count()).toBe(2);
  });

  it('updates review metadata, confirms status server-side, and links only current approved Evidence once', async () => {
    await execute(createCommand());
    const owner2 = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: 'owner2@example.test', passwordHash: 'unused',
      name: 'Owner 2', role: 'member',
    } });
    await expect(execute(command({
      type: 'UPDATE_SALES_HYPOTHESIS_REVIEW', salesHypothesisId: 'hypothesis-207', expectedVersion: 0,
      ownerUserId: owner2.id, nextReviewAt: '2026-10-10T00:00:00.000Z',
    }))).resolves.toMatchObject({ version: 1 });
    await expect(execute(command({
      type: 'SET_SALES_HYPOTHESIS_STATUS', salesHypothesisId: 'hypothesis-207',
      expectedVersion: 1, status: 'supported',
    }))).resolves.toMatchObject({ status: 'supported', version: 2 });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: 'hypothesis-207' } }))
      .resolves.toMatchObject({
        ownerUserId: owner2.id, status: 'supported', statusConfirmedByUserId: test.owner.id,
        statusConfirmedAt: now,
      });
    const pending = await test.prisma.evidenceEvent.create({ data: {
      id: 'evidence-207-pending', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, personId, signalKey: 'spec_alignment', direction: 1,
      status: 'pending_review', rawContent: '候选证据', createdBy: test.owner.id,
    } });
    await expect(execute(command({
      type: 'LINK_HYPOTHESIS_EVIDENCE', link: {
        id: 'link-pending', salesHypothesisId: 'hypothesis-207', expectedVersion: 2,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: pending.id,
        evidenceVersion: 0, direction: 'supporting',
      },
    }))).rejects.toMatchObject({ scopedNotFound: true });
    const linkCommand = command({
      type: 'LINK_HYPOTHESIS_EVIDENCE', link: {
        id: 'link-approved', salesHypothesisId: 'hypothesis-207', expectedVersion: 2,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'supporting',
      },
    });
    await expect(execute(linkCommand)).resolves.toMatchObject({ evidenceLinkId: 'link-approved', version: 3 });
    const duplicate = command({
      type: 'LINK_HYPOTHESIS_EVIDENCE', link: {
        id: 'link-duplicate', salesHypothesisId: 'hypothesis-207', expectedVersion: 3,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'contradicting',
      },
    });
    await expect(execute(duplicate)).rejects.toMatchObject({ code: 'hypothesis_evidence_conflict' });
  });

  it('links approved Evidence to one exact completed verification Commitment without leaking result text', async () => {
    await execute(createCommand());
    const commitmentId = 'commitment-verification-208';
    await test.prisma.planAction.create({ data: {
      id: commitmentId,
      tenantId: test.tenant.id,
      accountId: customerId,
      opportunityId: matterId,
      personId,
      title: '验证预算审批排期',
      ownerId: test.owner.id,
      ownerUserId: test.owner.id,
      kind: 'verification',
      executionStatus: 'completed',
      done: true,
      doneAt: '2026-08-30',
      hypothesisId: 'hypothesis-207',
      hypothesisRevisionId: 'hypothesis-revision-207',
      completionResult: '客户确认董事会已排期，不得进回执或审计',
      completionResultRecordedAtUtc: now,
      completionResultRecordedByUserId: test.owner.id,
    } });
    const input = command({
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'link-verification-208', salesHypothesisId: 'hypothesis-207', expectedVersion: 0,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'supporting', verificationCommitmentId: commitmentId,
      },
    });

    await expect(execute(input)).resolves.toMatchObject({
      evidenceLinkId: 'link-verification-208', verificationCommitmentId: commitmentId, version: 1,
    });
    await expect(test.prisma.hypothesisEvidenceLink.findUniqueOrThrow({
      where: { id: 'link-verification-208' },
    })).resolves.toMatchObject({
      tenantId: test.tenant.id,
      hypothesisId: 'hypothesis-207',
      hypothesisRevisionId: 'hypothesis-revision-207',
      verificationCommitmentId: commitmentId,
    });
    const detail = await salesHypothesisDetail(
      test.prisma, ctx, policy, 'hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    );
    expect(detail).toMatchObject({
      revisions: [{ evidenceLinks: [{ verificationCommitmentId: commitmentId }] }],
    });
    const audit = await test.prisma.auditEvent.findFirstOrThrow({
      where: { entityKind: 'sales_hypothesis', entityId: 'hypothesis-207', action: 'sales_hypothesis_evidence_link' },
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({ verificationCommitmentId: commitmentId });
    expect(audit.metadata).not.toContain('客户确认董事会已排期');
  });

  it('fails closed for unfinished, unlinked, reviewed, or foreign verification Commitments', async () => {
    await execute(createCommand());
    const createVerification = async (id: string, data: Record<string, unknown> = {}) => {
      await test.prisma.planAction.create({ data: {
        id,
        tenantId: test.tenant.id,
        accountId: customerId,
        opportunityId: matterId,
        title: '验证承诺',
        ownerId: test.owner.id,
        ownerUserId: test.owner.id,
        kind: 'verification',
        executionStatus: 'completed',
        hypothesisId: 'hypothesis-207',
        hypothesisRevisionId: 'hypothesis-revision-207',
        completionResult: '已得到明确结果',
        completionResultRecordedAtUtc: now,
        completionResultRecordedByUserId: test.owner.id,
        ...data,
      } });
    };
    const link = (id: string, verificationCommitmentId: string) => command({
      type: 'LINK_HYPOTHESIS_EVIDENCE', link: {
        id, salesHypothesisId: 'hypothesis-207', expectedVersion: 0,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'supporting', verificationCommitmentId,
      },
    });

    await createVerification('commitment-unfinished-208', {
      executionStatus: 'planned', completionResult: '',
      completionResultRecordedAtUtc: null, completionResultRecordedByUserId: null,
    });
    await expect(execute(link('link-unfinished-208', 'commitment-unfinished-208')))
      .rejects.toMatchObject({ code: 'hypothesis_verification_commitment_not_ready' });

    await createVerification('commitment-unlinked-208', {
      hypothesisId: null, hypothesisRevisionId: null,
    });
    await expect(execute(link('link-unlinked-208', 'commitment-unlinked-208')))
      .rejects.toMatchObject({ scopedNotFound: true });

    await createVerification('commitment-reviewed-208', {
      verificationReviewDisposition: 'kept',
      verificationReviewedAtUtc: now,
      verificationReviewedByUserId: test.owner.id,
    });
    await expect(execute(link('link-reviewed-208', 'commitment-reviewed-208')))
      .rejects.toMatchObject({ code: 'hypothesis_verification_commitment_already_reviewed' });

    const foreignTenant = await test.prisma.tenant.create({ data: {
      id: 'foreign-verification-tenant-208', name: 'Foreign verification tenant',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'commitment-foreign-208', tenantId: foreignTenant.id,
      accountId: customerId, opportunityId: matterId, title: 'Foreign verification',
      executionStatus: 'completed', hypothesisId: 'hypothesis-207',
      hypothesisRevisionId: 'hypothesis-revision-207', completionResult: 'Foreign result',
      completionResultRecordedAtUtc: now, completionResultRecordedByUserId: test.owner.id,
    } });
    await expect(execute(link('link-foreign-208', 'commitment-foreign-208')))
      .rejects.toMatchObject({ scopedNotFound: true });
    expect(await test.prisma.hypothesisEvidenceLink.count()).toBe(0);
  });

  it('returns scoped list/detail history and derives current-revision-only body-free suggestions', async () => {
    await execute(createCommand());
    await execute(command({
      type: 'LINK_HYPOTHESIS_EVIDENCE', link: {
        id: 'link-support', salesHypothesisId: 'hypothesis-207', expectedVersion: 0,
        expectedCurrentRevisionId: 'hypothesis-revision-207', evidenceId: 'evidence-207-support',
        evidenceVersion: 0, direction: 'supporting',
      },
    }));
    await expect(salesHypothesisStatusSuggestion(
      test.prisma, ctx, policy, 'hypothesis-207',
    )).resolves.toMatchObject({
      formalStatus: 'untested', suggestedStatus: 'supported', reasonCode: 'only_supporting',
      evidenceRefs: [{ evidenceId: 'evidence-207-support', direction: 'supporting' }],
    });
    const auditBefore = await test.prisma.auditEvent.count();
    await execute(command({
      type: 'REVISE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207', expectedVersion: 1,
      expectedCurrentRevisionId: 'hypothesis-revision-207', nextReviewAt: '2026-10-01T00:00:00.000Z',
      revision: {
        id: 'revision-current-207', claim: '进入最终审批', reason: '收到议程',
        expectedSignals: ['收到批复'], falsificationConditions: ['议程取消'],
      },
    }));
    const suggestion = await salesHypothesisStatusSuggestion(test.prisma, ctx, policy, 'hypothesis-207');
    expect(suggestion).toMatchObject({
      hypothesisRevisionId: 'revision-current-207', suggestedStatus: null, reasonCode: 'no_evidence',
      evidenceRefs: [],
    });
    expect(JSON.stringify(suggestion)).not.toContain('董事会纪要原文');
    expect(await test.prisma.auditEvent.count()).toBe(auditBefore + 1);
    const list = await listSalesHypotheses(test.prisma, ctx, policy, SalesHypothesisListQuerySchema.parse({
      customerId, matterId,
    }));
    expect(list).toMatchObject({ items: [{ id: 'hypothesis-207', currentRevisionId: 'revision-current-207' }] });
    const detail = await salesHypothesisDetail(
      test.prisma, ctx, policy, 'hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    );
    expect(detail).toMatchObject({
      revisions: [
        { revision: { id: 'revision-current-207', revisionNumber: 2 }, evidenceLinks: [] },
        { revision: { id: 'hypothesis-revision-207', revisionNumber: 1 }, evidenceLinks: [{ id: 'link-support' }] },
      ],
      nextRevisionBefore: null,
    });
  });

  it('reloads current role: viewer can read only owned customers and can never write', async () => {
    await execute(createCommand());
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    await expect(salesHypothesisDetail(
      test.prisma, ctx, policy, 'hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    )).resolves.toMatchObject({ item: { id: 'hypothesis-207' } });
    await expect(execute(command({
      type: 'SET_SALES_HYPOTHESIS_STATUS', salesHypothesisId: 'hypothesis-207',
      expectedVersion: 0, status: 'supported',
    }))).rejects.toMatchObject({ code: 'viewer_write_denied', statusCode: 403 });
    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await expect(salesHypothesisDetail(
      test.prisma, ctx, policy, 'hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    )).resolves.toBeNull();
    await expect(listSalesHypotheses(test.prisma, ctx, policy, SalesHypothesisListQuerySchema.parse({
      customerId, matterId,
    }))).rejects.toMatchObject({ scopedNotFound: true });
  });

  it('does not create, read, suggest or mutate through cross-tenant direct IDs', async () => {
    const foreignTenant = await test.prisma.tenant.create({ data: {
      id: 'foreign-tenant-207', name: 'Foreign hypothesis tenant',
    } });
    const foreignUser = await test.prisma.user.create({ data: {
      tenantId: foreignTenant.id, email: 'foreign-hypothesis@example.test',
      passwordHash: 'unused', name: 'Foreign Owner', role: 'owner',
    } });
    await test.prisma.account.create({ data: {
      id: 'foreign-customer-207', tenantId: foreignTenant.id, name: 'Foreign customer',
      primaryOwnerUserId: foreignUser.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'foreign-matter-207', tenantId: foreignTenant.id, accountId: 'foreign-customer-207',
      name: 'Foreign matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: foreignUser.id,
    } });
    await test.prisma.salesHypothesis.create({ data: {
      id: 'foreign-hypothesis-207', tenantId: foreignTenant.id,
      customerId: 'foreign-customer-207', matterId: 'foreign-matter-207',
      status: 'untested', ownerUserId: foreignUser.id,
      nextReviewAt: new Date('2099-09-15T00:00:00.000Z'),
      currentRevisionId: 'foreign-revision-207', createdByUserId: foreignUser.id,
    } });
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: 'foreign-revision-207', tenantId: foreignTenant.id,
      hypothesisId: 'foreign-hypothesis-207', revisionNumber: 1,
      claim: 'Foreign claim', reason: 'Foreign reason',
      expectedSignals: '["Foreign signal"]',
      falsificationConditions: '["Foreign falsification"]',
      createdByUserId: foreignUser.id,
    } });

    const crossCreate = createCommand('cross-create-207', 'cross-revision-207');
    if (crossCreate.type !== 'CREATE_SALES_HYPOTHESIS') throw new Error('fixture');
    crossCreate.hypothesis.customerId = 'foreign-customer-207';
    crossCreate.hypothesis.matterId = 'foreign-matter-207';
    crossCreate.hypothesis.personId = null;
    await expect(execute(crossCreate)).rejects.toMatchObject({ scopedNotFound: true });
    await expect(salesHypothesisDetail(
      test.prisma, ctx, policy, 'foreign-hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    )).resolves.toBeNull();
    await expect(salesHypothesisStatusSuggestion(
      test.prisma, ctx, policy, 'foreign-hypothesis-207',
    )).resolves.toBeNull();
    await expect(execute(command({
      type: 'SET_SALES_HYPOTHESIS_STATUS', salesHypothesisId: 'foreign-hypothesis-207',
      expectedVersion: 0, status: 'supported',
    }))).rejects.toMatchObject({ scopedNotFound: true });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({
      where: { id: 'foreign-hypothesis-207' },
    })).resolves.toMatchObject({ status: 'untested', version: 0 });
    expect(await test.prisma.salesHypothesis.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('fails closed on corrupted current pointers and structured history', async () => {
    await execute(createCommand());
    await test.prisma.salesHypothesis.update({
      where: { id: 'hypothesis-207' }, data: { currentRevisionId: 'missing-revision' },
    });
    await expect(salesHypothesisDetail(
      test.prisma, ctx, policy, 'hypothesis-207', SalesHypothesisDetailQuerySchema.parse({}),
    )).rejects.toMatchObject({ code: 'sales_hypothesis_storage_invalid' });
    await test.prisma.salesHypothesis.update({
      where: { id: 'hypothesis-207' }, data: { currentRevisionId: 'hypothesis-revision-207' },
    });
    await test.prisma.salesHypothesisRevision.update({
      where: { id: 'hypothesis-revision-207' }, data: { expectedSignals: '[ "not canonical" ]' },
    });
    await expect(salesHypothesisStatusSuggestion(test.prisma, ctx, policy, 'hypothesis-207'))
      .rejects.toMatchObject({ code: 'sales_hypothesis_storage_invalid' });
  });
});
