import {
  ActorRoleSchema,
  TenantDataScopePolicySchema,
  type TenantDataScopePolicy,
} from '@jianghu/domain-contracts';
import type { DbClient } from './mutation/scopeGuards.js';
import type { ReadPrincipal, VisibilityRole } from './visibility.js';

export interface EffectiveResourceScope {
  tenantId: string;
  actorUserId: string;
  actorRole: VisibilityRole;
  policy: TenantDataScopePolicy;
  accountIds: ReadonlySet<string>;
  fullAccountIds: ReadonlySet<string>;
  matterIds: ReadonlySet<string>;
  canReadAccountContainer(accountId: string): boolean;
  canReadAccountData(accountId: string): boolean;
  canReadMatter(matterId: string): boolean;
}

function createScope(input: {
  tenantId: string;
  actorUserId: string;
  actorRole: VisibilityRole;
  policy: TenantDataScopePolicy;
  accountIds?: Iterable<string>;
  fullAccountIds?: Iterable<string>;
  matterIds?: Iterable<string>;
}): EffectiveResourceScope {
  const accountIds = new Set(input.accountIds);
  const fullAccountIds = new Set(input.fullAccountIds);
  const matterIds = new Set(input.matterIds);
  return {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    policy: input.policy,
    accountIds,
    fullAccountIds,
    matterIds,
    canReadAccountContainer: (accountId) => accountIds.has(accountId),
    canReadAccountData: (accountId) => fullAccountIds.has(accountId),
    canReadMatter: (matterId) => matterIds.has(matterId),
  };
}

/** Invalid current database state is represented by the strictest effective policy and empty sets. */
function emptyScope(principal: ReadPrincipal): EffectiveResourceScope {
  return createScope({
    tenantId: principal.tenantId,
    actorUserId: principal.userId,
    actorRole: 'viewer',
    policy: 'scoped',
  });
}

/**
 * Resolves the only authoritative Customer/Matter read set from current database state.
 * The JWT role is intentionally not trusted: actor role and tenant policy are reloaded on every call.
 */
export async function resolveEffectiveResourceScope(
  db: DbClient,
  principal: ReadPrincipal,
): Promise<EffectiveResourceScope> {
  const [tenant, actor] = await Promise.all([
    db.tenant.findUnique({
      where: { id: principal.tenantId },
      select: { id: true, dataScopePolicy: true },
    }),
    db.user.findFirst({
      where: { id: principal.userId, tenantId: principal.tenantId },
      select: { id: true, role: true },
    }),
  ]);
  if (!tenant || !actor) return emptyScope(principal);

  const policy = TenantDataScopePolicySchema.safeParse(tenant.dataScopePolicy);
  const currentRole = ActorRoleSchema.safeParse(actor.role);
  if (!policy.success || !currentRole.success) return emptyScope(principal);

  const actorRole = currentRole.data;
  const hasTenantWideRead = actorRole === 'owner'
    || actorRole === 'admin'
    || (actorRole === 'member' && policy.data === 'legacy_tenant_shared');

  const fullAccountRows = await db.account.findMany({
    where: {
      tenantId: principal.tenantId,
      archivedAt: null,
      ...(hasTenantWideRead ? {} : { primaryOwnerUserId: actor.id }),
    },
    select: { id: true },
  });
  const fullAccountIds = new Set(fullAccountRows.map((row) => row.id));

  const matterOr = actorRole === 'member' && policy.data === 'scoped'
    ? [
        { primaryOwnerUserId: actor.id },
        ...(fullAccountIds.size > 0 ? [{ accountId: { in: [...fullAccountIds] } }] : []),
      ]
    : [];
  const matterRows = actorRole === 'viewer' && fullAccountIds.size === 0
    ? []
    : await db.opportunity.findMany({
        where: {
          tenantId: principal.tenantId,
          archivedAt: null,
          account: { tenantId: principal.tenantId, archivedAt: null },
          ...(hasTenantWideRead
            ? {}
            : actorRole === 'member'
              ? { OR: matterOr }
              : { accountId: { in: [...fullAccountIds] } }),
        },
        select: { id: true, accountId: true },
      });
  const matterIds = new Set(matterRows.map((row) => row.id));
  const accountIds = new Set(fullAccountIds);
  for (const matter of matterRows) accountIds.add(matter.accountId);

  return createScope({
    tenantId: principal.tenantId,
    actorUserId: actor.id,
    actorRole,
    policy: policy.data,
    accountIds,
    fullAccountIds,
    matterIds,
  });
}
