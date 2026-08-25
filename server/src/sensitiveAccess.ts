import {
  capabilityPolicyAllows,
  type CapabilityPolicy,
} from '@jianghu/domain-contracts';
import type { DbClient } from './mutation/scopeGuards.js';
import {
  resolveEffectiveResourceScope,
  type EffectiveResourceScope,
} from './resourceScope.js';
import type { ReadPrincipal, VisibilityRole } from './visibility.js';
import { ScopedNotFoundError } from './mutation/scopeGuards.js';

export const SENSITIVE_RESOURCE_KINDS = [
  'source_artifact', 'transcript', 'note', 'candidate',
] as const;
export const SENSITIVE_VISIBILITIES = [
  'private', 'matter_shared', 'owner_admin_only',
] as const;

export type SensitiveResourceKind = typeof SENSITIVE_RESOURCE_KINDS[number];
export type SensitiveResourceVisibility = typeof SENSITIVE_VISIBILITIES[number];
export type SensitiveAccessIntent = 'read' | 'manage' | 'review';

export interface SensitiveResourceDescriptor {
  kind: SensitiveResourceKind;
  id: string;
  tenantId: string;
  accountId: string | null;
  matterId: string | null;
  personId: string | null;
  createdByUserId: string | null;
  visibility: SensitiveResourceVisibility;
  aclVersion: number;
}

export type SensitiveAccessDenyReason =
  | 'invalid_actor'
  | 'tenant_mismatch'
  | 'invalid_resource_kind'
  | 'invalid_visibility'
  | 'invalid_acl_version'
  | 'invalid_creator'
  | 'invalid_parent'
  | 'parent_scope_denied'
  | 'private_creator_required'
  | 'invalid_quarantine_creator'
  | 'quarantine_role_required'
  | 'shared_permission_required'
  | 'write_role_denied'
  | 'manage_creator_required'
  | 'review_candidate_required'
  | 'reviewer_permission_required'
  | 'reviewer_grant_required';

export interface SensitiveAccessDecision {
  allowed: boolean;
  actorRole: VisibilityRole;
  reason?: SensitiveAccessDenyReason;
}

export interface CandidateReviewAccessContext {
  actorId: string;
  actorRole: VisibilityRole;
  capabilityPolicy: CapabilityPolicy;
}

export interface LegacyCandidateReviewRef {
  sourceKind: 'PersonSuggestion' | 'RelSuggestion' | 'ChangeProposal' | 'Reminder' | 'EvidenceEvent';
  sourceId: string;
}

export interface SensitiveMetadataFields {
  id?: string;
  accountId?: string;
  matterId?: string;
  createdByUserId?: string;
  visibility?: string;
  aclVersion?: string;
}

export interface SensitiveAccessEvaluator {
  readonly scope: EffectiveResourceScope;
  metadataWhere(
    kind: SensitiveResourceKind,
    intent: SensitiveAccessIntent,
    fields?: SensitiveMetadataFields,
  ): Promise<Record<string, unknown>>;
  authorizeMany(
    descriptors: readonly SensitiveResourceDescriptor[],
    intent: SensitiveAccessIntent,
  ): Promise<SensitiveAccessDecision[]>;
}

const deny = (actorRole: VisibilityRole, reason: SensitiveAccessDenyReason): SensitiveAccessDecision => ({
  allowed: false,
  actorRole,
  reason,
});

function isResourceKind(value: string): value is SensitiveResourceKind {
  return (SENSITIVE_RESOURCE_KINDS as readonly string[]).includes(value);
}

function isVisibility(value: string): value is SensitiveResourceVisibility {
  return (SENSITIVE_VISIBILITIES as readonly string[]).includes(value);
}

