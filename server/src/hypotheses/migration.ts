import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';

export const SALES_HYPOTHESIS_MIGRATION_MARKER = 'SAAS-207-sales-hypothesis-v1';
const SALES_HYPOTHESIS_MIGRATION_VERSION = 1;

export type SalesHypothesisSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';

export interface SalesHypothesisMigrationReport {
  ok: boolean;
  markerPresent: boolean;
  sourceRows: number;
  projectedRows: number;
  conflicts: string[];
  schemaFingerprint: string;
  projectionChecksum: string;
}

export interface SalesHypothesisMigrationApplyResult extends SalesHypothesisMigrationReport {
  writes: number;
}

interface MarkerDetails {
  version: number;
  schemaFingerprint: string;
  sourceRows: number;
  projectedRows: number;
  projectionChecksum: string;
  integrityChecksum: string;
}

interface LegacySource {
  id: string;
  tenantId: string;
  accountId: string;
  opportunityId: string;
  text: string;
  mitigation: string;
  status: string;
  origin: string;
  createdAt: Date;
}

interface LegacyProjection {
  source: LegacySource;
  hypothesis: {
    id: string;
    tenantId: string;
    customerId: string;
    matterId: string;
    personId: null;
    status: 'untested' | 'retired';
    ownerUserId: null;
    nextReviewAt: null;
    currentRevisionId: string;
    legacyStrategyRiskId: string;
    createdByUserId: null;
    statusConfirmedByUserId: null;
    statusConfirmedAt: null;
    version: 0;
    createdAt: Date;
  };
  revision: {
    id: string;
    tenantId: string;
    hypothesisId: string;
    revisionNumber: 1;
    claim: string;
    reason: string;
    expectedSignals: '[]';
    falsificationConditions: '[]';
    origin: 'legacy_assumption';
    createdByUserId: null;
    createdAt: Date;
  };
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const rowKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;
const boundedId = (value: string): boolean => (
  value.length > 0
  && value.length <= 200
  && !/[\s\u0000-\u001f\u007f]/u.test(value)
);
const boundedText = (value: string, maximum: number): boolean => (
  value.length > 0 && value.length <= maximum && value.trim() === value
);
const boundedOptionalText = (value: string, maximum: number): boolean => (
  value === '' || boundedText(value, maximum)
);
const nonnegativeVersion = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function hypothesisIdentityForLegacy(
  tenantId: string,
  strategyRiskId: string,
): { hypothesisId: string; revisionId: string } {
  return {
    hypothesisId: `hyp_${sha256(`${tenantId}\u0000StrategyRisk\u0000${strategyRiskId}`).slice(0, 32)}`,
    revisionId: `hyprev_${sha256(`${tenantId}\u0000StrategyRiskRevision\u0000${strategyRiskId}`).slice(0, 32)}`,
  };
}

export function salesHypothesisMigrationSchemaFingerprint(): string {
  return sha256(JSON.stringify({
    marker: SALES_HYPOTHESIS_MIGRATION_MARKER,
    version: SALES_HYPOTHESIS_MIGRATION_VERSION,
    hypothesis: {
      status: ['untested', 'testing', 'supported', 'contradicted', 'retired'],
      unique: [['tenantId', 'id'], ['tenantId', 'legacyStrategyRiskId']],
      authority: 'canonical-no-dual-write',
    },
    revision: {
      origin: ['user', 'legacy_assumption'],
      immutable: true,
      unique: [['tenantId', 'id'], ['tenantId', 'hypothesisId', 'revisionNumber']],
    },
    evidenceLink: {
      direction: ['supporting', 'contradicting'],
      evidenceVersion: 0,
      immutable: true,
      unique: [['tenantId', 'id'], ['tenantId', 'hypothesisRevisionId', 'evidenceId']],
    },
    migration: {
      source: 'StrategyRisk(kind=assumption,origin=manual)',
      open: 'untested',
      resolved: 'retired',
      dismissed: 'retired',
      inferTruth: false,
      formalEvidenceWrites: 0,
    },
  }));
}

function projectionChecksum(projections: readonly LegacyProjection[]): string {
  return sha256(JSON.stringify(projections.map(({ hypothesis, revision }) => ({
    hypothesis: {
      ...hypothesis,
      createdAt: hypothesis.createdAt.toISOString(),
    },
    revision: {
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    },
  }))));
}

function markerDetails(projections: readonly LegacyProjection[]): MarkerDetails {
  const payload = {
    version: SALES_HYPOTHESIS_MIGRATION_VERSION,
    schemaFingerprint: salesHypothesisMigrationSchemaFingerprint(),
    sourceRows: projections.length,
    projectedRows: projections.length,
    projectionChecksum: projectionChecksum(projections),
  };
  return { ...payload, integrityChecksum: sha256(JSON.stringify(payload)) };
}

function parseMarker(raw: string): MarkerDetails | null {
  try {
    const value = JSON.parse(raw) as Partial<MarkerDetails>;
    if (value.version !== SALES_HYPOTHESIS_MIGRATION_VERSION
      || value.schemaFingerprint !== salesHypothesisMigrationSchemaFingerprint()
      || !Number.isSafeInteger(value.sourceRows) || (value.sourceRows ?? -1) < 0
      || value.projectedRows !== value.sourceRows
      || typeof value.projectionChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.projectionChecksum)
      || typeof value.integrityChecksum !== 'string') {
      return null;
    }
    const payload = {
      version: value.version,
      schemaFingerprint: value.schemaFingerprint,
      sourceRows: value.sourceRows,
      projectedRows: value.projectedRows,
      projectionChecksum: value.projectionChecksum,
    };
    return value.integrityChecksum === sha256(JSON.stringify(payload))
      ? value as MarkerDetails
      : null;
  } catch {
    return null;
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

function sourceConflict(source: LegacySource): string | null {
  if (source.origin !== 'manual') return 'origin_not_user_confirmed';
  if (!['open', 'resolved', 'dismissed'].includes(source.status)) return 'status_invalid';
  if (!boundedText(source.text, 2_000)) return 'claim_invalid';
  if (!boundedOptionalText(source.mitigation, 1_000)) return 'reason_invalid';
  return null;
}

function asProjection(source: LegacySource): LegacyProjection {
  const identity = hypothesisIdentityForLegacy(source.tenantId, source.id);
  return {
    source,
    hypothesis: {
      id: identity.hypothesisId,
      tenantId: source.tenantId,
      customerId: source.accountId,
      matterId: source.opportunityId,
      personId: null,
      status: source.status === 'open' ? 'untested' : 'retired',
      ownerUserId: null,
      nextReviewAt: null,
      currentRevisionId: identity.revisionId,
      legacyStrategyRiskId: source.id,
      createdByUserId: null,
      statusConfirmedByUserId: null,
      statusConfirmedAt: null,
      version: 0,
      createdAt: source.createdAt,
    },
    revision: {
      id: identity.revisionId,
      tenantId: source.tenantId,
      hypothesisId: identity.hypothesisId,
      revisionNumber: 1,
      claim: source.text,
      reason: source.mitigation,
      expectedSignals: '[]',
      falsificationConditions: '[]',
      origin: 'legacy_assumption',
      createdByUserId: null,
      createdAt: source.createdAt,
    },
  };
}

function parseStringList(raw: string, allowEmpty: boolean): string[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && value.length === 0)) return null;
    if (!value.every((entry) => typeof entry === 'string' && boundedText(entry, 500))) return null;
    if (new Set(value).size !== value.length) return null;
    return JSON.stringify(value) === raw ? value : null;
  } catch {
    return null;
  }
}

