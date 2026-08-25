import {
  Prisma,
  type Candidate,
  type PersonSuggestion,
  type PrismaClient,
  type RelSuggestion,
} from '@prisma/client';
import type { DbClient } from '../mutation/scopeGuards.js';
import {
  requireAccount,
  requirePerson,
  ScopedNotFoundError,
} from '../mutation/scopeGuards.js';
import { activePersonWhere } from '../activePerson.js';
import {
  candidateDescriptor,
  requireCandidateProducerAccess,
  requireCandidateReviewAccess,
  type CandidateReviewAccessContext,
} from '../sensitiveAccess.js';
import {
  candidateIdentityForLegacy,
  canonicalCandidateJson,
  type CanonicalCandidateStatus,
} from './migration.js';
import {
  candidateDedupeKeyForCreator,
  personCandidateDedupeKey,
  relationCandidateDedupeKey,
  sourceCandidateDedupeKey,
} from './dedupe.js';
export {
  personCandidateDedupeKey,
  relationCandidateDedupeKey,
  sourceCandidateDedupeKey,
} from './dedupe.js';

type CandidateTx = Prisma.TransactionClient;
type CandidateEndpoint = { kind: 'person' | 'suggestion'; id: string };

const PERSON_SOURCE_KIND = 'PersonSuggestion' as const;
const REL_SOURCE_KIND = 'RelSuggestion' as const;

export class CandidateWriteConflictError extends Error {
  readonly candidateConflict = true;

  constructor(message = '候选已被处理或幂等身份冲突，请刷新后重试') {
    super(message);
    this.name = 'CandidateWriteConflictError';
  }
}

export interface CreatePersonCandidateInput {
  id: string;
  tenantId: string;
  accountId: string;
  matterId?: string | null;
  name: string;
  title?: string;
  orgLevel?: number;
  source: string;
  sourceRef: string;
  evidence: string;
  confidence: number;
  createdByUserId: string | null;
  dedupeKey: string;
  sourceUrl?: string | null;
  suggestedRole?: string | null;
  suggestedSentiment?: string | null;
}

export interface CreateRelationCandidateInput {
  id: string;
  tenantId: string;
  matterId: string;
  source: CandidateEndpoint;
  target: CandidateEndpoint;
  layer: string;
  label: string;
  sourceType: string;
  sourceRef: string;
  evidence: string;
  confidence: number;
  createdByUserId: string | null;
  dedupeKey: string;
}

export interface PersonCandidateReceipt {
  row: PersonSuggestion;
  candidateId: string;
  candidateVersion: number;
  created: boolean;
}

export interface RelationCandidateReceipt {
  row: RelSuggestion;
  candidateId: string;
  candidateVersion: number;
  created: boolean;
}

export interface UpdatePendingPersonCandidateInput {
  tenantId: string;
  id: string;
  createdByUserId: string | null;
  dedupeKey?: string;
  patch: Partial<Pick<
    PersonSuggestion,
    | 'name'
    | 'title'
    | 'orgLevel'
    | 'evidence'
    | 'sourceUrl'
    | 'confidence'
    | 'suggestedRole'
    | 'suggestedSentiment'
  >>;
}

export interface FindPendingPersonCandidateForProducerInput {
  tenantId: string;
  dedupeKey: string;
  createdByUserId: string | null;
}

export interface ClaimPersonCandidateInput {
  tenantId: string;
  id: string;
  override?: { name?: string; title?: string };
  review: CandidateReviewAccessContext;
}

export interface FinalizePersonCandidateInput {
  tenantId: string;
  id: string;
  expectedVersion: number;
  resolvedPersonId: string;
}

export interface ClaimRelationCandidateInput {
  tenantId: string;
  id: string;
  review: CandidateReviewAccessContext;
}

export interface FinalizeRelationCandidateInput {
  tenantId: string;
  id: string;
  expectedVersion: number;
  sourcePersonId: string;
  targetPersonId: string;
  layer: string;
  label: string;
}

export interface RejectCandidateInput {
  tenantId: string;
  id: string;
  review: CandidateReviewAccessContext;
}

export interface RedirectCandidatePersonReferencesInput {
  tenantId: string;
  accountId: string;
  from: CandidateEndpoint;
  toPersonId: string;
  review: CandidateReviewAccessContext;
}

export interface RedirectCandidatePersonReferencesReceipt {
  relationSources: number;
  relationTargets: number;
  resolvedPersons: number;
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

async function inTransaction<T>(db: DbClient, work: (tx: CandidateTx) => Promise<T>): Promise<T> {
  if (isRootClient(db)) {
    return db.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 15_000,
    });
  }
  return work(db as CandidateTx);
}

function prismaCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
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

function canonicalStatus(status: string): CanonicalCandidateStatus {
  if (status === 'pending' || status === 'accepted' || status === 'rejected') return status;
  throw new CandidateWriteConflictError(`不支持的候选状态：${status}`);
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
  strict: boolean,
): Promise<{ createdByUserId: string | null; visibility: 'private' | 'owner_admin_only' }> {
  if (!createdByUserId) return { createdByUserId: null, visibility: 'owner_admin_only' };
  const user = await tx.user.findFirst({ where: { id: createdByUserId, tenantId }, select: { id: true } });
  if (user) return { createdByUserId: user.id, visibility: 'private' };
  if (strict) throw new ScopedNotFoundError();
  return { createdByUserId: null, visibility: 'owner_admin_only' };
}

