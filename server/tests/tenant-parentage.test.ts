import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Action, CommandContext } from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/mutate.js';
import { assembleState, type StateSecurityWarning } from '../src/state.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  createRelationCandidate,
  relationCandidateDedupeKey,
} from '../src/candidates/personRelation.js';

const SCOPED_NOT_FOUND = { error: '资源不存在' };

interface RegisteredTenant {
  tenantId: string;
  userId: string;
  token: string;
}

interface SeededTree {
  accountId: string;
  opportunityId: string;
  sourcePersonId: string;
  targetPersonId: string;
  edgeId: string;
  biId: string;
  ucvId: string;
  visitId: string;
  noteId: string;
  planActionId: string;
  milestoneId: string;
  stageId: string;
  strategyCardId: string;
  strategyRiskId: string;
  strategyResourceId: string;
  evidenceId: string;
}

async function registerTenant(context: TestContext, label: string): Promise<RegisteredTenant> {
  const suffix = randomUUID();
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `${label}-${suffix}@example.test`,
      password: 'test-password',
      name: `${label} Owner`,
      tenantName: `${label} Tenant ${suffix}`,
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ token: string; tenant: { id: string }; user: { id: string } }>();
  return { tenantId: body.tenant.id, userId: body.user.id, token: body.token };
}

async function createViewerToken(context: TestContext, name: string): Promise<{ token: string; userId: string }> {
  const user = await context.prisma.user.create({
    data: {
      tenantId: context.tenant.id,
      email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'not-used-by-token-auth',
      name,
      role: 'viewer',
    },
  });
  return { userId: user.id, token: context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role: 'viewer' }) };
}

async function seedTree(db: PrismaClient, tenantId: string, prefix: string): Promise<SeededTree> {
  const ids: SeededTree = {
    accountId: `acc-${prefix}`,
    opportunityId: `opp-${prefix}`,
    sourcePersonId: `person-source-${prefix}`,
    targetPersonId: `person-target-${prefix}`,
    edgeId: `edge-${prefix}`,
    biId: `bi-${prefix}`,
    ucvId: `ucv-${prefix}`,
    visitId: `visit-${prefix}`,
    noteId: `note-${prefix}`,
    planActionId: `plan-${prefix}`,
    milestoneId: `milestone-${prefix}`,
    stageId: `stage-${prefix}`,
    strategyCardId: `card-${prefix}`,
    strategyRiskId: `risk-${prefix}`,
    strategyResourceId: `resource-${prefix}`,
    evidenceId: `evidence-${prefix}`,
  };

  await db.account.create({
    data: { id: ids.accountId, tenantId, name: `Account ${prefix}`, customerType: 1 },
  });
  await db.opportunity.create({
    data: {
      id: ids.opportunityId,
      tenantId,
      accountId: ids.accountId,
      name: `Opportunity ${prefix}`,
      customerType: 1,
      pipelineStage: '线索',
      engageStage: '需求调研立项',
    },
  });
  await db.person.createMany({
    data: [
      { id: ids.sourcePersonId, tenantId, accountId: ids.accountId, name: `Source ${prefix}`, title: 'Sponsor' },
      { id: ids.targetPersonId, tenantId, accountId: ids.accountId, name: `Target ${prefix}`, title: 'Decision maker' },
    ],
  });
  await db.edge.create({
    data: {
      id: ids.edgeId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      source: ids.sourcePersonId,
      target: ids.targetPersonId,
      layer: 'L2',
      label: 'seed edge',
    },
  });
  await db.oppRole.create({
    data: {
      tenantId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      role: 'A',
      sentiment: 'plus',
      confidence: '明确',
    },
  });
  await db.opportunityMember.create({
    data: { tenantId, opportunityId: ids.opportunityId, personId: ids.targetPersonId },
  });
  await db.burningIssue.create({
    data: {
      id: ids.biId,
      tenantId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      description: 'synthetic issue',
      category: 'test',
      confidence: '明确',
    },
  });
  await db.uCV.create({
    data: {
      id: ids.ucvId,
      tenantId,
      opportunityId: ids.opportunityId,
      targetBiId: ids.biId,
      description: 'synthetic value',
      competitorCannot: 'synthetic moat',
      status: '建议',
    },
  });
  await db.visitNote.create({
    data: { id: ids.visitId, tenantId, accountId: ids.accountId, opportunityId: ids.opportunityId },
  });
  await db.note.create({
    data: {
      id: ids.noteId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      content: 'synthetic note',
    },
  });
  await db.planAction.create({
    data: {
      id: ids.planActionId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      title: 'synthetic plan',
    },
  });
  await db.oppMilestone.create({
    data: {
      id: ids.milestoneId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      title: 'synthetic milestone',
    },
  });
  await db.oppStage.create({
    data: {
      id: ids.stageId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      stageKey: '需求引导',
    },
  });
  await db.strategyCard.create({
    data: {
      id: ids.strategyCardId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      title: 'synthetic card',
    },
  });
  await db.strategyRisk.create({
    data: {
      id: ids.strategyRiskId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      text: 'synthetic risk',
    },
  });
  await db.strategyResource.create({
    data: {
      id: ids.strategyResourceId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      label: 'synthetic resource',
    },
  });
  await db.evidenceEvent.create({
    data: {
      id: ids.evidenceId,
      tenantId,
      accountId: ids.accountId,
      opportunityId: ids.opportunityId,
      personId: ids.sourcePersonId,
      signalKey: 'synthetic_signal',
    },
  });
  return ids;
}

async function mutate(context: TestContext, token: string, action: Action) {
  return context.app.inject({
    method: 'POST',
    url: '/api/mutate',
    headers: { authorization: `Bearer ${token}` },
    payload: { action },
  });
}

