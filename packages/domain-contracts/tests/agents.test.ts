import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const definition = {
  jobKey: 'post_meeting_extract',
  jobVersion: 'core-206.v1',
  purpose: 'Turn one authorized meeting source into a human-review batch.',
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
    maxInputRefs: 20,
    maxEvidenceRefs: 20,
    maxOutputRefs: 1,
    maxCostUnits: 2_000,
  },
  timeoutMs: 30_000,
  maxAttempts: 2,
};

const limits = {
  maxCostUnits: 1_000,
  timeoutMs: 20_000,
  maxAttempts: 1,
};

const runView = {
  id: 'agent-run-1',
  jobKey: 'post_meeting_extract',
  jobVersion: 'core-206.v1',
  actionMode: 'candidate',
  trigger: 'manual',
  status: 'succeeded',
  customerId: 'customer-1',
  matterId: 'matter-1',
  sourceArtifactId: 'source-1',
  actorId: 'user-1',
  attemptCount: 1,
  maxAttempts: 1,
  budgetLimit: 1_000,
  costUsed: 12,
  timeoutMs: 20_000,
  authorizationFingerprint: 'a'.repeat(64),
  modelRef: 'tenant-byo-ai',
  connectorRefs: [],
  inputRefs: [
    { kind: 'customer', id: 'customer-1', version: 3 },
    { kind: 'matter', id: 'matter-1', version: 4 },
    { kind: 'source_artifact', id: 'source-1', version: 2 },
  ],
  evidenceRefs: [{
    sourceArtifactId: 'source-1',
    locatorId: 'segment-4',
    sourceFingerprint: 'b'.repeat(64),
    observedAt: '2026-08-25T18:00:00.000Z',
  }],
  outputRefs: [{ kind: 'review_batch', id: 'batch-1', version: 0 }],
  failureCode: '',
  createdAt: '2026-08-25T18:00:00.000Z',
  startedAt: '2026-08-25T18:00:01.000Z',
  completedAt: '2026-08-25T18:00:02.000Z',
  version: 2,
};

describe('CORE-206 controlled Agent contracts', () => {
  it('publishes one strict immutable definition for only the three built-in jobs', () => {
    const definitionSchema = schema('AgentJobDefinitionSchema');
    expect(definitionSchema, 'AgentJobDefinitionSchema must be exported').toBeDefined();
    expect(definitionSchema!.safeParse(definition).success).toBe(true);
    expect(definitionSchema!.safeParse({ ...definition, jobKey: 'tenant_script' }).success).toBe(false);
    expect(definitionSchema!.safeParse({ ...definition, prompt: 'secret prompt' }).success).toBe(false);
    expect(definitionSchema!.safeParse({
      ...definition,
      actionMode: 'read_only',
      outputRefKinds: ['review_batch'],
    }).success).toBe(false);
    expect(definitionSchema!.safeParse({
      ...definition,
      maxAttempts: 4,
    }).success).toBe(false);
  });

  it('keeps tenant controls bounded and missing definitions disabled', () => {
    const limitsSchema = schema('AgentJobControlLimitsSchema');
    const cardSchema = schema('AgentJobCardSchema');
    expect(limitsSchema, 'AgentJobControlLimitsSchema must be exported').toBeDefined();
    expect(cardSchema, 'AgentJobCardSchema must be exported').toBeDefined();
    expect(limitsSchema!.safeParse(limits).success).toBe(true);
    expect(limitsSchema!.safeParse({ ...limits, timeoutMs: 10 }).success).toBe(false);
    expect(cardSchema!.safeParse({
      ...definition,
      available: false,
      enabled: false,
      controlState: 'missing',
      controlVersion: 0,
      limits,
    }).success).toBe(true);
    expect(cardSchema!.safeParse({
      ...definition,
      available: false,
      enabled: true,
      controlState: 'missing',
      controlVersion: 0,
      limits,
    }).success).toBe(false);
  });

  it('accepts only body-free input, evidence, and output references', () => {
    const inputSchema = schema('AgentInputRefSchema');
    const evidenceSchema = schema('AgentEvidenceRefSchema');
    const outputSchema = schema('AgentOutputRefSchema');
    expect(inputSchema).toBeDefined();
    expect(evidenceSchema).toBeDefined();
    expect(outputSchema).toBeDefined();

    expect(inputSchema!.safeParse({ kind: 'customer', id: 'customer-1', version: 0 }).success).toBe(true);
    expect(inputSchema!.safeParse({ kind: 'customer', id: 'customer-1', version: null }).success).toBe(false);
    expect(inputSchema!.safeParse({
      kind: 'source_artifact', id: 'source-1', version: 0, body: 'meeting transcript',
    }).success).toBe(false);
    expect(evidenceSchema!.safeParse(runView.evidenceRefs[0]).success).toBe(true);
    expect(evidenceSchema!.safeParse({
      ...runView.evidenceRefs[0], excerpt: 'private source sentence',
    }).success).toBe(false);
    expect(outputSchema!.safeParse(runView.outputRefs[0]).success).toBe(true);
    expect(outputSchema!.safeParse({ kind: 'customer', id: 'customer-1', version: 4 }).success).toBe(false);
    expect(outputSchema!.safeParse({
      kind: 'review_batch', id: 'batch-1', version: 0, token: 'credential',
    }).success).toBe(false);
    expect(outputSchema!.safeParse({
      kind: 'research_brief', id: 'model response: private customer detail', version: 0,
    }).success).toBe(false);
    expect(outputSchema!.safeParse({
      kind: 'research_brief', id: 'x'.repeat(161), version: 0,
    }).success).toBe(false);
  });

  it('publishes a strict metadata-only run view with safe counters and stable failure codes', () => {
    const viewSchema = schema('AgentRunViewSchema');
    expect(viewSchema, 'AgentRunViewSchema must be exported').toBeDefined();
    expect(viewSchema!.safeParse(runView).success).toBe(true);
    expect(viewSchema!.safeParse({ ...runView, rawResponse: 'private model output' }).success).toBe(false);
    expect(viewSchema!.safeParse({ ...runView, authorizationFingerprint: 'not-a-hash' }).success).toBe(false);
    expect(viewSchema!.safeParse({
      ...runView,
      inputRefs: runView.inputRefs.filter((ref) => ref.kind !== 'matter'),
    }).success).toBe(false);
    expect(viewSchema!.safeParse({
      ...runView,
      outputRefs: [{ kind: 'research_brief', id: 'brief-1', version: 0 }],
    }).success).toBe(false);
    expect(viewSchema!.safeParse({
      ...runView,
      status: 'failed',
      failureCode: '',
    }).success).toBe(false);
  });
});
