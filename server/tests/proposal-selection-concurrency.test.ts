import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { acceptProposal } from '../src/proposals.js';
import { createTestContext } from './helpers/testApp.js';

describe('proposal selection concurrency', () => {
  it('accepts competing P4 proposals atomically and leaves at most one legal selection', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'account-proposal-p4';
      const opportunityId = 'opportunity-proposal-p4';
      const people = ['person-proposal-u', 'person-proposal-r'];
      await context.prisma.account.create({ data: { id: accountId, tenantId: context.tenant.id, name: '虚构客户', customerType: 1 } });
      await context.prisma.opportunity.create({ data: {
        id: opportunityId, tenantId: context.tenant.id, accountId, name: '虚构商机', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      await context.prisma.person.createMany({ data: people.map((id) => ({
        id, tenantId: context.tenant.id, accountId, name: id, title: '虚构岗位',
      })) });
      await context.prisma.oppRole.createMany({ data: [
        { tenantId: context.tenant.id, opportunityId, personId: people[0], role: 'U', sentiment: 'plus', confidence: '明确' },
        { tenantId: context.tenant.id, opportunityId, personId: people[1], role: 'R', sentiment: 'plus', confidence: '明确' },
      ] });
      await context.prisma.changeProposal.createMany({ data: people.map((personId, index) => ({
        id: `proposal-p4-${index}`, tenantId: context.tenant.id, accountId, opportunityId,
        entityKind: 'oppRole', entityId: personId, field: 'isKeyInfluencer', oldValue: 'false', newValue: 'true',
      })) });
      const commandContext: CommandContext = {
        tenantId: context.tenant.id, actorId: context.owner.id, actorRole: 'owner', channel: 'web',
        requestId: 'proposal-p4-concurrency', assertionMode: 'user_asserted',
      };

      const outcomes = await Promise.allSettled([
        acceptProposal(commandContext, 'proposal-p4-0'),
        acceptProposal(commandContext, 'proposal-p4-1'),
      ]);

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled' || (outcome.reason as { conflict?: boolean })?.conflict)).toBe(true);
      const selected = await context.prisma.oppRole.findMany({
        where: { tenantId: context.tenant.id, opportunityId, isKeyInfluencer: true },
      });
      expect(selected).toHaveLength(1);
      expect(['A', 'D']).not.toContain(selected[0].role);
      const proposals = await context.prisma.changeProposal.findMany({
        where: { tenantId: context.tenant.id, opportunityId }, orderBy: { id: 'asc' },
      });
      expect(proposals.every((proposal) => proposal.status === 'accepted' || proposal.status === 'pending')).toBe(true);
      expect(proposals).not.toContainEqual(expect.objectContaining({ status: 'applying' }));
    } finally {
      await context.cleanup();
    }
  });

  it('opens proposal acceptance with the same Serializable boundary used by mutations', async () => {
    const context = await createTestContext();
    const transactionSpy = vi.spyOn(context.prisma, '$transaction');
    try {
      const accountId = 'account-proposal-serializable';
      const opportunityId = 'opportunity-proposal-serializable';
      const personId = 'person-proposal-serializable';
      await context.prisma.account.create({ data: { id: accountId, tenantId: context.tenant.id, name: '虚构客户', customerType: 1 } });
      await context.prisma.opportunity.create({ data: {
        id: opportunityId, tenantId: context.tenant.id, accountId, name: '虚构商机', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      await context.prisma.person.create({ data: { id: personId, tenantId: context.tenant.id, accountId, name: '虚构人物', title: '虚构岗位' } });
      await context.prisma.oppRole.create({ data: {
        tenantId: context.tenant.id, opportunityId, personId, role: 'U', sentiment: 'neutral', confidence: '明确',
      } });
      await context.prisma.changeProposal.create({ data: {
        id: 'proposal-serializable', tenantId: context.tenant.id, accountId, opportunityId,
        entityKind: 'oppRole', entityId: personId, field: 'sentiment', oldValue: 'neutral', newValue: 'plus',
      } });

      await acceptProposal({
        tenantId: context.tenant.id, actorId: context.owner.id, actorRole: 'owner', channel: 'web',
        requestId: 'proposal-serializable', assertionMode: 'user_asserted',
      }, 'proposal-serializable');

      expect(transactionSpy).toHaveBeenLastCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } finally {
      transactionSpy.mockRestore();
      await context.cleanup();
    }
  });

  it('retries a P2034 conflict through the shared Serializable transaction runner', async () => {
    const mutateModule = await import('../src/mutate.js');
    const runSerializableTransaction = (mutateModule as unknown as {
      runSerializableTransaction?: <T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    }).runSerializableTransaction;
    expect(runSerializableTransaction).toBeTypeOf('function');
    if (!runSerializableTransaction) return;
    let attempts = 0;
    const db = {
      $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<string>, options?: { isolationLevel?: string }) => {
        attempts += 1;
        expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (attempts === 1) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
        return work({} as Prisma.TransactionClient);
      },
    } as unknown as PrismaClient;

    await expect(runSerializableTransaction(db, async () => 'committed')).resolves.toBe('committed');
    expect(attempts).toBe(2);
  });
});
