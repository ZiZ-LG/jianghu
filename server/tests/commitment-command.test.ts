import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

const auth = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

const commitmentId = (suffix: string) => `commitment_${suffix.padEnd(32, '0').slice(0, 32)}`;

async function seedTree(context: Awaited<ReturnType<typeof createTestContext>>, suffix: string) {
  const customerId = `commitment-customer-${suffix}`;
  const matterId = `commitment-matter-${suffix}`;
  const personId = `commitment-person-${suffix}`;
  await context.prisma.account.create({ data: {
    id: customerId, tenantId: context.tenant.id, name: 'Commitment customer', customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: matterId, tenantId: context.tenant.id, accountId: customerId, name: 'Commitment Matter',
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
  } });
  await context.prisma.person.create({ data: {
    id: personId, tenantId: context.tenant.id, accountId: customerId, name: 'Contact', title: 'Sponsor',
  } });
  return { customerId, matterId, personId };
}

function timedCreate(
  tree: { customerId: string; matterId: string; personId: string },
  ownerUserId: string,
  id: string,
): any {
  return {
    type: 'CREATE_COMMITMENT',
    commitment: {
      id,
      customerId: tree.customerId,
      matterId: tree.matterId,
      personId: tree.personId,
      title: '与客户确认项目交流时间',
      kind: 'meeting',
      ownerUserId,
      confirmationStatus: 'pending',
      scheduledAtUtc: '2026-09-10T02:00:00Z',
      dueAtUtc: null,
      timeZone: 'Asia/Shanghai',
      isAllDay: false,
      localDate: null,
      confirmationDueAtUtc: '2026-09-09T02:00:00Z',
      source: 'manual',
      sourceRef: null,
    },
  };
}

async function command(
  context: Awaited<ReturnType<typeof createTestContext>>,
  key: string,
  payload: any,
  token = context.token,
) {
  return context.app.inject({
    method: 'POST', url: '/api/commands/commitment', headers: auth(token, key), payload,
  });
}

