import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { applyAction } from '../src/mutate.js';
import { effectiveEvidenceStatus } from '../src/ingestTrust.js';
import { createTestContext } from './helpers/testApp.js';

describe('evidence trust boundary', () => {
  it('derives evidence status and origin from server context instead of client payload', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'acc-evidence-trust';
      const opportunityId = 'opp-evidence-trust';
      const personId = 'person-evidence-trust';
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: 'Evidence account', customerType: 2 },
      });
      await context.prisma.opportunity.create({
        data: { id: opportunityId, tenantId: context.tenant.id, accountId, name: 'Evidence opportunity', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项' },
      });
      await context.prisma.person.create({
        data: { id: personId, tenantId: context.tenant.id, accountId, name: '王总', title: '总经理' },
      });
      const base: Omit<CommandContext, 'channel' | 'assertionMode'> = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        requestId: 'request-evidence-trust',
      };
      const machineCtx: CommandContext = { ...base, channel: 'mcp', assertionMode: 'machine_proposed' };
      const humanCtx: CommandContext = { ...base, channel: 'web', assertionMode: 'user_asserted' };

      expect(effectiveEvidenceStatus(machineCtx)).toBe('pending_review');
      expect(effectiveEvidenceStatus(humanCtx)).toBe('approved');

      await applyAction(machineCtx, {
        type: 'ADD_EVIDENCE', accId: accountId, oppId: opportunityId,
        evidence: { id: 'ev-machine-forged', personId, signalKey: 'intro_referral', direction: 1, tier: 'mid', status: 'approved', origin: 'manual' },
      });
      await applyAction(humanCtx, {
        type: 'ADD_EVIDENCE', accId: accountId, oppId: opportunityId,
        evidence: { id: 'ev-human-forged', personId, signalKey: 'intro_referral', direction: 1, tier: 'mid', status: 'pending_review', origin: 'recording' },
      });
      await applyAction(humanCtx, {
        type: 'ADD_EVIDENCE', accId: accountId, oppId: opportunityId,
        evidence: { id: 'ev-human-direct', personId, signalKey: 'intro_referral', direction: 1, tier: 'mid', status: 'pending_review', origin: 'manual' },
      });

      await expect(context.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-machine-forged' } }))
        .resolves.toMatchObject({ status: 'pending_review', origin: 'mcp' });
      await expect(context.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-human-forged' } }))
        .resolves.toMatchObject({ status: 'pending_review', origin: 'recording' });
      await expect(context.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-human-direct' } }))
        .resolves.toMatchObject({ status: 'approved', origin: 'manual' });
      const candidates = await context.prisma.candidate.findMany({
        where: { tenantId: context.tenant.id, legacySourceKind: 'EvidenceEvent' },
        orderBy: { legacySourceId: 'asc' },
      });
      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.legacySourceId)).toEqual([
        'ev-human-forged', 'ev-machine-forged',
      ]);
      for (const candidate of candidates) expect(candidate).toMatchObject({
        kind: 'evidence_create', status: 'pending', accountId, matterId: opportunityId,
        targetKind: 'person', targetId: personId, createdByUserId: context.owner.id,
        visibility: 'private', version: 0,
      });
      await expect(applyAction(humanCtx, {
        type: 'DELETE_EVIDENCE', accId: accountId, oppId: opportunityId,
        evidenceId: 'ev-machine-forged',
      })).rejects.toMatchObject({ candidateConflict: true });
      await expect(context.prisma.evidenceEvent.findUnique({ where: { id: 'ev-machine-forged' } }))
        .resolves.not.toBeNull();
    } finally {
      await context.cleanup();
    }
  });
});
