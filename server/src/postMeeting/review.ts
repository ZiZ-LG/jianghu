import {
  CreateCommitmentCommandSchema,
  PostMeetingReviewBatchDetailSchema,
  type CapabilityPolicy,
  type PostMeetingPersonEndpoint,
  type PostMeetingReviewBatchDetail,
  type PostMeetingReviewItem,
} from '@jianghu/domain-contracts';
import { Prisma } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  readableReviewBatchById,
  type ReviewBatchContext,
} from '../reviewBatches/service.js';

const candidateDetailSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  targetKind: true,
  targetId: true,
  fieldKey: true,
  oldValue: true,
  newValue: true,
  payload: true,
  source: true,
  sourceRef: true,
  evidence: true,
  confidence: true,
  sourceArtifactId: true,
  reviewBatchId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
} as const;
type CandidateDetail = Prisma.CandidateGetPayload<{ select: typeof candidateDetailSelect }>;

const sourceDetailSelect = {
  id: true,
  tenantId: true,
  artifactKind: true,
  title: true,
  sourceFingerprint: true,
  occurredAt: true,
} as const;

const ITEM_LOCATOR = /^(item-\d{3}):chars:(\d+)-(\d+)$/;

function parseSourceRef(value: string): { itemRef: string; sourceLocator: string } | null {
  const prefix = 'post-meeting:';
  if (!value.startsWith(prefix)) return null;
  const separator = value.indexOf('@', prefix.length);
  if (separator <= prefix.length || separator === value.length - 1) return null;
  const runId = value.slice(prefix.length, separator);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(runId)) return null;
  const sourceLocator = value.slice(separator + 1);
  const match = ITEM_LOCATOR.exec(sourceLocator);
  if (!match) return null;
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
  return { itemRef: match[1]!, sourceLocator };
}

