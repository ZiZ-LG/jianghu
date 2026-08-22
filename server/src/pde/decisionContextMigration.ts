import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Stage } from 'pde-kernel';

type MigrationDb = PrismaClient | Prisma.TransactionClient;

export const PDE_DECISION_CONTEXT_MIGRATION_KEY = 'CORE-113-pde-decision-context-shadow-v1';
export const PDE_STAGE_KEYS = [
  'initiation',
  'feasibility',
  'budget_approval',
  'tender_design',
  'tender_execution',
] as const satisfies readonly Stage[];

const LEGACY_STAGE_MAP: Readonly<Record<string, Stage>> = Object.freeze({
  需求调研立项: 'initiation',
  方案可研: 'feasibility',
  预算批复: 'budget_approval',
  招标论证: 'tender_design',
  招采执行: 'tender_execution',
});

export function mapLegacyEngageStageToPdeStage(value: string): Stage {
  return LEGACY_STAGE_MAP[value] ?? 'initiation';
}

interface Candidate {
  tenantId: string;
  opportunityId: string;
  stageKey: Stage;
  decisionProfileRef: string | null;
}

export interface PdeDecisionContextParityConflict {
  tenantId: string;
  opportunityId: string;
  field: 'stageKey' | 'decisionProfileRef';
  expected: string | null;
  actual: string | null;
}

export interface PdeDecisionContextMigrationReport {
  sourceRows: number;
  candidateRows: number;
  missingDecisionProfileRows: number;
  invalidSourceRows: number;
  parityConflicts: PdeDecisionContextParityConflict[];
}

export interface PdeDecisionContextBackfillResult {
  candidateRows: number;
  createdRows: number;
  existingRows: number;
  missingDecisionProfileRows: number;
}

type CountRow = { count: number | bigint | string };

function count(value: number | bigint | string | undefined): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('invalid PDE decision context migration count');
  }
  return normalized;
}

function contextId(candidate: Pick<Candidate, 'tenantId' | 'opportunityId'>): string {
  return `pdc_${createHash('sha256')
    .update(JSON.stringify([candidate.tenantId, candidate.opportunityId]))
    .digest('hex')}`;
}

function isMissingRelationError(error: unknown): boolean {
  const value = error as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  if (value.code === 'P2021') return true;
  if (value.code !== 'P2010') return false;
  const databaseCode = String(value.meta?.code ?? '');
  return databaseCode === '42P01'
    || (databaseCode === '1' && String(value.meta?.message ?? value.message ?? '').includes('no such table'));
}

async function opportunityTableExists(db: MigrationDb): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT COUNT(*) AS "count" FROM "Opportunity"');
    return true;
  } catch (error) {
    if (isMissingRelationError(error)) return false;
    throw error;
  }
}

async function contextTableExists(db: MigrationDb): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT COUNT(*) AS "count" FROM "PdeDecisionContext"');
    return true;
  } catch (error) {
    if (isMissingRelationError(error)) return false;
    throw error;
  }
}