const hypothesisSelect = {
  id: true,
  tenantId: true,
  customerId: true,
  matterId: true,
  personId: true,
  status: true,
  ownerUserId: true,
  nextReviewAt: true,
  currentRevisionId: true,
  legacyStrategyRiskId: true,
  createdByUserId: true,
  statusConfirmedByUserId: true,
  statusConfirmedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const revisionSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  revisionNumber: true,
  claim: true,
  reason: true,
  expectedSignals: true,
  falsificationConditions: true,
  origin: true,
  createdByUserId: true,
  createdAt: true,
} as const;

const linkSelect = {
  id: true,
  tenantId: true,
  hypothesisId: true,
  hypothesisRevisionId: true,
  evidenceId: true,
  evidenceVersion: true,
  direction: true,
  linkedByUserId: true,
  linkedAt: true,
} as const;

type HypothesisRow = Prisma.SalesHypothesisGetPayload<{ select: typeof hypothesisSelect }>;
type RevisionRow = Prisma.SalesHypothesisRevisionGetPayload<{ select: typeof revisionSelect }>;
type LinkRow = Prisma.HypothesisEvidenceLinkGetPayload<{ select: typeof linkSelect }>;

function legacyHypothesisMatches(
  actual: HypothesisRow,
  expected: LegacyProjection['hypothesis'],
  markerPresent: boolean,
): boolean {
  const immutableMatch = actual.id === expected.id
    && actual.tenantId === expected.tenantId
    && actual.customerId === expected.customerId
    && actual.matterId === expected.matterId
    && actual.personId === null
    && actual.legacyStrategyRiskId === expected.legacyStrategyRiskId
    && actual.createdByUserId === null
    && actual.createdAt.toISOString() === expected.createdAt.toISOString();
  if (!immutableMatch) return false;
  if (markerPresent) return true;
  return actual.status === expected.status
    && actual.ownerUserId === null
    && actual.nextReviewAt === null
    && actual.currentRevisionId === expected.currentRevisionId
    && actual.statusConfirmedByUserId === null
    && actual.statusConfirmedAt === null
    && actual.version === 0;
}

