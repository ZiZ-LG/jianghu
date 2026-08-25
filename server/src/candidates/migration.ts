import { createHash } from 'node:crypto';
import { Prisma, type Candidate, type PrismaClient } from '@prisma/client';

export type LegacyCandidateSourceKind =
  | 'PersonSuggestion'
  | 'RelSuggestion'
  | 'ChangeProposal'
  | 'Reminder'
  | 'EvidenceEvent';

export type CanonicalCandidateStatus = 'pending' | 'accepted' | 'rejected';
export type CandidateSchemaState = 'uninitialized' | 'legacy' | 'expanded' | 'partial';
export const CANDIDATE_BACKFILL_MARKER = 'CORE-203-candidate-backfill-v1';
const CANDIDATE_BACKFILL_VERSION = 1;

export interface CandidateMigrationIssue {
  tenantId: string;
  sourceKind: LegacyCandidateSourceKind;
  sourceId: string;
  reason: string;
}

export interface CandidateMigrationSourceReport {
  sourceKind: LegacyCandidateSourceKind;
  sourceRows: number;
  projectedRows: number;
  invalidRows: number;
}

export interface CandidateMigrationStatusReport {
  status: CanonicalCandidateStatus;
  rows: number;
}

export interface CandidateMigrationReport {
  sourceRows: number;
  projectedRows: number;
  quarantinedCreatorRows: number;
  invalidRows: CandidateMigrationIssue[];
  bySource: CandidateMigrationSourceReport[];
  byStatus: CandidateMigrationStatusReport[];
  projectionChecksum: string;
}

export interface CandidateMigrationVerification {
  ok: boolean;
  markerPresent: boolean;
  conflicts: string[];
  report: CandidateMigrationReport;
}

export interface CandidateMigrationApplyResult extends CandidateMigrationVerification {
  writes: number;
}

export interface CandidateProjection {
  id: string;
  tenantId: string;
  kind: string;
  status: CanonicalCandidateStatus;
  accountId: string;
  matterId: string | null;
  targetKind: string;
  targetId: string | null;
  fieldKey: string | null;
  oldValue: string | null;
  newValue: string | null;
  payload: string;
  source: string;
  sourceRef: string;
  evidence: string;
  confidence: number;
  sourceArtifactId: null;
  reviewBatchId: null;
  createdByUserId: string | null;
  visibility: 'private' | 'owner_admin_only';
  dedupeKey: string;
  legacySourceKind: LegacyCandidateSourceKind;
  legacySourceId: string;
  version: 0;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantCandidateMigrationProjection {
  tenantId: string;
  sourceRows: number;
  projections: CandidateProjection[];
  invalidRows: CandidateMigrationIssue[];
  bySource: CandidateMigrationSourceReport[];
}

type CandidateReadClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  | 'tenant'
  | 'user'
  | 'account'
  | 'opportunity'
  | 'person'
  | 'planAction'
  | 'uCV'
  | 'personSuggestion'
  | 'relSuggestion'
  | 'changeProposal'
  | 'reminder'
  | 'evidenceEvent'
  | 'candidate'
  | 'dataMigrationState'
  | 'burningIssue'
  | '$queryRawUnsafe'
>;

const SOURCE_KINDS: readonly LegacyCandidateSourceKind[] = [
  'PersonSuggestion',
  'RelSuggestion',
  'ChangeProposal',
  'Reminder',
  'EvidenceEvent',
];

const STATUS_ORDER: readonly CanonicalCandidateStatus[] = ['pending', 'accepted', 'rejected'];

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('candidate canonical JSON rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new Error(`candidate canonical JSON rejects ${typeof value}`);
}

export function canonicalCandidateJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function candidateBackfillMarkerChecksum(): string {
  return sha256(canonicalCandidateJson({
    marker: CANDIDATE_BACKFILL_MARKER,
    sourceKinds: SOURCE_KINDS,
    version: CANDIDATE_BACKFILL_VERSION,
  }));
}

function candidateBackfillMarkerDetails(report: CandidateMigrationReport): string {
  return canonicalCandidateJson({
    markerChecksum: candidateBackfillMarkerChecksum(),
    projectionChecksum: report.projectionChecksum,
    sourceRows: report.sourceRows,
    version: CANDIDATE_BACKFILL_VERSION,
  });
}

function candidateBackfillMarkerConflict(details: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return 'candidate_marker_invalid:json';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'candidate_marker_invalid:shape';
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.version !== CANDIDATE_BACKFILL_VERSION) {
    return 'candidate_marker_invalid:version';
  }
  if (!Number.isInteger(receipt.sourceRows) || (receipt.sourceRows as number) < 0) {
    return 'candidate_marker_invalid:sourceRows';
  }
  if (typeof receipt.projectionChecksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(receipt.projectionChecksum)) {
    return 'candidate_marker_invalid:projectionChecksum';
  }
  if (receipt.markerChecksum !== candidateBackfillMarkerChecksum()) {
    return 'candidate_marker_checksum_mismatch';
  }
  return null;
}

