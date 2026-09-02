import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type Candidate,
  type ChangeProposal,
  type EvidenceEvent,
  type PrismaClient,
  type Reminder,
} from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  requireAccount,
  requireOpportunity,
  requirePerson,
  ScopedNotFoundError,
} from '../mutation/scopeGuards.js';
import {
  candidateIdentityForLegacy,
  canonicalCandidateJson,
} from './migration.js';
import { CandidateWriteConflictError } from './personRelation.js';
import {
  candidateDedupeKeyForCreator,
  evidenceCandidateDedupeKey,
  fieldCandidateDedupeKey,
  reminderCandidateDedupeKey,
} from './dedupe.js';
export { fieldCandidateDedupeKey } from './dedupe.js';
import {
  candidateDescriptor,
  requireCandidateProducerAccess,
  requireCandidateReviewAccess,
  type CandidateReviewAccessContext,
} from '../sensitiveAccess.js';
import { personIdForReviewCandidate } from '../reviewBatches/model.js';

type CandidateTx = Prisma.TransactionClient;
const FIELD_SOURCE_KIND = 'ChangeProposal' as const;
const REMINDER_SOURCE_KIND = 'Reminder' as const;
const EVIDENCE_SOURCE_KIND = 'EvidenceEvent' as const;
const ROOT_TRANSACTION_ATTEMPTS = 3;

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

async function inTransaction<T>(db: DbClient, work: (tx: CandidateTx) => Promise<T>): Promise<T> {
  if (!isRootClient(db)) return work(db as CandidateTx);
  for (let attempt = 1; attempt <= ROOT_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 30_000,
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if ((code !== 'P2002' && code !== 'P2034') || attempt === ROOT_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw new CandidateWriteConflictError();
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CandidateWriteConflictError(`${field} 不能为空`);
  return normalized;
}

function validConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CandidateWriteConflictError('confidence 必须在 0..1');
  }
  return value;
}

function terminalDedupeKey(candidateId: string): string {
  return `terminal-v1:${candidateId}`;
}

function isScopedNotFound(error: unknown): boolean {
  return error instanceof ScopedNotFoundError
    || Boolean(error && typeof error === 'object' && 'scopedNotFound' in error
      && (error as { scopedNotFound?: boolean }).scopedNotFound);
}

async function creatorScope(
  tx: CandidateTx,
  tenantId: string,
  createdByUserId: string | null,
): Promise<{ createdByUserId: string | null; visibility: 'private' | 'owner_admin_only' }> {
  if (!createdByUserId) return { createdByUserId: null, visibility: 'owner_admin_only' };
  const user = await tx.user.findFirst({ where: { id: createdByUserId, tenantId }, select: { id: true } });
  return user
    ? { createdByUserId: user.id, visibility: 'private' }
    : { createdByUserId: null, visibility: 'owner_admin_only' };
}

async function requireMatterAccount(
  tx: CandidateTx,
  tenantId: string,
  accountId: string,
  matterId: string | null,
): Promise<void> {
  await requireAccount(tx, tenantId, accountId);
  if (matterId) await requireOpportunity(tx, tenantId, accountId, matterId);
}

async function findLinkedCandidate(
  tx: CandidateTx,
  tenantId: string,
  sourceKind: typeof FIELD_SOURCE_KIND | typeof REMINDER_SOURCE_KIND | typeof EVIDENCE_SOURCE_KIND,
  sourceId: string,
): Promise<Candidate | null> {
  return tx.candidate.findUnique({ where: {
    tenantId_legacySourceKind_legacySourceId: {
      tenantId, legacySourceKind: sourceKind, legacySourceId: sourceId,
    },
  } });
}

const candidateAccessSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  targetKind: true,
  targetId: true,
  fieldKey: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  dedupeKey: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
  sourceRef: true,
  payload: true,
} as const;
type CandidateAccessMetadata = Prisma.CandidateGetPayload<{ select: typeof candidateAccessSelect }>;

function assertLinkedCandidate(candidate: Candidate, expected: {
  tenantId: string;
  kind: 'field_change' | 'reminder' | 'evidence_create';
  accountId: string;
  matterId: string | null;
  sourceKind: typeof FIELD_SOURCE_KIND | typeof REMINDER_SOURCE_KIND | typeof EVIDENCE_SOURCE_KIND;
  sourceId: string;
}): void {
  if (candidate.tenantId !== expected.tenantId
    || candidate.kind !== expected.kind
    || candidate.accountId !== expected.accountId
    || candidate.matterId !== expected.matterId
    || candidate.legacySourceKind !== expected.sourceKind
    || candidate.legacySourceId !== expected.sourceId) {
    throw new CandidateWriteConflictError();
  }
}

function fieldPayload(row: ChangeProposal): string {
  return canonicalCandidateJson({ legacyDedupeKey: row.dedupeKey, legacyStatus: row.status });
}

async function validateFieldParent(tx: CandidateTx, row: Pick<
  ChangeProposal,
  'tenantId' | 'accountId' | 'opportunityId' | 'entityKind' | 'entityId'
>): Promise<void> {
  await requireMatterAccount(tx, row.tenantId, row.accountId, row.opportunityId);
  if (row.entityKind === 'customer') {
    if (row.entityId !== row.accountId) throw new ScopedNotFoundError();
    return;
  }
  if (row.entityKind === 'matter') {
    if (!row.opportunityId || row.entityId !== row.opportunityId) throw new ScopedNotFoundError();
    return;
  }
  if (row.entityKind === 'person' || row.entityKind === 'personLog') {
    await requirePerson(tx, row.tenantId, row.accountId, row.entityId);
    return;
  }
  if (row.entityKind === 'oppRole') {
    if (!row.opportunityId) throw new ScopedNotFoundError();
    await requirePerson(tx, row.tenantId, row.accountId, row.entityId);
    return;
  }
  if (row.entityKind === 'opportunity') {
    if (!row.opportunityId || row.entityId !== row.opportunityId) throw new ScopedNotFoundError();
    return;
  }
  if (row.entityKind === 'bi') {
    if (!row.opportunityId) throw new ScopedNotFoundError();
    const target = await tx.burningIssue.findFirst({ where: {
      id: row.entityId, tenantId: row.tenantId, opportunityId: row.opportunityId,
      opportunity: { accountId: row.accountId, archivedAt: null, account: { archivedAt: null } },
    }, select: { id: true } });
    if (!target) throw new ScopedNotFoundError();
    return;
  }
  if (row.entityKind === 'ucv') {
    if (!row.opportunityId) throw new ScopedNotFoundError();
    const target = await tx.uCV.findFirst({ where: {
      id: row.entityId, tenantId: row.tenantId, opportunityId: row.opportunityId,
      opportunity: { accountId: row.accountId, archivedAt: null, account: { archivedAt: null } },
    }, select: { id: true } });
    if (!target) throw new ScopedNotFoundError();
    return;
  }
  throw new ScopedNotFoundError();
}