async function requireMatterAccount(
  tx: CandidateTx,
  tenantId: string,
  matterId: string,
  options: { allowArchived?: boolean } = {},
): Promise<string> {
  const matter = await tx.opportunity.findFirst({
    where: {
      id: matterId,
      tenantId,
      ...(options.allowArchived ? {} : { archivedAt: null, account: { archivedAt: null } }),
    },
    select: { accountId: true },
  });
  if (!matter) throw new ScopedNotFoundError();
  if (options.allowArchived) {
    const account = await tx.account.findFirst({ where: { id: matter.accountId, tenantId }, select: { id: true } });
    if (!account) throw new ScopedNotFoundError();
  } else {
    await requireAccount(tx, tenantId, matter.accountId);
  }
  return matter.accountId;
}

async function validatePersonParent(
  tx: CandidateTx,
  row: Pick<PersonSuggestion, 'tenantId' | 'accountId' | 'opportunityId' | 'resolvedPersonId'>,
  options: { allowArchived?: boolean } = {},
): Promise<void> {
  if (options.allowArchived) {
    const account = await tx.account.findFirst({ where: { id: row.accountId, tenantId: row.tenantId }, select: { id: true } });
    if (!account) throw new ScopedNotFoundError();
  } else {
    await requireAccount(tx, row.tenantId, row.accountId);
  }
  if (row.opportunityId) {
    const matterAccountId = await requireMatterAccount(tx, row.tenantId, row.opportunityId, options);
    if (matterAccountId !== row.accountId) throw new ScopedNotFoundError();
  }
  if (row.resolvedPersonId) {
    const person = await tx.person.findFirst({
      where: {
        id: row.resolvedPersonId,
        tenantId: row.tenantId,
        accountId: row.accountId,
        ...(options.allowArchived ? {} : activePersonWhere),
      },
      select: { id: true },
    });
    if (!person) throw new ScopedNotFoundError();
  }
}

async function validateEndpoint(
  tx: CandidateTx,
  tenantId: string,
  accountId: string,
  matterId: string,
  endpoint: CandidateEndpoint,
  options: { allowArchived?: boolean } = {},
): Promise<void> {
  if (endpoint.kind === 'person') {
    const person = await tx.person.findFirst({
      where: {
        id: endpoint.id,
        tenantId,
        accountId,
        ...(options.allowArchived ? {} : activePersonWhere),
      },
      select: { id: true },
    });
    if (!person) throw new ScopedNotFoundError();
    return;
  }
  const suggestion = await tx.personSuggestion.findFirst({
    where: { id: endpoint.id, tenantId, accountId },
    select: { opportunityId: true },
  });
  if (!suggestion || (suggestion.opportunityId && suggestion.opportunityId !== matterId)) {
    throw new ScopedNotFoundError();
  }
}

async function validateRelationParent(
  tx: CandidateTx,
  row: Pick<
    RelSuggestion,
    'tenantId' | 'opportunityId' | 'sourceKind' | 'sourcePersonId' | 'targetKind' | 'targetPersonId'
  >,
  options: { allowArchived?: boolean } = {},
): Promise<string> {
  const accountId = await requireMatterAccount(tx, row.tenantId, row.opportunityId, options);
  if (row.sourceKind !== 'person' && row.sourceKind !== 'suggestion') throw new ScopedNotFoundError();
  if (row.targetKind !== 'person' && row.targetKind !== 'suggestion') throw new ScopedNotFoundError();
  await validateEndpoint(tx, row.tenantId, accountId, row.opportunityId, {
    kind: row.sourceKind,
    id: row.sourcePersonId,
  }, options);
  await validateEndpoint(tx, row.tenantId, accountId, row.opportunityId, {
    kind: row.targetKind,
    id: row.targetPersonId,
  }, options);
  return accountId;
}

function personPayload(row: PersonSuggestion): string {
  return canonicalCandidateJson({
    legacyStatus: row.status,
    name: row.name,
    orgLevel: row.orgLevel,
    resolvedPersonId: row.resolvedPersonId,
    sourceUrl: row.sourceUrl,
    suggestedRole: row.suggestedRole,
    suggestedSentiment: row.suggestedSentiment,
    title: row.title,
  });
}

function relationPayload(row: RelSuggestion): string {
  return canonicalCandidateJson({
    label: row.label,
    layer: row.layer,
    legacyStatus: row.status,
    sourceKind: row.sourceKind,
    sourcePersonId: row.sourcePersonId,
    targetKind: row.targetKind,
    targetPersonId: row.targetPersonId,
  });
}

type LinkedCandidateMetadata = Pick<Candidate,
  | 'id'
  | 'tenantId'
  | 'kind'
  | 'status'
  | 'accountId'
  | 'matterId'
  | 'createdByUserId'
  | 'visibility'
  | 'aclVersion'
  | 'dedupeKey'
  | 'legacySourceKind'
  | 'legacySourceId'
  | 'sourceRef'
  | 'version'
>;

function assertLinkedCandidate(
  candidate: LinkedCandidateMetadata,
  expected: {
    kind: 'person_create' | 'relation_create';
    tenantId: string;
    accountId: string;
    matterId: string | null;
    legacySourceKind: typeof PERSON_SOURCE_KIND | typeof REL_SOURCE_KIND;
    legacySourceId: string;
  },
): void {
  if (
    candidate.kind !== expected.kind
    || candidate.tenantId !== expected.tenantId
    || candidate.accountId !== expected.accountId
    || candidate.matterId !== expected.matterId
    || candidate.legacySourceKind !== expected.legacySourceKind
    || candidate.legacySourceId !== expected.legacySourceId
  ) {
    throw new CandidateWriteConflictError();
  }
}

