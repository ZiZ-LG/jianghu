import { prisma } from '../src/prisma.js';

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};
type IndexRow = { tablename: string; indexname: string };
type ExpectedColumn = {
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
};

const expectedPlanActionColumns = new Map<string, ExpectedColumn>([
  ['hypothesisId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['hypothesisRevisionId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['completionResult', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['completionResultRecordedAtUtc', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['completionResultRecordedByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
  ['verificationReviewDisposition', { type: 'text', nullable: 'NO', defaultValue: "''::text" }],
  ['verificationReviewedAtUtc', { type: 'timestamp without time zone', nullable: 'YES', defaultValue: null }],
  ['verificationReviewedByUserId', { type: 'text', nullable: 'YES', defaultValue: null }],
]);

const expectedLinkColumns = new Map<string, ExpectedColumn>([
  ['verificationCommitmentId', { type: 'text', nullable: 'YES', defaultValue: null }],
]);

function columnsMatch(
  columns: readonly ColumnRow[],
  tableName: string,
  expected: ReadonlyMap<string, ExpectedColumn>,
): boolean {
  const relevant = columns.filter((column) => column.table_name === tableName);
  return relevant.length === expected.size && relevant.every((column) => {
    const wanted = expected.get(column.column_name);
    return wanted?.type === column.data_type
      && wanted.nullable === column.is_nullable
      && wanted.defaultValue === column.column_default;
  });
}

try {
  const exists = await prisma.$queryRawUnsafe<Array<{
    tenant: boolean;
    migration_state: boolean;
    plan_action: boolean;
    hypothesis: boolean;
    revision: boolean;
    evidence_link: boolean;
  }>>(`
    SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
           to_regclass('public."DataMigrationState"') IS NOT NULL AS migration_state,
           to_regclass('public."PlanAction"') IS NOT NULL AS plan_action,
           to_regclass('public."SalesHypothesis"') IS NOT NULL AS hypothesis,
           to_regclass('public."SalesHypothesisRevision"') IS NOT NULL AS revision,
           to_regclass('public."HypothesisEvidenceLink"') IS NOT NULL AS evidence_link
  `);
  const dependencies = exists[0];
  if (!dependencies?.tenant || !dependencies.migration_state || !dependencies.plan_action
    || !dependencies.hypothesis || !dependencies.revision || !dependencies.evidence_link) {
    process.stdout.write('uninitialized');
  } else {
    const quotedPlanActionNames = [...expectedPlanActionColumns.keys()]
      .map((name) => `'${name}'`).join(', ');
    const quotedLinkNames = [...expectedLinkColumns.keys()]
      .map((name) => `'${name}'`).join(', ');
    const [columns, indexes] = await Promise.all([
      prisma.$queryRawUnsafe<ColumnRow[]>(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             (table_name = 'PlanAction' AND column_name IN (${quotedPlanActionNames}))
             OR (table_name = 'HypothesisEvidenceLink' AND column_name IN (${quotedLinkNames}))
           )
         ORDER BY table_name, ordinal_position
      `),
      prisma.$queryRawUnsafe<IndexRow[]>(`
        SELECT tablename, indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN (
             'PlanAction_tenantId_hypothesisId_hypothesisRevisionId_idx',
             'HypothesisEvidenceLink_tenantId_verificationCommitmentId_idx'
           )
         ORDER BY indexname
      `),
    ]);
    if (columns.length === 0 && indexes.length === 0) {
      process.stdout.write(dependencies.plan_action && dependencies.evidence_link ? 'legacy' : 'uninitialized');
    } else {
      const indexNames = new Set(indexes.map((index) => index.indexname));
      const exact = columnsMatch(columns, 'PlanAction', expectedPlanActionColumns)
        && columnsMatch(columns, 'HypothesisEvidenceLink', expectedLinkColumns)
        && indexNames.size === 2
        && indexNames.has('PlanAction_tenantId_hypothesisId_hypothesisRevisionId_idx')
        && indexNames.has('HypothesisEvidenceLink_tenantId_verificationCommitmentId_idx');
      process.stdout.write(exact ? 'expanded' : 'partial');
    }
  }
} finally {
  await prisma.$disconnect();
}