async function parentIsCurrentAndScoped(
  db: DbClient,
  descriptor: SensitiveResourceDescriptor,
  scope: Awaited<ReturnType<typeof resolveEffectiveResourceScope>>,
): Promise<'ok' | 'invalid_parent' | 'parent_scope_denied'> {
  let effectiveAccountId = descriptor.accountId;
  if (descriptor.matterId) {
    const matter = await db.opportunity.findFirst({
      where: {
        id: descriptor.matterId,
        tenantId: descriptor.tenantId,
        archivedAt: null,
        account: { tenantId: descriptor.tenantId, archivedAt: null },
      },
      select: { accountId: true },
    });
    if (!matter || (effectiveAccountId && matter.accountId !== effectiveAccountId)) return 'invalid_parent';
    effectiveAccountId = matter.accountId;
    if (!scope.canReadMatter(descriptor.matterId)) return 'parent_scope_denied';
  } else if (effectiveAccountId) {
    const account = await db.account.findFirst({
      where: { id: effectiveAccountId, tenantId: descriptor.tenantId, archivedAt: null },
      select: { id: true },
    });
    if (!account) return 'invalid_parent';
    if (!scope.canReadAccountData(effectiveAccountId)) return 'parent_scope_denied';
  }

  if (descriptor.personId) {
    if (!effectiveAccountId) return 'invalid_parent';
    const person = await db.person.findFirst({
      where: {
        id: descriptor.personId,
        tenantId: descriptor.tenantId,
        accountId: effectiveAccountId,
        archivedAt: null,
        mergedIntoPersonId: null,
      },
      select: { id: true },
    });
    if (!person) return 'invalid_parent';
  }
  return 'ok';
}

function decideSensitiveAccess(
  scope: EffectiveResourceScope,
  policy: CapabilityPolicy,
  descriptor: SensitiveResourceDescriptor,
  intent: SensitiveAccessIntent,
  creatorIsCurrent: boolean,
  parent: 'ok' | 'invalid_parent' | 'parent_scope_denied',
  hasReviewerGrant: boolean,
): SensitiveAccessDecision {
  if (scope.tenantId !== descriptor.tenantId) return deny('viewer', 'tenant_mismatch');
  if (!scope.valid) return deny(scope.actorRole, 'invalid_actor');
  if ((intent === 'manage' || intent === 'review') && scope.actorRole === 'viewer') {
    return deny(scope.actorRole, 'write_role_denied');
  }
  if (!isResourceKind(descriptor.kind)) return deny(scope.actorRole, 'invalid_resource_kind');
  if (!isVisibility(descriptor.visibility)) return deny(scope.actorRole, 'invalid_visibility');
  if (!Number.isSafeInteger(descriptor.aclVersion) || descriptor.aclVersion < 1) {
    return deny(scope.actorRole, 'invalid_acl_version');
  }
  if (parent !== 'ok') return deny(scope.actorRole, parent);
  if (descriptor.visibility === 'matter_shared' && !descriptor.matterId) {
    return deny(scope.actorRole, 'invalid_parent');
  }
  if ((!descriptor.createdByUserId && descriptor.visibility !== 'owner_admin_only')
    || (descriptor.createdByUserId && descriptor.visibility === 'owner_admin_only')) {
    return deny(scope.actorRole, 'invalid_quarantine_creator');
  }
  if (descriptor.createdByUserId && !creatorIsCurrent) {
    return deny(scope.actorRole, 'invalid_creator');
  }

  const isCreator = Boolean(descriptor.createdByUserId)
    && descriptor.createdByUserId === scope.actorUserId;
  const isQuarantineAdmin = !descriptor.createdByUserId
    && (scope.actorRole === 'owner' || scope.actorRole === 'admin');

  if (intent === 'manage') {
    if (descriptor.visibility === 'owner_admin_only') {
      if (descriptor.createdByUserId) return deny(scope.actorRole, 'invalid_quarantine_creator');
      return isQuarantineAdmin
        ? { allowed: true, actorRole: scope.actorRole }
        : deny(scope.actorRole, 'quarantine_role_required');
    }
    return isCreator
      ? { allowed: true, actorRole: scope.actorRole }
      : deny(scope.actorRole, 'manage_creator_required');
  }

  if (descriptor.visibility === 'private') {
    if (!isCreator) return deny(scope.actorRole, 'private_creator_required');
  } else if (descriptor.visibility === 'owner_admin_only') {
    if (descriptor.createdByUserId) return deny(scope.actorRole, 'invalid_quarantine_creator');
    if (!isQuarantineAdmin) return deny(scope.actorRole, 'quarantine_role_required');
  } else if (!isCreator && !capabilityPolicyAllows(policy, { permission: 'source.read_shared' })) {
    return deny(scope.actorRole, 'shared_permission_required');
  }

  if (intent === 'read') return { allowed: true, actorRole: scope.actorRole };
  if (descriptor.kind !== 'candidate') return deny(scope.actorRole, 'review_candidate_required');
  if (isCreator || isQuarantineAdmin) return { allowed: true, actorRole: scope.actorRole };
  if (!capabilityPolicyAllows(policy, { permission: 'candidate.review_shared' })) {
    return deny(scope.actorRole, 'reviewer_permission_required');
  }
  return hasReviewerGrant
    ? { allowed: true, actorRole: scope.actorRole }
    : deny(scope.actorRole, 'reviewer_grant_required');
}

