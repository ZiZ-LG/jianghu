import type { Prisma, PrismaClient } from '@prisma/client';
import { CommitmentV2Schema } from '@jianghu/domain-contracts';
import {
  mapLegacyPlanActionToCommitmentFields,
  type LegacyCommitmentFields,
} from './legacy.js';

const PAGE_SIZE = 250;
const LOOKUP_CHUNK_SIZE = 100;
export const COMMITMENT_MIGRATION_KEY = 'CORE-106-commitment-backfill-v1';
export const COMMITMENT_CUTOVER_KEY = 'CORE-108-commitment-consumer-cutover-v1';

type CommitmentMigrationDb = PrismaClient | Prisma.TransactionClient;

interface LegacyPlanActionRow {
  id: string;
  tenantId: string;
  accountId: string;
  opportunityId: string | null;
  personId: string | null;
  title: string;
  ownerId: string;
  startDate: string;
  endDate: string;
  done: boolean;
  origin: string;
  createdBy: string;
}

interface CommitmentCandidate extends Omit<LegacyPlanActionRow, 'opportunityId'> {
  opportunityId: string;
  fields: LegacyCommitmentFields;
}

export type CommitmentMigrationInvalidReason =
  | 'missing_tenant'
  | 'missing_account'
  | 'missing_opportunity'
  | 'opportunity_account_mismatch'
  | 'missing_person'
  | 'person_account_mismatch'
  | 'invalid_owner_user'
  | 'empty_title'
  | 'invalid_start_date'
  | 'invalid_end_date'
  | 'missing_business_date';

export interface CommitmentMigrationInvalidRow {
  tenantId: string;
  id: string;
  reason: CommitmentMigrationInvalidReason;
}

export interface CommitmentMigrationReport {
  sourceRows: number;
  candidateRows: number;
  unassignedOwnerRows: number;
  invalidRows: CommitmentMigrationInvalidRow[];
}

export interface CommitmentBackfillResult {
  candidateRows: number;
  unassignedOwnerRows: number;
  updatedRows: number;
}

export interface CommitmentParityConflict {
  tenantId: string;
  id: string;
  field: string;
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
}

type IntegrityCount = { sourceRows: number | bigint | string; missingTenantRows: number | bigint | string };

function count(value: number | bigint | string | undefined): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error('invalid Commitment migration count');
  return normalized;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function inspectIntegrity(db: CommitmentMigrationDb): Promise<{ sourceRows: number; missingTenantRows: number }> {
  // Migration-only aggregate. Business rows are loaded below one tenant at a
  // time so malformed tenant ids cannot leak data into another tenant pass.
  const rows = await db.$queryRawUnsafe<IntegrityCount[]>(`
    SELECT
      (SELECT COUNT(*) FROM "PlanAction") AS "sourceRows",
      (SELECT COUNT(*)
         FROM "PlanAction" AS action
         LEFT JOIN "Tenant" AS tenant ON tenant.id = action."tenantId"
        WHERE tenant.id IS NULL) AS "missingTenantRows"
  `);
  return {
    sourceRows: count(rows[0]?.sourceRows),
    missingTenantRows: count(rows[0]?.missingTenantRows),
  };
}

function mappingReason(error: unknown): CommitmentMigrationInvalidReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('startDate')) return 'invalid_start_date';
  if (message.includes('endDate')) return 'invalid_end_date';
  return 'missing_business_date';
}