async function createCandidateForField(
  tx: CandidateTx,
  row: ChangeProposal,
  metadata?: { sourceRef: string; dedupeKey: string; createdByUserId: string | null; visibility: string },
): Promise<Candidate> {
  await validateFieldParent(tx, row);
  const identity = candidateIdentityForLegacy(row.tenantId, FIELD_SOURCE_KIND, row.id);
  const legacyScope = metadata ? null : await creatorScope(tx, row.tenantId, row.proposedBy || null);
  const scope = metadata ?? {
    sourceRef: identity.sourceRef,
    dedupeKey: candidateDedupeKeyForCreator(identity.dedupeKey, legacyScope!.createdByUserId),
    ...legacyScope!,
  };
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'field_change',
    status: row.status === 'pending' ? 'pending' : row.status === 'accepted' ? 'accepted' : 'rejected',
    accountId: row.accountId,
    matterId: row.opportunityId,
    targetKind: row.entityKind,
    targetId: row.entityId,
    fieldKey: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    payload: fieldPayload(row),
    source: row.origin,
    sourceRef: scope.sourceRef,
    evidence: row.evidence,
    confidence: row.confidence,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
    dedupeKey: scope.dedupeKey,
    legacySourceKind: FIELD_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function ensureFieldCandidate(tx: CandidateTx, row: ChangeProposal): Promise<Candidate> {
  await validateFieldParent(tx, row);
  const candidate = await findLinkedCandidate(tx, row.tenantId, FIELD_SOURCE_KIND, row.id);
  if (!candidate) return createCandidateForField(tx, row);
  assertLinkedCandidate(candidate, {
    tenantId: row.tenantId, kind: 'field_change', accountId: row.accountId,
    matterId: row.opportunityId, sourceKind: FIELD_SOURCE_KIND, sourceId: row.id,
  });
  const expectedStatus = row.status === 'pending' || row.status === 'applying'
    ? 'pending' : row.status === 'accepted' ? 'accepted' : 'rejected';
  if (candidate.status !== expectedStatus
    || candidate.targetKind !== row.entityKind
    || candidate.targetId !== row.entityId
    || candidate.fieldKey !== row.field
    || candidate.oldValue !== row.oldValue
    || candidate.newValue !== row.newValue
    || candidate.payload !== fieldPayload(row)
    || candidate.source !== row.origin
    || candidate.evidence !== row.evidence
    || candidate.confidence !== row.confidence) {
    throw new CandidateWriteConflictError();
  }
  return candidate;
}

export interface CreateFieldCandidateInput {
  id: string;
  tenantId: string;
  accountId: string;
  matterId?: string | null;
  targetKind: string;
  targetId: string;
  fieldKey: string;
  oldValue: string;
  newValue: string;
  source: string;
  sourceRef: string;
  evidence: string;
  confidence: number;
  createdByUserId: string | null;
  /** Optional producer-owned semantic identity for an immutable source/run item. */
  dedupeKey?: string;
}

export interface FieldCandidateReceipt {
  row: ChangeProposal;
  candidateId: string;
  candidateVersion: number;
  created: boolean;
}

export async function createFieldCandidate(
  db: DbClient,
  input: CreateFieldCandidateInput,
): Promise<FieldCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    requiredText(input.id, 'id');
    requiredText(input.targetKind, 'targetKind');
    requiredText(input.targetId, 'targetId');
    requiredText(input.fieldKey, 'fieldKey');
    requiredText(input.source, 'source');
    requiredText(input.sourceRef, 'sourceRef');
    requiredText(input.evidence, 'evidence');
    validConfidence(input.confidence);
    const matterId = input.matterId ?? null;
    const semanticKey = input.dedupeKey
      ? requiredText(input.dedupeKey, 'dedupeKey')
      : fieldCandidateDedupeKey(input);
    const parent = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      opportunityId: matterId,
      entityKind: input.targetKind,
      entityId: input.targetId,
    };
    await validateFieldParent(tx, parent);
    const scope = await creatorScope(tx, input.tenantId, input.createdByUserId);
    const dedupeKey = candidateDedupeKeyForCreator(semanticKey, scope.createdByUserId);
    await requireCandidateProducerAccess(tx, candidateDescriptor({
      id: input.id,
      tenantId: input.tenantId,
      accountId: input.accountId,
      matterId,
      createdByUserId: scope.createdByUserId,
      visibility: scope.visibility,
      aclVersion: 1,
    }), input.createdByUserId);
    const linked = await tx.candidate.findUnique({
      where: {
        tenantId_legacySourceKind_legacySourceId: {
          tenantId: input.tenantId,
          legacySourceKind: FIELD_SOURCE_KIND,
          legacySourceId: input.id,
        },
      },
      select: candidateAccessSelect,
    });
    const existingMetadata = linked ?? await tx.candidate.findUnique({
      where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
      select: candidateAccessSelect,
    });
    if (existingMetadata) {
      try {
        await requireCandidateProducerAccess(tx, candidateDescriptor(existingMetadata), input.createdByUserId);
      } catch {
        throw new CandidateWriteConflictError();
      }
      if (existingMetadata.legacySourceKind !== FIELD_SOURCE_KIND || !existingMetadata.legacySourceId) {
        throw new CandidateWriteConflictError();
      }
      const existing = await tx.changeProposal.findFirst({ where: {
        id: existingMetadata.legacySourceId,
        tenantId: input.tenantId,
        accountId: input.accountId,
        opportunityId: matterId,
        entityKind: input.targetKind,
        entityId: input.targetId,
        field: input.fieldKey,
        status: 'pending',
      } });
      if (!existing) throw new CandidateWriteConflictError();
      const candidate = await ensureFieldCandidate(tx, existing);
      if (candidate.status !== 'pending' || candidate.id !== existingMetadata.id) {
        throw new CandidateWriteConflictError();
      }
      const changed = await tx.changeProposal.updateMany({
        where: { id: existing.id, tenantId: input.tenantId, status: 'pending' },
        data: {
          opportunityId: matterId,
          oldValue: input.oldValue,
          newValue: input.newValue,
          origin: input.source,
          evidence: input.evidence,
          confidence: input.confidence,
          proposedBy: input.createdByUserId ?? '',
          dedupeKey,
        },
      });
      if (changed.count !== 1) throw new CandidateWriteConflictError();
      const row = await tx.changeProposal.findUniqueOrThrow({ where: { id: existing.id } });
      const updated = await tx.candidate.updateMany({
        where: {
          id: candidate.id,
          tenantId: input.tenantId,
          status: 'pending',
          version: candidate.version,
          aclVersion: candidate.aclVersion,
        },
        data: {
          oldValue: input.oldValue,
          newValue: input.newValue,
          payload: fieldPayload(row),
          source: input.source,
          sourceRef: input.sourceRef,
          evidence: input.evidence,
          confidence: input.confidence,
          dedupeKey,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new CandidateWriteConflictError();
      return { row, candidateId: candidate.id, candidateVersion: candidate.version + 1, created: false };
    }
    const row = await tx.changeProposal.create({ data: {
      id: input.id,
      tenantId: input.tenantId,
      accountId: input.accountId,
      opportunityId: matterId,
      entityKind: input.targetKind,
      entityId: input.targetId,
      field: input.fieldKey,
      oldValue: input.oldValue,
      newValue: input.newValue,
      origin: input.source,
      evidence: input.evidence,
      confidence: input.confidence,
      status: 'pending',
      dedupeKey,
      proposedBy: input.createdByUserId ?? '',
    } });
    const candidate = await createCandidateForField(tx, row, {
      sourceRef: input.sourceRef, dedupeKey, ...scope,
    });
    return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: true };
  });
}