async function findLinkedCandidate(
  tx: CandidateTx,
  tenantId: string,
  sourceKind: typeof PERSON_SOURCE_KIND | typeof REL_SOURCE_KIND,
  sourceId: string,
): Promise<Candidate | null> {
  return tx.candidate.findUnique({
    where: {
      tenantId_legacySourceKind_legacySourceId: {
        tenantId,
        legacySourceKind: sourceKind,
        legacySourceId: sourceId,
      },
    },
  });
}

const producerCandidateSelect = {
  id: true,
  tenantId: true,
  kind: true,
  status: true,
  accountId: true,
  matterId: true,
  createdByUserId: true,
  visibility: true,
  aclVersion: true,
  dedupeKey: true,
  legacySourceKind: true,
  legacySourceId: true,
  version: true,
  sourceRef: true,
} as const;

async function findLinkedProducerCandidate(
  tx: CandidateTx,
  tenantId: string,
  sourceKind: typeof PERSON_SOURCE_KIND | typeof REL_SOURCE_KIND,
  sourceId: string,
): Promise<LinkedCandidateMetadata | null> {
  return tx.candidate.findUnique({
    where: {
      tenantId_legacySourceKind_legacySourceId: {
        tenantId,
        legacySourceKind: sourceKind,
        legacySourceId: sourceId,
      },
    },
    select: producerCandidateSelect,
  });
}

/**
 * Resolve a producer-owned person Candidate by semantic key. Candidate ACL metadata is
 * checked before the legacy projection body is selected, in the same database snapshot.
 */
export async function findPendingPersonCandidateForProducer(
  db: DbClient,
  input: FindPendingPersonCandidateForProducerInput,
): Promise<PersonSuggestion | null> {
  return inTransaction(db, async (tx) => {
    const scope = await creatorScope(tx, input.tenantId, input.createdByUserId, true);
    const dedupeKey = candidateDedupeKeyForCreator(input.dedupeKey, scope.createdByUserId);
    const candidate = await tx.candidate.findUnique({
      where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
      select: producerCandidateSelect,
    });
    if (!candidate) return null;
    await requireCandidateProducerAccess(tx, candidateDescriptor(candidate), input.createdByUserId);
    if (candidate.kind !== 'person_create'
      || candidate.status !== 'pending'
      || candidate.legacySourceKind !== PERSON_SOURCE_KIND
      || !candidate.legacySourceId) {
      throw new CandidateWriteConflictError();
    }
    const row = await tx.personSuggestion.findFirst({
      where: {
        id: candidate.legacySourceId,
        tenantId: input.tenantId,
        accountId: candidate.accountId,
        opportunityId: candidate.matterId,
        status: 'pending',
      },
    });
    if (!row) throw new CandidateWriteConflictError();
    return row;
  });
}

async function requireProducerSuggestionEndpoint(
  tx: CandidateTx,
  input: {
    tenantId: string;
    accountId: string;
    matterId: string;
    suggestionId: string;
    createdByUserId: string | null;
  },
): Promise<void> {
  const candidate = await tx.candidate.findUnique({
    where: {
      tenantId_legacySourceKind_legacySourceId: {
        tenantId: input.tenantId,
        legacySourceKind: PERSON_SOURCE_KIND,
        legacySourceId: input.suggestionId,
      },
    },
    select: producerCandidateSelect,
  });
  if (!candidate) throw new ScopedNotFoundError();
  await requireCandidateProducerAccess(tx, candidateDescriptor(candidate), input.createdByUserId);
  if (candidate.kind !== 'person_create'
    || candidate.status !== 'pending'
    || candidate.accountId !== input.accountId
    || (candidate.matterId && candidate.matterId !== input.matterId)) {
    throw new ScopedNotFoundError();
  }
}

async function requireProducerCandidateEndpoints(
  tx: CandidateTx,
  input: Pick<CreateRelationCandidateInput, 'tenantId' | 'matterId' | 'source' | 'target' | 'createdByUserId'>,
  accountId: string,
): Promise<void> {
  for (const endpoint of [input.source, input.target]) {
    if (endpoint.kind !== 'suggestion') continue;
    await requireProducerSuggestionEndpoint(tx, {
      tenantId: input.tenantId,
      accountId,
      matterId: input.matterId,
      suggestionId: endpoint.id,
      createdByUserId: input.createdByUserId,
    });
  }
}

