import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';

export const INTELLIGENCE_FOCUS_MIGRATION_MARKER = 'SAAS-206-intelligence-focus-v1';
const INTELLIGENCE_FOCUS_MIGRATION_VERSION = 1;

export type IntelligenceFocusSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface IntelligenceFocusMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  intelligenceItems: number;
  stakeholderFocuses: number;
  conflicts: string[];
  schemaFingerprint: string;
}

export interface IntelligenceFocusMigrationApplyResult extends IntelligenceFocusMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  schemaFingerprint: string;
  backfill: {
    intelligenceRows: 0;
    focusRows: 0;
    formalRows: 0;
  };
  integrityChecksum: string;
}

type IntelligenceTarget = {
  kind: 'customer' | 'matter' | 'person' | 'relation';
  id: string;
};

type FocusBasis = {
  kind: 'intelligence_item' | 'interaction' | 'evidence';
  id: string;
  version: number;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const boundedText = (value: string, maximum: number): boolean => (
  value.length > 0 && value.length <= maximum && value.trim() === value
);
const boundedId = (value: string): boolean => (
  value.length > 0
  && value.length <= 200
  && !/[\s\u0000-\u001f\u007f]/u.test(value)
);
const nonnegativeVersion = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const rowKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;

export function intelligenceFocusMigrationSchemaFingerprint(): string {
  return sha256(JSON.stringify({
    marker: INTELLIGENCE_FOCUS_MIGRATION_MARKER,
    version: INTELLIGENCE_FOCUS_MIGRATION_VERSION,
    intelligence: {
      columns: [
        'id', 'tenantId', 'customerId', 'matterId', 'assertionType', 'statement', 'sourceKind',
        'sourceDescription', 'sourceRefId', 'sourceRefVersion', 'occurredAt', 'learnedAt',
        'confidence', 'targetRefs', 'createdByUserId', 'version', 'archivedAt',
        'archivedByUserId', 'archiveReason', 'createdAt', 'updatedAt',
      ],
      unique: [['tenantId', 'id']],
      indexes: [
        ['tenantId', 'customerId', 'learnedAt'],
        ['tenantId', 'matterId', 'learnedAt'],
        ['tenantId', 'assertionType', 'learnedAt'],
        ['tenantId', 'archivedAt', 'learnedAt'],
      ],
    },
    focus: {
      columns: [
        'id', 'tenantId', 'customerId', 'matterId', 'personId', 'desiredChange', 'rationale',
        'evidenceGap', 'basisRefs', 'validUntil', 'activeMatterKey', 'confirmedByUserId',
        'confirmedAt', 'retiredByUserId', 'retiredAt', 'retireReason', 'version',
        'createdAt', 'updatedAt',
      ],
      unique: [['tenantId', 'id'], ['tenantId', 'activeMatterKey']],
      indexes: [
        ['tenantId', 'customerId', 'updatedAt'],
        ['tenantId', 'matterId', 'updatedAt'],
        ['tenantId', 'personId', 'updatedAt'],
      ],
    },
    authority: {
      assertionTypes: ['observed', 'reported', 'inferred'],
      evidenceWrites: 0,
      legacyPrimaryDFallback: false,
    },
    backfill: { intelligenceRows: 0, focusRows: 0, formalRows: 0 },
  }));
}

function markerDetails(): MarkerDetails {
  const receipt = {
    version: INTELLIGENCE_FOCUS_MIGRATION_VERSION,
    schemaFingerprint: intelligenceFocusMigrationSchemaFingerprint(),
    backfill: { intelligenceRows: 0 as const, focusRows: 0 as const, formalRows: 0 as const },
  };
  return { ...receipt, integrityChecksum: sha256(JSON.stringify(receipt)) };
}

function markerValid(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    const expected = markerDetails();
    return value.version === expected.version
      && value.schemaFingerprint === expected.schemaFingerprint
      && value.backfill?.intelligenceRows === 0
      && value.backfill.focusRows === 0
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseTargets(raw: string): IntelligenceTarget[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length < 1 || value.length > 12) return null;
    const seen = new Set<string>();
    const targets: IntelligenceTarget[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      if (!hasExactKeys(record, ['kind', 'id'])) return null;
      if (!['customer', 'matter', 'person', 'relation'].includes(String(record.kind))) return null;
      if (typeof record.id !== 'string' || !boundedId(record.id)) return null;
      const target = { kind: record.kind as IntelligenceTarget['kind'], id: record.id };
      const key = `${target.kind}\u0000${target.id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      targets.push(target);
    }
    return JSON.stringify(targets) === raw ? targets : null;
  } catch {
    return null;
  }
}

function parseBasis(raw: string): FocusBasis[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length > 8) return null;
    const seen = new Set<string>();
    const basis: FocusBasis[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      if (!hasExactKeys(record, ['kind', 'id', 'version'])) return null;
      if (!['intelligence_item', 'interaction', 'evidence'].includes(String(record.kind))) return null;
      if (typeof record.id !== 'string' || !boundedId(record.id)) return null;
      if (typeof record.version !== 'number' || !nonnegativeVersion(record.version)) return null;
      const ref = {
        kind: record.kind as FocusBasis['kind'],
        id: record.id,
        version: record.version,
      };
      const key = `${ref.kind}\u0000${ref.id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      basis.push(ref);
    }
    return JSON.stringify(basis) === raw ? basis : null;
  } catch {
    return null;
  }
}

const intelligenceSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  assertionType: true,
  statement: true,
  sourceKind: true,
  sourceDescription: true,
  sourceRefId: true,
  sourceRefVersion: true,
  occurredAt: true,
  learnedAt: true,
  confidence: true,
  targetRefs: true,
  createdByUserId: true,
  version: true,
  archivedAt: true,
  archivedByUserId: true,
  archiveReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

const focusSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  desiredChange: true,
  rationale: true,
  evidenceGap: true,
  basisRefs: true,
  validUntil: true,
  activeMatterKey: true,
  confirmedByUserId: true,
  confirmedAt: true,
  retiredByUserId: true,
  retiredAt: true,
  retireReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type IntelligenceRow = Prisma.IntelligenceItemGetPayload<{ select: typeof intelligenceSelect }>;
type FocusRow = Prisma.StakeholderFocusGetPayload<{ select: typeof focusSelect }>;

function validateIntelligenceShape(row: IntelligenceRow): string | null {
  if (![row.id, row.tenantId, row.customerId, row.matterId, row.createdByUserId].every(boundedId)
    || !['observed', 'reported', 'inferred'].includes(row.assertionType)
    || !boundedText(row.statement, 2_000)
    || !['manual', 'interaction', 'evidence'].includes(row.sourceKind)
    || !boundedText(row.sourceDescription, 1_000)
    || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1
    || !nonnegativeVersion(row.version)
    || row.createdAt.getTime() > row.updatedAt.getTime()) {
    return 'metadata_invalid';
  }
  if (row.sourceKind === 'manual') {
    if (row.sourceRefId !== null || row.sourceRefVersion !== null) return 'source_invalid';
  } else if (row.sourceRefId === null || !boundedId(row.sourceRefId)
    || row.sourceRefVersion === null || !nonnegativeVersion(row.sourceRefVersion)) {
    return 'source_invalid';
  }
  if ((row.assertionType === 'observed' && row.occurredAt === null)
    || (row.occurredAt !== null && row.occurredAt.getTime() > row.learnedAt.getTime())) {
    return 'time_invalid';
  }
  if (row.archivedAt === null) {
    if (row.archivedByUserId !== null || row.archiveReason !== '') return 'archive_invalid';
  } else if (row.archivedByUserId === null || !boundedId(row.archivedByUserId)
    || !boundedText(row.archiveReason, 500)) {
    return 'archive_invalid';
  }
  if (!parseTargets(row.targetRefs)) return 'target_refs_invalid';
  return null;
}

function validateFocusShape(row: FocusRow): string | null {
  if (![row.id, row.tenantId, row.customerId, row.matterId, row.personId, row.confirmedByUserId]
    .every(boundedId)
    || !boundedText(row.desiredChange, 2_000)
    || !boundedText(row.rationale, 1_000)
    || (row.evidenceGap !== null && !boundedText(row.evidenceGap, 1_000))
    || !nonnegativeVersion(row.version)
    || row.validUntil.getTime() <= row.confirmedAt.getTime()
    || row.createdAt.getTime() > row.updatedAt.getTime()) {
    return 'metadata_invalid';
  }
  const basis = parseBasis(row.basisRefs);
  if (!basis || (basis.length === 0 && row.evidenceGap === null)) return 'basis_invalid';
  if (row.retiredAt === null) {
    if (row.retiredByUserId !== null || row.retireReason !== '') return 'retirement_invalid';
    if (row.activeMatterKey !== row.matterId) return 'active_key_invalid';
  } else {
    if (row.retiredByUserId === null || !boundedId(row.retiredByUserId)
      || !boundedText(row.retireReason, 500)
      || row.retiredAt.getTime() < row.confirmedAt.getTime()
      || row.activeMatterKey !== null) {
      return 'retirement_invalid';
    }
  }
  return null;
}

async function inspect(db: DbClient): Promise<IntelligenceFocusMigrationReport> {
  const schemaFingerprint = intelligenceFocusMigrationSchemaFingerprint();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: INTELLIGENCE_FOCUS_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) conflicts.push('intelligence_focus_marker_invalid');

  let intelligenceRows: IntelligenceRow[] | null;
  let focusRows: FocusRow[] | null;
  try {
    intelligenceRows = await db.intelligenceItem.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: intelligenceSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    intelligenceRows = null;
  }
  try {
    focusRows = await db.stakeholderFocus.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: focusSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    focusRows = null;
  }

  if (intelligenceRows === null || focusRows === null) {
    if ((intelligenceRows === null) !== (focusRows === null)) {
      conflicts.push('intelligence_focus_partial_schema');
    }
    if (markerPresent) conflicts.push('intelligence_focus_marker_without_schema');
    return {
      ok: conflicts.length === 0,
      markerPresent,
      intelligenceItems: 0,
      stakeholderFocuses: 0,
      conflicts,
      schemaFingerprint,
    };
  }

  const tenantIds = [...new Set([
    ...intelligenceRows.map((row) => row.tenantId),
    ...focusRows.map((row) => row.tenantId),
  ])];
  const [tenants, accounts, matters, users, persons, participants, interactions, evidence, edges] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true } }),
    db.account.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true } }),
    db.opportunity.findMany({
      where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, accountId: true },
    }),
    db.user.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true } }),
    db.person.findMany({
      where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, accountId: true },
    }),
    db.matterParticipant.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { tenantId: true, accountId: true, opportunityId: true, personId: true },
    }),
    db.interaction.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true, accountId: true, matterId: true, version: true },
    }),
    db.evidenceEvent.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true, accountId: true, opportunityId: true },
    }),
    db.edge.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true, accountId: true, opportunityId: true },
    }),
  ]);
  const tenantSet = new Set(tenants.map((row) => row.id));
  const accountMap = new Map(accounts.map((row) => [rowKey(row.tenantId, row.id), row]));
  const matterMap = new Map(matters.map((row) => [rowKey(row.tenantId, row.id), row]));
  const userSet = new Set(users.map((row) => rowKey(row.tenantId, row.id)));
  const personMap = new Map(persons.map((row) => [rowKey(row.tenantId, row.id), row]));
  const participantSet = new Set(participants.map((row) => (
    `${row.tenantId}\u0000${row.accountId}\u0000${row.opportunityId}\u0000${row.personId}`
  )));
  const interactionMap = new Map(interactions.map((row) => [rowKey(row.tenantId, row.id), row]));
  const evidenceMap = new Map(evidence.map((row) => [rowKey(row.tenantId, row.id), row]));
  const edgeMap = new Map(edges.map((row) => [rowKey(row.tenantId, row.id), row]));
  const intelligenceMap = new Map(intelligenceRows.map((row) => [rowKey(row.tenantId, row.id), row]));

  const parentClosureValid = (tenantId: string, customerId: string, matterId: string): boolean => {
    const account = accountMap.get(rowKey(tenantId, customerId));
    const matter = matterMap.get(rowKey(tenantId, matterId));
    return Boolean(tenantSet.has(tenantId) && account && matter && matter.accountId === customerId);
  };
  const personClosureValid = (
    tenantId: string, customerId: string, matterId: string, personId: string,
  ): boolean => {
    const person = personMap.get(rowKey(tenantId, personId));
    return Boolean(person?.accountId === customerId && participantSet.has(
      `${tenantId}\u0000${customerId}\u0000${matterId}\u0000${personId}`,
    ));
  };

  for (const row of intelligenceRows) {
    const prefix = `${row.tenantId}:intelligence:${row.id}`;
    const invalid = validateIntelligenceShape(row);
    if (invalid) {
      conflicts.push(`${prefix}:${invalid}`);
      continue;
    }
    if (!parentClosureValid(row.tenantId, row.customerId, row.matterId)
      || !userSet.has(rowKey(row.tenantId, row.createdByUserId))
      || (row.archivedByUserId !== null && !userSet.has(rowKey(row.tenantId, row.archivedByUserId)))) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
      continue;
    }
    if (row.sourceKind === 'interaction') {
      const linked = interactionMap.get(rowKey(row.tenantId, row.sourceRefId!));
      if (!linked || linked.accountId !== row.customerId || linked.matterId !== row.matterId
        || linked.version !== row.sourceRefVersion) {
        conflicts.push(`${prefix}:source_closure_invalid`);
      }
    } else if (row.sourceKind === 'evidence') {
      const linked = evidenceMap.get(rowKey(row.tenantId, row.sourceRefId!));
      if (!linked || linked.accountId !== row.customerId || linked.opportunityId !== row.matterId
        || row.sourceRefVersion !== 0) {
        conflicts.push(`${prefix}:source_closure_invalid`);
      }
    }
    const targets = parseTargets(row.targetRefs)!;
    const targetsValid = targets.every((target) => {
      if (target.kind === 'customer') return target.id === row.customerId;
      if (target.kind === 'matter') return target.id === row.matterId;
      if (target.kind === 'person') {
        return personClosureValid(row.tenantId, row.customerId, row.matterId, target.id);
      }
      const edge = edgeMap.get(rowKey(row.tenantId, target.id));
      return edge?.accountId === row.customerId && edge.opportunityId === row.matterId;
    });
    if (!targetsValid) conflicts.push(`${prefix}:target_closure_invalid`);
  }

  for (const row of focusRows) {
    const prefix = `${row.tenantId}:focus:${row.id}`;
    const invalid = validateFocusShape(row);
    if (invalid) {
      conflicts.push(`${prefix}:${invalid}`);
      continue;
    }
    if (!parentClosureValid(row.tenantId, row.customerId, row.matterId)
      || !personClosureValid(row.tenantId, row.customerId, row.matterId, row.personId)
      || !userSet.has(rowKey(row.tenantId, row.confirmedByUserId))
      || (row.retiredByUserId !== null && !userSet.has(rowKey(row.tenantId, row.retiredByUserId)))) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
      continue;
    }
    const basis = parseBasis(row.basisRefs)!;
    const basisValid = basis.every((ref) => {
      if (ref.kind === 'intelligence_item') {
        const linked = intelligenceMap.get(rowKey(row.tenantId, ref.id));
        return linked?.customerId === row.customerId && linked.matterId === row.matterId
          && linked.version === ref.version;
      }
      if (ref.kind === 'interaction') {
        const linked = interactionMap.get(rowKey(row.tenantId, ref.id));
        return linked?.accountId === row.customerId && linked.matterId === row.matterId
          && linked.version === ref.version;
      }
      const linked = evidenceMap.get(rowKey(row.tenantId, ref.id));
      return linked?.accountId === row.customerId && linked.opportunityId === row.matterId
        && ref.version === 0;
    });
    if (!basisValid) conflicts.push(`${prefix}:basis_closure_invalid`);
  }

  return {
    ok: conflicts.length === 0,
    markerPresent,
    intelligenceItems: intelligenceRows.length,
    stakeholderFocuses: focusRows.length,
    conflicts,
    schemaFingerprint,
  };
}

