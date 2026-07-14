import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JOB_LEASE_MS,
  JOB_MAX_ATTEMPTS,
  claimNextJob,
  commitJobSideEffect,
  commitJobSideEffectAndComplete,
  enqueueEnrichJob,
  enqueueProfileJob,
  enqueuePullRecordingJob,
  enqueueSuggestJob,
  recoverExpiredLeases,
  renewJobLease,
} from '../src/jobs.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('background job lease and crash recovery', () => {
  let test: TestContext;

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: 'job-recovery-account', tenantId: test.tenant.id, name: '任务恢复客户', customerType: 2,
    } });
  });

  afterEach(async () => test.cleanup());

  it('deduplicates concurrent enqueue attempts with a database unique key', async () => {
    const results = await Promise.all([
      enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma),
      enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma),
    ]);
    expect(results.filter((result) => result.enqueued)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await test.prisma.enrichJob.count({ where: {
      tenantId: test.tenant.id, type: 'enrich_account', accountId: 'job-recovery-account',
    } })).toBe(1);

    await test.prisma.enrichJob.update({ where: { id: results[0].id }, data: { status: 'done', attemptCount: 2, result: '{"ok":true}' } });
    const requeued = await enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'web', test.prisma);
    expect(requeued).toEqual({ id: results[0].id, enqueued: true });
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: requeued.id } })).toMatchObject({
      status: 'pending', mode: 'web', attemptCount: 0, result: '', error: '',
    });
    await expect(enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma))
      .resolves.toEqual({ id: requeued.id, enqueued: false });

    await test.prisma.account.create({ data: {
      id: 'legacy-job-account', tenantId: test.tenant.id, name: '存量任务客户', customerType: 2,
    } });
    await test.prisma.enrichJob.create({ data: {
      id: 'legacy-active-job', tenantId: test.tenant.id, type: 'enrich_account', accountId: 'legacy-job-account',
      mode: 'auto', status: 'pending', dedupeKey: null, enqueueToken: null,
    } });
    await expect(enqueueEnrichJob(test.tenant.id, 'legacy-job-account', 'auto', test.prisma))
      .resolves.toEqual({ id: 'legacy-active-job', enqueued: false });
    expect(await test.prisma.enrichJob.count({ where: { tenantId: test.tenant.id, accountId: 'legacy-job-account' } })).toBe(1);
  });

  it('allows only one worker to claim the same pending job', async () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    const enqueued = await enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma);
    await test.prisma.enrichJob.update({ where: { id: enqueued.id }, data: { nextAttemptAt: now } });
    const claims = await Promise.all([
      claimNextJob('worker-a', now, test.prisma),
      claimNextJob('worker-b', now, test.prisma),
    ]);
    const claimed = claims.filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ status: 'processing', attemptCount: 1 });
    expect(claimed[0]!.leaseOwner).toMatch(/^worker-[ab]$/);
    expect(claimed[0]!.leaseUntil?.getTime()).toBe(now.getTime() + JOB_LEASE_MS);
  });

  it('recovers an expired processing lease with backoff and makes it claimable again', async () => {
    const startedAt = new Date('2026-07-14T12:00:00.000Z');
    const enqueued = await enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma);
    await test.prisma.enrichJob.update({ where: { id: enqueued.id }, data: { nextAttemptAt: startedAt } });
    const claimed = await claimNextJob('crashed-worker', startedAt, test.prisma);
    expect(claimed).not.toBeNull();
    expect(claimed!.leaseToken).not.toBe('');
    expect(await recoverExpiredLeases(new Date(startedAt.getTime() + JOB_LEASE_MS - 1), test.prisma)).toBe(0);

    const recoveredAt = new Date(startedAt.getTime() + JOB_LEASE_MS + 1);
    expect(await recoverExpiredLeases(recoveredAt, test.prisma)).toBe(1);
    const pending = await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(pending).toMatchObject({ status: 'pending', leaseOwner: '', leaseUntil: null, attemptCount: 1 });
    expect(pending.nextAttemptAt.getTime()).toBe(recoveredAt.getTime() + 1000);
    expect(await claimNextJob('too-early-worker', recoveredAt, test.prisma)).toBeNull();

    const retried = await claimNextJob('retry-worker', pending.nextAttemptAt, test.prisma);
    expect(retried).toMatchObject({ id: claimed!.id, status: 'processing', leaseOwner: 'retry-worker', attemptCount: 2 });
    expect(retried!.leaseToken).not.toBe(claimed!.leaseToken);
    expect(await renewJobLease(claimed!, pending.nextAttemptAt, test.prisma)).toBe(false);
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: claimed!.id } })).toMatchObject({
      leaseOwner: 'retry-worker', leaseToken: retried!.leaseToken,
    });
    await expect(commitJobSideEffect(claimed!, (db) => db.note.create({ data: {
      id: 'stale-worker-note', tenantId: test.tenant.id, accountId: 'job-recovery-account', content: '不应写入',
    } }), test.prisma)).rejects.toThrow('side effect rejected');
    expect(await test.prisma.note.count({ where: { id: 'stale-worker-note', tenantId: test.tenant.id } })).toBe(0);
    const secondRecoveryAt = new Date(pending.nextAttemptAt.getTime() + JOB_LEASE_MS + 1);
    expect(await recoverExpiredLeases(secondRecoveryAt, test.prisma)).toBe(1);
    expect((await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: claimed!.id } })).nextAttemptAt.getTime())
      .toBe(secondRecoveryAt.getTime() + 2000);
  });

  it('moves an expired job to terminal failed after the maximum attempts', async () => {
    const enqueued = await enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma);
    const now = new Date('2026-07-14T13:00:00.000Z');
    await test.prisma.enrichJob.update({ where: { id: enqueued.id }, data: {
      status: 'processing', leaseOwner: 'dead-worker', leaseUntil: new Date(now.getTime() - 1), attemptCount: JOB_MAX_ATTEMPTS,
    } });

    expect(await recoverExpiredLeases(now, test.prisma)).toBe(1);
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: enqueued.id } })).toMatchObject({
      status: 'failed', leaseOwner: '', leaseUntil: null, attemptCount: JOB_MAX_ATTEMPTS,
    });
    expect(await claimNextJob('late-worker', new Date(now.getTime() + 86_400_000), test.prisma)).toBeNull();
  });

  it('recovers a pre-lease processing row whose leaseUntil is null', async () => {
    const now = new Date('2026-07-14T14:00:00.000Z');
    await test.prisma.enrichJob.create({ data: {
      id: 'legacy-processing-job', tenantId: test.tenant.id, type: 'enrich_account', accountId: 'job-recovery-account',
      mode: 'auto', status: 'processing', attemptCount: 1, leaseOwner: '', leaseUntil: null,
      dedupeKey: null, enqueueToken: null, nextAttemptAt: now,
    } });
    expect(await recoverExpiredLeases(now, test.prisma)).toBe(1);
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: 'legacy-processing-job' } })).toMatchObject({
      status: 'pending', leaseOwner: '', leaseUntil: null, attemptCount: 1,
    });
  });

  it('uses distinct stable dedupe keys for every public job type', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'job-recovery-opportunity', tenantId: test.tenant.id, accountId: 'job-recovery-account',
      name: '任务恢复商机', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    const first = await Promise.all([
      enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma),
      enqueueProfileJob(test.tenant.id, 'job-recovery-account', test.prisma),
      enqueueSuggestJob(test.tenant.id, 'job-recovery-account', 'job-recovery-opportunity', test.prisma),
      enqueuePullRecordingJob(test.tenant.id, 'mock-source', 'job-recovery-account', test.prisma),
    ]);
    const second = await Promise.all([
      enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'web', test.prisma),
      enqueueProfileJob(test.tenant.id, 'job-recovery-account', test.prisma),
      enqueueSuggestJob(test.tenant.id, 'job-recovery-account', 'job-recovery-opportunity', test.prisma),
      enqueuePullRecordingJob(test.tenant.id, 'mock-source', 'job-recovery-account', test.prisma),
    ]);
    expect(first.every((result) => result.enqueued)).toBe(true);
    expect(second.every((result) => !result.enqueued)).toBe(true);
    expect(new Set(first.map((result) => result.id)).size).toBe(4);
    expect(second.map((result) => result.id)).toEqual(first.map((result) => result.id));
  });

  it('enforces the tenant active-job limit under concurrent different-key enqueue', async () => {
    await test.prisma.enrichJob.createMany({ data: Array.from({ length: 49 }, (_, index) => ({
      id: `quota-job-${index}`, tenantId: test.tenant.id, dedupeKey: `quota:${index}`, enqueueToken: `token-${index}`,
      type: 'enrich_account', accountId: `quota-account-${index}`, mode: 'auto', status: 'pending',
    })) });
    const attempts = await Promise.allSettled([
      enqueueEnrichJob(test.tenant.id, 'quota-new-a', 'auto', test.prisma),
      enqueueEnrichJob(test.tenant.id, 'quota-new-b', 'auto', test.prisma),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await test.prisma.enrichJob.count({ where: {
      tenantId: test.tenant.id, status: { in: ['pending', 'processing'] },
    } })).toBe(50);
  });

  it('commits a job side effect and done state atomically', async () => {
    const enqueued = await enqueueEnrichJob(test.tenant.id, 'job-recovery-account', 'auto', test.prisma);
    const now = new Date(Date.now() + 1000);
    const claimed = await claimNextJob('atomic-worker', now, test.prisma);
    expect(claimed?.id).toBe(enqueued.id);

    await expect(commitJobSideEffectAndComplete(claimed!, async (db) => {
      await db.personSuggestion.create({ data: {
        id: 'atomic-candidate', tenantId: test.tenant.id, accountId: 'job-recovery-account',
        name: '原子候选', status: 'pending', origin: 'ai',
      } });
      throw new Error('injected crash before job completion');
    }, test.prisma)).rejects.toThrow('injected crash');
    expect(await test.prisma.personSuggestion.count({ where: { id: 'atomic-candidate', tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: enqueued.id } })).toMatchObject({ status: 'processing' });

    await expect(commitJobSideEffectAndComplete(claimed!, async (db) => {
      await db.personSuggestion.create({ data: {
        id: 'atomic-candidate', tenantId: test.tenant.id, accountId: 'job-recovery-account',
        name: '原子候选', status: 'pending', origin: 'ai',
      } });
      return { value: 1, result: '{"created":1}' };
    }, test.prisma)).resolves.toBe(1);
    expect(await test.prisma.personSuggestion.count({ where: { id: 'atomic-candidate', tenantId: test.tenant.id } })).toBe(1);
    expect(await test.prisma.enrichJob.findUniqueOrThrow({ where: { id: enqueued.id } })).toMatchObject({
      status: 'done', result: '{"created":1}', leaseOwner: '', leaseToken: '', leaseUntil: null,
    });
  });
});
