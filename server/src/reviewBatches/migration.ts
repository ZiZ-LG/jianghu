import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  commitmentIdForReviewCandidate,
  edgeIdForReviewCandidate,
  personIdForReviewCandidate,
  REVIEW_CANDIDATE_KINDS,
  validateReviewBatchMetadata,
} from './model.js';

export const REVIEW_BATCH_MIGRATION_MARKER = 'CORE-205-review-batch-interaction-v1';
const REVIEW_BATCH_MIGRATION_VERSION = 1;

export type ReviewBatchSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface ReviewBatchMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  reviewBatches: number;
  interactions: number;
  attachedCandidates: number;
  conflicts: string[];
  contractChecksum: string;
}

export interface ReviewBatchMigrationApplyResult extends ReviewBatchMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  contractChecksum: string;
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function reviewBatchMigrationContractChecksum(): string {
  return sha256(JSON.stringify({
    marker: REVIEW_BATCH_MIGRATION_MARKER,
    version: REVIEW_BATCH_MIGRATION_VERSION,
    reviewCandidateAuthority: 'Candidate',
    reviewBatchStatuses: ['accepted', 'pending', 'rejected'],
    interactionBodyAuthority: 'SourceArtifact',
    acceptanceIdentity: ['reviewBatchId', 'acceptanceVersion'],
    formalKinds: ['commitment_create', 'evidence_create', 'field_change', 'person_create', 'relation_create'],
  }));
}

function markerDetails(): MarkerDetails {
  const value = {
    version: REVIEW_BATCH_MIGRATION_VERSION,
    contractChecksum: reviewBatchMigrationContractChecksum(),
  };
  return { ...value, integrityChecksum: sha256(JSON.stringify(value)) };
}

function markerValid(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    const expected = markerDetails();
    return value.version === expected.version
      && value.contractChecksum === expected.contractChecksum
      && value.integrityChecksum === expected.integrityChecksum;
  } catch {
    return false;
  }
}

function prismaCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissingTable(error: unknown): boolean {
  if (prismaCode(error) === 'P2021') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('no such table') || message.includes('does not exist');
}

const batchSelect = {
  id: true,
  tenantId: true,
  sourceArtifactId: true,
  accountId: true,
  matterId: true,
  status: true,
  activityKind: true,
  occurredAt: true,
  interactionId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  acceptanceVersion: true,
  version: true,
  lastAcceptanceVersion: true,
  lastAcceptanceHash: true,
  lastAcceptanceResult: true,
  reviewedByUserId: true,
  reviewedAt: true,
} as const;

const candidateSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  targetKind: true,
  targetId: true,
  sourceArtifactId: true,
  reviewBatchId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
} as const;

const interactionSelect = {
  id: true,
  tenantId: true,
  accountId: true,
  matterId: true,
  sourceArtifactId: true,
  activityKind: true,
  occurredAt: true,
  createdByUserId: true,
  confirmedByUserId: true,
  version: true,
} as const;

type BatchRow = Prisma.ReviewBatchGetPayload<{ select: typeof batchSelect }>;
type InteractionRow = Prisma.InteractionGetPayload<{ select: typeof interactionSelect }>;
type CandidateRow = Prisma.CandidateGetPayload<{ select: typeof candidateSelect }>;

function formalReceiptMatchesCandidate(
  candidate: CandidateRow,
  item: { formalKind: string | null; formalId: string | null },
): boolean {
  if (candidate.kind === 'person_create') {
    return candidate.legacySourceKind === 'PersonSuggestion'
      && item.formalKind === 'person'
      && item.formalId === personIdForReviewCandidate(candidate.tenantId, candidate.id);
  }
  if (candidate.kind === 'relation_create') {
    return candidate.legacySourceKind === 'RelSuggestion'
      && item.formalKind === 'relation'
      && item.formalId === edgeIdForReviewCandidate(candidate.tenantId, candidate.id);
  }
  if (candidate.kind === 'field_change') {
    return candidate.legacySourceKind === 'ChangeProposal'
      && item.formalKind === candidate.targetKind
      && item.formalId === candidate.targetId;
  }
  if (candidate.kind === 'evidence_create') {
    return candidate.legacySourceKind === 'EvidenceEvent'
      && item.formalKind === 'evidence'
      && item.formalId === candidate.legacySourceId;
  }
  return candidate.kind === 'commitment_create'
    && item.formalKind === 'commitment'
    && item.formalId === commitmentIdForReviewCandidate(candidate.tenantId, candidate.id);
}

