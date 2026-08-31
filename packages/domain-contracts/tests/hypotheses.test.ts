import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean; data?: unknown };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const revision = {
  id: 'hypothesis-revision-207-1',
  claim: '若王主任确认实施风险可控，他会推动李总立项',
  reason: '王主任负责实施风险评估，并能影响立项意见',
  expectedSignals: ['王主任主动安排技术评审', '允许业务部门参加评审'],
  falsificationConditions: ['王主任拒绝安排评审', '评审后明确反对立项'],
};

const revisionView = {
  ...revision,
  revisionNumber: 1,
  origin: 'user',
  createdByUserId: 'user-207',
  createdAt: '2026-08-30T20:00:00.000Z',
};

const linkView = {
  id: 'hypothesis-link-207',
  hypothesisId: 'hypothesis-207',
  hypothesisRevisionId: revision.id,
  evidenceId: 'evidence-207',
  evidenceVersion: 0,
  direction: 'supporting',
  linkedByUserId: 'user-207',
  linkedAt: '2026-08-30T20:10:00.000Z',
};

const hypothesisView = {
  id: 'hypothesis-207',
  customerId: 'customer-207',
  matterId: 'matter-207',
  personId: 'person-207',
  status: 'testing',
  ownerUserId: 'user-207',
  nextReviewAt: '2026-09-06T20:00:00.000Z',
  currentRevisionId: revision.id,
  currentRevision: revisionView,
  legacyStrategyRiskId: null,
  createdByUserId: 'user-207',
  statusConfirmedByUserId: 'user-207',
  statusConfirmedAt: '2026-08-30T20:05:00.000Z',
  version: 2,
  createdAt: '2026-08-30T20:00:00.000Z',
  updatedAt: '2026-08-30T20:10:00.000Z',
};

