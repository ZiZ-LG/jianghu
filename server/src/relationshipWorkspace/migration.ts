import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';

export const HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER = 'SAAS-208-hypothesis-commitment-review-v1';
const HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_VERSION = 1;

export type HypothesisCommitmentReviewSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface HypothesisCommitmentReviewMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  schemaPresent: boolean;
  commitments: number;
  linkedCommitments: number;
  linkedEvidence: number;
  conflicts: string[];
  schemaFingerprint: string;
}

export interface HypothesisCommitmentReviewMigrationApplyResult
  extends HypothesisCommitmentReviewMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  schemaFingerprint: string;
  backfill: {
    commitmentRows: 0;
    evidenceLinkRows: 0;
    formalRows: 0;
  };
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const boundedId = (value: string | null): value is string => Boolean(
  value && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/u.test(value),
);

export function hypothesisCommitmentReviewMigrationSchemaFingerprint(): string {
  return sha256(JSON.stringify({
    marker: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER,
    version: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_VERSION,
    planActionColumns: [
      ['hypothesisId', 'String?'],
      ['hypothesisRevisionId', 'String?'],
      ['completionResult', 'String', ''],
      ['completionResultRecordedAtUtc', 'DateTime?'],
      ['completionResultRecordedByUserId', 'String?'],
      ['verificationReviewDisposition', 'String', ''],
      ['verificationReviewedAtUtc', 'DateTime?'],
      ['verificationReviewedByUserId', 'String?'],
    ],
    evidenceLinkColumns: [['verificationCommitmentId', 'String?']],
    indexes: [
      ['PlanAction', 'tenantId', 'hypothesisId', 'hypothesisRevisionId'],
      ['HypothesisEvidenceLink', 'tenantId', 'verificationCommitmentId'],
    ],
    disposition: ['kept', 'revised', 'retired'],
    authority: 'same-plan-action-row-human-reviewed',
    backfill: { commitmentRows: 0, evidenceLinkRows: 0, formalRows: 0 },
  }));
}

function markerDetails(): MarkerDetails {
  const payload = {
    version: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_VERSION,
    schemaFingerprint: hypothesisCommitmentReviewMigrationSchemaFingerprint(),
    backfill: { commitmentRows: 0 as const, evidenceLinkRows: 0 as const, formalRows: 0 as const },
  };
  return { ...payload, integrityChecksum: sha256(JSON.stringify(payload)) };
}

function markerValid(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    const expected = markerDetails();
    return value.version === expected.version
      && value.schemaFingerprint === expected.schemaFingerprint
      && value.backfill?.commitmentRows === 0
      && value.backfill.evidenceLinkRows === 0
      && value.backfill.formalRows === 0
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

function isMissingExpansion(error: unknown): boolean {
  if (['P2021', 'P2022'].includes(prismaCode(error) ?? '')) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('no such table')
    || message.includes('no such column')
    || message.includes('does not exist');
}

const commitmentSelect = {
  id: true,
  tenantId: true,
  accountId: true,
  opportunityId: true,
  executionStatus: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  completionResult: true,
  completionResultRecordedAtUtc: true,
  completionResultRecordedByUserId: true,
  verificationReviewDisposition: true,
  verificationReviewedAtUtc: true,
  verificationReviewedByUserId: true,
} as const;

const linkSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  evidenceId: true,
  evidenceVersion: true,
  verificationCommitmentId: true,
} as const;

type CommitmentRow = Prisma.PlanActionGetPayload<{ select: typeof commitmentSelect }>;
type LinkRow = Prisma.HypothesisEvidenceLinkGetPayload<{ select: typeof linkSelect }>;

const rowKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;

function addConflict(conflicts: string[], prefix: string, kind: string): void {
  const conflict = `${prefix}:${kind}`;
  if (!conflicts.includes(conflict)) conflicts.push(conflict);
}