function initialRevisionMatches(
  actual: RevisionRow,
  expected: LegacyProjection['revision'],
): boolean {
  return actual.id === expected.id
    && actual.tenantId === expected.tenantId
    && actual.hypothesisId === expected.hypothesisId
    && actual.revisionNumber === 1
    && actual.claim === expected.claim
    && actual.reason === expected.reason
    && actual.expectedSignals === '[]'
    && actual.falsificationConditions === '[]'
    && actual.origin === 'legacy_assumption'
    && actual.createdByUserId === null
    && actual.createdAt.toISOString() === expected.createdAt.toISOString();
}

function validateHypothesisShape(row: HypothesisRow): string | null {
  if (![row.id, row.tenantId, row.customerId, row.matterId, row.currentRevisionId].every(boundedId)
    || !['untested', 'testing', 'supported', 'contradicted', 'retired'].includes(row.status)
    || !nonnegativeVersion(row.version)
    || row.createdAt.getTime() > row.updatedAt.getTime()) {
    return 'metadata_invalid';
  }
  if (row.personId !== null && !boundedId(row.personId)) return 'person_invalid';
  if (row.ownerUserId !== null && !boundedId(row.ownerUserId)) return 'owner_invalid';
  if (row.createdByUserId !== null && !boundedId(row.createdByUserId)) return 'creator_invalid';
  if ((row.statusConfirmedByUserId === null) !== (row.statusConfirmedAt === null)) {
    return 'status_confirmation_invalid';
  }
  if (row.legacyStrategyRiskId === null
    && (row.ownerUserId === null || row.nextReviewAt === null || row.createdByUserId === null)) {
    return 'review_contract_incomplete';
  }
  return null;
}

function validateRevisionShape(row: RevisionRow): string | null {
  if (![row.id, row.tenantId, row.hypothesisId].every(boundedId)
    || !Number.isSafeInteger(row.revisionNumber) || row.revisionNumber < 1
    || !boundedText(row.claim, 2_000)
    || !boundedOptionalText(row.reason, 1_000)
    || !['user', 'legacy_assumption'].includes(row.origin)) {
    return 'metadata_invalid';
  }
  const legacy = row.origin === 'legacy_assumption';
  if (!parseStringList(row.expectedSignals, legacy)
    || !parseStringList(row.falsificationConditions, legacy)) {
    return 'test_contract_invalid';
  }
  if (legacy) {
    if (row.revisionNumber !== 1 || row.createdByUserId !== null) return 'legacy_revision_invalid';
  } else if (row.createdByUserId === null || !boundedId(row.createdByUserId)) {
    return 'creator_invalid';
  }
  return null;
}

