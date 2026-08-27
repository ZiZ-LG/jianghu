import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ResearchBriefSnapshotDetailResponseSchema,
  ResearchBriefSnapshotListResponseSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type ResearchBriefPreparedPayload,
  type ResearchBriefSnapshotDetailResponse,
  type ResearchBriefSnapshotListResponse,
  type ResearchBriefSource,
} from '@jianghu/domain-contracts';
import { dec, enc } from '../ai.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import {
  authorizeSensitiveResource,
  sourceArtifactDescriptor,
} from '../sensitiveAccess.js';
import {
  SOURCE_ARTIFACT_METADATA_SELECT,
  sourceArtifactMetadataIsValid,
} from '../sourceArtifacts/service.js';
import {
  deriveResearchBriefMetadata,
  hashResearchBriefPayload,
  serializeResearchBriefPayload,
  validateResearchBriefPreparedPayload,
} from './model.js';

const TRANSACTION_ATTEMPTS = 3;

export class ResearchBriefError extends Error {
  readonly scopedNotFound: boolean;
  constructor(readonly code: string, readonly statusCode = 400, scopedNotFound = false) {
    super(code);
    this.name = 'ResearchBriefError';
    this.scopedNotFound = scopedNotFound;
  }
}

export interface CommitResearchBriefInput {
  tenantId: string;
  actorId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  customerId: string;
  matterId: string | null;
  generationKey: string;
  generatedAt: Date;
  payload: ResearchBriefPreparedPayload;
}

export interface ResearchBriefReadContext {
  tenantId: string;
  actorId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface ListResearchBriefInput {
  customerId: string;
  matterId?: string;
  cursor?: string;
  limit: number;
}

interface ResearchBriefParentAuthority {
  customer: { id: string; version: number; unifiedCreditCode: string | null };
  matter: { id: string; accountId: string; version: number } | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function canonicalScalar(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalScalar);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalScalar(entry)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalScalar(value)));
}

export function researchBriefCrmFactFingerprint(input: {
  kind: 'customer' | 'matter';
  id: string;
  version: number;
}): string {
  return fingerprint({ authority: 'crm_fact_v1', ...input });
}

export function researchBriefCuratedSummaryFingerprint(input: {
  id: string;
  entityKind: string;
  entityId: string;
  content: string;
  model: string;
  basedOnAt: Date | null;
  editedByHuman: boolean;
  editedBy: string;
  aclVersion: number;
}): string {
  return fingerprint({
    authority: 'curated_summary_v1',
    id: input.id,
    entityKind: input.entityKind,
    entityId: input.entityId,
    content: input.content,
    model: input.model,
    basedOnAt: input.basedOnAt,
    editedByHuman: input.editedByHuman,
    editedBy: input.editedBy,
    aclVersion: input.aclVersion,
  });
}

function scopedNotFound(): never {
  throw new ResearchBriefError('research_brief_not_found', 404, true);
}

function conflict(code: string): never {
  throw new ResearchBriefError(code, 409);
}

function validVisibleReference(value: string, minLength = 1): boolean {
  return value.length >= minLength
    && value.length <= 200
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function generationKeyHash(value: string): string {
  if (!validVisibleReference(value, 8)) {
    throw new ResearchBriefError('research_brief_generation_key_invalid', 400);
  }
  return sha256(value);
}

function snapshotIdFromGenerationHash(
  tenantId: string,
  actorId: string,
  keyHash: string,
): string {
  return `rbs_${sha256(JSON.stringify([
    'research-brief-snapshot-v1', tenantId, actorId, keyHash,
  ])).slice(0, 32)}`;
}

export function researchBriefSnapshotId(
  tenantId: string,
  actorId: string,
  generationKey: string,
): string {
  if (!validVisibleReference(tenantId) || !validVisibleReference(actorId)) {
    throw new ResearchBriefError('research_brief_input_invalid', 400);
  }
  return snapshotIdFromGenerationHash(tenantId, actorId, generationKeyHash(generationKey));
}

function isRootClient(db: DbClient): db is PrismaClient {
  return typeof (db as Partial<PrismaClient>).$transaction === 'function';
}

function prismaCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function retryable(error: unknown): boolean {
  const code = prismaCode(error);
  if (code === 'P2034' || code === 'P1008' || code === 'P2028') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('database is locked') || message.includes('transaction already closed');
}

const pause = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 15 * attempt));

