import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll } from 'vitest';

const TEST_DATABASE_URL = 'file:./test.db';
const DEV_DATABASE_PATH = fileURLToPath(new URL('../../prisma/dev.db', import.meta.url));

export type DevDbSnapshot =
  | { exists: false }
  | { exists: true; mtimeMs: number };

export function assertTestDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
    throw new Error(
      `Integration tests require DATABASE_URL=${TEST_DATABASE_URL}; received ${process.env.DATABASE_URL ?? '<unset>'}`,
    );
  }
}

export async function captureDevDbState(): Promise<DevDbSnapshot> {
  try {
    const result = await stat(DEV_DATABASE_PATH);
    return { exists: true, mtimeMs: result.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export async function assertDevDbUnchanged(expected: DevDbSnapshot): Promise<void> {
  const actual = await captureDevDbState();
  if (expected.exists !== actual.exists) {
    throw new Error('server/prisma/dev.db existence changed during an integration test');
  }
  if (expected.exists && actual.exists && expected.mtimeMs !== actual.mtimeMs) {
    throw new Error(
      `server/prisma/dev.db mtime changed during an integration test (${expected.mtimeMs} -> ${actual.mtimeMs})`,
    );
  }
}

export async function clearTestTenant(client: PrismaClient, tenantId: string): Promise<void> {
  assertTestDatabaseUrl();
  await client.$transaction([
    client.eVSnapshot.deleteMany({ where: { tenantId } }),
    client.signalCatalog.deleteMany({ where: { tenantId } }),
    client.actionCatalog.deleteMany({ where: { tenantId } }),
    client.industryPack.deleteMany({ where: { tenantId } }),
    client.dealPdeConfig.deleteMany({ where: { tenantId } }),
    client.scoringItemState.deleteMany({ where: { tenantId } }),
    client.scheduleSync.deleteMany({ where: { tenantId } }),
    client.weComUserBind.deleteMany({ where: { tenantId } }),
    client.weComOAuthState.deleteMany({ where: { tenantId } }),
    client.advisorMsg.deleteMany({ where: { tenantId } }),
    client.reminder.deleteMany({ where: { tenantId } }),
    client.curatedSummary.deleteMany({ where: { tenantId } }),
    client.recordingCredential.deleteMany({ where: { tenantId } }),
    client.recordingProviderConfig.deleteMany({ where: { tenantId } }),
    client.transcript.deleteMany({ where: { tenantId } }),
    client.enrichJob.deleteMany({ where: { tenantId } }),
    client.changeProposal.deleteMany({ where: { tenantId } }),
    client.commandRun.deleteMany({ where: { tenantId } }),
    client.evidenceEvent.deleteMany({ where: { tenantId } }),
    client.strategyResource.deleteMany({ where: { tenantId } }),
    client.strategyRisk.deleteMany({ where: { tenantId } }),
    client.strategyCard.deleteMany({ where: { tenantId } }),
    client.oppStage.deleteMany({ where: { tenantId } }),
    client.oppMilestone.deleteMany({ where: { tenantId } }),
    client.planAction.deleteMany({ where: { tenantId } }),
    client.note.deleteMany({ where: { tenantId } }),
    client.visitNote.deleteMany({ where: { tenantId } }),
    client.uCV.deleteMany({ where: { tenantId } }),
    client.burningIssue.deleteMany({ where: { tenantId } }),
    client.edge.deleteMany({ where: { tenantId } }),
    client.opportunityMember.deleteMany({ where: { tenantId } }),
    client.oppRole.deleteMany({ where: { tenantId } }),
    client.relSuggestion.deleteMany({ where: { tenantId } }),
    client.personSuggestion.deleteMany({ where: { tenantId } }),
    client.opportunity.deleteMany({ where: { tenantId } }),
    client.person.deleteMany({ where: { tenantId } }),
    client.account.deleteMany({ where: { tenantId } }),
    client.accessToken.deleteMany({ where: { tenantId } }),
    client.user.deleteMany({ where: { tenantId } }),
    client.weComConfig.deleteMany({ where: { tenantId } }),
    client.aiConfig.deleteMany({ where: { tenantId } }),
    client.qccConfig.deleteMany({ where: { tenantId } }),
    client.tenant.deleteMany({ where: { id: tenantId } }),
  ]);
}

export async function clearTestDatabase(client: PrismaClient): Promise<void> {
  // This all-tenant sweep is safe only for the dedicated test DB; fail closed elsewhere.
  assertTestDatabaseUrl();
  const tenants = await client.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) await clearTestTenant(client, tenant.id);
}

// Vitest loads this module as a setup file before importing app/prisma modules.
assertTestDatabaseUrl();
export const devDbBaseline = await captureDevDbState();
afterAll(async () => assertDevDbUnchanged(devDbBaseline));