async function inspectCommitmentCandidates(db: CommitmentMigrationDb): Promise<{
  report: CommitmentMigrationReport;
  candidates: CommitmentCandidate[];
}> {
  const integrity = await inspectIntegrity(db);
  const tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  const report: CommitmentMigrationReport = {
    sourceRows: 0,
    candidateRows: 0,
    unassignedOwnerRows: 0,
    invalidRows: [],
  };
  const candidates: CommitmentCandidate[] = [];

  for (const tenant of tenants) {
    let cursor: string | undefined;
    while (true) {
      const rows: LegacyPlanActionRow[] = await db.planAction.findMany({
        where: { tenantId: tenant.id },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
          title: true, ownerId: true, startDate: true, endDate: true, done: true,
          origin: true, createdBy: true,
        },
      });
      if (rows.length === 0) break;
      report.sourceRows += rows.length;

      const accountIds = [...new Set(rows.map((row) => row.accountId))];
      const opportunityIds = [...new Set(rows.flatMap((row) => row.opportunityId ? [row.opportunityId] : []))];
      const personIds = [...new Set(rows.flatMap((row) => row.personId ? [row.personId] : []))];
      const userIds = [...new Set(rows.flatMap((row) => row.ownerId ? [row.ownerId] : []))];
      const [accounts, opportunities, persons, users] = await Promise.all([
        db.account.findMany({
          where: { tenantId: tenant.id, id: { in: accountIds } }, select: { id: true },
        }),
        db.opportunity.findMany({
          where: { tenantId: tenant.id, id: { in: opportunityIds } }, select: { id: true, accountId: true },
        }),
        personIds.length === 0 ? Promise.resolve([]) : db.person.findMany({
          where: { tenantId: tenant.id, id: { in: personIds } }, select: { id: true, accountId: true },
        }),
        userIds.length === 0 ? Promise.resolve([]) : db.user.findMany({
          where: { tenantId: tenant.id, id: { in: userIds } }, select: { id: true },
        }),
      ]);
      const accountSet = new Set(accounts.map((row) => row.id));
      const opportunityById = new Map(opportunities.map((row) => [row.id, row]));
      const personById = new Map(persons.map((row) => [row.id, row]));
      const userSet = new Set(users.map((row) => row.id));

      for (const row of rows) {
        if (row.tenantId !== tenant.id) throw new Error(`Commitment source escaped tenant scope (${tenant.id})`);
        // Once CORE-108 is released, customer-level rows are already generic
        // Commitments and are never candidates for legacy PlanAction backfill.
        if (!row.opportunityId) continue;
        let reason: CommitmentMigrationInvalidReason | undefined;
        const opportunity = opportunityById.get(row.opportunityId);
        const person = row.personId ? personById.get(row.personId) : undefined;
        if (!accountSet.has(row.accountId)) reason = 'missing_account';
        else if (!opportunity) reason = 'missing_opportunity';
        else if (opportunity.accountId !== row.accountId) reason = 'opportunity_account_mismatch';
        else if (row.personId && !person) reason = 'missing_person';
        else if (person && person.accountId !== row.accountId) reason = 'person_account_mismatch';
        else if (row.ownerId && !userSet.has(row.ownerId)) reason = 'invalid_owner_user';
        else if (!row.title.trim()) reason = 'empty_title';

        const ownerUserId = row.ownerId || null;
        let fields: LegacyCommitmentFields | undefined;
        if (!reason) {
          try {
            fields = mapLegacyPlanActionToCommitmentFields(row, ownerUserId);
          } catch (error) {
            reason = mappingReason(error);
          }
        }
        if (reason || !fields) {
          report.invalidRows.push({ tenantId: row.tenantId, id: row.id, reason: reason ?? 'missing_business_date' });
          continue;
        }
        if (!ownerUserId) report.unassignedOwnerRows += 1;
        candidates.push({ ...row, opportunityId: row.opportunityId, fields });
      }

      cursor = rows.at(-1)?.id;
      if (rows.length < PAGE_SIZE) break;
    }
  }

  if (integrity.missingTenantRows > 0 || report.sourceRows !== integrity.sourceRows) {
    report.invalidRows.unshift({ tenantId: '', id: '', reason: 'missing_tenant' });
  }
  report.candidateRows = candidates.length;
  return { report, candidates };
}

export async function inspectCommitmentMigration(db: CommitmentMigrationDb): Promise<CommitmentMigrationReport> {
  return (await inspectCommitmentCandidates(db)).report;
}

function assertValid(report: CommitmentMigrationReport): void {
  if (report.invalidRows.length === 0) return;
  throw new Error(`invalid legacy PlanAction rows (${report.invalidRows.length})`);
}

const comparableFields = [
  'kind', 'ownerUserId', 'executionStatus', 'confirmationStatus',
  'scheduledAtUtc', 'dueAtUtc', 'timeZone', 'isAllDay', 'localDate',
  'confirmationDueAtUtc', 'confirmedAtUtc', 'confirmedByUserId',
  'scheduleVersion', 'nextCommitmentId', 'source', 'sourceRef',
  'archivedAt', 'version',
] as const satisfies readonly (keyof LegacyCommitmentFields)[];