async function inspect(db: DbClient): Promise<HypothesisCommitmentReviewMigrationReport> {
  const schemaFingerprint = hypothesisCommitmentReviewMigrationSchemaFingerprint();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) {
    conflicts.push('hypothesis_commitment_review_marker_invalid');
  }

  let commitments: CommitmentRow[];
  let links: LinkRow[];
  try {
    [commitments, links] = await Promise.all([
      db.planAction.findMany({
        orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: commitmentSelect,
      }),
      db.hypothesisEvidenceLink.findMany({
        orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: linkSelect,
      }),
    ]);
  } catch (error) {
    if (!isMissingExpansion(error)) throw error;
    if (markerPresent) conflicts.push('hypothesis_commitment_review_marker_without_schema');
    return {
      ok: conflicts.length === 0,
      markerPresent,
      schemaPresent: false,
      commitments: 0,
      linkedCommitments: 0,
      linkedEvidence: 0,
      conflicts,
      schemaFingerprint,
    };
  }

  const linkedCommitmentRows = commitments.filter((row) => row.hypothesisId !== null
    || row.hypothesisRevisionId !== null);
  const linkedEvidenceRows = links.filter((row) => row.verificationCommitmentId !== null);
  const hypothesisIds = [...new Set(linkedCommitmentRows
    .map((row) => row.hypothesisId)
    .filter((id): id is string => id !== null))];
  const revisionIds = [...new Set(linkedCommitmentRows
    .map((row) => row.hypothesisRevisionId)
    .filter((id): id is string => id !== null))];
  const evidenceIds = [...new Set(linkedEvidenceRows.map((row) => row.evidenceId))];
  const userIds = [...new Set(commitments.flatMap((row) => [
    row.completionResultRecordedByUserId,
    row.verificationReviewedByUserId,
  ]).filter((id): id is string => id !== null))];

  const [hypotheses, revisions, evidence, users] = await Promise.all([
    db.salesHypothesis.findMany({
      where: { id: { in: hypothesisIds } },
      select: { id: true, tenantId: true, customerId: true, matterId: true, currentRevisionId: true },
    }),
    db.salesHypothesisRevision.findMany({
      where: { id: { in: revisionIds } },
      select: { id: true, tenantId: true, hypothesisId: true },
    }),
    db.evidenceEvent.findMany({
      where: { id: { in: evidenceIds } },
      select: { id: true, tenantId: true, accountId: true, opportunityId: true, status: true },
    }),
    db.user.findMany({
      where: { id: { in: userIds } }, select: { id: true, tenantId: true },
    }),
  ]);
  const hypothesesById = new Map(hypotheses.map((row) => [rowKey(row.tenantId, row.id), row]));
  const revisionsById = new Map(revisions.map((row) => [rowKey(row.tenantId, row.id), row]));
  const evidenceById = new Map(evidence.map((row) => [rowKey(row.tenantId, row.id), row]));
  const usersById = new Set(users.map((row) => rowKey(row.tenantId, row.id)));
  const commitmentsById = new Map(commitments.map((row) => [rowKey(row.tenantId, row.id), row]));
  const validEvidenceByCommitment = new Map<string, number>();

  for (const row of commitments) {
    const prefix = `${row.tenantId}:commitment:${row.id}`;
    const pointersPaired = (row.hypothesisId === null) === (row.hypothesisRevisionId === null);
    const hypothesis = row.hypothesisId
      ? hypothesesById.get(rowKey(row.tenantId, row.hypothesisId))
      : undefined;
    const revision = row.hypothesisRevisionId
      ? revisionsById.get(rowKey(row.tenantId, row.hypothesisRevisionId))
      : undefined;
    const pointerValid = pointersPaired && (row.hypothesisId === null || (
      boundedId(row.hypothesisId)
      && boundedId(row.hypothesisRevisionId)
      && row.opportunityId !== null
      && hypothesis?.customerId === row.accountId
      && hypothesis.matterId === row.opportunityId
      && revision?.hypothesisId === row.hypothesisId
    ));
    if (!pointerValid) addConflict(conflicts, prefix, 'hypothesis_pointer_invalid');

    const noResult = row.completionResult === ''
      && row.completionResultRecordedAtUtc === null
      && row.completionResultRecordedByUserId === null;
    const completeResult = row.completionResult.length > 0
      && row.completionResult.length <= 2_000
      && row.completionResult.trim() === row.completionResult
      && row.executionStatus === 'completed'
      && row.hypothesisId !== null
      && row.completionResultRecordedAtUtc !== null
      && row.completionResultRecordedByUserId !== null
      && usersById.has(rowKey(row.tenantId, row.completionResultRecordedByUserId));
    if (!noResult && !completeResult) addConflict(conflicts, prefix, 'completion_result_invalid');

    const noReview = row.verificationReviewDisposition === ''
      && row.verificationReviewedAtUtc === null
      && row.verificationReviewedByUserId === null;
    const completeReview = ['kept', 'revised', 'retired'].includes(row.verificationReviewDisposition)
      && row.executionStatus === 'completed'
      && row.hypothesisId !== null
      && row.verificationReviewedAtUtc !== null
      && row.verificationReviewedByUserId !== null
      && usersById.has(rowKey(row.tenantId, row.verificationReviewedByUserId));
    if (!noReview && !completeReview) addConflict(conflicts, prefix, 'review_metadata_invalid');
  }

  for (const row of linkedEvidenceRows) {
    const prefix = `${row.tenantId}:hypothesis_evidence_link:${row.id}`;
    const commitment = row.verificationCommitmentId
      ? commitmentsById.get(rowKey(row.tenantId, row.verificationCommitmentId))
      : undefined;
    const linkedEvidence = evidenceById.get(rowKey(row.tenantId, row.evidenceId));
    const valid = commitment?.executionStatus === 'completed'
      && commitment.hypothesisId === row.hypothesisId
      && commitment.hypothesisRevisionId === row.hypothesisRevisionId
      && row.evidenceVersion === 0
      && linkedEvidence?.accountId === commitment.accountId
      && linkedEvidence.opportunityId === commitment.opportunityId
      && linkedEvidence.status === 'approved';
    if (!valid || row.verificationCommitmentId === null) {
      addConflict(conflicts, prefix, 'verification_commitment_invalid');
      continue;
    }
    const key = rowKey(row.tenantId, row.verificationCommitmentId);
    validEvidenceByCommitment.set(key, (validEvidenceByCommitment.get(key) ?? 0) + 1);
  }

  for (const row of commitments) {
    if (row.verificationReviewDisposition === '') continue;
    const hasResult = row.completionResult.length > 0;
    const hasEvidence = (validEvidenceByCommitment.get(rowKey(row.tenantId, row.id)) ?? 0) > 0;
    if (!hasResult && !hasEvidence) {
      addConflict(conflicts, `${row.tenantId}:commitment:${row.id}`, 'review_metadata_invalid');
    }
  }

  return {
    ok: conflicts.length === 0,
    markerPresent,
    schemaPresent: true,
    commitments: commitments.length,
    linkedCommitments: linkedCommitmentRows.length,
    linkedEvidence: linkedEvidenceRows.length,
    conflicts,
    schemaFingerprint,
  };
}