async function loadCandidates(db: MigrationDb): Promise<{
  candidates: Candidate[];
  sourceRows: number;
  invalidSourceRows: number;
}> {
  if (!(await opportunityTableExists(db))) {
    return { candidates: [], sourceRows: 0, invalidSourceRows: 0 };
  }
  const integrity = await db.$queryRawUnsafe<Array<{
    sourceRows: number | bigint | string;
    invalidSourceRows: number | bigint | string;
  }>>(`
    SELECT
      (SELECT COUNT(*) FROM "Opportunity") AS "sourceRows",
      (SELECT COUNT(*)
         FROM "Opportunity" AS matter
         LEFT JOIN "Tenant" AS tenant ON tenant.id = matter."tenantId"
        WHERE tenant.id IS NULL) AS "invalidSourceRows"
  `);
  const sourceRows = count(integrity[0]?.sourceRows);
  const invalidSourceRows = count(integrity[0]?.invalidSourceRows);
  const tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  const candidates: Candidate[] = [];

  for (const tenant of tenants) {
    const [matters, configs, profiles] = await Promise.all([
      db.opportunity.findMany({
        where: { tenantId: tenant.id },
        orderBy: { id: 'asc' },
        select: { id: true, engageStage: true },
      }),
      db.dealPdeConfig.findMany({
        where: { tenantId: tenant.id },
        select: { opportunityId: true, industryPackKey: true },
      }),
      db.industryPack.findMany({
        where: { tenantId: tenant.id, active: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, packKey: true, schemaVersion: true },
      }),
    ]);
    const configByMatter = new Map(configs.map((config) => [config.opportunityId, config]));
    const profileByKey = new Map<string, string>();
    const preferredProfileByKey = new Map<string, string>();
    for (const profile of profiles) {
      if (!profileByKey.has(profile.packKey)) profileByKey.set(profile.packKey, profile.id);
      if (profile.schemaVersion === '1.1' && !preferredProfileByKey.has(profile.packKey)) {
        preferredProfileByKey.set(profile.packKey, profile.id);
      }
    }
    for (const matter of matters) {
      const packKey = configByMatter.get(matter.id)?.industryPackKey ?? 'digital-energy';
      candidates.push({
        tenantId: tenant.id,
        opportunityId: matter.id,
        stageKey: mapLegacyEngageStageToPdeStage(matter.engageStage),
        decisionProfileRef: preferredProfileByKey.get(packKey) ?? profileByKey.get(packKey) ?? null,
      });
    }
  }

  if (candidates.length !== sourceRows - invalidSourceRows) {
    throw new Error('PDE decision context tenant-scoped source scan count mismatch');
  }
  return { candidates, sourceRows, invalidSourceRows };
}

async function inspectMigration(db: MigrationDb): Promise<{
  report: PdeDecisionContextMigrationReport;
  candidates: Candidate[];
}> {
  const { candidates, sourceRows, invalidSourceRows } = await loadCandidates(db);
  const parityConflicts: PdeDecisionContextParityConflict[] = [];
  if (await contextTableExists(db)) {
    const existing = await db.pdeDecisionContext.findMany({
      select: { tenantId: true, opportunityId: true, stageKey: true, decisionProfileRef: true },
    });
    const byMatter = new Map(existing.map((row) => [JSON.stringify([row.tenantId, row.opportunityId]), row]));
    for (const candidate of candidates) {
      const row = byMatter.get(JSON.stringify([candidate.tenantId, candidate.opportunityId]));
      if (!row) continue;
      if (row.stageKey !== candidate.stageKey) {
        parityConflicts.push({
          tenantId: candidate.tenantId,
          opportunityId: candidate.opportunityId,
          field: 'stageKey',
          expected: candidate.stageKey,
          actual: row.stageKey,
        });
      }
      if (row.decisionProfileRef !== candidate.decisionProfileRef) {
        parityConflicts.push({
          tenantId: candidate.tenantId,
          opportunityId: candidate.opportunityId,
          field: 'decisionProfileRef',
          expected: candidate.decisionProfileRef,
          actual: row.decisionProfileRef,
        });
      }
    }
  }
  return {
    candidates,
    report: {
      sourceRows,
      candidateRows: candidates.length,
      missingDecisionProfileRows: candidates.filter((candidate) => !candidate.decisionProfileRef).length,
      invalidSourceRows,
      parityConflicts,
    },
  };
}

export async function inspectPdeDecisionContextMigration(
  db: MigrationDb,
): Promise<PdeDecisionContextMigrationReport> {
  return (await inspectMigration(db)).report;
}

export async function hasPdeDecisionContextMigrationMarker(db: MigrationDb): Promise<boolean> {
  return Boolean(await db.dataMigrationState.findUnique({
    where: { key: PDE_DECISION_CONTEXT_MIGRATION_KEY },
    select: { key: true },
  }));
}

