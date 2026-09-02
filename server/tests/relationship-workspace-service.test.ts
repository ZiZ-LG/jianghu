import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RelationshipWorkspaceQuerySchema,
  ReviewHypothesisVerificationCommandSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import {
  relationshipWorkspace,
  executeHypothesisVerificationReview,
  RelationshipWorkspaceError,
} from '../src/relationshipWorkspace/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
const now = new Date('2026-09-01T12:00:00.000Z');

describe('SAAS-208 relationship workspace projection', () => {
  let test: TestContext;
  let ctx: CommandContext;
  const customerId = 'workspace-customer-208';
  const matterId = 'workspace-matter-208';
  const personA = 'workspace-person-a-208';
  const personB = 'workspace-person-b-208';
  const hypothesisId = 'workspace-hypothesis-208';
  const revisionId = 'workspace-revision-208';
  const commitmentId = 'workspace-commitment-208';

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
      id: customerId, tenantId: test.tenant.id, name: '工作台客户',
      categoryKey: 'enterprise', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '工作台事项',
      kind: 'complex_sale', lifecycleStatus: 'active', customerType: 1,
      pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.createMany({ data: [
      { id: personA, tenantId: test.tenant.id, accountId: customerId, name: '王主任', title: '实施负责人' },
      { id: personB, tenantId: test.tenant.id, accountId: customerId, name: '李经理', title: '技术经理' },
    ] });
    await test.prisma.matterParticipant.createMany({ data: [
      { id: 'participant-a-208', tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId: personA },
      { id: 'participant-b-208', tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId: personB },
    ] });
    await test.prisma.edge.create({ data: {
      id: 'workspace-edge-208', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, source: personA, target: personB,
      kind: 'influences', layer: 'L2', label: '推动', directed: true,
    } });
    await test.prisma.intelligenceItem.create({ data: {
      id: 'workspace-intelligence-208', tenantId: test.tenant.id, customerId, matterId,
      assertionType: 'reported', statement: '客户下周安排技术评审',
      sourceKind: 'manual', sourceDescription: '人工会后记录',
      occurredAt: new Date('2026-08-31T08:00:00.000Z'), learnedAt: new Date('2026-08-31T09:00:00.000Z'),
      confidence: 0.8, targetRefs: JSON.stringify([{ kind: 'person', id: personA }]),
      createdByUserId: test.owner.id,
      createdAt: new Date('2026-08-31T09:00:00.000Z'),
      updatedAt: new Date('2026-08-31T09:00:00.000Z'),
    } });
    await test.prisma.stakeholderFocus.create({ data: {
      id: 'workspace-focus-208', tenantId: test.tenant.id, customerId, matterId, personId: personA,
      desiredChange: '推动安排评审', rationale: '实施风险待确认', evidenceGap: '缺少准确时间',
      basisRefs: '[]', validUntil: new Date('2026-09-08T12:00:00.000Z'),
      activeMatterKey: matterId, confirmedByUserId: test.owner.id,
      confirmedAt: new Date('2026-08-31T10:00:00.000Z'),
      createdAt: new Date('2026-08-31T10:00:00.000Z'),
      updatedAt: new Date('2026-08-31T10:00:00.000Z'),
    } });
    await test.prisma.salesHypothesis.create({ data: {
      id: hypothesisId, tenantId: test.tenant.id, customerId, matterId, personId: personA,
      status: 'testing', ownerUserId: test.owner.id,
      nextReviewAt: new Date('2026-09-08T12:00:00.000Z'), currentRevisionId: revisionId,
      createdByUserId: test.owner.id, statusConfirmedByUserId: test.owner.id,
      statusConfirmedAt: new Date('2026-08-31T10:00:00.000Z'),
      createdAt: new Date('2026-08-31T08:00:00.000Z'),
      updatedAt: new Date('2026-08-31T10:00:00.000Z'),
    } });
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: revisionId, tenantId: test.tenant.id, hypothesisId, revisionNumber: 1,
      claim: '客户会安排技术评审', reason: '王主任控制排期',
      expectedSignals: '["收到评审邀请"]', falsificationConditions: '["明确拒绝评审"]',
      origin: 'user', createdByUserId: test.owner.id,
      createdAt: new Date('2026-08-31T08:00:00.000Z'),
    } });
    await test.prisma.planAction.create({ data: {
      id: commitmentId, tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId,
      personId: personA, title: '确认评审时间', ownerId: test.owner.id, ownerUserId: test.owner.id,
      kind: 'verification', executionStatus: 'completed', done: true, doneAt: '2026-09-01',
      isAllDay: false, scheduledAtUtc: new Date('2026-09-01T08:00:00.000Z'), localDate: null,
      hypothesisId, hypothesisRevisionId: revisionId,
      completionResult: '客户已同意安排评审', completionResultRecordedAtUtc: now,
      completionResultRecordedByUserId: test.owner.id,
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'workspace-evidence-208', tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, personId: personA, signalKey: 'review_scheduled', direction: 1,
      rawContent: '证据原文不得进工作台', occurredAt: '2026-09-01T10:00:00.000Z',
      status: 'approved', origin: 'manual', createdBy: test.owner.id,
    } });
    await test.prisma.hypothesisEvidenceLink.create({ data: {
      id: 'workspace-link-208', tenantId: test.tenant.id, hypothesisId,
      hypothesisRevisionId: revisionId, evidenceId: 'workspace-evidence-208',
      direction: 'supporting', verificationCommitmentId: commitmentId,
      linkedByUserId: test.owner.id, linkedAt: now,
    } });
  });

  afterEach(async () => test.cleanup());

  const query = () => RelationshipWorkspaceQuerySchema.parse({ customerId, matterId });

  async function seedCandidateBatch() {
    const sourceArtifactId = 'workspace-source-208';
    const batchId = 'workspace-batch-208';
    const personSuggestionId = 'workspace-person-suggestion-208';
    await test.prisma.sourceArtifact.create({ data: {
      id: sourceArtifactId, tenantId: test.tenant.id, accountId: customerId, matterId,
      backingKind: 'note', backingId: 'workspace-note-208', artifactKind: 'note',
      source: 'post_meeting_extract', idempotencyDomain: `creator-private-v1:${JSON.stringify(test.owner.id)}`,
      title: '技术沟通纪要', occurredAt: new Date('2026-08-31T07:00:00.000Z'),
      fingerprintKind: 'content_sha256_v1', sourceFingerprint: 'a'.repeat(64),
      retentionState: 'available', retentionUpdatedAt: now,
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await test.prisma.reviewBatch.create({ data: {
      id: batchId, tenantId: test.tenant.id, sourceArtifactId, accountId: customerId, matterId,
      status: 'pending', createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });
    await test.prisma.personSuggestion.create({ data: {
      id: personSuggestionId, tenantId: test.tenant.id, accountId: customerId,
      opportunityId: matterId, name: '赵经理', title: '采购经理', origin: 'post_meeting_extract',
      evidence: '会议中提及赵经理', confidence: 0.72,
    } });
    await test.prisma.relSuggestion.create({ data: {
      id: 'workspace-rel-suggestion-208', tenantId: test.tenant.id, opportunityId: matterId,
      sourcePersonId: personA, targetPersonId: personSuggestionId,
      sourceKind: 'person', targetKind: 'suggestion', layer: 'L2', label: '可能影响',
      origin: 'post_meeting_extract', evidence: '王主任表示会邀请赵经理参与评审', confidence: 0.72,
    } });
    await test.prisma.candidate.createMany({ data: [
      {
        id: 'workspace-person-candidate-208', tenantId: test.tenant.id, kind: 'person_create',
        accountId: customerId, matterId, targetKind: 'person', targetId: null,
        source: 'post_meeting_extract', sourceRef: 'post-meeting:run208@item-001:chars:0-10',
        evidence: '会议中提及赵经理', confidence: 0.72, sourceArtifactId, reviewBatchId: batchId,
        createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
        dedupeKey: 'workspace-person-candidate-dedupe-208',
        legacySourceKind: 'PersonSuggestion', legacySourceId: personSuggestionId,
      },
      {
        id: 'workspace-relation-candidate-208', tenantId: test.tenant.id, kind: 'relation_create',
        accountId: customerId, matterId, targetKind: 'relation', targetId: null,
        source: 'post_meeting_extract', sourceRef: 'post-meeting:run208@item-002:chars:11-40',
        evidence: '王主任表示会邀请赵经理参与评审', confidence: 0.72,
        sourceArtifactId, reviewBatchId: batchId, createdByUserId: test.owner.id,
        visibility: 'private', aclVersion: 1, dedupeKey: 'workspace-relation-candidate-dedupe-208',
        legacySourceKind: 'RelSuggestion', legacySourceId: 'workspace-rel-suggestion-208',
      },
    ] });
    return { sourceArtifactId };
  }

  it('assembles exact formal, intelligence, focus and hypothesis layers without writes', async () => {
    const countsBefore = await Promise.all([
      test.prisma.auditEvent.count(), test.prisma.commandRun.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.stakeholderFocus.count(),
      test.prisma.salesHypothesisRevision.count(), test.prisma.planAction.count(),
    ]);
    const view = await relationshipWorkspace(test.prisma, ctx, policy, query(), now);
    expect(view).toMatchObject({
      customer: { id: customerId, categoryKey: 'enterprise' },
      matter: { id: matterId, customerId },
      people: [{ id: personA }, { id: personB }],
      formalRelations: [{ id: 'workspace-edge-208', rendering: 'solid' }],
      candidateRelations: [],
      intelligence: [{
        id: 'workspace-intelligence-208', assertionType: 'reported', confidence: 0.8,
        source: { kind: 'manual', description: '人工会后记录' },
      }],
      focus: { id: 'workspace-focus-208', personId: personA, status: 'active' },
      hypotheses: [{
        hypothesis: { id: hypothesisId, currentRevision: {
          expectedSignals: ['收到评审邀请'], falsificationConditions: ['明确拒绝评审'],
        } },
        evidenceLinks: [{ id: 'workspace-link-208', verificationCommitmentId: commitmentId }],
        verificationCommitments: [{
          commitment: { id: commitmentId, completionResult: '客户已同意安排评审' },
          linkedEvidenceIds: ['workspace-evidence-208'], readiness: 'ready_for_review',
        }],
        rendering: 'dotted_annotation',
      }],
    });
    expect(JSON.stringify(view)).not.toContain('证据原文不得进工作台');
    expect(await Promise.all([
      test.prisma.auditEvent.count(), test.prisma.commandRun.count(), test.prisma.edge.count(),
      test.prisma.evidenceEvent.count(), test.prisma.stakeholderFocus.count(),
      test.prisma.salesHypothesisRevision.count(), test.prisma.planAction.count(),
    ])).toEqual(countsBefore);
  });

  it('shows only authorized pending relation candidates and drops a revoked branch fail-closed', async () => {
    const { sourceArtifactId } = await seedCandidateBatch();
    const view = await relationshipWorkspace(test.prisma, ctx, policy, query(), now);
    expect(view.candidateRelations).toMatchObject([{
      candidateId: 'workspace-relation-candidate-208',
      sourceEndpoint: { kind: 'person', personId: personA, label: '王主任' },
      targetEndpoint: {
        kind: 'candidate_person', candidateId: 'workspace-person-candidate-208',
        itemRef: 'item-001', label: '赵经理', title: '采购经理',
      },
      layer: 'L2', label: '可能影响', confidence: 0.72,
      rendering: 'muted_dashed_question',
      source: { title: '技术沟通纪要', locator: 'item-002:chars:11-40' },
    }]);

    await test.prisma.sourceArtifact.update({ where: { id: sourceArtifactId }, data: { aclVersion: 2 } });
    const revoked = await relationshipWorkspace(test.prisma, ctx, policy, query(), now);
    expect(revoked.candidateRelations).toEqual([]);
    expect(revoked.formalRelations).toHaveLength(1);
    expect(revoked.hypotheses).toHaveLength(1);
  });

  it('reloads viewer ownership and fails closed on corrupt formal relation closure', async () => {
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const owned = await relationshipWorkspace(test.prisma, ctx, policy, query(), now);
    expect(owned.customer.id).toBe(customerId);
    expect(owned.candidateRelations).toEqual([]);
    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await expect(relationshipWorkspace(test.prisma, ctx, policy, query(), now))
      .rejects.toBeInstanceOf(RelationshipWorkspaceError);

    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'owner' } });
    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: test.owner.id } });
    await test.prisma.edge.update({ where: { id: 'workspace-edge-208' }, data: { target: 'missing-person' } });
    await expect(relationshipWorkspace(test.prisma, ctx, policy, query(), now))
      .rejects.toMatchObject({ code: 'relationship_workspace_storage_invalid' });
  });

  it('keeps one verified hypothesis atomically with body-free receipt and audits', async () => {
    const command = ReviewHypothesisVerificationCommandSchema.parse({
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', disposition: 'keep',
      customerId, matterId, commitmentId, salesHypothesisId: hypothesisId,
      expectedCommitmentVersion: 0, expectedCommitmentScheduleVersion: 0,
      expectedHypothesisVersion: 0, expectedCurrentRevisionId: revisionId,
      ownerUserId: test.owner.id, nextReviewAt: '2026-09-15T12:00:00.000Z',
    });
    const result = await test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, command, now)
    ));
    expect(result).toEqual({
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', customerId, matterId, commitmentId,
      salesHypothesisId: hypothesisId, previousRevisionId: revisionId,
      currentRevisionId: revisionId, disposition: 'kept',
      commitmentVersion: 1, hypothesisVersion: 1, undoable: false,
    });
    await expect(test.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } }))
      .resolves.toMatchObject({
        verificationReviewDisposition: 'kept', verificationReviewedAtUtc: now,
        verificationReviewedByUserId: test.owner.id, version: 1,
      });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } }))
      .resolves.toMatchObject({
        currentRevisionId: revisionId, status: 'testing', ownerUserId: test.owner.id,
        nextReviewAt: new Date('2026-09-15T12:00:00.000Z'), version: 1,
      });
    const audits = await test.prisma.auditEvent.findMany({
      where: { tenantId: test.tenant.id, OR: [{ entityId: commitmentId }, { entityId: hypothesisId }] },
      orderBy: { action: 'asc' },
    });
    expect(audits.map((audit) => audit.action)).toEqual([
      'hypothesis_verification_reviewed', 'sales_hypothesis_review_update',
    ]);
    expect(JSON.stringify(audits)).not.toContain('客户已同意安排评审');
    expect(JSON.stringify(audits)).not.toContain('客户会安排技术评审');
  });

  it('revises append-only or retires only through explicit human dispositions', async () => {
    const revise = ReviewHypothesisVerificationCommandSchema.parse({
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', disposition: 'revise',
      customerId, matterId, commitmentId, salesHypothesisId: hypothesisId,
      expectedCommitmentVersion: 0, expectedCommitmentScheduleVersion: 0,
      expectedHypothesisVersion: 0, expectedCurrentRevisionId: revisionId,
      nextReviewAt: '2026-09-15T12:00:00.000Z',
      revision: {
        id: 'workspace-revision-208-v2', claim: '客户将先安排小范围评审',
        reason: '本次验证结果改变了时间预期', expectedSignals: ['收到小组会议邀请'],
        falsificationConditions: ['小组会议被取消'],
      },
    });
    const oldRevision = await test.prisma.salesHypothesisRevision.findUniqueOrThrow({ where: { id: revisionId } });
    await expect(test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, revise, now)
    ))).resolves.toMatchObject({
      disposition: 'revised', previousRevisionId: revisionId,
      currentRevisionId: 'workspace-revision-208-v2', commitmentVersion: 1, hypothesisVersion: 1,
    });
    expect(await test.prisma.salesHypothesisRevision.findUniqueOrThrow({ where: { id: revisionId } }))
      .toEqual(oldRevision);
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } }))
      .resolves.toMatchObject({
        currentRevisionId: 'workspace-revision-208-v2', status: 'untested', version: 1,
      });
    await expect(test.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } }))
      .resolves.toMatchObject({ verificationReviewDisposition: 'revised' });
  });

  it('retires explicitly and rejects missing proof, stale CAS, or a second review with rollback', async () => {
    const retire = ReviewHypothesisVerificationCommandSchema.parse({
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', disposition: 'retire',
      customerId, matterId, commitmentId, salesHypothesisId: hypothesisId,
      expectedCommitmentVersion: 0, expectedCommitmentScheduleVersion: 0,
      expectedHypothesisVersion: 0, expectedCurrentRevisionId: revisionId,
    });
    await test.prisma.planAction.update({ where: { id: commitmentId }, data: {
      completionResult: '', completionResultRecordedAtUtc: null, completionResultRecordedByUserId: null,
    } });
    await test.prisma.hypothesisEvidenceLink.deleteMany({ where: { verificationCommitmentId: commitmentId } });
    await expect(test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, retire, now)
    ))).rejects.toMatchObject({ code: 'hypothesis_verification_proof_required' });
    expect(await test.prisma.auditEvent.count()).toBe(0);
    await test.prisma.planAction.update({ where: { id: commitmentId }, data: {
      completionResult: '客户明确取消评审', completionResultRecordedAtUtc: now,
      completionResultRecordedByUserId: test.owner.id,
    } });
    await expect(test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, { ...retire, expectedHypothesisVersion: 9 }, now)
    ))).rejects.toMatchObject({ code: 'hypothesis_verification_version_conflict' });
    await expect(test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, retire, now)
    ))).resolves.toMatchObject({ disposition: 'retired', hypothesisVersion: 1, commitmentVersion: 1 });
    await expect(test.prisma.salesHypothesis.findUniqueOrThrow({ where: { id: hypothesisId } }))
      .resolves.toMatchObject({ status: 'retired', version: 1 });
    await expect(test.prisma.$transaction((tx) => (
      executeHypothesisVerificationReview(tx, ctx, policy, {
        ...retire, expectedCommitmentVersion: 1, expectedHypothesisVersion: 1,
      }, now)
    ))).rejects.toMatchObject({ code: 'hypothesis_verification_already_reviewed' });
    expect(await test.prisma.salesHypothesisRevision.count()).toBe(1);
  });

  it('serves a no-store read route and reauthorizes body-free review replay', async () => {
    const read = await test.app.inject({
      method: 'GET',
      url: `/api/relationship-workspace?customerId=${customerId}&matterId=${matterId}`,
      headers: { authorization: `Bearer ${test.token}` },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.json()).toMatchObject({ customer: { id: customerId }, matter: { id: matterId } });

    const payload = {
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', disposition: 'keep',
      customerId, matterId, commitmentId, salesHypothesisId: hypothesisId,
      expectedCommitmentVersion: 0, expectedCommitmentScheduleVersion: 0,
      expectedHypothesisVersion: 0, expectedCurrentRevisionId: revisionId,
      ownerUserId: test.owner.id, nextReviewAt: '2026-09-15T12:00:00.000Z',
    };
    const send = () => test.app.inject({
      method: 'POST', url: '/api/commands/hypothesis-verification-review',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'workspace-review-replay-208',
      },
      payload,
    });
    const first = await send();
    const replay = await send();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      disposition: 'kept', commitmentVersion: 1, hypothesisVersion: 1, replayed: false,
    });
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(first.body).not.toContain('客户已同意安排评审');
    expect(await test.prisma.commandRun.count()).toBe(1);

    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const deniedReplay = await send();
    expect(deniedReplay.statusCode).toBe(403);
    expect(deniedReplay.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(await test.prisma.commandRun.count()).toBe(1);
  });

  it('blocks viewer review before CommandRun or AuditEvent writes', async () => {
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const response = await test.app.inject({
      method: 'POST', url: '/api/commands/hypothesis-verification-review',
      headers: {
        authorization: `Bearer ${test.token}`,
        'idempotency-key': 'workspace-viewer-denied-208',
      },
      payload: {
        type: 'REVIEW_HYPOTHESIS_VERIFICATION', disposition: 'retire',
        customerId, matterId, commitmentId, salesHypothesisId: hypothesisId,
        expectedCommitmentVersion: 0, expectedCommitmentScheduleVersion: 0,
        expectedHypothesisVersion: 0, expectedCurrentRevisionId: revisionId,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(await test.prisma.commandRun.count()).toBe(0);
    expect(await test.prisma.auditEvent.count()).toBe(0);
  });
});