/**
 * The single sensitive-resource decision point. Callers pass metadata only; the helper
 * deliberately cannot load Note bodies, Transcript ciphertext or Candidate payload/evidence.
 */
export async function authorizeSensitiveResource(
  db: DbClient,
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
  descriptor: SensitiveResourceDescriptor,
  intent: SensitiveAccessIntent,
): Promise<SensitiveAccessDecision> {
  if (principal.tenantId !== descriptor.tenantId) return deny('viewer', 'tenant_mismatch');
  const scope = await resolveEffectiveResourceScope(db, principal);
  if (!scope.valid) return deny(scope.actorRole, 'invalid_actor');
  if ((intent === 'manage' || intent === 'review') && scope.actorRole === 'viewer') {
    return deny(scope.actorRole, 'write_role_denied');
  }
  if (!isResourceKind(descriptor.kind)) return deny(scope.actorRole, 'invalid_resource_kind');
  if (!isVisibility(descriptor.visibility)) return deny(scope.actorRole, 'invalid_visibility');
  if (!Number.isSafeInteger(descriptor.aclVersion) || descriptor.aclVersion < 1) {
    return deny(scope.actorRole, 'invalid_acl_version');
  }
  if (descriptor.visibility === 'matter_shared' && !descriptor.matterId) {
    return deny(scope.actorRole, 'invalid_parent');
  }
  if ((!descriptor.createdByUserId && descriptor.visibility !== 'owner_admin_only')
    || (descriptor.createdByUserId && descriptor.visibility === 'owner_admin_only')) {
    return deny(scope.actorRole, 'invalid_quarantine_creator');
  }
  const creator = descriptor.createdByUserId
    ? await db.user.findFirst({
        where: { id: descriptor.createdByUserId, tenantId: descriptor.tenantId },
        select: { id: true },
      })
    : null;
  if (descriptor.createdByUserId && !creator) return deny(scope.actorRole, 'invalid_creator');
  const parent = await parentIsCurrentAndScoped(db, descriptor, scope);
  const needsGrant = intent === 'review'
    && descriptor.kind === 'candidate'
    && descriptor.createdByUserId !== scope.actorUserId
    && descriptor.createdByUserId !== null
    && descriptor.visibility === 'matter_shared';
  const grant = needsGrant ? await db.sensitiveResourceGrant.findFirst({
    where: {
      tenantId: descriptor.tenantId,
      resourceKind: 'candidate',
      resourceId: descriptor.id,
      granteeUserId: scope.actorUserId,
      grantKind: 'reviewer',
      resourceAclVersion: descriptor.aclVersion,
      revokedAt: null,
    },
    select: { id: true },
  }) : null;
  return decideSensitiveAccess(
    scope,
    policy,
    descriptor,
    intent,
    descriptor.createdByUserId === null || Boolean(creator),
    parent,
    Boolean(grant),
  );
}

/**
 * Request/transaction-local batch evaluator. It reloads current actor/scope once in the
 * caller's snapshot, batches parent/grant metadata, and never survives beyond that call.
 */