function comparable(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error('unsupported Commitment parity value');
}

async function compareStoredCandidates(
  db: CommitmentMigrationDb,
  candidates: readonly CommitmentCandidate[],
  sampleLimit = 100,
): Promise<CommitmentParityConflict[]> {
  const conflicts: CommitmentParityConflict[] = [];
  for (const group of chunks(candidates, LOOKUP_CHUNK_SIZE)) {
    const rows = await db.planAction.findMany({
      where: { OR: group.map((candidate) => ({ id: candidate.id, tenantId: candidate.tenantId })) },
      select: {
        id: true, tenantId: true,
        kind: true, ownerUserId: true, executionStatus: true, confirmationStatus: true,
        scheduledAtUtc: true, dueAtUtc: true, timeZone: true, isAllDay: true, localDate: true,
        confirmationDueAtUtc: true, confirmedAtUtc: true, confirmedByUserId: true,
        scheduleVersion: true, nextCommitmentId: true, source: true, sourceRef: true,
        archivedAt: true, version: true,
      },
    });
    const storedById = new Map(rows.map((row) => [row.id, row]));
    for (const candidate of group) {
      const stored = storedById.get(candidate.id);
      if (!stored) {
        conflicts.push({ tenantId: candidate.tenantId, id: candidate.id, field: 'row', expected: 'present', actual: null });
        continue;
      }
      for (const field of comparableFields) {
        const expected = comparable(candidate.fields[field]);
        const actual = comparable(stored[field]);
        if (expected !== actual) conflicts.push({ tenantId: candidate.tenantId, id: candidate.id, field, expected, actual });
        if (conflicts.length >= sampleLimit) return conflicts;
      }
    }
  }
  return conflicts;
}

export async function applyCommitmentBackfill(db: PrismaClient): Promise<CommitmentBackfillResult> {
  return db.$transaction(async (tx) => {
    const inspection = await inspectCommitmentCandidates(tx);
    assertValid(inspection.report);
    let updatedRows = 0;
    for (const candidate of inspection.candidates) {
      const updated = await tx.planAction.updateMany({
        where: {
          id: candidate.id,
          tenantId: candidate.tenantId,
          accountId: candidate.accountId,
          opportunityId: candidate.opportunityId,
          personId: candidate.personId,
          ownerId: candidate.ownerId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          done: candidate.done,
          origin: candidate.origin,
          createdBy: candidate.createdBy,
        },
        data: candidate.fields,
      });
      if (updated.count !== 1) throw new Error(`PlanAction changed during Commitment backfill (${candidate.id})`);
      updatedRows += 1;
    }
    const conflicts = await compareStoredCandidates(tx, inspection.candidates);
    if (conflicts.length > 0) throw new Error(`Commitment backfill parity failed (${conflicts.length} sampled conflicts)`);
    await tx.dataMigrationState.upsert({
      where: { key: COMMITMENT_MIGRATION_KEY },
      create: {
        key: COMMITMENT_MIGRATION_KEY,
        details: JSON.stringify({
          source: 'PlanAction legacy fields',
          authority: 'legacy PlanAction until CORE-107',
          timeZone: 'Asia/Shanghai',
          allDay: true,
        }),
      },
      update: {},
    });
    return {
      candidateRows: inspection.report.candidateRows,
      unassignedOwnerRows: inspection.report.unassignedOwnerRows,
      updatedRows,
    };
  }, { timeout: 15 * 60 * 1000 });
}

export async function hasCommitmentMigrationMarker(db: CommitmentMigrationDb): Promise<boolean> {
  return !!(await db.dataMigrationState.findUnique({
    where: { key: COMMITMENT_MIGRATION_KEY }, select: { key: true },
  }));
}

export async function hasCommitmentCutoverMarker(db: CommitmentMigrationDb): Promise<boolean> {
  try {
    return !!(await db.dataMigrationState.findUnique({
      where: { key: COMMITMENT_CUTOVER_KEY }, select: { key: true },
    }));
  } catch (error) {
    // Pre-CORE-105 legacy databases do not have DataMigrationState yet. This
    // is the expected pre-expand state, not evidence of a completed cutover.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') return false;
    throw error;
  }
}

