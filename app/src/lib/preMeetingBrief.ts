import {
  AgentManualRunRequestSchema,
  AgentRunViewSchema,
  PostMeetingJobCardsResponseSchema,
  PostMeetingRunListResponseSchema,
  ResearchBriefSnapshotDetailResponseSchema,
  ResearchBriefSnapshotListResponseSchema,
  type AgentJobCard,
  type AgentManualRunRequest,
  type AgentRunView,
  type PostMeetingSourceOption,
  type ResearchBriefSnapshotDetail,
  type ResearchBriefSnapshotListResponse,
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

export interface StablePreMeetingRunSubmission {
  idempotencyKey: string;
  canonicalRequest: string;
  request: AgentManualRunRequest;
}

function invalid(label: string): never {
  throw new Error(`invalid_pre_meeting_response:${label}`);
}

export function parsePreMeetingJobCards(raw: unknown): { items: AgentJobCard[] } {
  const parsed = PostMeetingJobCardsResponseSchema.safeParse(raw);
  if (!parsed.success) invalid('job_cards');
  return {
    items: parsed.data.items.filter((card) => card.jobKey === 'pre_meeting_brief'),
  };
}

export function parsePreMeetingRuns(raw: unknown): {
  items: AgentRunView[];
  nextCursor: string | null;
} {
  const parsed = PostMeetingRunListResponseSchema.safeParse(raw);
  if (!parsed.success) invalid('runs');
  return {
    items: parsed.data.items.filter((run) => run.jobKey === 'pre_meeting_brief'),
    nextCursor: parsed.data.nextCursor,
  };
}

export function parsePreMeetingBriefList(raw: unknown): ResearchBriefSnapshotListResponse {
  const parsed = ResearchBriefSnapshotListResponseSchema.safeParse(raw);
  if (!parsed.success) invalid('brief_list');
  return parsed.data;
}

export function parsePreMeetingBriefDetail(
  raw: unknown,
  expectedId: string,
): ResearchBriefSnapshotDetail {
  const parsed = ResearchBriefSnapshotDetailResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.item.id !== expectedId) invalid('brief_detail');
  return parsed.data.item;
}

export function buildPreMeetingRunInput(input: {
  job: AgentJobCard;
  customer: CustomerAnchor;
  matter: MatterAnchor;
  source: PostMeetingSourceOption;
}): AgentManualRunRequest {
  if (input.job.jobKey !== 'pre_meeting_brief'
    || input.job.jobVersion !== 'core-206.v1'
    || input.job.actionMode !== 'read_only'
    || !input.job.available) {
    throw new Error('pre_meeting_job_invalid');
  }
  if (input.customer.archivedAt !== null || input.customer.version < 0) {
    throw new Error('pre_meeting_customer_invalid');
  }
  if (input.matter.archivedAt !== null
    || input.matter.customerId !== input.customer.id
    || input.matter.version < 0) {
    throw new Error('pre_meeting_matter_invalid');
  }
  if (input.source.customerId !== input.customer.id
    || input.source.matterId !== input.matter.id
    || input.source.version !== input.source.aclVersion) {
    throw new Error('pre_meeting_source_invalid');
  }
  return AgentManualRunRequestSchema.parse({
    jobVersion: input.job.jobVersion,
    customerId: input.customer.id,
    matterId: input.matter.id,
    sourceArtifactId: input.source.id,
    inputRefs: [
      { kind: 'customer', id: input.customer.id, version: input.customer.version },
      { kind: 'matter', id: input.matter.id, version: input.matter.version },
      { kind: 'source_artifact', id: input.source.id, version: input.source.version },
    ],
  });
}

export function stablePreMeetingRunSubmission(
  request: AgentManualRunRequest,
  previous: StablePreMeetingRunSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): StablePreMeetingRunSubmission {
  const parsed = AgentManualRunRequestSchema.parse(request);
  const canonicalRequest = JSON.stringify(parsed);
  if (previous?.canonicalRequest === canonicalRequest) return previous;
  return { idempotencyKey: createKey(), canonicalRequest, request: parsed };
}

export function preMeetingRunOutcome(run: AgentRunView): {
  briefId: string | null;
  errorCode: string;
  canRetry: boolean;
} {
  const parsed = AgentRunViewSchema.safeParse(run);
  if (!parsed.success || parsed.data.jobKey !== 'pre_meeting_brief') invalid('run_outcome');
  const briefOutputs = parsed.data.outputRefs.filter((output) => output.kind === 'research_brief');
  if (parsed.data.status === 'succeeded') {
    if (briefOutputs.length !== 1 || parsed.data.outputRefs.length !== 1) invalid('run_output');
    return { briefId: briefOutputs[0]!.id, errorCode: '', canRetry: false };
  }
  if (briefOutputs.length !== 0) invalid('failed_run_output');
  return {
    briefId: null,
    errorCode: parsed.data.failureCode,
    canRetry: parsed.data.status === 'failed',
  };
}
