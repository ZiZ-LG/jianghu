import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AgentInputRefSchema,
  AgentEvidenceRefSchema,
  AgentOutputRefSchema,
  AgentJobKeySchema,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  BUILT_IN_AGENT_DEFINITIONS,
  builtInAgentDefinition,
  canonicalAgentDefinition,
  hashAgentDefinition,
} from './registry.js';
import { effectiveAgentControl, validatePreparedAgentAudit } from './policy.js';

export const AGENT_JOB_MIGRATION_MARKER = 'CORE-206-agent-job-run-v1';
const AGENT_JOB_MIGRATION_VERSION = 1;

export type AgentJobSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface AgentJobMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  definitions: number;
  runs: number;
  conflicts: string[];
  contractChecksum: string;
}

export interface AgentJobMigrationApplyResult extends AgentJobMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  contractChecksum: string;
  integrityChecksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

export function agentJobMigrationContractChecksum(): string {
  return sha256(JSON.stringify({
    marker: AGENT_JOB_MIGRATION_MARKER,
    version: AGENT_JOB_MIGRATION_VERSION,
    definitions: BUILT_IN_AGENT_DEFINITIONS.map((definition) => ({
      key: definition.jobKey,
      version: definition.jobVersion,
      hash: hashAgentDefinition(definition),
    })),
    actionModes: ['candidate', 'draft', 'read_only'],
    runStatuses: ['discarded', 'failed', 'running', 'succeeded'],
    bodyAuthority: 'SourceArtifact',
    candidateAuthority: 'ReviewBatch',
  }));
}

function markerDetails(): MarkerDetails {
  const receipt = {
    version: AGENT_JOB_MIGRATION_VERSION,
    contractChecksum: agentJobMigrationContractChecksum(),
  };
  return { ...receipt, integrityChecksum: sha256(JSON.stringify(receipt)) };
}

function markerValid(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    const expected = markerDetails();
    return value.version === expected.version
      && value.contractChecksum === expected.contractChecksum
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

const definitionSelect = {
  id: true,
  tenantId: true,
  jobKey: true,
  jobVersion: true,
  definitionJson: true,
  definitionHash: true,
  enabled: true,
  tenantLimitsJson: true,
  version: true,
  createdByUserId: true,
  updatedByUserId: true,
} as const;

const runSelect = {
  id: true,
  tenantId: true,
  definitionId: true,
  jobKey: true,
  jobVersion: true,
  definitionHash: true,
  definitionControlVersion: true,
  actionMode: true,
  trigger: true,
  status: true,
  customerId: true,
  matterId: true,
  sourceArtifactId: true,
  actorId: true,
  idempotencyKey: true,
  requestHash: true,
  attemptCount: true,
  maxAttempts: true,
  leaseToken: true,
  leaseExpiresAt: true,
  budgetLimit: true,
  costUsed: true,
  timeoutMs: true,
  authorizationFingerprint: true,
  inputRefs: true,
  evidenceRefs: true,
  outputRefs: true,
  modelRef: true,
  connectorRefs: true,
  failureCode: true,
  startedAt: true,
  completedAt: true,
  version: true,
} as const;

type DefinitionRow = Prisma.AgentJobDefinitionGetPayload<{ select: typeof definitionSelect }>;
type RunRow = Prisma.AgentRunGetPayload<{ select: typeof runSelect }>;

function parseRefArray<T>(
  raw: string,
  parser: { safeParse(value: unknown): { success: boolean; data?: T } },
  min: number,
  max: number,
): T[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length < min || value.length > max) return null;
    const parsed = value.map((item) => parser.safeParse(item));
    if (parsed.some((item) => !item.success)) return null;
    return parsed.map((item) => item.data as T);
  } catch {
    return null;
  }
}