async function createCandidateForPerson(
  tx: CandidateTx,
  row: PersonSuggestion,
  metadata?: {
    sourceRef: string;
    dedupeKey: string;
    createdByUserId: string | null;
    visibility: 'private' | 'owner_admin_only';
  },
): Promise<Candidate> {
  await validatePersonParent(tx, row);
  const identity = candidateIdentityForLegacy(row.tenantId, PERSON_SOURCE_KIND, row.id);
  const legacyScope = metadata ? null : await creatorScope(tx, row.tenantId, row.proposedBy || null, false);
  const scope = metadata ?? {
    sourceRef: identity.sourceRef,
    dedupeKey: candidateDedupeKeyForCreator(identity.dedupeKey, legacyScope!.createdByUserId),
    ...legacyScope!,
  };
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'person_create',
    status: canonicalStatus(row.status),
    accountId: row.accountId,
    matterId: row.opportunityId,
    targetKind: 'person',
    targetId: null,
    payload: personPayload(row),
    source: row.origin,
    sourceRef: scope.sourceRef,
    evidence: row.evidence,
    confidence: row.confidence,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
    dedupeKey: scope.dedupeKey,
    legacySourceKind: PERSON_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function ensurePersonCandidate(
  tx: CandidateTx,
  row: PersonSuggestion,
  options: { dedupeKey?: string; allowArchived?: boolean } = {},
): Promise<Candidate> {
  await validatePersonParent(tx, row, { allowArchived: options.allowArchived });
  const existing = await findLinkedCandidate(tx, row.tenantId, PERSON_SOURCE_KIND, row.id);
  if (existing) {
    assertLinkedCandidate(existing, {
      kind: 'person_create', tenantId: row.tenantId, accountId: row.accountId,
      matterId: row.opportunityId, legacySourceKind: PERSON_SOURCE_KIND, legacySourceId: row.id,
    });
    const requestedDedupeKey = options.dedupeKey
      ? candidateDedupeKeyForCreator(options.dedupeKey, existing.createdByUserId)
      : null;
    if (requestedDedupeKey && existing.dedupeKey !== requestedDedupeKey) {
      const legacyIdentity = candidateIdentityForLegacy(row.tenantId, PERSON_SOURCE_KIND, row.id);
      const legacyDedupeKey = candidateDedupeKeyForCreator(
        legacyIdentity.dedupeKey,
        existing.createdByUserId,
      );
      if (existing.dedupeKey !== legacyDedupeKey) throw new CandidateWriteConflictError();
      return tx.candidate.update({ where: { id: existing.id }, data: { dedupeKey: requestedDedupeKey } });
    }
    return existing;
  }
  const identity = candidateIdentityForLegacy(row.tenantId, PERSON_SOURCE_KIND, row.id);
  const scope = await creatorScope(tx, row.tenantId, row.proposedBy || null, false);
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'person_create',
    status: canonicalStatus(row.status),
    accountId: row.accountId,
    matterId: row.opportunityId,
    targetKind: 'person',
    targetId: null,
    payload: personPayload(row),
    source: row.origin,
    sourceRef: identity.sourceRef,
    evidence: row.evidence,
    confidence: row.confidence,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
    dedupeKey: candidateDedupeKeyForCreator(options.dedupeKey ?? identity.dedupeKey, scope.createdByUserId),
    legacySourceKind: PERSON_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function createCandidateForRelation(
  tx: CandidateTx,
  row: RelSuggestion,
  metadata?: {
    sourceRef: string;
    dedupeKey: string;
    createdByUserId: string | null;
    visibility: 'private' | 'owner_admin_only';
  },
  options: { allowArchived?: boolean } = {},
): Promise<Candidate> {
  const accountId = await validateRelationParent(tx, row, options);
  const identity = candidateIdentityForLegacy(row.tenantId, REL_SOURCE_KIND, row.id);
  const scope = metadata ?? {
    sourceRef: identity.sourceRef,
    dedupeKey: identity.dedupeKey,
    createdByUserId: null,
    visibility: 'owner_admin_only' as const,
  };
  return tx.candidate.create({ data: {
    id: identity.id,
    tenantId: row.tenantId,
    kind: 'relation_create',
    status: canonicalStatus(row.status),
    accountId,
    matterId: row.opportunityId,
    targetKind: 'relation',
    targetId: null,
    payload: relationPayload(row),
    source: row.origin,
    sourceRef: scope.sourceRef,
    evidence: row.evidence,
    confidence: row.confidence,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
    dedupeKey: scope.dedupeKey,
    legacySourceKind: REL_SOURCE_KIND,
    legacySourceId: row.id,
    createdAt: row.createdAt,
  } });
}

async function ensureRelationCandidate(
  tx: CandidateTx,
  row: RelSuggestion,
  options: { allowArchived?: boolean } = {},
): Promise<Candidate> {
  const accountId = await validateRelationParent(tx, row, options);
  const existing = await findLinkedCandidate(tx, row.tenantId, REL_SOURCE_KIND, row.id);
  if (existing) {
    assertLinkedCandidate(existing, {
      kind: 'relation_create', tenantId: row.tenantId, accountId,
      matterId: row.opportunityId, legacySourceKind: REL_SOURCE_KIND, legacySourceId: row.id,
    });
    return existing;
  }
  return createCandidateForRelation(tx, row, undefined, options);
}

async function replayPerson(
  tx: CandidateTx,
  candidate: LinkedCandidateMetadata,
  input: CreatePersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  await requireCandidateProducerAccess(tx, candidateDescriptor(candidate), input.createdByUserId);
  assertLinkedCandidate(candidate, {
    kind: 'person_create', tenantId: input.tenantId, accountId: input.accountId,
    matterId: input.matterId ?? null, legacySourceKind: PERSON_SOURCE_KIND,
    legacySourceId: candidate.legacySourceId ?? '',
  });
  if (candidate.sourceRef !== input.sourceRef || !candidate.legacySourceId) throw new CandidateWriteConflictError();
  const row = await tx.personSuggestion.findFirst({
    where: { id: candidate.legacySourceId, tenantId: input.tenantId, accountId: input.accountId },
  });
  if (!row || row.name !== input.name) throw new CandidateWriteConflictError();
  return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: false };
}

async function replayRelation(
  tx: CandidateTx,
  candidate: LinkedCandidateMetadata,
  input: CreateRelationCandidateInput,
): Promise<RelationCandidateReceipt> {
  await requireCandidateProducerAccess(tx, candidateDescriptor(candidate), input.createdByUserId);
  if (!candidate.legacySourceId) throw new CandidateWriteConflictError();
  const accountId = await requireMatterAccount(tx, input.tenantId, input.matterId);
  await requireProducerCandidateEndpoints(tx, input, accountId);
  assertLinkedCandidate(candidate, {
    kind: 'relation_create', tenantId: input.tenantId, accountId,
    matterId: input.matterId, legacySourceKind: REL_SOURCE_KIND,
    legacySourceId: candidate.legacySourceId,
  });
  if (candidate.sourceRef !== input.sourceRef) throw new CandidateWriteConflictError();
  const row = await tx.relSuggestion.findFirst({
    where: { id: candidate.legacySourceId, tenantId: input.tenantId, opportunityId: input.matterId },
  });
  if (!row) throw new CandidateWriteConflictError();
  return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: false };
}

