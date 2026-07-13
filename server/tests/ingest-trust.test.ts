import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { canWriteFormal, hasExplicitTrustMetadata } from '../src/ingestTrust.js';
import { deriveIngestCommandContext } from '../src/voice.js';
import { handleMcpBody } from '../src/mcpServer.js';
import { applyAction, machineActionPolicy } from '../src/mutate.js';
import { acceptProposal } from '../src/proposals.js';
import { createTestContext } from './helpers/testApp.js';

const webCtx: CommandContext = {
  tenantId: 'tenant-ingest-trust',
  actorId: 'actor-ingest-trust',
  actorRole: 'member',
  channel: 'web',
  requestId: 'request-ingest-trust',
  assertionMode: 'user_asserted',
};

describe('machine ingest trust boundary', () => {
  it.each([
    ['missing kind', { confidence: 0.99 }],
    ['missing confidence', { kind: 'explicit' }],
    ['unknown kind', { kind: 'certain', confidence: 0.99 }],
    ['out-of-range confidence', { kind: 'explicit', confidence: 2 }],
    ['low confidence', { kind: 'explicit', confidence: 0.59 }],
  ])('fails closed for %s', (_label, item) => {
    expect(hasExplicitTrustMetadata(item)).toBe(false);
    expect(deriveIngestCommandContext(webCtx, { kind: 'structured', source: 'voice', item }).assertionMode)
      .toBe('machine_proposed');
  });

  it('allows only authenticated web assertions to write protected formal entities', () => {
    expect(canWriteFormal(webCtx, 'person')).toBe(true);
    expect(canWriteFormal({ ...webCtx, channel: 'mcp', assertionMode: 'machine_proposed' }, 'person')).toBe(false);
    expect(canWriteFormal({ ...webCtx, channel: 'worker', assertionMode: 'machine_proposed' }, 'edge')).toBe(false);
    expect(canWriteFormal({ ...webCtx, assertionMode: 'machine_proposed' }, 'oppRole')).toBe(false);
    expect(canWriteFormal({
      ...webCtx,
      channel: 'mcp',
      assertionMode: 'user_asserted',
      scopes: ['human_command'],
      sourceRef: 'workbuddy-message-42',
      sourceExcerpt: '把李总标为 D',
    }, 'person')).toBe(true);
    expect(canWriteFormal({
      ...webCtx,
      channel: 'mcp',
      assertionMode: 'user_asserted',
      scopes: ['human_command'],
      sourceRef: 'workbuddy-message-42',
    }, 'person')).toBe(false);
  });

  it('classifies every sensitive machine mutation family as deny or conditional', () => {
    expect([
      'MOVE_PERSON', 'DELETE_PERSON', 'DELETE_EDGE', 'UPDATE_OPP', 'DELETE_BI',
      'DELETE_UCV', 'DELETE_EVIDENCE', 'REMOVE_ROLE', 'ADD_OPP_MEMBER',
    ].map((type) => machineActionPolicy(type as Parameters<typeof machineActionPolicy>[0])))
      .toEqual(['deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny']);
    expect(machineActionPolicy('SET_ROLE')).toBe('conditional_opp_role');
  });

  it('turns repeated machine changes to an existing formal role field into one pending draft', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'acc-ingest-role';
      const opportunityId = 'opp-ingest-role';
      const personId = 'person-ingest-role';
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: 'Trust account', customerType: 2 },
      });
      await context.prisma.opportunity.create({
        data: { id: opportunityId, tenantId: context.tenant.id, accountId, name: 'Trust opportunity', customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项' },
      });
      await context.prisma.person.create({
        data: { id: personId, tenantId: context.tenant.id, accountId, name: '李处长', title: '处长' },
      });
      await context.prisma.oppRole.create({
        data: { tenantId: context.tenant.id, opportunityId, personId, role: 'D', sentiment: 'plus', confidence: '共识' },
      });
      const ctx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'mcp',
        requestId: 'request-ingest-role',
        assertionMode: 'machine_proposed',
      };
      const call = (id: number, confidence: string) => handleMcpBody(ctx, {
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'set_opportunity_roles', arguments: { opportunityId, roles: [{ personId, role: 'D', confidence }] } },
      });

      await call(1, '明确');
      await call(2, '不清');

      const role = await context.prisma.oppRole.findUniqueOrThrow({
        where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId, personId } },
      });
      const proposals = await context.prisma.changeProposal.findMany({
        where: { tenantId: context.tenant.id, entityKind: 'oppRole', entityId: personId, field: 'confidence', status: 'pending' },
      });
      expect(role.confidence).toBe('共识');
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ oldValue: '共识', newValue: '不清' });

      const humanCtx = { ...ctx, channel: 'web' as const, assertionMode: 'user_asserted' as const };
      const results = await Promise.all([
        acceptProposal(humanCtx, proposals[0].id),
        acceptProposal(humanCtx, proposals[0].id),
      ]);
      expect(results.sort()).toEqual(['already', 'ok']);
      await expect(context.prisma.oppRole.findUniqueOrThrow({
        where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId, personId } },
      })).resolves.toMatchObject({ confidence: '不清' });
      await expect(context.prisma.changeProposal.findUniqueOrThrow({ where: { id: proposals[0].id } }))
        .resolves.toMatchObject({ status: 'accepted', dedupeKey: null });

      await call(3, '明确');
      const next = await context.prisma.changeProposal.findFirstOrThrow({
        where: { tenantId: context.tenant.id, entityKind: 'oppRole', entityId: personId, field: 'confidence', status: 'pending' },
      });
      await expect(acceptProposal(humanCtx, next.id, '非法可信度')).rejects.toThrow('confidence 值非法');
      await expect(context.prisma.oppRole.findUniqueOrThrow({
        where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId, personId } },
      })).resolves.toMatchObject({ confidence: '不清' });
      await expect(context.prisma.changeProposal.findUniqueOrThrow({ where: { id: next.id } }))
        .resolves.toMatchObject({ status: 'pending', dedupeKey: expect.any(String) });

      await applyAction(humanCtx, {
        type: 'SET_ROLE', accId: accountId, oppId: opportunityId, personId,
        patch: { confidence: '共识' },
      });
      await expect(acceptProposal(humanCtx, next.id)).rejects.toThrow('正式字段已被人工更新');
      await expect(context.prisma.oppRole.findUniqueOrThrow({
        where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId, personId } },
      })).resolves.toMatchObject({ confidence: '共识' });
      await expect(context.prisma.changeProposal.findUniqueOrThrow({ where: { id: next.id } }))
        .resolves.toMatchObject({ status: 'pending', dedupeKey: expect.any(String) });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a machine attempt to bypass the Person candidate boundary', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'acc-machine-person-bypass';
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: 'Boundary account', customerType: 2 },
      });
      await expect(applyAction({
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'worker',
        requestId: 'request-machine-person-bypass',
        assertionMode: 'machine_proposed',
      }, {
        type: 'ADD_PERSON', accId: accountId,
        person: { id: 'person-machine-bypass', name: '不应直落', title: '' },
      })).rejects.toThrow('must use candidate or proposal');
      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);

      await context.prisma.person.create({
        data: { id: 'person-existing-machine-log', tenantId: context.tenant.id, accountId, name: '已有人员', title: '', logs: '[]' },
      });
      await expect(applyAction({
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'worker',
        requestId: 'request-machine-log-bypass',
        assertionMode: 'machine_proposed',
      }, {
        type: 'ADD_LOG', accId: accountId, personId: 'person-existing-machine-log',
        log: { date: '2026-07-12', content: '不应直接写入', visibility: 'team' },
      })).rejects.toThrow('must use candidate or proposal');
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: 'person-existing-machine-log' } }))
        .resolves.toMatchObject({ logs: '[]' });
    } finally {
      await context.cleanup();
    }
  });
});