async function acceptPersonSuggestion(
  context: TestContext,
  token: string,
  id: string,
  payload: { name?: string; title?: string } = {},
) {
  return context.app.inject({
    method: 'POST',
    url: `/api/suggest/persons/${id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function acceptRelSuggestion(
  context: TestContext,
  token: string,
  id: string,
  payload: { layer?: 'L1' | 'L2' | 'L3' | 'L4'; label?: string } = {},
) {
  return context.app.inject({
    method: 'POST',
    url: `/api/suggest/${id}/accept`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function simulateLostAcceptanceClaim(
  context: TestContext,
  model: 'PersonSuggestion' | 'RelSuggestion',
  id: string,
) {
  context.prisma.$use(async (params, next) => {
    const whereId = params.args?.where?.id;
    const acceptsCandidate = params.args?.data?.status === 'accepted';
    if (params.model === model && whereId === id && acceptsCandidate) {
      // Simulate another transaction winning between our stale pending read and status write.
      // A real CAS returns count=0; the legacy unconditional update falsely reports success.
      return params.action === 'updateMany' ? { count: 0 } : {};
    }
    return next(params);
  });
}

async function stateFor(context: TestContext, token: string): Promise<unknown> {
  const response = await context.app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

type InteractiveTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

function observeTopLevelTransactions(
  client: PrismaClient,
  beforeAttempt: (options: InteractiveTransactionOptions | undefined) => void,
): PrismaClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: InteractiveTransactionOptions,
        ): Promise<T> => {
          beforeAttempt(options);
          return target.$transaction(callback, options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function expectScopedNotFound(response: Awaited<ReturnType<typeof mutate>>) {
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual(SCOPED_NOT_FOUND);
}

function expectHardDeleteDisabled(response: Awaited<ReturnType<typeof mutate>>) {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: '应用变更失败' });
}

describe('INT-102 tenant parentage and reference guards', () => {
  it('rejects all ten cross-tenant create/reference attacks without changing tenant B state', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'tenant-b');
      const treeA = await seedTree(context.prisma, context.tenant.id, 'attack-a');
      const treeB = await seedTree(context.prisma, tenantB.tenantId, 'attack-b');

      const attacks: Array<{
        label: string;
        action: Action;
        persisted: () => Promise<unknown>;
      }> = [
        {
          label: 'ADD_OPP foreign Account',
          action: {
            type: 'ADD_OPP', accId: treeB.accountId,
            opp: { id: 'attack-add-opp', name: 'Attack opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
          },
          persisted: () => context.prisma.opportunity.findUnique({ where: { id: 'attack-add-opp' } }),
        },
        {
          label: 'ADD_PERSON foreign Account',
          action: { type: 'ADD_PERSON', accId: treeB.accountId, person: { id: 'attack-add-person', name: 'Attack person', title: 'Attacker' } },
          persisted: () => context.prisma.person.findUnique({ where: { id: 'attack-add-person' } }),
        },
        {
          label: 'ADD_EDGE foreign Account/Opportunity/Persons',
          action: {
            type: 'ADD_EDGE', accId: treeB.accountId, oppId: treeB.opportunityId,
            edge: { id: 'attack-add-edge', source: treeB.sourcePersonId, target: treeB.targetPersonId, layer: 'L2', label: 'attack' },
          },
          persisted: () => context.prisma.edge.findUnique({ where: { id: 'attack-add-edge' } }),
        },
        {
          label: 'SET_ROLE foreign Person',
          action: { type: 'SET_ROLE', accId: treeA.accountId, oppId: treeA.opportunityId, personId: treeB.sourcePersonId, patch: { role: 'D' } },
          persisted: () => context.prisma.oppRole.findUnique({ where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId: treeA.opportunityId, personId: treeB.sourcePersonId } } }),
        },
        {
          label: 'ADD_OPP_MEMBER foreign Person',
          action: { type: 'ADD_OPP_MEMBER', accId: treeA.accountId, oppId: treeA.opportunityId, personId: treeB.sourcePersonId },
          persisted: () => context.prisma.opportunityMember.findUnique({ where: { tenantId_opportunityId_personId: { tenantId: context.tenant.id, opportunityId: treeA.opportunityId, personId: treeB.sourcePersonId } } }),
        },
        {
          label: 'ADD_BI foreign Person',
          action: {
            type: 'ADD_BI', accId: treeA.accountId, oppId: treeA.opportunityId,
            bi: { id: 'attack-add-bi', personId: treeB.sourcePersonId, description: 'attack', category: 'test', isPrivate: true, confidence: '明确' },
          },
          persisted: () => context.prisma.burningIssue.findUnique({ where: { id: 'attack-add-bi' } }),
        },
        {
          label: 'ADD_UCV foreign BI',
          action: {
            type: 'ADD_UCV', accId: treeA.accountId, oppId: treeA.opportunityId,
            ucv: { id: 'attack-add-ucv', targetBiId: treeB.biId, description: 'attack', competitorCannot: 'attack', status: '建议' },
          },
          persisted: () => context.prisma.uCV.findUnique({ where: { id: 'attack-add-ucv' } }),
        },
        {
          label: 'ADD_VISIT foreign Account/Opportunity',
          action: {
            type: 'ADD_VISIT', accId: treeB.accountId,
            visit: { id: 'attack-add-visit', opportunityId: treeB.opportunityId, date: '2026-07-12', topic: 'attack', summary: 'attack' },
          },
          persisted: () => context.prisma.visitNote.findUnique({ where: { id: 'attack-add-visit' } }),
        },
        {
          label: 'ADD_NOTE foreign Account/Opportunity/Person',
          action: {
            type: 'ADD_NOTE', accId: treeB.accountId,
            note: { id: 'attack-add-note', opportunityId: treeB.opportunityId, personId: treeB.sourcePersonId, content: 'attack' },
          },
          persisted: () => context.prisma.note.findUnique({ where: { id: 'attack-add-note' } }),
        },
        {
          label: 'ADD_EVIDENCE foreign Person',
          action: {
            type: 'ADD_EVIDENCE', accId: treeA.accountId, oppId: treeA.opportunityId,
            evidence: { id: 'attack-add-evidence', personId: treeB.sourcePersonId, signalKey: 'attack_signal', direction: 1, tier: 'mid' },
          },
          persisted: () => context.prisma.evidenceEvent.findUnique({ where: { id: 'attack-add-evidence' } }),
        },
      ];

      for (const attack of attacks) {
        const before = await stateFor(context, tenantB.token);
        const response = await mutate(context, context.token, attack.action);
        const row = await attack.persisted();

        expect(row, `${attack.label} must not persist an attack row`).toBeNull();
        expectScopedNotFound(response);
        await expect(stateFor(context, tenantB.token), `${attack.label} must not change tenant B tree`).resolves.toEqual(before);
      }
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a PersonSuggestion whose Account belongs to another tenant and rolls back its override', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'suggest-person-account-b');
      const treeB = await seedTree(context.prisma, tenantB.tenantId, 'suggest-person-account-b');
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-foreign-account',
          tenantId: context.tenant.id,
          accountId: treeB.accountId,
          name: 'Original candidate',
          title: 'Original title',
          status: 'pending',
        },
      });

      const response = await acceptPersonSuggestion(context, context.token, 'ps-foreign-account', {
        name: 'Must roll back',
        title: 'Must also roll back',
      });

      await expect(context.prisma.person.findFirst({
        where: { tenantId: context.tenant.id, accountId: treeB.accountId },
      })).resolves.toBeNull();
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-foreign-account' } })).resolves.toMatchObject({
        name: 'Original candidate',
        title: 'Original title',
        status: 'pending',
        resolvedPersonId: null,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(SCOPED_NOT_FOUND);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a relation candidate with a formal endpoint from another Account and rolls back the override', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-formal-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-formal-right');
      await context.prisma.opportunity.update({
        where: { id: left.opportunityId },
        data: { memberScoped: true },
      });
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-must-roll-back-with-relation',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          name: 'Must remain pending',
          suggestedRole: 'D',
          suggestedSentiment: 'plus',
          status: 'pending',
        },
      });
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-wrong-formal-endpoint',
          tenantId: context.tenant.id,
          opportunityId: left.opportunityId,
          sourcePersonId: 'ps-must-roll-back-with-relation',
          targetPersonId: right.targetPersonId,
          sourceKind: 'suggestion',
          targetKind: 'person',
          layer: 'L2',
          label: 'Original relation',
          status: 'pending',
        },
      });
      const [edgeCountBefore, roleCountBefore, memberCountBefore, personCountBefore] = await Promise.all([
        context.prisma.edge.count({ where: { tenantId: context.tenant.id, opportunityId: left.opportunityId } }),
        context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
      ]);

      const response = await acceptRelSuggestion(context, context.token, 'rs-wrong-formal-endpoint', {
        layer: 'L4',
        label: 'Must roll back',
      });

      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id, opportunityId: left.opportunityId } })).resolves.toBe(edgeCountBefore);
      await expect(context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(roleCountBefore);
      await expect(context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(memberCountBefore);
      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(personCountBefore);
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-must-roll-back-with-relation' } })).resolves.toMatchObject({
        status: 'pending',
        resolvedPersonId: null,
      });
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-wrong-formal-endpoint' } })).resolves.toMatchObject({
        status: 'pending',
        layer: 'L2',
        label: 'Original relation',
        sourceKind: 'suggestion',
        sourcePersonId: 'ps-must-roll-back-with-relation',
        targetKind: 'person',
        targetPersonId: right.targetPersonId,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(SCOPED_NOT_FOUND);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a PersonSuggestion whose Opportunity is in another Account without creating role or membership rows', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-person-opp-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-person-opp-right');
      await context.prisma.opportunity.update({
        where: { id: right.opportunityId },
        data: { memberScoped: true },
      });
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-wrong-opportunity',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: right.opportunityId,
          name: 'Wrong opportunity candidate',
          suggestedRole: 'D',
          suggestedSentiment: 'plus',
          status: 'pending',
        },
      });
      const [personCountBefore, roleCountBefore, memberCountBefore] = await Promise.all([
        context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } }),
      ]);

      const response = await acceptPersonSuggestion(context, context.token, 'ps-wrong-opportunity');

      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(personCountBefore);
      await expect(context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(roleCountBefore);
      await expect(context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(memberCountBefore);
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-wrong-opportunity' } })).resolves.toMatchObject({
        status: 'pending',
        resolvedPersonId: null,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(SCOPED_NOT_FOUND);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a relation candidate whose pending PersonSuggestion belongs to another Account', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-pending-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-pending-right');
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-wrong-relation-account',
          tenantId: context.tenant.id,
          accountId: right.accountId,
          opportunityId: right.opportunityId,
          name: 'Wrong tree candidate',
          status: 'pending',
        },
      });
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-wrong-pending-suggestion',
          tenantId: context.tenant.id,
          opportunityId: left.opportunityId,
          sourceKind: 'suggestion',
          sourcePersonId: 'ps-wrong-relation-account',
          targetKind: 'person',
          targetPersonId: left.targetPersonId,
          layer: 'L3',
          label: 'Wrong pending suggestion',
          status: 'pending',
        },
      });
      const [personCountBefore, edgeCountBefore] = await Promise.all([
        context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.edge.count({ where: { tenantId: context.tenant.id } }),
      ]);

      const response = await acceptRelSuggestion(context, context.token, 'rs-wrong-pending-suggestion');

      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(personCountBefore);
      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(edgeCountBefore);
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-wrong-relation-account' } })).resolves.toMatchObject({
        status: 'pending',
        resolvedPersonId: null,
      });
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-wrong-pending-suggestion' } })).resolves.toMatchObject({
        status: 'pending',
        sourceKind: 'suggestion',
        sourcePersonId: 'ps-wrong-relation-account',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(SCOPED_NOT_FOUND);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects an accepted PersonSuggestion whose resolved Person belongs to another Account', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-resolved-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-resolved-right');
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-wrong-resolved-person',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          name: 'Historical accepted candidate',
          status: 'accepted',
          resolvedPersonId: right.sourcePersonId,
        },
      });
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-wrong-resolved-person',
          tenantId: context.tenant.id,
          opportunityId: left.opportunityId,
          sourceKind: 'suggestion',
          sourcePersonId: 'ps-wrong-resolved-person',
          targetKind: 'person',
          targetPersonId: left.targetPersonId,
          layer: 'L3',
          label: 'Wrong resolved person',
          status: 'pending',
        },
      });
      const edgeCountBefore = await context.prisma.edge.count({ where: { tenantId: context.tenant.id } });

      const response = await acceptRelSuggestion(context, context.token, 'rs-wrong-resolved-person');

      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(edgeCountBefore);
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-wrong-resolved-person' } })).resolves.toMatchObject({
        status: 'accepted',
        resolvedPersonId: right.sourcePersonId,
      });
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-wrong-resolved-person' } })).resolves.toMatchObject({
        status: 'pending',
        sourceKind: 'suggestion',
        sourcePersonId: 'ps-wrong-resolved-person',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(SCOPED_NOT_FOUND);
    } finally {
      await context.cleanup();
    }
  });

  it('rewrites pending relation endpoints only for Opportunities in the accepted candidate Account', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-rewrite-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-rewrite-right');
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-scoped-rewrite',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          name: 'Scoped rewrite candidate',
          status: 'pending',
        },
      });
      await context.prisma.relSuggestion.createMany({
        data: [
          {
            id: 'rs-valid-rewrite',
            tenantId: context.tenant.id,
            opportunityId: left.opportunityId,
            sourceKind: 'suggestion',
            sourcePersonId: 'ps-scoped-rewrite',
            targetKind: 'person',
            targetPersonId: left.targetPersonId,
            layer: 'L3',
            label: 'Valid rewrite',
            status: 'pending',
          },
          {
            id: 'rs-cross-account-rewrite',
            tenantId: context.tenant.id,
            opportunityId: right.opportunityId,
            sourceKind: 'suggestion',
            sourcePersonId: 'ps-scoped-rewrite',
            targetKind: 'person',
            targetPersonId: right.targetPersonId,
            layer: 'L3',
            label: 'Must remain dirty and pending',
            status: 'pending',
          },
        ],
      });

      const response = await acceptPersonSuggestion(context, context.token, 'ps-scoped-rewrite');
      const candidate = await context.prisma.personSuggestion.findUniqueOrThrow({ where: { id: 'ps-scoped-rewrite' } });

      expect(response.statusCode).toBe(200);
      expect(candidate.status).toBe('accepted');
      expect(candidate.resolvedPersonId).toBeTruthy();
      await expect(context.prisma.matterParticipant.findUnique({
        where: {
          tenantId_opportunityId_personId: {
            tenantId: context.tenant.id,
            opportunityId: left.opportunityId,
            personId: candidate.resolvedPersonId!,
          },
        },
      })).resolves.toMatchObject({ accountId: left.accountId });
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-valid-rewrite' } })).resolves.toMatchObject({
        status: 'pending',
        sourceKind: 'person',
        sourcePersonId: candidate.resolvedPersonId,
      });
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-cross-account-rewrite' } })).resolves.toMatchObject({
        status: 'pending',
        sourceKind: 'suggestion',
        sourcePersonId: 'ps-scoped-rewrite',
        targetKind: 'person',
        targetPersonId: right.targetPersonId,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('rolls back Person materialization when the atomic pending claim loses a race', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'suggest-person-lost-claim');
      await context.prisma.opportunity.update({
        where: { id: tree.opportunityId },
        data: { memberScoped: true },
      });
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-lost-claim',
          tenantId: context.tenant.id,
          accountId: tree.accountId,
          opportunityId: tree.opportunityId,
          name: 'Lost person claim',
          title: 'Original title',
          suggestedRole: 'D',
          suggestedSentiment: 'plus',
          status: 'pending',
        },
      });
      const [personCountBefore, roleCountBefore, memberCountBefore] = await Promise.all([
        context.prisma.person.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } }),
        context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } }),
      ]);
      simulateLostAcceptanceClaim(context, 'PersonSuggestion', 'ps-lost-claim');

      const response = await acceptPersonSuggestion(context, context.token, 'ps-lost-claim', {
        name: 'Override must roll back',
        title: 'Override title must roll back',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: '该候选已被处理，请刷新后重试' });
      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(personCountBefore);
      await expect(context.prisma.oppRole.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(roleCountBefore);
      await expect(context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(memberCountBefore);
      await expect(context.prisma.personSuggestion.findUnique({ where: { id: 'ps-lost-claim' } })).resolves.toMatchObject({
        name: 'Lost person claim',
        title: 'Original title',
        status: 'pending',
        resolvedPersonId: null,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('rolls back Edge creation when the atomic relation claim loses a race', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'suggest-rel-lost-claim');
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-lost-claim',
          tenantId: context.tenant.id,
          opportunityId: tree.opportunityId,
          sourcePersonId: tree.sourcePersonId,
          targetPersonId: tree.targetPersonId,
          layer: 'L2',
          label: 'Lost relation claim',
          status: 'pending',
        },
      });
      const edgeCountBefore = await context.prisma.edge.count({ where: { tenantId: context.tenant.id } });
      simulateLostAcceptanceClaim(context, 'RelSuggestion', 'rs-lost-claim');

      const response = await acceptRelSuggestion(context, context.token, 'rs-lost-claim', {
        layer: 'L4',
        label: 'Override must roll back',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: '该候选已被处理，请刷新后重试' });
      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(edgeCountBefore);
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-lost-claim' } })).resolves.toMatchObject({
        status: 'pending',
        layer: 'L2',
        label: 'Lost relation claim',
        sourceKind: 'person',
        sourcePersonId: tree.sourcePersonId,
        targetKind: 'person',
        targetPersonId: tree.targetPersonId,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('allows only one of two concurrent requests to materialize a PersonSuggestion', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'suggest-person-concurrent');
      await context.prisma.personSuggestion.create({
        data: {
          id: 'ps-concurrent-accept',
          tenantId: context.tenant.id,
          accountId: tree.accountId,
          opportunityId: tree.opportunityId,
          name: 'Concurrent candidate',
          status: 'pending',
        },
      });

      const responses = await Promise.all([
        acceptPersonSuggestion(context, context.token, 'ps-concurrent-accept'),
        acceptPersonSuggestion(context, context.token, 'ps-concurrent-accept'),
      ]);
      const candidate = await context.prisma.personSuggestion.findUniqueOrThrow({ where: { id: 'ps-concurrent-accept' } });
      const persons = await context.prisma.person.findMany({
        where: { tenantId: context.tenant.id, accountId: tree.accountId, name: 'Concurrent candidate' },
      });

      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
      expect(responses.every((response) => response.statusCode < 500)).toBe(true);
      expect(persons).toHaveLength(1);
      expect(candidate).toMatchObject({ status: 'accepted', resolvedPersonId: persons[0].id });
    } finally {
      await context.cleanup();
    }
  });

  it('allows only one of two concurrent requests to create an Edge for a RelSuggestion', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'suggest-rel-concurrent');
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-concurrent-accept',
          tenantId: context.tenant.id,
          opportunityId: tree.opportunityId,
          sourcePersonId: tree.sourcePersonId,
          targetPersonId: tree.targetPersonId,
          layer: 'L2',
          label: 'Concurrent relation',
          status: 'pending',
        },
      });

      const responses = await Promise.all([
        acceptRelSuggestion(context, context.token, 'rs-concurrent-accept'),
        acceptRelSuggestion(context, context.token, 'rs-concurrent-accept'),
      ]);
      const candidate = await context.prisma.relSuggestion.findUniqueOrThrow({ where: { id: 'rs-concurrent-accept' } });
      const edges = await context.prisma.edge.findMany({
        where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, label: 'Concurrent relation', origin: 'ai' },
      });

      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
      expect(responses.every((response) => response.statusCode < 500)).toBe(true);
      expect(edges).toHaveLength(1);
      expect(candidate).toMatchObject({
        status: 'accepted',
        sourceKind: 'person',
        sourcePersonId: tree.sourcePersonId,
        targetKind: 'person',
        targetPersonId: tree.targetPersonId,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('does not let a later reject overwrite an accepted RelSuggestion after its Edge is committed', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'suggest-rel-reject-after-accept');
      await context.prisma.relSuggestion.create({
        data: {
          id: 'rs-reject-after-accept',
          tenantId: context.tenant.id,
          opportunityId: tree.opportunityId,
          sourcePersonId: tree.sourcePersonId,
          targetPersonId: tree.targetPersonId,
          layer: 'L2',
          label: 'Accepted must stay accepted',
          status: 'pending',
        },
      });
      const accepted = await acceptRelSuggestion(context, context.token, 'rs-reject-after-accept');
      expect(accepted.statusCode).toBe(200);

      const rejected = await context.app.inject({
        method: 'POST',
        url: '/api/suggest/rs-reject-after-accept/reject',
        headers: { authorization: `Bearer ${context.token}` },
      });

      expect(rejected.statusCode).toBe(404);
      expect(rejected.json()).toEqual(SCOPED_NOT_FOUND);
      await expect(context.prisma.relSuggestion.findUnique({ where: { id: 'rs-reject-after-accept' } })).resolves.toMatchObject({
        status: 'accepted',
        sourceKind: 'person',
        targetKind: 'person',
      });
      await expect(context.prisma.edge.count({
        where: { tenantId: context.tenant.id, opportunityId: tree.opportunityId, label: 'Accepted must stay accepted', origin: 'ai' },
      })).resolves.toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('drops wrong-Account formal and suggestion endpoints from viewer and generate relation reads', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'suggest-read-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'suggest-read-right');
      const viewerName = 'Right Account Viewer';
      const viewer = await createViewerToken(context, viewerName);
      await context.prisma.account.update({ where: { id: right.accountId }, data: { primaryOwner: viewerName, primaryOwnerUserId: viewer.userId } });

      await context.prisma.personSuggestion.createMany({
        data: [
          {
            id: 'ps-read-secret-left',
            tenantId: context.tenant.id,
            accountId: left.accountId,
            opportunityId: left.opportunityId,
            name: 'A1 secret candidate name',
            evidence: 'A1 secret candidate evidence',
            status: 'pending',
          },
          {
            id: 'same-id-read-endpoints',
            tenantId: context.tenant.id,
            accountId: right.accountId,
            opportunityId: right.opportunityId,
            name: 'Right candidate name',
            status: 'pending',
          },
          {
            id: 'ps-read-bad-optional-opp',
            tenantId: context.tenant.id,
            accountId: right.accountId,
            opportunityId: left.opportunityId,
            name: 'Bad optional opportunity candidate',
            status: 'pending',
          },
        ],
      });
      await context.prisma.person.create({
        data: { id: 'same-id-read-endpoints', tenantId: context.tenant.id, accountId: right.accountId, name: 'Right formal name', title: '' },
      });
      await context.prisma.relSuggestion.createMany({
        data: [
          {
            id: 'rs-read-invalid-suggestion', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'suggestion', sourcePersonId: 'ps-read-secret-left', targetKind: 'person', targetPersonId: right.targetPersonId,
            layer: 'L3', label: 'invalid suggestion', evidence: 'must never leak invalid suggestion evidence', confidence: 0.99, status: 'pending',
          },
          {
            id: 'rs-read-invalid-formal', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'person', sourcePersonId: left.sourcePersonId, targetKind: 'person', targetPersonId: right.targetPersonId,
            layer: 'L2', label: 'invalid formal', evidence: 'must never leak invalid formal evidence', confidence: 0.98, status: 'pending',
          },
          {
            id: 'rs-read-invalid-optional-opp', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'suggestion', sourcePersonId: 'ps-read-bad-optional-opp', targetKind: 'person', targetPersonId: right.targetPersonId,
            layer: 'L3', label: 'invalid optional opportunity', confidence: 0.97, status: 'pending',
          },
          {
            id: 'rs-read-valid', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'person', sourcePersonId: right.sourcePersonId, targetKind: 'person', targetPersonId: right.targetPersonId,
            layer: 'L2', label: 'valid relation', confidence: 0.6, status: 'pending',
          },
          {
            id: 'rs-read-kind-key-collision', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'person', sourcePersonId: 'same-id-read-endpoints', targetKind: 'suggestion', targetPersonId: 'same-id-read-endpoints',
            layer: 'L3', label: 'kind collision relation', confidence: 0.5, status: 'pending',
          },
        ],
      });

      const viewerResponse = await context.app.inject({
        method: 'GET',
        url: `/api/suggest?opportunityId=${right.opportunityId}`,
        headers: { authorization: `Bearer ${viewer.token}` },
      });
      expect(viewerResponse.statusCode).toBe(200);
      const viewerSuggestions = viewerResponse.json<{ suggestions: Array<Record<string, unknown>> }>().suggestions;
      expect(viewerSuggestions.map((row) => row.id)).toEqual(['rs-read-valid', 'rs-read-kind-key-collision']);
      expect(viewerSuggestions.find((row) => row.id === 'rs-read-kind-key-collision')).toMatchObject({
        sourceName: 'Right formal name',
        targetName: 'Right candidate name（候选）',
      });
      const viewerBody = JSON.stringify(viewerSuggestions);
      for (const secret of [
        'rs-read-invalid-suggestion', 'rs-read-invalid-formal', 'rs-read-invalid-optional-opp',
        'ps-read-secret-left', left.sourcePersonId, 'A1 secret candidate name',
        'A1 secret candidate evidence', 'must never leak invalid suggestion evidence', 'must never leak invalid formal evidence',
      ]) expect(viewerBody).not.toContain(secret);

      const generated = await context.app.inject({
        method: 'POST',
        url: '/api/suggest/generate',
        headers: { authorization: `Bearer ${context.token}` },
        payload: { opportunityId: right.opportunityId },
      });
      expect(generated.statusCode).toBe(200);
      expect(generated.json<{ suggestions: Array<{ id: string }> }>().suggestions.map((row) => row.id)).toEqual([
        'rs-read-valid',
        'rs-read-kind-key-collision',
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps inbox relation context paired with the surviving row after malformed rows are dropped', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'inbox-drop-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'inbox-drop-right');
      await context.prisma.relSuggestion.createMany({
        data: [
          {
            id: 'rs-inbox-invalid-first', tenantId: context.tenant.id, opportunityId: left.opportunityId,
            sourceKind: 'person', sourcePersonId: right.sourcePersonId, targetKind: 'person', targetPersonId: left.targetPersonId,
            layer: 'L2', label: 'invalid first', evidence: 'invalid first evidence', confidence: 0.99, status: 'pending',
          },
          {
            id: 'rs-inbox-valid-second', tenantId: context.tenant.id, opportunityId: right.opportunityId,
            sourceKind: 'person', sourcePersonId: right.sourcePersonId, targetKind: 'person', targetPersonId: right.targetPersonId,
            layer: 'L3', label: 'valid second', confidence: 0.5, status: 'pending',
          },
        ],
      });
      const source = { kind: 'person' as const, id: right.sourcePersonId };
      const target = { kind: 'person' as const, id: right.targetPersonId };
      await createRelationCandidate(context.prisma, {
        id: 'rs-inbox-valid-second', tenantId: context.tenant.id, matterId: right.opportunityId,
        source, target, layer: 'L3', label: 'valid second', sourceType: 'graph',
        sourceRef: 'test:tenant-parentage:valid-relation', evidence: 'valid relation evidence',
        confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: relationCandidateDedupeKey(right.opportunityId, source, target),
      });
      await context.prisma.dataMigrationState.create({ data: {
        key: 'CORE-203-candidate-backfill-v1', details: '{"test":true}',
      } });

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/inbox',
        headers: { authorization: `Bearer ${context.token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ rels: Array<Record<string, unknown>> }>().rels).toEqual([
        expect.objectContaining({
          id: 'rs-inbox-valid-second',
          opportunityId: right.opportunityId,
          oppName: `Opportunity inbox-drop-right`,
          accountId: right.accountId,
          accountName: `Account inbox-drop-right`,
          sourceName: `Source inbox-drop-right`,
          targetName: `Target inbox-drop-right`,
        }),
      ]);
      expect(response.body).not.toContain('rs-inbox-invalid-first');
      expect(response.body).not.toContain('invalid first evidence');
    } finally {
      await context.cleanup();
    }
  });

  it('removes a deleted PlanAction only from valid same-tree StrategyCard references and keeps the card operable', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'plan-ref-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'plan-ref-right');
      const keepActionId = 'plan-ref-keep';
      const malformedActionId = 'plan-ref-invalid-person';
      await context.prisma.planAction.create({
        data: {
          id: keepActionId,
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          title: 'Keep this action',
        },
      });
      await context.prisma.planAction.create({
        data: {
          id: malformedActionId,
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          personId: right.sourcePersonId,
          title: 'Historical action with a cross-account person',
        },
      });
      await context.prisma.strategyCard.update({
        where: { id: left.strategyCardId },
        data: { dispatchedActionIds: JSON.stringify([keepActionId, left.planActionId]) },
      });
      await context.prisma.strategyCard.create({
        data: {
          id: 'card-plan-ref-cross-tree-dirty',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          title: 'Historical dirty card must not be rewritten',
          dispatchedActionIds: JSON.stringify([left.planActionId, right.planActionId]),
        },
      });
      await context.prisma.strategyCard.create({
        data: {
          id: 'card-plan-ref-invalid-person-dirty',
          tenantId: context.tenant.id,
          accountId: left.accountId,
          opportunityId: left.opportunityId,
          title: 'Historical dirty action reference must not be rewritten',
          dispatchedActionIds: JSON.stringify([left.planActionId, malformedActionId]),
        },
      });

      const response = await mutate(context, context.token, {
        type: 'DELETE_PLAN_ACTION',
        accId: left.accountId,
        actionId: left.planActionId,
      });
      expect(response.statusCode).toBe(200);

      const state = await stateFor(context, context.token) as {
        accounts: Array<{ id: string; strategyCards?: Array<{ id: string; dispatchedActionIds?: string[] }> }>;
      };
      const leftState = state.accounts.find((account) => account.id === left.accountId);
      expect(leftState?.strategyCards?.find((card) => card.id === left.strategyCardId)).toMatchObject({
        id: left.strategyCardId,
        dispatchedActionIds: [keepActionId],
      });
      expect(leftState?.strategyCards?.some((card) => card.id === 'card-plan-ref-cross-tree-dirty')).toBe(false);
      expect(leftState?.strategyCards?.some((card) => card.id === 'card-plan-ref-invalid-person-dirty')).toBe(false);

      await expect(context.prisma.planAction.findUnique({ where: { id: left.planActionId } })).resolves.toBeNull();
      const [validCard, dirtyCard, dirtyPersonCard] = await Promise.all([
        context.prisma.strategyCard.findUniqueOrThrow({ where: { id: left.strategyCardId } }),
        context.prisma.strategyCard.findUniqueOrThrow({ where: { id: 'card-plan-ref-cross-tree-dirty' } }),
        context.prisma.strategyCard.findUniqueOrThrow({ where: { id: 'card-plan-ref-invalid-person-dirty' } }),
      ]);
      expect(JSON.parse(validCard.dispatchedActionIds)).toEqual([keepActionId]);
      expect(JSON.parse(dirtyCard.dispatchedActionIds)).toEqual([left.planActionId, right.planActionId]);
      expect(JSON.parse(dirtyPersonCard.dispatchedActionIds)).toEqual([left.planActionId, malformedActionId]);

      const updated = await mutate(context, context.token, {
        type: 'UPDATE_STRATEGY_CARD',
        accId: left.accountId,
        cardId: left.strategyCardId,
        patch: { title: 'Still updateable' },
      });
      expect(updated.statusCode).toBe(200);
      await expect(context.prisma.strategyCard.findUnique({ where: { id: left.strategyCardId } })).resolves.toMatchObject({ title: 'Still updateable' });

      const deleted = await mutate(context, context.token, {
        type: 'DELETE_STRATEGY_CARD',
        accId: left.accountId,
        cardId: left.strategyCardId,
      });
      expect(deleted.statusCode).toBe(200);
      await expect(context.prisma.strategyCard.findUnique({ where: { id: left.strategyCardId } })).resolves.toBeNull();
      await expect(context.prisma.strategyCard.findUnique({ where: { id: 'card-plan-ref-cross-tree-dirty' } })).resolves.toMatchObject({
        dispatchedActionIds: JSON.stringify([left.planActionId, right.planActionId]),
      });
      await expect(context.prisma.strategyCard.findUnique({ where: { id: 'card-plan-ref-invalid-person-dirty' } })).resolves.toMatchObject({
        dispatchedActionIds: JSON.stringify([left.planActionId, malformedActionId]),
      });
    } finally {
      await context.cleanup();
    }
  });

  it('rolls back PlanAction deletion when a referenced StrategyCard changes after the read', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'plan-ref-cas');
      await context.prisma.strategyCard.update({
        where: { id: tree.strategyCardId },
        data: { dispatchedActionIds: JSON.stringify([tree.planActionId]) },
      });
      context.prisma.$use(async (params, next) => {
        if (
          params.model === 'StrategyCard'
          && params.action === 'updateMany'
          && params.args?.where?.id === tree.strategyCardId
        ) return { count: 0 };
        return next(params);
      });

      const response = await mutate(context, context.token, {
        type: 'DELETE_PLAN_ACTION',
        accId: tree.accountId,
        actionId: tree.planActionId,
      });

      expect(response.statusCode).toBe(409);
      await expect(context.prisma.planAction.findUnique({ where: { id: tree.planActionId } })).resolves.not.toBeNull();
      await expect(context.prisma.strategyCard.findUnique({ where: { id: tree.strategyCardId } })).resolves.toMatchObject({
        dispatchedActionIds: JSON.stringify([tree.planActionId]),
      });
    } finally {
      await context.cleanup();
    }
  });

  it('returns a generic 404 for foreign Account updates and disables Account hard delete for every tenant', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'foreign-account');
      const treeB = await seedTree(context.prisma, tenantB.tenantId, 'foreign-account-b');
      expectScopedNotFound(await mutate(context, context.token, {
        type: 'UPDATE_ACCOUNT', accId: treeB.accountId, patch: { name: 'must not change' },
      }));
      expectHardDeleteDisabled(await mutate(context, context.token, {
        type: 'DELETE_ACCOUNT', accId: treeB.accountId,
      }));
      await expect(context.prisma.account.findUnique({ where: { id: treeB.accountId } })).resolves.toMatchObject({ name: 'Account foreign-account-b' });
    } finally {
      await context.cleanup();
    }
  });

  it('allows a tenant-scoped role/member pair when a historical foreign-tenant pair already exists', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'historical-pair-b');
      const treeA = await seedTree(context.prisma, context.tenant.id, 'historical-pair-a');
      await context.prisma.oppRole.create({
        data: {
          tenantId: tenantB.tenantId,
          opportunityId: treeA.opportunityId,
          personId: treeA.targetPersonId,
          role: 'U',
          sentiment: 'unknown',
          confidence: '不清',
        },
      });
      await context.prisma.opportunityMember.create({
        data: {
          tenantId: tenantB.tenantId,
          opportunityId: treeA.opportunityId,
          personId: treeA.sourcePersonId,
        },
      });

      const roleResponse = await mutate(context, context.token, {
        type: 'SET_ROLE',
        accId: treeA.accountId,
        oppId: treeA.opportunityId,
        personId: treeA.targetPersonId,
        patch: { role: 'D' },
      });
      const memberResponse = await mutate(context, context.token, {
        type: 'ADD_OPP_MEMBER',
        accId: treeA.accountId,
        oppId: treeA.opportunityId,
        personId: treeA.sourcePersonId,
      });

      expect(roleResponse.statusCode).toBe(200);
      expect(memberResponse.statusCode).toBe(200);
      const [roles, members] = await Promise.all([
        context.prisma.oppRole.findMany({
          where: { opportunityId: treeA.opportunityId, personId: treeA.targetPersonId },
          orderBy: { tenantId: 'asc' },
        }),
        context.prisma.opportunityMember.findMany({
          where: { opportunityId: treeA.opportunityId, personId: treeA.sourcePersonId },
          orderBy: { tenantId: 'asc' },
        }),
      ]);
      expect(new Set(roles.map((row) => row.tenantId))).toEqual(new Set([context.tenant.id, tenantB.tenantId]));
      expect(new Set(members.map((row) => row.tenantId))).toEqual(new Set([context.tenant.id, tenantB.tenantId]));
      expect(roles.find((row) => row.tenantId === context.tenant.id)?.role).toBe('D');
    } finally {
      await context.cleanup();
    }
  });

  it('fails parent deletes closed when any Prisma-cascaded child belongs to another tenant', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'cascade-guard-b');
      const cases: Array<{
        label: string;
        parent: 'account' | 'opportunity';
        insert: (tree: SeededTree, suffix: string) => Promise<() => Promise<unknown>>;
      }> = [
        {
          label: 'Account -> Person', parent: 'account',
          insert: async (tree, suffix) => {
            const id = `foreign-person-${suffix}`;
            await context.prisma.person.create({ data: { id, tenantId: tenantB.tenantId, accountId: tree.accountId, name: 'foreign', title: 'foreign' } });
            return () => context.prisma.person.findUnique({ where: { id } });
          },
        },
        {
          label: 'Account -> Opportunity', parent: 'account',
          insert: async (tree, suffix) => {
            const id = `foreign-opp-${suffix}`;
            await context.prisma.opportunity.create({ data: { id, tenantId: tenantB.tenantId, accountId: tree.accountId, name: 'foreign', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' } });
            return () => context.prisma.opportunity.findUnique({ where: { id } });
          },
        },
        {
          label: 'Account -> Edge', parent: 'account',
          insert: async (tree, suffix) => {
            const id = `foreign-account-edge-${suffix}`;
            await context.prisma.edge.create({ data: { id, tenantId: tenantB.tenantId, accountId: tree.accountId, source: tree.sourcePersonId, target: tree.targetPersonId, layer: 'L1', label: 'foreign' } });
            return () => context.prisma.edge.findUnique({ where: { id } });
          },
        },
        {
          label: 'Account -> Opportunity -> OppRole', parent: 'account',
          insert: async (tree) => {
            const row = await context.prisma.oppRole.create({ data: { tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, personId: tree.targetPersonId, role: 'U', sentiment: 'unknown', confidence: '不清' } });
            return () => context.prisma.oppRole.findUnique({ where: { id: row.id } });
          },
        },
        {
          label: 'Opportunity -> RelSuggestion', parent: 'opportunity',
          insert: async (tree, suffix) => {
            const id = `foreign-suggestion-${suffix}`;
            await context.prisma.relSuggestion.create({ data: { id, tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, sourcePersonId: tree.sourcePersonId, targetPersonId: tree.targetPersonId, layer: 'L2', label: 'foreign' } });
            return () => context.prisma.relSuggestion.findUnique({ where: { id } });
          },
        },
        {
          label: 'Opportunity -> OppRole', parent: 'opportunity',
          insert: async (tree) => {
            const row = await context.prisma.oppRole.create({ data: { tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, personId: tree.targetPersonId, role: 'U', sentiment: 'unknown', confidence: '不清' } });
            return () => context.prisma.oppRole.findUnique({ where: { id: row.id } });
          },
        },
        {
          label: 'Opportunity -> OpportunityMember', parent: 'opportunity',
          insert: async (tree) => {
            const row = await context.prisma.opportunityMember.create({ data: { tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, personId: tree.sourcePersonId } });
            return () => context.prisma.opportunityMember.findUnique({ where: { id: row.id } });
          },
        },
        {
          label: 'Opportunity -> Edge', parent: 'opportunity',
          insert: async (tree, suffix) => {
            const id = `foreign-opp-edge-${suffix}`;
            await context.prisma.edge.create({ data: { id, tenantId: tenantB.tenantId, accountId: tree.accountId, opportunityId: tree.opportunityId, source: tree.sourcePersonId, target: tree.targetPersonId, layer: 'L2', label: 'foreign' } });
            return () => context.prisma.edge.findUnique({ where: { id } });
          },
        },
        {
          label: 'Opportunity -> BurningIssue', parent: 'opportunity',
          insert: async (tree, suffix) => {
            const id = `foreign-bi-${suffix}`;
            await context.prisma.burningIssue.create({ data: { id, tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, personId: tree.targetPersonId, description: 'foreign', category: 'foreign', confidence: '不清' } });
            return () => context.prisma.burningIssue.findUnique({ where: { id } });
          },
        },
        {
          label: 'Opportunity -> UCV', parent: 'opportunity',
          insert: async (tree, suffix) => {
            const id = `foreign-ucv-${suffix}`;
            await context.prisma.uCV.create({ data: { id, tenantId: tenantB.tenantId, opportunityId: tree.opportunityId, targetBiId: tree.biId, description: 'foreign', competitorCannot: 'foreign', status: '建议' } });
            return () => context.prisma.uCV.findUnique({ where: { id } });
          },
        },
      ];

      for (const [index, cascadeCase] of cases.entries()) {
        const suffix = `cascade-${index}`;
        const tree = await seedTree(context.prisma, context.tenant.id, suffix);
        const findForeignChild = await cascadeCase.insert(tree, suffix);
        const action: Action = cascadeCase.parent === 'account'
          ? { type: 'DELETE_ACCOUNT', accId: tree.accountId }
          : { type: 'DELETE_OPP', accId: tree.accountId, oppId: tree.opportunityId };
        const response = await mutate(context, context.token, action);

        expectHardDeleteDisabled(response);
        await expect(context.prisma.account.findUnique({ where: { id: tree.accountId } }), cascadeCase.label).resolves.not.toBeNull();
        await expect(findForeignChild(), cascadeCase.label).resolves.not.toBeNull();
      }
    } finally {
      await context.cleanup();
    }
  });

  it('guards every existing child update/delete path against a same-tenant wrong Account tree', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'wrong-tree-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'wrong-tree-right');
      const actions = [
        { type: 'UPDATE_OPP', accId: left.accountId, oppId: right.opportunityId, patch: { name: 'attack' } },
        { type: 'DELETE_OPP', accId: left.accountId, oppId: right.opportunityId },
        { type: 'UPDATE_PERSON', accId: left.accountId, personId: right.sourcePersonId, patch: { title: 'attack' } },
        { type: 'MOVE_PERSON', accId: left.accountId, personId: right.sourcePersonId, x: 1, y: 1 },
        { type: 'DELETE_PERSON', accId: left.accountId, personId: right.sourcePersonId },
        { type: 'ADD_LOG', accId: left.accountId, personId: right.sourcePersonId, log: { date: '2026-07-12', content: 'attack' } },
        { type: 'SET_ROLE', accId: left.accountId, oppId: right.opportunityId, personId: right.targetPersonId, patch: { role: 'D' } },
        { type: 'REMOVE_ROLE', accId: left.accountId, oppId: right.opportunityId, personId: right.sourcePersonId },
        { type: 'ADD_OPP_MEMBER', accId: left.accountId, oppId: right.opportunityId, personId: right.sourcePersonId },
        { type: 'REMOVE_OPP_MEMBER', accId: left.accountId, oppId: right.opportunityId, personId: right.targetPersonId },
        { type: 'ADD_EDGE', accId: left.accountId, oppId: right.opportunityId, edge: { id: 'wrong-tree-edge-create', source: right.sourcePersonId, target: right.targetPersonId, layer: 'L2', label: 'attack' } },
        { type: 'UPDATE_EDGE', accId: left.accountId, oppId: right.opportunityId, edgeId: right.edgeId, patch: { label: 'attack' } },
        { type: 'DELETE_EDGE', accId: left.accountId, oppId: right.opportunityId, edgeId: right.edgeId },
        { type: 'ADD_BI', accId: left.accountId, oppId: right.opportunityId, bi: { id: 'wrong-tree-bi-create', personId: right.sourcePersonId, description: 'attack', category: 'test', isPrivate: true, confidence: '明确' } },
        { type: 'UPDATE_BI', accId: left.accountId, oppId: right.opportunityId, biId: right.biId, patch: { description: 'attack' } },
        { type: 'DELETE_BI', accId: left.accountId, oppId: right.opportunityId, biId: right.biId },
        { type: 'ADD_UCV', accId: left.accountId, oppId: right.opportunityId, ucv: { id: 'wrong-tree-ucv-create', targetBiId: right.biId, description: 'attack', competitorCannot: 'attack', status: '建议' } },
        { type: 'UPDATE_UCV', accId: left.accountId, oppId: right.opportunityId, ucvId: right.ucvId, patch: { description: 'attack' } },
        { type: 'DELETE_UCV', accId: left.accountId, oppId: right.opportunityId, ucvId: right.ucvId },
        { type: 'ADD_VISIT', accId: left.accountId, visit: { id: 'wrong-tree-visit-create', opportunityId: right.opportunityId, date: '2026-07-12', topic: 'attack', summary: 'attack' } },
        { type: 'UPDATE_VISIT', accId: left.accountId, visitId: right.visitId, patch: { topic: 'attack' } },
        { type: 'DELETE_VISIT', accId: left.accountId, visitId: right.visitId },
        { type: 'ADD_NOTE', accId: left.accountId, note: { id: 'wrong-tree-note-create', opportunityId: right.opportunityId, personId: right.sourcePersonId, content: 'attack' } },
        { type: 'UPDATE_NOTE', accId: left.accountId, noteId: right.noteId, patch: { content: 'attack' } },
        { type: 'DELETE_NOTE', accId: left.accountId, noteId: right.noteId },
        { type: 'ADD_PLAN_ACTION', accId: left.accountId, oppId: right.opportunityId, planAction: { id: 'wrong-tree-plan-create', title: 'attack', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false } },
        { type: 'UPDATE_PLAN_ACTION', accId: left.accountId, actionId: right.planActionId, patch: { title: 'attack' } },
        { type: 'DELETE_PLAN_ACTION', accId: left.accountId, actionId: right.planActionId },
        { type: 'TOGGLE_PLAN_ACTION', accId: left.accountId, actionId: right.planActionId, done: true },
        { type: 'ADD_MILESTONE', accId: left.accountId, oppId: right.opportunityId, milestone: { id: 'wrong-tree-milestone-create', title: 'attack', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am' } },
        { type: 'UPDATE_MILESTONE', accId: left.accountId, milestoneId: right.milestoneId, patch: { title: 'attack' } },
        { type: 'DELETE_MILESTONE', accId: left.accountId, milestoneId: right.milestoneId },
        { type: 'ADD_OPP_STAGE', accId: left.accountId, oppId: right.opportunityId, stage: { id: 'wrong-tree-stage-create', stageKey: '需求引导', startDate: '2026-07-12', endDate: '2026-07-12' } },
        { type: 'UPDATE_OPP_STAGE', accId: left.accountId, stageId: right.stageId, patch: { stageKey: '方案认可' } },
        { type: 'DELETE_OPP_STAGE', accId: left.accountId, stageId: right.stageId },
        { type: 'ADD_STRATEGY_CARD', accId: left.accountId, oppId: right.opportunityId, card: { id: 'wrong-tree-card-create', title: 'attack', personId: right.sourcePersonId } },
        { type: 'UPDATE_STRATEGY_CARD', accId: left.accountId, cardId: right.strategyCardId, patch: { title: 'attack' } },
        { type: 'DELETE_STRATEGY_CARD', accId: left.accountId, cardId: right.strategyCardId },
        { type: 'ADD_STRATEGY_RISK', accId: left.accountId, oppId: right.opportunityId, risk: { id: 'wrong-tree-risk-create', kind: 'risk', text: 'attack' } },
        { type: 'UPDATE_STRATEGY_RISK', accId: left.accountId, riskId: right.strategyRiskId, patch: { text: 'attack' } },
        { type: 'DELETE_STRATEGY_RISK', accId: left.accountId, riskId: right.strategyRiskId },
        { type: 'ADD_STRATEGY_RESOURCE', accId: left.accountId, oppId: right.opportunityId, resource: { id: 'wrong-tree-resource-create', label: 'attack' } },
        { type: 'UPDATE_STRATEGY_RESOURCE', accId: left.accountId, resourceId: right.strategyResourceId, patch: { label: 'attack' } },
        { type: 'DELETE_STRATEGY_RESOURCE', accId: left.accountId, resourceId: right.strategyResourceId },
        { type: 'ADD_EVIDENCE', accId: left.accountId, oppId: right.opportunityId, evidence: { id: 'wrong-tree-evidence-create', personId: right.sourcePersonId, signalKey: 'attack', direction: 1, tier: 'mid' } },
        { type: 'DELETE_EVIDENCE', accId: left.accountId, oppId: right.opportunityId, evidenceId: right.evidenceId },
      ] satisfies Action[];

      for (const action of actions) {
        const before = await stateFor(context, context.token);
        const response = await mutate(context, context.token, action);
        if (action.type === 'DELETE_OPP') expectHardDeleteDisabled(response);
        else expectScopedNotFound(response);
        await expect(stateFor(context, context.token), action.type).resolves.toEqual(before);
      }
    } finally {
      await context.cleanup();
    }
  });

  it('validates every newly patched reference inside the target Account tree', async () => {
    const context = await createTestContext();
    try {
      const left = await seedTree(context.prisma, context.tenant.id, 'patched-ref-left');
      const right = await seedTree(context.prisma, context.tenant.id, 'patched-ref-right');
      const actions = [
        { type: 'ADD_STRATEGY_CARD', accId: left.accountId, oppId: left.opportunityId, card: { id: 'patched-ref-card-create', title: 'attack', dispatchedActionIds: [right.planActionId] } },
        { type: 'UPDATE_STRATEGY_CARD', accId: left.accountId, cardId: left.strategyCardId, patch: { dispatchedActionIds: [right.planActionId] } },
        { type: 'UPDATE_EDGE', accId: left.accountId, oppId: left.opportunityId, edgeId: left.edgeId, patch: { target: right.targetPersonId } },
        { type: 'UPDATE_UCV', accId: left.accountId, oppId: left.opportunityId, ucvId: left.ucvId, patch: { targetBiId: right.biId } },
        { type: 'UPDATE_VISIT', accId: left.accountId, visitId: left.visitId, patch: { opportunityId: right.opportunityId } },
        { type: 'UPDATE_NOTE', accId: left.accountId, noteId: left.noteId, patch: { opportunityId: right.opportunityId } },
        { type: 'UPDATE_NOTE', accId: left.accountId, noteId: left.noteId, patch: { personId: right.sourcePersonId } },
        { type: 'UPDATE_PLAN_ACTION', accId: left.accountId, actionId: left.planActionId, patch: { personId: right.sourcePersonId } },
        { type: 'UPDATE_STRATEGY_CARD', accId: left.accountId, cardId: left.strategyCardId, patch: { personId: right.sourcePersonId } },
      ] satisfies Action[];

      for (const action of actions) {
        const before = await stateFor(context, context.token);
        const response = await mutate(context, context.token, action);
        expectScopedNotFound(response);
        await expect(stateFor(context, context.token), action.type).resolves.toEqual(before);
      }
    } finally {
      await context.cleanup();
    }
  });

  it('allows a base edge to be updated and deleted through a valid same-tree opportunity context', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'base-edge');
      await context.prisma.edge.create({
        data: {
          id: 'base-edge-target',
          tenantId: context.tenant.id,
          accountId: tree.accountId,
          source: tree.sourcePersonId,
          target: tree.targetPersonId,
          layer: 'L1',
          label: 'base',
        },
      });
      const updated = await mutate(context, context.token, {
        type: 'UPDATE_EDGE', accId: tree.accountId, oppId: tree.opportunityId,
        edgeId: 'base-edge-target', patch: { label: 'updated base' }, baseVersion: 0,
      });
      expect(updated.statusCode).toBe(200);
      await expect(context.prisma.edge.findUnique({ where: { id: 'base-edge-target' } })).resolves.toMatchObject({
        opportunityId: null,
        label: 'updated base',
      });

      const deleted = await mutate(context, context.token, {
        type: 'DELETE_EDGE', accId: tree.accountId, oppId: tree.opportunityId, edgeId: 'base-edge-target',
      });
      expect(deleted.statusCode).toBe(200);
      await expect(context.prisma.edge.findUnique({ where: { id: 'base-edge-target' } })).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('drops malformed nested and separately queried rows and emits one content-free aggregate warning', async () => {
    const context = await createTestContext();
    try {
      const tenantB = await registerTenant(context, 'state-defense-b');
      const treeA = await seedTree(context.prisma, context.tenant.id, 'state-defense-a');
      const treeB = await seedTree(context.prisma, tenantB.tenantId, 'state-defense-b');
      const malformedPersonId = 'malformed-nested-person';
      const malformedVisitId = 'malformed-standalone-visit';
      const malformedNoteId = 'malformed-note-reference';
      const malformedCardId = 'malformed-card-action-reference';
      await context.prisma.person.create({
        data: {
          id: malformedPersonId,
          tenantId: context.tenant.id,
          accountId: treeB.accountId,
          name: 'must never be returned',
          title: 'must never be returned',
        },
      });
      await context.prisma.visitNote.create({
        data: {
          id: malformedVisitId,
          tenantId: tenantB.tenantId,
          accountId: treeA.accountId,
          opportunityId: treeA.opportunityId,
          summary: 'must never be returned',
        },
      });
      await context.prisma.note.create({
        data: {
          id: malformedNoteId,
          tenantId: tenantB.tenantId,
          accountId: treeB.accountId,
          opportunityId: treeA.opportunityId,
          personId: treeA.sourcePersonId,
          content: 'must never be returned',
        },
      });
      await context.prisma.strategyCard.create({
        data: {
          id: malformedCardId,
          tenantId: tenantB.tenantId,
          accountId: treeB.accountId,
          opportunityId: treeB.opportunityId,
          title: 'must never be returned',
          dispatchedActionIds: JSON.stringify([treeA.planActionId]),
        },
      });

      const warnings: StateSecurityWarning[] = [];
      const state = await assembleState(tenantB.tenantId, { tenantId: tenantB.tenantId, userId: tenantB.userId, role: 'owner' }, {
        onSecurityWarning: (warning) => warnings.push(warning),
      });
      const serialized = JSON.stringify(state);

      expect(serialized).not.toContain(malformedPersonId);
      expect(serialized).not.toContain(malformedVisitId);
      expect(serialized).not.toContain(malformedNoteId);
      expect(serialized).not.toContain(malformedCardId);
      expect(serialized).not.toContain(treeA.planActionId);
      expect(serialized).not.toContain('must never be returned');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        event: 'state_scope_rows_dropped',
        tenantId: tenantB.tenantId,
        counts: {
          Person: { tenant_mismatch: 1 },
          VisitNote: { account_mismatch: 1 },
          Note: { opportunity_mismatch: 1, person_mismatch: 1 },
          StrategyCard: { plan_action_mismatch: 1 },
        },
      });
      expect(warnings[0].samples.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(warnings[0])).not.toContain('must never be returned');
    } finally {
      await context.cleanup();
    }
  });

  it('reuses a caller TransactionClient without nesting and rolls back the guarded write with its caller', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'caller-transaction');
      const ctx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'caller-transaction-test',
        assertionMode: 'user_asserted',
      };
      await expect(context.prisma.$transaction(async (tx) => {
        await applyAction(ctx, {
          type: 'ADD_PERSON',
          accId: tree.accountId,
          person: { id: 'caller-transaction-person', name: 'Rollback', title: 'Rollback' },
        }, tx);
        throw new Error('force caller rollback');
      })).rejects.toThrow('force caller rollback');

      await expect(context.prisma.person.findUnique({ where: { id: 'caller-transaction-person' } })).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('uses Serializable and retries a top-level P2034 conflict at most until the third successful attempt', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'serializable-retry');
      const ctx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'serializable-retry-test',
        assertionMode: 'user_asserted',
      };
      const optionsSeen: Array<InteractiveTransactionOptions | undefined> = [];
      let attempts = 0;
      const retryingClient = observeTopLevelTransactions(context.prisma, (options) => {
        optionsSeen.push(options);
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('synthetic serializable conflict'), { code: 'P2034' });
        }
      });

      await applyAction(ctx, {
        type: 'ADD_PERSON',
        accId: tree.accountId,
        person: { id: 'serializable-retry-person', name: 'Retry', title: 'Retry' },
      }, retryingClient);

      expect(attempts).toBe(3);
      expect(optionsSeen).toHaveLength(3);
      for (const options of optionsSeen) expect(options).toMatchObject({ isolationLevel: 'Serializable' });
      await expect(context.prisma.person.findUnique({ where: { id: 'serializable-retry-person' } })).resolves.not.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('does not retry a top-level transaction error other than P2034', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'no-retry');
      const ctx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'no-retry-test',
        assertionMode: 'user_asserted',
      };
      let attempts = 0;
      const failingClient = observeTopLevelTransactions(context.prisma, () => {
        attempts += 1;
        throw Object.assign(new Error('synthetic non-retryable error'), { code: 'P2002' });
      });

      await expect(applyAction(ctx, {
        type: 'ADD_PERSON',
        accId: tree.accountId,
        person: { id: 'no-retry-person', name: 'No retry', title: 'No retry' },
      }, failingClient)).rejects.toMatchObject({ code: 'P2002' });
      expect(attempts).toBe(1);
      await expect(context.prisma.person.findUnique({ where: { id: 'no-retry-person' } })).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('translates an exhausted third P2034 into the existing 409 conflict contract', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'retry-exhausted');
      const ctx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'retry-exhausted-test',
        assertionMode: 'user_asserted',
      };
      let attempts = 0;
      const conflictingClient = observeTopLevelTransactions(context.prisma, () => {
        attempts += 1;
        throw Object.assign(new Error('synthetic exhausted conflict'), { code: 'P2034' });
      });

      await expect(applyAction(ctx, {
        type: 'ADD_PERSON',
        accId: tree.accountId,
        person: { id: 'retry-exhausted-person', name: 'Conflict', title: 'Conflict' },
      }, conflictingClient)).rejects.toMatchObject({ conflict: true });
      expect(attempts).toBe(3);
      await expect(context.prisma.person.findUnique({ where: { id: 'retry-exhausted-person' } })).resolves.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('preserves optimistic-lock conflicts as 409 after scope validation', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context.prisma, context.tenant.id, 'conflict-contract');
      const first = await mutate(context, context.token, {
        type: 'UPDATE_PERSON', accId: tree.accountId, personId: tree.sourcePersonId, patch: { title: 'first' }, baseVersion: 0,
      });
      expect(first.statusCode).toBe(200);
      const stale = await mutate(context, context.token, {
        type: 'UPDATE_PERSON', accId: tree.accountId, personId: tree.sourcePersonId, patch: { title: 'stale' }, baseVersion: 0,
      });
      expect(stale.statusCode).toBe(409);
    } finally {
      await context.cleanup();
    }
  });
});
