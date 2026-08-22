import { prisma } from '../src/prisma.js';
import {
  backfillPdeDecisionContexts,
  inspectPdeDecisionContextMigration,
  verifyPdeDecisionContextIntegrity,
} from '../src/pde/decisionContextMigration.js';

type Mode = 'dry-run' | 'apply' | 'verify';

const modes: Array<Mode | null> = [
  process.argv.includes('--dry-run') ? 'dry-run' : null,
  process.argv.includes('--apply') ? 'apply' : null,
  process.argv.includes('--verify') ? 'verify' : null,
];
const selected = modes.filter((mode): mode is Mode => mode !== null);

if (selected.length !== 1) {
  console.error('usage: migrate-pde-decision-context.ts --dry-run|--apply|--verify');
  process.exitCode = 2;
} else {
  const mode = selected[0]!;
  try {
    if (mode === 'dry-run') {
      const report = await inspectPdeDecisionContextMigration(prisma);
      const ok = report.invalidSourceRows === 0 && report.parityConflicts.length === 0;
      console.log(JSON.stringify({ ok, mode, authority: 'legacy-shadow', ...report }, null, 2));
      if (!ok) process.exitCode = 1;
    } else if (mode === 'apply') {
      const result = await backfillPdeDecisionContexts(prisma);
      console.log(JSON.stringify({ ok: true, mode, authority: 'PdeDecisionContext', ...result }, null, 2));
    } else {
      const result = await verifyPdeDecisionContextIntegrity(prisma);
      console.log(JSON.stringify({ ok: true, mode, authority: 'PdeDecisionContext', ...result }, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