export async function isCommitmentMatterNullable(db: CommitmentMigrationDb): Promise<boolean> {
  if ((process.env.DATABASE_URL ?? '').startsWith('file:')) {
    const columns = await db.$queryRawUnsafe<Array<{ name: string; notnull: number | bigint }>>(
      'PRAGMA table_info("PlanAction")',
    );
    const opportunityId = columns.find((column) => column.name === 'opportunityId');
    if (!opportunityId) throw new Error('PlanAction.opportunityId is missing');
    return Number(opportunityId.notnull) === 0;
  }
  const columns = await db.$queryRawUnsafe<Array<{ isNullable: string }>>(`
    SELECT is_nullable AS "isNullable"
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'PlanAction'
       AND column_name = 'opportunityId'
  `);
  if (!columns[0]) throw new Error('PlanAction.opportunityId is missing');
  return columns[0].isNullable === 'YES';
}

/**
 * Post-cutover integrity validates the generic authority itself. It never
 * compares against legacy dates/status/owner fields, so later valid generic
 * commands cannot be mistaken for migration drift.
 */
export async function verifyCurrentCommitmentIntegrity(
  db: CommitmentMigrationDb,
  sampleLimit = 100,
): Promise<CommitmentParityConflict[]> {
  const integrity = await inspectIntegrity(db);
  const tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  const conflicts: CommitmentParityConflict[] = [];
  let scopedRows = 0;
  const push = (tenantId: string, id: string, field: string, actual: string | number | boolean | null) => {
    if (conflicts.length < sampleLimit) conflicts.push({ tenantId, id, field, expected: 'valid', actual });
  };

  for (const tenant of tenants) {
    let cursor: string | undefined;
    while (conflicts.length < sampleLimit) {
      const rows = await db.planAction.findMany({
        where: { tenantId: tenant.id },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true, tenantId: true, accountId: true, opportunityId: true, personId: true,
          title: true, kind: true, ownerUserId: true, executionStatus: true,
          confirmationStatus: true, scheduledAtUtc: true, dueAtUtc: true, timeZone: true,
          isAllDay: true, localDate: true, confirmationDueAtUtc: true, confirmedAtUtc: true,
          confirmedByUserId: true, scheduleVersion: true, nextCommitmentId: true,
          source: true, sourceRef: true, archivedAt: true, version: true,
        },
      });
      if (rows.length === 0) break;
      scopedRows += rows.length;

      const accountIds = [...new Set(rows.map((row) => row.accountId))];
      const matterIds = [...new Set(rows.flatMap((row) => row.opportunityId ? [row.opportunityId] : []))];
      const personIds = [...new Set(rows.flatMap((row) => row.personId ? [row.personId] : []))];
      const nextCommitmentIds = [...new Set(rows.flatMap((row) => row.nextCommitmentId ? [row.nextCommitmentId] : []))];
      const userIds = [...new Set(rows.flatMap((row) => [row.ownerUserId, row.confirmedByUserId]
        .filter((id): id is string => !!id)))];
      const [accounts, matters, persons, users, nextCommitments] = await Promise.all([
        db.account.findMany({ where: { tenantId: tenant.id, id: { in: accountIds } }, select: { id: true } }),
        matterIds.length ? db.opportunity.findMany({
          where: { tenantId: tenant.id, id: { in: matterIds } }, select: { id: true, accountId: true },
        }) : Promise.resolve([]),
        personIds.length ? db.person.findMany({
          where: { tenantId: tenant.id, id: { in: personIds } }, select: { id: true, accountId: true },
        }) : Promise.resolve([]),
        userIds.length ? db.user.findMany({
          where: { tenantId: tenant.id, id: { in: userIds } }, select: { id: true },
        }) : Promise.resolve([]),
        nextCommitmentIds.length ? db.planAction.findMany({
          where: { tenantId: tenant.id, id: { in: nextCommitmentIds } },
          select: { id: true, accountId: true },
        }) : Promise.resolve([]),
      ]);
      const accountSet = new Set(accounts.map((row) => row.id));
      const matterById = new Map(matters.map((row) => [row.id, row]));
      const personById = new Map(persons.map((row) => [row.id, row]));
      const userSet = new Set(users.map((row) => row.id));
      const nextCommitmentById = new Map(nextCommitments.map((row) => [row.id, row]));

      for (const row of rows) {
        if (row.tenantId !== tenant.id) {
          push(tenant.id, row.id, 'tenantId', row.tenantId);
          continue;
        }
        const matter = row.opportunityId ? matterById.get(row.opportunityId) : undefined;
        const person = row.personId ? personById.get(row.personId) : undefined;
        if (!accountSet.has(row.accountId)) push(row.tenantId, row.id, 'customerId', row.accountId);
        else if (row.opportunityId && (!matter || matter.accountId !== row.accountId)) {
          push(row.tenantId, row.id, 'matterId', row.opportunityId);
        } else if (row.personId && (!person || person.accountId !== row.accountId)) {
          push(row.tenantId, row.id, 'personId', row.personId);
        } else if (row.ownerUserId && !userSet.has(row.ownerUserId)) {
          push(row.tenantId, row.id, 'ownerUserId', row.ownerUserId);
        } else if (row.confirmedByUserId && !userSet.has(row.confirmedByUserId)) {
          push(row.tenantId, row.id, 'confirmedByUserId', row.confirmedByUserId);
        } else if (row.nextCommitmentId
          && nextCommitmentById.get(row.nextCommitmentId)?.accountId !== row.accountId) {
          push(row.tenantId, row.id, 'nextCommitmentId', row.nextCommitmentId);
        } else {
          const parsed = CommitmentV2Schema.safeParse({
            id: row.id, customerId: row.accountId, matterId: row.opportunityId,
            personId: row.personId, title: row.title, kind: row.kind,
            ownerUserId: row.ownerUserId, executionStatus: row.executionStatus,
            confirmationStatus: row.confirmationStatus,
            scheduledAtUtc: row.scheduledAtUtc?.toISOString() ?? null,
            dueAtUtc: row.dueAtUtc?.toISOString() ?? null, timeZone: row.timeZone,
            isAllDay: row.isAllDay, localDate: row.localDate,
            confirmationDueAtUtc: row.confirmationDueAtUtc?.toISOString() ?? null,
            confirmedAtUtc: row.confirmedAtUtc?.toISOString() ?? null,
            confirmedByUserId: row.confirmedByUserId, scheduleVersion: row.scheduleVersion,
            nextCommitmentId: row.nextCommitmentId, source: row.source,
            sourceRef: row.sourceRef, archivedAt: row.archivedAt?.toISOString() ?? null,
            version: row.version,
          });
          if (!parsed.success) push(row.tenantId, row.id, 'generic_contract', 'invalid');
        }
        if (conflicts.length >= sampleLimit) break;
      }

      cursor = rows.at(-1)?.id;
      if (rows.length < PAGE_SIZE) break;
    }
  }

  if (conflicts.length < sampleLimit && (integrity.missingTenantRows > 0 || scopedRows !== integrity.sourceRows)) {
    push('', '', 'tenantId', null);
  }
  return conflicts;
}

