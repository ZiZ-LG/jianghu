import { prisma } from '../src/prisma.js';

try {
  const count = await prisma.commandRun.count();
  if (count !== 0) {
    console.error(`[migration] 未纳管当前 schema 含 ${count} 条 CommandRun；64-hex 旧 key 无法安全区分 raw/digest，拒绝自动接管。`);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
