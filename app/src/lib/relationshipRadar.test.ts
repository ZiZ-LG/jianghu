import { describe, expect, it } from 'vitest';
import type { AgentJobCard, AgentRunView } from '@jianghu/domain-contracts';
import {
  buildRelationshipRadarRunInput,
  parseRelationshipRadar,
  parseRelationshipRadarRuns,
  stableRelationshipRadarRunSubmission,
} from './relationshipRadar';

describe('SAAS-212 relationship radar client domain', () => {
  const job: AgentJobCard = {
    jobKey: 'relationship_radar',
    jobVersion: 'saas-212.v1',
    purpose: 'Generate explainable relationship signals, interventions, and uncommitted action drafts.',
    triggers: ['manual', 'schedule'],
    scopeManifest: {
      customer: 'required', matter: 'required', sourceArtifact: 'optional',
      allowedSourceKinds: ['transcript', 'note', 'external_reference'],
      allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
    },
    actionMode: 'draft',
    outputRefKinds: ['relationship_signal', 'intervention_item', 'draft_action'],
    modelRef: 'deterministic-relationship-rules-v1', connectorRefs: [],
    timeoutMs: 30_000, maxAttempts: 2,
    available: true,
    enabled: true,
    controlState: 'valid' as const,
    controlVersion: 1,
    evidencePolicy: { required: false, minimumRefs: 0, maximumRefs: 0, requireSourceFingerprint: true as const },
    budget: { maxInputRefs: 100, maxEvidenceRefs: 0, maxOutputRefs: 100, maxCostUnits: 500 },
    limits: { maxCostUnits: 500, timeoutMs: 30_000, maxAttempts: 2 },
  };

  it('builds an exact body-free Customer/Matter-only run request', () => {
    expect(buildRelationshipRadarRunInput({
      job,
      customer: { id: 'customer-1', version: 4, archivedAt: null },
      matter: { id: 'matter-1', customerId: 'customer-1', version: 3, archivedAt: null },
    })).toEqual({
      jobVersion: 'saas-212.v1', customerId: 'customer-1', matterId: 'matter-1',
      sourceArtifactId: null,
      inputRefs: [
        { kind: 'customer', id: 'customer-1', version: 4 },
        { kind: 'matter', id: 'matter-1', version: 3 },
      ],
    });
  });

  it('keeps a stable idempotency key for the same canonical run request', () => {
    const request = buildRelationshipRadarRunInput({
      job,
      customer: { id: 'customer-1', version: 4, archivedAt: null },
      matter: { id: 'matter-1', customerId: 'customer-1', version: 3, archivedAt: null },
    });
    const first = stableRelationshipRadarRunSubmission(request, null, () => 'stable-key');
    expect(stableRelationshipRadarRunSubmission(request, first, () => 'new-key')).toBe(first);
  });

  it('rejects a mismatched projection parent', () => {
    expect(() => parseRelationshipRadar({
      status: 'missing', customerId: 'other', matterId: 'matter-1',
    }, 'customer-1', 'matter-1')).toThrow('invalid_relationship_radar_response:projection');
  });

  it('keeps only strict relationship-radar history for the selected Customer/Matter', () => {
    const run: AgentRunView = {
      id: 'run-radar-1', jobKey: 'relationship_radar', jobVersion: 'saas-212.v1',
      actionMode: 'draft', trigger: 'manual', status: 'succeeded',
      customerId: 'customer-1', matterId: 'matter-1', sourceArtifactId: null,
      actorId: 'user-1', attemptCount: 1, maxAttempts: 2,
      budgetLimit: 500, costUsed: 6, timeoutMs: 30_000,
      authorizationFingerprint: 'a'.repeat(64),
      modelRef: 'deterministic-relationship-rules-v1', connectorRefs: [],
      inputRefs: [
        { kind: 'customer', id: 'customer-1', version: 4 },
        { kind: 'matter', id: 'matter-1', version: 3 },
      ],
      evidenceRefs: [],
      outputRefs: [{ kind: 'relationship_signal', id: 'rrsig_history_1', version: 1 }],
      failureCode: '', createdAt: '2026-09-01T08:00:00.000Z',
      startedAt: '2026-09-01T08:00:00.000Z', completedAt: '2026-09-01T08:00:01.000Z',
      version: 1,
    };
    expect(parseRelationshipRadarRuns({
      items: [run, { ...run, id: 'run-other-matter', matterId: 'matter-2', inputRefs: [
        { kind: 'customer', id: 'customer-1', version: 4 },
        { kind: 'matter', id: 'matter-2', version: 1 },
      ] }],
      nextCursor: null,
    }, 'customer-1', 'matter-1')).toEqual({ items: [run], nextCursor: null });
    expect(() => parseRelationshipRadarRuns({
      items: [{ ...run, rawPrompt: 'must-not-cross-client-boundary' }], nextCursor: null,
    }, 'customer-1', 'matter-1')).toThrow('invalid_relationship_radar_response:runs');
  });
});