describe('SAAS-207 SalesHypothesis contracts', () => {
  it('exports a standalone strict contract without extending legacy Action', () => {
    for (const name of [
      'SalesHypothesisStatusSchema',
      'HypothesisEvidenceDirectionSchema',
      'SalesHypothesisRevisionInputSchema',
      'SalesHypothesisRevisionViewSchema',
      'HypothesisEvidenceLinkViewSchema',
      'SalesHypothesisViewSchema',
      'SalesHypothesisCommandSchema',
      'SalesHypothesisCommandReceiptSchema',
      'SalesHypothesisListQuerySchema',
      'SalesHypothesisListResponseSchema',
      'SalesHypothesisDetailQuerySchema',
      'SalesHypothesisDetailResponseSchema',
      'SalesHypothesisStatusSuggestionSchema',
    ]) {
      expect(schema(name), `${name} must be exported`).toBeDefined();
    }
  });

  it('requires falsifiable complete user revisions with bounded unique signals', () => {
    const input = schema('SalesHypothesisRevisionInputSchema')!;
    expect(input.safeParse(revision).success).toBe(true);
    for (const field of ['claim', 'reason'] as const) {
      expect(input.safeParse({ ...revision, [field]: '' }).success).toBe(false);
    }
    expect(input.safeParse({ ...revision, expectedSignals: [] }).success).toBe(false);
    expect(input.safeParse({ ...revision, falsificationConditions: [] }).success).toBe(false);
    expect(input.safeParse({
      ...revision,
      expectedSignals: [revision.expectedSignals[0], revision.expectedSignals[0]],
    }).success).toBe(false);
    expect(input.safeParse({
      ...revision,
      falsificationConditions: Array.from({ length: 9 }, (_, index) => `反证 ${index}`),
    }).success).toBe(false);
    expect(input.safeParse({ ...revision, claim: 'x'.repeat(2_001) }).success).toBe(false);
    expect(input.safeParse({ ...revision, reason: 'x'.repeat(1_001) }).success).toBe(false);
    expect(input.safeParse({ ...revision, expectedSignals: ['x'.repeat(501)] }).success).toBe(false);
    expect(input.safeParse({ ...revision, hiddenTruthStatus: 'supported' }).success).toBe(false);
  });

  it('preserves explicit legacy-incomplete revision history without allowing it as new input', () => {
    const view = schema('SalesHypothesisRevisionViewSchema')!;
    const legacy = {
      id: 'legacy-revision-207', revisionNumber: 1,
      claim: '历史单段假设', reason: '', expectedSignals: [], falsificationConditions: [],
      origin: 'legacy_assumption', createdByUserId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    expect(view.safeParse(legacy).success).toBe(true);
    expect(view.safeParse({ ...legacy, revisionNumber: 2 }).success).toBe(false);
    expect(view.safeParse({ ...legacy, createdByUserId: 'invented-user' }).success).toBe(false);
    expect(view.safeParse({ ...revisionView, expectedSignals: [] }).success).toBe(false);
    expect(schema('SalesHypothesisRevisionInputSchema')!.safeParse({
      id: legacy.id, claim: legacy.claim, reason: '', expectedSignals: [], falsificationConditions: [],
    }).success).toBe(false);
  });

  it('locks five explicit human command variants and exact optimistic concurrency', () => {
    const command = schema('SalesHypothesisCommandSchema')!;
    const create = {
      type: 'CREATE_SALES_HYPOTHESIS',
      hypothesis: {
        id: 'hypothesis-207', customerId: 'customer-207', matterId: 'matter-207',
        personId: 'person-207', ownerUserId: 'user-207',
        nextReviewAt: '2026-09-06T20:00:00.000Z', revision,
      },
    };
    expect(command.safeParse(create).success).toBe(true);
    expect(command.safeParse({ ...create, hypothesis: { ...create.hypothesis, ownerUserId: null } }).success).toBe(false);
    expect(command.safeParse({ ...create, hypothesis: { ...create.hypothesis, personId: null } }).success).toBe(true);
    expect(command.safeParse({ ...create, hypothesis: { ...create.hypothesis, status: 'supported' } }).success).toBe(false);

    expect(command.safeParse({
      type: 'REVISE_SALES_HYPOTHESIS', salesHypothesisId: 'hypothesis-207',
      expectedVersion: 2, expectedCurrentRevisionId: revision.id,
      nextReviewAt: '2026-09-13T20:00:00.000Z',
      revision: { ...revision, id: 'hypothesis-revision-207-2' },
    }).success).toBe(true);
    expect(command.safeParse({
      type: 'UPDATE_SALES_HYPOTHESIS_REVIEW', salesHypothesisId: 'hypothesis-207',
      expectedVersion: 3, ownerUserId: 'user-207', nextReviewAt: '2026-09-20T20:00:00.000Z',
    }).success).toBe(true);
    for (const status of ['untested', 'testing', 'supported', 'contradicted', 'retired']) {
      expect(command.safeParse({
        type: 'SET_SALES_HYPOTHESIS_STATUS', salesHypothesisId: 'hypothesis-207',
        expectedVersion: 3, status,
      }).success).toBe(true);
    }
    expect(command.safeParse({
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'hypothesis-link-207', salesHypothesisId: 'hypothesis-207', expectedVersion: 3,
        expectedCurrentRevisionId: revision.id, evidenceId: 'evidence-207', evidenceVersion: 0,
        direction: 'contradicting',
      },
    }).success).toBe(true);
    expect(command.safeParse({
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'hypothesis-link-207', salesHypothesisId: 'hypothesis-207', expectedVersion: 3,
        expectedCurrentRevisionId: revision.id, evidenceId: 'evidence-207', evidenceVersion: 1,
        direction: 'supporting',
      },
    }).success).toBe(false);
    for (const forbiddenType of ['DELETE_SALES_HYPOTHESIS', 'DELETE_HYPOTHESIS_REVISION', 'AUTO_SET_HYPOTHESIS_STATUS']) {
      expect(command.safeParse({ ...create, type: forbiddenType }).success).toBe(false);
    }
  });

  it('keeps receipts body-free and exposes immutable identifiers only', () => {
    const receipt = schema('SalesHypothesisCommandReceiptSchema')!;
    const safe = {
      type: 'LINK_HYPOTHESIS_EVIDENCE', salesHypothesisId: 'hypothesis-207',
      customerId: 'customer-207', matterId: 'matter-207',
      currentRevisionId: revision.id, currentRevisionNumber: 1,
      evidenceLinkId: 'hypothesis-link-207',
      status: 'testing', version: 3, replayed: false, undoable: false,
    };
    expect(receipt.safeParse(safe).success).toBe(true);
    const { currentRevisionNumber: _revisionNumber, ...missingRevisionNumber } = safe;
    expect(receipt.safeParse(missingRevisionNumber).success).toBe(false);
    for (const forbidden of ['claim', 'reason', 'expectedSignals', 'falsificationConditions', 'rawContent']) {
      expect(receipt.safeParse({ ...safe, [forbidden]: '不得进入回执' }).success).toBe(false);
    }
    expect(receipt.safeParse({ ...safe, evidenceLinkId: null }).success).toBe(false);
    expect(receipt.safeParse({
      ...safe, type: 'SET_SALES_HYPOTHESIS_STATUS', evidenceLinkId: null,
    }).success).toBe(true);
  });

  it('defines strict current views and paginated immutable history', () => {
    const view = schema('SalesHypothesisViewSchema')!;
    const listQuery = schema('SalesHypothesisListQuerySchema')!;
    const list = schema('SalesHypothesisListResponseSchema')!;
    const detailQuery = schema('SalesHypothesisDetailQuerySchema')!;
    const detail = schema('SalesHypothesisDetailResponseSchema')!;
    expect(view.safeParse(hypothesisView).success).toBe(true);
    expect(view.safeParse({ ...hypothesisView, currentRevisionId: 'wrong-revision' }).success).toBe(false);
    expect(view.safeParse({ ...hypothesisView, methodScore: 80 }).success).toBe(false);
    expect(listQuery.safeParse({ customerId: 'customer-207', matterId: 'matter-207' }).success).toBe(true);
    expect(listQuery.safeParse({ customerId: 'customer-207', matterId: 'matter-207', limit: 51 }).success).toBe(false);
    expect(list.safeParse({ items: [hypothesisView], nextCursor: null }).success).toBe(true);
    expect(detailQuery.safeParse({ beforeRevisionNumber: null, limit: 20 }).success).toBe(true);
    expect(detailQuery.safeParse({ beforeRevisionNumber: 0, limit: 20 }).success).toBe(false);
    expect(detail.safeParse({
      item: hypothesisView,
      revisions: [{ revision: revisionView, evidenceLinks: [linkView] }],
      nextRevisionBefore: null,
    }).success).toBe(true);
    expect(detail.safeParse({
      item: hypothesisView,
      revisions: [{ revision: revisionView, evidenceLinks: Array.from({ length: 51 }, () => linkView) }],
      nextRevisionBefore: null,
    }).success).toBe(false);
  });

  it('returns a deterministic body-free status suggestion and never a formal write command', () => {
    const suggestion = schema('SalesHypothesisStatusSuggestionSchema')!;
    const safe = {
      hypothesisId: 'hypothesis-207', hypothesisRevisionId: revision.id,
      formalStatus: 'testing', suggestedStatus: 'supported', reasonCode: 'only_supporting',
      supportingCount: 1, contradictingCount: 0,
      evidenceRefs: [{ evidenceId: 'evidence-207', evidenceVersion: 0, direction: 'supporting', linkedAt: linkView.linkedAt }],
      asOf: linkView.linkedAt, ruleVersion: 'hypothesis-evidence-balance.v1',
    };
    expect(suggestion.safeParse(safe).success).toBe(true);
    expect(suggestion.safeParse({ ...safe, suggestedStatus: 'contradicted' }).success).toBe(false);
    expect(suggestion.safeParse({
      ...safe, suggestedStatus: null, reasonCode: 'mixed', contradictingCount: 1,
      evidenceRefs: [
        safe.evidenceRefs[0],
        { ...safe.evidenceRefs[0], evidenceId: 'evidence-208', direction: 'contradicting' },
      ],
    }).success).toBe(true);
    expect(suggestion.safeParse({ ...safe, rawEvidence: '禁止泄露证据正文' }).success).toBe(false);
    expect(schema('SalesHypothesisCommandSchema')!.safeParse({
      type: 'APPLY_HYPOTHESIS_STATUS_SUGGESTION', salesHypothesisId: 'hypothesis-207', status: 'supported',
    }).success).toBe(false);
  });
});
