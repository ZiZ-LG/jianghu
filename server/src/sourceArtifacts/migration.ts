import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  artifactIdForExternalReference,
  sourceArtifactCreateData,
  sourceArtifactProjectionForNote,
  sourceArtifactProjectionForTranscript,
  validateSourceArtifactProjection,
  type SourceArtifactProjection,
} from './model.js';

export const SOURCE_ARTIFACT_MIGRATION_MARKER = 'SAAS-201-source-artifact-projection-v1';
const SOURCE_ARTIFACT_MIGRATION_VERSION = 1;

export interface SourceArtifactMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  notes: number;
  transcripts: number;
  sourceArtifacts: number;
  missing: number;
  stale: number;
  tombstones: number;
  externalReferences: number;
  conflicts: string[];
  receiptChecksum: string;
}

export interface SourceArtifactMigrationApplyResult extends SourceArtifactMigrationReport {
  writes: number;
}

interface Inspection {
  report: SourceArtifactMigrationReport;
  expected: SourceArtifactProjection[];
  missing: SourceArtifactProjection[];
  stale: Array<{ actual: SourceArtifactProjection; projection: SourceArtifactProjection }>;
}

interface MarkerDetails {
  version: number;
  contractChecksum: string;
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function sourceArtifactMigrationContractChecksum(): string {
  return sha256(JSON.stringify({
    marker: SOURCE_ARTIFACT_MIGRATION_MARKER,
    version: SOURCE_ARTIFACT_MIGRATION_VERSION,
    authority: ['Transcript.contentEnc', 'Note.content'],
    artifactKinds: ['external_reference', 'note', 'transcript', 'uploaded_file'],
    backingKinds: ['external_reference', 'note', 'transcript'],
    fingerprintKinds: ['content_sha256_v1', 'reference_sha256_v1'],
    retentionStates: ['available', 'degraded', 'deleted', 'reference_only'],
    creatorDomain: 'creator-private-v1',
  }));
}

function markerDetails(): MarkerDetails {
  const payload = {
    version: SOURCE_ARTIFACT_MIGRATION_VERSION,
    contractChecksum: sourceArtifactMigrationContractChecksum(),
  };
  return { ...payload, integrityChecksum: sha256(JSON.stringify(payload)) };
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

const projectionSelect = {
  id: true,
  tenantId: true,
  accountId: true,
  matterId: true,
  personId: true,
  backingKind: true,
  backingId: true,
  artifactKind: true,
  source: true,
  externalRef: true,
  idempotencyDomain: true,
  title: true,
  occurredAt: true,
  fingerprintKind: true,
  sourceFingerprint: true,
  retentionState: true,
  retentionUpdatedAt: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  createdAt: true,
} as const;

function asProjection(row: Record<string, unknown>): SourceArtifactProjection {
  return row as unknown as SourceArtifactProjection;
}

function authorityFieldsMatch(actual: SourceArtifactProjection, expected: SourceArtifactProjection): boolean {
  const adoptedExternalId = expected.backingKind === 'transcript' && expected.externalRef
    ? artifactIdForExternalReference(
        expected.tenantId,
        expected.idempotencyDomain,
        expected.source,
        expected.externalRef,
      )
    : null;
  return (actual.id === expected.id || actual.id === adoptedExternalId)
    && actual.tenantId === expected.tenantId
    && actual.accountId === expected.accountId
    && actual.matterId === expected.matterId
    && actual.personId === expected.personId
    && actual.backingKind === expected.backingKind
    && actual.backingId === expected.backingId
    && actual.createdByUserId === expected.createdByUserId
    && actual.visibility === expected.visibility
    && actual.aclVersion === expected.aclVersion;
}

function projectionFieldsMatch(actual: SourceArtifactProjection, expected: SourceArtifactProjection): boolean {
  const fingerprintMatches = (
    actual.fingerprintKind === expected.fingerprintKind
    && actual.sourceFingerprint === expected.sourceFingerprint
  ) || (
    expected.retentionState === 'degraded'
    && actual.fingerprintKind === 'content_sha256_v1'
    && /^[a-f0-9]{64}$/.test(actual.sourceFingerprint)
  );
  return authorityFieldsMatch(actual, expected)
    && actual.artifactKind === expected.artifactKind
    && actual.source === expected.source
    && actual.externalRef === expected.externalRef
    && actual.idempotencyDomain === expected.idempotencyDomain
    && actual.title === expected.title
    && (actual.occurredAt?.toISOString() ?? null) === (expected.occurredAt?.toISOString() ?? null)
    && fingerprintMatches
    && actual.retentionState === expected.retentionState;
}

function receiptChecksum(expected: readonly SourceArtifactProjection[]): string {
  return sha256(JSON.stringify(expected.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    accountId: row.accountId,
    matterId: row.matterId,
    personId: row.personId,
    backingKind: row.backingKind,
    backingId: row.backingId,
    artifactKind: row.artifactKind,
    source: row.source,
    externalRef: row.externalRef,
    idempotencyDomain: row.idempotencyDomain,
    fingerprintKind: row.fingerprintKind,
    sourceFingerprint: row.sourceFingerprint,
    retentionState: row.retentionState,
    createdByUserId: row.createdByUserId,
    visibility: row.visibility,
    aclVersion: row.aclVersion,
  })).sort((left, right) => left.tenantId.localeCompare(right.tenantId) || left.id.localeCompare(right.id))));
}

