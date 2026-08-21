import { pathToFileURL } from 'node:url';
import { inspectMatterOwnerAssignments } from '../src/matter/ownership.js';
import { prisma } from '../src/prisma.js';

function tenantIdArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--tenant-id') {
    throw new Error('required usage: --tenant-id <id>; this command is always read-only');
  }
  const tenantId = args[1];
  if (!tenantId || tenantId.startsWith('--')) throw new Error('--tenant-id requires a value');
  return tenantId;
}

async function reportTenant(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) throw new Error(`tenant not found: ${tenantId}`);

  let cursor: string | undefined;
  let totalMatters = 0;
  let assignedMatters = 0;
  let unassignedMatters = 0;
  do {
    const page = await inspectMatterOwnerAssignments(prisma, {
      tenantId, cursor, limit: 500, includeArchived: true,
    });
    process.stdout.write(`${JSON.stringify({ type: 'page', tenantId, ...page })}\n`);
    totalMatters += page.pageMatterCount;
    assignedMatters += page.pageAssignedCount;
    unassignedMatters += page.pageUnassignedCount;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  process.stdout.write(`${JSON.stringify({
    type: 'summary', tenantId, totalMatters, assignedMatters, unassignedMatters,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tenantId = tenantIdArgument(process.argv.slice(2));
    reportTenant(tenantId)
      .catch((error) => {
        console.error('[matter-owner-report] failed', error);
        process.exitCode = 2;
      })
      .finally(() => prisma.$disconnect());
  } catch (error) {
    console.error('[matter-owner-report] invalid arguments', error);
    process.exitCode = 2;
  }
}
