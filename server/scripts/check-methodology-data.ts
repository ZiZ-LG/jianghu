import { prisma } from '../src/prisma.js';

type CountRow = { count: number | bigint | string };

const count = async (query: string): Promise<number> => {
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(query);
  return Number(rows[0]?.count ?? 0);
};

const parseJson = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
};
const isObjectJson = (value: string): boolean => {
  const parsed = parseJson(value);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
};
const isArrayJson = (value: string): boolean => Array.isArray(parseJson(value));
const isStringArrayJson = (value: string): boolean => {
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string' && entry.length > 0);
};
const isJson = (value: string): boolean => parseJson(value) !== undefined;
const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const isBusinessDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

async function inspectFoundation(): Promise<Record<string, number>> {
  const [invalidActivePointers, invalidCurrentPublishedVersions] = await Promise.all([
    count(`
      SELECT COUNT(*) AS "count"
        FROM "Opportunity" AS matter
       WHERE matter."activeMethodologyBindingId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "MethodologyBinding" AS binding
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
           SELECT 1 FROM "MethodologyPackVersion" AS version
            WHERE version.id = pack."currentPublishedVersionId"
              AND version."tenantId" = pack."tenantId"
              AND version."packId" = pack.id
              AND version.status = 'published'
         )
    `),
  ]);
  return { invalidActivePointers, invalidCurrentPublishedVersions };
}

async function preflight(): Promise<Record<string, number>> {
  const report = await inspectFoundation();
  if (Object.values(report).some((value) => value > 0)) {
    throw new Error(`methodology data preflight failed: ${JSON.stringify(report)}`);
  }
  return report;
}