export async function rejectFieldCandidate(
  db: DbClient,
  input: { tenantId: string; id: string; review: CandidateReviewAccessContext },
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    try {
      await requireCandidateReviewAccess(tx, input.tenantId, FIELD_SOURCE_KIND, input.id, input.review);
    } catch (error) {
      if (isScopedNotFound(error)) return false;
      throw error;
    }
    const row = await tx.changeProposal.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending') return false;
    const candidate = await ensureFieldCandidate(tx, row);
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const changed = await tx.changeProposal.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: 'pending' },
      data: { status: 'rejected', dedupeKey: null },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const rejectedRow = await tx.changeProposal.findUniqueOrThrow({ where: { id: row.id } });
    const rejected = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'rejected',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: fieldPayload(rejectedRow),
        version: { increment: 1 },
      },
    });
    if (rejected.count !== 1) throw new CandidateWriteConflictError();
    return true;
  });
}

export async function claimFieldCandidate(
  db: DbClient,
  input: { tenantId: string; id: string; review: CandidateReviewAccessContext },
): Promise<{ row: ChangeProposal; candidateVersion: number } | null> {
  return inTransaction(db, async (tx) => {
    await requireCandidateReviewAccess(tx, input.tenantId, FIELD_SOURCE_KIND, input.id, input.review);
    const row = await tx.changeProposal.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending') return null;
    const candidate = await ensureFieldCandidate(tx, row);
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const claimedCandidate = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: { version: { increment: 1 } },
    });
    if (claimedCandidate.count !== 1) throw new CandidateWriteConflictError();
    const claimedProjection = await tx.changeProposal.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: 'pending' },
      data: { status: 'applying' },
    });
    if (claimedProjection.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: await tx.changeProposal.findUniqueOrThrow({ where: { id: row.id } }),
      candidateVersion: candidate.version + 1,
    };
  });
}

export async function finalizeFieldCandidate(
  db: DbClient,
  input: { tenantId: string; id: string; expectedVersion: number; newValue: string },
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const row = await tx.changeProposal.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'applying') throw new CandidateWriteConflictError();
    const candidate = await findLinkedCandidate(tx, input.tenantId, FIELD_SOURCE_KIND, row.id);
    if (!candidate) throw new CandidateWriteConflictError();
    assertLinkedCandidate(candidate, {
      tenantId: row.tenantId, kind: 'field_change', accountId: row.accountId,
      matterId: row.opportunityId, sourceKind: FIELD_SOURCE_KIND, sourceId: row.id,
    });
    if (candidate.status !== 'pending' || candidate.version !== input.expectedVersion) {
      throw new CandidateWriteConflictError();
    }
    const finalizedProjection = await tx.changeProposal.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: 'applying' },
      data: { status: 'accepted', newValue: input.newValue, dedupeKey: null },
    });
    if (finalizedProjection.count !== 1) throw new CandidateWriteConflictError();
    const accepted = await tx.changeProposal.findUniqueOrThrow({ where: { id: row.id } });
    const finalizedCandidate = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId,
        status: 'pending', version: input.expectedVersion, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'accepted',
        newValue: input.newValue,
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: fieldPayload(accepted),
        version: { increment: 1 },
      },
    });
    if (finalizedCandidate.count !== 1) throw new CandidateWriteConflictError();
  });
}

function reminderPayload(row: Reminder): string {
  return canonicalCandidateJson({
    accountName: row.accountName,
    detail: row.detail,
    legacyDedupeKey: row.dedupeKey,
    legacyStatus: row.status,
    reminderKind: row.kind,
    severity: row.severity,
    title: row.title,
  });
}

