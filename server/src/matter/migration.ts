import type { Prisma, PrismaClient } from '@prisma/client';
import {
  isLegacyOpportunityStatus,
  mapLegacyOpportunityStatus,
} from './lifecycle.js';

export interface MatterMigrationMappingCount {
  legacyStatus: string;
  lifecycleStatus: string;
  outcomeKey: string | null;
  count: number;
}

export interface UnsupportedMatterStatusCount {
  legacyStatus: string;
  count: number;
}

export interface TenantMatterMigrationReport {
  tenantId: string;
  totalRows: number;
  supportedRows: number;
  unsupportedRows: number;
  mappings: MatterMigrationMappingCount[];
  unsupported: UnsupportedMatterStatusCount[];
}

export interface MatterParityConflict {
  tenantId: string;
  id: string;
  status: string;
  lifecycleStatus: string;
  outcomeKey: string | null;
  expectedLifecycleStatus: string | null;
  expectedOutcomeKey: string | null;
}

export interface MatterMigrationIntegrityReport {
  totalRows: number;
  missingTenantRows: number;
  missingAccountRows: number;
  accountTenantMismatchRows: number;
}

type MatterReadClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  'opportunity' | '$queryRawUnsafe'
>;

type MatterIntegrityCountRow = {
  totalRows: number | bigint | string;
  missingTenantRows: number | bigint | string;
  missingAccountRows: number | bigint | string;
  accountTenantMismatchRows: number | bigint | string;
};

function normalizeCount(value: number | bigint | string | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid Matter migration integrity count');
  return count;
}

export async function inspectMatterMigrationIntegrity(
  db: MatterReadClient,
): Promise<MatterMigrationIntegrityReport> {
  // Migration-only aggregate: no business content leaves the database. The
  // anti-join is required to detect rows whose tenant cannot be enumerated by
  // the normal tenant-scoped pass.
  const rows = await db.$queryRawUnsafe<MatterIntegrityCountRow[]>(`
    SELECT
      (SELECT COUNT(*) FROM "Opportunity") AS "totalRows",
      (SELECT COUNT(*)
         FROM "Opportunity" AS opportunity
         LEFT JOIN "Tenant" AS tenant ON tenant.id = opportunity."tenantId"
        WHERE tenant.id IS NULL) AS "missingTenantRows",
      (SELECT COUNT(*)
         FROM "Opportunity" AS opportunity
         LEFT JOIN "Account" AS account ON account.id = opportunity."accountId"
        WHERE account.id IS NULL) AS "missingAccountRows",
      (SELECT COUNT(*)
         FROM "Opportunity" AS opportunity
         JOIN "Account" AS account ON account.id = opportunity."accountId"
        WHERE account."tenantId" <> opportunity."tenantId") AS "accountTenantMismatchRows"
  `);
  const row = rows[0];
  return {
    totalRows: normalizeCount(row?.totalRows),
    missingTenantRows: normalizeCount(row?.missingTenantRows),
    missingAccountRows: normalizeCount(row?.missingAccountRows),
    accountTenantMismatchRows: normalizeCount(row?.accountTenantMismatchRows),
  };
}

export function assertMatterMigrationIntegrity(report: MatterMigrationIntegrityReport): void {
  if (report.missingTenantRows === 0
    && report.missingAccountRows === 0
    && report.accountTenantMismatchRows === 0) return;
  throw new Error(
    `Matter migration integrity failed: missingTenant=${report.missingTenantRows}, `
    + `missingAccount=${report.missingAccountRows}, accountTenantMismatch=${report.accountTenantMismatchRows}`,
  );
}

export async function inspectTenantMatterMigration(
  db: MatterReadClient,
  tenantId: string,
): Promise<TenantMatterMigrationReport> {
  const reports = await inspectMatterMigrationForTenants(db, [tenantId]);
  return reports[0]!;
}

export async function inspectMatterMigrationForTenants(
  db: MatterReadClient,
  tenantIds: readonly string[],
): Promise<TenantMatterMigrationReport[]> {
  const scopedTenantIds = [...new Set(tenantIds)].sort();
  const reports = new Map(scopedTenantIds.map((tenantId) => [tenantId, {
    tenantId,
    totalRows: 0,
    supportedRows: 0,
    unsupportedRows: 0,
    mappings: [] as MatterMigrationMappingCount[],
    unsupported: [] as UnsupportedMatterStatusCount[],
  }]));
  if (scopedTenantIds.length === 0) return [];
  const groups = await db.opportunity.groupBy({
    by: ['tenantId', 'status'],
    where: { tenantId: { in: scopedTenantIds } },
    _count: { _all: true },
    orderBy: [{ tenantId: 'asc' }, { status: 'asc' }],
  });
  for (const group of groups) {
    const report = reports.get(group.tenantId);
    if (!report) throw new Error(`Matter report escaped requested tenant scope: ${group.tenantId}`);
    const count = group._count._all;
    if (isLegacyOpportunityStatus(group.status)) {
      report.mappings.push({ legacyStatus: group.status, ...mapLegacyOpportunityStatus(group.status), count });
      report.supportedRows += count;
    } else {
      report.unsupported.push({ legacyStatus: group.status, count });
      report.unsupportedRows += count;
    }
    report.totalRows += count;
  }
  return scopedTenantIds.map((tenantId) => reports.get(tenantId)!);
}