async function loadTenantSlice(db: DbClient, tenantId: string) {
  const [users, accounts, matters, persons, notes, transcripts, artifacts] = await Promise.all([
    db.user.findMany({ where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true } }),
    db.account.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true },
    }),
    db.opportunity.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true, accountId: true },
    }),
    db.person.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true, accountId: true },
    }),
    db.note.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        content: true, source: true, createdByUserId: true, visibility: true, aclVersion: true,
        createdAt: true,
      },
    }),
    db.transcript.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
        source: true, externalRef: true, idempotencyDomain: true, title: true, contentEnc: true,
        recordedAt: true, status: true, createdByUserId: true, visibility: true, aclVersion: true,
        createdAt: true,
      },
    }),
    db.sourceArtifact.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: projectionSelect,
    }),
  ]);
  return {
    tenantId,
    users: new Set(users.map((row) => row.id)),
    accounts: new Set(accounts.map((row) => row.id)),
    matters: new Map(matters.map((row) => [row.id, row.accountId])),
    persons: new Map(persons.map((row) => [row.id, row.accountId])),
    notes,
    transcripts,
    artifacts,
  };
}

type TenantSlice = Awaited<ReturnType<typeof loadTenantSlice>>;

function authorityScopeConflict(
  slice: TenantSlice,
  row: Pick<SourceArtifactProjection,
    'accountId' | 'matterId' | 'personId' | 'createdByUserId'>,
): string | null {
  if (row.createdByUserId && !slice.users.has(row.createdByUserId)) return 'creator_missing';
  if (row.accountId && !slice.accounts.has(row.accountId)) return 'account_invalid';
  if (row.matterId && (!row.accountId || slice.matters.get(row.matterId) !== row.accountId)) {
    return 'matter_invalid';
  }
  if (row.personId && (!row.accountId || slice.persons.get(row.personId) !== row.accountId)) {
    return 'person_invalid';
  }
  return null;
}