async function reminderTarget(tx: CandidateTx, row: Pick<
  Reminder,
  'tenantId' | 'accountId' | 'opportunityId' | 'kind' | 'entityId'
>): Promise<{ kind: 'person' | 'matter' | 'commitment'; id: string }> {
  await requireMatterAccount(tx, row.tenantId, row.accountId, row.opportunityId);
  if (row.kind === 'sentiment_recheck' || row.kind === 'form_empty') {
    if (!row.entityId) throw new ScopedNotFoundError();
    await requirePerson(tx, row.tenantId, row.accountId, row.entityId);
    return { kind: 'person', id: row.entityId };
  }
  if (row.kind === 'action_overdue' || row.kind === 'confirmation_due' || row.kind === 'commitment_due') {
    if (!row.entityId) throw new ScopedNotFoundError();
    const commitment = await tx.planAction.findFirst({ where: {
      id: row.entityId, tenantId: row.tenantId, accountId: row.accountId,
      ...(row.opportunityId ? { opportunityId: row.opportunityId } : {}),
      archivedAt: null,
    }, select: { id: true } });
    if (!commitment) throw new ScopedNotFoundError();
    return { kind: 'commitment', id: commitment.id };
  }
  if (row.kind === 'matter_without_next_commitment') {
    if (!row.opportunityId || row.entityId !== row.opportunityId) throw new ScopedNotFoundError();
    return { kind: 'matter', id: row.opportunityId };
  }
  if (row.kind === 'stalled' || row.kind === 'no_decider') {
    if (!row.opportunityId || row.entityId) throw new ScopedNotFoundError();
    return { kind: 'matter', id: row.opportunityId };
  }
  throw new ScopedNotFoundError();
}

async function createCandidateForReminder(tx: CandidateTx, row: Reminder): Promise<Candidate> {
  const target = await reminderTarget(tx, row);
  const identity = candidateIdentityForLegacy(row.tenantId, REMINDER_SOURCE_KIND, row.id);
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'reminder',
    status: row.status === 'pending' ? 'pending' : row.status === 'done' ? 'accepted' : 'rejected',
    accountId: row.accountId,
    matterId: row.opportunityId,
    targetKind: target.kind,
    targetId: target.id,
    payload: reminderPayload(row),
    source: 'rules',
    sourceRef: `patrol:${row.dedupeKey}`,
    evidence: row.detail || '确定性巡检提醒，必须由人工处理',
    confidence: 1,
    createdByUserId: null,
    visibility: 'owner_admin_only',
    aclVersion: 1,
    dedupeKey: row.status === 'pending' ? reminderCandidateDedupeKey(row.dedupeKey) : terminalDedupeKey(identity.id),
    legacySourceKind: REMINDER_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function ensureReminderCandidate(tx: CandidateTx, row: Reminder): Promise<Candidate> {
  const target = await reminderTarget(tx, row);
  const candidate = await findLinkedCandidate(tx, row.tenantId, REMINDER_SOURCE_KIND, row.id);
  if (!candidate) return createCandidateForReminder(tx, row);
  assertLinkedCandidate(candidate, {
    tenantId: row.tenantId, kind: 'reminder', accountId: row.accountId,
    matterId: row.opportunityId, sourceKind: REMINDER_SOURCE_KIND, sourceId: row.id,
  });
  const expectedStatus = row.status === 'pending' ? 'pending' : row.status === 'done' ? 'accepted' : 'rejected';
  const legacyIdentity = candidateIdentityForLegacy(row.tenantId, REMINDER_SOURCE_KIND, row.id);
  const legacyEmptyEvidence = !row.detail
    && candidate.sourceRef === legacyIdentity.sourceRef
    && candidate.evidence === '';
  if (candidate.status !== expectedStatus
    || candidate.targetKind !== target.kind
    || candidate.targetId !== target.id
    || candidate.payload !== reminderPayload(row)
    || candidate.source !== 'rules'
    || (candidate.evidence !== (row.detail || '确定性巡检提醒，必须由人工处理')
      && !legacyEmptyEvidence)
    || candidate.confidence !== 1) {
    throw new CandidateWriteConflictError();
  }
  return candidate;
}

export interface UpsertReminderCandidateInput {
  id?: string;
  tenantId: string;
  accountId: string;
  accountName: string;
  matterId: string | null;
  matterName: string;
  kind: string;
  title: string;
  detail: string;
  severity: string;
  targetId: string | null;
  dedupeKey: string;
}

export interface ReminderCandidateReceipt {
  row: Reminder;
  candidateId: string;
  candidateVersion: number;
  created: boolean;
}

export async function upsertReminderCandidate(
  db: DbClient,
  input: UpsertReminderCandidateInput,
): Promise<ReminderCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    requiredText(input.dedupeKey, 'dedupeKey');
    requiredText(input.title, 'title');
    const draft = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      opportunityId: input.matterId,
      kind: input.kind,
      entityId: input.targetId,
    };
    await reminderTarget(tx, draft);
    await requireCandidateProducerAccess(tx, candidateDescriptor({
      id: input.id ?? `reminder:${input.dedupeKey}`,
      tenantId: input.tenantId,
      accountId: input.accountId,
      matterId: input.matterId,
      createdByUserId: null,
      visibility: 'owner_admin_only',
      aclVersion: 1,
    }), null);
    const existingRef = await tx.reminder.findUnique({ where: {
      tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey: input.dedupeKey },
    }, select: { id: true } });
    if (existingRef) {
      const existingMetadata = await tx.candidate.findUnique({
        where: {
          tenantId_legacySourceKind_legacySourceId: {
            tenantId: input.tenantId,
            legacySourceKind: REMINDER_SOURCE_KIND,
            legacySourceId: existingRef.id,
          },
        },
        select: candidateAccessSelect,
      });
      if (!existingMetadata) throw new CandidateWriteConflictError();
      try {
        await requireCandidateProducerAccess(tx, candidateDescriptor(existingMetadata), null);
      } catch {
        throw new CandidateWriteConflictError();
      }
      const existing = await tx.reminder.findFirst({ where: {
        id: existingRef.id,
        tenantId: input.tenantId,
      } });
      if (!existing) throw new CandidateWriteConflictError();
      if (existing.accountId !== input.accountId
        || existing.opportunityId !== input.matterId
        || existing.kind !== input.kind
        || existing.entityId !== input.targetId) {
        throw new CandidateWriteConflictError();
      }
      const candidate = await ensureReminderCandidate(tx, existing);
      if (candidate.id !== existingMetadata.id) throw new CandidateWriteConflictError();
      if (existing.status !== 'pending') {
        return { row: existing, candidateId: candidate.id, candidateVersion: candidate.version, created: false };
      }
      if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
      const changed = await tx.reminder.updateMany({
        where: { id: existing.id, tenantId: input.tenantId, status: 'pending' },
        data: {
          accountId: input.accountId,
          accountName: input.accountName,
          opportunityId: input.matterId,
          oppName: input.matterName,
          kind: input.kind,
          title: input.title,
          detail: input.detail,
          severity: input.severity,
          entityId: input.targetId,
        },
      });
      if (changed.count !== 1) throw new CandidateWriteConflictError();
      const row = await tx.reminder.findUniqueOrThrow({ where: { id: existing.id } });
      const target = await reminderTarget(tx, row);
      const updated = await tx.candidate.updateMany({
        where: {
          id: candidate.id,
          tenantId: input.tenantId,
          status: 'pending',
          version: candidate.version,
          aclVersion: candidate.aclVersion,
        },
        data: {
          accountId: row.accountId,
          matterId: row.opportunityId,
          targetKind: target.kind,
          targetId: target.id,
          payload: reminderPayload(row),
          evidence: row.detail || '确定性巡检提醒，必须由人工处理',
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new CandidateWriteConflictError();
      return { row, candidateId: candidate.id, candidateVersion: candidate.version + 1, created: false };
    }
    const row = await tx.reminder.create({ data: {
      id: input.id ?? `rem_${randomUUID().replaceAll('-', '')}`,
      tenantId: input.tenantId,
      accountId: input.accountId,
      accountName: input.accountName,
      opportunityId: input.matterId,
      oppName: input.matterName,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      severity: input.severity,
      entityId: input.targetId,
      dedupeKey: input.dedupeKey,
      status: 'pending',
    } });
    const candidate = await createCandidateForReminder(tx, row);
    return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: true };
  });
}