export async function markCommitmentCutover(db: CommitmentMigrationDb): Promise<void> {
  if (!(await isCommitmentMatterNullable(db))) {
    throw new Error('PlanAction.opportunityId must be nullable before CORE-108 cutover is marked');
  }
  const conflicts = await verifyCurrentCommitmentIntegrity(db);
  if (conflicts.length > 0) {
    throw new Error(`Commitment cutover preflight failed (${conflicts.length} sampled conflicts)`);
  }
  await db.dataMigrationState.upsert({
    where: { key: COMMITMENT_CUTOVER_KEY },
    create: {
      key: COMMITMENT_CUTOVER_KEY,
      details: JSON.stringify({
        authority: 'generic same-row Commitment fields',
        matter: 'nullable',
        legacyPlanAction: 'matter-required adapter',
      }),
    },
    update: {},
  });
}

export async function verifyCommitmentBackfill(
  db: CommitmentMigrationDb,
  sampleLimit = 100,
): Promise<CommitmentParityConflict[]> {
  const inspection = await inspectCommitmentCandidates(db);
  if (inspection.report.invalidRows.length > 0) {
    return inspection.report.invalidRows.slice(0, sampleLimit).map((row) => ({
      tenantId: row.tenantId,
      id: row.id,
      field: `invalid_source:${row.reason}`,
      expected: 'valid',
      actual: null,
    }));
  }
  return compareStoredCandidates(db, inspection.candidates, sampleLimit);
}