async function inspect(db: DbClient): Promise<Inspection> {
  const [marker, tenants] = await Promise.all([
    db.dataMigrationState.findUnique({
      where: { key: SOURCE_ARTIFACT_MIGRATION_MARKER }, select: { details: true },
    }),
    db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } }),
  ]);
  const slices: TenantSlice[] = [];
  for (const tenant of tenants) slices.push(await loadTenantSlice(db, tenant.id));
  const notes = slices.flatMap((slice) => slice.notes);
  const transcripts = slices.flatMap((slice) => slice.transcripts);
  const artifacts = slices.flatMap((slice) => slice.artifacts);
  const sliceByTenant = new Map(slices.map((slice) => [slice.tenantId, slice]));
  const expected = [
    ...notes.map(sourceArtifactProjectionForNote),
    ...transcripts.map(sourceArtifactProjectionForTranscript),
  ];
  const expectedByBacking = new Map(expected.map((row) => [
    JSON.stringify([row.tenantId, row.backingKind, row.backingId]), row,
  ]));
  const actualByBacking = new Map(artifacts.map((row) => [
    JSON.stringify([row.tenantId, row.backingKind, row.backingId]), asProjection(row),
  ]));
  const conflicts: string[] = [];
  const missing: SourceArtifactProjection[] = [];
  const stale: Array<{ actual: SourceArtifactProjection; projection: SourceArtifactProjection }> = [];

  for (const projection of expected) {
    const validation = validateSourceArtifactProjection(projection);
    if (!validation.ok) {
      conflicts.push(
        `${projection.tenantId}:${projection.backingKind}:${projection.backingId}:authority_${validation.code}`,
      );
    }
    const slice = sliceByTenant.get(projection.tenantId);
    const scopeConflict = slice ? authorityScopeConflict(slice, projection) : 'tenant_missing';
    if (scopeConflict) {
      conflicts.push(
        `${projection.tenantId}:${projection.backingKind}:${projection.backingId}:authority_${scopeConflict}`,
      );
    }
  }

  for (const projection of expected) {
    const key = JSON.stringify([projection.tenantId, projection.backingKind, projection.backingId]);
    const actual = actualByBacking.get(key);
    if (!actual) {
      missing.push(projection);
      continue;
    }
    if (!authorityFieldsMatch(actual, projection)) {
      conflicts.push(`${projection.tenantId}:${projection.backingKind}:${projection.backingId}:authority_drift`);
      continue;
    }
    if (!projectionFieldsMatch(actual, projection)) {
      stale.push({ actual, projection });
    }
  }

  let tombstones = 0;
  let externalReferences = 0;
  for (const raw of artifacts) {
    const artifact = asProjection(raw);
    const validation = validateSourceArtifactProjection(artifact);
    if (!validation.ok) conflicts.push(`${artifact.tenantId}:source_artifact:${artifact.id}:${validation.code}`);
    const slice = sliceByTenant.get(artifact.tenantId);
    const scopeConflict = slice ? authorityScopeConflict(slice, artifact) : 'tenant_missing';
    if (scopeConflict) {
      conflicts.push(`${artifact.tenantId}:source_artifact:${artifact.id}:${scopeConflict}`);
    }
    const key = JSON.stringify([artifact.tenantId, artifact.backingKind, artifact.backingId]);
    if (artifact.backingKind === 'external_reference') externalReferences += 1;
    if (artifact.retentionState === 'deleted') tombstones += 1;
    if (!expectedByBacking.has(key)
      && artifact.backingKind !== 'external_reference'
      && artifact.retentionState !== 'deleted') {
      conflicts.push(`${artifact.tenantId}:source_artifact:${artifact.id}:backing_missing`);
    }
    if (expectedByBacking.has(key) && artifact.retentionState === 'deleted') {
      conflicts.push(`${artifact.tenantId}:source_artifact:${artifact.id}:live_backing_tombstoned`);
    }
  }
  if (marker && !markerValid(marker.details)) conflicts.push('marker_invalid');
  if (marker && missing.length > 0) conflicts.push(`post_marker_missing:${missing.length}`);
  if (marker && stale.length > 0) conflicts.push(`post_marker_stale:${stale.length}`);
  conflicts.sort();
  return {
    expected,
    missing,
    stale,
    report: {
      ok: conflicts.length === 0,
      markerPresent: Boolean(marker),
      notes: notes.length,
      transcripts: transcripts.length,
      sourceArtifacts: artifacts.length,
      missing: missing.length,
      stale: stale.length,
      tombstones,
      externalReferences,
      conflicts,
      receiptChecksum: receiptChecksum(expected),
    },
  };
}

export async function reportSourceArtifactMigration(db: DbClient): Promise<SourceArtifactMigrationReport> {
  return (await inspect(db)).report;
}