async function createPersonCandidateInTransaction(
  tx: CandidateTx,
  input: CreatePersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  requiredText(input.id, 'id');
  requiredText(input.name, 'name');
  requiredText(input.source, 'source');
  requiredText(input.sourceRef, 'sourceRef');
  requiredText(input.evidence, 'evidence');
  requiredText(input.dedupeKey, 'dedupeKey');
  validConfidence(input.confidence);
  await requireAccount(tx, input.tenantId, input.accountId);
  if (input.matterId) {
    const matterAccountId = await requireMatterAccount(tx, input.tenantId, input.matterId);
    if (matterAccountId !== input.accountId) throw new ScopedNotFoundError();
  }
  const scope = await creatorScope(tx, input.tenantId, input.createdByUserId, true);
  const dedupeKey = candidateDedupeKeyForCreator(input.dedupeKey, scope.createdByUserId);
  await requireCandidateProducerAccess(tx, candidateDescriptor({
    id: input.id,
    tenantId: input.tenantId,
    accountId: input.accountId,
    matterId: input.matterId ?? null,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
  }), input.createdByUserId);
  const existingByKey = await tx.candidate.findUnique({
    where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
    select: producerCandidateSelect,
  });
  if (existingByKey) return replayPerson(tx, existingByKey, input);
  const linked = await findLinkedProducerCandidate(tx, input.tenantId, PERSON_SOURCE_KIND, input.id);
  if (linked) return replayPerson(tx, linked, input);
  const legacy = await tx.personSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (legacy) {
    if (legacy.accountId !== input.accountId || legacy.opportunityId !== (input.matterId ?? null) || legacy.name !== input.name) {
      throw new CandidateWriteConflictError();
    }
    const candidate = await createCandidateForPerson(tx, legacy, {
      sourceRef: input.sourceRef,
      dedupeKey,
      ...scope,
    });
    return { row: legacy, candidateId: candidate.id, candidateVersion: candidate.version, created: false };
  }
  const row = await tx.personSuggestion.create({ data: {
    id: input.id,
    tenantId: input.tenantId,
    accountId: input.accountId,
    opportunityId: input.matterId ?? null,
    name: input.name,
    title: input.title ?? '',
    orgLevel: input.orgLevel ?? 3,
    origin: input.source,
    evidence: input.evidence,
    sourceUrl: input.sourceUrl ?? null,
    confidence: input.confidence,
    status: 'pending',
    proposedBy: input.createdByUserId ?? '',
    suggestedRole: input.suggestedRole ?? null,
    suggestedSentiment: input.suggestedSentiment ?? null,
  } });
  const candidate = await createCandidateForPerson(tx, row, {
    sourceRef: input.sourceRef,
    dedupeKey,
    ...scope,
  });
  return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: true };
}

export async function createPersonCandidate(
  db: DbClient,
  input: CreatePersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  try {
    return await inTransaction(db, (tx) => createPersonCandidateInTransaction(tx, input));
  } catch (error) {
    if (prismaCode(error) !== 'P2002' || !isRootClient(db)) throw error;
    return inTransaction(db, async (tx) => {
      const dedupeKey = candidateDedupeKeyForCreator(input.dedupeKey, input.createdByUserId);
      const existing = await tx.candidate.findUnique({
        where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
        select: producerCandidateSelect,
      });
      if (!existing) throw error;
      return replayPerson(tx, existing, input);
    });
  }
}

async function createRelationCandidateInTransaction(
  tx: CandidateTx,
  input: CreateRelationCandidateInput,
): Promise<RelationCandidateReceipt> {
  requiredText(input.id, 'id');
  requiredText(input.sourceType, 'source');
  requiredText(input.sourceRef, 'sourceRef');
  requiredText(input.evidence, 'evidence');
  requiredText(input.dedupeKey, 'dedupeKey');
  requiredText(input.source.id, 'source endpoint');
  requiredText(input.target.id, 'target endpoint');
  if (input.source.kind === input.target.kind && input.source.id === input.target.id) {
    throw new CandidateWriteConflictError('关系端点不能相同');
  }
  validConfidence(input.confidence);
  const accountId = await requireMatterAccount(tx, input.tenantId, input.matterId);
  const scope = await creatorScope(tx, input.tenantId, input.createdByUserId, true);
  const dedupeKey = candidateDedupeKeyForCreator(input.dedupeKey, scope.createdByUserId);
  await requireCandidateProducerAccess(tx, candidateDescriptor({
    id: input.id,
    tenantId: input.tenantId,
    accountId,
    matterId: input.matterId,
    createdByUserId: scope.createdByUserId,
    visibility: scope.visibility,
    aclVersion: 1,
  }), input.createdByUserId);
  await requireProducerCandidateEndpoints(tx, input, accountId);
  await validateEndpoint(tx, input.tenantId, accountId, input.matterId, input.source);
  await validateEndpoint(tx, input.tenantId, accountId, input.matterId, input.target);
  const existingByKey = await tx.candidate.findUnique({
    where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
    select: producerCandidateSelect,
  });
  if (existingByKey) return replayRelation(tx, existingByKey, input);
  const linked = await findLinkedProducerCandidate(tx, input.tenantId, REL_SOURCE_KIND, input.id);
  if (linked) return replayRelation(tx, linked, input);
  const legacy = await tx.relSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
  if (legacy) {
    if (legacy.opportunityId !== input.matterId) throw new CandidateWriteConflictError();
    const candidate = await createCandidateForRelation(tx, legacy, {
      sourceRef: input.sourceRef,
      dedupeKey,
      ...scope,
    });
    return { row: legacy, candidateId: candidate.id, candidateVersion: candidate.version, created: false };
  }
  const row = await tx.relSuggestion.create({ data: {
    id: input.id,
    tenantId: input.tenantId,
    opportunityId: input.matterId,
    sourcePersonId: input.source.id,
    sourceKind: input.source.kind,
    targetPersonId: input.target.id,
    targetKind: input.target.kind,
    layer: input.layer,
    label: input.label,
    confidence: input.confidence,
    origin: input.sourceType,
    evidence: input.evidence,
    status: 'pending',
  } });
  const candidate = await createCandidateForRelation(tx, row, {
    sourceRef: input.sourceRef,
    dedupeKey,
    ...scope,
  });
  return { row, candidateId: candidate.id, candidateVersion: candidate.version, created: true };
}