export async function reportIntelligenceFocusMigration(
  db: DbClient,
): Promise<IntelligenceFocusMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyIntelligenceFocusMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<IntelligenceFocusMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('Intelligence/Focus migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok) {
      throw new Error(before.conflicts.join(',') || 'Intelligence/Focus migration preflight failed');
    }
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: INTELLIGENCE_FOCUS_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: INTELLIGENCE_FOCUS_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) {
        throw new Error('injected Intelligence/Focus migration failure');
      }
    } else if (!markerValid(existing.details)) {
      throw new Error('intelligence_focus_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'Intelligence/Focus migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyIntelligenceFocusMigration(
  db: DbClient,
): Promise<IntelligenceFocusMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const INTELLIGENCE_COLUMNS = new Set([
  'id', 'tenantId', 'customerId', 'matterId', 'assertionType', 'statement', 'sourceKind',
  'sourceDescription', 'sourceRefId', 'sourceRefVersion', 'occurredAt', 'learnedAt',
  'confidence', 'targetRefs', 'createdByUserId', 'version', 'archivedAt',
  'archivedByUserId', 'archiveReason', 'createdAt', 'updatedAt',
]);
const INTELLIGENCE_INDEXES = new Set([
  'IntelligenceItem_tenantId_customerId_learnedAt_idx',
  'IntelligenceItem_tenantId_matterId_learnedAt_idx',
  'IntelligenceItem_tenantId_assertionType_learnedAt_idx',
  'IntelligenceItem_tenantId_archivedAt_learnedAt_idx',
  'IntelligenceItem_tenantId_id_key',
]);
const FOCUS_COLUMNS = new Set([
  'id', 'tenantId', 'customerId', 'matterId', 'personId', 'desiredChange', 'rationale',
  'evidenceGap', 'basisRefs', 'validUntil', 'activeMatterKey', 'confirmedByUserId',
  'confirmedAt', 'retiredByUserId', 'retiredAt', 'retireReason', 'version',
  'createdAt', 'updatedAt',
]);
const FOCUS_INDEXES = new Set([
  'StakeholderFocus_tenantId_customerId_updatedAt_idx',
  'StakeholderFocus_tenantId_matterId_updatedAt_idx',
  'StakeholderFocus_tenantId_personId_updatedAt_idx',
  'StakeholderFocus_tenantId_id_key',
  'StakeholderFocus_tenantId_activeMatterKey_key',
]);

async function sqliteTableIsExact(
  db: Pick<DbClient, '$queryRawUnsafe'>,
  table: 'IntelligenceItem' | 'StakeholderFocus',
  expectedColumns: ReadonlySet<string>,
  expectedIndexes: ReadonlySet<string>,
): Promise<boolean> {
  const [columns, indexes, foreignKeys] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`),
    db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA index_list("${table}")`),
    db.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string }>>(
      `PRAGMA foreign_key_list("${table}")`,
    ),
  ]);
  const exactColumns = columns.length === expectedColumns.size
    && columns.every((row) => expectedColumns.has(row.name));
  const namedIndexes = indexes.filter((row) => !row.name.startsWith('sqlite_autoindex_'));
  const exactIndexes = namedIndexes.length === expectedIndexes.size
    && namedIndexes.every((row) => expectedIndexes.has(row.name));
  const exactTenantFk = foreignKeys.length === 1
    && foreignKeys[0]?.table === 'Tenant'
    && foreignKeys[0].from === 'tenantId'
    && foreignKeys[0].to === 'id'
    && foreignKeys[0].on_delete.toUpperCase() === 'CASCADE';
  return exactColumns && exactIndexes && exactTenantFk;
}

export async function inspectIntelligenceFocusSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<IntelligenceFocusSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'ResearchBriefSnapshot',
                     'IntelligenceItem', 'StakeholderFocus')`,
  );
  const names = new Set(tables.map((table) => table.name));
  if (!names.has('Tenant') || !names.has('DataMigrationState') || !names.has('ResearchBriefSnapshot')) {
    return 'uninitialized';
  }
  const hasIntelligence = names.has('IntelligenceItem');
  const hasFocus = names.has('StakeholderFocus');
  if (!hasIntelligence && !hasFocus) return 'legacy';
  if (!hasIntelligence || !hasFocus) return 'partial';
  const [intelligenceExact, focusExact] = await Promise.all([
    sqliteTableIsExact(db, 'IntelligenceItem', INTELLIGENCE_COLUMNS, INTELLIGENCE_INDEXES),
    sqliteTableIsExact(db, 'StakeholderFocus', FOCUS_COLUMNS, FOCUS_INDEXES),
  ]);
  return intelligenceExact && focusExact ? 'expanded' : 'partial';
}
