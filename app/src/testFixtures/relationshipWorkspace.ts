import {
  RelationshipWorkspaceResponseSchema,
  type RelationshipWorkspaceResponse,
} from '@jianghu/domain-contracts';

export const RELATIONSHIP_WORKSPACE_FIXTURE: RelationshipWorkspaceResponse = RelationshipWorkspaceResponseSchema.parse({
  generatedAtUtc: '2026-09-01T12:00:00.000Z',
  customer: {
    id: 'customer-208', name: '远山制造', categoryKey: 'enterprise',
    primaryOwnerUserId: 'owner-208', archivedAt: null, version: 0,
  },
  matter: {
    id: 'matter-208', customerId: 'customer-208', title: '技术升级项目', kind: 'complex_sale',
    lifecycleStatus: 'active', outcomeKey: null, priority: 'high', targetDate: '2026-10-01',
    primaryOwnerUserId: 'owner-208', archivedAt: null, version: 0,
  },
  people: [
    { id: 'person-a-208', customerId: 'customer-208', name: '王主任', title: '实施负责人', archivedAt: null, version: 0 },
    { id: 'person-b-208', customerId: 'customer-208', name: '李经理', title: '技术经理', archivedAt: null, version: 0 },
  ],
  formalRelations: [{
    id: 'relation-208', customerId: 'customer-208', matterId: 'matter-208',
    sourcePersonId: 'person-a-208', targetPersonId: 'person-b-208', kind: 'influences',
    label: '推动', directed: true, version: 0, rendering: 'solid',
  }],
  candidateRelations: [{
    candidateId: 'candidate-relation-208', reviewBatchId: 'batch-208', sourceArtifactId: 'source-208',
    sourceEndpoint: { kind: 'person', personId: 'person-a-208', label: '王主任', title: '实施负责人' },
    targetEndpoint: {
      kind: 'candidate_person', candidateId: 'candidate-person-208', itemRef: 'item-001',
      label: '赵经理', title: '采购经理',
    },
    layer: 'L2', label: '可能影响', directed: true, confidence: 0.72,
    source: {
      artifactKind: 'note', title: '技术沟通纪要', externalRef: null,
      occurredAtUtc: '2026-08-31T07:00:00.000Z', locator: 'item-002:chars:11-40',
      quote: '王主任表示会邀请赵经理参与评审',
    },
    candidateCreatedAtUtc: '2026-08-31T08:00:00.000Z', rendering: 'muted_dashed_question',
  }],
  intelligence: [{
    id: 'intelligence-208', customerId: 'customer-208', matterId: 'matter-208',
    assertionType: 'reported', statement: '客户计划下周进行技术评审',
    source: { kind: 'manual', description: '人工会后记录', refId: null, refVersion: null },
    occurredAt: '2026-08-31T07:00:00.000Z', learnedAt: '2026-08-31T08:00:00.000Z',
    confidence: 0.8, targets: [{ kind: 'person', id: 'person-a-208' }], status: 'active',
    createdByUserId: 'owner-208', version: 0,
    createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T08:00:00.000Z',
  }],
  focus: {
    id: 'focus-208', customerId: 'customer-208', matterId: 'matter-208', personId: 'person-a-208',
    desiredChange: '推动安排技术评审', rationale: '实施风险是当前核心不确定性',
    evidenceGap: '尚未确认评审时间', basisRefs: [], validUntil: '2026-09-08T12:00:00.000Z',
    status: 'active', confirmedByUserId: 'owner-208', confirmedAt: '2026-08-31T10:00:00.000Z',
    retiredByUserId: null, retiredAt: null, version: 0,
    createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
  },
  hypotheses: [{
    hypothesis: {
      id: 'hypothesis-208', customerId: 'customer-208', matterId: 'matter-208', personId: 'person-a-208',
      status: 'testing', ownerUserId: 'owner-208', nextReviewAt: '2026-09-08T12:00:00.000Z',
      currentRevisionId: 'revision-208', currentRevision: {
        id: 'revision-208', revisionNumber: 1, claim: '客户会安排技术评审',
        reason: '王主任控制排期', expectedSignals: ['收到评审邀请'],
        falsificationConditions: ['明确拒绝评审'], origin: 'user',
        createdByUserId: 'owner-208', createdAt: '2026-08-31T08:00:00.000Z',
      },
      legacyStrategyRiskId: null, createdByUserId: 'owner-208',
      statusConfirmedByUserId: 'owner-208', statusConfirmedAt: '2026-08-31T10:00:00.000Z',
      version: 0, createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    },
    evidenceLinks: [],
    verificationCommitments: [{
      commitment: {
        id: 'commitment_00000000000000000000000000000208', customerId: 'customer-208',
        matterId: 'matter-208', personId: 'person-a-208', title: '确认评审时间',
        kind: 'verification', ownerUserId: 'owner-208', executionStatus: 'completed',
        confirmationStatus: 'not_required', scheduledAtUtc: '2026-09-01T08:00:00.000Z', dueAtUtc: null,
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null, confirmationDueAtUtc: null,
        confirmedAtUtc: null, confirmedByUserId: null, scheduleVersion: 0, nextCommitmentId: null,
        source: 'manual', sourceRef: null, archivedAt: null, version: 1,
        hypothesisId: 'hypothesis-208', hypothesisRevisionId: 'revision-208',
        completionResult: '客户已同意安排评审',
        completionResultRecordedAtUtc: '2026-09-01T10:00:00.000Z',
        completionResultRecordedByUserId: 'owner-208', verificationReviewDisposition: null,
        verificationReviewedAtUtc: null, verificationReviewedByUserId: null,
      },
      linkedEvidenceIds: [], readiness: 'ready_for_review',
    }],
    rendering: 'dotted_annotation',
  }],
});
