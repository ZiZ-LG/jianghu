import { collectInternalReleaseMetrics } from '../src/releaseMetrics.js';
import { prisma } from '../src/prisma.js';

const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const tenantId = valueAfter('--tenant');
const startRaw = valueAfter('--start');
const endRaw = valueAfter('--end') ?? new Date().toISOString();
const final = process.argv.includes('--final');
if (!tenantId || !startRaw) {
  console.error('Usage: npm run release:metrics -- --tenant TENANT_ID --start ISO [--end ISO] [--final]');
  process.exit(2);
}
const start = new Date(startRaw);
const end = new Date(endRaw);
if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
  console.error('invalid release observation window');
  process.exit(2);
}

try {
  const report = await collectInternalReleaseMetrics(prisma, { tenantId, start, end });
  console.log(JSON.stringify(report, null, 2));
  if (final && !report.automaticPass) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