async function terminateReminderCandidate(
  db: DbClient,
  input: { tenantId: string; id: string; review?: CandidateReviewAccessContext },
  decision: 'dismissed' | 'done',
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    let systemMetadata: CandidateAccessMetadata | null = null;
    if (decision === 'dismissed') {
      if (!input.review) throw new ScopedNotFoundError();
      try {
        await requireCandidateReviewAccess(tx, input.tenantId, REMINDER_SOURCE_KIND, input.id, input.review);
      } catch (error) {
        if (isScopedNotFound(error)) return false;
        throw error;
      }
    } else {
      systemMetadata = await tx.candidate.findUnique({
        where: {
          tenantId_legacySourceKind_legacySourceId: {
            tenantId: input.tenantId,
            legacySourceKind: REMINDER_SOURCE_KIND,
            legacySourceId: input.id,
          },
        },
        select: candidateAccessSelect,
      });
      if (!systemMetadata) return false;
      try {
        await requireCandidateProducerAccess(tx, candidateDescriptor(systemMetadata), null);
      } catch {
        return false;
      }
    }
    const row = await tx.reminder.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending') return false;
    const candidate = await ensureReminderCandidate(tx, row);
    if (systemMetadata && candidate.id !== systemMetadata.id) throw new CandidateWriteConflictError();
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const changed = await tx.reminder.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: 'pending' },
      data: { status: decision },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const terminalRow = await tx.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const terminal = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: decision === 'done' ? 'accepted' : 'rejected',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: reminderPayload(terminalRow),
        version: { increment: 1 },
      },
    });
    if (terminal.count !== 1) throw new CandidateWriteConflictError();
    return true;
  });
}

export async function dismissReminderCandidate(
  db: DbClient,
  input: { tenantId: string; id: string; review: CandidateReviewAccessContext },
): Promise<boolean> {
  return terminateReminderCandidate(db, input, 'dismissed');
}

export async function resolveReminderCandidate(
  db: DbClient,
  input: { tenantId: string; id: string },
): Promise<boolean> {
  return terminateReminderCandidate(db, input, 'done');
}

function evidencePayload(row: EvidenceEvent, pendingPersonCandidateId: string | null = null): string {
  return canonicalCandidateJson({
    direction: row.direction,
    legacyStatus: row.status,
    occurredAt: row.occurredAt,
    ...(pendingPersonCandidateId ? { pendingPersonCandidateId } : {}),
    signalKey: row.signalKey,
    tier: row.tier,
  });
}

async function validateEvidenceParent(tx: CandidateTx, row: Pick<
  EvidenceEvent,
  'tenantId' | 'accountId' | 'opportunityId' | 'personId'
>, pendingPersonCandidateId: string | null = null): Promise<void> {
  await requireOpportunity(tx, row.tenantId, row.accountId, row.opportunityId);
  const person = await tx.person.findFirst({ where: {
    id: row.personId,
    tenantId: row.tenantId,
    accountId: row.accountId,
    archivedAt: null,
    mergedIntoPersonId: null,
  }, select: { id: true } });
  if (person) return;
  if (!pendingPersonCandidateId
    || personIdForReviewCandidate(row.tenantId, pendingPersonCandidateId) !== row.personId) {
    throw new ScopedNotFoundError();
  }
  const pending = await tx.candidate.findFirst({ where: {
    id: pendingPersonCandidateId,
    tenantId: row.tenantId,
    accountId: row.accountId,
    matterId: row.opportunityId,
    kind: 'person_create',
    status: 'pending',
  }, select: { id: true } });
  if (!pending) throw new ScopedNotFoundError();
}