export async function reportHypothesisCommitmentReviewMigration(
  db: DbClient,
): Promise<HypothesisCommitmentReviewMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyHypothesisCommitmentReviewMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<HypothesisCommitmentReviewMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('hypothesis Commitment review migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok || !before.schemaPresent) {
      throw new Error(before.conflicts.join(',') || 'hypothesis Commitment review migration preflight failed');
    }
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: HYPOTHESIS_COMMITMENT_REVIEW_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) {
        throw new Error('injected hypothesis Commitment review migration failure');
      }
    } else if (!markerValid(existing.details)) {
      throw new Error('hypothesis_commitment_review_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'hypothesis Commitment review migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyHypothesisCommitmentReviewMigration(
  db: DbClient,
): Promise<HypothesisCommitmentReviewMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.schemaPresent && report.markerPresent };
}

interface SqliteColumn {
  name: string;
  type: string;
  notnull: number | bigint;
  dflt_value: string | null;
}

const PLAN_ACTION_EXPANSION = new Map<string, Omit<SqliteColumn, 'name'>>([
  ['hypothesisId', { type: 'TEXT', notnull: 0, dflt_value: null }],
  ['hypothesisRevisionId', { type: 'TEXT', notnull: 0, dflt_value: null }],
  ['completionResult', { type: 'TEXT', notnull: 1, dflt_value: "''" }],
  ['completionResultRecordedAtUtc', { type: 'DATETIME', notnull: 0, dflt_value: null }],
  ['completionResultRecordedByUserId', { type: 'TEXT', notnull: 0, dflt_value: null }],
  ['verificationReviewDisposition', { type: 'TEXT', notnull: 1, dflt_value: "''" }],
  ['verificationReviewedAtUtc', { type: 'DATETIME', notnull: 0, dflt_value: null }],
  ['verificationReviewedByUserId', { type: 'TEXT', notnull: 0, dflt_value: null }],
]);