export async function backfillPdeDecisionContexts(
  db: PrismaClient,
): Promise<PdeDecisionContextBackfillResult> {
  const marker = await db.dataMigrationState.findUnique({
    where: { key: PDE_DECISION_CONTEXT_MIGRATION_KEY },
    select: { details: true },
  });
  const { candidates, report } = await inspectMigration(db);
  if (report.invalidSourceRows > 0) {
    throw new Error(`PDE decision context migration has ${report.invalidSourceRows} invalid tenant source row(s)`);
  }
  if (!marker && report.parityConflicts.length > 0) {
    throw new Error(`PDE decision context backfill parity failed (${report.parityConflicts.length} conflict(s))`);
  }

  const existingKeys = new Set((await db.pdeDecisionContext.findMany({
    select: { tenantId: true, opportunityId: true },
  })).map((row) => JSON.stringify([row.tenantId, row.opportunityId])));
  const missing = candidates.filter((candidate) => !existingKeys.has(JSON.stringify([
    candidate.tenantId,
    candidate.opportunityId,
  ])));
  if (marker && missing.length > 0) {
    throw new Error('legacy PDE decision context backfill is disabled after cutover');
  }

  await db.$transaction(async (tx) => {
    for (const candidate of missing) {
      await tx.pdeDecisionContext.create({ data: {
        id: contextId(candidate),
        tenantId: candidate.tenantId,
        opportunityId: candidate.opportunityId,
        stageKey: candidate.stageKey,
        decisionProfileRef: candidate.decisionProfileRef,
        source: 'legacy_shadow',
      } });
    }
    if (!marker) {
      await tx.dataMigrationState.create({ data: {
        key: PDE_DECISION_CONTEXT_MIGRATION_KEY,
        details: JSON.stringify({
          authority: 'PdeDecisionContext',
          candidateRows: report.candidateRows,
          missingDecisionProfileRows: report.missingDecisionProfileRows,
        }),
      } });
    }
  });

  return {
    candidateRows: report.candidateRows,
    createdRows: missing.length,
    existingRows: report.candidateRows - missing.length,
    missingDecisionProfileRows: report.missingDecisionProfileRows,
  };
}

export async function verifyPdeDecisionContextIntegrity(db: MigrationDb): Promise<{
  markerPresent: boolean;
  invalidContexts: number;
  invalidParents: number;
  invalidDecisionProfiles: number;
}> {
  const markerPresent = await hasPdeDecisionContextMigrationMarker(db);
  const [invalidParentsRow, invalidProfilesRow] = await Promise.all([
    db.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(*) AS "count"
        FROM "PdeDecisionContext" AS context
       WHERE NOT EXISTS (
         SELECT 1 FROM "Opportunity" AS matter
          WHERE matter.id = context."opportunityId"
            AND matter."tenantId" = context."tenantId"
       )
    `),
    db.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(*) AS "count"
        FROM "PdeDecisionContext" AS context
       WHERE context."decisionProfileRef" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "IndustryPack" AS profile
            WHERE profile.id = context."decisionProfileRef"
              AND profile."tenantId" = context."tenantId"
         )
    `),
  ]);
  const contexts = await db.pdeDecisionContext.findMany({
    select: { stageKey: true, source: true, version: true },
  });
  const stageKeys = new Set<string>(PDE_STAGE_KEYS);
  const invalidContexts = contexts.filter((context) => !stageKeys.has(context.stageKey)
    || !['legacy_shadow', 'manual', 'system_default'].includes(context.source)
    || context.version < 0).length;
  const invalidParents = count(invalidParentsRow[0]?.count);
  const invalidDecisionProfiles = count(invalidProfilesRow[0]?.count);
  if (!markerPresent || invalidContexts > 0 || invalidParents > 0 || invalidDecisionProfiles > 0) {
    throw new Error(`PDE decision context integrity failed: ${JSON.stringify({
      markerPresent,
      invalidContexts,
      invalidParents,
      invalidDecisionProfiles,
    })}`);
  }
  return { markerPresent, invalidContexts, invalidParents, invalidDecisionProfiles };
}
