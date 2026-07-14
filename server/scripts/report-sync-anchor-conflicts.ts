import { prisma } from '../src/prisma.js';
import { findSyncAnchorConflicts } from '../src/mcp/syncAnchorConflicts.js';

try {
  const conflicts = await findSyncAnchorConflicts(prisma);
  if (conflicts.length) {
    console.error(JSON.stringify({ ok: false, conflictCount: conflicts.length, conflicts }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, conflictCount: 0 }, null, 2));
  }
} catch (error) {
  console.error('[sync-anchor-report] database check failed', error);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