function validateDefinition(row: DefinitionRow): string | null {
  const key = AgentJobKeySchema.safeParse(row.jobKey);
  const definition = key.success ? builtInAgentDefinition(key.data, row.jobVersion) : null;
  if (!definition) return 'registry_version_unknown';
  if (row.definitionJson !== canonicalAgentDefinition(definition)
    || row.definitionHash !== hashAgentDefinition(definition)) return 'definition_drift';
  const control = effectiveAgentControl(definition, row, true);
  if (control.state !== 'valid') return 'control_invalid';
  if (!row.id || !Number.isSafeInteger(row.version) || row.version < 1
    || !row.createdByUserId || !row.updatedByUserId) return 'metadata_invalid';
  return null;
}

function validateRunShape(row: RunRow, definitionRow: DefinitionRow | undefined): string | null {
  const key = AgentJobKeySchema.safeParse(row.jobKey);
  const definition = key.success ? builtInAgentDefinition(key.data, row.jobVersion) : null;
  if (!definition || !definitionRow) return 'definition_missing';
  if (definitionRow.tenantId !== row.tenantId
    || definitionRow.id !== row.definitionId
    || definitionRow.jobKey !== row.jobKey
    || definitionRow.jobVersion !== row.jobVersion
    || row.definitionHash !== hashAgentDefinition(definition)
    || row.actionMode !== definition.actionMode
    || row.definitionControlVersion < 1
    || row.definitionControlVersion > definitionRow.version) return 'definition_mismatch';
  if (!definition.triggers.includes(row.trigger as never)) return 'trigger_invalid';
  if (!['running', 'succeeded', 'failed', 'discarded'].includes(row.status)) return 'status_invalid';
  if (!isSha256(row.idempotencyKey) || !isSha256(row.requestHash)
    || !isSha256(row.authorizationFingerprint)) return 'hash_invalid';
  if (!Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0
    || !Number.isSafeInteger(row.maxAttempts) || row.maxAttempts < 1
    || row.maxAttempts > definition.maxAttempts || row.attemptCount > row.maxAttempts
    || !Number.isSafeInteger(row.budgetLimit) || row.budgetLimit < 0
    || row.budgetLimit > definition.budget.maxCostUnits
    || !Number.isSafeInteger(row.costUsed) || row.costUsed < 0 || row.costUsed > row.budgetLimit
    || !Number.isSafeInteger(row.timeoutMs) || row.timeoutMs < 25 || row.timeoutMs > definition.timeoutMs
    || !Number.isSafeInteger(row.version) || row.version < 0) return 'limits_invalid';
  if (row.status === 'running') {
    if (!row.leaseToken || !row.leaseExpiresAt || row.completedAt || row.failureCode) return 'lifecycle_invalid';
  } else if (row.leaseToken || row.leaseExpiresAt || !row.completedAt) return 'lifecycle_invalid';
  if (row.status === 'succeeded' && row.failureCode) return 'lifecycle_invalid';
  if ((row.status === 'failed' || row.status === 'discarded')
    && !/^[a-z][a-z0-9._-]{0,119}$/.test(row.failureCode)) return 'lifecycle_invalid';
  if (row.attemptCount > 0 && !row.startedAt) return 'lifecycle_invalid';

  const inputRefs = parseRefArray(row.inputRefs, AgentInputRefSchema, 1, definition.budget.maxInputRefs);
  const evidenceRefs = parseRefArray(row.evidenceRefs, AgentEvidenceRefSchema, 0, definition.budget.maxEvidenceRefs);
  const outputRefs = parseRefArray(row.outputRefs, AgentOutputRefSchema, 0, definition.budget.maxOutputRefs);
  const connectorRefs = parseRefArray(
    row.connectorRefs,
    { safeParse: (value: unknown) => ({
      success: typeof value === 'string' && definition.connectorRefs.includes(value),
      data: value as string,
    }) },
    0,
    definition.connectorRefs.length,
  );
  if (!inputRefs || !evidenceRefs || !outputRefs || !connectorRefs) return 'references_invalid';
  const inputIdentities = inputRefs.map((ref) => `${ref.kind}\0${ref.id}`);
  const sourceInputIds = new Set(inputRefs
    .filter((ref) => ref.kind === 'source_artifact')
    .map((ref) => ref.id));
  const customerRefs = inputRefs.filter((ref) => ref.kind === 'customer');
  const matterRefs = inputRefs.filter((ref) => ref.kind === 'matter');
  if (new Set(inputIdentities).size !== inputIdentities.length
    || inputRefs.some((ref) => !definition.scopeManifest.allowedInputRefKinds.includes(ref.kind))
    || customerRefs.length !== 1 || customerRefs[0]?.id !== row.customerId
    || matterRefs.length !== (row.matterId ? 1 : 0)
    || (row.matterId && matterRefs[0]?.id !== row.matterId)
    || (definition.scopeManifest.matter === 'required' && !row.matterId)
    || (definition.scopeManifest.matter === 'forbidden' && Boolean(row.matterId))
    || (definition.scopeManifest.sourceArtifact === 'required' && !row.sourceArtifactId)
    || (definition.scopeManifest.sourceArtifact === 'forbidden' && sourceInputIds.size > 0)
    || (definition.actionMode === 'candidate'
      && (sourceInputIds.size !== 1 || !sourceInputIds.has(row.sourceArtifactId ?? '')))
    || evidenceRefs.some((ref) => !sourceInputIds.has(ref.sourceArtifactId))) {
    return 'references_invalid';
  }
  if (row.modelRef !== definition.modelRef
    || connectorRefs.length !== definition.connectorRefs.length
    || connectorRefs.some((ref, index) => ref !== definition.connectorRefs[index])) return 'provider_ref_invalid';
  if (!inputRefs.some((ref) => ref.kind === 'customer' && ref.id === row.customerId)
    || (row.matterId && !inputRefs.some((ref) => ref.kind === 'matter' && ref.id === row.matterId))
    || (row.sourceArtifactId && !inputRefs.some((ref) => (
      ref.kind === 'source_artifact' && ref.id === row.sourceArtifactId
    )))) return 'anchor_ref_invalid';
  if (row.status === 'succeeded') {
    const policy = validatePreparedAgentAudit(definition, {
      costUnits: row.costUsed,
      evidenceRefs,
      outputRefs,
    }, {
      maxCostUnits: row.budgetLimit,
      timeoutMs: row.timeoutMs,
      maxAttempts: row.maxAttempts,
    });
    if (!policy.ok) return policy.code;
  } else if (outputRefs.length > 0) return 'terminal_output_forbidden';
  return null;
}