export async function createSensitiveAccessEvaluator(
  db: DbClient,
  principal: ReadPrincipal,
  policy: CapabilityPolicy,
): Promise<SensitiveAccessEvaluator> {
  const scope = await resolveEffectiveResourceScope(db, principal);
  let reviewerGrantsPromise: Promise<Array<{ resourceId: string; resourceAclVersion: number }>> | null = null;
  const reviewerGrants = () => {
    reviewerGrantsPromise ??= db.sensitiveResourceGrant.findMany({
      where: {
        tenantId: scope.tenantId,
        resourceKind: 'candidate',
        granteeUserId: scope.actorUserId,
        grantKind: 'reviewer',
        revokedAt: null,
      },
      select: { resourceId: true, resourceAclVersion: true },
    });
    return reviewerGrantsPromise;
  };

  const metadataWhere = async (
    kind: SensitiveResourceKind,
    intent: SensitiveAccessIntent,
    fields: SensitiveMetadataFields = {},
  ): Promise<Record<string, unknown>> => {
    const idField = fields.id ?? 'id';
    const accountField = fields.accountId ?? 'accountId';
    const matterField = fields.matterId ?? 'matterId';
    const creatorField = fields.createdByUserId ?? 'createdByUserId';
    const visibilityField = fields.visibility ?? 'visibility';
    const aclVersionField = fields.aclVersion ?? 'aclVersion';
    const impossible = { [idField]: { in: [] as string[] } };
    if (!scope.valid || ((intent === 'manage' || intent === 'review') && scope.actorRole === 'viewer')) {
      return impossible;
    }
    if (intent === 'review' && kind !== 'candidate') return impossible;

    const parentOr: Array<Record<string, unknown>> = [
      { [matterField]: { in: [...scope.matterIds] } },
      { [matterField]: null, [accountField]: { in: [...scope.fullAccountIds] } },
    ];
    if (kind !== 'candidate') {
      parentOr.push({ [matterField]: null, [accountField]: null });
    }
    const aclOr: Array<Record<string, unknown>> = [
      {
        [creatorField]: scope.actorUserId,
        [visibilityField]: { in: ['private', 'matter_shared'] },
      },
    ];
    if (scope.actorRole === 'owner' || scope.actorRole === 'admin') {
      aclOr.push({ [creatorField]: null, [visibilityField]: 'owner_admin_only' });
    }
    if (intent === 'read'
      && capabilityPolicyAllows(policy, { permission: 'source.read_shared' })) {
      aclOr.push({
        [creatorField]: { not: null },
        [visibilityField]: 'matter_shared',
        [matterField]: { in: [...scope.matterIds] },
      });
    }
    if (intent === 'review'
      && capabilityPolicyAllows(policy, { permission: 'source.read_shared' })
      && capabilityPolicyAllows(policy, { permission: 'candidate.review_shared' })) {
      const grants = await reviewerGrants();
      if (grants.length > 0) {
        aclOr.push({
          [creatorField]: { not: null },
          [visibilityField]: 'matter_shared',
          [matterField]: { in: [...scope.matterIds] },
          OR: grants.map((grant) => ({
            [idField]: grant.resourceId,
            [aclVersionField]: grant.resourceAclVersion,
          })),
        });
      }
    }
    return { AND: [{ OR: parentOr }, { OR: aclOr }] };
  };

  const authorizeMany = async (
    descriptors: readonly SensitiveResourceDescriptor[],
    intent: SensitiveAccessIntent,
  ): Promise<SensitiveAccessDecision[]> => {
    if (descriptors.length === 0) return [];
    const candidates = descriptors.filter((descriptor) => (
      descriptor.tenantId === scope.tenantId
      && isResourceKind(descriptor.kind)
      && isVisibility(descriptor.visibility)
      && Number.isSafeInteger(descriptor.aclVersion)
      && descriptor.aclVersion >= 1
    ));
    const matterIds = [...new Set(candidates.flatMap((descriptor) => (
      descriptor.matterId ? [descriptor.matterId] : []
    )))];
    const accountIds = [...new Set(candidates.flatMap((descriptor) => (
      !descriptor.matterId && descriptor.accountId ? [descriptor.accountId] : []
    )))];
    const personIds = [...new Set(candidates.flatMap((descriptor) => (
      descriptor.personId ? [descriptor.personId] : []
    )))];
    const creatorIds = [...new Set(candidates.flatMap((descriptor) => (
      descriptor.createdByUserId ? [descriptor.createdByUserId] : []
    )))];
    const shouldLoadGrants = intent === 'review'
      && candidates.some((descriptor) => descriptor.kind === 'candidate');
    const [matters, accounts, persons, creators, grants] = scope.valid ? await Promise.all([
      matterIds.length === 0 ? [] : db.opportunity.findMany({
        where: {
          tenantId: scope.tenantId,
          id: { in: matterIds },
          archivedAt: null,
          account: { tenantId: scope.tenantId, archivedAt: null },
        },
        select: { id: true, accountId: true },
      }),
      accountIds.length === 0 ? [] : db.account.findMany({
        where: { tenantId: scope.tenantId, id: { in: accountIds }, archivedAt: null },
        select: { id: true },
      }),
      personIds.length === 0 ? [] : db.person.findMany({
        where: {
          tenantId: scope.tenantId,
          id: { in: personIds },
          archivedAt: null,
          mergedIntoPersonId: null,
        },
        select: { id: true, accountId: true },
      }),
      creatorIds.length === 0 ? [] : db.user.findMany({
        where: { tenantId: scope.tenantId, id: { in: creatorIds } },
        select: { id: true },
      }),
      shouldLoadGrants ? reviewerGrants() : Promise.resolve([]),
    ]) : [[], [], [], [], []] as const;
    const matterAccount = new Map(matters.map((row) => [row.id, row.accountId]));
    const activeAccountIds = new Set(accounts.map((row) => row.id));
    const personAccount = new Map(persons.map((row) => [row.id, row.accountId]));
    const currentCreatorIds = new Set(creators.map((row) => row.id));
    const grantKeys = new Set(grants.map((grant) => `${grant.resourceId}\u0000${grant.resourceAclVersion}`));

    return descriptors.map((descriptor) => {
      let parent: 'ok' | 'invalid_parent' | 'parent_scope_denied' = 'ok';
      let effectiveAccountId = descriptor.accountId;
      if (descriptor.matterId) {
        const currentAccountId = matterAccount.get(descriptor.matterId);
        if (!currentAccountId || (effectiveAccountId && currentAccountId !== effectiveAccountId)) {
          parent = 'invalid_parent';
        } else {
          effectiveAccountId = currentAccountId;
          if (!scope.canReadMatter(descriptor.matterId)) parent = 'parent_scope_denied';
        }
      } else if (effectiveAccountId) {
        if (!activeAccountIds.has(effectiveAccountId)) parent = 'invalid_parent';
        else if (!scope.canReadAccountData(effectiveAccountId)) parent = 'parent_scope_denied';
      }
      if (parent === 'ok' && descriptor.personId) {
        if (!effectiveAccountId || personAccount.get(descriptor.personId) !== effectiveAccountId) {
          parent = 'invalid_parent';
        }
      }
      return decideSensitiveAccess(
        scope,
        policy,
        descriptor,
        intent,
        descriptor.createdByUserId === null || currentCreatorIds.has(descriptor.createdByUserId),
        parent,
        grantKeys.has(`${descriptor.id}\u0000${descriptor.aclVersion}`),
      );
    });
  };

  return { scope, metadataWhere, authorizeMany };
}

