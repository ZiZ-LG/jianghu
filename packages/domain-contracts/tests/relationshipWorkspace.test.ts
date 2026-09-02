import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean; data?: unknown };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const customer = {
  id: 'customer-208', name: '远山制造', categoryKey: 'strategic',
  primaryOwnerUserId: 'user-208', archivedAt: null, version: 2,
};

const matter = {
  id: 'matter-208', customerId: customer.id, title: '设备升级', kind: 'sales_opportunity',
  lifecycleStatus: 'active', outcomeKey: null, priority: 'important', targetDate: '2026-10-01',
  primaryOwnerUserId: 'user-208', archivedAt: null, version: 3,
};

const people = [{
  id: 'person-208-a', customerId: customer.id, name: '王主任', title: '实施负责人',
  archivedAt: null, version: 1,
}, {
  id: 'person-208-b', customerId: customer.id, name: '李总', title: '决策人',
  archivedAt: null, version: 1,
}];

const revisionInput = {
  id: 'revision-208-1',
  claim: '若实施风险得到澄清，王主任会推动李总立项',
  reason: '王主任负责实施风险评估',
  expectedSignals: ['王主任主动安排技术评审'],
  falsificationConditions: ['王主任明确拒绝安排技术评审'],
};

const hypothesis = {
  id: 'hypothesis-208', customerId: customer.id, matterId: matter.id,
  personId: people[0]!.id, status: 'testing', ownerUserId: 'user-208',
  nextReviewAt: '2026-09-08T08:00:00.000Z', currentRevisionId: revisionInput.id,
  currentRevision: {
    ...revisionInput, revisionNumber: 1, origin: 'user', createdByUserId: 'user-208',
    createdAt: '2026-08-31T08:00:00.000Z',
  },
  legacyStrategyRiskId: null, createdByUserId: 'user-208',
  statusConfirmedByUserId: 'user-208', statusConfirmedAt: '2026-08-31T08:01:00.000Z',
  version: 2, createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T08:02:00.000Z',
};

const verificationCommitment = {
  id: 'commitment_00000000000000000000000000000208',
  customerId: customer.id, matterId: matter.id, personId: people[0]!.id,
  title: '确认王主任是否安排技术评审', kind: 'verification', ownerUserId: 'user-208',
  executionStatus: 'completed', confirmationStatus: 'not_required',
  scheduledAtUtc: '2026-09-01T08:00:00.000Z', dueAtUtc: null,
  timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
  confirmationDueAtUtc: null, confirmedAtUtc: null, confirmedByUserId: null,
  scheduleVersion: 0, nextCommitmentId: null, source: 'manual', sourceRef: null,
  archivedAt: null, version: 1,
  hypothesisId: hypothesis.id, hypothesisRevisionId: revisionInput.id,
  completionResult: '客户已同意安排评审',
  completionResultRecordedAtUtc: '2026-09-01T10:00:00.000Z',
  completionResultRecordedByUserId: 'user-208',
  verificationReviewDisposition: null,
  verificationReviewedAtUtc: null,
  verificationReviewedByUserId: null,
};

const workspace = {
  generatedAtUtc: '2026-09-01T10:01:00.000Z',
  customer,
  matter,
  people,
  formalRelations: [{
    id: 'relation-208', customerId: customer.id, matterId: matter.id,
    sourcePersonId: people[0]!.id, targetPersonId: people[1]!.id,
    kind: 'influences', label: '推动', directed: true, version: 1,
    rendering: 'solid',
  }],
  candidateRelations: [{
    candidateId: 'candidate-208', reviewBatchId: 'review-batch-208',
    sourceArtifactId: 'artifact-208',
    sourceEndpoint: { kind: 'person', personId: people[0]!.id, label: '王主任', title: '实施负责人' },
    targetEndpoint: {
      kind: 'candidate_person', candidateId: 'candidate-person-208', itemRef: 'person-002',
      label: '赵经理', title: null,
    },
    layer: 'L2', label: '可能影响', directed: true, confidence: 0.72,
    source: {
      artifactKind: 'transcript', title: '技术沟通纪要', externalRef: 'meeting-208',
      occurredAtUtc: '2026-08-31T07:00:00.000Z', locator: 'item-003:chars:10-28',
      quote: '王主任表示会邀请赵经理参与技术评审',
    },
    candidateCreatedAtUtc: '2026-08-31T08:05:00.000Z',
    rendering: 'muted_dashed_question',
  }],
  intelligence: [{
    id: 'intelligence-208', customerId: customer.id, matterId: matter.id,
    assertionType: 'reported', statement: '客户计划下周进行技术评审',
    source: { kind: 'interaction', description: '技术沟通纪要', refId: 'interaction-208', refVersion: 0 },
    occurredAt: '2026-08-31T07:00:00.000Z', learnedAt: '2026-08-31T08:00:00.000Z',
    confidence: 0.8, targets: [{ kind: 'person', id: people[0]!.id }], status: 'active',
    createdByUserId: 'user-208', version: 0,
    createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T08:00:00.000Z',
  }],
  focus: {
    id: 'focus-208', customerId: customer.id, matterId: matter.id, personId: people[0]!.id,
    desiredChange: '推动安排技术评审', rationale: '实施风险是当前核心不确定性',
    evidenceGap: '尚未确认评审时间', basisRefs: [], validUntil: '2026-09-08T08:00:00.000Z',
    status: 'active', confirmedByUserId: 'user-208', confirmedAt: '2026-08-31T08:00:00.000Z',
    retiredByUserId: null, retiredAt: null, version: 0,
    createdAt: '2026-08-31T08:00:00.000Z', updatedAt: '2026-08-31T08:00:00.000Z',
  },
  hypotheses: [{
    hypothesis,
    evidenceLinks: [],
    verificationCommitments: [{
      commitment: verificationCommitment,
      linkedEvidenceIds: [],
      readiness: 'ready_for_review',
    }],
  }],
};

