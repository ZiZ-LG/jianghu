import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

async function mutate(context: TestContext, action: Record<string, unknown>) {
  return context.app.inject({
    method: 'POST',
    url: '/api/mutate',
    headers: { authorization: `Bearer ${context.token}` },
    payload: { action },
  });
}

async function seedTree(context: TestContext, suffix: string) {
  const accountId = `acc-${suffix}`;
  const opportunityId = `opp-${suffix}`;
  await context.prisma.account.create({ data: { id: accountId, tenantId: context.tenant.id, name: `虚构客户 ${suffix}`, customerType: 1 } });
  await context.prisma.opportunity.create({ data: {
    id: opportunityId, tenantId: context.tenant.id, accountId, name: `虚构商机 ${suffix}`,
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
  } });
  const personIds = [`d1-${suffix}`, `d2-${suffix}`, `u1-${suffix}`];
  for (const personId of personIds) {
    await context.prisma.person.create({ data: { id: personId, tenantId: context.tenant.id, accountId, name: personId, title: '虚构岗位' } });
  }
  await mutate(context, { type: 'SET_ROLE', accId: accountId, oppId: opportunityId, personId: personIds[0], patch: { role: 'D' } });
  await mutate(context, { type: 'SET_ROLE', accId: accountId, oppId: opportunityId, personId: personIds[1], patch: { role: 'D' } });
  await mutate(context, { type: 'SET_ROLE', accId: accountId, oppId: opportunityId, personId: personIds[2], patch: { role: 'U' } });
  return { accountId, opportunityId, d1: personIds[0], d2: personIds[1], u1: personIds[2] };
}

describe('G64111 selection constraints', () => {
  it('accepts only a current D in the same opportunity parent tree as primary D', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'primary-d');
      const accepted = await mutate(context, {
        type: 'UPDATE_OPP', accId: tree.accountId, oppId: tree.opportunityId,
        patch: { primaryDPersonId: tree.d2 },
      });
      expect(accepted.statusCode).toBe(200);

      const nonD = await mutate(context, {
        type: 'UPDATE_OPP', accId: tree.accountId, oppId: tree.opportunityId,
        patch: { primaryDPersonId: tree.u1 },
      });
      expect(nonD.statusCode).toBe(400);

      const other = await seedTree(context, 'foreign-parent');
      const foreign = await mutate(context, {
        type: 'UPDATE_OPP', accId: tree.accountId, oppId: tree.opportunityId,
        patch: { primaryDPersonId: other.d1 },
      });
      expect(foreign.statusCode).toBe(400);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.opportunityId } }))
        .resolves.toMatchObject({ primaryDPersonId: tree.d2 });
    } finally {
      await context.cleanup();
    }
  });

  it('keeps exactly one P4 when sequential and concurrent clients select different people', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'p4-single');
      expect((await mutate(context, {
        type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: tree.u1,
        patch: { isKeyInfluencer: true },
      })).statusCode).toBe(200);

      const extraId = 'u2-p4-single';
      await context.prisma.person.create({ data: { id: extraId, tenantId: context.tenant.id, accountId: tree.accountId, name: extraId, title: '虚构岗位' } });
      await mutate(context, { type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: extraId, patch: { role: 'U' } });
      expect((await mutate(context, {
        type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: extraId,
        patch: { isKeyInfluencer: true },
      })).statusCode).toBe(200);

      let selected = await context.prisma.oppRole.findMany({ where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, isKeyInfluencer: true } });
      expect(selected.map((role) => role.personId)).toEqual([extraId]);

      const concurrent = await Promise.all([
        mutate(context, { type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: tree.u1, patch: { isKeyInfluencer: true } }),
        mutate(context, { type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: extraId, patch: { isKeyInfluencer: true } }),
      ]);
      expect(concurrent.every((response) => response.statusCode === 200 || response.statusCode === 409)).toBe(true);
      selected = await context.prisma.oppRole.findMany({ where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, isKeyInfluencer: true } });
      expect(selected).toHaveLength(1);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects A/D as P4 and clears primary D when its D role is removed', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'role-invariants');
      await mutate(context, { type: 'UPDATE_OPP', accId: tree.accountId, oppId: tree.opportunityId, patch: { primaryDPersonId: tree.d1 } });
      const invalidP4 = await mutate(context, {
        type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: tree.d1,
        patch: { isKeyInfluencer: true },
      });
      expect(invalidP4.statusCode).toBe(400);

      const roleChanged = await mutate(context, {
        type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: tree.d1,
        patch: { role: 'R' },
      });
      expect(roleChanged.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.opportunityId } }))
        .resolves.toMatchObject({ primaryDPersonId: null });
    } finally {
      await context.cleanup();
    }
  });

  it('repairs historical A/D and duplicate P4 rows on the next SET_ROLE write', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'historical-p4');
      const extraId = 'r2-historical-p4';
      await context.prisma.person.create({
        data: { id: extraId, tenantId: context.tenant.id, accountId: tree.accountId, name: extraId, title: '虚构岗位' },
      });
      await context.prisma.oppRole.create({
        data: {
          tenantId: context.tenant.id, opportunityId: tree.opportunityId, personId: extraId,
          role: 'R', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true,
        },
      });
      await context.prisma.oppRole.updateMany({
        where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, personId: { in: [tree.d1, tree.u1] } },
        data: { isKeyInfluencer: true },
      });

      const response = await mutate(context, {
        type: 'SET_ROLE', accId: tree.accountId, oppId: tree.opportunityId, personId: tree.u1,
        patch: { confidence: '共识' },
      });

      expect(response.statusCode).toBe(200);
      const selected = await context.prisma.oppRole.findMany({
        where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, isKeyInfluencer: true },
      });
      expect(selected).toHaveLength(1);
      expect(['A', 'D']).not.toContain(selected[0].role);
    } finally {
      await context.cleanup();
    }
  });
});
