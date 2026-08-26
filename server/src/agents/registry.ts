import { createHash } from 'node:crypto';
import {
  AgentJobDefinitionSchema,
  type AgentJobDefinition,
  type AgentJobKey,
} from '@jianghu/domain-contracts';

const definitions = [
  {
    jobKey: 'pre_meeting_brief',
    jobVersion: 'core-206.v1',
    purpose: 'Generate a reproducible pre-meeting brief from currently authorized CRM sources.',
    triggers: ['manual', 'event'],
    scopeManifest: {
      customer: 'required',
      matter: 'optional',
      sourceArtifact: 'optional',
      allowedSourceKinds: ['transcript', 'uploaded_file', 'note', 'external_reference'],
      allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
    },
    actionMode: 'read_only',
    evidencePolicy: {
      required: true,
      minimumRefs: 1,
      maximumRefs: 20,
      requireSourceFingerprint: true,
    },
    outputRefKinds: ['research_brief'],
    modelRef: 'tenant-byo-ai',
    connectorRefs: [],
    budget: {
      maxInputRefs: 50,
      maxEvidenceRefs: 20,
      maxOutputRefs: 10,
      maxCostUnits: 1_000,
    },
    timeoutMs: 30_000,
    maxAttempts: 2,
  },
  {
    jobKey: 'post_meeting_extract',
    jobVersion: 'core-206.v1',
    purpose: 'Turn one authorized meeting source into a human-review batch without formal writes.',
    triggers: ['manual', 'event'],
    scopeManifest: {
      customer: 'required',
      matter: 'optional',
      sourceArtifact: 'required',
      allowedSourceKinds: ['transcript', 'uploaded_file', 'note'],
      allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
    },
    actionMode: 'candidate',
    evidencePolicy: {
      required: true,
      minimumRefs: 1,
      maximumRefs: 20,
      requireSourceFingerprint: true,
    },
    outputRefKinds: ['review_batch'],
    modelRef: 'tenant-byo-ai',
    connectorRefs: [],
    budget: {
      maxInputRefs: 50,
      maxEvidenceRefs: 20,
      maxOutputRefs: 1,
      maxCostUnits: 2_000,
    },
    timeoutMs: 45_000,
    maxAttempts: 2,
  },
  {
    jobKey: 'relationship_radar',
    jobVersion: 'core-206.v1',
    purpose: 'Generate explainable relationship signals, interventions, and uncommitted action drafts.',
    triggers: ['manual', 'schedule'],
    scopeManifest: {
      customer: 'required',
      matter: 'required',
      sourceArtifact: 'optional',
      allowedSourceKinds: ['transcript', 'note', 'external_reference'],
      allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
    },
    actionMode: 'draft',
    evidencePolicy: {
      required: true,
      minimumRefs: 1,
      maximumRefs: 30,
      requireSourceFingerprint: true,
    },
    outputRefKinds: ['relationship_signal', 'intervention_item', 'draft_action'],
    modelRef: 'deterministic-relationship-rules-v1',
    connectorRefs: [],
    budget: {
      maxInputRefs: 100,
      maxEvidenceRefs: 30,
      maxOutputRefs: 100,
      maxCostUnits: 500,
    },
    timeoutMs: 30_000,
    maxAttempts: 2,
  },
] satisfies unknown[];

export const BUILT_IN_AGENT_DEFINITIONS: readonly AgentJobDefinition[] = definitions.map(
  (definition) => AgentJobDefinitionSchema.parse(definition),
);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

export function canonicalAgentDefinition(value: unknown): string {
  const definition = AgentJobDefinitionSchema.parse(value);
  return JSON.stringify(canonicalize(definition));
}

export function hashAgentDefinition(value: unknown): string {
  return createHash('sha256').update(canonicalAgentDefinition(value)).digest('hex');
}

export function builtInAgentDefinition(
  jobKey: AgentJobKey,
  jobVersion: string,
): AgentJobDefinition | null {
  return BUILT_IN_AGENT_DEFINITIONS.find((definition) => (
    definition.jobKey === jobKey && definition.jobVersion === jobVersion
  )) ?? null;
}

export function agentDefinitionRegistryKey(jobKey: AgentJobKey, jobVersion: string): string {
  return `${jobKey}@${jobVersion}`;
}
