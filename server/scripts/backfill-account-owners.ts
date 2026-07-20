import type { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/prisma.js';

export type OwnerBackfillReason = 'missing_name' | 'unmatched_name' | 'duplicate_name' | 'invalid_existing_owner';
export interface OwnerBackfillReport {
  linked: Array<{ accountId: string; userId: string }>;
  manualReview: Array<{ tenantId: string; accountId: string; primaryOwner: string; reason: OwnerBackfillReason; candidateUserIds: string[] }>;
}

/** Repeatable and fail-safe: only a unique exact tenant-local name match is linked. */
export async function backfillAccountOwners(
  db: PrismaClient,
  options: { tenantId?: string } = {},
): Promise<OwnerBackfillReport> {
  const accounts = await db.account.findMany({
    where: options.tenantId ? { tenantId: options.tenantId } : {},
    select: { id: true, tenantId: true, primaryOwner: true, primaryOwnerUserId: true },
    orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
  });
  const tenants = [...new Set(accounts.map((a) => a.tenantId))];
  const users = await db.user.findMany({ where: { tenantId: { in: tenants } }, select: { id: true, tenantId: true, name: true } });
  const byTenantAndName = new Map<string, string[]>();
  const validIds = new Set<string>();
  for (const user of users) {
    validIds.add(`${user.tenantId}\u0000${user.id}`);
    const key = `${user.tenantId}\u0000${user.name}`;
    byTenantAndName.set(key, [...(byTenantAndName.get(key) ?? []), user.id].sort());
  }

  const report: OwnerBackfillReport = { linked: [], manualReview: [] };
  for (const account of accounts) {
    if (account.primaryOwnerUserId) {
      if (!validIds.has(`${account.tenantId}\u0000${account.primaryOwnerUserId}`)) {
        report.manualReview.push({ tenantId: account.tenantId, accountId: account.id, primaryOwner: account.primaryOwner, reason: 'invalid_existing_owner', candidateUserIds: [] });
      }
      continue;
    }
    const matches = byTenantAndName.get(`${account.tenantId}\u0000${account.primaryOwner}`) ?? [];
    if (!account.primaryOwner) {
      report.manualReview.push({ tenantId: account.tenantId, accountId: account.id, primaryOwner: '', reason: 'missing_name', candidateUserIds: [] });
    } else if (matches.length === 0) {
      report.manualReview.push({ tenantId: account.tenantId, accountId: account.id, primaryOwner: account.primaryOwner, reason: 'unmatched_name', candidateUserIds: [] });
    } else if (matches.length > 1) {
      report.manualReview.push({ tenantId: account.tenantId, accountId: account.id, primaryOwner: account.primaryOwner, reason: 'duplicate_name', candidateUserIds: matches });
    } else {
      const result = await db.account.updateMany({
        where: { id: account.id, tenantId: account.tenantId, primaryOwnerUserId: null },
        data: { primaryOwnerUserId: matches[0] },
      });
      if (result.count === 1) report.linked.push({ accountId: account.id, userId: matches[0] });
    }
  }
  report.manualReview.sort((a, b) => a.accountId.localeCompare(b.accountId));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failOnAmbiguous = process.argv.includes('--fail-on-ambiguous');
  backfillAccountOwners(prisma)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      const ambiguous = report.manualReview.filter((row) => row.reason === 'duplicate_name' || row.reason === 'invalid_existing_owner');
      if (failOnAmbiguous && ambiguous.length) process.exitCode = 1;
    })
    .catch((error) => { console.error('[account-owner-backfill] database check failed', error); process.exitCode = 2; })
    .finally(() => prisma.$disconnect());
}