export async function createRelationCandidate(
  db: DbClient,
  input: CreateRelationCandidateInput,
): Promise<RelationCandidateReceipt> {
  try {
    return await inTransaction(db, (tx) => createRelationCandidateInTransaction(tx, input));
  } catch (error) {
    if (prismaCode(error) !== 'P2002' || !isRootClient(db)) throw error;
    return inTransaction(db, async (tx) => {
      const dedupeKey = candidateDedupeKeyForCreator(input.dedupeKey, input.createdByUserId);
      const existing = await tx.candidate.findUnique({
        where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
        select: producerCandidateSelect,
      });
      if (!existing) throw error;
      return replayRelation(tx, existing, input);
    });
  }
}

export async function updatePendingPersonCandidate(
  db: DbClient,
  input: UpdatePendingPersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    if (input.patch.evidence !== undefined) requiredText(input.patch.evidence, 'evidence');
    if (input.patch.confidence !== undefined) validConfidence(input.patch.confidence);
    const candidate = await tx.candidate.findUnique({
      where: {
        tenantId_legacySourceKind_legacySourceId: {
          tenantId: input.tenantId,
          legacySourceKind: PERSON_SOURCE_KIND,
          legacySourceId: input.id,
        },
      },
      select: producerCandidateSelect,
    });
    if (!candidate) throw new ScopedNotFoundError();
    await requireCandidateProducerAccess(tx, candidateDescriptor(candidate), input.createdByUserId);
    if (candidate.kind !== 'person_create'
      || candidate.status !== 'pending'
      || candidate.legacySourceKind !== PERSON_SOURCE_KIND
      || candidate.legacySourceId !== input.id) {
      throw new CandidateWriteConflictError();
    }
    const requestedDedupeKey = input.dedupeKey
      ? candidateDedupeKeyForCreator(input.dedupeKey, candidate.createdByUserId)
      : null;
    if (requestedDedupeKey && candidate.dedupeKey !== requestedDedupeKey) {
      const legacyIdentity = candidateIdentityForLegacy(input.tenantId, PERSON_SOURCE_KIND, input.id);
      const legacyDedupeKey = candidateDedupeKeyForCreator(
        legacyIdentity.dedupeKey,
        candidate.createdByUserId,
      );
      if (candidate.dedupeKey !== legacyDedupeKey) throw new CandidateWriteConflictError();
      const remapped = await tx.candidate.updateMany({
        where: {
          id: candidate.id,
          tenantId: input.tenantId,
          dedupeKey: candidate.dedupeKey,
          version: candidate.version,
          aclVersion: candidate.aclVersion,
        },
        data: { dedupeKey: requestedDedupeKey },
      });
      if (remapped.count !== 1) throw new CandidateWriteConflictError();
    }
    const row = await tx.personSuggestion.findFirst({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        accountId: candidate.accountId,
        opportunityId: candidate.matterId,
        status: 'pending',
      },
    });
    if (!row) throw new CandidateWriteConflictError();
    const changed = await tx.personSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'pending' },
      data: input.patch,
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.personSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const updatedCandidate = await tx.candidate.updateMany({
      where: {
        id: candidate.id,
        tenantId: row.tenantId,
        status: 'pending',
        version: candidate.version,
        aclVersion: candidate.aclVersion,
      },
      data: {
        payload: personPayload(updatedRow),
        source: updatedRow.origin,
        evidence: updatedRow.evidence,
        confidence: updatedRow.confidence,
        version: { increment: 1 },
      },
    });
    if (updatedCandidate.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: updatedRow,
      candidateId: candidate.id,
      candidateVersion: candidate.version + 1,
      created: false,
    };
  });
}

export async function claimPersonCandidate(
  db: DbClient,
  input: ClaimPersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    await requireCandidateReviewAccess(tx, input.tenantId, PERSON_SOURCE_KIND, input.id, input.review);
    const row = await tx.personSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) throw new ScopedNotFoundError();
    if (row.status !== 'pending' || row.resolvedPersonId) throw new CandidateWriteConflictError();
    const candidate = await ensurePersonCandidate(tx, row);
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const changed = await tx.personSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'pending', resolvedPersonId: null },
      data: {
        status: 'accepted',
        ...(input.override?.name !== undefined ? { name: input.override.name } : {}),
        ...(input.override?.title !== undefined ? { title: input.override.title } : {}),
      },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.personSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const claimed = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: row.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'accepted',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: personPayload(updatedRow),
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: updatedRow,
      candidateId: candidate.id,
      candidateVersion: candidate.version + 1,
      created: false,
    };
  });
}