async function inspect(db: DbClient): Promise<AgentJobMigrationReport> {
  const contractChecksum = agentJobMigrationContractChecksum();
  const marker = await db.dataMigrationState.findUnique({
    where: { key: AGENT_JOB_MIGRATION_MARKER }, select: { details: true },
  });
  const markerPresent = Boolean(marker);
  const conflicts: string[] = [];
  if (marker && !markerValid(marker.details)) conflicts.push('agent_job_marker_invalid');

  let definitions: DefinitionRow[] | null;
  let runs: RunRow[] | null;
  try {
    definitions = await db.agentJobDefinition.findMany({
      orderBy: [{ tenantId: 'asc' }, { jobKey: 'asc' }, { jobVersion: 'asc' }],
      select: definitionSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    definitions = null;
  }
  try {
    runs = await db.agentRun.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
      select: runSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    runs = null;
  }
  if (definitions === null || runs === null) {
    if ((definitions === null) !== (runs === null)) conflicts.push('agent_job_schema_partial');
    if (markerPresent) conflicts.push('agent_job_marker_without_schema');
    return {
      ok: conflicts.length === 0,
      markerPresent,
      definitions: definitions?.length ?? 0,
      runs: runs?.length ?? 0,
      conflicts,
      contractChecksum,
    };
  }

  const tenantIds = [...new Set([...definitions, ...runs].map((row) => row.tenantId))];
  const [tenants, users, accounts, matters, sources, reviewBatches] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true } }),
    db.user.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true } }),
    db.account.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true } }),
    db.opportunity.findMany({
      where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, accountId: true },
    }),
    db.sourceArtifact.findMany({
      where: { tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, accountId: true, matterId: true },
    }),
    db.reviewBatch.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { id: true, tenantId: true, sourceArtifactId: true, accountId: true, matterId: true },
    }),
  ]);
  const tenantSet = new Set(tenants.map((row) => row.id));
  const userSet = new Set(users.map((row) => `${row.tenantId}\0${row.id}`));
  const accountById = new Map(accounts.map((row) => [row.id, row]));
  const matterById = new Map(matters.map((row) => [row.id, row]));
  const sourceById = new Map(sources.map((row) => [row.id, row]));
  const reviewBatchById = new Map(reviewBatches.map((row) => [row.id, row]));
  const definitionById = new Map(definitions.map((row) => [`${row.tenantId}\0${row.id}`, row]));

  for (const row of definitions) {
    const prefix = `${row.tenantId}:agent_definition:${row.id}`;
    if (!tenantSet.has(row.tenantId)) conflicts.push(`${prefix}:tenant_invalid`);
    const invalid = validateDefinition(row);
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
  }

  for (const row of runs) {
    const prefix = `${row.tenantId}:agent_run:${row.id}`;
    if (!tenantSet.has(row.tenantId)) conflicts.push(`${prefix}:tenant_invalid`);
    const invalid = validateRunShape(row, definitionById.get(`${row.tenantId}\0${row.definitionId}`));
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
    const account = accountById.get(row.customerId);
    if (account && account.tenantId !== row.tenantId) conflicts.push(`${prefix}:customer_tenant_mismatch`);
    if (row.matterId) {
      const matter = matterById.get(row.matterId);
      if (matter && (matter.tenantId !== row.tenantId || matter.accountId !== row.customerId)) {
        conflicts.push(`${prefix}:matter_parent_mismatch`);
      }
    }
    if (row.sourceArtifactId) {
      const source = sourceById.get(row.sourceArtifactId);
      if (source && (source.tenantId !== row.tenantId
        || source.accountId !== row.customerId
        || source.matterId !== row.matterId)) conflicts.push(`${prefix}:source_parent_mismatch`);
    }
    if (row.status === 'succeeded' && row.actionMode === 'candidate') {
      const outputs = parseRefArray(row.outputRefs, AgentOutputRefSchema, 1, 1);
      const batch = outputs?.[0]?.kind === 'review_batch'
        ? reviewBatchById.get(outputs[0].id)
        : undefined;
      if (!batch
        || batch.tenantId !== row.tenantId
        || batch.accountId !== row.customerId
        || batch.matterId !== row.matterId
        || batch.sourceArtifactId !== row.sourceArtifactId) {
        conflicts.push(`${prefix}:review_batch_authority_invalid`);
      }
    }
    if (row.status === 'running' && (
      !account
      || !userSet.has(`${row.tenantId}\0${row.actorId}`)
      || (row.matterId !== null && !matterById.has(row.matterId))
      || (row.sourceArtifactId !== null && !sourceById.has(row.sourceArtifactId))
    )) {
      conflicts.push(`${prefix}:active_scope_missing`);
    }
  }

  return {
    ok: conflicts.length === 0,
    markerPresent,
    definitions: definitions.length,
    runs: runs.length,
    conflicts,
    contractChecksum,
  };
}

