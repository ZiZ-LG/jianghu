import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AgentOutputRefSchema,
  RELATIONSHIP_RADAR_RULE_VERSION,
  RelationshipRadarSnapshotPayloadSchema,
  type RelationshipRadarSnapshotPayload,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';

export const RELATIONSHIP_RADAR_MIGRATION_MARKER = 'SAAS-212-relationship-radar-v1';
const RELATIONSHIP_RADAR_MIGRATION_VERSION = 1;

export type RelationshipRadarSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface RelationshipRadarMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  snapshots: number;
  conflicts: string[];
  schemaFingerprint: string;
}

export interface RelationshipRadarMigrationApplyResult extends RelationshipRadarMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  schemaFingerprint: string;
  backfill: { snapshotRows: 0; formalRows: 0 };
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const bounded = (value: string, max = 500): boolean => value.length > 0 && value.length <= max;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

export function canonicalRelationshipRadarPayload(value: unknown): string {
  return JSON.stringify(canonicalize(RelationshipRadarSnapshotPayloadSchema.parse(value)));
}

export function relationshipRadarMigrationSchemaFingerprint(): string {
  return sha256(JSON.stringify({
    marker: RELATIONSHIP_RADAR_MIGRATION_MARKER,
    version: RELATIONSHIP_RADAR_MIGRATION_VERSION,
    model: 'RelationshipRadarSnapshot',
    columns: [
      'id', 'tenantId', 'customerId', 'matterId', 'createdByUserId', 'agentRunId',
      'generationKey', 'payloadJson', 'payloadFingerprint', 'sourceSetHash', 'signalCount',
      'interventionCount', 'draftCount', 'ruleVersion', 'generatedAt', 'expiresAt',
      'version', 'createdAt',
    ],
    unique: [
      ['tenantId', 'agentRunId'],
      ['tenantId', 'createdByUserId', 'generationKey'],
    ],
    indexes: [
      ['tenantId', 'customerId', 'matterId', 'generatedAt'],
      ['tenantId', 'matterId', 'expiresAt'],
    ],
    payloadAuthority: RELATIONSHIP_RADAR_RULE_VERSION,
    backfill: { snapshotRows: 0, formalRows: 0 },
  }));
}

function markerDetails(): MarkerDetails {
  const receipt = {
    version: RELATIONSHIP_RADAR_MIGRATION_VERSION,
    schemaFingerprint: relationshipRadarMigrationSchemaFingerprint(),
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
  agentRunId: true,
  generationKey: true,
  payloadJson: true,
  payloadFingerprint: true,
  sourceSetHash: true,
  signalCount: true,
  interventionCount: true,
  draftCount: true,
  ruleVersion: true,
  generatedAt: true,
  expiresAt: true,
  version: true,
  createdAt: true,
} as const;

const runSelect = {
  id: true,
  tenantId: true,
  jobKey: true,
  jobVersion: true,
  status: true,
  customerId: true,
  matterId: true,
  actorId: true,
  outputRefs: true,
} as const;

type SnapshotRow = Prisma.RelationshipRadarSnapshotGetPayload<{ select: typeof snapshotSelect }>;
type RunRow = Prisma.AgentRunGetPayload<{ select: typeof runSelect }>;

function expectedOutputRefs(payload: RelationshipRadarSnapshotPayload) {
  return [
    ...payload.signals.map((item) => ({ kind: 'relationship_signal' as const, id: item.id, version: 1 })),
    ...payload.interventions.map((item) => ({ kind: 'intervention_item' as const, id: item.id, version: 1 })),
    ...payload.drafts.map((item) => ({ kind: 'draft_action' as const, id: item.id, version: 1 })),
  ];
}

function parseOutputRefs(raw: string): ReturnType<typeof expectedOutputRefs> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const parsed = value.map((item) => AgentOutputRefSchema.safeParse(item));
    if (parsed.some((item) => !item.success)) return null;
    return parsed.map((item) => item.data!) as ReturnType<typeof expectedOutputRefs>;
  } catch {
    return null;
  }
}