async function requireParentAuthority(
  db: DbClient,
  input: Pick<CommitResearchBriefInput, 'tenantId' | 'actorId' | 'actorRole' | 'customerId' | 'matterId'>,
  policy: CapabilityPolicy,
): Promise<ResearchBriefParentAuthority> {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new ResearchBriefError('capability_denied', 403);
  }
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: input.tenantId,
    userId: input.actorId,
    role: input.actorRole,
  });
  if (!scope.valid) scopedNotFound();
  if (scope.actorRole === 'viewer') throw new ResearchBriefError('viewer_write_denied', 403);

  const customer = await db.account.findFirst({
    where: { id: input.customerId, tenantId: input.tenantId, archivedAt: null },
    select: { id: true, version: true, unifiedCreditCode: true },
  });
  if (!customer) scopedNotFound();

  if (input.matterId === null) {
    if (!scope.canReadAccountData(customer.id)) scopedNotFound();
    return { customer, matter: null };
  }

  const matter = await db.opportunity.findFirst({
    where: {
      id: input.matterId,
      tenantId: input.tenantId,
      accountId: customer.id,
      archivedAt: null,
      account: { tenantId: input.tenantId, archivedAt: null },
    },
    select: { id: true, accountId: true, version: true },
  });
  if (!matter || !scope.canReadMatter(matter.id)) scopedNotFound();
  return { customer, matter };
}

function requireLocalSubjectAnchor(source: ResearchBriefSource, customerId: string): void {
  if (source.subjectAnchor !== `crm_customer:${customerId}`) {
    conflict('research_brief_source_subject_conflict');
  }
}

function requireExactSourceAuthority(
  source: ResearchBriefSource,
  expected: { refId: string; version: number; fingerprint: string },
): void {
  if (source.refId !== expected.refId || source.version !== expected.version) {
    conflict('research_brief_source_version_conflict');
  }
  if (source.fingerprint !== expected.fingerprint) {
    conflict('research_brief_source_fingerprint_conflict');
  }
}

async function requireCrmFactSource(
  source: ResearchBriefSource,
  parent: ResearchBriefParentAuthority,
): Promise<void> {
  requireLocalSubjectAnchor(source, parent.customer.id);
  const customerRef = `${parent.customer.id}@${parent.customer.version}`;
  if (source.refId === `${parent.customer.id}@${source.version}`) {
    requireExactSourceAuthority(source, {
      refId: customerRef,
      version: parent.customer.version,
      fingerprint: researchBriefCrmFactFingerprint({
        kind: 'customer', id: parent.customer.id, version: parent.customer.version,
      }),
    });
    return;
  }
  if (parent.matter && source.refId === `${parent.matter.id}@${source.version}`) {
    requireExactSourceAuthority(source, {
      refId: `${parent.matter.id}@${parent.matter.version}`,
      version: parent.matter.version,
      fingerprint: researchBriefCrmFactFingerprint({
        kind: 'matter', id: parent.matter.id, version: parent.matter.version,
      }),
    });
    return;
  }
  conflict('research_brief_source_version_conflict');
}

