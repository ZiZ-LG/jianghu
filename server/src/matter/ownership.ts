import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  MatterOwnerAssignmentReport,
  MatterOwnerQueueItem,
  MatterOwnerQueueReason,
} from '@jianghu/domain-contracts';

type InspectOptions = { tenantId: string; cursor?: string; limit?: number; includeArchived?: boolean };
const QUERY_BATCH_SIZE = 500;
const DEFAULT_PAGE_SIZE = 500;
const ACCOUNT_OWNER_SELECT = {
  id: true, tenantId: true, primaryOwner: true, primaryOwnerUserId: true, archivedAt: true,
} as const;
const USER_OWNER_SELECT = { id: true, tenantId: true, name: true } as const;
type AccountOwnerRow = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_OWNER_SELECT }>;
type UserOwnerRow = Prisma.UserGetPayload<{ select: typeof USER_OWNER_SELECT }>;

function batches<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += QUERY_BATCH_SIZE) {
    result.push(items.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
}

/**
 * Read-only owner migration report. Account.primaryOwnerUserId may produce a
 * suggestion, but this function never writes Matter ownership and never maps a
 * display name to a User.id.
 */
export async function inspectMatterOwnerAssignments(
  db: PrismaClient,
  options: InspectOptions,
): Promise<MatterOwnerAssignmentReport> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_BATCH_SIZE) {
    throw new Error(`Matter owner report limit must be between 1 and ${QUERY_BATCH_SIZE}`);
  }
  const page = await db.opportunity.findMany({
    where: {
      tenantId: options.tenantId,
      ...(options.cursor ? { id: { gt: options.cursor } } : {}),
      ...(options.includeArchived ? {} : {
        archivedAt: null,
        account: { tenantId: options.tenantId, archivedAt: null },
      }),
    },
    select: {
      id: true, tenantId: true, accountId: true, primaryOwnerUserId: true, version: true, archivedAt: true,
    },
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const hasNextPage = page.length > limit;
  const matters = hasNextPage ? page.slice(0, limit) : page;
  const nextCursor = hasNextPage ? (matters.at(-1)?.id ?? null) : null;
  if (matters.length === 0) {
    return { pageMatterCount: 0, pageAssignedCount: 0, pageUnassignedCount: 0, queue: [], nextCursor: null };
  }

  const accounts: AccountOwnerRow[] = [];
  const customerIds = [...new Set(matters.map((matter) => matter.accountId))];
  for (const ids of batches(customerIds)) {
    accounts.push(...await db.account.findMany({
      where: { tenantId: options.tenantId, id: { in: ids } },
      select: ACCOUNT_OWNER_SELECT,
    }));
  }
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const referencedOwnerIds = [...new Set([
    ...matters.map((matter) => matter.primaryOwnerUserId),
    ...accounts.map((account) => account.primaryOwnerUserId),
  ].filter((value): value is string => Boolean(value)))];
  const usersById = new Map<string, UserOwnerRow>();
  for (const ids of batches(referencedOwnerIds)) {
    const rows = await db.user.findMany({
      where: { tenantId: options.tenantId, id: { in: ids } },
      select: USER_OWNER_SELECT,
    });
    for (const user of rows) usersById.set(user.id, user);
  }
  const legacyOwnerNames = [...new Set(accounts
    .filter((account) => !account.primaryOwnerUserId && account.primaryOwner)
    .map((account) => account.primaryOwner))];
  const legacyNameCounts = new Map<string, number>();
  for (const names of batches(legacyOwnerNames)) {
    const rows = await db.user.groupBy({
      by: ['name'],
      where: { tenantId: options.tenantId, name: { in: names } },
      _count: { _all: true },
    });
    for (const row of rows) legacyNameCounts.set(row.name, row._count._all);
  }

  const accountSuggestion = (
    tenantId: string,
    account: (typeof accounts)[number],
  ): { suggestedOwnerUserId: string | null; reason: MatterOwnerQueueReason } => {
    if (account.primaryOwnerUserId) {
      const accountOwner = usersById.get(account.primaryOwnerUserId);
      if (!accountOwner || accountOwner.tenantId !== tenantId) {
        return { suggestedOwnerUserId: null, reason: 'invalid_account_owner' };
      }
      return { suggestedOwnerUserId: accountOwner.id, reason: 'account_owner_suggestion' };
    }
    if (!account.primaryOwner) return { suggestedOwnerUserId: null, reason: 'unassigned' };
    const legacyMatchCount = legacyNameCounts.get(account.primaryOwner) ?? 0;
    return {
      suggestedOwnerUserId: null,
      reason: legacyMatchCount > 1
        ? 'duplicate_legacy_account_owner_name'
        : 'legacy_account_owner_name_only',
    };
  };

  let assignedMatters = 0;
  const queue: MatterOwnerQueueItem[] = [];
  for (const matter of matters) {
    const base = {
      tenantId: matter.tenantId,
      customerId: matter.accountId,
      matterId: matter.id,
      baseVersion: matter.version,
      currentOwnerUserId: matter.primaryOwnerUserId,
    };
    const account = accountsById.get(matter.accountId);
    if (!account || account.tenantId !== matter.tenantId) {
      queue.push({ ...base, suggestedOwnerUserId: null, reason: 'invalid_customer' });
      continue;
    }
    if (matter.archivedAt) {
      queue.push({ ...base, suggestedOwnerUserId: null, reason: 'archived_matter' });
      continue;
    }
    if (account.archivedAt) {
      queue.push({ ...base, suggestedOwnerUserId: null, reason: 'archived_customer' });
      continue;
    }
    const suggestion = accountSuggestion(matter.tenantId, account);
    if (!matter.primaryOwnerUserId) {
      queue.push({ ...base, ...suggestion });
      continue;
    }
    const currentOwner = usersById.get(matter.primaryOwnerUserId);
    if (currentOwner?.tenantId === matter.tenantId) {
      assignedMatters += 1;
      continue;
    }
    queue.push({
      ...base,
      suggestedOwnerUserId: suggestion.suggestedOwnerUserId,
      reason: 'invalid_matter_owner',
    });
  }

  queue.sort((left, right) => left.tenantId.localeCompare(right.tenantId)
    || left.matterId.localeCompare(right.matterId));
  return {
    pageMatterCount: matters.length,
    pageAssignedCount: assignedMatters,
    pageUnassignedCount: queue.length,
    queue,
    nextCursor,
  };
}

/** Stable-ID ownership primitive for CORE-109's future effective-scope resolver. */
export async function userOwnsMatter(
  db: PrismaClient,
  tenantId: string,
  userId: string,
  matterId: string,
): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!user) return false;
  const matter = await db.opportunity.findFirst({
    where: {
      id: matterId,
      tenantId,
      primaryOwnerUserId: userId,
      archivedAt: null,
      account: { tenantId, archivedAt: null },
    },
    select: { id: true },
  });
  return Boolean(matter);
}