async function verify(): Promise<Record<string, number>> {
  const foundation = await inspectFoundation();
  const [invalidRoleAssignmentTargets, invalidMethodologyValueTargets] = await Promise.all([
    count(`
      SELECT COUNT(*) AS "count"
        FROM "MethodologyRoleAssignment" AS assignment
        JOIN "Opportunity" AS matter ON matter.id = assignment."opportunityId"
       WHERE NOT EXISTS (
         SELECT 1 FROM "Person" AS person
          WHERE person.id = assignment."personId"
            AND person."tenantId" = assignment."tenantId"
            AND person."accountId" = matter."accountId"
            AND person."archivedAt" IS NULL
       )
    `),
    count(`
      SELECT COUNT(*) AS "count"
        FROM "MethodologyValue" AS value
        JOIN "Opportunity" AS matter ON matter.id = value."opportunityId"
       WHERE (value."targetKind" = 'matter' AND value."targetId" <> value."opportunityId")
          OR (value."targetKind" = 'person' AND NOT EXISTS (
               SELECT 1 FROM "Person" AS person
                WHERE person.id = value."targetId"
                  AND person."tenantId" = value."tenantId"
                  AND person."accountId" = matter."accountId"
                  AND person."archivedAt" IS NULL
             ))
          OR (value."targetKind" = 'relation' AND NOT EXISTS (
               SELECT 1 FROM "Edge" AS relation
                WHERE relation.id = value."targetId"
                  AND relation."tenantId" = value."tenantId"
                  AND relation."accountId" = matter."accountId"
                  AND (relation."opportunityId" IS NULL OR relation."opportunityId" = value."opportunityId")
             ))
          OR value."targetKind" NOT IN ('matter', 'person', 'relation')
    `),
  ]);

  const [fields, stages, roles, rules, actions, stageStates, assignments, values, evaluations, migrations] = await Promise.all([
    prisma.methodologyFieldDefinition.findMany(),
    prisma.methodologyStageDefinition.findMany(),
    prisma.methodologyRoleDefinition.findMany(),
    prisma.methodologyRuleDefinition.findMany(),
    prisma.methodologyActionTemplate.findMany(),
    prisma.methodologyStageState.findMany(),
    prisma.methodologyRoleAssignment.findMany(),
    prisma.methodologyValue.findMany(),
    prisma.methodologyEvaluation.findMany({ include: { binding: { include: { methodologyVersion: true } } } }),
    prisma.methodologyMigrationRun.findMany(),
  ]);

  const invalidDefinitions = fields.filter((field) => {
    const consumers = parseJson(field.legacyConsumersJson);
    const legacy = field.storageBindingKind === 'legacy_path';
    return !['core_path', 'methodology_value', 'legacy_path'].includes(field.storageBindingKind)
      || !['matter', 'person', 'relation'].includes(field.targetKind)
      || !isObjectJson(field.valueDomainJson)
      || !Array.isArray(consumers)
      || !consumers.every((entry) => typeof entry === 'string' && entry.length > 0)
      || (legacy && (!field.legacyStopDate || !isBusinessDate(field.legacyStopDate) || consumers.length === 0))
      || (!legacy && (field.legacyStopDate !== null || consumers.length > 0));
  }).length
    + stages.filter((stage) => !isArrayJson(stage.entryConditionsJson) || !isArrayJson(stage.exitConditionsJson)).length
    + roles.filter((role) => role.appliesTo !== 'person' || !isObjectJson(role.constraintsJson)
      || role.minimumAssignments < 0 || role.maximumAssignments < role.minimumAssignments).length
    + rules.filter((rule) => !isStringArrayJson(rule.inputRefsJson)
      || !isObjectJson(rule.weightsJson) || !isObjectJson(rule.thresholdsJson)).length
    + actions.filter((action) => !isStringArrayJson(action.evidenceRequirementsJson)).length;

  const invalidInstances = stageStates.filter((state) => !isStringArrayJson(state.evidenceIdsJson)
    || state.humanOverride !== Boolean(state.overrideReason)).length
    + assignments.filter((assignment) => !['pending', 'confirmed', 'rejected'].includes(assignment.reviewStatus)
      || !isStringArrayJson(assignment.evidenceIdsJson)).length
    + values.filter((value) => !['pending', 'confirmed', 'rejected'].includes(value.reviewStatus)
      || !isJson(value.normalizedValueJson) || !isStringArrayJson(value.evidenceIdsJson)).length;

  const invalidEvaluations = evaluations.filter((evaluation) => !isObjectJson(evaluation.inputsJson)
    || !isObjectJson(evaluation.resultJson)
    || !isStringArrayJson(evaluation.evidenceIdsJson)
    || evaluation.aclVersion < 0
    || !isSha256(evaluation.inputsHash)
    || !isSha256(evaluation.resultHash)
    || evaluation.packVersionKey !== evaluation.binding.methodologyVersion.versionKey
    || evaluation.engineRef !== evaluation.binding.methodologyVersion.engineRef).length;

  const invalidMigrations = migrations.filter((migration) => {
    const confirmationPresent = Boolean(migration.confirmedByUserId && migration.confirmedAt);
    const executionPresent = Boolean(migration.executedByUserId && migration.executedAt);
    const rollbackPresent = Boolean(migration.rolledBackByUserId && migration.rolledBackAt);
    const paired = Boolean(migration.confirmedByUserId) === Boolean(migration.confirmedAt)
      && Boolean(migration.executedByUserId) === Boolean(migration.executedAt)
      && Boolean(migration.rolledBackByUserId) === Boolean(migration.rolledBackAt);
    return !['planned', 'confirmed', 'running', 'completed', 'failed', 'rolled_back'].includes(migration.status)
      || migration.matterVersion < 0
      || !isObjectJson(migration.dryRunJson) || !isObjectJson(migration.mappingJson)
      || !isArrayJson(migration.conflictsJson) || !isObjectJson(migration.confirmationJson)
      || !isObjectJson(migration.executionJson) || !isObjectJson(migration.rollbackJson)
      || !paired
      || (['confirmed', 'running', 'completed', 'rolled_back'].includes(migration.status) && !confirmationPresent)
      || (['running', 'completed', 'rolled_back'].includes(migration.status) && !executionPresent)
      || (migration.status === 'rolled_back' && !rollbackPresent)
      || (migration.status === 'planned' && (confirmationPresent || executionPresent || rollbackPresent));
  }).length;

  const report = {
    ...foundation,
    invalidRoleAssignmentTargets,
    invalidMethodologyValueTargets,
    invalidDefinitions,
    invalidInstances,
    invalidEvaluations,
    invalidMigrations,
  };
  if (Object.values(report).some((value) => value > 0)) {
    throw new Error(`methodology data integrity failed: ${JSON.stringify(report)}`);
  }
  return report;
}

const mode = process.argv[2];
if (mode !== '--preflight' && mode !== '--verify') {
  console.error('usage: check-methodology-data.ts --preflight|--verify');
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