function validateLinkShape(row: LinkRow): string | null {
  if (![row.id, row.tenantId, row.hypothesisId, row.hypothesisRevisionId,
    row.evidenceId, row.linkedByUserId].every(boundedId)
    || row.evidenceVersion !== 0
    || !['supporting', 'contradicting'].includes(row.direction)) {
    return 'metadata_invalid';
  }
  return null;
}

async function inspect(db: DbClient): Promise<{
  report: SalesHypothesisMigrationReport;
  projections: LegacyProjection[];
  hypotheses: HypothesisRow[];
  revisions: RevisionRow[];
}> {
  const [marker, sources, tenants, accounts, matters, persons, participants, users, evidence] = await Promise.all([
    db.dataMigrationState.findUnique({
      where: { key: SALES_HYPOTHESIS_MIGRATION_MARKER }, select: { details: true },
    }),
    db.strategyRisk.findMany({
      where: { kind: 'assumption' },
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
      select: {
        id: true, tenantId: true, accountId: true, opportunityId: true,
        text: true, mitigation: true, status: true, origin: true, createdAt: true,
      },
    }),
    db.tenant.findMany({ select: { id: true } }),
    db.account.findMany({ select: { id: true, tenantId: true } }),
    db.opportunity.findMany({ select: { id: true, tenantId: true, accountId: true } }),
    db.person.findMany({ select: { id: true, tenantId: true, accountId: true } }),
    db.matterParticipant.findMany({
      select: { tenantId: true, accountId: true, opportunityId: true, personId: true },
    }),
    db.user.findMany({ select: { id: true, tenantId: true } }),
    db.evidenceEvent.findMany({
      select: { id: true, tenantId: true, accountId: true, opportunityId: true, status: true },
    }),
  ]);
  let hypotheses: HypothesisRow[] = [];
  let revisions: RevisionRow[] = [];
  let links: LinkRow[] = [];
  let missingSuccessorTables = 0;
  try {
    hypotheses = await db.salesHypothesis.findMany({
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }], select: hypothesisSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    missingSuccessorTables += 1;
  }
  try {
    revisions = await db.salesHypothesisRevision.findMany({
      orderBy: [{ tenantId: 'asc' }, { hypothesisId: 'asc' }, { revisionNumber: 'asc' }],
      select: revisionSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    missingSuccessorTables += 1;
  }
  try {
    links = await db.hypothesisEvidenceLink.findMany({
      orderBy: [{ tenantId: 'asc' }, { hypothesisId: 'asc' }, { linkedAt: 'asc' }],
      select: linkSelect,
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    missingSuccessorTables += 1;
  }
  const markerPresent = Boolean(marker);
  const parsedMarker = marker ? parseMarker(marker.details) : null;
  const conflicts: string[] = [];
  if (marker && !parsedMarker) conflicts.push('sales_hypothesis_marker_invalid');
  if (missingSuccessorTables !== 0 && missingSuccessorTables !== 3) {
    conflicts.push('sales_hypothesis_partial_schema');
  }
  if (markerPresent && missingSuccessorTables === 3) {
    conflicts.push('sales_hypothesis_marker_without_schema');
  }

  const tenantSet = new Set(tenants.map((row) => row.id));
  const accountMap = new Map(accounts.map((row) => [rowKey(row.tenantId, row.id), row]));
  const matterMap = new Map(matters.map((row) => [rowKey(row.tenantId, row.id), row]));
  const personMap = new Map(persons.map((row) => [rowKey(row.tenantId, row.id), row]));
  const participantSet = new Set(participants.map((row) => (
    `${row.tenantId}\u0000${row.accountId}\u0000${row.opportunityId}\u0000${row.personId}`
  )));
  const userSet = new Set(users.map((row) => rowKey(row.tenantId, row.id)));
  const evidenceMap = new Map(evidence.map((row) => [rowKey(row.tenantId, row.id), row]));
  const hypothesisMap = new Map(hypotheses.map((row) => [rowKey(row.tenantId, row.id), row]));
  const revisionMap = new Map(revisions.map((row) => [rowKey(row.tenantId, row.id), row]));
  const legacyMap = new Map(hypotheses
    .filter((row) => row.legacyStrategyRiskId !== null)
    .map((row) => [rowKey(row.tenantId, row.legacyStrategyRiskId!), row]));

  const projections: LegacyProjection[] = [];
  for (const source of sources) {
    const prefix = `${source.tenantId}:StrategyRisk:${source.id}`;
    const invalid = sourceConflict(source);
    if (invalid) {
      conflicts.push(`${prefix}:${invalid}`);
      continue;
    }
    const account = accountMap.get(rowKey(source.tenantId, source.accountId));
    const matter = matterMap.get(rowKey(source.tenantId, source.opportunityId));
    if (!tenantSet.has(source.tenantId) || !account || matter?.accountId !== source.accountId) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
      continue;
    }
    const projection = asProjection(source);
    projections.push(projection);
    const actual = hypothesisMap.get(rowKey(source.tenantId, projection.hypothesis.id));
    const byLegacy = legacyMap.get(rowKey(source.tenantId, source.id));
    if ((actual && !legacyHypothesisMatches(actual, projection.hypothesis, markerPresent))
      || (byLegacy && byLegacy.id !== projection.hypothesis.id)) {
      conflicts.push(`${prefix}:successor_identity_conflict`);
      continue;
    }
    const initial = revisionMap.get(rowKey(source.tenantId, projection.revision.id));
    if (initial && !initialRevisionMatches(initial, projection.revision)) {
      conflicts.push(`${prefix}:revision_semantic_conflict`);
    }
    if (markerPresent) {
      if (!actual) conflicts.push(`${prefix}:successor_missing`);
      if (!initial) conflicts.push(`${prefix}:initial_revision_missing`);
    }
  }

  const sourceByLegacy = new Set(sources.map((row) => rowKey(row.tenantId, row.id)));
  for (const row of hypotheses) {
    const prefix = `${row.tenantId}:SalesHypothesis:${row.id}`;
    const invalid = validateHypothesisShape(row);
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
    const account = accountMap.get(rowKey(row.tenantId, row.customerId));
    const matter = matterMap.get(rowKey(row.tenantId, row.matterId));
    const person = row.personId === null ? null : personMap.get(rowKey(row.tenantId, row.personId));
    if (!tenantSet.has(row.tenantId) || !account || matter?.accountId !== row.customerId
      || (row.personId !== null && (person?.accountId !== row.customerId
        || !participantSet.has(
          `${row.tenantId}\u0000${row.customerId}\u0000${row.matterId}\u0000${row.personId}`,
        )))
      || (row.ownerUserId !== null && !userSet.has(rowKey(row.tenantId, row.ownerUserId)))
      || (row.createdByUserId !== null && !userSet.has(rowKey(row.tenantId, row.createdByUserId)))
      || (row.statusConfirmedByUserId !== null
        && !userSet.has(rowKey(row.tenantId, row.statusConfirmedByUserId)))) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
    }
    const current = revisionMap.get(rowKey(row.tenantId, row.currentRevisionId));
    if (!current || current.hypothesisId !== row.id) conflicts.push(`${prefix}:current_revision_invalid`);
    if (row.legacyStrategyRiskId !== null
      && !sourceByLegacy.has(rowKey(row.tenantId, row.legacyStrategyRiskId))) {
      conflicts.push(`${prefix}:legacy_source_missing`);
    }
  }

  for (const row of revisions) {
    const prefix = `${row.tenantId}:SalesHypothesisRevision:${row.id}`;
    const invalid = validateRevisionShape(row);
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
    const parent = hypothesisMap.get(rowKey(row.tenantId, row.hypothesisId));
    if (!parent || (row.createdByUserId !== null
      && !userSet.has(rowKey(row.tenantId, row.createdByUserId)))) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
    }
  }

  const linksPerRevision = new Map<string, number>();
  for (const row of links) {
    const prefix = `${row.tenantId}:HypothesisEvidenceLink:${row.id}`;
    const invalid = validateLinkShape(row);
    if (invalid) conflicts.push(`${prefix}:${invalid}`);
    const hypothesis = hypothesisMap.get(rowKey(row.tenantId, row.hypothesisId));
    const revision = revisionMap.get(rowKey(row.tenantId, row.hypothesisRevisionId));
    const linkedEvidence = evidenceMap.get(rowKey(row.tenantId, row.evidenceId));
    if (!hypothesis || revision?.hypothesisId !== row.hypothesisId
      || linkedEvidence?.accountId !== hypothesis?.customerId
      || linkedEvidence?.opportunityId !== hypothesis?.matterId
      || linkedEvidence?.status !== 'approved'
      || !userSet.has(rowKey(row.tenantId, row.linkedByUserId))) {
      conflicts.push(`${prefix}:parent_closure_invalid`);
    }
    const countKey = rowKey(row.tenantId, row.hypothesisRevisionId);
    linksPerRevision.set(countKey, (linksPerRevision.get(countKey) ?? 0) + 1);
  }
  for (const [key, count] of linksPerRevision) {
    if (count > 50) conflicts.push(`${key.replace('\u0000', ':')}:evidence_link_limit_exceeded`);
  }

  const checksum = projectionChecksum(projections);
  if (parsedMarker && (parsedMarker.sourceRows !== projections.length
    || parsedMarker.projectedRows !== projections.length
    || parsedMarker.projectionChecksum !== checksum)) {
    conflicts.push('sales_hypothesis_marker_source_drift');
  }
  conflicts.sort();
  return {
    projections,
    hypotheses,
    revisions,
    report: {
      ok: conflicts.length === 0,
      markerPresent,
      sourceRows: sources.length,
      projectedRows: projections.length,
      conflicts,
      schemaFingerprint: salesHypothesisMigrationSchemaFingerprint(),
      projectionChecksum: checksum,
    },
  };
}

export async function reportSalesHypothesisMigration(
  db: DbClient,
): Promise<SalesHypothesisMigrationReport> {
  return (await inspect(db)).report;
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

export async function applySalesHypothesisMigration(
  db: DbClient,
  options: { failAfterWrites?: number } = {},
): Promise<SalesHypothesisMigrationApplyResult> {
  if (!isRootClient(db)) throw new Error('SalesHypothesis migration apply requires root client');
  return db.$transaction(async (tx) => {
    const before = await inspect(tx);
    if (!before.report.ok) {
      throw new Error(before.report.conflicts.join(',') || 'SalesHypothesis migration preflight failed');
    }
    let writes = 0;
    const inject = () => {
      if (options.failAfterWrites === writes) {
        throw new Error('injected SalesHypothesis migration failure');
      }
    };
    inject();
    const hypothesisById = new Set(before.hypotheses.map((row) => rowKey(row.tenantId, row.id)));
    const revisionById = new Set(before.revisions.map((row) => rowKey(row.tenantId, row.id)));
    for (const projection of before.projections) {
      const hypothesisKey = rowKey(projection.hypothesis.tenantId, projection.hypothesis.id);
      if (!hypothesisById.has(hypothesisKey)) {
        await tx.salesHypothesis.create({ data: projection.hypothesis });
        writes += 1;
        inject();
      }
      const revisionKey = rowKey(projection.revision.tenantId, projection.revision.id);
      if (!revisionById.has(revisionKey)) {
        await tx.salesHypothesisRevision.create({ data: projection.revision });
        writes += 1;
        inject();
      }
    }
    const existingMarker = await tx.dataMigrationState.findUnique({
      where: { key: SALES_HYPOTHESIS_MIGRATION_MARKER }, select: { details: true },
    });
    if (!existingMarker) {
      await tx.dataMigrationState.create({ data: {
        key: SALES_HYPOTHESIS_MIGRATION_MARKER,
        details: JSON.stringify(markerDetails(before.projections)),
      } });
      writes += 1;
      inject();
    } else if (!parseMarker(existingMarker.details)) {
      throw new Error('sales_hypothesis_marker_invalid');
    }
    const after = await inspect(tx);
    if (!after.report.ok || !after.report.markerPresent) {
      throw new Error(after.report.conflicts.join(',') || 'SalesHypothesis migration verification failed');
    }
    return { ...after.report, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 115_000,
  });
}

export async function verifySalesHypothesisMigration(
  db: DbClient,
): Promise<SalesHypothesisMigrationReport> {
  const report = await reportSalesHypothesisMigration(db);
  return { ...report, ok: report.ok && report.markerPresent };
}

const HYPOTHESIS_COLUMNS = new Set([
  'id', 'tenantId', 'customerId', 'matterId', 'personId', 'status', 'ownerUserId',
  'nextReviewAt', 'currentRevisionId', 'legacyStrategyRiskId', 'createdByUserId',
  'statusConfirmedByUserId', 'statusConfirmedAt', 'version', 'createdAt', 'updatedAt',
]);
const HYPOTHESIS_INDEXES = new Set([
  'SalesHypothesis_tenantId_id_key',
  'SalesHypothesis_tenantId_legacyStrategyRiskId_key',
  'SalesHypothesis_tenantId_customerId_updatedAt_idx',
  'SalesHypothesis_tenantId_matterId_updatedAt_idx',
  'SalesHypothesis_tenantId_personId_updatedAt_idx',
  'SalesHypothesis_tenantId_ownerUserId_nextReviewAt_idx',
  'SalesHypothesis_tenantId_status_nextReviewAt_idx',
]);
const REVISION_COLUMNS = new Set([
  'id', 'tenantId', 'hypothesisId', 'revisionNumber', 'claim', 'reason', 'expectedSignals',
  'falsificationConditions', 'origin', 'createdByUserId', 'createdAt',
]);
const REVISION_INDEXES = new Set([
  'SalesHypothesisRevision_tenantId_id_key',
  'SalesHypothesisRevision_tenantId_hypothesisId_revisionNumber_key',
  'SalesHypothesisRevision_tenantId_hypothesisId_createdAt_idx',
]);
const LINK_COLUMNS = new Set([
  'id', 'tenantId', 'hypothesisId', 'hypothesisRevisionId', 'evidenceId',
  'evidenceVersion', 'direction', 'linkedByUserId', 'linkedAt',
]);
const LINK_INDEXES = new Set([
  'HypothesisEvidenceLink_tenantId_id_key',
  'HypothesisEvidenceLink_tenantId_hypothesisRevisionId_evidenceId_key',
  'HypothesisEvidenceLink_tenantId_hypothesisId_linkedAt_idx',
  'HypothesisEvidenceLink_tenantId_evidenceId_idx',
]);

async function sqliteTableIsExact(
  db: Pick<DbClient, '$queryRawUnsafe'>,
  table: 'SalesHypothesis' | 'SalesHypothesisRevision' | 'HypothesisEvidenceLink',
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

export async function inspectSalesHypothesisSchemaState(
  db: Pick<DbClient, '$queryRawUnsafe'>,
): Promise<SalesHypothesisSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Tenant', 'DataMigrationState', 'IntelligenceItem', 'StakeholderFocus',
                     'SalesHypothesis', 'SalesHypothesisRevision', 'HypothesisEvidenceLink')`,
  );
  const names = new Set(tables.map((row) => row.name));
  if (!['Tenant', 'DataMigrationState', 'IntelligenceItem', 'StakeholderFocus']
    .every((name) => names.has(name))) {
    return 'uninitialized';
  }
  const expansion = ['SalesHypothesis', 'SalesHypothesisRevision', 'HypothesisEvidenceLink']
    .filter((name) => names.has(name));
  if (expansion.length === 0) return 'legacy';
  if (expansion.length !== 3) return 'partial';
  const [hypothesisExact, revisionExact, linkExact] = await Promise.all([
    sqliteTableIsExact(db, 'SalesHypothesis', HYPOTHESIS_COLUMNS, HYPOTHESIS_INDEXES),
    sqliteTableIsExact(db, 'SalesHypothesisRevision', REVISION_COLUMNS, REVISION_INDEXES),
    sqliteTableIsExact(db, 'HypothesisEvidenceLink', LINK_COLUMNS, LINK_INDEXES),
  ]);
  return hypothesisExact && revisionExact && linkExact ? 'expanded' : 'partial';
}
