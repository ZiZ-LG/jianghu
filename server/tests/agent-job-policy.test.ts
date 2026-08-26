import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_AGENT_DEFINITIONS,
  builtInAgentDefinition,
  canonicalAgentDefinition,
  hashAgentDefinition,
} from '../src/agents/registry.js';
import {
  effectiveAgentControl,
  validatePreparedAgentAudit,
} from '../src/agents/policy.js';

describe('CORE-206 fixed Agent registry and policy', () => {
  it('registers exactly three immutable cards with fixed modes and triggers', () => {
    expect(BUILT_IN_AGENT_DEFINITIONS.map((definition) => definition.jobKey)).toEqual([
      'pre_meeting_brief',
      'post_meeting_extract',
      'relationship_radar',
    ]);
    expect(builtInAgentDefinition('pre_meeting_brief', 'core-206.v1')).toMatchObject({
      actionMode: 'read_only', triggers: ['manual', 'event'],
    });
    expect(builtInAgentDefinition('post_meeting_extract', 'core-206.v1')).toMatchObject({
      actionMode: 'candidate', outputRefKinds: ['review_batch'],
    });
    expect(builtInAgentDefinition('relationship_radar', 'core-206.v1')).toMatchObject({
      actionMode: 'draft', triggers: ['manual', 'schedule'],
    });
    expect(builtInAgentDefinition('post_meeting_extract', 'unknown')).toBeNull();
  });

  it('canonicalizes and hashes definitions deterministically without availability state', () => {
    const definition = BUILT_IN_AGENT_DEFINITIONS[1]!;
    const canonical = canonicalAgentDefinition(definition);
    expect(JSON.parse(canonical)).toEqual(definition);
    expect(hashAgentDefinition(definition)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAgentDefinition(JSON.parse(canonical))).toBe(hashAgentDefinition(definition));
    expect(canonical).not.toContain('available');
    expect(canonical).not.toContain('enabled');
  });

  it('defaults missing controls disabled and rejects database attempts to widen authority', () => {
    const definition = BUILT_IN_AGENT_DEFINITIONS[0]!;
    expect(effectiveAgentControl(definition, null, false)).toMatchObject({
      state: 'missing', enabled: false, version: 0,
      limits: {
        maxCostUnits: definition.budget.maxCostUnits,
        timeoutMs: definition.timeoutMs,
        maxAttempts: definition.maxAttempts,
      },
    });

    const stored = {
      definitionJson: canonicalAgentDefinition(definition),
      definitionHash: hashAgentDefinition(definition),
      enabled: true,
      tenantLimitsJson: JSON.stringify({
        maxCostUnits: definition.budget.maxCostUnits - 1,
        timeoutMs: definition.timeoutMs - 1,
        maxAttempts: 1,
      }),
      version: 4,
    };
    expect(effectiveAgentControl(definition, stored, true)).toMatchObject({
      state: 'valid', enabled: true, version: 4,
    });
    expect(effectiveAgentControl(definition, {
      ...stored,
      tenantLimitsJson: JSON.stringify({
        maxCostUnits: definition.budget.maxCostUnits + 1,
        timeoutMs: definition.timeoutMs,
        maxAttempts: definition.maxAttempts,
      }),
    }, true)).toMatchObject({ state: 'invalid', enabled: false });
    expect(effectiveAgentControl(definition, { ...stored, definitionHash: '0'.repeat(64) }, true))
      .toMatchObject({ state: 'invalid', enabled: false });
    expect(effectiveAgentControl(definition, stored, false))
      .toMatchObject({ state: 'valid', enabled: false });
  });

  it('enforces action mode, evidence, output and budget before any commit adapter runs', () => {
    const readOnly = BUILT_IN_AGENT_DEFINITIONS[0]!;
    const source = {
      sourceArtifactId: 'source-1',
      locatorId: 'segment-1',
      sourceFingerprint: 'a'.repeat(64),
      observedAt: '2026-08-25T18:00:00.000Z',
    };
    expect(validatePreparedAgentAudit(readOnly, {
      costUnits: 2,
      evidenceRefs: [source],
      outputRefs: [{ kind: 'research_brief', id: 'brief-1', version: 0 }],
    }, {
      maxCostUnits: 10, timeoutMs: 1_000, maxAttempts: 1,
    })).toEqual({ ok: true });

    expect(validatePreparedAgentAudit(readOnly, {
      costUnits: 2,
      evidenceRefs: [source],
      outputRefs: [{ kind: 'review_batch', id: 'batch-1', version: 0 }],
    }, {
      maxCostUnits: 10, timeoutMs: 1_000, maxAttempts: 1,
    })).toEqual({ ok: false, code: 'agent_output_forbidden' });

    expect(validatePreparedAgentAudit(readOnly, {
      costUnits: 11,
      evidenceRefs: [source],
      outputRefs: [{ kind: 'research_brief', id: 'brief-1', version: 0 }],
    }, {
      maxCostUnits: 10, timeoutMs: 1_000, maxAttempts: 1,
    })).toEqual({ ok: false, code: 'agent_budget_exceeded' });

    expect(validatePreparedAgentAudit(readOnly, {
      costUnits: 2,
      evidenceRefs: [],
      outputRefs: [{ kind: 'research_brief', id: 'brief-1', version: 0 }],
    }, {
      maxCostUnits: 10, timeoutMs: 1_000, maxAttempts: 1,
    })).toEqual({ ok: false, code: 'agent_evidence_required' });
  });
});
