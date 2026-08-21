import { prisma } from '../src/prisma.js';

type CountRow = { count: number | bigint | string };

const count = async (query: string): Promise<number> => {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(query);
  return Number(rows[0]?.count ?? 0);
};

async function preflight(): Promise<Record<string, number>> {
  const unmanagedActivePointers = await count(`
    SELECT COUNT(*) AS "count"
      FROM "Opportunity"
     WHERE "activeMethodologyBindingId" IS NOT NULL
  `);
  if (unmanagedActivePointers > 0) {
    throw new Error(
      `unmanaged active methodology binding pointer: ${unmanagedActivePointers} Matter row(s) require approved repair`,
    );
  }
  return { unmanagedActivePointers };
}

async function verify(): Promise<Record<string, number>> {
  const [
    invalidActivePointers,
    invalidCurrentPublishedVersions,
    invalidBindingDecisionProfiles,
    invalidPilotBaselines,
  ] = await Promise.all([
    count(`
      SELECT COUNT(*) AS "count"
        FROM "Opportunity" AS matter
       WHERE matter."activeMethodologyBindingId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM "MethodologyBinding" AS binding
            WHERE binding.id = matter."activeMethodologyBindingId"
              AND binding."tenantId" = matter."tenantId"
              AND binding."opportunityId" = matter.id
         )
    `),
    count(`
      SELECT COUNT(*) AS "count"
        FROM "MethodologyPack" AS pack
       WHERE pack."currentPublishedVersionId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM "MethodologyPackVersion" AS version
            WHERE version.id = pack."currentPublishedVersionId"
              AND version."tenantId" = pack."tenantId"
              AND version."packId" = pack.id
              AND version.status = 'published'
         )
    `),
    count(`
      SELECT COUNT(*) AS "count"
        FROM "MethodologyBinding" AS binding
       WHERE binding."decisionProfileRef" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM "IndustryPack" AS profile
            WHERE profile.id = binding."decisionProfileRef"
              AND profile."tenantId" = binding."tenantId"
         )
    `),
    count(`
      SELECT COUNT(*) AS "count"
        FROM "MethodologyPilotAssignment" AS pilot
       WHERE pilot."baselineBindingId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM "MethodologyBinding" AS binding
            WHERE binding.id = pilot."baselineBindingId"
              AND binding."tenantId" = pilot."tenantId"
              AND binding."opportunityId" = pilot."opportunityId"
         )
    `),
  ]);

  const versions = await prisma.methodologyPackVersion.findMany({
    select: {
      status: true,
      contentHash: true,
      publishedByUserId: true,
      publishedAt: true,
    },
  });
  const invalidVersions = versions.filter((version) => {
    const statusAllowed = [
      'draft', 'validated', 'piloting', 'published', 'deprecated', 'archived',
    ].includes(version.status);
    const released = ['published', 'deprecated', 'archived'].includes(version.status);
    const publicationValid = released
      ? Boolean(version.publishedByUserId && version.publishedAt)
      : !version.publishedByUserId && !version.publishedAt;
    return !statusAllowed || !publicationValid || !/^[0-9a-f]{64}$/.test(version.contentHash);
  }).length;

  const pilots = await prisma.methodologyPilotAssignment.findMany({
    select: { status: true, completedAt: true, matterVersion: true },
  });
  const invalidPilots = pilots.filter((pilot) => {
    const statusAllowed = ['active', 'completed', 'canceled'].includes(pilot.status);
    const completionValid = pilot.status === 'active' ? pilot.completedAt === null : pilot.completedAt !== null;
    return !statusAllowed || !completionValid || pilot.matterVersion < 0;
  }).length;

  const report = {
    invalidActivePointers,
    invalidCurrentPublishedVersions,
    invalidBindingDecisionProfiles,
    invalidPilotBaselines,
    invalidVersions,
    invalidPilots,
  };
  const total = Object.values(report).reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    throw new Error(`methodology foundation integrity failed: ${JSON.stringify(report)}`);
  }
  return report;
}

const mode = process.argv[2];
if (mode !== '--preflight' && mode !== '--verify') {
  console.error('usage: check-methodology-foundation.ts --preflight|--verify');
  process.exitCode = 2;
} else {
  try {
    const report = mode === '--preflight' ? await preflight() : await verify();
    console.log(JSON.stringify({ ok: true, mode, ...report }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
