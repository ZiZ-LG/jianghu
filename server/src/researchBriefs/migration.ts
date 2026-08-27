import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';

export const RESEARCH_BRIEF_MIGRATION_MARKER = 'SAAS-204-research-brief-snapshot-v1';
const RESEARCH_BRIEF_MIGRATION_VERSION = 1;

export type ResearchBriefSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface ResearchBriefMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  snapshots: number;
  conflicts: string[];
  schemaFingerprint: string;
}

export interface ResearchBriefMigrationApplyResult extends ResearchBriefMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  schemaFingerprint: string;
  backfill: {
    snapshotRows: 0;
    formalRows: 0;
  };
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const boundedText = (value: string, max = 200): boolean => value.length > 0 && value.length <= max;

export function researchBriefMigrationSchemaFingerprint(): string {
  return sha256(JSON.stringify({
    marker: RESEARCH_BRIEF_MIGRATION_MARKER,
    version: RESEARCH_BRIEF_MIGRATION_VERSION,
    model: 'ResearchBriefSnapshot',
    columns: [
      'id', 'tenantId', 'customerId', 'matterId', 'createdByUserId', 'generationKey', 'status',
      'subjectStatus', 'payloadEnc', 'payloadFingerprint', 'sourceSetHash', 'sourceCount',
      'sectionCount', 'unknownCount', 'failureCount', 'version', 'basedOnAt', 'freshUntil',
      'generatedAt', 'createdAt',
    ],
    unique: [['tenantId', 'createdByUserId', 'generationKey']],
    indexes: [
      ['tenantId', 'createdByUserId', 'customerId', 'generatedAt'],
      ['tenantId', 'createdByUserId', 'matterId', 'generatedAt'],
    ],
    payloadAuthority: 'encrypted_snapshot_v1',
    backfill: { snapshotRows: 0, formalRows: 0 },
  }));
}

function markerDetails(): MarkerDetails {
  const receipt = {
    version: RESEARCH_BRIEF_MIGRATION_VERSION,
    schemaFingerprint: researchBriefMigrationSchemaFingerprint(),
    backfill: { snapshotRows: 0 as const, formalRows: 0 as const },
  };
  return { ...receipt, integrityChecksum: sha256(JSON.stringify(receipt)) };
}

function markerValid(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    const expected = markerDetails();
    return value.version === expected.version
      && value.schemaFingerprint === expected.schemaFingerprint
      && value.backfill?.snapshotRows === 0
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

function isMissingTable(error: unknown): boolean {
  if (prismaCode(error) === 'P2021') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('no such table') || message.includes('does not exist');
}

const snapshotSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  createdByUserId: true,
  generationKey: true,
  status: true,
  subjectStatus: true,
  payloadEnc: true,
  payloadFingerprint: true,
  sourceSetHash: true,
  sourceCount: true,
  sectionCount: true,
  unknownCount: true,
  failureCount: true,
  version: true,
  basedOnAt: true,
  freshUntil: true,
  generatedAt: true,
  createdAt: true,
} as const;

type SnapshotRow = Prisma.ResearchBriefSnapshotGetPayload<{ select: typeof snapshotSelect }>;

function validateSnapshot(row: SnapshotRow): string | null {
  if (!boundedText(row.id) || !boundedText(row.tenantId) || !boundedText(row.customerId)
    || (row.matterId !== null && !boundedText(row.matterId))
    || !boundedText(row.createdByUserId) || !isSha256(row.generationKey)
    || !boundedText(row.payloadEnc, 100_000)
    || !isSha256(row.payloadFingerprint) || !isSha256(row.sourceSetHash)
    || !Number.isSafeInteger(row.sourceCount) || row.sourceCount < 0 || row.sourceCount > 20
    || !Number.isSafeInteger(row.sectionCount) || row.sectionCount < 0 || row.sectionCount > 8
    || !Number.isSafeInteger(row.unknownCount) || row.unknownCount < 0 || row.unknownCount > 20
    || !Number.isSafeInteger(row.failureCount) || row.failureCount < 0 || row.failureCount > 20
    || (row.sectionCount > 0 && row.sourceCount === 0)
    || (row.failureCount > 0 && row.sourceCount === 0)
    || row.version !== 1
    || row.generatedAt.getTime() > row.createdAt.getTime()
    || (row.basedOnAt !== null && row.basedOnAt.getTime() > row.generatedAt.getTime())
    || (row.basedOnAt !== null && row.freshUntil !== null
      && row.basedOnAt.getTime() > row.freshUntil.getTime())) {
    return 'metadata_invalid';
  }
  if (!['ready', 'partial', 'blocked'].includes(row.status)
    || !['matched', 'ambiguous', 'unmatched'].includes(row.subjectStatus)
    || (row.subjectStatus === 'matched' && row.status === 'blocked')
    || (row.status === 'ready' && (row.sourceCount === 0 || row.sectionCount === 0
      || row.unknownCount !== 0 || row.failureCount !== 0
      || row.basedOnAt === null || row.freshUntil === null))
    || (row.subjectStatus !== 'matched' && (row.status !== 'blocked' || row.sectionCount !== 0))) {
    return 'status_invalid';
  }
  return null;
}