export function candidateIdentityForLegacy(
  tenantId: string,
  sourceKind: LegacyCandidateSourceKind,
  sourceId: string,
) {
  return {
    id: `cand_${sha256(`${tenantId}\u0000${sourceKind}\u0000${sourceId}`).slice(0, 32)}`,
    dedupeKey: `legacy-v1:${sourceKind}:${sourceId}`,
    sourceRef: `legacy:${sourceKind}:${sourceId}`,
  };
}

function creatorScope(userIds: ReadonlySet<string>, creatorId: string | null | undefined) {
  return creatorId && userIds.has(creatorId)
    ? { createdByUserId: creatorId, visibility: 'private' as const }
    : { createdByUserId: null, visibility: 'owner_admin_only' as const };
}

function sourceStatus(
  sourceKind: LegacyCandidateSourceKind,
  status: string,
): CanonicalCandidateStatus | null {
  if (sourceKind === 'Reminder') {
    if (status === 'pending') return 'pending';
    if (status === 'done') return 'accepted';
    if (status === 'dismissed') return 'rejected';
    return null;
  }
  if (sourceKind === 'EvidenceEvent') {
    if (status === 'pending_review') return 'pending';
    if (status === 'approved') return 'accepted';
    if (status === 'rejected') return 'rejected';
    return null;
  }
  return STATUS_ORDER.includes(status as CanonicalCandidateStatus)
    ? status as CanonicalCandidateStatus
    : null;
}

