import {
  AgentManualRunRequestSchema,
  AgentRunReceiptSchema,
  PostMeetingJobCardsResponseSchema,
  PostMeetingRunListResponseSchema,
  RelationshipRadarResponseSchema,
  type AgentJobCard,
  type AgentManualRunRequest,
  type AgentRunReceipt,
  type AgentRunView,
  type RelationshipRadarResponse,
} from '@jianghu/domain-contracts';

interface CustomerAnchor {
  id: string;
  version: number;
  archivedAt: string | null;
}

interface MatterAnchor {
  id: string;
  customerId: string;
  version: number;
  archivedAt: string | null;
}

export interface StableRelationshipRadarRunSubmission {
  idempotencyKey: string;
  canonicalRequest: string;
  request: AgentManualRunRequest;
}

function invalid(label: string): never {
  throw new Error(`invalid_relationship_radar_response:${label}`);
}

export function parseRelationshipRadar(
  raw: unknown,
  customerId: string,
  matterId: string,
): RelationshipRadarResponse {
  const parsed = RelationshipRadarResponseSchema.safeParse(raw);
  if (!parsed.success
    || parsed.data.customerId !== customerId
    || parsed.data.matterId !== matterId) invalid('projection');
  return parsed.data;
}

export function parseRelationshipRadarJobCards(raw: unknown): { items: AgentJobCard[] } {
  const parsed = PostMeetingJobCardsResponseSchema.safeParse(raw);
  if (!parsed.success) invalid('job_cards');
  return { items: parsed.data.items.filter((item) => item.jobKey === 'relationship_radar') };
}

export function parseRelationshipRadarRuns(
  raw: unknown,
  customerId: string,
  matterId: string,
): { items: AgentRunView[]; nextCursor: string | null } {
  const parsed = PostMeetingRunListResponseSchema.safeParse(raw);
  if (!parsed.success) invalid('runs');
  return {
    items: parsed.data.items.filter((run) => (
      run.jobKey === 'relationship_radar'
      && run.jobVersion === 'saas-212.v1'
      && run.customerId === customerId
      && run.matterId === matterId
    )),
    nextCursor: parsed.data.nextCursor,
  };
}

export function buildRelationshipRadarRunInput(input: {
  job: AgentJobCard;
  customer: CustomerAnchor;
  matter: MatterAnchor;
}): AgentManualRunRequest {
  if (input.job.jobKey !== 'relationship_radar'
    || input.job.jobVersion !== 'saas-212.v1'
    || input.job.actionMode !== 'draft'
    || !input.job.available) {
    throw new Error('relationship_radar_job_invalid');
  }
  if (input.customer.archivedAt !== null || input.customer.version < 0) {
    throw new Error('relationship_radar_customer_invalid');
  }
  if (input.matter.archivedAt !== null
    || input.matter.customerId !== input.customer.id
    || input.matter.version < 0) {
    throw new Error('relationship_radar_matter_invalid');
  }
  return AgentManualRunRequestSchema.parse({
    jobVersion: input.job.jobVersion,
    customerId: input.customer.id,
    matterId: input.matter.id,
    sourceArtifactId: null,
    inputRefs: [
      { kind: 'customer', id: input.customer.id, version: input.customer.version },
      { kind: 'matter', id: input.matter.id, version: input.matter.version },
    ],
  });
}

export function stableRelationshipRadarRunSubmission(
  request: AgentManualRunRequest,
  previous: StableRelationshipRadarRunSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): StableRelationshipRadarRunSubmission {
  const parsed = AgentManualRunRequestSchema.parse(request);
  const canonicalRequest = JSON.stringify(parsed);
  if (previous?.canonicalRequest === canonicalRequest) return previous;
  return { idempotencyKey: createKey(), canonicalRequest, request: parsed };
}

export function parseRelationshipRadarRunReceipt(
  raw: unknown,
  expected: AgentManualRunRequest,
): AgentRunReceipt {
  const parsed = AgentRunReceiptSchema.safeParse(raw);
  if (!parsed.success
    || parsed.data.run.jobKey !== 'relationship_radar'
    || parsed.data.run.jobVersion !== expected.jobVersion
    || parsed.data.run.customerId !== expected.customerId
    || parsed.data.run.matterId !== expected.matterId
    || parsed.data.run.sourceArtifactId !== null
    || JSON.stringify(parsed.data.run.inputRefs) !== JSON.stringify(expected.inputRefs)) {
    invalid('run_receipt');
  }
  return parsed.data;
}