export function noteDescriptor(row: {
  id: string; tenantId: string; accountId: string | null; opportunityId: string | null;
  personId: string | null; createdByUserId: string | null; visibility: string; aclVersion: number;
}): SensitiveResourceDescriptor {
  return {
    kind: 'note', id: row.id, tenantId: row.tenantId, accountId: row.accountId,
    matterId: row.opportunityId, personId: row.personId, createdByUserId: row.createdByUserId,
    visibility: row.visibility as SensitiveResourceVisibility, aclVersion: row.aclVersion,
  };
}

export function transcriptDescriptor(row: {
  id: string; tenantId: string; accountId: string | null; opportunityId: string | null;
  personId: string | null; createdByUserId: string | null; visibility: string; aclVersion: number;
}): SensitiveResourceDescriptor {
  return {
    kind: 'transcript', id: row.id, tenantId: row.tenantId, accountId: row.accountId,
    matterId: row.opportunityId, personId: row.personId, createdByUserId: row.createdByUserId,
    visibility: row.visibility as SensitiveResourceVisibility, aclVersion: row.aclVersion,
  };
}

export function candidateDescriptor(row: {
  id: string; tenantId: string; accountId: string; matterId: string | null;
  createdByUserId: string | null; visibility: string; aclVersion: number;
}): SensitiveResourceDescriptor {
  return {
    kind: 'candidate', id: row.id, tenantId: row.tenantId, accountId: row.accountId,
    matterId: row.matterId, personId: null, createdByUserId: row.createdByUserId,
    visibility: row.visibility as SensitiveResourceVisibility, aclVersion: row.aclVersion,
  };
}

export function sourceArtifactDescriptor(row: {
  id: string; tenantId: string; accountId: string | null; matterId: string | null;
  personId: string | null; createdByUserId: string | null; visibility: string; aclVersion: number;
}): SensitiveResourceDescriptor {
  return {
    kind: 'source_artifact', id: row.id, tenantId: row.tenantId, accountId: row.accountId,
    matterId: row.matterId, personId: row.personId, createdByUserId: row.createdByUserId,
    visibility: row.visibility as SensitiveResourceVisibility, aclVersion: row.aclVersion,
  };
}

