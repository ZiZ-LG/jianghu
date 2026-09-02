import {
  AgentJobControlLimitsSchema,
  AgentPreparedAuditSchema,
  type AgentJobControlLimits,
  type AgentJobDefinition,
} from '@jianghu/domain-contracts';
import {
  canonicalAgentDefinition,
  hashAgentDefinition,
} from './registry.js';

export interface StoredAgentControl {
  definitionJson: string;
  definitionHash: string;
  enabled: boolean;
  tenantLimitsJson: string;
  version: number;
}

export interface EffectiveAgentControl {
  state: 'missing' | 'valid' | 'invalid';
  enabled: boolean;
  version: number;
  limits: AgentJobControlLimits;
}

export type AgentPreparedPolicyResult = { ok: true } | { ok: false; code: string };

export function defaultAgentControlLimits(definition: AgentJobDefinition): AgentJobControlLimits {
  return {
    maxCostUnits: definition.budget.maxCostUnits,
    timeoutMs: definition.timeoutMs,
    maxAttempts: definition.maxAttempts,
  };
}

function limitsDoNotWiden(
  definition: AgentJobDefinition,
  limits: AgentJobControlLimits,
): boolean {
  return limits.maxCostUnits <= definition.budget.maxCostUnits
    && limits.timeoutMs <= definition.timeoutMs
    && limits.maxAttempts <= definition.maxAttempts;
}

export function effectiveAgentControl(
  definition: AgentJobDefinition,
  stored: StoredAgentControl | null,
  handlerAvailable: boolean,
): EffectiveAgentControl {
  const defaults = defaultAgentControlLimits(definition);
  if (!stored) return { state: 'missing', enabled: false, version: 0, limits: defaults };
  if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
    return { state: 'invalid', enabled: false, version: 0, limits: defaults };
  }
  let limits: AgentJobControlLimits;
  try {
    const parsedDefinition = JSON.parse(stored.definitionJson) as unknown;
    if (canonicalAgentDefinition(parsedDefinition) !== canonicalAgentDefinition(definition)
      || stored.definitionJson !== canonicalAgentDefinition(definition)
      || stored.definitionHash !== hashAgentDefinition(definition)) {
      return { state: 'invalid', enabled: false, version: stored.version, limits: defaults };
    }
    limits = AgentJobControlLimitsSchema.parse(JSON.parse(stored.tenantLimitsJson));
  } catch {
    return { state: 'invalid', enabled: false, version: stored.version, limits: defaults };
  }
  if (!limitsDoNotWiden(definition, limits)) {
    return { state: 'invalid', enabled: false, version: stored.version, limits: defaults };
  }
  return {
    state: 'valid',
    enabled: stored.enabled && handlerAvailable,
    version: stored.version,
    limits,
  };
}

export function validatePreparedAgentAudit(
  definition: AgentJobDefinition,
  raw: unknown,
  limits: AgentJobControlLimits,
): AgentPreparedPolicyResult {
  const parsed = AgentPreparedAuditSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'agent_output_invalid' };
  const audit = parsed.data;
  if (!limitsDoNotWiden(definition, limits)) return { ok: false, code: 'agent_control_invalid' };
  if (audit.costUnits > limits.maxCostUnits) return { ok: false, code: 'agent_budget_exceeded' };
  if (audit.evidenceRefs.length < definition.evidencePolicy.minimumRefs) {
    return { ok: false, code: 'agent_evidence_required' };
  }
  if (audit.evidenceRefs.length > definition.evidencePolicy.maximumRefs
    || audit.evidenceRefs.length > definition.budget.maxEvidenceRefs) {
    return { ok: false, code: 'agent_evidence_limit_exceeded' };
  }
  if (audit.outputRefs.length < 1 || audit.outputRefs.length > definition.budget.maxOutputRefs) {
    return { ok: false, code: 'agent_output_limit_exceeded' };
  }
  const allowedOutputs = new Set(definition.outputRefKinds);
  if (audit.outputRefs.some((ref) => !allowedOutputs.has(ref.kind))) {
    return { ok: false, code: 'agent_output_forbidden' };
  }
  if (definition.actionMode === 'candidate'
    && audit.outputRefs.some((ref) => ref.kind !== 'review_batch')) {
    return { ok: false, code: 'agent_output_forbidden' };
  }
  if (definition.actionMode !== 'candidate'
    && audit.outputRefs.some((ref) => ref.kind === 'review_batch')) {
    return { ok: false, code: 'agent_output_forbidden' };
  }
  const evidenceIds = audit.evidenceRefs.map((ref) => (
    `${ref.sourceArtifactId}\0${ref.locatorId}\0${ref.sourceFingerprint}`
  ));
  const outputIds = audit.outputRefs.map((ref) => `${ref.kind}\0${ref.id}\0${ref.version}`);
  if (new Set(evidenceIds).size !== evidenceIds.length
    || new Set(outputIds).size !== outputIds.length) {
    return { ok: false, code: 'agent_output_invalid' };
  }
  return { ok: true };
}