async function inspect(db: DbClient): Promise<ResearchBriefMigrationReport> {
  const schemaFingerprint = researchBriefMigrationSchemaFingerprint();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: RESEARCH_BRIEF_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) conflicts.push('research_brief_marker_invalid');

  let snapshots: SnapshotRow[] | null;
  try {
    snapshots = await db.researchBriefSnapshot.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
      select: snapshotSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    snapshots = null;
  }
  if (snapshots === null) {
    if (markerPresent) conflicts.push('research_brief_marker_without_schema');
    return {
      ok: conflicts.length === 0,
      markerPresent,
      snapshots: 0,
      conflicts,
      schemaFingerprint,
    };
  }

  const tenantIds = [...new Set(snapshots.map((row) => row.tenantId))];
  const tenants = await db.tenant.findMany({
    where: { id: { in: tenantIds } }, select: { id: true },
  });
  const tenantSet = new Set(tenants.map((row) => row.id));
  for (const row of snapshots) {
    const prefix = `${row.tenantId}:research_brief:${row.id}`;
    if (!tenantSet.has(row.tenantId)) conflicts.push(`${prefix}:tenant_invalid`);
    const invalid = validateSnapshot(row);
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
  }
  return {
    ok: conflicts.length === 0,
    markerPresent,
    snapshots: snapshots.length,
    conflicts,
    schemaFingerprint,
  };
}

export async function reportResearchBriefMigration(
  db: DbClient,
): Promise<ResearchBriefMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyResearchBriefMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<ResearchBriefMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('ResearchBrief migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok) {
      throw new Error(before.conflicts.join(',') || 'ResearchBrief migration preflight failed');
    }
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: RESEARCH_BRIEF_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: RESEARCH_BRIEF_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) {
        throw new Error('injected ResearchBrief migration failure');
      }
    } else if (!markerValid(existing.details)) {
      throw new Error('research_brief_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'ResearchBrief migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyResearchBriefMigration(
  db: DbClient,
): Promise<ResearchBriefMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const SNAPSHOT_COLUMNS = new Set([
  'id', 'tenantId', 'customerId', 'matterId', 'createdByUserId', 'generationKey', 'status',
  'subjectStatus', 'payloadEnc', 'payloadFingerprint', 'sourceSetHash', 'sourceCount',
  'sectionCount', 'unknownCount', 'failureCount', 'version', 'basedOnAt', 'freshUntil',
  'generatedAt', 'createdAt',
]);
const SNAPSHOT_INDEXES = new Set([
  'ResearchBriefSnapshot_tenantId_createdByUserId_generationKey_key',
  'ResearchBriefSnapshot_tenantId_createdByUserId_customerId_generatedAt_idx',
  'ResearchBriefSnapshot_tenantId_createdByUserId_matterId_generatedAt_idx',
]);

export async function inspectResearchBriefSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<ResearchBriefSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'AgentRun', 'ResearchBriefSnapshot')`,
  );
  const names = new Set(tables.map((table) => table.name));
  if (!names.has('Tenant') || !names.has('DataMigrationState') || !names.has('AgentRun')) {
    return 'uninitialized';
  }
  if (!names.has('ResearchBriefSnapshot')) return 'legacy';
  const [columns, indexes, foreignKeys] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ResearchBriefSnapshot")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("ResearchBriefSnapshot")'),
    db.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string }>>(
      'PRAGMA foreign_key_list("ResearchBriefSnapshot")',
    ),
  ]);
  const exactColumns = columns.length === SNAPSHOT_COLUMNS.size
    && columns.every((row) => SNAPSHOT_COLUMNS.has(row.name));
  const namedIndexes = indexes.filter((row) => !row.name.startsWith('sqlite_autoindex_'));
  const exactIndexes = namedIndexes.length === SNAPSHOT_INDEXES.size
    && namedIndexes.every((row) => SNAPSHOT_INDEXES.has(row.name));
  const exactTenantFk = foreignKeys.length === 1
    && foreignKeys[0]?.table === 'Tenant'
    && foreignKeys[0].from === 'tenantId'
    && foreignKeys[0].to === 'id'
    && foreignKeys[0].on_delete.toUpperCase() === 'CASCADE';
  return exactColumns && exactIndexes && exactTenantFk ? 'expanded' : 'partial';
}
