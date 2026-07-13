import type { PrismaClient } from '@prisma/client';
import { prisma } from '../src/prisma.js';
import { pathToFileURL } from 'node:url';

export async function reportWecomBindConflicts(db: PrismaClient, tenantId?: string) {
  const rows = await db.weComUserBind.findMany({ where: tenantId ? { tenantId } : {}, orderBy: [{ tenantId: 'asc' }, { wecomUserid: 'asc' }, { id: 'asc' }] });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.tenantId}\u0000${row.wecomUserid}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    tenantId: g[0].tenantId, wecomUserid: g[0].wecomUserid,
    conflicts: g.map((r) => ({ bindId: r.id, userId: r.userId })),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportWecomBindConflicts(prisma).then((conflicts) => process.stdout.write(`${JSON.stringify({ conflicts }, null, 2)}\n`)).finally(() => prisma.$disconnect());
}