function projectionBase(args: {
  tenantId: string;
  sourceKind: LegacyCandidateSourceKind;
  sourceId: string;
  status: CanonicalCandidateStatus;
  accountId: string;
  matterId?: string | null;
  kind: string;
  targetKind: string;
  targetId?: string | null;
  fieldKey?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  payload: unknown;
  source: string;
  evidence: string;
  confidence: number;
  creator: ReturnType<typeof creatorScope>;
  createdAt: Date;
}): CandidateProjection {
  const identity = candidateIdentityForLegacy(args.tenantId, args.sourceKind, args.sourceId);
  return {
    id: identity.id,
    tenantId: args.tenantId,
    kind: args.kind,
    status: args.status,
    accountId: args.accountId,
    matterId: args.matterId ?? null,
    targetKind: args.targetKind,
    targetId: args.targetId ?? null,
    fieldKey: args.fieldKey ?? null,
    oldValue: args.oldValue ?? null,
    newValue: args.newValue ?? null,
    payload: canonicalCandidateJson(args.payload),
    source: args.source,
    sourceRef: identity.sourceRef,
    evidence: args.evidence,
    confidence: args.confidence,
    sourceArtifactId: null,
    reviewBatchId: null,
    ...args.creator,
    dedupeKey: identity.dedupeKey,
    legacySourceKind: args.sourceKind,
    legacySourceId: args.sourceId,
    version: 0,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

function issue(
  tenantId: string,
  sourceKind: LegacyCandidateSourceKind,
  sourceId: string,
  reason: string,
): CandidateMigrationIssue {
  return { tenantId, sourceKind, sourceId, reason };
}

export async function projectCandidateMigrationForTenant(
  db: CandidateReadClient,
  tenantId: string,
): Promise<TenantCandidateMigrationProjection> {
  let linkedEvidenceSourceIds = new Set<string>();
  try {
    const linked = await db.candidate.findMany({
      where: { tenantId, legacySourceKind: 'EvidenceEvent' },
      select: { legacySourceId: true },
    });
    linkedEvidenceSourceIds = new Set(linked.flatMap((row) => row.legacySourceId ? [row.legacySourceId] : []));
  } catch (error) {
    // Pre-expansion dry-runs intentionally operate before Candidate exists.
    if (!isMissingTable(error)) throw error;
  }
  const [
    users, accounts, matters, persons, planActions, ucvs, personSuggestions,
    relSuggestions, changeProposals, reminders, evidenceRows, burningIssues,
  ] = await Promise.all([
    db.user.findMany({ where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true } }),
    db.account.findMany({ where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true } }),
    db.opportunity.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true, accountId: true },
    }),
    db.person.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true, accountId: true },
    }),
    db.planAction.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: { id: true, accountId: true, opportunityId: true },
    }),
    db.uCV.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: { id: true, opportunityId: true },
    }),
    db.personSuggestion.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, name: true, title: true, orgLevel: true,
        origin: true, evidence: true, sourceUrl: true, confidence: true, status: true, proposedBy: true,
        resolvedPersonId: true, suggestedRole: true, suggestedSentiment: true, createdAt: true,
      },
    }),
    db.relSuggestion.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, opportunityId: true, sourcePersonId: true, targetPersonId: true,
        sourceKind: true, targetKind: true, layer: true, label: true, confidence: true,
        origin: true, evidence: true, status: true, createdAt: true,
      },
    }),
    db.changeProposal.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, entityKind: true, entityId: true,
        field: true, oldValue: true, newValue: true, origin: true, evidence: true,
        confidence: true, status: true, proposedBy: true, createdAt: true,
      },
    }),
    db.reminder.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, accountName: true, opportunityId: true, oppName: true,
        kind: true, title: true, detail: true, severity: true, entityId: true, dedupeKey: true,
        status: true, createdAt: true,
      },
    }),
    db.evidenceEvent.findMany({
      where: { tenantId }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, opportunityId: true, personId: true, signalKey: true,
        direction: true, tier: true, rawContent: true, occurredAt: true, status: true,
        origin: true, createdBy: true, createdAt: true,
      },
    }),
    db.burningIssue.findMany({
      where: { tenantId }, orderBy: { id: 'asc' }, select: { id: true, opportunityId: true, personId: true },
    }),
  ]);
  const evidences = evidenceRows.filter((row) =>
    row.status === 'pending_review' || linkedEvidenceSourceIds.has(row.id));

  const changeDedupeById = new Map<string, string | null>();
  try {
    const rows = await db.changeProposal.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
      select: { id: true, dedupeKey: true },
    });
    for (const row of rows) changeDedupeById.set(row.id, row.dedupeKey);
  } catch (error) {
    // The approved pre-INT501 production snapshot predates this nullable
    // compatibility field. Never broaden the query: the retry remains scoped
    // to this tenant and simply records that no legacy semantic key existed.
    if (!isMissingColumn(error)) throw error;
  }

  const userIds = new Set(users.map((row) => row.id));
  const accountIds = new Set(accounts.map((row) => row.id));
  const matterById = new Map(matters.map((row) => [row.id, row]));
  const personById = new Map(persons.map((row) => [row.id, row]));
  const planActionById = new Map(planActions.map((row) => [row.id, row]));
  const ucvById = new Map(ucvs.map((row) => [row.id, row]));
  const suggestionById = new Map(personSuggestions.map((row) => [row.id, row]));
  const burningIssueById = new Map(burningIssues.map((row) => [row.id, row]));
  const projections: CandidateProjection[] = [];
  const invalidRows: CandidateMigrationIssue[] = [];
  const sourceTotals = new Map<LegacyCandidateSourceKind, number>([
    ['PersonSuggestion', personSuggestions.length],
    ['RelSuggestion', relSuggestions.length],
    ['ChangeProposal', changeProposals.length],
    ['Reminder', reminders.length],
    ['EvidenceEvent', evidences.length],
  ]);

  const validAccount = (accountId: string) => accountIds.has(accountId);
  const validMatter = (matterId: string | null, accountId: string) => {
    if (!matterId) return true;
    return matterById.get(matterId)?.accountId === accountId;
  };
  const validPerson = (personId: string, accountId: string) => personById.get(personId)?.accountId === accountId;

  for (const row of personSuggestions) {
    const status = sourceStatus('PersonSuggestion', row.status);
    let reason: string | null = null;
    if (!status) reason = 'unsupported_status';
    else if (!validAccount(row.accountId)) reason = 'account_not_found';
    else if (!validMatter(row.opportunityId, row.accountId)) reason = 'matter_not_found_or_mismatch';
    else if (row.resolvedPersonId && !validPerson(row.resolvedPersonId, row.accountId)) {
      reason = 'resolved_person_not_found';
    }
    if (reason || !status) {
      invalidRows.push(issue(tenantId, 'PersonSuggestion', row.id, reason ?? 'unsupported_status'));
      continue;
    }
    projections.push(projectionBase({
      tenantId, sourceKind: 'PersonSuggestion', sourceId: row.id, status,
      accountId: row.accountId, matterId: row.opportunityId, kind: 'person_create',
      targetKind: 'person', payload: {
        legacyStatus: row.status,
        name: row.name,
        orgLevel: row.orgLevel,
        resolvedPersonId: row.resolvedPersonId,
        sourceUrl: row.sourceUrl,
        suggestedRole: row.suggestedRole,
        suggestedSentiment: row.suggestedSentiment,
        title: row.title,
      },
      source: row.origin, evidence: row.evidence, confidence: row.confidence,
      creator: creatorScope(userIds, row.proposedBy), createdAt: row.createdAt,
    }));
  }

  const validRelationEndpoint = (
    kind: string,
    id: string,
    accountId: string,
    matterId: string,
  ): boolean => {
    if (kind === 'person') return validPerson(id, accountId);
    if (kind !== 'suggestion') return false;
    const suggestion = suggestionById.get(id);
    return suggestion?.accountId === accountId
      && (!suggestion.opportunityId || suggestion.opportunityId === matterId);
  };

  for (const row of relSuggestions) {
    const status = sourceStatus('RelSuggestion', row.status);
    const matter = matterById.get(row.opportunityId);
    let reason: string | null = null;
    if (!status) reason = 'unsupported_status';
    else if (!matter) reason = 'matter_not_found_or_mismatch';
    else if (
      !validRelationEndpoint(row.sourceKind, row.sourcePersonId, matter.accountId, row.opportunityId)
      || !validRelationEndpoint(row.targetKind, row.targetPersonId, matter.accountId, row.opportunityId)
    ) reason = 'relation_endpoint_not_found';
    if (reason || !status || !matter) {
      invalidRows.push(issue(tenantId, 'RelSuggestion', row.id, reason ?? 'matter_not_found_or_mismatch'));
      continue;
    }
    projections.push(projectionBase({
      tenantId, sourceKind: 'RelSuggestion', sourceId: row.id, status,
      accountId: matter.accountId, matterId: row.opportunityId, kind: 'relation_create',
      targetKind: 'relation', payload: {
        label: row.label,
        layer: row.layer,
        legacyStatus: row.status,
        sourceKind: row.sourceKind,
        sourcePersonId: row.sourcePersonId,
        targetKind: row.targetKind,
        targetPersonId: row.targetPersonId,
      },
      source: row.origin, evidence: row.evidence, confidence: row.confidence,
      creator: creatorScope(userIds, null), createdAt: row.createdAt,
    }));
  }

  for (const row of changeProposals) {
    const status = sourceStatus('ChangeProposal', row.status);
    let reason: string | null = null;
    if (!status) reason = 'unsupported_status';
    else if (!validAccount(row.accountId)) reason = 'account_not_found';
    else if (!validMatter(row.opportunityId, row.accountId)) reason = 'matter_not_found_or_mismatch';
    else if (row.entityKind === 'person' || row.entityKind === 'personLog') {
      if (!validPerson(row.entityId, row.accountId)) reason = 'change_target_not_found';
    } else if (row.entityKind === 'oppRole') {
      if (!row.opportunityId || !validPerson(row.entityId, row.accountId)) reason = 'change_target_not_found';
    } else if (row.entityKind === 'opportunity') {
      const targetMatter = matterById.get(row.entityId);
      if (!targetMatter || targetMatter.accountId !== row.accountId
        || (row.opportunityId && row.opportunityId !== row.entityId)) reason = 'change_target_not_found';
    } else if (row.entityKind === 'bi') {
      const target = burningIssueById.get(row.entityId);
      const targetMatter = target ? matterById.get(target.opportunityId) : null;
      if (!target || !targetMatter || targetMatter.accountId !== row.accountId
        || (row.opportunityId && target.opportunityId !== row.opportunityId)) reason = 'change_target_not_found';
    } else if (row.entityKind === 'ucv') {
      const target = ucvById.get(row.entityId);
      const targetMatter = target ? matterById.get(target.opportunityId) : null;
      if (!target || !targetMatter || targetMatter.accountId !== row.accountId
        || (row.opportunityId && target.opportunityId !== row.opportunityId)) reason = 'change_target_not_found';
    } else reason = 'unsupported_target_kind';
    if (reason || !status) {
      invalidRows.push(issue(tenantId, 'ChangeProposal', row.id, reason ?? 'unsupported_status'));
      continue;
    }
    projections.push(projectionBase({
      tenantId, sourceKind: 'ChangeProposal', sourceId: row.id, status,
      accountId: row.accountId, matterId: row.opportunityId, kind: 'field_change',
      targetKind: row.entityKind, targetId: row.entityId, fieldKey: row.field,
      oldValue: row.oldValue, newValue: row.newValue,
      payload: { legacyDedupeKey: changeDedupeById.get(row.id) ?? null, legacyStatus: row.status },
      source: row.origin, evidence: row.evidence, confidence: row.confidence,
      creator: creatorScope(userIds, row.proposedBy), createdAt: row.createdAt,
    }));
  }

  for (const row of reminders) {
    const status = sourceStatus('Reminder', row.status);
    let reason: string | null = null;
    let targetKind = '';
    let targetId = '';
    if (!status) reason = 'unsupported_status';
    else if (!validAccount(row.accountId)) reason = 'account_not_found';
    else if (!validMatter(row.opportunityId, row.accountId)) reason = 'matter_not_found_or_mismatch';
    else if (row.kind === 'sentiment_recheck' || row.kind === 'form_empty') {
      if (!row.entityId || !validPerson(row.entityId, row.accountId)) reason = 'reminder_entity_not_found';
      else {
        targetKind = 'person';
        targetId = row.entityId;
      }
    } else if (row.kind === 'action_overdue' || row.kind === 'confirmation_due' || row.kind === 'commitment_due') {
      const commitment = row.entityId ? planActionById.get(row.entityId) : null;
      if (!commitment || commitment.accountId !== row.accountId
        || (row.opportunityId && commitment.opportunityId !== row.opportunityId)) {
        reason = 'reminder_entity_not_found';
      } else {
        targetKind = 'commitment';
        targetId = commitment.id;
      }
    } else if (row.kind === 'matter_without_next_commitment') {
      if (!row.entityId || !row.opportunityId || row.entityId !== row.opportunityId) {
        reason = 'reminder_entity_not_found';
      } else {
        targetKind = 'matter';
        targetId = row.opportunityId;
      }
    } else if (row.kind === 'stalled' || row.kind === 'no_decider') {
      if (!row.opportunityId || row.entityId) reason = 'reminder_entity_not_found';
      else {
        targetKind = 'matter';
        targetId = row.opportunityId;
      }
    } else reason = 'unsupported_reminder_kind';
    if (reason || !status) {
      invalidRows.push(issue(tenantId, 'Reminder', row.id, reason ?? 'unsupported_status'));
      continue;
    }
    projections.push(projectionBase({
      tenantId, sourceKind: 'Reminder', sourceId: row.id, status,
      accountId: row.accountId, matterId: row.opportunityId, kind: 'reminder',
      targetKind, targetId,
      payload: {
        accountName: row.accountName,
        detail: row.detail,
        legacyDedupeKey: row.dedupeKey,
        legacyStatus: row.status,
        reminderKind: row.kind,
        severity: row.severity,
        title: row.title,
      },
      source: 'rules', evidence: row.detail, confidence: 1,
      creator: creatorScope(userIds, null), createdAt: row.createdAt,
    }));
  }

  for (const row of evidences) {
    const status = sourceStatus('EvidenceEvent', row.status);
    let reason: string | null = null;
    if (!status) reason = 'unsupported_status';
    else if (!validAccount(row.accountId)) reason = 'account_not_found';
    else if (!validMatter(row.opportunityId, row.accountId)) reason = 'matter_not_found_or_mismatch';
    else if (!validPerson(row.personId, row.accountId)) reason = 'evidence_person_not_found';
    if (reason || !status) {
      invalidRows.push(issue(tenantId, 'EvidenceEvent', row.id, reason ?? 'unsupported_status'));
      continue;
    }
    projections.push(projectionBase({
      tenantId, sourceKind: 'EvidenceEvent', sourceId: row.id, status,
      accountId: row.accountId, matterId: row.opportunityId, kind: 'evidence_create',
      targetKind: 'person', targetId: row.personId,
      payload: {
        direction: row.direction,
        legacyStatus: row.status,
        occurredAt: row.occurredAt,
        signalKey: row.signalKey,
        tier: row.tier,
      },
      source: row.origin, evidence: row.rawContent, confidence: 0.5,
      creator: creatorScope(userIds, row.createdBy), createdAt: row.createdAt,
    }));
  }

  const sourceOrder = new Map(SOURCE_KINDS.map((kind, index) => [kind, index]));
  invalidRows.sort((left, right) =>
    (sourceOrder.get(left.sourceKind)! - sourceOrder.get(right.sourceKind)!)
    || left.sourceId.localeCompare(right.sourceId));
  projections.sort((left, right) =>
    (sourceOrder.get(left.legacySourceKind)! - sourceOrder.get(right.legacySourceKind)!)
    || left.legacySourceId.localeCompare(right.legacySourceId));

  const seenIds = new Set<string>();
  const seenDedupe = new Set<string>();
  for (const row of projections) {
    if (seenIds.has(row.id) || seenDedupe.has(row.dedupeKey)) {
      throw new Error(`Candidate migration identity collision for tenant ${tenantId}`);
    }
    seenIds.add(row.id);
    seenDedupe.add(row.dedupeKey);
  }

  const bySource = SOURCE_KINDS.map((sourceKind) => {
    const sourceRows = sourceTotals.get(sourceKind) ?? 0;
    const projectedRows = projections.filter((row) => row.legacySourceKind === sourceKind).length;
    const invalid = invalidRows.filter((row) => row.sourceKind === sourceKind).length;
    if (sourceRows !== projectedRows + invalid) {
      throw new Error(`Candidate ${sourceKind} count parity failed for tenant ${tenantId}`);
    }
    return { sourceKind, sourceRows, projectedRows, invalidRows: invalid };
  });

  return {
    tenantId,
    sourceRows: bySource.reduce((sum, row) => sum + row.sourceRows, 0),
    projections,
    invalidRows,
    bySource,
  };
}

