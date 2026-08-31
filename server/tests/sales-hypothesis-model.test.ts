import { describe, expect, it } from 'vitest';
import {
  canonicalHypothesisStrings,
  hypothesisStatusSuggestion,
  parseStoredHypothesisStrings,
  projectHypothesisEvidenceLink,
  projectSalesHypothesis,
  projectSalesHypothesisRevision,
} from '../src/hypotheses/model.js';

const createdAt = new Date('2026-08-30T10:00:00.000Z');

describe('SAAS-207 SalesHypothesis immutable model', () => {
  it('canonicalizes strict unique signal lists and fails closed on stored drift', () => {
    expect(canonicalHypothesisStrings(['signal one', 'signal two']))
      .toBe('["signal one","signal two"]');
    expect(parseStoredHypothesisStrings('["signal one","signal two"]', false))
      .toEqual(['signal one', 'signal two']);
    expect(() => parseStoredHypothesisStrings('[ "signal one" ]', false)).toThrow('storage_invalid');
    expect(() => parseStoredHypothesisStrings('["duplicate","duplicate"]', false)).toThrow('storage_invalid');
    expect(() => parseStoredHypothesisStrings('[]', false)).toThrow('storage_invalid');
    expect(parseStoredHypothesisStrings('[]', true)).toEqual([]);
  });

  it('projects complete user and explicitly incomplete legacy revisions', () => {
    expect(projectSalesHypothesisRevision({
      id: 'revision-user', revisionNumber: 2, claim: 'Budget is approved', reason: 'Committee minutes',
      expectedSignals: '["PO draft arrives"]', falsificationConditions: '["Budget removed"]',
      origin: 'user', createdByUserId: 'user-1', createdAt,
    })).toMatchObject({
      id: 'revision-user', revisionNumber: 2, expectedSignals: ['PO draft arrives'],
      falsificationConditions: ['Budget removed'], origin: 'user', createdAt: createdAt.toISOString(),
    });
    expect(projectSalesHypothesisRevision({
      id: 'revision-legacy', revisionNumber: 1, claim: 'Legacy assumption', reason: '',
      expectedSignals: '[]', falsificationConditions: '[]', origin: 'legacy_assumption',
      createdByUserId: null, createdAt,
    })).toMatchObject({ reason: '', expectedSignals: [], falsificationConditions: [] });
    expect(() => projectSalesHypothesisRevision({
      id: 'revision-bad', revisionNumber: 2, claim: 'Bad legacy', reason: '',
      expectedSignals: '[]', falsificationConditions: '[]', origin: 'legacy_assumption',
      createdByUserId: null, createdAt,
    })).toThrow('storage_invalid');
  });

  it('checks current pointer, paired metadata and body-free evidence links', () => {
    const revision = projectSalesHypothesisRevision({
      id: 'revision-1', revisionNumber: 1, claim: 'Budget is approved', reason: 'Committee minutes',
      expectedSignals: '["PO draft arrives"]', falsificationConditions: '["Budget removed"]',
      origin: 'user', createdByUserId: 'user-1', createdAt,
    });
    const view = projectSalesHypothesis({
      id: 'hypothesis-1', customerId: 'customer-1', matterId: 'matter-1', personId: null,
      status: 'testing', ownerUserId: 'user-1', nextReviewAt: new Date('2026-09-30T00:00:00.000Z'),
      currentRevisionId: revision.id, legacyStrategyRiskId: null, createdByUserId: 'user-1',
      statusConfirmedByUserId: 'user-1', statusConfirmedAt: createdAt, version: 3,
      createdAt, updatedAt: createdAt,
    }, revision);
    expect(view.currentRevision.claim).toBe('Budget is approved');
    expect(() => projectSalesHypothesis({
      id: 'hypothesis-1', customerId: 'customer-1', matterId: 'matter-1', personId: null,
      status: 'testing', ownerUserId: 'user-1', nextReviewAt: null,
      currentRevisionId: revision.id, legacyStrategyRiskId: null, createdByUserId: 'user-1',
      statusConfirmedByUserId: 'user-1', statusConfirmedAt: createdAt, version: 3,
      createdAt, updatedAt: createdAt,
    }, revision)).toThrow('storage_invalid');
    expect(projectHypothesisEvidenceLink({
      id: 'link-1', hypothesisId: view.id, hypothesisRevisionId: revision.id,
      evidenceId: 'evidence-1', evidenceVersion: 0, direction: 'supporting',
      linkedByUserId: 'user-1', linkedAt: createdAt,
    })).not.toHaveProperty('rawContent');
  });

  it('derives a deterministic suggestion without changing formal status', () => {
    const supporting = projectHypothesisEvidenceLink({
      id: 'link-support', hypothesisId: 'hypothesis-1', hypothesisRevisionId: 'revision-1',
      evidenceId: 'evidence-support', evidenceVersion: 0, direction: 'supporting',
      linkedByUserId: 'user-1', linkedAt: createdAt,
    });
    expect(hypothesisStatusSuggestion('hypothesis-1', 'revision-1', 'testing', [supporting]))
      .toMatchObject({
        formalStatus: 'testing', suggestedStatus: 'supported', reasonCode: 'only_supporting',
        supportingCount: 1, contradictingCount: 0,
        ruleVersion: 'hypothesis-evidence-balance.v1',
      });
    const mixed = hypothesisStatusSuggestion('hypothesis-1', 'revision-1', 'testing', [
      supporting,
      { ...supporting, id: 'link-against', evidenceId: 'evidence-against', direction: 'contradicting' },
    ]);
    expect(mixed).toMatchObject({ suggestedStatus: null, reasonCode: 'mixed' });
  });
});