describe('CORE-107 Commitment command path', () => {
  it('creates once, replays without duplicate writes, and exposes the generic state projection', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'create');
      const payload = timedCreate(tree, context.owner.id, commitmentId('1'));

      const first = await command(context, 'commitment-create-stable', payload);
      const replay = await command(context, 'commitment-create-stable', payload);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        commitmentId: payload.commitment.id,
        customerId: tree.customerId,
        matterId: tree.matterId,
        executionStatus: 'planned',
        confirmationStatus: 'pending',
        version: 0,
        scheduleVersion: 0,
        replayed: false,
        undoable: false,
        repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
      });
      expect(replay.json()).toEqual({ ...first.json(), replayed: true });
      const reusedKey = await command(context, 'commitment-create-stable', {
        ...payload,
        commitment: { ...payload.commitment, title: '不同业务参数' },
      });
      expect(reusedKey.statusCode).toBe(409);
      expect(reusedKey.json()).toMatchObject({ code: 'idempotency_key_reused' });
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(await context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, action: 'commitment_created' },
      })).toBe(1);

      const stateResponse = await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      });
      expect(stateResponse.statusCode, stateResponse.body).toBe(200);
      const account = stateResponse.json<any>().accounts.find((item: any) => item.id === tree.customerId);
      expect(account.commitments).toEqual([expect.objectContaining({
        id: payload.commitment.id,
        customerId: tree.customerId,
        matterId: tree.matterId,
        personId: tree.personId,
        title: payload.commitment.title,
        scheduledAtUtc: '2026-09-10T02:00:00.000Z',
        confirmationStatus: 'pending',
        version: 0,
        scheduleVersion: 0,
      })]);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for viewer, invalid parentage and unauthorized assignment', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'scope');
      const other = await seedTree(context, 'other');
      const payload = timedCreate(tree, context.owner.id, commitmentId('2'));
      const viewer = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: `viewer-${randomUUID()}@example.test`,
        passwordHash: 'unused', name: 'Viewer', role: 'viewer',
      } });
      const viewerToken = context.app.jwt.sign({
        userId: viewer.id, tenantId: context.tenant.id, role: 'viewer',
      });

      const viewerAttempt = await command(context, 'commitment-viewer-denied', payload, viewerToken);
      expect(viewerAttempt.statusCode).toBe(403);

      const member = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: `member-${randomUUID()}@example.test`,
        passwordHash: 'unused', name: 'Member', role: 'member',
      } });
      const memberToken = context.app.jwt.sign({
        userId: member.id, tenantId: context.tenant.id, role: 'member',
      });
      const assignmentAttempt = await command(context, 'commitment-member-assign-denied', {
        ...payload,
        commitment: { ...payload.commitment, id: commitmentId('b'), ownerUserId: context.owner.id },
      }, memberToken);
      expect(assignmentAttempt.statusCode).toBe(403);
      expect(assignmentAttempt.json()).toMatchObject({ code: 'commitment_assign_forbidden' });

      const wrongPerson = await command(context, 'commitment-wrong-person', {
        ...payload,
        commitment: { ...payload.commitment, personId: other.personId },
      });
      expect(wrongPerson.statusCode).toBe(404);

      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityKind: 'commitment' },
      })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed when a scoped member forges an in-tenant Customer or Commitment id', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'effective-scope');
      const existingId = commitmentId('d');
      expect((await command(
        context,
        'commitment-effective-scope-seed',
        timedCreate(tree, context.owner.id, existingId),
      )).statusCode).toBe(200);

      const member = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: `scoped-member-${randomUUID()}@example.test`,
        passwordHash: 'unused',
        name: 'Scoped Member',
        role: 'member',
      } });
      await context.prisma.tenant.update({
        where: { id: context.tenant.id },
        data: { dataScopePolicy: 'scoped' },
      });
      const memberToken = context.app.jwt.sign({
        userId: member.id, tenantId: context.tenant.id, role: 'member',
      });

      const forgedCreate = timedCreate(tree, member.id, commitmentId('e'));
      const createAttempt = await command(
        context, 'commitment-effective-scope-create-denied', forgedCreate, memberToken,
      );
      const confirmAttempt = await command(context, 'commitment-effective-scope-update-denied', {
        type: 'CONFIRM_COMMITMENT',
        customerId: tree.customerId,
        commitmentId: existingId,
        baseVersion: 0,
        expectedScheduleVersion: 0,
        confirmedAtUtc: '2026-09-09T03:00:00Z',
      }, memberToken);

      expect(createAttempt.statusCode, createAttempt.body).toBe(404);
      expect(confirmAttempt.statusCode, confirmAttempt.body).toBe(404);
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(await context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, actorId: member.id, entityKind: 'commitment' },
      })).toBe(0);

      await context.prisma.opportunity.update({
        where: { id: tree.matterId },
        data: { primaryOwnerUserId: member.id },
      });
      const allowedPayload = timedCreate(tree, member.id, commitmentId('f'));
      allowedPayload.commitment.personId = null;
      const allowedCreate = await command(
        context, 'commitment-effective-scope-create-allowed', allowedPayload, memberToken,
      );
      expect(allowedCreate.statusCode, allowedCreate.body).toBe(200);
      const allowedConfirm = await command(context, 'commitment-effective-scope-update-allowed', {
        type: 'CONFIRM_COMMITMENT', customerId: tree.customerId,
        commitmentId: allowedPayload.commitment.id,
        baseVersion: 0, expectedScheduleVersion: 0,
        confirmedAtUtc: '2026-09-09T03:00:00Z',
      }, memberToken);
      expect(allowedConfirm.statusCode, allowedConfirm.body).toBe(200);
      expect(await context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, actorId: member.id, entityKind: 'commitment' },
      })).toBe(2);
    } finally {
      await context.cleanup();
    }
  });

  it('uses version and schedule CAS, keeps the ID on reschedule, and records stale confirmation metadata', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'reschedule');
      const id = commitmentId('4');
      expect((await command(context, 'commitment-lifecycle-create', timedCreate(tree, context.owner.id, id))).statusCode).toBe(200);

      const confirm = await command(context, 'commitment-confirm-current', {
        type: 'CONFIRM_COMMITMENT', customerId: tree.customerId, commitmentId: id,
        baseVersion: 0, expectedScheduleVersion: 0, confirmedAtUtc: '2026-09-09T03:00:00Z',
      });
      expect(confirm.statusCode, confirm.body).toBe(200);
      expect(confirm.json()).toMatchObject({ confirmationStatus: 'confirmed', version: 1, scheduleVersion: 0 });

      const reschedulePayload = {
        type: 'RESCHEDULE_COMMITMENT', customerId: tree.customerId, commitmentId: id,
        baseVersion: 1, expectedScheduleVersion: 0,
        schedule: {
          scheduledAtUtc: '2026-09-12T02:00:00Z', dueAtUtc: null,
          timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
          confirmationDueAtUtc: '2026-09-11T02:00:00Z', requiresConfirmation: true,
        },
      };
      const rescheduled = await command(context, 'commitment-reschedule-current', reschedulePayload);
      expect(rescheduled.statusCode, rescheduled.body).toBe(200);
      expect(rescheduled.json()).toMatchObject({
        commitmentId: id, confirmationStatus: 'pending', version: 2, scheduleVersion: 1,
      });

      const stale = await command(context, 'commitment-confirm-stale', {
        type: 'CONFIRM_COMMITMENT', customerId: tree.customerId, commitmentId: id,
        baseVersion: 2, expectedScheduleVersion: 0, confirmedAtUtc: '2026-09-11T03:00:00Z',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'commitment_version_conflict' });

      const row = await context.prisma.planAction.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        id, confirmationStatus: 'pending', confirmedAtUtc: null, confirmedByUserId: null,
        version: 2, scheduleVersion: 1,
      });
      const revision = await context.prisma.auditEvent.findFirstOrThrow({
        where: { tenantId: context.tenant.id, entityId: id, action: 'commitment_rescheduled' },
      });
      expect(JSON.parse(revision.metadata)).toMatchObject({
        fromVersion: 1,
        toVersion: 2,
        fromScheduleVersion: 0,
        toScheduleVersion: 1,
        previousConfirmation: {
          status: 'confirmed',
          confirmedAtUtc: '2026-09-09T03:00:00.000Z',
          confirmedByUserId: context.owner.id,
          auditEventId: expect.any(String),
          stale: true,
        },
      });
    } finally {
      await context.cleanup();
    }
  });

  it('declines and cancels only through explicit audited commands', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'terminal');
      const declinedId = commitmentId('9');
      const canceledId = commitmentId('a');
      expect((await command(context, 'commitment-decline-create', timedCreate(tree, context.owner.id, declinedId))).statusCode).toBe(200);
      expect((await command(context, 'commitment-cancel-create', timedCreate(tree, context.owner.id, canceledId))).statusCode).toBe(200);

      const declined = await command(context, 'commitment-decline-current', {
        type: 'DECLINE_COMMITMENT', customerId: tree.customerId, commitmentId: declinedId,
        baseVersion: 0, expectedScheduleVersion: 0, declinedAtUtc: '2026-09-09T04:00:00Z',
      });
      const canceled = await command(context, 'commitment-cancel-current', {
        type: 'CANCEL_COMMITMENT', customerId: tree.customerId, commitmentId: canceledId,
        baseVersion: 0, expectedScheduleVersion: 0, canceledAtUtc: '2026-09-09T05:00:00Z',
        reason: '客户行程变化',
      });
      expect(declined.statusCode, declined.body).toBe(200);
      expect(declined.json()).toMatchObject({ confirmationStatus: 'declined', version: 1 });
      expect(canceled.statusCode, canceled.body).toBe(200);
      expect(canceled.json()).toMatchObject({ executionStatus: 'canceled', version: 1 });

      const events = await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, entityKind: 'commitment' },
        select: { action: true, metadata: true },
      });
      expect(events.map((event) => event.action)).toEqual(expect.arrayContaining([
        'commitment_declined', 'commitment_canceled',
      ]));
      const cancelMetadata = JSON.parse(events.find((event) => event.action === 'commitment_canceled')!.metadata);
      expect(cancelMetadata).toMatchObject({ reasonProvided: true });
      expect(JSON.stringify(cancelMetadata)).not.toContain('客户行程变化');
    } finally {
      await context.cleanup();
    }
  });

  it('never auto-marks overdue, supports explicit missed, and atomically links one next commitment', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'next');
      const previousId = commitmentId('5');
      const previous = timedCreate(tree, context.owner.id, previousId);
      previous.commitment.scheduledAtUtc = '2020-01-02T02:00:00Z';
      previous.commitment.confirmationDueAtUtc = '2020-01-01T02:00:00Z';
      expect((await command(context, 'commitment-overdue-create', previous)).statusCode).toBe(200);

      const before = await context.prisma.planAction.findUniqueOrThrow({ where: { id: previousId } });
      expect(before.executionStatus).toBe('planned');
      const missed = await command(context, 'commitment-explicit-missed', {
        type: 'MARK_COMMITMENT_MISSED', customerId: tree.customerId, commitmentId: previousId,
        baseVersion: 0, expectedScheduleVersion: 0, missedAtUtc: '2020-01-03T02:00:00Z',
      });
      expect(missed.statusCode, missed.body).toBe(200);
      expect(missed.json()).toMatchObject({ executionStatus: 'missed', version: 1 });

      const completedId = commitmentId('6');
      expect((await command(context, 'commitment-complete-create', timedCreate(tree, context.owner.id, completedId))).statusCode).toBe(200);
      const complete = await command(context, 'commitment-complete-current', {
        type: 'COMPLETE_COMMITMENT', customerId: tree.customerId, commitmentId: completedId,
        baseVersion: 0, expectedScheduleVersion: 0, completedAtUtc: '2026-09-10T04:00:00Z',
      });
      expect(complete.statusCode, complete.body).toBe(200);

      const nextId = commitmentId('7');
      const next = timedCreate(tree, context.owner.id, nextId).commitment;
      next.title = '形成下一步行动';
      next.confirmationStatus = 'not_required';
      next.confirmationDueAtUtc = null;
      await context.prisma.opportunity.create({ data: {
        id: 'commitment-next-other-matter', tenantId: context.tenant.id,
        accountId: tree.customerId, name: '同客户的其他事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
      } });
      const wrongMatter = await command(context, 'commitment-create-next-wrong-matter', {
        type: 'CREATE_NEXT_COMMITMENT', previousCommitmentId: completedId,
        expectedPreviousVersion: 1,
        commitment: {
          ...next,
          id: commitmentId('0'),
          matterId: 'commitment-next-other-matter',
          personId: null,
        },
      });
      expect(wrongMatter.statusCode).toBe(409);
      expect(wrongMatter.json()).toMatchObject({ code: 'commitment_state_conflict' });
      const createNextPayload = {
        type: 'CREATE_NEXT_COMMITMENT', previousCommitmentId: completedId,
        expectedPreviousVersion: 1, commitment: next,
      };
      const linked = await command(context, 'commitment-create-next-stable', createNextPayload);
      const replay = await command(context, 'commitment-create-next-stable', createNextPayload);
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({
        commitmentId: nextId, linkedFromCommitmentId: completedId, replayed: false,
      });
      expect(replay.json()).toEqual({ ...linked.json(), replayed: true });
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(3);
      expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id: completedId } })).toMatchObject({
        nextCommitmentId: nextId, version: 2,
      });

      const secondLink = await command(context, 'commitment-create-next-conflict', {
        ...createNextPayload,
        expectedPreviousVersion: 2,
        commitment: { ...next, id: commitmentId('8') },
      });
      expect(secondLink.statusCode).toBe(409);
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(3);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps the legacy PlanAction adapter on the same versioned Commitment row', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'legacy');
      const id = 'legacy-plan-action-core107';
      const mutate = (action: unknown) => context.app.inject({
        method: 'POST', url: '/api/mutate',
        headers: { authorization: `Bearer ${context.token}` }, payload: { action },
      });
      const added = await mutate({
        type: 'ADD_PLAN_ACTION', accId: tree.customerId, oppId: tree.matterId,
        planAction: {
          id, personId: tree.personId, title: '旧界面创建的行动', startDate: '2026-09-15',
          endDate: '2026-09-15', half: 'am', done: false, origin: 'manual',
        },
      });
      expect(added.statusCode, added.body).toBe(200);
      expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id } })).toMatchObject({
        localDate: '2026-09-15', executionStatus: 'planned', version: 0, scheduleVersion: 0,
      });

      const updated = await mutate({
        type: 'UPDATE_PLAN_ACTION', accId: tree.customerId, actionId: id,
        patch: { startDate: '2026-09-16', endDate: '2026-09-16' },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id } })).toMatchObject({
        localDate: '2026-09-16', confirmationStatus: 'not_required',
        version: 1, scheduleVersion: 1,
      });

      const staleGeneric = await command(context, 'commitment-after-legacy-stale', {
        type: 'RESCHEDULE_COMMITMENT', customerId: tree.customerId, commitmentId: id,
        baseVersion: 0, expectedScheduleVersion: 0,
        schedule: {
          scheduledAtUtc: null, dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: true,
          localDate: '2026-09-17', confirmationDueAtUtc: null, requiresConfirmation: false,
        },
      });
      expect(staleGeneric.statusCode).toBe(409);

      const toggled = await mutate({
        type: 'TOGGLE_PLAN_ACTION', accId: tree.customerId, actionId: id,
        done: true, doneAt: '2026-09-16',
      });
      expect(toggled.statusCode, toggled.body).toBe(200);
      expect(await context.prisma.planAction.findUniqueOrThrow({ where: { id } })).toMatchObject({
        done: true, executionStatus: 'completed', version: 2, scheduleVersion: 1,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('keeps invalid legacy rows out of generic state without falling back or hiding the legacy adapter row', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'invalid-state');
      await context.prisma.planAction.create({ data: {
        id: 'legacy-unmigrated-state-row', tenantId: context.tenant.id,
        accountId: tree.customerId, opportunityId: tree.matterId,
        title: '仅用于旧适配器的未迁移行', startDate: '2026-09-18', endDate: '2026-09-18',
      } });
      const response = await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      const account = response.json<any>().accounts.find((item: any) => item.id === tree.customerId);
      expect(account.planActions).toEqual([expect.objectContaining({ id: 'legacy-unmigrated-state-row' })]);
      expect(account.commitments).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  it('supports an operational rollback flag without touching the legacy adapter or data', async () => {
    const context = await createTestContext();
    const previous = process.env.COMMITMENT_COMMANDS_ENABLED;
    try {
      const tree = await seedTree(context, 'disabled');
      process.env.COMMITMENT_COMMANDS_ENABLED = '0';
      const response = await command(
        context, 'commitment-disabled-command', timedCreate(tree, context.owner.id, commitmentId('c')),
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'commitment_commands_disabled' });
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id } })).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.COMMITMENT_COMMANDS_ENABLED;
      else process.env.COMMITMENT_COMMANDS_ENABLED = previous;
      await context.cleanup();
    }
  });
});