function parseEncodedValue(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' || parsed === null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pendingPersonCandidateId(payload: string): string | null | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as { pendingPersonCandidateId?: unknown }).pendingPersonCandidateId;
    if (value === undefined) return null;
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function sourceTitle(kind: 'transcript' | 'uploaded_file' | 'note', title: string): string {
  const value = title.trim();
  if (value) return value;
  if (kind === 'transcript') return '会议转写';
  if (kind === 'uploaded_file') return '上传文件';
  return '会后记录';
}

function commonItem(candidate: CandidateDetail) {
  const identity = parseSourceRef(candidate.sourceRef);
  if (!identity || !candidate.evidence.trim()) return null;
  return {
    candidateId: candidate.id,
    status: candidate.status as 'pending' | 'accepted' | 'rejected',
    itemRef: identity.itemRef,
    expectedVersion: candidate.version,
    expectedAclVersion: candidate.aclVersion,
    sourceLocator: identity.sourceLocator,
    sourceQuote: candidate.evidence,
    confidence: candidate.confidence,
    defaultSelected: false as const,
  };
}

function strictCommitment(candidate: CandidateDetail) {
  try {
    const parsed = JSON.parse(candidate.payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'command') return null;
    const command = CreateCommitmentCommandSchema.safeParse(
      (parsed as { command?: unknown }).command,
    );
    if (!command.success
      || command.data.commitment.customerId !== candidate.accountId
      || command.data.commitment.matterId !== candidate.matterId) return null;
    return command.data;
  } catch {
    return null;
  }
}

async function projectPostMeetingItems(
  db: DbClient,
  ctx: ReviewBatchContext,
  batchId: string,
  candidates: readonly CandidateDetail[],
): Promise<PostMeetingReviewItem[] | null> {
  const personLegacyIds = candidates
    .filter((candidate) => candidate.kind === 'person_create' && candidate.legacySourceId)
    .map((candidate) => candidate.legacySourceId!);
  const relationLegacyIds = candidates
    .filter((candidate) => candidate.kind === 'relation_create' && candidate.legacySourceId)
    .map((candidate) => candidate.legacySourceId!);
  const fieldLegacyIds = candidates
    .filter((candidate) => candidate.kind === 'field_change' && candidate.legacySourceId)
    .map((candidate) => candidate.legacySourceId!);
  const evidenceLegacyIds = candidates
    .filter((candidate) => candidate.kind === 'evidence_create' && candidate.legacySourceId)
    .map((candidate) => candidate.legacySourceId!);
  const [people, relations, fields, evidence] = await Promise.all([
    db.personSuggestion.findMany({
      where: { tenantId: ctx.tenantId, id: { in: personLegacyIds } },
      select: {
        id: true, accountId: true, opportunityId: true, name: true, title: true,
        origin: true, evidence: true, confidence: true,
      },
    }),
    db.relSuggestion.findMany({
      where: { tenantId: ctx.tenantId, id: { in: relationLegacyIds } },
      select: {
        id: true, opportunityId: true, sourcePersonId: true, targetPersonId: true,
        sourceKind: true, targetKind: true, layer: true, label: true,
        origin: true, evidence: true, confidence: true,
      },
    }),
    db.changeProposal.findMany({
      where: { tenantId: ctx.tenantId, id: { in: fieldLegacyIds } },
      select: {
        id: true, accountId: true, opportunityId: true, entityKind: true,
        entityId: true, field: true, oldValue: true, newValue: true,
        origin: true, evidence: true, confidence: true,
      },
    }),
    db.evidenceEvent.findMany({
      where: { tenantId: ctx.tenantId, id: { in: evidenceLegacyIds } },
      select: {
        id: true, accountId: true, opportunityId: true, personId: true,
        signalKey: true, direction: true, tier: true, rawContent: true,
        occurredAt: true, origin: true,
      },
    }),
  ]);
  const personById = new Map(people.map((row) => [row.id, row]));
  const relationById = new Map(relations.map((row) => [row.id, row]));
  const fieldById = new Map(fields.map((row) => [row.id, row]));
  const evidenceById = new Map(evidence.map((row) => [row.id, row]));
  const personCandidateByLegacyId = new Map<string, { candidateId: string; itemRef: string }>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'person_create' || !candidate.legacySourceId) continue;
    const identity = parseSourceRef(candidate.sourceRef);
    if (!identity) return null;
    personCandidateByLegacyId.set(candidate.legacySourceId, {
      candidateId: candidate.id,
      itemRef: identity.itemRef,
    });
  }
  const endpoint = (kind: string, id: string): PostMeetingPersonEndpoint | null => {
    if (kind === 'person') return { kind: 'existing_person', personId: id };
    if (kind !== 'suggestion') return null;
    const pending = personCandidateByLegacyId.get(id);
    return pending ? { kind: 'new_person', itemRef: pending.itemRef } : null;
  };

  const items: PostMeetingReviewItem[] = [];
  for (const candidate of candidates) {
    if (candidate.tenantId !== ctx.tenantId
      || candidate.reviewBatchId !== batchId
      || candidate.source !== 'post_meeting_extract') return null;
    const common = commonItem(candidate);
    if (!common) return null;
    if (candidate.kind === 'person_create') {
      if (candidate.legacySourceKind !== 'PersonSuggestion' || !candidate.legacySourceId) return null;
      const row = personById.get(candidate.legacySourceId);
      if (!row
        || row.accountId !== candidate.accountId
        || row.opportunityId !== candidate.matterId
        || row.origin !== candidate.source
        || row.evidence !== candidate.evidence
        || row.confidence !== candidate.confidence) return null;
      items.push({
        kind: 'person', ...common, before: null,
        after: { name: row.name, title: row.title.trim() ? row.title : null },
      });
      continue;
    }
    if (candidate.kind === 'relation_create') {
      if (candidate.legacySourceKind !== 'RelSuggestion' || !candidate.legacySourceId) return null;
      const row = relationById.get(candidate.legacySourceId);
      const sourcePerson = row ? endpoint(row.sourceKind, row.sourcePersonId) : null;
      const targetPerson = row ? endpoint(row.targetKind, row.targetPersonId) : null;
      if (!row || !sourcePerson || !targetPerson
        || row.opportunityId !== candidate.matterId
        || row.origin !== candidate.source
        || row.evidence !== candidate.evidence
        || row.confidence !== candidate.confidence) return null;
      items.push({
        kind: 'relation', ...common, before: null,
        after: {
          sourcePerson, targetPerson,
          layer: row.layer as 'L1' | 'L2' | 'L3' | 'L4',
          label: row.label.trim() ? row.label : null,
        },
      });
      continue;
    }
    if (candidate.kind === 'field_change') {
      if (candidate.legacySourceKind !== 'ChangeProposal' || !candidate.legacySourceId) return null;
      const row = fieldById.get(candidate.legacySourceId);
      const before = parseEncodedValue(candidate.oldValue);
      const after = parseEncodedValue(candidate.newValue);
      if (!row || before === undefined || after === undefined
        || row.accountId !== candidate.accountId
        || row.opportunityId !== candidate.matterId
        || row.entityKind !== candidate.targetKind
        || row.entityId !== candidate.targetId
        || row.field !== candidate.fieldKey
        || row.oldValue !== candidate.oldValue
        || row.newValue !== candidate.newValue
        || row.origin !== candidate.source
        || row.evidence !== candidate.evidence
        || row.confidence !== candidate.confidence) return null;
      const target = candidate.targetKind === 'customer'
        && (candidate.fieldKey === 'name' || candidate.fieldKey === 'categoryKey')
        ? {
          kind: 'customer' as const,
          field: candidate.fieldKey as 'name' | 'categoryKey',
        }
        : candidate.targetKind === 'matter'
          && (candidate.fieldKey === 'title' || candidate.fieldKey === 'kind'
            || candidate.fieldKey === 'priority' || candidate.fieldKey === 'targetDate')
          ? {
            kind: 'matter' as const,
            field: candidate.fieldKey as 'title' | 'kind' | 'priority' | 'targetDate',
          }
          : null;
      if (!target) return null;
      items.push({ kind: 'field', ...common, target, before, after });
      continue;
    }
    if (candidate.kind === 'evidence_create') {
      if (candidate.legacySourceKind !== 'EvidenceEvent' || !candidate.legacySourceId) return null;
      const row = evidenceById.get(candidate.legacySourceId);
      const pendingId = pendingPersonCandidateId(candidate.payload);
      if (!row || pendingId === undefined
        || row.accountId !== candidate.accountId
        || row.opportunityId !== candidate.matterId
        || row.personId !== candidate.targetId
        || row.origin !== candidate.source
        || row.rawContent !== candidate.evidence) return null;
      const pending = pendingId ? candidates.find((item) => item.id === pendingId) : null;
      const person = pendingId
        ? pending && pending.reviewBatchId === batchId && pending.kind === 'person_create'
          ? { kind: 'new_person' as const, itemRef: parseSourceRef(pending.sourceRef)?.itemRef ?? '' }
          : null
        : { kind: 'existing_person' as const, personId: row.personId };
      if (!person || (person.kind === 'new_person' && !person.itemRef)) return null;
      items.push({
        kind: 'evidence', ...common, before: null,
        after: {
          person,
          signalKey: row.signalKey,
          direction: row.direction as -1 | 0 | 1,
          tier: row.tier as 'weak' | 'mid' | 'strong',
          occurredAt: row.occurredAt,
        },
      });
      continue;
    }
    if (candidate.kind === 'commitment_create') {
      if (candidate.legacySourceKind !== null || candidate.legacySourceId !== null) return null;
      const command = strictCommitment(candidate);
      if (!command) return null;
      items.push({ kind: 'commitment', ...common, before: null, after: command });
      continue;
    }
    return null;
  }
  return items.sort((left, right) => left.itemRef.localeCompare(right.itemRef));
}

