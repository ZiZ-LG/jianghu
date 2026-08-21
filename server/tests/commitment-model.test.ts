import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { applyAction } from '../src/mutate.js';
import {
  mapLegacyPlanActionToCommitmentFields,
  type LegacyPlanActionMappingInput,
} from '../src/commitment/legacy.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const LEGACY_ACTION: LegacyPlanActionMappingInput = {
  startDate: '2026-10-07',
  endDate: '2026-10-08',
  done: false,
  origin: 'workbuddy',
};

describe('CORE-106 legacy PlanAction mapping', () => {
  it('maps the stable row to an all-day Commitment without fabricating UTC', () => {
    expect(mapLegacyPlanActionToCommitmentFields(LEGACY_ACTION, 'user-cao')).toEqual({
      kind: 'task',
      ownerUserId: 'user-cao',
      executionStatus: 'planned',
      confirmationStatus: 'not_required',
      scheduledAtUtc: null,
      dueAtUtc: null,
      timeZone: 'Asia/Shanghai',
      isAllDay: true,
      localDate: '2026-10-08',
      confirmationDueAtUtc: null,
      confirmedAtUtc: null,
      confirmedByUserId: null,
      scheduleVersion: 0,
      nextCommitmentId: null,
      source: 'workbuddy',
      sourceRef: null,
      archivedAt: null,
      version: 0,
    });
  });

  it('maps completion deterministically and preserves an explicit unassigned owner', () => {
    expect(mapLegacyPlanActionToCommitmentFields({
      ...LEGACY_ACTION,
      done: true,
      origin: '   ',
    }, null)).toMatchObject({
      ownerUserId: null,
      executionStatus: 'completed',
      source: 'manual',
    });
  });

  it('fails closed for missing or impossible legacy business dates', () => {
    expect(() => mapLegacyPlanActionToCommitmentFields({
      ...LEGACY_ACTION,
      endDate: '2026-02-31',
    }, null)).toThrow('invalid legacy PlanAction endDate');
    expect(() => mapLegacyPlanActionToCommitmentFields({
      ...LEGACY_ACTION,
      startDate: '',
      endDate: '',
    }, null)).toThrow('legacy PlanAction requires a business date');
  });
});

describe('CORE-107 legacy write adapter', () => {
  let test: TestContext;
  let ctx: CommandContext;

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'core-106-legacy-write',
      assertionMode: 'user_asserted',
    };
    await test.prisma.account.create({ data: {
      id: 'commitment-customer', tenantId: test.tenant.id, name: 'Customer', customerType: 1,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'commitment-matter', tenantId: test.tenant.id, accountId: 'commitment-customer',
      name: 'Matter', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
  });

  afterEach(async () => test.cleanup());

  it('keeps the same-row Commitment authoritative and invalidates generic CAS on legacy writes', async () => {
    await applyAction(ctx, {
      type: 'ADD_PLAN_ACTION',
      accId: 'commitment-customer',
      oppId: 'commitment-matter',
      planAction: {
        id: 'commitment-plan-action', title: '拜访客户',
        startDate: '2026-10-07', endDate: '2026-10-08', half: 'am', done: false,
        origin: 'workbuddy',
      },
    }, test.prisma);

    await expect(test.prisma.planAction.findUniqueOrThrow({
      where: { id: 'commitment-plan-action' },
    })).resolves.toMatchObject({
      kind: 'task', ownerId: test.owner.id, ownerUserId: test.owner.id,
      executionStatus: 'planned', confirmationStatus: 'not_required',
      scheduledAtUtc: null, dueAtUtc: null, timeZone: 'Asia/Shanghai',
      isAllDay: true, localDate: '2026-10-08', scheduleVersion: 0,
      source: 'workbuddy', version: 0,
    });

    await applyAction(ctx, {
      type: 'UPDATE_PLAN_ACTION', accId: 'commitment-customer', actionId: 'commitment-plan-action',
      patch: { endDate: '2026-10-09', done: true },
    }, test.prisma);
    await expect(test.prisma.planAction.findUniqueOrThrow({
      where: { id: 'commitment-plan-action' },
    })).resolves.toMatchObject({
      localDate: '2026-10-09', executionStatus: 'completed', scheduleVersion: 1, version: 1,
    });

    await applyAction(ctx, {
      type: 'TOGGLE_PLAN_ACTION', accId: 'commitment-customer', actionId: 'commitment-plan-action', done: false,
    }, test.prisma);
    await expect(test.prisma.planAction.findUniqueOrThrow({
      where: { id: 'commitment-plan-action' },
    })).resolves.toMatchObject({ executionStatus: 'planned', done: false, scheduleVersion: 1, version: 2 });
  });
});