async function requireSourceArtifact(
  db: DbClient,
  input: CommitResearchBriefInput,
  policy: CapabilityPolicy,
  source: ResearchBriefSource,
): Promise<void> {
  requireLocalSubjectAnchor(source, input.customerId);
  const row = await db.sourceArtifact.findFirst({
    where: { id: source.refId, tenantId: input.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!row || !sourceArtifactMetadataIsValid(row)
    || row.retentionState === 'deleted' || row.retentionState === 'degraded'
    || row.accountId !== input.customerId
    || (row.matterId !== null && row.matterId !== input.matterId)) {
    scopedNotFound();
  }
  const access = await authorizeSensitiveResource(db, {
    tenantId: input.tenantId,
    userId: input.actorId,
    role: input.actorRole,
  }, policy, sourceArtifactDescriptor(row), 'read');
  if (!access.allowed) scopedNotFound();
  requireExactSourceAuthority(source, {
    refId: row.id,
    version: row.aclVersion,
    fingerprint: row.sourceFingerprint,
  });
}

async function requireCuratedSource(
  db: DbClient,
  input: CommitResearchBriefInput,
  source: ResearchBriefSource,
): Promise<void> {
  requireLocalSubjectAnchor(source, input.customerId);
  const row = await db.curatedSummary.findFirst({
    where: { id: source.refId, tenantId: input.tenantId },
    select: {
      id: true, tenantId: true, entityKind: true, entityId: true, content: true,
      model: true, basedOnAt: true, editedByHuman: true, editedBy: true,
      aclVersion: true, createdAt: true, updatedAt: true,
    },
  });
  if (!row) scopedNotFound();
  const currentParent = row.entityKind === 'account' && row.entityId === input.customerId
    || row.entityKind === 'opportunity' && row.entityId === input.matterId;
  if (!currentParent) scopedNotFound();

  if (!row.content.trim()) conflict('research_brief_source_content_invalid');
  if (source.kind === 'curated_human') {
    if (!row.editedByHuman || !row.editedBy) conflict('research_brief_source_kind_conflict');
    const editor = await db.user.findFirst({
      where: { id: row.editedBy, tenantId: input.tenantId }, select: { id: true },
    });
    if (!editor) conflict('research_brief_source_attribution_invalid');
  } else if (row.editedByHuman || row.aclVersion < 1 || !row.model.trim()) {
    conflict('research_brief_source_kind_conflict');
  }

  requireExactSourceAuthority(source, {
    refId: row.id,
    version: row.aclVersion,
    fingerprint: researchBriefCuratedSummaryFingerprint(row),
  });
}

async function requirePreparedSources(
  db: DbClient,
  input: CommitResearchBriefInput,
  policy: CapabilityPolicy,
  payload: ResearchBriefPreparedPayload,
  parent: ResearchBriefParentAuthority,
): Promise<void> {
  for (const source of payload.sources) {
    if (source.kind === 'crm_fact') {
      await requireCrmFactSource(source, parent);
    } else if (source.kind === 'source_artifact') {
      await requireSourceArtifact(db, input, policy, source);
    } else if (source.kind === 'curated_human' || source.kind === 'curated_ai_cache') {
      await requireCuratedSource(db, input, source);
    }
  }
}

function exactSelectedSubject(
  input: CommitResearchBriefInput,
  payload: ResearchBriefPreparedPayload,
  parent: ResearchBriefParentAuthority,
): void {
  if (payload.subject.crmCustomerId !== input.customerId) {
    throw new ResearchBriefError('research_brief_subject_invalid', 400);
  }
  if (payload.subject.status === 'matched'
    && payload.subject.selected?.anchorKind === 'unified_credit_code'
    && parent.customer.unifiedCreditCode
    && payload.subject.selected.anchorValue !== parent.customer.unifiedCreditCode) {
    conflict('research_brief_subject_conflict');
  }
}

type SnapshotInsert = Prisma.ResearchBriefSnapshotGetPayload<Record<string, never>>;

function replayResult(
  existing: SnapshotInsert,
  expected: {
    id: string;
    customerId: string;
    matterId: string | null;
    payloadFingerprint: string;
    payloadSerialized: string;
    sourceSetHash: string;
    generatedAt: Date;
    basedOnAt: Date | null;
    freshUntil: Date | null;
    status: string;
    subjectStatus: string;
    sourceCount: number;
    sectionCount: number;
    unknownCount: number;
    failureCount: number;
  },
): { id: string; version: number; replayed: true } {
  const exact = existing.id === expected.id
    && existing.customerId === expected.customerId
    && existing.matterId === expected.matterId
    && existing.payloadFingerprint === expected.payloadFingerprint
    && dec(existing.payloadEnc) === expected.payloadSerialized
    && existing.sourceSetHash === expected.sourceSetHash
    && existing.generatedAt.getTime() === expected.generatedAt.getTime()
    && existing.basedOnAt?.getTime() === expected.basedOnAt?.getTime()
    && existing.freshUntil?.getTime() === expected.freshUntil?.getTime()
    && existing.generatedAt.getTime() <= existing.createdAt.getTime()
    && existing.status === expected.status
    && existing.subjectStatus === expected.subjectStatus
    && existing.sourceCount === expected.sourceCount
    && existing.sectionCount === expected.sectionCount
    && existing.unknownCount === expected.unknownCount
    && existing.failureCount === expected.failureCount
    && existing.version === 1;
  if (!exact) conflict('research_brief_idempotency_conflict');
  return { id: existing.id, version: existing.version, replayed: true };
}

async function commitInsideTransaction(
  tx: DbClient,
  input: CommitResearchBriefInput,
  policy: CapabilityPolicy,
  prepared: ResearchBriefPreparedPayload,
  keyHash: string,
  payloadFingerprint: string,
  payloadSerialized: string,
) {
  const parent = await requireParentAuthority(tx, input, policy);
  exactSelectedSubject(input, prepared, parent);
  await requirePreparedSources(tx, input, policy, prepared, parent);
  const metadata = deriveResearchBriefMetadata(prepared, input.generatedAt);
  if (input.generatedAt.getTime() > Date.now()) {
    throw new ResearchBriefError('research_brief_timestamp_invalid', 400);
  }

  const id = snapshotIdFromGenerationHash(input.tenantId, input.actorId, keyHash);
  const expected = {
    id,
    customerId: input.customerId,
    matterId: input.matterId,
    payloadFingerprint,
    payloadSerialized,
    generatedAt: input.generatedAt,
    ...metadata,
  };
  const existing = await tx.researchBriefSnapshot.findUnique({
    where: {
      tenantId_createdByUserId_generationKey: {
        tenantId: input.tenantId,
        createdByUserId: input.actorId,
        generationKey: keyHash,
      },
    },
  });
  if (existing) return replayResult(existing, expected);

  const createdAt = new Date();
  const row = await tx.researchBriefSnapshot.create({ data: {
    id,
    tenantId: input.tenantId,
    customerId: input.customerId,
    matterId: input.matterId,
    createdByUserId: input.actorId,
    generationKey: keyHash,
    status: metadata.status,
    subjectStatus: metadata.subjectStatus,
    payloadEnc: enc(payloadSerialized),
    payloadFingerprint,
    sourceSetHash: metadata.sourceSetHash,
    sourceCount: metadata.sourceCount,
    sectionCount: metadata.sectionCount,
    unknownCount: metadata.unknownCount,
    failureCount: metadata.failureCount,
    version: 1,
    basedOnAt: metadata.basedOnAt,
    freshUntil: metadata.freshUntil,
    generatedAt: input.generatedAt,
    createdAt,
  } });
  await tx.auditEvent.create({ data: {
    id: randomUUID(),
    tenantId: input.tenantId,
    actorId: input.actorId,
    channel: 'agent',
    action: 'research_brief_snapshot_created',
    entityKind: 'ResearchBriefSnapshot',
    entityId: row.id,
    requestId: null,
    sourceRef: null,
    changedFields: '[]',
    metadata: JSON.stringify({
      version: row.version,
      status: row.status,
      subjectStatus: row.subjectStatus,
      payloadFingerprint: row.payloadFingerprint,
      sourceSetHash: row.sourceSetHash,
      sourceCount: row.sourceCount,
      sectionCount: row.sectionCount,
      unknownCount: row.unknownCount,
      failureCount: row.failureCount,
    }),
    createdAt,
  } });
  return { id: row.id, version: row.version, replayed: false as const };
}

export async function commitResearchBriefSnapshot(
  db: DbClient,
  input: CommitResearchBriefInput,
  policy: CapabilityPolicy,
): Promise<{ id: string; version: number; replayed: boolean }> {
  if (!validVisibleReference(input.tenantId)
    || !validVisibleReference(input.actorId)
    || !validVisibleReference(input.customerId)
    || (input.matterId !== null && !validVisibleReference(input.matterId))) {
    throw new ResearchBriefError('research_brief_input_invalid', 400);
  }
  const prepared = validateResearchBriefPreparedPayload(input.payload);
  const keyHash = generationKeyHash(input.generationKey);
  const payloadSerialized = serializeResearchBriefPayload(prepared);
  const payloadFingerprint = hashResearchBriefPayload(prepared);
  if (!isRootClient(db)) {
    return commitInsideTransaction(
      db, input, policy, prepared, keyHash, payloadFingerprint, payloadSerialized,
    );
  }

  for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        (tx) => commitInsideTransaction(
          tx, input, policy, prepared, keyHash, payloadFingerprint, payloadSerialized,
        ),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 30_000 },
      );
    } catch (error) {
      if ((prismaCode(error) === 'P2002' || retryable(error)) && attempt < TRANSACTION_ATTEMPTS) {
        await pause(attempt);
        continue;
      }
      throw error;
    }
  }
  throw new ResearchBriefError('research_brief_retry_exhausted', 503);
}