async function inspect(db: DbClient): Promise<ReviewBatchMigrationReport> {
  const contractChecksum = reviewBatchMigrationContractChecksum();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: REVIEW_BATCH_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) conflicts.push('review_batch_marker_invalid');

  const attachedCandidates = await db.candidate.findMany({
    where: { OR: [{ sourceArtifactId: { not: null } }, { reviewBatchId: { not: null } }] },
    orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    select: candidateSelect,
  });

  let batches: BatchRow[];
  let interactions: InteractionRow[];
  try {
    [batches, interactions] = await Promise.all([
      db.reviewBatch.findMany({ orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: batchSelect }),
      db.interaction.findMany({ orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: interactionSelect }),
    ]);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    for (const candidate of attachedCandidates) {
      conflicts.push(`${candidate.tenantId}:candidate:${candidate.id}:batch_missing`);
    }
    if (markerPresent) conflicts.push('review_batch_marker_without_schema');
    return {
      ok: conflicts.length === 0,
      markerPresent,
      reviewBatches: 0,
      interactions: 0,
      attachedCandidates: attachedCandidates.length,
      conflicts,
      contractChecksum,
    };
  }

  const tenantIds = [...new Set([
    ...batches.map((row) => row.tenantId),
    ...interactions.map((row) => row.tenantId),
    ...attachedCandidates.map((row) => row.tenantId),
  ])];
  const [users, accounts, matters, artifacts] = await Promise.all([
    db.user.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true } }),
    db.account.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, archivedAt: true } }),
    db.opportunity.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true, accountId: true, archivedAt: true },
    }),
    db.sourceArtifact.findMany({
      where: { tenantId: { in: tenantIds } },
      select: {
        id: true, tenantId: true, accountId: true, matterId: true,
        createdByUserId: true, visibility: true, aclVersion: true,
      },
    }),
  ]);
  const userKeys = new Set(users.map((row) => `${row.tenantId}\0${row.id}`));
  const accountByKey = new Map(accounts.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  const matterByKey = new Map(matters.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  const artifactByKey = new Map(artifacts.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  const batchByKey = new Map(batches.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  const interactionByKey = new Map(interactions.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  const batchesByInteraction = new Map<string, BatchRow[]>();
  for (const batch of batches) {
    if (!batch.interactionId) continue;
    const key = `${batch.tenantId}\0${batch.interactionId}`;
    const list = batchesByInteraction.get(key) ?? [];
    list.push(batch);
    batchesByInteraction.set(key, list);
  }
  const candidatesByBatch = new Map<string, typeof attachedCandidates>();
  for (const candidate of attachedCandidates) {
    if (!candidate.reviewBatchId) continue;
    const key = `${candidate.tenantId}\0${candidate.reviewBatchId}`;
    const list = candidatesByBatch.get(key) ?? [];
    list.push(candidate);
    candidatesByBatch.set(key, list);
  }

  const parentValid = (tenantId: string, accountId: string, matterId: string | null): boolean => {
    const account = accountByKey.get(`${tenantId}\0${accountId}`);
    if (!account || account.archivedAt) return false;
    if (!matterId) return true;
    const matter = matterByKey.get(`${tenantId}\0${matterId}`);
    return Boolean(matter && !matter.archivedAt && matter.accountId === accountId);
  };

  for (const batch of batches) {
    const prefix = `${batch.tenantId}:review_batch:${batch.id}`;
    const metadata = validateReviewBatchMetadata(batch);
    if (!metadata.ok) conflicts.push(`${prefix}:${metadata.code}`);
    const artifact = artifactByKey.get(`${batch.tenantId}\0${batch.sourceArtifactId}`);
    if (!artifact) conflicts.push(`${prefix}:source_artifact_missing`);
    if (!parentValid(batch.tenantId, batch.accountId, batch.matterId)) {
      conflicts.push(`${prefix}:parent_invalid`);
    }
    if (batch.createdByUserId && !userKeys.has(`${batch.tenantId}\0${batch.createdByUserId}`)) {
      conflicts.push(`${prefix}:creator_invalid`);
    }
    if (batch.reviewedByUserId && !userKeys.has(`${batch.tenantId}\0${batch.reviewedByUserId}`)) {
      conflicts.push(`${prefix}:reviewer_invalid`);
    }
    if (artifact && (artifact.accountId !== batch.accountId
      || artifact.matterId !== batch.matterId
      || artifact.createdByUserId !== batch.createdByUserId
      || artifact.visibility !== batch.visibility
      || artifact.aclVersion !== batch.aclVersion)) {
      conflicts.push(`${prefix}:source_authority_mismatch`);
    }
    const candidates = candidatesByBatch.get(`${batch.tenantId}\0${batch.id}`) ?? [];
    if (candidates.length === 0) conflicts.push(`${prefix}:candidate_required`);
    const pending = candidates.filter((candidate) => candidate.status === 'pending').length;
    const accepted = candidates.filter((candidate) => candidate.status === 'accepted').length;
    if (batch.status === 'pending' && pending === 0) conflicts.push(`${prefix}:pending_candidate_required`);
    if (batch.status !== 'pending' && pending > 0) conflicts.push(`${prefix}:closed_candidate_pending`);
    if (batch.status === 'accepted' && accepted === 0) conflicts.push(`${prefix}:accepted_candidate_required`);
    if (batch.status === 'rejected' && accepted > 0) conflicts.push(`${prefix}:rejected_candidate_accepted`);
    if (metadata.ok && batch.lastAcceptanceVersion !== null) {
      const receipt = JSON.parse(batch.lastAcceptanceResult) as {
        items: Array<{
          candidateId: string;
          status: string;
          formalKind: string | null;
          formalId: string | null;
        }>;
      };
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      if (receipt.items.some((item) => !candidateById.has(item.candidateId))) {
        conflicts.push(`${prefix}:acceptance_candidate_missing`);
      } else if (receipt.items.some((item) => candidateById.get(item.candidateId)?.status !== item.status)) {
        conflicts.push(`${prefix}:acceptance_candidate_status_mismatch`);
      } else if (receipt.items.some((item) => item.status === 'accepted'
        && !formalReceiptMatchesCandidate(candidateById.get(item.candidateId)!, item))) {
        conflicts.push(`${prefix}:acceptance_formal_identity_mismatch`);
      }
    }
    if (batch.interactionId) {
      const interaction = interactionByKey.get(`${batch.tenantId}\0${batch.interactionId}`);
      if (!interaction
        || interaction.accountId !== batch.accountId
        || interaction.matterId !== batch.matterId
        || interaction.sourceArtifactId !== batch.sourceArtifactId
        || interaction.activityKind !== batch.activityKind
        || interaction.occurredAt.getTime() !== batch.occurredAt?.getTime()
        || interaction.createdByUserId !== batch.createdByUserId) {
        conflicts.push(`${prefix}:interaction_mismatch`);
      }
    }
  }

  for (const candidate of attachedCandidates) {
    const prefix = `${candidate.tenantId}:candidate:${candidate.id}`;
    if (!candidate.sourceArtifactId) {
      conflicts.push(`${prefix}:batch_missing`);
      continue;
    }
    const artifact = artifactByKey.get(`${candidate.tenantId}\0${candidate.sourceArtifactId}`);
    if (!artifact
      || artifact.accountId !== candidate.accountId
      || artifact.matterId !== candidate.matterId
      || artifact.createdByUserId !== candidate.createdByUserId
      || artifact.visibility !== candidate.visibility
      || !Number.isSafeInteger(candidate.aclVersion)
      || candidate.aclVersion < 1) {
      conflicts.push(`${prefix}:source_authority_mismatch`);
      continue;
    }
    if (!candidate.reviewBatchId) {
      if (candidate.status !== 'pending') conflicts.push(`${prefix}:unbatched_status_invalid`);
      if (!Number.isSafeInteger(candidate.version) || candidate.version < 0) {
        conflicts.push(`${prefix}:version_invalid`);
      }
      continue;
    }
    const batch = batchByKey.get(`${candidate.tenantId}\0${candidate.reviewBatchId}`);
    if (!batch) {
      conflicts.push(`${prefix}:batch_missing`);
      continue;
    }
    if (candidate.sourceArtifactId !== batch.sourceArtifactId
      || candidate.accountId !== batch.accountId
      || candidate.matterId !== batch.matterId
      || candidate.createdByUserId !== batch.createdByUserId
      || candidate.visibility !== batch.visibility
      || !Number.isSafeInteger(candidate.aclVersion)
      || candidate.aclVersion < 1) {
      conflicts.push(`${prefix}:batch_authority_mismatch`);
    }
    if (!(REVIEW_CANDIDATE_KINDS as readonly string[]).includes(candidate.kind)) {
      conflicts.push(`${prefix}:kind_invalid`);
    }
    if (!['pending', 'accepted', 'rejected'].includes(candidate.status)) {
      conflicts.push(`${prefix}:status_invalid`);
    }
    if (!Number.isSafeInteger(candidate.version) || candidate.version < 0) conflicts.push(`${prefix}:version_invalid`);
  }

  for (const interaction of interactions) {
    const prefix = `${interaction.tenantId}:interaction:${interaction.id}`;
    if (!interaction.id || !interaction.activityKind.trim()
      || !Number.isSafeInteger(interaction.version) || interaction.version < 0) {
      conflicts.push(`${prefix}:metadata_invalid`);
    }
    if (!parentValid(interaction.tenantId, interaction.accountId, interaction.matterId)) {
      conflicts.push(`${prefix}:parent_invalid`);
    }
    if (!artifactByKey.has(`${interaction.tenantId}\0${interaction.sourceArtifactId}`)) {
      conflicts.push(`${prefix}:source_artifact_missing`);
    }
    if (!userKeys.has(`${interaction.tenantId}\0${interaction.confirmedByUserId}`)) {
      conflicts.push(`${prefix}:reviewer_invalid`);
    }
    if (interaction.createdByUserId
      && !userKeys.has(`${interaction.tenantId}\0${interaction.createdByUserId}`)) {
      conflicts.push(`${prefix}:creator_invalid`);
    }
    if (!(batchesByInteraction.get(`${interaction.tenantId}\0${interaction.id}`)?.length)) {
      conflicts.push(`${prefix}:review_batch_missing`);
    }
  }

  return {
    ok: conflicts.length === 0,
    markerPresent,
    reviewBatches: batches.length,
    interactions: interactions.length,
    attachedCandidates: attachedCandidates.length,
    conflicts,
    contractChecksum,
  };
}

export async function reportReviewBatchMigration(db: DbClient): Promise<ReviewBatchMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyReviewBatchMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<ReviewBatchMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('ReviewBatch migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok) throw new Error(before.conflicts.join(',') || 'ReviewBatch migration preflight failed');
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: REVIEW_BATCH_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: REVIEW_BATCH_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) throw new Error('injected ReviewBatch migration failure');
    } else if (!markerValid(existing.details)) {
      throw new Error('review_batch_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'ReviewBatch migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyReviewBatchMigration(db: DbClient): Promise<ReviewBatchMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const BATCH_COLUMNS = new Set([
  'id', 'tenantId', 'sourceArtifactId', 'accountId', 'matterId', 'status', 'activityKind',
  'occurredAt', 'interactionId', 'createdByUserId', 'visibility', 'aclVersion',
  'acceptanceVersion', 'version', 'lastAcceptanceVersion', 'lastAcceptanceHash',
  'lastAcceptanceResult', 'reviewedByUserId', 'reviewedAt', 'createdAt', 'updatedAt',
]);
const INTERACTION_COLUMNS = new Set([
  'id', 'tenantId', 'accountId', 'matterId', 'sourceArtifactId', 'activityKind', 'occurredAt',
  'title', 'createdByUserId', 'confirmedByUserId', 'version', 'createdAt', 'updatedAt',
]);
const BATCH_INDEXES = new Set([
  'ReviewBatch_tenantId_sourceArtifactId_status_idx',
  'ReviewBatch_tenantId_accountId_status_createdAt_idx',
  'ReviewBatch_tenantId_matterId_status_createdAt_idx',
  'ReviewBatch_tenantId_createdByUserId_visibility_idx',
  'ReviewBatch_tenantId_interactionId_idx',
]);
const INTERACTION_INDEXES = new Set([
  'Interaction_tenantId_sourceArtifactId_idx',
  'Interaction_tenantId_accountId_occurredAt_idx',
  'Interaction_tenantId_matterId_occurredAt_idx',
  'Interaction_tenantId_createdByUserId_idx',
]);

export async function inspectReviewBatchSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<ReviewBatchSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Candidate', 'ReviewBatch', 'Interaction')`,
  );
  const names = new Set(tables.map((table) => table.name));
  if (!names.has('Candidate')) return 'uninitialized';
  const present = Number(names.has('ReviewBatch')) + Number(names.has('Interaction'));
  if (present === 0) return 'legacy';
  if (present !== 2) return 'partial';
  const [batchColumns, interactionColumns, batchIndexes, interactionIndexes] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ReviewBatch")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("Interaction")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("ReviewBatch")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("Interaction")'),
  ]);
  const exact = (actual: readonly { name: string }[], expected: ReadonlySet<string>) => (
    actual.length === expected.size && actual.every((row) => expected.has(row.name))
  );
  const contains = (actual: readonly { name: string }[], expected: ReadonlySet<string>) => {
    const actualNames = new Set(actual.map((row) => row.name));
    return [...expected].every((name) => actualNames.has(name));
  };
  return exact(batchColumns, BATCH_COLUMNS)
    && exact(interactionColumns, INTERACTION_COLUMNS)
    && contains(batchIndexes, BATCH_INDEXES)
    && contains(interactionIndexes, INTERACTION_INDEXES)
    ? 'expanded'
    : 'partial';
}