export type ReadableReviewBatchTransport =
  | { kind: 'legacy'; view: unknown }
  | { kind: 'post_meeting'; view: PostMeetingReviewBatchDetail };

/**
 * Returns metadata-only legacy batches and a strict, body-free projection for
 * post-meeting batches. Quotes require Candidate review access; viewer and any
 * malformed/mixed authority graph receive the same scoped-not-found result.
 */
export async function readableReviewBatchTransport(
  db: DbClient,
  ctx: ReviewBatchContext,
  policy: CapabilityPolicy,
  id: string,
): Promise<ReadableReviewBatchTransport | null> {
  const readable = await readableReviewBatchById(db, ctx, policy, id, 'read');
  if (!readable) return null;
  const producerMarkers = await db.candidate.findMany({
    where: {
      tenantId: ctx.tenantId,
      reviewBatchId: id,
      id: { in: readable.candidates.map((candidate) => candidate.id) },
    },
    orderBy: { id: 'asc' },
    select: { id: true, source: true },
  });
  if (producerMarkers.length !== readable.candidates.length) return null;
  const postMeetingCount = producerMarkers.filter(
    (candidate) => candidate.source === 'post_meeting_extract',
  ).length;
  if (postMeetingCount === 0) return { kind: 'legacy', view: readable.view };
  if (postMeetingCount !== producerMarkers.length) return null;
  const reviewable = await readableReviewBatchById(db, ctx, policy, id, 'review');
  if (!reviewable) return null;
  const [source, candidates] = await Promise.all([
    db.sourceArtifact.findFirst({
      where: {
        id: reviewable.batch.sourceArtifactId,
        tenantId: ctx.tenantId,
      },
      select: sourceDetailSelect,
    }),
    db.candidate.findMany({
      where: {
        tenantId: ctx.tenantId,
        reviewBatchId: id,
        id: { in: reviewable.candidates.map((candidate) => candidate.id) },
      },
      orderBy: { id: 'asc' },
      select: candidateDetailSelect,
    }),
  ]);
  if (candidates.length !== reviewable.candidates.length) return null;
  if (!source || !['transcript', 'uploaded_file', 'note'].includes(source.artifactKind)) return null;
  const items = await projectPostMeetingItems(db, ctx, id, candidates);
  if (!items) return null;
  const kind = source.artifactKind as 'transcript' | 'uploaded_file' | 'note';
  const parsed = PostMeetingReviewBatchDetailSchema.safeParse({
    id: reviewable.batch.id,
    source: {
      id: source.id,
      title: sourceTitle(kind, source.title),
      kind,
      fingerprint: source.sourceFingerprint,
      occurredAt: source.occurredAt?.toISOString() ?? null,
    },
    customerId: reviewable.batch.accountId,
    matterId: reviewable.batch.matterId,
    status: reviewable.batch.status,
    activityKind: reviewable.batch.activityKind.trim() || null,
    occurredAt: reviewable.batch.occurredAt?.toISOString() ?? null,
    interactionId: reviewable.batch.interactionId,
    acceptanceVersion: reviewable.batch.acceptanceVersion,
    version: reviewable.batch.version,
    createdAt: reviewable.batch.createdAt.toISOString(),
    updatedAt: reviewable.batch.updatedAt.toISOString(),
    items,
  });
  return parsed.success ? { kind: 'post_meeting', view: parsed.data } : null;
}
