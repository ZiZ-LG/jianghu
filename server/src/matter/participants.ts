import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

const SOURCE_PAGE_SIZE = 250;
const LOOKUP_CHUNK_SIZE = 100;
export const MATTER_PARTICIPANT_MIGRATION_KEY = 'CORE-105-matter-participant-backfill-v1';

type ParticipantSourceKind = 'opp_role' | 'opportunity_member';
type ParticipantSourceRow = {
  id: string;
  tenantId: string;
  opportunityId: string;
  personId: string;
};

export type MatterParticipantMigrationInvalidReason =
  | 'missing_tenant'
  | 'missing_opportunity'
  | 'missing_person'
  | 'opportunity_tenant_mismatch'
  | 'person_tenant_mismatch'
  | 'account_mismatch';

export interface MatterParticipantMigrationInvalidRow {
  sourceKind: ParticipantSourceKind;
  sourceId: string;
  tenantId: string;
  opportunityId: string;
  personId: string;
  reason: MatterParticipantMigrationInvalidReason;
}

export interface MatterParticipantMigrationReport {
  sourceRows: number;
  roleRows: number;
  legacyVisibilityRows: number;
  candidateRows: number;
  duplicateSourceRows: number;
  invalidRows: MatterParticipantMigrationInvalidRow[];
}

interface ParticipantCandidate {
  tenantId: string;
  accountId: string;
  opportunityId: string;
  personId: string;
}

interface InspectionResult {
  report: MatterParticipantMigrationReport;
  candidates: ParticipantCandidate[];
}

type ParticipantSourceIntegrityRow = {
  sourceRows: number | bigint | string;
  missingTenantRows: number | bigint | string;
};

export interface MatterParticipantBackfillResult {
  candidateRows: number;
  createdRows: number;
  existingRows: number;
}

export interface MatterParticipantParityConflict {
  tenantId: string;
  opportunityId: string;
  personId: string;
  reason: 'missing_candidate' | 'account_mismatch' | `invalid_source:${MatterParticipantMigrationInvalidReason}`;
}

const candidateKey = (value: Pick<ParticipantCandidate, 'tenantId' | 'opportunityId' | 'personId'>) =>
  JSON.stringify([value.tenantId, value.opportunityId, value.personId]);

const participantId = (candidate: ParticipantCandidate) => `mp_${createHash('sha256')
  .update(candidateKey(candidate))
  .digest('hex')}`;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function normalizedCount(value: number | bigint | string | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid MatterParticipant source count');
  return count;
}

async function inspectSourceIntegrity(db: PrismaClient | Prisma.TransactionClient): Promise<{
  sourceRows: number;
  missingTenantRows: number;
}> {
  // Migration-only aggregate: enumerate no business fields globally. Actual
  // source rows are loaded below one tenant at a time.
  const rows = await db.$queryRawUnsafe<ParticipantSourceIntegrityRow[]>(`
    SELECT
      ((SELECT COUNT(*) FROM "OppRole")
        + (SELECT COUNT(*) FROM "OpportunityMember")) AS "sourceRows",
      ((SELECT COUNT(*)
          FROM "OppRole" AS role
          LEFT JOIN "Tenant" AS tenant ON tenant."id" = role."tenantId"
         WHERE tenant."id" IS NULL)
        + (SELECT COUNT(*)
             FROM "OpportunityMember" AS member
             LEFT JOIN "Tenant" AS tenant ON tenant."id" = member."tenantId"
            WHERE tenant."id" IS NULL)) AS "missingTenantRows"
  `);
  return {
    sourceRows: normalizedCount(rows[0]?.sourceRows),
    missingTenantRows: normalizedCount(rows[0]?.missingTenantRows),
  };
}

async function sourcePages(
  load: (cursor?: string) => Promise<ParticipantSourceRow[]>,
  consume: (rows: ParticipantSourceRow[]) => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const rows = await load(cursor);
    if (rows.length === 0) return;
    await consume(rows);
    cursor = rows.at(-1)?.id;
    if (rows.length < SOURCE_PAGE_SIZE) return;
  }
}

