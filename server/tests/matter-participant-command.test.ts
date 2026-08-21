import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

const auth = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

async function seedMatter(context: Awaited<ReturnType<typeof createTestContext>>, suffix: string) {
  const customerId = `participant-command-customer-${suffix}`;
  const matterId = `participant-command-matter-${suffix}`;
  const personId = `participant-command-person-${suffix}`;
  await context.prisma.account.create({ data: {
    id: customerId, tenantId: context.tenant.id, name: 'Command customer', customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: matterId, tenantId: context.tenant.id, accountId: customerId, name: 'Command Matter',
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
  } });
  await context.prisma.person.create({ data: {
    id: personId, tenantId: context.tenant.id, accountId: customerId, name: 'Participant', title: 'Advisor',
  } });
  return { customerId, matterId, personId };
}

describe('CORE-105 MatterParticipant generic command', () => {
  it('adds and removes participation idempotently without changing roles or legacy visibility', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMatter(context, 'happy');
      await context.prisma.person.create({ data: {
        id: 'participant-command-visible', tenantId: context.tenant.id, accountId: tree.customerId,
        name: 'Visibility only', title: 'Member',
      } });
      await context.prisma.opportunityMember.create({ data: {
        tenantId: context.tenant.id, opportunityId: tree.matterId, personId: 'participant-command-visible',
      } });
      const add = {
        type: 'ADD_MATTER_PARTICIPANT',
        customerId: tree.customerId,
        matterId: tree.matterId,
        personId: tree.personId,
      };

      const first = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(context.token, 'participant-add-happy'), payload: add,
      });
      const replay = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(context.token, 'participant-add-happy'), payload: add,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ ...tree, participating: true, changed: true, replayed: false });
      expect(replay.json()).toMatchObject({ ...tree, participating: true, changed: true, replayed: true });

      let state = (await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      })).json<any>();
      expect(state.accounts[0].opportunities[0]).toMatchObject({
        participantIds: [tree.personId], memberIds: ['participant-command-visible'], roles: [],
      });

      const remove = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(context.token, 'participant-remove-happy'),
        payload: { ...add, type: 'REMOVE_MATTER_PARTICIPANT' },
      });
      const removeAgain = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(context.token, 'participant-remove-noop'),
        payload: { ...add, type: 'REMOVE_MATTER_PARTICIPANT' },
      });
      expect(remove.json()).toMatchObject({ ...tree, participating: false, changed: true, replayed: false });
      expect(removeAgain.json()).toMatchObject({ ...tree, participating: false, changed: false, replayed: false });
      state = (await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      })).json<any>();
      expect(state.accounts[0].opportunities[0]).toMatchObject({
        participantIds: [], memberIds: ['participant-command-visible'], roles: [],
      });
      expect(await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, entityKind: 'matter_participant' },
        orderBy: { action: 'asc' }, select: { action: true },
      })).toEqual([{ action: 'matter_participant_add' }, { action: 'matter_participant_remove' }]);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for a cross-customer Person and keeps viewers read-only', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMatter(context, 'scope');
      await context.prisma.account.create({ data: {
        id: 'participant-command-other-customer', tenantId: context.tenant.id, name: 'Other', customerType: 1,
      } });
      await context.prisma.person.create({ data: {
        id: 'participant-command-other-person', tenantId: context.tenant.id,
        accountId: 'participant-command-other-customer', name: 'Other', title: 'Other',
      } });
      const payload = {
        type: 'ADD_MATTER_PARTICIPANT', customerId: tree.customerId,
        matterId: tree.matterId, personId: 'participant-command-other-person',
      };

      const crossCustomer = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(context.token, 'participant-cross-customer'), payload,
      });
      expect(crossCustomer.statusCode).toBe(404);
      expect(await context.prisma.matterParticipant.count()).toBe(0);

      const viewer = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id, email: `viewer-${randomUUID()}@example.test`,
        passwordHash: 'unused', name: 'Viewer', role: 'viewer',
      } });
      const viewerToken = context.app.jwt.sign({
        userId: viewer.id, tenantId: context.tenant.id, role: 'viewer',
      });
      const viewerAttempt = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-participant',
        headers: auth(viewerToken, 'participant-viewer-denied'),
        payload: { ...payload, personId: tree.personId },
      });
      expect(viewerAttempt.statusCode).toBe(403);
      expect(await context.prisma.matterParticipant.count()).toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