export async function reportAgentJobMigration(db: DbClient): Promise<AgentJobMigrationReport> {
  return inspect(db);
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applyAgentJobMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<AgentJobMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('Agent Job migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.ok) throw new Error(before.conflicts.join(',') || 'Agent Job migration preflight failed');
    let writes = 0;
    const existing = await tx.dataMigrationState.findUnique({
      where: { key: AGENT_JOB_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existing) {
      await tx.dataMigrationState.create({ data: {
        key: AGENT_JOB_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails()),
      } });
      writes += 1;
      if (options.failAfterWrites === writes) throw new Error('injected Agent Job migration failure');
    } else if (!markerValid(existing.details)) {
      throw new Error('agent_job_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.ok || !after.markerPresent) {
      throw new Error(after.conflicts.join(',') || 'Agent Job migration verification failed');
    }
    return { ...after, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifyAgentJobMigration(db: DbClient): Promise<AgentJobMigrationReport> {
  const report = await inspect(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const DEFINITION_COLUMNS = new Set([
  'id', 'tenantId', 'jobKey', 'jobVersion', 'definitionJson', 'definitionHash', 'enabled',
  'tenantLimitsJson', 'version', 'createdByUserId', 'updatedByUserId', 'createdAt', 'updatedAt',
]);
const RUN_COLUMNS = new Set([
  'id', 'tenantId', 'definitionId', 'jobKey', 'jobVersion', 'definitionHash',
  'definitionControlVersion', 'actionMode', 'trigger', 'status', 'customerId', 'matterId',
  'sourceArtifactId', 'actorId', 'idempotencyKey', 'requestHash', 'attemptCount', 'maxAttempts',
  'leaseToken', 'leaseExpiresAt', 'budgetLimit', 'costUsed', 'timeoutMs',
  'authorizationFingerprint', 'inputRefs', 'evidenceRefs', 'outputRefs', 'modelRef',
  'connectorRefs', 'failureCode', 'startedAt', 'completedAt', 'version', 'createdAt', 'updatedAt',
]);
const DEFINITION_INDEXES = new Set([
  'AgentJobDefinition_tenantId_jobKey_jobVersion_key',
  'AgentJobDefinition_tenantId_enabled_jobKey_idx',
  'AgentJobDefinition_tenantId_updatedAt_idx',
]);
const RUN_INDEXES = new Set([
  'AgentRun_tenantId_actorId_jobKey_jobVersion_idempotencyKey_key',
  'AgentRun_tenantId_status_createdAt_idx',
  'AgentRun_tenantId_customerId_createdAt_idx',
  'AgentRun_tenantId_matterId_createdAt_idx',
  'AgentRun_tenantId_sourceArtifactId_createdAt_idx',
  'AgentRun_tenantId_actorId_createdAt_idx',
  'AgentRun_tenantId_definitionId_idx',
]);

export async function inspectAgentJobSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<AgentJobSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'ReviewBatch', 'AgentJobDefinition', 'AgentRun')`,
  );
  const names = new Set(tables.map((table) => table.name));
  if (!names.has('Tenant') || !names.has('DataMigrationState') || !names.has('ReviewBatch')) {
    return 'uninitialized';
  }
  const present = Number(names.has('AgentJobDefinition')) + Number(names.has('AgentRun'));
  if (present === 0) return 'legacy';
  if (present !== 2) return 'partial';
  const [definitionColumns, runColumns, definitionIndexes, runIndexes, definitionFks, runFks] = await Promise.all([
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("AgentJobDefinition")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("AgentRun")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("AgentJobDefinition")'),
    db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("AgentRun")'),
    db.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string }>>(
      'PRAGMA foreign_key_list("AgentJobDefinition")',
    ),
    db.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string }>>(
      'PRAGMA foreign_key_list("AgentRun")',
    ),
  ]);
  const exact = (actual: readonly { name: string }[], expected: ReadonlySet<string>) => (
    actual.length === expected.size && actual.every((row) => expected.has(row.name))
  );
  const contains = (actual: readonly { name: string }[], expected: ReadonlySet<string>) => {
    const actualNames = new Set(actual.map((row) => row.name));
    return [...expected].every((name) => actualNames.has(name));
  };
  const exactTenantFk = (rows: readonly { table: string; from: string; to: string; on_delete: string }[]) => (
    rows.length === 1
      && rows[0]?.table === 'Tenant'
      && rows[0].from === 'tenantId'
      && rows[0].to === 'id'
      && rows[0].on_delete.toUpperCase() === 'CASCADE'
  );
  return exact(definitionColumns, DEFINITION_COLUMNS)
    && exact(runColumns, RUN_COLUMNS)
    && contains(definitionIndexes, DEFINITION_INDEXES)
    && contains(runIndexes, RUN_INDEXES)
    && exactTenantFk(definitionFks)
    && exactTenantFk(runFks)
    ? 'expanded'
    : 'partial';
}