async function inspectMatterParticipantSources(db: PrismaClient | Prisma.TransactionClient): Promise<InspectionResult> {
  const integrity = await inspectSourceIntegrity(db);
  const tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  const report: MatterParticipantMigrationReport = {
    sourceRows: 0,
    roleRows: 0,
    legacyVisibilityRows: 0,
    candidateRows: 0,
    duplicateSourceRows: 0,
    invalidRows: [],
  };
  const candidates = new Map<string, ParticipantCandidate>();

  const consume = async (
    sourceKind: ParticipantSourceKind,
    expectedTenantId: string,
    rows: ParticipantSourceRow[],
  ) => {
    report.sourceRows += rows.length;
    if (sourceKind === 'opp_role') report.roleRows += rows.length;
    else report.legacyVisibilityRows += rows.length;

    const opportunityIds = [...new Set(rows.map((row) => row.opportunityId))];
    const personIds = [...new Set(rows.map((row) => row.personId))];
    const [opportunities, persons] = await Promise.all([
      db.opportunity.findMany({
        where: { tenantId: expectedTenantId, id: { in: opportunityIds } },
        select: { id: true, tenantId: true, accountId: true },
      }),
      db.person.findMany({
        where: { tenantId: expectedTenantId, id: { in: personIds } },
        select: { id: true, tenantId: true, accountId: true },
      }),
    ]);
    const opportunityById = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity]));
    const personById = new Map(persons.map((person) => [person.id, person]));

    for (const row of rows) {
      if (row.tenantId !== expectedTenantId) {
        throw new Error(`MatterParticipant source escaped tenant scope (${expectedTenantId})`);
      }
      const opportunity = opportunityById.get(row.opportunityId);
      const person = personById.get(row.personId);
      let reason: MatterParticipantMigrationInvalidReason | undefined;
      if (!opportunity) reason = 'missing_opportunity';
      else if (!person) reason = 'missing_person';
      else if (opportunity.tenantId !== row.tenantId) reason = 'opportunity_tenant_mismatch';
      else if (person.tenantId !== row.tenantId) reason = 'person_tenant_mismatch';
      else if (opportunity.accountId !== person.accountId) reason = 'account_mismatch';

      if (reason) {
        report.invalidRows.push({
          sourceKind, sourceId: row.id, tenantId: row.tenantId,
          opportunityId: row.opportunityId, personId: row.personId, reason,
        });
        continue;
      }

      const candidate = {
        tenantId: row.tenantId,
        accountId: opportunity!.accountId,
        opportunityId: row.opportunityId,
        personId: row.personId,
      };
      const key = candidateKey(candidate);
      if (candidates.has(key)) report.duplicateSourceRows += 1;
      else candidates.set(key, candidate);
    }
  };

  for (const tenant of tenants) {
    await sourcePages(
      (cursor) => db.oppRole.findMany({
        where: { tenantId: tenant.id },
        take: SOURCE_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, tenantId: true, opportunityId: true, personId: true },
      }),
      (rows) => consume('opp_role', tenant.id, rows),
    );
    await sourcePages(
      (cursor) => db.opportunityMember.findMany({
        where: { tenantId: tenant.id },
        take: SOURCE_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, tenantId: true, opportunityId: true, personId: true },
      }),
      (rows) => consume('opportunity_member', tenant.id, rows),
    );
  }

  if (integrity.missingTenantRows > 0 || report.sourceRows !== integrity.sourceRows) {
    throw new Error(
      `MatterParticipant source tenant coverage failed: scoped=${report.sourceRows}, `
      + `total=${integrity.sourceRows}, missingTenant=${integrity.missingTenantRows}`,
    );
  }

  const sortedCandidates = [...candidates.values()].sort((left, right) =>
    candidateKey(left).localeCompare(candidateKey(right)));
  report.candidateRows = sortedCandidates.length;
  return { report, candidates: sortedCandidates };
}