function pendingEvidencePersonCandidate(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as { pendingPersonCandidateId?: unknown }).pendingPersonCandidateId;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function createCandidateForEvidence(
  tx: CandidateTx,
  row: EvidenceEvent,
  metadata?: {
    sourceRef: string;
    dedupeKey: string;
    confidence: number;
    createdByUserId: string | null;
    visibility: string;
    pendingPersonCandidateId?: string | null;
  },
): Promise<Candidate> {
  const pendingPersonCandidateId = metadata?.pendingPersonCandidateId ?? null;
  await validateEvidenceParent(tx, row, pendingPersonCandidateId);
  const identity = candidateIdentityForLegacy(row.tenantId, EVIDENCE_SOURCE_KIND, row.id);
  const legacyScope = metadata ? null : await creatorScope(tx, row.tenantId, row.createdBy || null);
  const scope = metadata ?? {
    sourceRef: identity.sourceRef,
    dedupeKey: candidateDedupeKeyForCreator(identity.dedupeKey, legacyScope!.createdByUserId),
    confidence: 0.5,
    ...legacyScope!,
  };
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'evidence_create',
    status: row.status === 'pending_review' ? 'pending' : row.status === 'approved' ? 'accepted' : 'rejected',
    accountId: row.accountId,
    matterId: row.opportunityId,
    targetKind: 'person',
    targetId: row.personId,
    payload: evidencePayload(row, pendingPersonCandidateId),
    source: row.origin,
    sourceRef: scope.sourceRef,
    evidence: row.rawContent,
    confidence: scope.confidence,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
    dedupeKey: scope.dedupeKey,
    legacySourceKind: EVIDENCE_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function ensureEvidenceCandidate(tx: CandidateTx, row: EvidenceEvent): Promise<Candidate> {
  const candidate = await findLinkedCandidate(tx, row.tenantId, EVIDENCE_SOURCE_KIND, row.id);
  if (!candidate) return createCandidateForEvidence(tx, row);
  const pendingPersonCandidateId = pendingEvidencePersonCandidate(candidate.payload);
  await validateEvidenceParent(tx, row, pendingPersonCandidateId);
  assertLinkedCandidate(candidate, {
    tenantId: row.tenantId, kind: 'evidence_create', accountId: row.accountId,
    matterId: row.opportunityId, sourceKind: EVIDENCE_SOURCE_KIND, sourceId: row.id,
  });
  const expectedStatus = row.status === 'pending_review'
    ? 'pending' : row.status === 'approved' ? 'accepted' : 'rejected';
  if (candidate.status !== expectedStatus
    || candidate.targetKind !== 'person'
    || candidate.targetId !== row.personId
    || candidate.payload !== evidencePayload(row, pendingPersonCandidateId)
    || candidate.source !== row.origin
    || candidate.evidence !== row.rawContent) {
    throw new CandidateWriteConflictError();
  }
  return candidate;
}

export interface CreateEvidenceCandidateInput {
  id: string;
  tenantId: string;
  accountId: string;
  matterId: string;
  personId: string;
  signalKey: string;
  direction: number;
  tier: string;
  rawContent: string;
  occurredAt: string;
  source: string;
  sourceRef: string;
  confidence: number;
  createdByUserId: string | null;
  pendingPersonCandidateId?: string | null;
}

export interface EvidenceCandidateReceipt {
  row: EvidenceEvent;
  candidateId: string;
  candidateVersion: number;
  created: boolean;
}

export async function createEvidenceCandidate(
  db: DbClient,
  input: CreateEvidenceCandidateInput,
): Promise<EvidenceCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    requiredText(input.id, 'id');
    requiredText(input.signalKey, 'signalKey');
    requiredText(input.rawContent, 'rawContent');
    requiredText(input.source, 'source');
    requiredText(input.sourceRef, 'sourceRef');
    validConfidence(input.confidence);
    await validateEvidenceParent(tx, {
      tenantId: input.tenantId, accountId: input.accountId,
      opportunityId: input.matterId, personId: input.personId,
    }, input.pendingPersonCandidateId ?? null);
    const scope = await creatorScope(tx, input.tenantId, input.createdByUserId);
    await requireCandidateProducerAccess(tx, candidateDescriptor({
      id: input.id,
      tenantId: input.tenantId,
      accountId: input.accountId,
      matterId: input.matterId,
      createdByUserId: scope.createdByUserId,
      visibility: scope.visibility,
      aclVersion: 1,
    }), input.createdByUserId);
    const linked = await tx.candidate.findUnique({
      where: {
        tenantId_legacySourceKind_legacySourceId: {
          tenantId: input.tenantId,
          legacySourceKind: EVIDENCE_SOURCE_KIND,
          legacySourceId: input.id,
        },
      },
      select: candidateAccessSelect,
    });
    const dedupeKey = candidateDedupeKeyForCreator(
      evidenceCandidateDedupeKey(input.source, input.sourceRef),
      scope.createdByUserId,
    );
    const existingCandidate = linked ?? await tx.candidate.findUnique({ where: {
      tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey },
    }, select: candidateAccessSelect });
    if (existingCandidate) {
      if (existingCandidate.kind !== 'evidence_create' || !existingCandidate.legacySourceId) {
        throw new CandidateWriteConflictError();
      }
      try {
        await requireCandidateProducerAccess(
          tx, candidateDescriptor(existingCandidate), input.createdByUserId,
        );
      } catch {
        throw new CandidateWriteConflictError();
      }
      const row = await tx.evidenceEvent.findFirst({ where: {
        id: existingCandidate.legacySourceId, tenantId: input.tenantId,
      } });
      if (!row || row.accountId !== input.accountId || row.opportunityId !== input.matterId
        || row.personId !== input.personId || row.signalKey !== input.signalKey
        || row.rawContent !== input.rawContent || row.occurredAt !== input.occurredAt
        || row.origin !== input.source) {
        throw new CandidateWriteConflictError();
      }
      if (pendingEvidencePersonCandidate(existingCandidate.payload)
        !== (input.pendingPersonCandidateId ?? null)) {
        throw new CandidateWriteConflictError();
      }
      const legacySourceRef = candidateIdentityForLegacy(
        input.tenantId, EVIDENCE_SOURCE_KIND, existingCandidate.legacySourceId,
      ).sourceRef;
      if (existingCandidate.sourceRef === legacySourceRef) {
        // CORE-203 did not retain the producer's original external sourceRef. The
        // first exact same-creator replay is therefore the only safe point to adopt
        // the recoverable semantic identity. Current parentage and producer scope
        // have already been revalidated above; sharing never permits re-homing.
        const adopted = await tx.candidate.updateMany({
          where: {
            id: existingCandidate.id,
            tenantId: input.tenantId,
            version: existingCandidate.version,
            sourceRef: legacySourceRef,
            dedupeKey: existingCandidate.dedupeKey,
          },
          data: {
            sourceRef: input.sourceRef,
            ...(existingCandidate.status === 'pending' ? { dedupeKey } : {}),
            version: { increment: 1 },
          },
        });
        if (adopted.count !== 1) throw new CandidateWriteConflictError();
        return {
          row, candidateId: existingCandidate.id,
          candidateVersion: existingCandidate.version + 1, created: false,
        };
      }
      if (existingCandidate.sourceRef !== input.sourceRef) throw new CandidateWriteConflictError();
      return {
        row, candidateId: existingCandidate.id,
        candidateVersion: existingCandidate.version, created: false,
      };
    }
    const row = await tx.evidenceEvent.create({ data: {
      id: input.id,
      tenantId: input.tenantId,
      accountId: input.accountId,
      opportunityId: input.matterId,
      personId: input.personId,
      signalKey: input.signalKey,
      direction: input.direction,
      tier: input.tier,
      rawContent: input.rawContent,
      occurredAt: input.occurredAt,
      status: 'pending_review',
      origin: input.source,
      createdBy: input.createdByUserId ?? '',
    } });
    const candidate = await createCandidateForEvidence(tx, row, {
      sourceRef: input.sourceRef,
      dedupeKey,
      confidence: input.confidence,
      pendingPersonCandidateId: input.pendingPersonCandidateId ?? null,
      ...scope,
    });
    return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: true };
  });
}