export async function applySourceArtifactMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<SourceArtifactMigrationApplyResult> {
  const root = db as PrismaClient;
  if (typeof root.$transaction !== 'function') throw new Error('SourceArtifact apply requires root client');
  return root.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.report.ok) throw new Error(before.report.conflicts.join(','));
    let writes = 0;
    const inject = () => {
      if (options.failAfterWrites === writes) throw new Error('injected SourceArtifact migration failure');
    };
    inject();
    for (const projection of before.missing) {
      await tx.sourceArtifact.create({ data: sourceArtifactCreateData(projection) });
      writes += 1;
      inject();
    }
    for (const stale of before.stale) {
      const { actual, projection } = stale;
      const preserveContentFingerprint = projection.retentionState === 'degraded'
        && actual.fingerprintKind === 'content_sha256_v1';
      const changed = await tx.sourceArtifact.updateMany({
        where: {
          id: actual.id,
          tenantId: projection.tenantId,
          backingKind: projection.backingKind,
          backingId: projection.backingId,
          aclVersion: projection.aclVersion,
        },
        data: {
          artifactKind: projection.artifactKind,
          source: projection.source,
          externalRef: projection.externalRef,
          idempotencyDomain: projection.idempotencyDomain,
          title: projection.title,
          occurredAt: projection.occurredAt,
          fingerprintKind: preserveContentFingerprint ? actual.fingerprintKind : projection.fingerprintKind,
          sourceFingerprint: preserveContentFingerprint ? actual.sourceFingerprint : projection.sourceFingerprint,
          retentionState: projection.retentionState,
          retentionUpdatedAt: projection.retentionUpdatedAt,
        },
      });
      if (changed.count !== 1) throw new Error('SourceArtifact migration CAS conflict');
      writes += 1;
      inject();
    }
    const afterRows = await inspect(tx);
    if (!afterRows.report.ok || afterRows.report.missing !== 0 || afterRows.report.stale !== 0) {
      throw new Error(`SourceArtifact migration parity failed:${afterRows.report.conflicts.join(',')}`);
    }
    const existingMarker = await tx.dataMigrationState.findUnique({
      where: { key: SOURCE_ARTIFACT_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existingMarker) {
      await tx.dataMigrationState.create({ data: {
        key: SOURCE_ARTIFACT_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      inject();
    }
    const verified = await inspect(tx);
    if (!verified.report.ok || !verified.report.markerPresent
      || verified.report.missing !== 0 || verified.report.stale !== 0) {
      throw new Error(`SourceArtifact migration verification failed:${verified.report.conflicts.join(',')}`);
    }
    return { ...verified.report, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifySourceArtifactMigration(db: DbClient): Promise<SourceArtifactMigrationReport> {
  const inspection = await inspect(db);
  return {
    ...inspection.report,
    ok: inspection.report.ok
      && inspection.report.markerPresent
      && inspection.report.missing === 0
      && inspection.report.stale === 0,
  };
}

export type SourceArtifactSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

const SAAS_201_COLUMNS = new Set([
  'artifactKind', 'source', 'externalRef', 'idempotencyDomain', 'title', 'occurredAt',
  'fingerprintKind', 'sourceFingerprint', 'retentionState', 'retentionUpdatedAt',
]);
const SAAS_201_INDEXES = new Set([
  'SourceArtifact_tenantId_domain_source_externalRef_key',
  'SourceArtifact_tenantId_artifactKind_createdAt_idx',
  'SourceArtifact_tenantId_retentionState_updatedAt_idx',
]);

export async function inspectSourceArtifactSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<SourceArtifactSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'SourceArtifact'`,
  );
  if (tables.length === 0) return 'uninitialized';
  const [columns, indexes] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("SourceArtifact")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("SourceArtifact")'),
  ]);
  const names = new Set(columns.map((column) => column.name));
  const present = [...SAAS_201_COLUMNS].filter((name) => names.has(name)).length;
  if (present === 0) return 'legacy';
  const indexNames = new Set(indexes.map((index) => index.name));
  return present === SAAS_201_COLUMNS.size
    && [...SAAS_201_INDEXES].every((name) => indexNames.has(name))
    ? 'expanded'
    : 'partial';
}