export async function applyMatterFieldBackfill(db: PrismaClient, tenantId: string): Promise<void> {
  await applyMatterFieldBackfillForTenants(db, [tenantId]);
}

export async function applyMatterFieldBackfillForTenants(
  db: PrismaClient,
  tenantIds: readonly string[],
): Promise<void> {
  const scopedTenantIds = [...new Set(tenantIds)].sort();
  await db.$transaction(async (tx) => {
    assertMatterMigrationIntegrity(await inspectMatterMigrationIntegrity(tx));
    const reports = await inspectMatterMigrationForTenants(tx, scopedTenantIds);
    const unsupported = reports.filter((report) => report.unsupportedRows > 0);
    if (unsupported.length > 0) {
      throw new Error(`unsupported legacy Opportunity status for tenant ${unsupported.map((row) => row.tenantId).join(',')}`);
    }
    const nonLegacyKind = await tx.opportunity.findFirst({
      where: { tenantId: { in: scopedTenantIds }, NOT: { kind: 'sales_opportunity' } },
      orderBy: { tenantId: 'asc' },
      select: { tenantId: true },
    });
    if (nonLegacyKind) {
      throw new Error(`Matter backfill is no longer safe after non-sales kinds exist for tenant ${nonLegacyKind.tenantId}`);
    }
    for (const status of ['active', 'paused', 'won', 'lost'] as const) {
      const mapping = mapLegacyOpportunityStatus(status);
      await tx.opportunity.updateMany({
        where: { tenantId: { in: scopedTenantIds }, status },
        data: { kind: 'sales_opportunity', ...mapping },
      });
    }
    const conflictCount = await countMatterParityConflicts(tx, scopedTenantIds);
    if (conflictCount > 0) {
      throw new Error(`Matter lifecycle backfill parity failed for ${conflictCount} row(s)`);
    }
  }, { timeout: 60_000 });
}

function matterParityConflictWhere(tenantIds: readonly string[]): Prisma.OpportunityWhereInput {
  return {
    tenantId: { in: [...tenantIds] },
    kind: 'sales_opportunity',
    OR: [
      { status: { notIn: ['active', 'paused', 'won', 'lost'] } },
      { status: 'active', OR: [{ lifecycleStatus: { not: 'active' } }, { outcomeKey: { not: null } }] },
      { status: 'paused', OR: [{ lifecycleStatus: { not: 'paused' } }, { outcomeKey: { not: null } }] },
      {
        status: 'won',
        OR: [{ lifecycleStatus: { not: 'completed' } }, { outcomeKey: null }, { outcomeKey: { not: 'won' } }],
      },
      {
        status: 'lost',
        OR: [{ lifecycleStatus: { not: 'completed' } }, { outcomeKey: null }, { outcomeKey: { not: 'lost' } }],
      },
    ],
  };
}

export async function countMatterParityConflicts(
  db: MatterReadClient,
  tenantIds: readonly string[],
): Promise<number> {
  if (tenantIds.length === 0) return 0;
  return db.opportunity.count({ where: matterParityConflictWhere(tenantIds) });
}

export async function verifyMatterParity(
  db: MatterReadClient,
  tenantIds: readonly string[],
  sampleLimit = 100,
): Promise<MatterParityConflict[]> {
  if (tenantIds.length === 0) return [];
  const rows = await db.opportunity.findMany({
    where: matterParityConflictWhere(tenantIds),
    orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    take: sampleLimit,
    select: { tenantId: true, id: true, status: true, lifecycleStatus: true, outcomeKey: true },
  });
  return rows.map((row) => {
    const expected = isLegacyOpportunityStatus(row.status) ? mapLegacyOpportunityStatus(row.status) : null;
    return {
      ...row,
      expectedLifecycleStatus: expected?.lifecycleStatus ?? null,
      expectedOutcomeKey: expected?.outcomeKey ?? null,
    };
  });
}

export async function verifyTenantMatterParity(
  db: MatterReadClient,
  tenantId: string,
): Promise<MatterParityConflict[]> {
  return verifyMatterParity(db, [tenantId]);
}