const LINK_EXPANSION = new Map<string, Omit<SqliteColumn, 'name'>>([
  ['verificationCommitmentId', { type: 'TEXT', notnull: 0, dflt_value: null }],
]);

function expansionColumnsExact(
  rows: readonly SqliteColumn[],
  expected: ReadonlyMap<string, Omit<SqliteColumn, 'name'>>,
): boolean {
  const relevant = rows.filter((row) => expected.has(row.name));
  return relevant.length === expected.size && relevant.every((row) => {
    const wanted = expected.get(row.name);
    return wanted?.type === row.type.toUpperCase()
      && wanted.notnull === Number(row.notnull)
      && wanted.dflt_value === row.dflt_value;
  });
}

export async function inspectHypothesisCommitmentReviewSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<HypothesisCommitmentReviewSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'PlanAction', 'SalesHypothesis',
                     'SalesHypothesisRevision', 'HypothesisEvidenceLink')`,
  );
  const names = new Set(tables.map((row) => row.name));
  if (!['Tenant', 'DataMigrationState', 'PlanAction', 'SalesHypothesis',
    'SalesHypothesisRevision', 'HypothesisEvidenceLink'].every((name) => names.has(name))) {
    return 'uninitialized';
  }
  const [planColumns, linkColumns, planIndexes, linkIndexes] = await Promise.all([
    db.$queryRawUnsafe<SqliteColumn[]>('PRAGMA table_info("PlanAction")'),
    db.$queryRawUnsafe<SqliteColumn[]>('PRAGMA table_info("HypothesisEvidenceLink")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("PlanAction")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("HypothesisEvidenceLink")'),
  ]);
  const newColumnCount = planColumns.filter((row) => PLAN_ACTION_EXPANSION.has(row.name)).length
    + linkColumns.filter((row) => LINK_EXPANSION.has(row.name)).length;
  const newIndexCount = planIndexes.filter(
    (row) => row.name === 'PlanAction_tenantId_hypothesisId_hypothesisRevisionId_idx',
  ).length + linkIndexes.filter(
    (row) => row.name === 'HypothesisEvidenceLink_tenantId_verificationCommitmentId_idx',
  ).length;
  if (newColumnCount === 0 && newIndexCount === 0) return 'legacy';
  const exact = expansionColumnsExact(planColumns, PLAN_ACTION_EXPANSION)
    && expansionColumnsExact(linkColumns, LINK_EXPANSION)
    && newIndexCount === 2;
  return exact ? 'expanded' : 'partial';
}
