import type { Prisma, PrismaClient } from '@prisma/client';

export type DbClient = PrismaClient | Prisma.TransactionClient;

/** Generic scoped miss: callers must never disclose whether an ID exists elsewhere. */
export class ScopedNotFoundError extends Error {
  readonly scopedNotFound = true;

  constructor() {
    super('scoped resource not found');
    this.name = 'ScopedNotFoundError';
  }
}

export async function requireScopedRow<T>(row: PromiseLike<T | null>): Promise<T> {
  const result = await row;
  if (!result) throw new ScopedNotFoundError();
  return result;
}

export async function requireAccount(db: DbClient, tenantId: string, accountId: string): Promise<void> {
  await requireScopedRow(db.account.findFirst({
    where: { id: accountId, tenantId, archivedAt: null },
    select: { id: true },
  }));
}

export async function requireOpportunity(db: DbClient, tenantId: string, accountId: string, opportunityId: string): Promise<void> {
  await requireScopedRow(db.opportunity.findFirst({
    where: { id: opportunityId, tenantId, accountId, archivedAt: null, account: { archivedAt: null } },
    select: { id: true },
  }));
}

export async function requirePerson(db: DbClient, tenantId: string, accountId: string, personId: string): Promise<void> {
  await requireScopedRow(db.person.findFirst({
    where: { id: personId, tenantId, accountId },
    select: { id: true },
  }));
}

export async function requireEdgeEndpoints(db: DbClient, tenantId: string, accountId: string, sourceId: string, targetId: string): Promise<void> {
  const expected = new Set([sourceId, targetId]);
  const persons = await db.person.findMany({
    where: { tenantId, accountId, id: { in: [...expected] } },
    select: { id: true },
  });
  if (persons.length !== expected.size) throw new ScopedNotFoundError();
}