export interface ReviewEvidenceCandidateInput {
  tenantId: string;
  id: string;
  decision: 'accept' | 'reject';
  reviewedBy: string;
  reviewedAt: string;
  direction?: -1 | 0 | 1;
  tier?: 'weak' | 'mid' | 'strong';
  review: CandidateReviewAccessContext;
}

export async function reviewEvidenceCandidate(
  db: DbClient,
  input: ReviewEvidenceCandidateInput,
  afterApprove?: (tx: CandidateTx, row: EvidenceEvent) => Promise<void>,
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    try {
      await requireCandidateReviewAccess(tx, input.tenantId, EVIDENCE_SOURCE_KIND, input.id, input.review);
    } catch (error) {
      if (isScopedNotFound(error)) return false;
      throw error;
    }
    const row = await tx.evidenceEvent.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending_review') return false;
    const candidate = await ensureEvidenceCandidate(tx, row);
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const status = input.decision === 'accept' ? 'approved' : 'rejected';
    const changed = await tx.evidenceEvent.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: 'pending_review' },
      data: {
        status,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        ...(input.decision === 'accept' && input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.decision === 'accept' && input.tier ? { tier: input.tier } : {}),
      },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const reviewed = await tx.evidenceEvent.findUniqueOrThrow({ where: { id: row.id } });
    const finalized = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: evidencePayload(reviewed),
        version: { increment: 1 },
      },
    });
    if (finalized.count !== 1) throw new CandidateWriteConflictError();
    if (input.decision === 'accept' && afterApprove) await afterApprove(tx, reviewed);
    return true;
  });
}

export async function assertEvidenceDeletionAllowed(
  db: DbClient,
  input: { tenantId: string; id: string },
): Promise<void> {
  const row = await db.evidenceEvent.findFirst({
    where: { id: input.id, tenantId: input.tenantId },
    select: { id: true, status: true },
  });
  if (!row) return;
  const [candidateLink, hypothesisLink] = await Promise.all([
    db.candidate.findUnique({
      where: {
        tenantId_legacySourceKind_legacySourceId: {
          tenantId: input.tenantId,
          legacySourceKind: EVIDENCE_SOURCE_KIND,
          legacySourceId: row.id,
        },
      },
      select: { id: true },
    }),
    db.hypothesisEvidenceLink.findFirst({
      where: { tenantId: input.tenantId, evidenceId: row.id },
      select: { id: true },
    }),
  ]);
  if (row.status === 'pending_review' || candidateLink || hypothesisLink) {
    throw new CandidateWriteConflictError('候选证据不可删除；请通过审核保留审计轨迹');
  }
}

export async function prepareFieldCandidatesForPersonMerge(
  db: DbClient,
  input: { tenantId: string; ids: string[]; review: CandidateReviewAccessContext },
): Promise<void> {
  if (!input.ids.length) return;
  await inTransaction(db, async (tx) => {
    const refs = await tx.changeProposal.findMany({ where: {
      tenantId: input.tenantId, id: { in: input.ids },
    }, select: { id: true } });
    if (refs.length !== new Set(input.ids).size) throw new CandidateWriteConflictError();
    for (const ref of refs) {
      await requireCandidateReviewAccess(tx, input.tenantId, FIELD_SOURCE_KIND, ref.id, input.review);
      const row = await tx.changeProposal.findFirst({ where: { id: ref.id, tenantId: input.tenantId } });
      if (!row) throw new CandidateWriteConflictError();
      if (row.status === 'applying') throw new CandidateWriteConflictError();
      const candidate = await ensureFieldCandidate(tx, row);
      const cleared = await tx.candidate.updateMany({
        where: {
          id: candidate.id, tenantId: input.tenantId,
          status: candidate.status, version: candidate.version, aclVersion: candidate.aclVersion,
        },
        data: {
          ...(candidate.status === 'pending' ? { dedupeKey: `merge-pending-v1:${candidate.id}` } : {}),
          payload: fieldPayload({ ...row, dedupeKey: null }),
          version: { increment: 1 },
        },
      });
      if (cleared.count !== 1) throw new CandidateWriteConflictError();
    }
    await tx.changeProposal.updateMany({
      where: { tenantId: input.tenantId, id: { in: input.ids } },
      data: { dedupeKey: null },
    });
  });
}

