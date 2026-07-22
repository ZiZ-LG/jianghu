import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectInternalReleaseMetrics } from '../src/releaseMetrics.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('INT-502 controlled-run metrics', () => {
  let context: TestContext;
  beforeEach(async () => { context = await createTestContext(); });
  afterEach(async () => context.cleanup());

  it('computes tenant-scoped logical success and created-person duplicate rates', async () => {
    const start = new Date('2026-07-01T00:00:00.000Z');
    const end = new Date('2026-07-15T00:00:00.000Z');
    await context.prisma.syncRun.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
      id: `sync-release-${index}`,
      tenantId: context.tenant.id,
      actorId: context.owner.id,
      idempotencyKey: `hash-${index}`,
      requestHash: `request-${index}`,
      status: index === 99 ? 'failed' : 'completed',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
      updatedAt: new Date('2026-07-02T00:01:00.000Z'),
    })) });
    await context.prisma.account.create({ data: {
      id: 'acc-release-metrics', tenantId: context.tenant.id, name: 'Metrics', customerType: 2,
    } });
    await context.prisma.person.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
      id: `person-release-${index}`,
      tenantId: context.tenant.id,
      accountId: 'acc-release-metrics',
      name: `Person ${index}`,
      title: '',
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
    })) });
    const report = await collectInternalReleaseMetrics(context.prisma, { tenantId: context.tenant.id, start, end });
    expect(report.workbuddyLogicalCommands).toMatchObject({ completed: 99, failed: 1, terminal: 100, successRatePct: 99 });
    expect(report.formalPeople).toMatchObject({ created: 100, mergedAsDuplicate: 0, duplicateRatePct: 0 });
    expect(report.thresholds).toMatchObject({ observedRequiredHours: true, minimumSample: true, successRate: true, duplicateRate: true });
    expect(report.automaticPass).toBe(true);
  });
});
