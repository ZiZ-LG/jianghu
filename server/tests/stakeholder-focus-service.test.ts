import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntelligenceItemCommandSchema,
  StakeholderFocusCommandSchema,
  type CapabilityPolicy,
  type CommandContext,
} from '@jianghu/domain-contracts';
import {
  executeIntelligenceItemCommand,
  executeStakeholderFocusCommand,
  listStakeholderFocuses,
  stakeholderFocusDetail,
} from '../src/intelligenceFocus/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
const now = new Date('2026-08-28T00:00:00.000Z');

describe('SAAS-206 explicit StakeholderFocus authority', () => {
  let test: TestContext;
  let ctx: CommandContext;
  const customerId = 'customer-206-focus';
  const matterId = 'matter-206-focus';
  const personId = 'person-206-focus';
  const otherPersonId = 'person-206-focus-other';

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner', channel: 'web',
      requestId: randomUUID(), assertionMode: 'user_asserted',
    };
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: '聚焦客户', primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId, name: '聚焦事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test.owner.id,
      primaryDPersonId: otherPersonId,
    } });
    await test.prisma.person.createMany({ data: [
      { id: personId, tenantId: test.tenant.id, accountId: customerId, name: '聚焦人', title: '负责人' },
      { id: otherPersonId, tenantId: test.tenant.id, accountId: customerId, name: '旧 D', title: '总监' },
    ] });
    await test.prisma.matterParticipant.createMany({ data: [
      { tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId },
      { tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId: otherPersonId },
    ] });
    await test.prisma.$transaction((tx) => executeIntelligenceItemCommand(tx, ctx, policy,
      IntelligenceItemCommandSchema.parse({
        type: 'CREATE_INTELLIGENCE_ITEM', item: {
          id: 'intel-focus-basis', customerId, matterId, statement: '评审人需要风险澄清。',
          source: { description: '人工确认纪要' }, learnedAt: '2026-08-27T12:00:00.000Z',
          confidence: 0.8, targets: [{ kind: 'person', id: personId }],
        },
      })));
  });
  afterEach(async () => test.cleanup());

  function setCommand(id: string, expectedId: string | null, expectedVersion: number | null, person = personId) {
    return StakeholderFocusCommandSchema.parse({
      type: 'SET_STAKEHOLDER_FOCUS',
      focus: {
        id, customerId, matterId, personId: person,
        desiredChange: '让负责人确认下一次评审条件', rationale: '负责人掌握评审排期',
        evidenceGap: null,
        basisRefs: [{ kind: 'intelligence_item', id: 'intel-focus-basis', version: 0 }],
        validUntil: '2026-09-10T00:00:00.000Z',
      },
      expectedCurrentFocusId: expectedId,
      expectedCurrentFocusVersion: expectedVersion,
    });
  }

  const execute = async (command: ReturnType<typeof StakeholderFocusCommandSchema.parse>) => (
    test.prisma.$transaction((tx) => executeStakeholderFocusCommand(tx, ctx, policy, command, now))
  );

  it('sets one server-confirmed current focus without reading or changing legacy primary D', async () => {
    const before = await test.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } });
    const receipt = await execute(setCommand('focus-206-a', null, null));
    expect(receipt).toEqual({
      type: 'SET_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-206-a', customerId, matterId,
      personId, status: 'active', version: 0, undoable: false,
    });
    const focus = await test.prisma.stakeholderFocus.findUniqueOrThrow({ where: { id: 'focus-206-a' } });
    expect(focus).toMatchObject({
      tenantId: test.tenant.id, activeMatterKey: matterId, confirmedByUserId: test.owner.id,
      confirmedAt: now, retiredAt: null, version: 0,
    });
    const after = await test.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } });
    expect(after.primaryDPersonId).toBe(before.primaryDPersonId);
    expect(after.version).toBe(before.version);
    const audit = await test.prisma.auditEvent.findFirstOrThrow({ where: { entityId: 'focus-206-a' } });
    expect(audit.metadata).not.toContain('让负责人');
    expect(audit.metadata).not.toContain('掌握评审');
  });

  it('requires an active MatterParticipant, exact basis version, future validity and human confirmation', async () => {
    await test.prisma.matterParticipant.delete({
      where: { tenantId_opportunityId_personId: { tenantId: test.tenant.id, opportunityId: matterId, personId } },
    });
    await expect(execute(setCommand('focus-no-participant', null, null))).rejects.toMatchObject({ scopedNotFound: true });
    await test.prisma.matterParticipant.create({ data: {
      tenantId: test.tenant.id, accountId: customerId, opportunityId: matterId, personId,
    } });
    const stale = setCommand('focus-stale-basis', null, null);
    if (stale.type !== 'SET_STAKEHOLDER_FOCUS') throw new Error('fixture');
    stale.focus.basisRefs[0]!.version = 9;
    await expect(execute(stale)).rejects.toMatchObject({ code: 'stakeholder_focus_basis_version_conflict' });
    const expired = setCommand('focus-expired', null, null);
    if (expired.type !== 'SET_STAKEHOLDER_FOCUS') throw new Error('fixture');
    expired.focus.validUntil = '2026-08-27T00:00:00.000Z';
    await expect(execute(expired)).rejects.toMatchObject({ code: 'stakeholder_focus_validity_conflict' });
    ctx = { ...ctx, assertionMode: 'machine_proposed' };
    await expect(execute(setCommand('focus-machine', null, null))).rejects.toMatchObject({ code: 'human_confirmation_required' });
    expect(await test.prisma.stakeholderFocus.count()).toBe(0);
  });

  it('uses expected-current CAS for replacement and retirement', async () => {
    await execute(setCommand('focus-206-a', null, null));
    await expect(execute(setCommand('focus-206-stale', null, null)))
      .rejects.toMatchObject({ code: 'stakeholder_focus_current_conflict', statusCode: 409 });
    await execute(setCommand('focus-206-b', 'focus-206-a', 0, otherPersonId));
    await expect(test.prisma.stakeholderFocus.findUniqueOrThrow({ where: { id: 'focus-206-a' } }))
      .resolves.toMatchObject({ activeMatterKey: null, retiredByUserId: test.owner.id, version: 1 });
    await expect(test.prisma.stakeholderFocus.findUniqueOrThrow({ where: { id: 'focus-206-b' } }))
      .resolves.toMatchObject({ activeMatterKey: matterId, version: 0 });
    await expect(execute(StakeholderFocusCommandSchema.parse({
      type: 'RETIRE_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-206-b', expectedVersion: 1,
      reason: '错误版本',
    }))).rejects.toMatchObject({ code: 'stakeholder_focus_version_conflict' });
    await execute(StakeholderFocusCommandSchema.parse({
      type: 'RETIRE_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-206-b', expectedVersion: 0,
      reason: '本轮聚焦已经结束',
    }));
    expect(await test.prisma.stakeholderFocus.count({ where: { activeMatterKey: matterId } })).toBe(0);
  });

  it('stays identical when primary D changes or clears and enforces current read scope', async () => {
    await execute(setCommand('focus-206-a', null, null));
    const initial = await stakeholderFocusDetail(test.prisma, ctx, policy, 'focus-206-a', now);
    await test.prisma.opportunity.update({ where: { id: matterId }, data: { primaryDPersonId: personId } });
    expect(await stakeholderFocusDetail(test.prisma, ctx, policy, 'focus-206-a', now)).toEqual(initial);
    await test.prisma.opportunity.update({ where: { id: matterId }, data: { primaryDPersonId: null } });
    expect(await listStakeholderFocuses(test.prisma, ctx, policy, {
      customerId, matterId, includeRetired: false, cursor: null, limit: 50,
    }, now)).toMatchObject({ items: [{ id: 'focus-206-a', personId }] });

    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    await expect(stakeholderFocusDetail(test.prisma, ctx, policy, 'focus-206-a', now)).resolves.toBeNull();
  });
});