function sameRefs(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSnapshot(row: SnapshotRow, run: RunRow | undefined): string[] {
  const conflicts: string[] = [];
  if (!bounded(row.id, 160) || !bounded(row.tenantId) || !bounded(row.customerId)
    || !bounded(row.matterId) || !bounded(row.createdByUserId) || !bounded(row.agentRunId)
    || !isSha256(row.generationKey) || !isSha256(row.payloadFingerprint)
    || !isSha256(row.sourceSetHash) || !bounded(row.payloadJson, 100_000)
    || row.ruleVersion !== RELATIONSHIP_RADAR_RULE_VERSION
    || row.version !== 1
    || !Number.isSafeInteger(row.signalCount) || row.signalCount !== 6
    || !Number.isSafeInteger(row.interventionCount) || row.interventionCount < 0 || row.interventionCount > 6
    || !Number.isSafeInteger(row.draftCount) || row.draftCount < 0 || row.draftCount > 1
    || row.generatedAt.getTime() > row.createdAt.getTime()
    || row.expiresAt.getTime() - row.generatedAt.getTime() !== 24 * 60 * 60 * 1_000) {
    conflicts.push('metadata_invalid');
  }

  let payload: RelationshipRadarSnapshotPayload | null = null;
  try {
    const raw = JSON.parse(row.payloadJson) as unknown;
    const parsed = RelationshipRadarSnapshotPayloadSchema.safeParse(raw);
    if (parsed.success && canonicalRelationshipRadarPayload(parsed.data) === row.payloadJson) {
      payload = parsed.data;
    }
  } catch {
    payload = null;
  }
  if (!payload) {
    conflicts.push('payload_invalid');
  } else {
    if (sha256(row.payloadJson) !== row.payloadFingerprint) conflicts.push('payload_fingerprint_invalid');
    if (payload.customerId !== row.customerId || payload.matterId !== row.matterId
      || payload.ruleVersion !== row.ruleVersion
      || payload.generatedAtUtc !== row.generatedAt.toISOString()
      || payload.expiresAtUtc !== row.expiresAt.toISOString()
      || payload.signals.length !== row.signalCount
      || payload.interventions.length !== row.interventionCount
      || payload.drafts.length !== row.draftCount) {
      conflicts.push('payload_metadata_mismatch');
    }
  }

  if (!run || run.tenantId !== row.tenantId
    || run.jobKey !== 'relationship_radar' || run.jobVersion !== 'saas-212.v1'
    || run.status !== 'succeeded' || run.customerId !== row.customerId
    || run.matterId !== row.matterId || run.actorId !== row.createdByUserId) {
    conflicts.push('agent_run_invalid');
  } else if (payload) {
    const refs = parseOutputRefs(run.outputRefs);
    if (!refs || !sameRefs(refs, expectedOutputRefs(payload))) conflicts.push('agent_output_mismatch');
  }
  return conflicts;
}

async function inspect(db: DbClient): Promise<RelationshipRadarMigrationReport> {
  const schemaFingerprint = relationshipRadarMigrationSchemaFingerprint();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: RELATIONSHIP_RADAR_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) conflicts.push('relationship_radar_marker_invalid');

  let snapshots: SnapshotRow[] | null;
  try {
    snapshots = await db.relationshipRadarSnapshot.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: snapshotSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    snapshots = null;
  }
  if (snapshots === null) {
    if (markerPresent) conflicts.push('relationship_radar_marker_without_schema');
    return { ok: conflicts.length === 0, markerPresent, snapshots: 0, conflicts, schemaFingerprint };
  }

  const runIds = [...new Set(snapshots.map((row) => row.agentRunId))];
  const runs = runIds.length === 0 ? [] : await db.agentRun.findMany({
    where: { tenantId: { in: [...new Set(snapshots.map((row) => row.tenantId))] }, id: { in: runIds } },
    select: runSelect,
  });
  const runByTenantAndId = new Map(runs.map((row) => [`${row.tenantId}\0${row.id}`, row]));
  for (const row of snapshots) {
    const prefix = `${row.tenantId}:relationship_radar:${row.id}`;
    for (const conflict of validateSnapshot(row, runByTenantAndId.get(`${row.tenantId}\0${row.agentRunId}`))) {
      conflicts.push(`${prefix}:${conflict}`);
    }
  }
  return { ok: conflicts.length === 0, markerPresent, snapshots: snapshots.length, conflicts, schemaFingerprint };
}

export function reportRelationshipRadarMigration(db: DbClient): Promise<RelationshipRadarMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyRelationshipRadarMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<RelationshipRadarMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('Relationship Radar migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok) throw new Error(before.conflicts.join(',') || 'Relationship Radar migration preflight failed');
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: RELATIONSHIP_RADAR_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: RELATIONSHIP_RADAR_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) {
        throw new Error('injected Relationship Radar migration failure');
      }
    } else if (!markerValid(existing.details)) {
      throw new Error('relationship_radar_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'Relationship Radar migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyRelationshipRadarMigration(
  db: DbClient,
): Promise<RelationshipRadarMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const SNAPSHOT_COLUMNS = new Set([
  'id', 'tenantId', 'customerId', 'matterId', 'createdByUserId', 'agentRunId',
  'generationKey', 'payloadJson', 'payloadFingerprint', 'sourceSetHash', 'signalCount',
  'interventionCount', 'draftCount', 'ruleVersion', 'generatedAt', 'expiresAt',
  'version', 'createdAt',
]);
const SNAPSHOT_INDEXES = new Set([
  'rrs_tenant_run_key',
  'rrs_tenant_creator_generation_key',
  'rrs_tenant_customer_matter_generated_idx',
  'rrs_tenant_matter_expires_idx',
]);

export async function inspectRelationshipRadarSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<RelationshipRadarSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'AgentRun', 'RelationshipRadarSnapshot')`,
  );
  const names = new Set(tables.map((table) => table.name));
  if (!names.has('Tenant') || !names.has('DataMigrationState') || !names.has('AgentRun')) {
    return 'uninitialized';
  }
  if (!names.has('RelationshipRadarSnapshot')) return 'legacy';
  const [columns, indexes, foreignKeys] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("RelationshipRadarSnapshot")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("RelationshipRadarSnapshot")'),
    db.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string }>>(
      'PRAGMA foreign_key_list("RelationshipRadarSnapshot")',
    ),
  ]);
  const columnNames = new Set(columns.map((column) => column.name));
  const namedIndexes = indexes.filter((index) => !index.name.startsWith('sqlite_autoindex_'));
  const indexNames = new Set(namedIndexes.map((index) => index.name));
  const tenantFk = foreignKeys.length === 1
    && foreignKeys[0]?.table === 'Tenant'
    && foreignKeys[0].from === 'tenantId'
    && foreignKeys[0].to === 'id'
    && foreignKeys[0].on_delete.toUpperCase() === 'CASCADE';
  return columnNames.size === SNAPSHOT_COLUMNS.size
    && [...SNAPSHOT_COLUMNS].every((name) => columnNames.has(name))
    && namedIndexes.length === SNAPSHOT_INDEXES.size
    && [...SNAPSHOT_INDEXES].every((name) => indexNames.has(name))
    && tenantFk
    ? 'expanded'
    : 'partial';
}
