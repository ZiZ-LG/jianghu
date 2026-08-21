import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestContext } from './helpers/testApp.js';

async function seedMutationParents(context: Awaited<ReturnType<typeof createTestContext>>, suffix: string) {
  const accountId = `acc-${suffix}`;
  const opportunityId = `opp-${suffix}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: `Account ${suffix}`, customerType: 1 },
  });
  await context.prisma.opportunity.create({
    data: {
      id: opportunityId,
      tenantId: context.tenant.id,
      accountId,
      name: `Opportunity ${suffix}`,
      customerType: 1,
      pipelineStage: '线索',
      engageStage: '需求调研立项',
    },
  });
  return { accountId, opportunityId };
}

describe('/api/mutate Action contract', () => {
  it.each(['竞标方家数', '甲方代表', '招标代理', '未知事项'])('rejects non-authoritative C5 write key %s', async (invalidKey) => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedMutationParents(context, `invalid-c5-${invalidKey}`);
      const response = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` },
        payload: {
          action: {
            type: 'UPDATE_OPP', accId: accountId, oppId: opportunityId,
            patch: { c5Items: { [invalidKey]: true } },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } }))
        .resolves.toMatchObject({ c5Items: '{}' });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a legacy TB role without persisting it', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.create({
        data: {
          id: 'acc-action-contract',
          tenantId: context.tenant.id,
          name: 'Action Contract Account',
          customerType: 1,
        },
      });
      await context.prisma.person.create({
        data: {
          id: 'person-action-contract',
          tenantId: context.tenant.id,
          accountId: 'acc-action-contract',
          name: 'Action Contract Person',
          title: 'Decision Maker',
        },
      });
      await context.prisma.opportunity.create({
        data: {
          id: 'opp-action-contract',
          tenantId: context.tenant.id,
          accountId: 'acc-action-contract',
          name: 'Action Contract Opportunity',
          customerType: 1,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
        },
      });

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { authorization: `Bearer ${context.token}` },
        payload: {
          action: {
            type: 'SET_ROLE',
            accId: 'acc-action-contract',
            oppId: 'opp-action-contract',
            personId: 'person-action-contract',
            patch: { role: 'TB' },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: '无效的 action' });
      await expect(
        context.prisma.oppRole.findUnique({
          where: {
            tenantId_opportunityId_personId: {
              tenantId: context.tenant.id,
              opportunityId: 'opp-action-contract',
              personId: 'person-action-contract',
            },
          },
        }),
      ).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('rejects forged createdBy on Visit, Note, and PlanAction without persisting records', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedMutationParents(context, 'forged-created-by');
      const actions = [
        { type: 'ADD_VISIT', accId: accountId, visit: { id: 'visit-forged-created-by', date: '2026-07-12', topic: 'Visit', summary: 'Summary', createdBy: 'attacker-user' } },
        { type: 'ADD_NOTE', accId: accountId, note: { id: 'note-forged-created-by', content: 'Note', createdBy: 'attacker-user' } },
        { type: 'ADD_PLAN_ACTION', accId: accountId, oppId: opportunityId, planAction: { id: 'plan-forged-created-by', title: 'Plan', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false, createdBy: 'attacker-user' } },
      ];

      const statuses: number[] = [];
      for (const action of actions) {
        const response = await context.app.inject({
          method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action },
        });
        statuses.push(response.statusCode);
      }

      expect(statuses).toEqual([400, 400, 400]);
      await expect(Promise.all([
        context.prisma.visitNote.findUnique({ where: { id: 'visit-forged-created-by' } }),
        context.prisma.note.findUnique({ where: { id: 'note-forged-created-by' } }),
        context.prisma.planAction.findUnique({ where: { id: 'plan-forged-created-by' } }),
      ])).resolves.toEqual([null, null, null]);
    } finally {
      await context.cleanup();
    }
  });

  it('persists ctx.actorId as createdBy for Visit, Note, and PlanAction', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedMutationParents(context, 'trusted-created-by');
      const actions = [
        { type: 'ADD_VISIT', accId: accountId, visit: { id: 'visit-trusted-created-by', date: '2026-07-12', topic: 'Visit', summary: 'Summary' } },
        { type: 'ADD_NOTE', accId: accountId, note: { id: 'note-trusted-created-by', content: 'Note' } },
        { type: 'ADD_PLAN_ACTION', accId: accountId, oppId: opportunityId, planAction: { id: 'plan-trusted-created-by', title: 'Plan', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false } },
      ];

      const statuses: number[] = [];
      for (const action of actions) {
        const response = await context.app.inject({
          method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200]);

      const [visit, note, plan] = await Promise.all([
        context.prisma.visitNote.findUniqueOrThrow({ where: { id: 'visit-trusted-created-by' } }),
        context.prisma.note.findUniqueOrThrow({ where: { id: 'note-trusted-created-by' } }),
        context.prisma.planAction.findUniqueOrThrow({ where: { id: 'plan-trusted-created-by' } }),
      ]);
      expect([visit.createdBy, note.createdBy, plan.createdBy]).toEqual([
        context.owner.id, context.owner.id, context.owner.id,
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a client-forged account _mcpOrigin', async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { authorization: `Bearer ${context.token}` },
        payload: {
          action: {
            type: 'ADD_ACCOUNT',
            account: {
              id: 'acc-forged-mcp-origin',
              name: 'Forged MCP Origin',
              customerType: 2,
              profile: { business: 'Business', _mcpOrigin: { source: 'client', at: 'forged', needsReview: false } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      await expect(context.prisma.account.findUnique({ where: { id: 'acc-forged-mcp-origin' } })).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('preserves legacy profile extras but clears _mcpOrigin on a human profile update', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'acc-human-profile-update';
      await context.prisma.account.create({
        data: {
          id: accountId,
          tenantId: context.tenant.id,
          name: 'Human Profile Update',
          customerType: 2,
          profile: JSON.stringify({
            business: 'Old business',
            legacyCustom: 'preserve me',
            _mcpOrigin: { source: 'mcp', at: 'old', needsReview: true },
          }),
        },
      });

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: { authorization: `Bearer ${context.token}` },
        payload: {
          action: { type: 'UPDATE_ACCOUNT', accId: accountId, patch: { profile: { business: 'Human verified business' } } },
        },
      });

      expect(response.statusCode).toBe(200);
      const updated = await context.prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(JSON.parse(updated.profile)).toEqual({
        business: 'Human verified business',
        legacyCustom: 'preserve me',
      });
    } finally {
      await context.cleanup();
    }
  });

  it('adds participation with a sales role while keeping later role removal independent', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedMutationParents(context, 'participant-role-adapter');
      await context.prisma.person.create({ data: {
        id: 'role-participant', tenantId: context.tenant.id, accountId, name: 'Role participant', title: 'Advisor',
      } });
      const role = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action: {
          type: 'SET_ROLE', accId: accountId, oppId: opportunityId, personId: 'role-participant',
          patch: { role: 'R', sentiment: 'plus', confidence: '明确' },
        } },
      });
      expect(role.statusCode).toBe(200);
      let state = (await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      })).json<any>();
      expect(state.accounts[0].opportunities[0]).toMatchObject({
        participantIds: ['role-participant'],
        memberIds: [],
      });

      const remove = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action: {
          type: 'REMOVE_ROLE', accId: accountId, oppId: opportunityId, personId: 'role-participant',
        } },
      });
      expect(remove.statusCode).toBe(200);
      state = (await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      })).json<any>();
      expect(state.accounts[0].opportunities[0].participantIds).toEqual(['role-participant']);
      expect(state.accounts[0].opportunities[0].roles).toEqual([]);
      expect(state.accounts[0].opportunities[0].memberIds).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  it('round-trips an unknown Relation kind through persistence and state', async () => {
    const context = await createTestContext();
    try {
      const { accountId, opportunityId } = await seedMutationParents(context, 'relation-kind');
      await context.prisma.person.createMany({ data: ['source', 'target'].map((id) => ({
        id: `relation-${id}`, tenantId: context.tenant.id, accountId, name: id, title: id,
      })) });
      const response = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action: {
          type: 'ADD_EDGE', accId: accountId, oppId: opportunityId, edge: {
            id: 'relation-open-kind', source: 'relation-source', target: 'relation-target',
            kind: 'trusted_advisor', layer: 'L2', label: '顾问',
          },
        } },
      });
      expect(response.statusCode).toBe(200);
      const update = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: { authorization: `Bearer ${context.token}` }, payload: { action: {
          type: 'UPDATE_EDGE', accId: accountId, oppId: opportunityId, edgeId: 'relation-open-kind',
          patch: { kind: 'former_colleague' }, baseVersion: 0,
        } },
      });
      expect(update.statusCode).toBe(200);
      const state = (await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      })).json<any>();
      expect(state.accounts[0].opportunities[0].edges).toEqual([
        expect.objectContaining({ id: 'relation-open-kind', kind: 'former_colleague', layer: 'L2', version: 1 }),
      ]);
    } finally {
      await context.cleanup();
    }
  });
});

describe('WorkBuddy integration documentation', () => {
  it('does not publish the retired writable role sequence', () => {
    const docs = [
      '../../docs/集成-WorkBuddy销售包对接设计.md',
      '../../docs/集成-M1实现清单.md',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

    expect(docs.join('\n')).not.toContain('A/D/U/TB/R');
  });
});