export async function inspectMatterParticipantMigration(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<MatterParticipantMigrationReport> {
  return (await inspectMatterParticipantSources(db)).report;
}

export async function hasMatterParticipantMigrationMarker(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<boolean> {
  return !!(await db.dataMigrationState.findUnique({
    where: { key: MATTER_PARTICIPANT_MIGRATION_KEY },
    select: { key: true },
  }));
}

function assertValidSources(report: MatterParticipantMigrationReport): void {
  if (report.invalidRows.length === 0) return;
  throw new Error(`invalid MatterParticipant legacy parentage (${report.invalidRows.length} rows)`);
}

async function findExistingCandidateKeys(
  db: PrismaClient | Prisma.TransactionClient,
  candidates: readonly ParticipantCandidate[],
): Promise<Set<string>> {
  const result = new Set<string>();
  for (const group of chunks(candidates, LOOKUP_CHUNK_SIZE)) {
    const rows = await db.matterParticipant.findMany({
      where: { OR: group.map((candidate) => ({
        tenantId: candidate.tenantId,
        opportunityId: candidate.opportunityId,
        personId: candidate.personId,
      })) },
      select: { tenantId: true, opportunityId: true, personId: true },
    });
    for (const row of rows) result.add(candidateKey(row));
  }
  return result;
}

async function assertStoredCandidateParity(
  db: PrismaClient | Prisma.TransactionClient,
  candidates: readonly ParticipantCandidate[],
): Promise<void> {
  for (const group of chunks(candidates, LOOKUP_CHUNK_SIZE)) {
    const rows = await db.matterParticipant.findMany({
      where: { OR: group.map((candidate) => ({
        tenantId: candidate.tenantId,
        opportunityId: candidate.opportunityId,
        personId: candidate.personId,
      })) },
      select: { tenantId: true, accountId: true, opportunityId: true, personId: true },
    });
    const expected = new Map(group.map((candidate) => [candidateKey(candidate), candidate]));
    const seen = new Set<string>();
    for (const row of rows) {
      const key = candidateKey(row);
      const candidate = expected.get(key);
      if (!candidate) continue;
      if (row.accountId !== candidate.accountId) {
        throw new Error(`existing MatterParticipant customer mismatch (${key})`);
      }
      seen.add(key);
    }
    const missing = group.find((candidate) => !seen.has(candidateKey(candidate)));
    if (missing) throw new Error(`MatterParticipant backfill missing candidate (${candidateKey(missing)})`);
  }
}

export async function applyMatterParticipantBackfill(db: PrismaClient): Promise<MatterParticipantBackfillResult> {
  const inspection = await inspectMatterParticipantSources(db);
  assertValidSources(inspection.report);
  const existing = await findExistingCandidateKeys(db, inspection.candidates);
  const missing = inspection.candidates.filter((candidate) => !existing.has(candidateKey(candidate)));

  await db.$transaction(async (tx) => {
    for (const candidate of missing) {
      await tx.matterParticipant.upsert({
        where: { tenantId_opportunityId_personId: {
          tenantId: candidate.tenantId,
          opportunityId: candidate.opportunityId,
          personId: candidate.personId,
        } },
        create: { id: participantId(candidate), ...candidate },
        update: {},
      });
    }
    // The completion marker and candidate parity are one transaction. A
    // redundant but wrong customer reference must never survive as "migrated".
    await assertStoredCandidateParity(tx, inspection.candidates);
    await tx.dataMigrationState.upsert({
      where: { key: MATTER_PARTICIPANT_MIGRATION_KEY },
      create: {
        key: MATTER_PARTICIPANT_MIGRATION_KEY,
        details: JSON.stringify({ source: 'OppRole+OpportunityMember', authority: 'MatterParticipant' }),
      },
      update: {},
    });
  }, { timeout: 15 * 60 * 1000 });

  return {
    candidateRows: inspection.candidates.length,
    createdRows: missing.length,
    existingRows: existing.size,
  };
}

export async function verifyMatterParticipantBackfill(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<MatterParticipantParityConflict[]> {
  const inspection = await inspectMatterParticipantSources(db);
  const conflicts: MatterParticipantParityConflict[] = inspection.report.invalidRows.map((row) => ({
    tenantId: row.tenantId,
    opportunityId: row.opportunityId,
    personId: row.personId,
    reason: `invalid_source:${row.reason}` as const,
  }));
  const existing = await findExistingCandidateKeys(db, inspection.candidates);
  if (existing.size !== inspection.candidates.length) {
    for (const candidate of inspection.candidates) {
      if (!existing.has(candidateKey(candidate))) conflicts.push({
        tenantId: candidate.tenantId,
        opportunityId: candidate.opportunityId,
        personId: candidate.personId,
        reason: 'missing_candidate',
      });
    }
  }

  for (const group of chunks(inspection.candidates, LOOKUP_CHUNK_SIZE)) {
    const rows = await db.matterParticipant.findMany({
      where: { OR: group.map((candidate) => ({
        tenantId: candidate.tenantId,
        opportunityId: candidate.opportunityId,
        personId: candidate.personId,
      })) },
      select: { tenantId: true, accountId: true, opportunityId: true, personId: true },
    });
    const candidateByKey = new Map(group.map((candidate) => [candidateKey(candidate), candidate]));
    for (const row of rows) {
      const candidate = candidateByKey.get(candidateKey(row));
      if (candidate && row.accountId !== candidate.accountId) conflicts.push({
        tenantId: row.tenantId,
        opportunityId: row.opportunityId,
        personId: row.personId,
        reason: 'account_mismatch',
      });
    }
  }

  return conflicts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