type ResearchBriefSnapshotRow = Prisma.ResearchBriefSnapshotGetPayload<Record<string, never>>;

async function currentReadScope(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
) {
  if (!capabilityPolicyAllows(policy, { entitlement: 'sales.workspace' })) {
    throw new ResearchBriefError('capability_denied', 403);
  }
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: context.tenantId,
    userId: context.actorId,
    role: context.actorRole,
  });
  if (!scope.valid) scopedNotFound();
  return scope;
}

async function readableParent(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  customerId: string,
  matterId: string | null,
): Promise<ResearchBriefParentAuthority> {
  const scope = await currentReadScope(db, context, policy);
  const customer = await db.account.findFirst({
    where: { id: customerId, tenantId: context.tenantId, archivedAt: null },
    select: { id: true, version: true, unifiedCreditCode: true },
  });
  if (!customer) scopedNotFound();
  if (matterId === null) {
    if (!scope.canReadAccountData(customer.id)) scopedNotFound();
    return { customer, matter: null };
  }
  const matter = await db.opportunity.findFirst({
    where: {
      id: matterId,
      tenantId: context.tenantId,
      accountId: customer.id,
      archivedAt: null,
      account: { tenantId: context.tenantId, archivedAt: null },
    },
    select: { id: true, accountId: true, version: true },
  });
  if (!matter || !scope.canReadMatter(matter.id)) scopedNotFound();
  return { customer, matter };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function metadataProjection(row: ResearchBriefSnapshotRow) {
  return {
    id: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    status: row.status,
    subjectStatus: row.subjectStatus,
    sourceCount: row.sourceCount,
    sectionCount: row.sectionCount,
    unknownCount: row.unknownCount,
    failureCount: row.failureCount,
    version: row.version,
    basedOnAt: iso(row.basedOnAt),
    freshUntil: iso(row.freshUntil),
    generatedAt: row.generatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

interface CursorAuthority {
  generatedAt: Date;
  id: string;
}

function encodeCursor(row: CursorAuthority): string {
  return Buffer.from(JSON.stringify([row.generatedAt.toISOString(), row.id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorAuthority {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || !validVisibleReference(parsed[1])) {
      throw new Error('invalid');
    }
    const generatedAt = new Date(parsed[0]);
    if (!Number.isFinite(generatedAt.getTime()) || generatedAt.toISOString() !== parsed[0]) {
      throw new Error('invalid');
    }
    return { generatedAt, id: parsed[1] };
  } catch {
    throw new ResearchBriefError('research_brief_cursor_invalid', 400);
  }
}

export async function listResearchBriefSnapshots(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  input: ListResearchBriefInput,
): Promise<ResearchBriefSnapshotListResponse> {
  if (!validVisibleReference(input.customerId)
    || (input.matterId !== undefined && !validVisibleReference(input.matterId))
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new ResearchBriefError('research_brief_query_invalid', 400);
  }
  const scope = await currentReadScope(db, context, policy);
  const customer = await db.account.findFirst({
    where: { id: input.customerId, tenantId: context.tenantId, archivedAt: null },
    select: { id: true },
  });
  if (!customer) return { items: [], nextCursor: null };

  const accessibleMatterRows = scope.matterIds.size === 0 ? [] : await db.opportunity.findMany({
    where: {
      tenantId: context.tenantId,
      accountId: customer.id,
      id: { in: [...scope.matterIds] },
      archivedAt: null,
      account: { tenantId: context.tenantId, archivedAt: null },
    },
    select: { id: true },
  });
  const accessibleMatterIds = accessibleMatterRows.map((matter) => matter.id);
  const parentOr: Array<Record<string, unknown>> = [];
  if (scope.canReadAccountData(customer.id)) parentOr.push({ matterId: null });
  if (accessibleMatterIds.length > 0) parentOr.push({ matterId: { in: accessibleMatterIds } });
  if (input.matterId !== undefined) {
    if (!accessibleMatterIds.includes(input.matterId)) return { items: [], nextCursor: null };
    parentOr.splice(0, parentOr.length, { matterId: input.matterId });
  }
  if (parentOr.length === 0) return { items: [], nextCursor: null };

  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await db.researchBriefSnapshot.findMany({
    where: {
      tenantId: context.tenantId,
      createdByUserId: context.actorId,
      customerId: input.customerId,
      OR: parentOr,
      ...(cursor ? {
        AND: [{ OR: [
          { generatedAt: { lt: cursor.generatedAt } },
          { generatedAt: cursor.generatedAt, id: { lt: cursor.id } },
        ] }],
      } : {}),
    },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const projected = page.map(metadataProjection);
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;
  const response = ResearchBriefSnapshotListResponseSchema.safeParse({ items: projected, nextCursor });
  if (!response.success) throw new ResearchBriefError('research_brief_snapshot_invalid', 409);
  return response.data;
}

function exactStoredMetadata(
  row: ResearchBriefSnapshotRow,
  payload: ResearchBriefPreparedPayload,
): boolean {
  try {
    const derived = deriveResearchBriefMetadata(payload, row.generatedAt);
    return row.version === 1
      && row.payloadFingerprint === hashResearchBriefPayload(payload)
      && row.sourceSetHash === derived.sourceSetHash
      && row.status === derived.status
      && row.subjectStatus === derived.subjectStatus
      && row.sourceCount === derived.sourceCount
      && row.sectionCount === derived.sectionCount
      && row.unknownCount === derived.unknownCount
      && row.failureCount === derived.failureCount
      && row.basedOnAt?.getTime() === derived.basedOnAt?.getTime()
      && row.freshUntil?.getTime() === derived.freshUntil?.getTime()
      && row.generatedAt.getTime() <= row.createdAt.getTime();
  } catch {
    return false;
  }
}

type CurrentSourceState = 'current' | 'stale' | 'unavailable';

function crmFactIsCurrent(source: ResearchBriefSource, parent: ResearchBriefParentAuthority): boolean {
  const customer = {
    refId: `${parent.customer.id}@${parent.customer.version}`,
    version: parent.customer.version,
    fingerprint: researchBriefCrmFactFingerprint({
      kind: 'customer', id: parent.customer.id, version: parent.customer.version,
    }),
  };
  const matter = parent.matter ? {
    refId: `${parent.matter.id}@${parent.matter.version}`,
    version: parent.matter.version,
    fingerprint: researchBriefCrmFactFingerprint({
      kind: 'matter', id: parent.matter.id, version: parent.matter.version,
    }),
  } : null;
  return [customer, matter].some((expected) => expected !== null
    && source.refId === expected.refId
    && source.version === expected.version
    && source.fingerprint === expected.fingerprint);
}

async function curatedSourceState(
  db: DbClient,
  context: ResearchBriefReadContext,
  source: ResearchBriefSource,
  customerId: string,
  matterId: string | null,
): Promise<CurrentSourceState> {
  const row = await db.curatedSummary.findFirst({
    where: { id: source.refId, tenantId: context.tenantId },
    select: {
      id: true, entityKind: true, entityId: true, content: true, model: true,
      basedOnAt: true, editedByHuman: true, editedBy: true, aclVersion: true,
    },
  });
  if (!row) return 'stale';
  const currentParent = row.entityKind === 'account' && row.entityId === customerId
    || row.entityKind === 'opportunity' && row.entityId === matterId;
  if (!currentParent) return 'stale';
  const exactKind = source.kind === 'curated_human'
    ? row.editedByHuman && Boolean(row.editedBy)
    : !row.editedByHuman && row.aclVersion >= 1 && Boolean(row.model.trim());
  if (!exactKind) return 'stale';
  if (source.kind === 'curated_human') {
    const editor = await db.user.findFirst({
      where: { id: row.editedBy, tenantId: context.tenantId }, select: { id: true },
    });
    if (!editor) return 'stale';
  }
  return source.version === row.aclVersion
    && source.fingerprint === researchBriefCuratedSummaryFingerprint(row)
    ? 'current'
    : 'stale';
}

async function sourceArtifactState(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  source: ResearchBriefSource,
  customerId: string,
  matterId: string | null,
): Promise<CurrentSourceState> {
  const row = await db.sourceArtifact.findFirst({
    where: { id: source.refId, tenantId: context.tenantId },
    select: SOURCE_ARTIFACT_METADATA_SELECT,
  });
  if (!row || !sourceArtifactMetadataIsValid(row)
    || row.retentionState === 'deleted' || row.retentionState === 'degraded'
    || row.accountId !== customerId
    || (row.matterId !== null && row.matterId !== matterId)) {
    return 'unavailable';
  }
  const access = await authorizeSensitiveResource(db, {
    tenantId: context.tenantId,
    userId: context.actorId,
    role: context.actorRole,
  }, policy, sourceArtifactDescriptor(row), 'read');
  if (!access.allowed) return 'unavailable';
  return source.version === row.aclVersion && source.fingerprint === row.sourceFingerprint
    ? 'current'
    : 'unavailable';
}

async function currentSourceState(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  source: ResearchBriefSource,
  parent: ResearchBriefParentAuthority,
): Promise<CurrentSourceState> {
  let state: CurrentSourceState = 'current';
  if (source.kind === 'crm_fact') {
    state = crmFactIsCurrent(source, parent) ? 'current' : 'stale';
  } else if (source.kind === 'curated_human' || source.kind === 'curated_ai_cache') {
    state = await curatedSourceState(db, context, source, parent.customer.id, parent.matter?.id ?? null);
  } else if (source.kind === 'source_artifact') {
    state = await sourceArtifactState(
      db, context, policy, source, parent.customer.id, parent.matter?.id ?? null,
    );
  }
  if (state === 'current' && source.status === 'fresh' && source.freshUntil !== null
    && Date.parse(source.freshUntil) <= Date.now()) {
    return 'stale';
  }
  return state;
}

function redactedSource(source: ResearchBriefSource): ResearchBriefSource {
  const redactedId = `unavailable_${sha256(source.id)}`;
  return {
    ...source,
    id: redactedId,
    refId: redactedId,
    fingerprint: sha256(`research-brief-unavailable-v1:${source.id}`),
    provider: 'jianghu-redacted',
    label: '来源当前不可用',
    url: null,
    observedAt: null,
    freshUntil: null,
    status: 'unavailable',
    failureCode: 'source_unavailable',
  };
}

async function projectedPayload(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  payload: ResearchBriefPreparedPayload,
  parent: ResearchBriefParentAuthority,
): Promise<ResearchBriefPreparedPayload> {
  const states = new Map<string, CurrentSourceState>();
  for (const source of payload.sources) {
    states.set(source.id, await currentSourceState(db, context, policy, source, parent));
  }
  const unavailableIds = new Set([...states]
    .filter(([, state]) => state === 'unavailable')
    .map(([id]) => id));
  const remappedIds = new Map<string, string>();
  const sources = payload.sources.map((source) => {
    const state = states.get(source.id) ?? 'unavailable';
    if (state === 'unavailable') {
      const redacted = redactedSource(source);
      remappedIds.set(source.id, redacted.id);
      return redacted;
    }
    if (state === 'stale' && source.status === 'fresh' && source.freshUntil !== null) {
      return { ...source, status: 'stale' as const };
    }
    return source;
  });
  const remap = (sourceId: string) => remappedIds.get(sourceId) ?? sourceId;
  const sections = payload.sections.filter((section) => (
    section.sourceIds.every((sourceId) => !unavailableIds.has(sourceId))
  ));
  const unavailableSourceIds = [...unavailableIds].sort();
  const revocationUnknowns = unavailableSourceIds.map((sourceId) => ({
    key: `source_unavailable_${sha256(sourceId)}`,
    question: '该来源当前不可访问，请重新授权或改用可验证来源。',
    reasonCode: 'source_unavailable',
    sourceIds: [remap(sourceId)],
  }));
  const revocationUnknownKeys = new Set(revocationUnknowns.map((unknown) => unknown.key));
  const retainedUnknowns = payload.unknowns
    .filter((unknown) => unknown.sourceIds.every((sourceId) => !unavailableIds.has(sourceId)))
    .filter((unknown) => !revocationUnknownKeys.has(unknown.key))
    .slice(0, Math.max(0, 20 - revocationUnknowns.length));
  const unknowns = [...retainedUnknowns, ...revocationUnknowns];

  const revocationFailures = unavailableSourceIds.map((sourceId) => ({
    sourceId: remap(sourceId), code: 'source_unavailable', retryable: false,
  }));
  const retainedFailures = payload.failures
    .filter((failure) => !unavailableIds.has(failure.sourceId))
    .slice(0, Math.max(0, 20 - revocationFailures.length));
  const failures = [...retainedFailures, ...revocationFailures];
  return validateResearchBriefPreparedPayload({
    ...payload,
    sources,
    sections,
    unknowns,
    failures,
  });
}

export async function researchBriefSnapshotDetail(
  db: DbClient,
  context: ResearchBriefReadContext,
  policy: CapabilityPolicy,
  id: string,
): Promise<ResearchBriefSnapshotDetailResponse | null> {
  if (!validVisibleReference(id)) return null;
  await currentReadScope(db, context, policy);
  const row = await db.researchBriefSnapshot.findFirst({
    where: { id, tenantId: context.tenantId, createdByUserId: context.actorId },
  });
  if (!row) return null;
  let parent: ResearchBriefParentAuthority;
  try {
    parent = await readableParent(db, context, policy, row.customerId, row.matterId);
  } catch (error) {
    if (error instanceof ResearchBriefError && error.scopedNotFound) return null;
    throw error;
  }
  const plaintext = dec(row.payloadEnc);
  if (!plaintext) return null;
  let payload: ResearchBriefPreparedPayload;
  try {
    payload = validateResearchBriefPreparedPayload(JSON.parse(plaintext));
  } catch {
    return null;
  }
  if (payload.subject.crmCustomerId !== row.customerId || !exactStoredMetadata(row, payload)) return null;
  const projected = await projectedPayload(db, context, policy, payload, parent);
  const metadata = deriveResearchBriefMetadata(projected, row.generatedAt);
  const response = ResearchBriefSnapshotDetailResponseSchema.safeParse({
    item: {
      id: row.id,
      customerId: row.customerId,
      matterId: row.matterId,
      status: metadata.status,
      subjectStatus: metadata.subjectStatus,
      sourceCount: metadata.sourceCount,
      sectionCount: metadata.sectionCount,
      unknownCount: metadata.unknownCount,
      failureCount: metadata.failureCount,
      version: row.version,
      basedOnAt: iso(metadata.basedOnAt),
      freshUntil: iso(metadata.freshUntil),
      generatedAt: row.generatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      payload: projected,
    },
  });
  return response.success ? response.data : null;
}