export async function finalizePersonCandidate(
  db: DbClient,
  input: FinalizePersonCandidateInput,
): Promise<PersonCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    const row = await tx.personSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) throw new ScopedNotFoundError();
    if (row.status !== 'accepted' || row.resolvedPersonId) throw new CandidateWriteConflictError();
    await requirePerson(tx, row.tenantId, row.accountId, input.resolvedPersonId);
    const candidate = await ensurePersonCandidate(tx, row);
    if (candidate.status !== 'accepted' || candidate.version !== input.expectedVersion) {
      throw new CandidateWriteConflictError();
    }
    const changed = await tx.personSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'accepted', resolvedPersonId: null },
      data: { resolvedPersonId: input.resolvedPersonId },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.personSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const finalized = await tx.candidate.updateMany({
      where: {
        id: candidate.id,
        tenantId: row.tenantId,
        status: 'accepted',
        version: input.expectedVersion,
        aclVersion: candidate.aclVersion,
      },
      data: { payload: personPayload(updatedRow), version: { increment: 1 } },
    });
    if (finalized.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: updatedRow,
      candidateId: candidate.id,
      candidateVersion: input.expectedVersion + 1,
      created: false,
    };
  });
}

export async function claimRelationCandidate(
  db: DbClient,
  input: ClaimRelationCandidateInput,
): Promise<RelationCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    await requireCandidateReviewAccess(tx, input.tenantId, REL_SOURCE_KIND, input.id, input.review);
    const row = await tx.relSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) throw new ScopedNotFoundError();
    if (row.status !== 'pending') throw new CandidateWriteConflictError();
    const candidate = await ensureRelationCandidate(tx, row);
    if (candidate.status !== 'pending') throw new CandidateWriteConflictError();
    const changed = await tx.relSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'pending' },
      data: { status: 'accepted' },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.relSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const claimed = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: row.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'accepted',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: relationPayload(updatedRow),
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: updatedRow,
      candidateId: candidate.id,
      candidateVersion: candidate.version + 1,
      created: false,
    };
  });
}

export async function finalizeRelationCandidate(
  db: DbClient,
  input: FinalizeRelationCandidateInput,
): Promise<RelationCandidateReceipt> {
  return inTransaction(db, async (tx) => {
    const row = await tx.relSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row) throw new ScopedNotFoundError();
    if (row.status !== 'accepted') throw new CandidateWriteConflictError();
    const accountId = await requireMatterAccount(tx, row.tenantId, row.opportunityId);
    await requirePerson(tx, row.tenantId, accountId, input.sourcePersonId);
    await requirePerson(tx, row.tenantId, accountId, input.targetPersonId);
    const candidate = await ensureRelationCandidate(tx, row);
    if (candidate.status !== 'accepted' || candidate.version !== input.expectedVersion) {
      throw new CandidateWriteConflictError();
    }
    const changed = await tx.relSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'accepted' },
      data: {
        sourceKind: 'person',
        sourcePersonId: input.sourcePersonId,
        targetKind: 'person',
        targetPersonId: input.targetPersonId,
        layer: input.layer,
        label: input.label,
      },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.relSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const finalized = await tx.candidate.updateMany({
      where: {
        id: candidate.id,
        tenantId: row.tenantId,
        status: 'accepted',
        version: input.expectedVersion,
        aclVersion: candidate.aclVersion,
      },
      data: { payload: relationPayload(updatedRow), version: { increment: 1 } },
    });
    if (finalized.count !== 1) throw new CandidateWriteConflictError();
    return {
      row: updatedRow,
      candidateId: candidate.id,
      candidateVersion: input.expectedVersion + 1,
      created: false,
    };
  });
}

export async function rejectPersonCandidate(db: DbClient, input: RejectCandidateInput): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    try {
      await requireCandidateReviewAccess(tx, input.tenantId, PERSON_SOURCE_KIND, input.id, input.review);
    } catch (error) {
      if (isScopedNotFound(error)) return false;
      throw error;
    }
    const row = await tx.personSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending' || row.resolvedPersonId) return false;
    const candidate = await ensurePersonCandidate(tx, row);
    if (candidate.status !== 'pending') return false;
    const changed = await tx.personSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'pending', resolvedPersonId: null },
      data: { status: 'rejected' },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.personSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const rejected = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: row.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'rejected',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: personPayload(updatedRow),
        version: { increment: 1 },
      },
    });
    if (rejected.count !== 1) throw new CandidateWriteConflictError();
    return true;
  });
}

export async function rejectRelationCandidate(db: DbClient, input: RejectCandidateInput): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    try {
      await requireCandidateReviewAccess(tx, input.tenantId, REL_SOURCE_KIND, input.id, input.review);
    } catch (error) {
      if (isScopedNotFound(error)) return false;
      throw error;
    }
    const row = await tx.relSuggestion.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!row || row.status !== 'pending') return false;
    const candidate = await ensureRelationCandidate(tx, row);
    if (candidate.status !== 'pending') return false;
    const changed = await tx.relSuggestion.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: 'pending' },
      data: { status: 'rejected' },
    });
    if (changed.count !== 1) throw new CandidateWriteConflictError();
    const updatedRow = await tx.relSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: row.tenantId } });
    const rejected = await tx.candidate.updateMany({
      where: {
        id: candidate.id, tenantId: row.tenantId, status: 'pending',
        version: candidate.version, aclVersion: candidate.aclVersion,
      },
      data: {
        status: 'rejected',
        dedupeKey: terminalDedupeKey(candidate.id),
        payload: relationPayload(updatedRow),
        version: { increment: 1 },
      },
    });
    if (rejected.count !== 1) throw new CandidateWriteConflictError();
    return true;
  });
}