/**
 * Candidate producers may refresh only their own current-scope Candidate. Creatorless
 * rows are reserved for deterministic system producers and must stay quarantined.
 */
export async function requireCandidateProducerAccess(
  db: DbClient,
  descriptor: SensitiveResourceDescriptor,
  producerUserId: string | null,
): Promise<void> {
  if (descriptor.kind !== 'candidate') throw new ScopedNotFoundError();
  if (producerUserId === null) {
    if (descriptor.createdByUserId !== null
      || descriptor.visibility !== 'owner_admin_only'
      || !Number.isSafeInteger(descriptor.aclVersion)
      || descriptor.aclVersion < 1) {
      throw new ScopedNotFoundError();
    }
    if (!descriptor.accountId) throw new ScopedNotFoundError();
    const account = await db.account.findFirst({
      where: { id: descriptor.accountId, tenantId: descriptor.tenantId, archivedAt: null },
      select: { id: true },
    });
    if (!account) throw new ScopedNotFoundError();
    if (descriptor.matterId) {
      const matter = await db.opportunity.findFirst({
        where: {
          id: descriptor.matterId,
          tenantId: descriptor.tenantId,
          accountId: descriptor.accountId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!matter) throw new ScopedNotFoundError();
    }
    return;
  }
  if (descriptor.createdByUserId !== producerUserId) throw new ScopedNotFoundError();
  const access = await authorizeSensitiveResource(db, {
    tenantId: descriptor.tenantId,
    userId: producerUserId,
    role: 'member',
  }, { entitlements: [], permissions: [] }, descriptor, 'manage');
  if (!access.allowed) throw new ScopedNotFoundError();
}

/** Resolve a compatibility-row ID to its Candidate authority and enforce review in the caller's transaction. */
export async function requireCandidateReviewAccess(
  db: DbClient,
  tenantId: string,
  legacySourceKind: 'PersonSuggestion' | 'RelSuggestion' | 'ChangeProposal' | 'Reminder' | 'EvidenceEvent',
  legacySourceId: string,
  review: CandidateReviewAccessContext,
): Promise<void> {
  const row = await db.candidate.findFirst({
    where: { tenantId, legacySourceKind, legacySourceId },
    select: {
      id: true, tenantId: true, accountId: true, matterId: true,
      createdByUserId: true, visibility: true, aclVersion: true,
    },
  });
  if (!row) throw new ScopedNotFoundError();
  const descriptor = candidateDescriptor(row);
  const access = await authorizeSensitiveResource(db, {
    tenantId,
    userId: review.actorId,
    role: review.actorRole,
  }, review.capabilityPolicy, descriptor, 'review');
  if (!access.allowed) throw new ScopedNotFoundError();
}

/** Batch preflight used by atomic review commands and replay authorization. */
export async function requireCandidateReviewAccessMany(
  db: DbClient,
  tenantId: string,
  refs: readonly LegacyCandidateReviewRef[],
  review: CandidateReviewAccessContext,
): Promise<void> {
  if (refs.length === 0) return;
  const uniqueRefs = [...new Map(refs.map((ref) => [
    `${ref.sourceKind}\u0000${ref.sourceId}`,
    ref,
  ])).values()];
  const rows = await db.candidate.findMany({
    where: {
      tenantId,
      OR: uniqueRefs.map((ref) => ({
        legacySourceKind: ref.sourceKind,
        legacySourceId: ref.sourceId,
      })),
    },
    select: {
      id: true, tenantId: true, accountId: true, matterId: true,
      createdByUserId: true, visibility: true, aclVersion: true,
      legacySourceKind: true, legacySourceId: true,
    },
  });
  const current = new Map(rows.map((row) => [
    `${row.legacySourceKind}\u0000${row.legacySourceId}`,
    candidateDescriptor(row),
  ]));
  const descriptors: SensitiveResourceDescriptor[] = [];
  for (const ref of uniqueRefs) {
    const key = `${ref.sourceKind}\u0000${ref.sourceId}`;
    const descriptor = current.get(key);
    if (!descriptor) throw new ScopedNotFoundError();
    descriptors.push(descriptor);
  }
  const evaluator = await createSensitiveAccessEvaluator(db, {
    tenantId,
    userId: review.actorId,
    role: review.actorRole,
  }, review.capabilityPolicy);
  const decisions = await evaluator.authorizeMany(descriptors, 'review');
  if (decisions.some((decision) => !decision.allowed)) throw new ScopedNotFoundError();
}
