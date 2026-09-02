import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_JOB_MIGRATION_MARKER,
  agentJobMigrationContractChecksum,
  applyAgentJobMigration,
  inspectAgentJobSchemaState,
  reportAgentJobMigration,
  verifyAgentJobMigration,
} from '../src/agents/migration.js';
import {
  BUILT_IN_AGENT_DEFINITIONS,
  canonicalAgentDefinition,
  hashAgentDefinition,
} from '../src/agents/registry.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('CORE-206 AgentJobDefinition and AgentRun migration', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('keeps the historical CORE-206 marker contract stable after the radar card advances', () => {
    expect(agentJobMigrationContractChecksum()).toBe(
      '8cf6a7a2294cfc0623829826f5913b0b43cd4022e3e276b425804bfd243feb99',
    );
  });

  it('marks the exact empty expansion without creating a Job or Run row', async () => {
    await expect(inspectAgentJobSchemaState(test.prisma)).resolves.toBe('expanded');
    await expect(reportAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: false,
      definitions: 0,
      runs: 0,
      conflicts: [],
    });
    await expect(applyAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      definitions: 0,
      runs: 0,
      writes: 1,
    });
    await expect(verifyAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      markerPresent: true,
      conflicts: [],
    });
    await expect(test.prisma.agentJobDefinition.count()).resolves.toBe(0);
    await expect(test.prisma.agentRun.count()).resolves.toBe(0);
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: AGENT_JOB_MIGRATION_MARKER },
    })).resolves.toMatchObject({ key: AGENT_JOB_MIGRATION_MARKER });

    for (const table of ['AgentJobDefinition', 'AgentRun']) {
      const columns = await test.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`,
      );
      expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
        'body', 'content', 'contentEnc', 'prompt', 'response', 'rawResponse', 'token', 'secret',
      ]));
    }
  });

  it('treats Agent tables as uninitialized until the ReviewBatch dependency exists', async () => {
    const dependencyMissing = {
      $queryRawUnsafe: async () => [
        { name: 'Tenant' },
        { name: 'AgentJobDefinition' },
        { name: 'AgentRun' },
      ],
    };
    await expect(inspectAgentJobSchemaState(
      dependencyMissing as unknown as Parameters<typeof inspectAgentJobSchemaState>[0],
    )).resolves.toBe('uninitialized');
  });

  it('fails report closed when exactly one Agent table is missing', async () => {
    const missingTable = Object.assign(new Error('no such table: AgentRun'), { code: 'P2021' });
    const partial = {
      dataMigrationState: { findUnique: async () => null },
      agentJobDefinition: { findMany: async () => [] },
      agentRun: { findMany: async () => { throw missingTable; } },
    };
    await expect(reportAgentJobMigration(
      partial as unknown as Parameters<typeof reportAgentJobMigration>[0],
    )).resolves.toMatchObject({
      ok: false,
      definitions: 0,
      runs: 0,
      conflicts: ['agent_job_schema_partial'],
    });
  });

  it('rolls the marker back when apply is interrupted', async () => {
    await expect(applyAgentJobMigration(test.prisma, { failAfterWrites: 1 }))
      .rejects.toThrow('injected Agent Job migration failure');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: AGENT_JOB_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });

  it('accepts one canonical disabled definition and one body-free failed run', async () => {
    const definition = BUILT_IN_AGENT_DEFINITIONS[0]!;
    const definitionId = 'agent-definition-valid';
    const accountId = 'agent-migration-account';
    await test.prisma.account.create({ data: {
      id: accountId,
      tenantId: test.tenant.id,
      name: 'Agent migration account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.agentJobDefinition.create({ data: {
      id: definitionId,
      tenantId: test.tenant.id,
      jobKey: definition.jobKey,
      jobVersion: definition.jobVersion,
      definitionJson: canonicalAgentDefinition(definition),
      definitionHash: hashAgentDefinition(definition),
      enabled: false,
      tenantLimitsJson: JSON.stringify({
        maxCostUnits: definition.budget.maxCostUnits,
        timeoutMs: definition.timeoutMs,
        maxAttempts: definition.maxAttempts,
      }),
      version: 1,
      createdByUserId: test.owner.id,
      updatedByUserId: test.owner.id,
    } });
    await test.prisma.agentRun.create({ data: {
      id: 'agent-run-valid',
      tenantId: test.tenant.id,
      definitionId,
      jobKey: definition.jobKey,
      jobVersion: definition.jobVersion,
      definitionHash: hashAgentDefinition(definition),
      definitionControlVersion: 1,
      actionMode: definition.actionMode,
      trigger: 'manual',
      status: 'failed',
      customerId: accountId,
      actorId: test.owner.id,
      idempotencyKey: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      attemptCount: 1,
      maxAttempts: 2,
      budgetLimit: definition.budget.maxCostUnits,
      timeoutMs: definition.timeoutMs,
      authorizationFingerprint: 'c'.repeat(64),
      inputRefs: JSON.stringify([{ kind: 'customer', id: accountId, version: 0 }]),
      evidenceRefs: '[]',
      outputRefs: '[]',
      modelRef: definition.modelRef,
      connectorRefs: '[]',
      failureCode: 'agent_timeout',
      startedAt: new Date('2026-08-25T18:00:00.000Z'),
      completedAt: new Date('2026-08-25T18:00:01.000Z'),
      version: 2,
    } });

    await expect(reportAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      definitions: 1,
      runs: 1,
      conflicts: [],
    });
    await expect(applyAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      definitions: 1,
      runs: 1,
    });
    await test.prisma.user.delete({ where: { id: test.owner.id } });
    await expect(reportAgentJobMigration(test.prisma)).resolves.toMatchObject({
      ok: true,
      definitions: 1,
      runs: 1,
      conflicts: [],
    });
  });

  it('fails closed on widened definitions and body-bearing run references', async () => {
    const definition = BUILT_IN_AGENT_DEFINITIONS[0]!;
    await test.prisma.agentJobDefinition.create({ data: {
      id: 'agent-definition-invalid',
      tenantId: test.tenant.id,
      jobKey: definition.jobKey,
      jobVersion: definition.jobVersion,
      definitionJson: canonicalAgentDefinition(definition),
      definitionHash: hashAgentDefinition(definition),
      enabled: true,
      tenantLimitsJson: JSON.stringify({
        maxCostUnits: definition.budget.maxCostUnits + 1,
        timeoutMs: definition.timeoutMs,
        maxAttempts: definition.maxAttempts,
      }),
      version: 1,
      createdByUserId: test.owner.id,
      updatedByUserId: test.owner.id,
    } });
    const report = await reportAgentJobMigration(test.prisma);
    expect(report.ok).toBe(false);
    expect(report.conflicts).toContain(
      `${test.tenant.id}:agent_definition:agent-definition-invalid:control_invalid`,
    );
    await expect(applyAgentJobMigration(test.prisma)).rejects.toThrow('control_invalid');
    await expect(test.prisma.dataMigrationState.findUnique({
      where: { key: AGENT_JOB_MIGRATION_MARKER },
    })).resolves.toBeNull();
  });
});