export async function redirectCandidatePersonReferences(
  db: DbClient,
  input: RedirectCandidatePersonReferencesInput,
): Promise<RedirectCandidatePersonReferencesReceipt> {
  return inTransaction(db, async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: input.accountId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!account) throw new ScopedNotFoundError();
    const target = await tx.person.findFirst({
      where: { id: input.toPersonId, tenantId: input.tenantId, accountId: input.accountId },
      select: { id: true },
    });
    if (!target) throw new ScopedNotFoundError();
    if (input.from.kind === 'suggestion') {
      await requireCandidateReviewAccess(
        tx, input.tenantId, PERSON_SOURCE_KIND, input.from.id, input.review,
      );
      const source = await tx.personSuggestion.findFirst({
        where: { id: input.from.id, tenantId: input.tenantId, accountId: input.accountId },
        select: { id: true },
      });
      if (!source) throw new ScopedNotFoundError();
    } else {
      const source = await tx.person.findFirst({
        where: { id: input.from.id, tenantId: input.tenantId, accountId: input.accountId },
        select: { id: true },
      });
      if (!source) throw new ScopedNotFoundError();
    }
    const matters = await tx.opportunity.findMany({
      where: { tenantId: input.tenantId, accountId: input.accountId },
      select: { id: true },
    });
    const matterIds = matters.map((matter) => matter.id);
    const relationRefs = matterIds.length
      ? await tx.relSuggestion.findMany({
          where: {
            tenantId: input.tenantId,
            opportunityId: { in: matterIds },
            ...(input.from.kind === 'suggestion' ? { status: 'pending' } : {}),
            OR: [
              { sourceKind: input.from.kind, sourcePersonId: input.from.id },
              { targetKind: input.from.kind, targetPersonId: input.from.id },
            ],
          },
          select: { id: true },
        })
      : [];
    let relationSources = 0;
    let relationTargets = 0;
    for (const ref of relationRefs) {
      await requireCandidateReviewAccess(tx, input.tenantId, REL_SOURCE_KIND, ref.id, input.review);
      const row = await tx.relSuggestion.findFirst({ where: { id: ref.id, tenantId: input.tenantId } });
      if (!row) throw new CandidateWriteConflictError();
      const candidate = await ensureRelationCandidate(tx, row, { allowArchived: true });
      const patch: Prisma.RelSuggestionUpdateManyMutationInput = {};
      if (row.sourceKind === input.from.kind && row.sourcePersonId === input.from.id) {
        patch.sourceKind = 'person';
        patch.sourcePersonId = input.toPersonId;
        relationSources += 1;
      }
      if (row.targetKind === input.from.kind && row.targetPersonId === input.from.id) {
        patch.targetKind = 'person';
        patch.targetPersonId = input.toPersonId;
        relationTargets += 1;
      }
      const changed = await tx.relSuggestion.updateMany({
        where: { id: row.id, tenantId: input.tenantId },
        data: patch,
      });
      if (changed.count !== 1) throw new CandidateWriteConflictError();
      const updatedRow = await tx.relSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: input.tenantId } });
      const synced = await tx.candidate.updateMany({
        where: {
          id: candidate.id, tenantId: input.tenantId,
          version: candidate.version, aclVersion: candidate.aclVersion,
        },
        data: { payload: relationPayload(updatedRow), version: { increment: 1 } },
      });
      if (synced.count !== 1) throw new CandidateWriteConflictError();
    }

    let resolvedPersons = 0;
    if (input.from.kind === 'person') {
      const personRefs = await tx.personSuggestion.findMany({
        where: { tenantId: input.tenantId, accountId: input.accountId, resolvedPersonId: input.from.id },
        select: { id: true },
      });
      for (const ref of personRefs) {
        await requireCandidateReviewAccess(tx, input.tenantId, PERSON_SOURCE_KIND, ref.id, input.review);
        const row = await tx.personSuggestion.findFirst({ where: { id: ref.id, tenantId: input.tenantId } });
        if (!row) throw new CandidateWriteConflictError();
        const candidate = await ensurePersonCandidate(tx, row, { allowArchived: true });
        const changed = await tx.personSuggestion.updateMany({
          where: { id: row.id, tenantId: input.tenantId, resolvedPersonId: input.from.id },
          data: { resolvedPersonId: input.toPersonId },
        });
        if (changed.count !== 1) throw new CandidateWriteConflictError();
        const updatedRow = await tx.personSuggestion.findFirstOrThrow({ where: { id: row.id, tenantId: input.tenantId } });
        const synced = await tx.candidate.updateMany({
          where: {
            id: candidate.id, tenantId: input.tenantId,
            version: candidate.version, aclVersion: candidate.aclVersion,
          },
          data: { payload: personPayload(updatedRow), version: { increment: 1 } },
        });
        if (synced.count !== 1) throw new CandidateWriteConflictError();
        resolvedPersons += 1;
      }
    }
    return { relationSources, relationTargets, resolvedPersons };
  });
}