type CandidateIntegrityCountRow = Record<
  'personSuggestions' | 'relSuggestions' | 'changeProposals' | 'reminders' | 'evidences',
  number | bigint | string
>;

function countValue(value: number | bigint | string | undefined): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('invalid Candidate migration integrity count');
  }
  return normalized;
}

function emptyReport(): CandidateMigrationReport {
  const bySource = SOURCE_KINDS.map((sourceKind) => ({
    sourceKind, sourceRows: 0, projectedRows: 0, invalidRows: 0,
  }));
  return {
    sourceRows: 0,
    projectedRows: 0,
    quarantinedCreatorRows: 0,
    invalidRows: [],
    bySource,
    byStatus: STATUS_ORDER.map((status) => ({ status, rows: 0 })),
    projectionChecksum: sha256('[]'),
  };
}

function isMissingTable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  if (error.code === 'P2021') return true;
  if (error.code !== 'P2010') return false;
  const detail = JSON.stringify('meta' in error ? error.meta : '');
  return /no such table:\s*Candidate|relation .*Candidate.*does not exist|42P01/i.test(detail);
}

function isMissingColumn(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2022';
}

export async function inspectCandidateMigration(
  db: CandidateReadClient,
): Promise<CandidateMigrationReport> {
  let tenants: Array<{ id: string }>;
  try {
    tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  } catch (error) {
    if (isMissingTable(error)) return emptyReport();
    throw error;
  }

  let integrityRows: CandidateIntegrityCountRow[];
  try {
    integrityRows = await db.$queryRawUnsafe<CandidateIntegrityCountRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM "PersonSuggestion") AS "personSuggestions",
        (SELECT COUNT(*) FROM "RelSuggestion") AS "relSuggestions",
        (SELECT COUNT(*) FROM "ChangeProposal") AS "changeProposals",
        (SELECT COUNT(*) FROM "Reminder") AS "reminders",
        (SELECT COUNT(*) FROM "EvidenceEvent"
          WHERE "status" = 'pending_review'
             OR "id" IN (
               SELECT "legacySourceId" FROM "Candidate"
               WHERE "legacySourceKind" = 'EvidenceEvent' AND "legacySourceId" IS NOT NULL
             )) AS "evidences"
    `);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    integrityRows = await db.$queryRawUnsafe<CandidateIntegrityCountRow[]>(`
      SELECT
        (SELECT COUNT(*) FROM "PersonSuggestion") AS "personSuggestions",
        (SELECT COUNT(*) FROM "RelSuggestion") AS "relSuggestions",
        (SELECT COUNT(*) FROM "ChangeProposal") AS "changeProposals",
        (SELECT COUNT(*) FROM "Reminder") AS "reminders",
        (SELECT COUNT(*) FROM "EvidenceEvent" WHERE "status" = 'pending_review') AS "evidences"
    `);
  }
  const integrity = integrityRows[0];
  if (!integrity) throw new Error('Candidate migration integrity count returned no row');
  const expectedBySource = new Map<LegacyCandidateSourceKind, number>([
    ['PersonSuggestion', countValue(integrity.personSuggestions)],
    ['RelSuggestion', countValue(integrity.relSuggestions)],
    ['ChangeProposal', countValue(integrity.changeProposals)],
    ['Reminder', countValue(integrity.reminders)],
    ['EvidenceEvent', countValue(integrity.evidences)],
  ]);

  const tenantReports: TenantCandidateMigrationProjection[] = [];
  for (const tenant of tenants) {
    tenantReports.push(await projectCandidateMigrationForTenant(db, tenant.id));
  }

  const projections = tenantReports.flatMap((row) => row.projections);
  const invalidRows = tenantReports.flatMap((row) => row.invalidRows);
  const bySource = SOURCE_KINDS.map((sourceKind) => {
    const sourceRows = tenantReports.reduce(
      (sum, report) => sum + (report.bySource.find((row) => row.sourceKind === sourceKind)?.sourceRows ?? 0),
      0,
    );
    const expectedRows = expectedBySource.get(sourceKind) ?? 0;
    if (sourceRows !== expectedRows) {
      throw new Error(
        `Candidate migration tenant coverage failed for ${sourceKind}: scoped=${sourceRows}, total=${expectedRows}`,
      );
    }
    const projectedRows = projections.filter((row) => row.legacySourceKind === sourceKind).length;
    const invalid = invalidRows.filter((row) => row.sourceKind === sourceKind).length;
    return { sourceKind, sourceRows, projectedRows, invalidRows: invalid };
  });
  const sourceRows = bySource.reduce((sum, row) => sum + row.sourceRows, 0);
  if (sourceRows !== projections.length + invalidRows.length) {
    throw new Error('Candidate migration aggregate count parity failed');
  }

  projections.sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId)
    || left.legacySourceKind.localeCompare(right.legacySourceKind)
    || left.legacySourceId.localeCompare(right.legacySourceId));
  invalidRows.sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId)
    || SOURCE_KINDS.indexOf(left.sourceKind) - SOURCE_KINDS.indexOf(right.sourceKind)
    || left.sourceId.localeCompare(right.sourceId));

  const checksumRows = projections.map((row) => ({
    accountId: row.accountId,
    confidence: row.confidence,
    createdByUserId: row.createdByUserId,
    dedupeKey: row.dedupeKey,
    fieldKey: row.fieldKey,
    id: row.id,
    kind: row.kind,
    legacySourceId: row.legacySourceId,
    legacySourceKind: row.legacySourceKind,
    matterId: row.matterId,
    source: row.source,
    sourceRef: row.sourceRef,
    status: row.status,
    targetId: row.targetId,
    targetKind: row.targetKind,
    tenantId: row.tenantId,
    visibility: row.visibility,
  }));

  return {
    sourceRows,
    projectedRows: projections.length,
    quarantinedCreatorRows: projections.filter((row) => row.visibility === 'owner_admin_only').length,
    invalidRows,
    bySource,
    byStatus: STATUS_ORDER.map((status) => ({
      status,
      rows: projections.filter((row) => row.status === status).length,
    })),
    projectionChecksum: sha256(canonicalCandidateJson(checksumRows)),
  };
}

function projectionKey(tenantId: string, sourceKind: string, sourceId: string): string {
  return `${tenantId}\u0000${sourceKind}\u0000${sourceId}`;
}

async function loadCandidateProjections(db: CandidateReadClient): Promise<CandidateProjection[]> {
  const tenants = await db.tenant.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
  const projections: CandidateProjection[] = [];
  for (const tenant of tenants) {
    const projected = await projectCandidateMigrationForTenant(db, tenant.id);
    projections.push(...projected.projections);
  }
  return projections.sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId)
    || SOURCE_KINDS.indexOf(left.legacySourceKind) - SOURCE_KINDS.indexOf(right.legacySourceKind)
    || left.legacySourceId.localeCompare(right.legacySourceId));
}

function candidateSemanticConflict(candidate: Candidate, projection: CandidateProjection): string | null {
  const comparable: Array<keyof CandidateProjection> = [
    'id', 'tenantId', 'kind', 'status', 'accountId', 'matterId', 'targetKind', 'targetId',
    'fieldKey', 'oldValue', 'newValue', 'payload', 'source', 'evidence',
    'legacySourceKind', 'legacySourceId',
  ];
  for (const field of comparable) {
    if (candidate[field as keyof Candidate] !== projection[field]) {
      return `candidate_semantic_conflict:${projection.legacySourceKind}:${projection.legacySourceId}:${field}`;
    }
  }
  // EvidenceEvent has no compatibility confidence column. Backfilled legacy rows
  // use the deterministic 0.5 projection; online Candidate producers may retain
  // their source confidence without weakening source/provenance/status parity.
  if ((projection.legacySourceKind !== 'EvidenceEvent' || candidate.sourceRef === projection.sourceRef)
    && candidate.confidence !== projection.confidence) {
    return `candidate_semantic_conflict:${projection.legacySourceKind}:${projection.legacySourceId}:confidence`;
  }
  if (candidate.createdAt.getTime() !== projection.createdAt.getTime()) {
    return `candidate_semantic_conflict:${projection.legacySourceKind}:${projection.legacySourceId}:createdAt`;
  }
  return null;
}

async function verifyCandidateMigrationWithReport(
  db: CandidateReadClient,
  report: CandidateMigrationReport,
): Promise<CandidateMigrationVerification> {
  const marker = await db.dataMigrationState.findUnique({
    where: { key: CANDIDATE_BACKFILL_MARKER },
    select: { key: true, details: true },
  });
  const conflicts = report.invalidRows.map((row) =>
    `candidate_source_invalid:${row.sourceKind}:${row.sourceId}:${row.reason}`);
  if (marker) {
    const markerConflict = candidateBackfillMarkerConflict(marker.details);
    if (markerConflict) conflicts.push(markerConflict);
  }
  const projections = await loadCandidateProjections(db);
  const projectedBySource = new Map(projections.map((row) => [
    projectionKey(row.tenantId, row.legacySourceKind, row.legacySourceId), row,
  ]));
  const candidates = await db.candidate.findMany({
    where: {
      legacySourceKind: { in: [...SOURCE_KINDS] },
      legacySourceId: { not: null },
    },
    orderBy: [{ tenantId: 'asc' }, { legacySourceKind: 'asc' }, { legacySourceId: 'asc' }],
  });
  const candidateBySource = new Map(candidates.map((row) => [
    projectionKey(row.tenantId, row.legacySourceKind!, row.legacySourceId!), row,
  ]));
  for (const projection of projections) {
    const candidate = candidateBySource.get(
      projectionKey(projection.tenantId, projection.legacySourceKind, projection.legacySourceId),
    );
    if (!candidate) {
      conflicts.push(`candidate_missing:${projection.legacySourceKind}:${projection.legacySourceId}`);
      continue;
    }
    const conflict = candidateSemanticConflict(candidate, projection);
    if (conflict) conflicts.push(conflict);
  }
  for (const candidate of candidates) {
    const key = projectionKey(candidate.tenantId, candidate.legacySourceKind!, candidate.legacySourceId!);
    if (!projectedBySource.has(key)) {
      conflicts.push(`candidate_source_missing:${candidate.legacySourceKind}:${candidate.legacySourceId}`);
    }
  }
  return {
    ok: !!marker
      && conflicts.length === 0
      && report.invalidRows.length === 0
      && report.sourceRows === report.projectedRows
      && projections.length === candidates.length,
    markerPresent: !!marker,
    conflicts,
    report,
  };
}

export async function verifyCandidateMigration(
  db: CandidateReadClient,
): Promise<CandidateMigrationVerification> {
  const report = await inspectCandidateMigration(db);
  return verifyCandidateMigrationWithReport(db, report);
}

function migrationFailure(conflicts: readonly string[]): Error {
  return new Error(conflicts.length ? conflicts.join('\n') : 'candidate_migration_verification_failed');
}

export async function applyCandidateMigration(
  db: PrismaClient,
): Promise<CandidateMigrationApplyResult> {
  return db.$transaction(async (tx) => {
    const report = await inspectCandidateMigration(tx);
    if (report.invalidRows.length || report.sourceRows !== report.projectedRows) {
      throw migrationFailure(report.invalidRows.map((row) =>
        `candidate_source_invalid:${row.sourceKind}:${row.sourceId}:${row.reason}`));
    }
    const marker = await tx.dataMigrationState.findUnique({
      where: { key: CANDIDATE_BACKFILL_MARKER },
      select: { key: true },
    });
    if (marker) {
      const verification = await verifyCandidateMigrationWithReport(tx, report);
      if (!verification.ok) throw migrationFailure(verification.conflicts);
      return { ...verification, writes: 0 };
    }

    const projections = await loadCandidateProjections(tx);
    let writes = 0;
    for (const projection of projections) {
      const linked = await tx.candidate.findUnique({
        where: {
          tenantId_legacySourceKind_legacySourceId: {
            tenantId: projection.tenantId,
            legacySourceKind: projection.legacySourceKind,
            legacySourceId: projection.legacySourceId,
          },
        },
      });
      if (linked) {
        const normalized = linked.createdAt.getTime() === projection.createdAt.getTime()
          ? linked
          : await tx.candidate.update({
            where: { id: linked.id },
            data: { createdAt: projection.createdAt },
          });
        const conflict = candidateSemanticConflict(normalized, projection);
        if (conflict) throw migrationFailure([conflict]);
        if (normalized !== linked) writes += 1;
        continue;
      }

      const identityCollision = await tx.candidate.findFirst({
        where: {
          tenantId: projection.tenantId,
          OR: [
            { id: projection.id },
            { dedupeKey: projection.dedupeKey },
          ],
        },
      });
      if (identityCollision) {
        throw migrationFailure([
          `candidate_semantic_conflict:${projection.legacySourceKind}:${projection.legacySourceId}:identity`,
        ]);
      }
      await tx.candidate.create({ data: projection });
      writes += 1;
    }

    await tx.dataMigrationState.create({ data: {
      key: CANDIDATE_BACKFILL_MARKER,
      details: candidateBackfillMarkerDetails(report),
    } });
    const verification = await verifyCandidateMigrationWithReport(tx, report);
    if (!verification.ok) throw migrationFailure(verification.conflicts);
    return { ...verification, writes };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 120_000,
  });
}

const CANDIDATE_COLUMNS = new Map<string, { type: string; required: boolean }>([
  ['id', { type: 'TEXT', required: true }],
  ['tenantId', { type: 'TEXT', required: true }],
  ['kind', { type: 'TEXT', required: true }],
  ['status', { type: 'TEXT', required: true }],
  ['accountId', { type: 'TEXT', required: true }],
  ['matterId', { type: 'TEXT', required: false }],
  ['targetKind', { type: 'TEXT', required: true }],
  ['targetId', { type: 'TEXT', required: false }],
  ['fieldKey', { type: 'TEXT', required: false }],
  ['oldValue', { type: 'TEXT', required: false }],
  ['newValue', { type: 'TEXT', required: false }],
  ['payload', { type: 'TEXT', required: true }],
  ['source', { type: 'TEXT', required: true }],
  ['sourceRef', { type: 'TEXT', required: true }],
  ['evidence', { type: 'TEXT', required: true }],
  ['confidence', { type: 'REAL', required: true }],
  ['sourceArtifactId', { type: 'TEXT', required: false }],
  ['reviewBatchId', { type: 'TEXT', required: false }],
  ['createdByUserId', { type: 'TEXT', required: false }],
  ['visibility', { type: 'TEXT', required: true }],
  ['dedupeKey', { type: 'TEXT', required: true }],
  ['legacySourceKind', { type: 'TEXT', required: false }],
  ['legacySourceId', { type: 'TEXT', required: false }],
  ['version', { type: 'INTEGER', required: true }],
  ['createdAt', { type: 'DATETIME', required: true }],
  ['updatedAt', { type: 'DATETIME', required: true }],
]);

const CANDIDATE_INDEXES = new Set([
  'Candidate_tenantId_status_createdAt_idx',
  'Candidate_tenantId_accountId_status_createdAt_idx',
  'Candidate_tenantId_matterId_status_createdAt_idx',
  'Candidate_tenantId_sourceArtifactId_idx',
  'Candidate_tenantId_reviewBatchId_idx',
  'Candidate_tenantId_createdByUserId_visibility_idx',
  'Candidate_tenantId_dedupeKey_key',
  'Candidate_tenantId_legacySourceKind_legacySourceId_key',
]);

export async function inspectCandidateSchemaState(db: Pick<CandidateReadClient, '$queryRawUnsafe'>): Promise<CandidateSchemaState> {
  const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Tenant', 'Candidate')`,
  );
  const tableNames = new Set(tables.map((row) => row.name));
  if (!tableNames.has('Tenant') && !tableNames.has('Candidate')) return 'uninitialized';
  if (!tableNames.has('Candidate')) return tableNames.has('Tenant') ? 'legacy' : 'partial';
  if (!tableNames.has('Tenant')) return 'partial';

  const columns = await db.$queryRawUnsafe<Array<{
    name: string; type: string; notnull: number; pk: number;
  }>>('PRAGMA table_info("Candidate")');
  if (columns.length !== CANDIDATE_COLUMNS.size) return 'partial';
  for (const column of columns) {
    const expected = CANDIDATE_COLUMNS.get(column.name);
    if (!expected || column.type.toUpperCase() !== expected.type) return 'partial';
    if (Number(column.notnull) !== (expected.required ? 1 : 0)) return 'partial';
    if (column.name === 'id' && Number(column.pk) !== 1) return 'partial';
  }

  const indexes = await db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("Candidate")');
  const namedIndexes = indexes.map((row) => row.name).filter((name) => !name.startsWith('sqlite_autoindex_'));
  if (namedIndexes.length !== CANDIDATE_INDEXES.size
    || namedIndexes.some((name) => !CANDIDATE_INDEXES.has(name))) return 'partial';

  const foreignKeys = await db.$queryRawUnsafe<Array<{
    table: string; from: string; to: string; on_update: string; on_delete: string;
  }>>('PRAGMA foreign_key_list("Candidate")');
  if (foreignKeys.length !== 1) return 'partial';
  const tenantForeignKey = foreignKeys[0];
  if (!tenantForeignKey
    || tenantForeignKey.table !== 'Tenant'
    || tenantForeignKey.from !== 'tenantId'
    || tenantForeignKey.to !== 'id'
    || tenantForeignKey.on_update.toUpperCase() !== 'CASCADE'
    || tenantForeignKey.on_delete.toUpperCase() !== 'CASCADE') return 'partial';
  return 'expanded';
}