describe('SAAS-208 relationship workspace contracts', () => {
  it('exports one strict projection and standalone human review command', () => {
    for (const name of [
      'RelationshipWorkspaceQuerySchema',
      'RelationshipWorkspaceResponseSchema',
      'RelationshipCandidateEndpointSchema',
      'RelationshipVerificationReadinessSchema',
      'ReviewHypothesisVerificationCommandSchema',
      'ReviewHypothesisVerificationReceiptSchema',
    ]) {
      expect(schema(name), `${name} must be exported`).toBeDefined();
    }
  });

  it('accepts the three explicit visual layers and rejects invented scoring fields', () => {
    const response = schema('RelationshipWorkspaceResponseSchema')!;
    expect(response.safeParse(workspace).success).toBe(true);
    expect(response.safeParse({ ...workspace, relationshipRiskScore: 86 }).success).toBe(false);
    expect(response.safeParse({
      ...workspace,
      formalRelations: [{ ...workspace.formalRelations[0], rendering: 'dashed' }],
    }).success).toBe(false);
    expect(response.safeParse({
      ...workspace,
      candidateRelations: [{ ...workspace.candidateRelations[0], rendering: 'solid' }],
    }).success).toBe(false);
  });

  it('preserves intelligence provenance and fails closed on broken graph references', () => {
    const response = schema('RelationshipWorkspaceResponseSchema')!;
    expect(response.safeParse({
      ...workspace,
      intelligence: [{ ...workspace.intelligence[0], assertionType: 'evidence' }],
    }).success).toBe(false);
    expect(response.safeParse({
      ...workspace,
      formalRelations: [{ ...workspace.formalRelations[0], sourcePersonId: 'missing-person' }],
    }).success).toBe(false);
    expect(response.safeParse({
      ...workspace,
      hypotheses: [{ ...workspace.hypotheses[0], hypothesis: { ...hypothesis, personId: 'missing-person' } }],
    }).success).toBe(false);
    expect(response.safeParse({
      ...workspace,
      intelligence: [{ ...workspace.intelligence[0], sourceQuote: 'not-authoritative' }],
    }).success).toBe(false);
  });

  it('locks exact verification links, result capture and Quick Capture isolation', () => {
    const crm = schema('CrmCommandSchema')!;
    const create = {
      type: 'CREATE_COMMITMENT',
      commitment: {
        id: verificationCommitment.id, customerId: customer.id, matterId: matter.id,
        personId: people[0]!.id, title: verificationCommitment.title, kind: 'verification',
        ownerUserId: 'user-208', confirmationStatus: 'not_required',
        scheduledAtUtc: '2026-09-01T08:00:00.000Z', dueAtUtc: null,
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: null, source: 'manual', sourceRef: null,
        hypothesisRef: { hypothesisId: hypothesis.id, hypothesisRevisionId: revisionInput.id },
      },
    };
    expect(crm.safeParse(create).success).toBe(true);
    expect(crm.safeParse({
      ...create,
      commitment: { ...create.commitment, hypothesisRef: { hypothesisId: hypothesis.id } },
    }).success).toBe(false);
    expect(crm.safeParse({
      type: 'RECORD_COMMITMENT_RESULT', customerId: customer.id,
      commitmentId: verificationCommitment.id, baseVersion: 1, expectedScheduleVersion: 0,
      result: '客户已确认安排评审',
    }).success).toBe(true);
    expect(crm.safeParse({
      type: 'RECORD_COMMITMENT_RESULT', customerId: customer.id,
      commitmentId: verificationCommitment.id, baseVersion: 1, expectedScheduleVersion: 0,
      result: '',
    }).success).toBe(false);
    expect(crm.safeParse({
      type: 'RECORD_COMMITMENT_RESULT', customerId: customer.id,
      commitmentId: verificationCommitment.id, baseVersion: 1, expectedScheduleVersion: 0,
      result: 'x'.repeat(2_001), auditMetadata: { result: 'leak' },
    }).success).toBe(false);

    const quickCapture = schema('QuickCaptureCommandSchema')!;
    expect(quickCapture.safeParse({
      customer: { mode: 'existing', customerId: customer.id },
      commitment: {
        ...create,
        commitment: {
          ...create.commitment, kind: 'follow_up', source: 'manual_quick_capture',
          hypothesisRef: null,
        },
      },
    }).success).toBe(true);
    expect(quickCapture.safeParse({
      customer: { mode: 'existing', customerId: customer.id },
      commitment: { ...create, commitment: { ...create.commitment, kind: 'follow_up', source: 'manual_quick_capture' } },
    }).success).toBe(false);
  });

  it('extends hypothesis Evidence links only with an optional exact verification Commitment', () => {
    const command = schema('SalesHypothesisCommandSchema')!;
    const link = {
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'link-208', salesHypothesisId: hypothesis.id, expectedVersion: hypothesis.version,
        expectedCurrentRevisionId: revisionInput.id, evidenceId: 'evidence-208', evidenceVersion: 0,
        direction: 'supporting', verificationCommitmentId: verificationCommitment.id,
      },
    };
    expect(command.safeParse(link).success).toBe(true);
    expect(command.safeParse({
      ...link, link: { ...link.link, verificationCommitmentId: '' },
    }).success).toBe(false);
    const legacy = { ...link, link: { ...link.link } };
    delete (legacy.link as { verificationCommitmentId?: string }).verificationCommitmentId;
    expect(command.safeParse(legacy).success).toBe(true);
  });

  it('allows only explicit keep, revise, or retire review decisions with exact CAS', () => {
    const review = schema('ReviewHypothesisVerificationCommandSchema')!;
    const common = {
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', customerId: customer.id, matterId: matter.id,
      commitmentId: verificationCommitment.id, expectedCommitmentVersion: 1,
      expectedCommitmentScheduleVersion: 0, salesHypothesisId: hypothesis.id,
      expectedHypothesisVersion: hypothesis.version, expectedCurrentRevisionId: revisionInput.id,
    };
    expect(review.safeParse({
      ...common, disposition: 'keep', ownerUserId: 'user-208',
      nextReviewAt: '2026-09-15T08:00:00.000Z',
    }).success).toBe(true);
    expect(review.safeParse({
      ...common, disposition: 'revise', nextReviewAt: '2026-09-15T08:00:00.000Z',
      revision: { ...revisionInput, id: 'revision-208-2' },
    }).success).toBe(true);
    expect(review.safeParse({ ...common, disposition: 'retire' }).success).toBe(true);
    expect(review.safeParse({ ...common, disposition: 'auto_retire' }).success).toBe(false);
    expect(review.safeParse({ ...common, disposition: 'keep' }).success).toBe(false);
    expect(review.safeParse({
      ...common, disposition: 'retire', confidence: 0.99,
    }).success).toBe(false);
  });

  it('keeps verification receipts body-free', () => {
    const receipt = schema('ReviewHypothesisVerificationReceiptSchema')!;
    const safe = {
      type: 'REVIEW_HYPOTHESIS_VERIFICATION', customerId: customer.id, matterId: matter.id,
      commitmentId: verificationCommitment.id, salesHypothesisId: hypothesis.id,
      previousRevisionId: revisionInput.id, currentRevisionId: revisionInput.id,
      disposition: 'kept', commitmentVersion: 2, hypothesisVersion: 3,
      replayed: false, undoable: false,
    };
    expect(receipt.safeParse(safe).success).toBe(true);
    for (const forbidden of ['result', 'claim', 'sourceQuote', 'evidenceBody']) {
      expect(receipt.safeParse({ ...safe, [forbidden]: 'sensitive' }).success).toBe(false);
    }
  });
});
