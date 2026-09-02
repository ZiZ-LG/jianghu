import {
  AgentManualRunRequestSchema,
  PostMeetingFeishuImportRequestSchema,
  PostMeetingSourceImportReceiptSchema,
  PostMeetingUploadMetadataSchema,
  type AgentManualRunRequest,
  type PostMeetingFeishuImportRequest,
  type PostMeetingSourceImportReceipt,
  type PostMeetingSourceOption,
  type PostMeetingUploadMetadata,
} from '@jianghu/domain-contracts';

export interface StablePostMeetingImportSubmission {
  kind: 'feishu' | 'upload';
  canonicalRequest: string;
  idempotencyKey: string;
  fileDigest?: string;
}

export interface StablePostMeetingLifecycleSubmission {
  canonicalRequest: string;
  idempotencyKey: string;
}

export interface PostMeetingUploadFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function invalidImportResponse(): never {
  throw new Error('invalid_post_meeting_import_response');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(file: PostMeetingUploadFile): Promise<string> {
  const bytes = await file.arrayBuffer();
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function stableFeishuImportSubmission(
  request: PostMeetingFeishuImportRequest,
  previous: StablePostMeetingImportSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): StablePostMeetingImportSubmission {
  const parsed = PostMeetingFeishuImportRequestSchema.parse(request);
  const canonicalRequest = JSON.stringify({ kind: 'feishu', request: parsed });
  if (previous?.kind === 'feishu' && previous.canonicalRequest === canonicalRequest) return previous;
  return { kind: 'feishu', canonicalRequest, idempotencyKey: createKey() };
}

export async function stableUploadImportSubmission(
  input: { file: PostMeetingUploadFile; metadata: PostMeetingUploadMetadata },
  previous: StablePostMeetingImportSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): Promise<StablePostMeetingImportSubmission & { kind: 'upload'; fileDigest: string }> {
  const metadata = PostMeetingUploadMetadataSchema.parse(input.metadata);
  const fileDigest = await sha256(input.file);
  const canonicalRequest = JSON.stringify({
    kind: 'upload',
    metadata,
    file: {
      name: input.file.name.normalize('NFC'),
      size: input.file.size,
      type: input.file.type.toLowerCase(),
      digest: fileDigest,
    },
  });
  if (previous?.kind === 'upload'
    && previous.canonicalRequest === canonicalRequest
    && previous.fileDigest === fileDigest) {
    return previous as StablePostMeetingImportSubmission & { kind: 'upload'; fileDigest: string };
  }
  return {
    kind: 'upload', canonicalRequest, idempotencyKey: createKey(), fileDigest,
  };
}

export function exactPostMeetingImportReceipt(
  raw: unknown,
  anchor: { customerId: string; matterId: string },
  expectedKind: 'transcript' | 'uploaded_file',
): PostMeetingSourceImportReceipt {
  const parsed = PostMeetingSourceImportReceiptSchema.safeParse(raw);
  if (!parsed.success
    || parsed.data.source.customerId !== anchor.customerId
    || parsed.data.source.matterId !== anchor.matterId
    || parsed.data.source.kind !== expectedKind) {
    invalidImportResponse();
  }
  return parsed.data;
}

export function buildPostMeetingRunInput(input: {
  job: {
    jobKey: string;
    jobVersion: string;
    available: boolean;
    enabled: boolean;
  };
  customer: { id: string; version: number; archivedAt: string | null };
  matter: {
    id: string;
    customerId: string;
    version: number;
    archivedAt: string | null;
  };
  source: PostMeetingSourceOption;
}): AgentManualRunRequest {
  const { job, customer, matter, source } = input;
  if (job.jobKey !== 'post_meeting_extract' || !job.available || !job.enabled) {
    throw new Error('post_meeting_job_unavailable');
  }
  if (customer.archivedAt !== null
    || matter.archivedAt !== null
    || matter.customerId !== customer.id
    || source.customerId !== customer.id
    || source.matterId !== matter.id) {
    throw new Error('post_meeting_anchor_mismatch');
  }
  return AgentManualRunRequestSchema.parse({
    jobVersion: job.jobVersion,
    customerId: customer.id,
    matterId: matter.id,
    sourceArtifactId: source.id,
    inputRefs: [
      { kind: 'customer', id: customer.id, version: customer.version },
      { kind: 'matter', id: matter.id, version: matter.version },
      { kind: 'source_artifact', id: source.id, version: source.version },
    ],
  });
}

export function postMeetingRunOutcome(
  source: PostMeetingSourceOption,
  run: {
    status: 'running' | 'succeeded' | 'failed' | 'discarded';
    failureCode: string;
    outputRefs: Array<{ kind: string; id: string; version: number }>;
  },
): {
  selectedSourceId: string;
  reviewBatchId: string | null;
  errorCode: string;
  canRetry: boolean;
} {
  const reviewBatchId = run.outputRefs.find((ref) => ref.kind === 'review_batch')?.id ?? null;
  const succeeded = run.status === 'succeeded' && reviewBatchId !== null;
  return {
    selectedSourceId: source.id,
    reviewBatchId,
    errorCode: succeeded ? '' : run.failureCode || 'post_meeting_run_incomplete',
    canRetry: !succeeded && run.status !== 'running',
  };
}

export function reconcilePostMeetingSourceSelection(
  sources: readonly PostMeetingSourceOption[],
  currentSourceId: string,
  preferredSourceId: string | null,
): string {
  if (preferredSourceId && sources.some((source) => source.id === preferredSourceId)) {
    return preferredSourceId;
  }
  if (currentSourceId && sources.some((source) => source.id === currentSourceId)) {
    return currentSourceId;
  }
  return sources[0]?.id ?? '';
}

export function stablePostMeetingLifecycleSubmission(
  input: { action: 'degrade' | 'delete'; sourceId: string; expectedAclVersion: number },
  previous: StablePostMeetingLifecycleSubmission | null,
  createKey: () => string = () => crypto.randomUUID(),
): StablePostMeetingLifecycleSubmission {
  if (!input.sourceId || !Number.isSafeInteger(input.expectedAclVersion) || input.expectedAclVersion < 1) {
    throw new Error('post_meeting_lifecycle_input_invalid');
  }
  const canonicalRequest = JSON.stringify(input);
  if (previous?.canonicalRequest === canonicalRequest) return previous;
  return { canonicalRequest, idempotencyKey: createKey() };
}
