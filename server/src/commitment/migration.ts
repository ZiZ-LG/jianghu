import type { Prisma, PrismaClient } from '@prisma/client';
import {
  mapLegacyPlanActionToCommitmentFields,
  type LegacyCommitmentFields,
} from './legacy.js';

const PAGE_SIZE = 250;
const LOOKUP_CHUNK_SIZE = 100;
export const COMMITMENT_MIGRATION_KEY = 'CORE-106-commitment-backfill-v1';

type CommitmentMigrationDb = PrismaClient | Prisma.TransactionClient;

interface LegacyPlanActionRow {
  id: string;
  tenantId: string;
  accountId: string;
  opportunityId: string;
  personId: string | null;
  title: string;
  ownerId: string;
  startDate: string;
  endDate: string;
  done: boolean;
  origin: string;
  createdBy: string;
}

interface CommitmentCandidate extends LegacyPlanActionRow {
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
      const opportunityIds = [...new Set(rows.map((row) => row.opportunityId))];
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
        candidates.push({ ...row, fields });
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