export async function redirectFieldCandidateForPersonMerge(
  db: DbClient,
  input: {
    tenantId: string;
    id: string;
    targetId: string;
    reject: boolean;
    dedupeKey: string | null;
    review: CandidateReviewAccessContext;
  },
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await requireCandidateReviewAccess(tx, input.tenantId, FIELD_SOURCE_KIND, input.id, input.review);
    const row = await tx.changeProposal.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status === 'applying') throw new CandidateWriteConflictError();
    const candidate = await ensureFieldCandidate(tx, row);
    const status = input.reject && row.status === 'pending' ? 'rejected' : row.status;
    const prospective = { ...row, entityId: input.targetId, status, dedupeKey: input.dedupeKey };
    await validateFieldParent(tx, prospective);
    const updatedProjection = await tx.changeProposal.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: row.status },
      data: { entityId: input.targetId, status, dedupeKey: status === 'pending' ? input.dedupeKey : null },
    });
    if (updatedProjection.count !== 1) throw new CandidateWriteConflictError();
    const updated = await tx.changeProposal.findUniqueOrThrow({ where: { id: row.id } });
    const candidateStatus = status === 'pending' ? 'pending' : status === 'accepted' ? 'accepted' : 'rejected';
    const candidateDedupe = candidateStatus === 'pending'
      ? input.dedupeKey ?? `merge-duplicate-v1:${candidate.id}`
      : terminalDedupeKey(candidate.id);
    const redirected = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId,
        status: candidate.status, version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: candidateStatus,
        targetId: input.targetId,
        dedupeKey: candidateDedupe,
        payload: fieldPayload(updated),
        version: { increment: 1 },
      },
    });
    if (redirected.count !== 1) throw new CandidateWriteConflictError();
  });
}

export async function redirectReminderCandidateForPersonMerge(
  db: DbClient,
  input: {
    tenantId: string;
    id: string;
    targetId: string;
    dedupeKey: string;
    duplicate: boolean;
    review: CandidateReviewAccessContext;
  },
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await requireCandidateReviewAccess(tx, input.tenantId, REMINDER_SOURCE_KIND, input.id, input.review);
    const row = await tx.reminder.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) throw new CandidateWriteConflictError();
    const candidate = await ensureReminderCandidate(tx, row);
    const status = input.duplicate && row.status === 'pending' ? 'dismissed' : row.status;
    const legacyDedupeKey = input.duplicate
      ? `merge-duplicate:${row.id}:${input.dedupeKey}`
      : input.dedupeKey;
    const prospective = {
      ...row,
      entityId: input.targetId,
      dedupeKey: legacyDedupeKey,
      status,
    };
    const target = await reminderTarget(tx, prospective);
    const changed = await tx.reminder.updateMany({
      where: { id: row.id, tenantId: input.tenantId, status: row.status },
      data: { entityId: input.targetId, dedupeKey: legacyDedupeKey, status },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updated = await tx.reminder.findUniqueOrThrow({ where: { id: row.id } });
    const candidateStatus = status === 'pending' ? 'pending' : status === 'done' ? 'accepted' : 'rejected';
    const redirected = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: input.tenantId,
        status: candidate.status, version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: candidateStatus,
        targetKind: target.kind,
        targetId: target.id,
        dedupeKey: candidateStatus === 'pending'
          ? reminderCandidateDedupeKey(legacyDedupeKey)
          : terminalDedupeKey(candidate.id),
        payload: reminderPayload(updated),
        version: { increment: 1 },
      },
    });
    if (redirected.count !== 1) throw new CandidateWriteConflictError();
  });
}

export async function redirectEvidenceCandidatesForPersonMerge(
  db: DbClient,
  input: {
    tenantId: string;
    accountId: string;
    fromPersonId: string;
    toPersonId: string;
    review: CandidateReviewAccessContext;
  },
): Promise<number> {
  return inTransaction(db, async (tx) => {
    await requirePerson(tx, input.tenantId, input.accountId, input.toPersonId);
    const refs = await tx.evidenceEvent.findMany({ where: {
      tenantId: input.tenantId, accountId: input.accountId, personId: input.fromPersonId,
    }, select: { id: true } });
    for (const ref of refs) {
      const candidateMetadata = await tx.candidate.findUnique({
        where: {
          tenantId_legacySourceKind_legacySourceId: {
            tenantId: input.tenantId,
            legacySourceKind: EVIDENCE_SOURCE_KIND,
            legacySourceId: ref.id,
          },
        },
        select: candidateAccessSelect,
      });
      if (!candidateMetadata) {
        const changed = await tx.evidenceEvent.updateMany({
          where: {
            id: ref.id, tenantId: input.tenantId,
            accountId: input.accountId, personId: input.fromPersonId,
          },
          data: { personId: input.toPersonId },
        });
        if (changed.count !== 1) throw new CandidateWriteConflictError();
        continue;
      }
      await requireCandidateReviewAccess(tx, input.tenantId, EVIDENCE_SOURCE_KIND, ref.id, input.review);
      const row = await tx.evidenceEvent.findFirst({ where: { id: ref.id, tenantId: input.tenantId } });
      if (!row) throw new CandidateWriteConflictError();
      const candidate = await findLinkedCandidate(tx, input.tenantId, EVIDENCE_SOURCE_KIND, row.id);
      if (!candidate || candidate.id !== candidateMetadata.id) throw new CandidateWriteConflictError();
      await ensureEvidenceCandidate(tx, row);
      const changed = await tx.evidenceEvent.updateMany({
        where: {
          id: row.id, tenantId: input.tenantId,
          accountId: input.accountId, personId: input.fromPersonId,
        },
        data: { personId: input.toPersonId },
      });
      if (changed.count !== 1) throw new CandidateWriteConflictError();
      const updated = await tx.evidenceEvent.findUniqueOrThrow({ where: { id: row.id } });
      const redirected = await tx.candidate.updateMany({
        where: {
          id: candidate.id, tenantId: input.tenantId,
          status: candidate.status, version: candidate.version, aclVersion: candidate.aclVersion,
        },
        data: {
          targetId: input.toPersonId,
          payload: evidencePayload(updated),
          version: { increment: 1 },
        },
      });
      if (redirected.count !== 1) throw new CandidateWriteConflictError();
    }
    return refs.length;
  });
}
