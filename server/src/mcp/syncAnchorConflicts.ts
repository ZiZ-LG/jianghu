import type { PrismaClient } from '@prisma/client';

export interface SyncAnchorConflict {
  entity: 'Account' | 'Opportunity' | 'VisitNote';
  key: string;
  tenantId: string;
  accountId?: string;
  value: string;
  ids: string[];
}

const prismaCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
);

async function existingRows<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    // 新库在首次 db push 前还没有业务表；已有表仍会逐张扫描，不能因部分旧表缺失而跳过全部检查。
    if (prismaCode(error) === 'P2021') return [];
    throw error;
  }
}

function duplicates(
  entity: SyncAnchorConflict['entity'],
  key: string,
  rows: Array<{ id: string; tenantId: string; accountId?: string; value: string | null }>,
): SyncAnchorConflict[] {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.value == null) continue;
    const groupKey = JSON.stringify([row.tenantId, row.accountId ?? '', row.value]);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => ({
    entity, key, tenantId: group[0].tenantId, ...(group[0].accountId ? { accountId: group[0].accountId } : {}),
    value: group[0].value!, ids: group.map((row) => row.id).sort(),
  }));
}

export async function findSyncAnchorConflicts(db: PrismaClient): Promise<SyncAnchorConflict[]> {
  const [accounts, opportunities, visits] = await Promise.all([
    existingRows(() => db.account.findMany({ select: { id: true, tenantId: true, externalRef: true, unifiedCreditCode: true } })),
    existingRows(() => db.opportunity.findMany({ select: { id: true, tenantId: true, accountId: true, externalRef: true } })),
    existingRows(() => db.visitNote.findMany({ select: { id: true, tenantId: true, accountId: true, externalRef: true } })),
  ]);
  return [
    ...duplicates('Account', 'externalRef', accounts.map((row) => ({ ...row, value: row.externalRef }))),
    ...duplicates('Account', 'unifiedCreditCode', accounts.map((row) => ({ ...row, value: row.unifiedCreditCode }))),
    ...duplicates('Opportunity', 'externalRef', opportunities.map((row) => ({ ...row, value: row.externalRef }))),
    ...duplicates('VisitNote', 'externalRef', visits.map((row) => ({ ...row, value: row.externalRef }))),
  ];
}
