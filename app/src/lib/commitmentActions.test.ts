import { describe, expect, it, vi } from 'vitest';
import {
  InterventionItemSchema,
  type InterventionItem,
} from '@jianghu/domain-contracts';
import {
  availableTodayCommitmentActions,
  buildTodayCommitmentActionDraft,
  saveAndRefreshTodayCommitmentActionDraft,
} from './commitmentActions';

const NOW = '2026-08-23T19:00:00.000Z';
const NEXT_ID = 'commitment_11111111111111111111111111111111';

function item(overrides: Partial<InterventionItem> = {}): InterventionItem {
  const base = {
    id: 'today:confirmation_due:commitment-1:v2:s3',
    section: 'pending_confirmation' as const,
    providerKey: 'core.today',
    title: '确认周一会议',
    context: { customerName: '远山制造', matterName: '方案交流' },
    reasonCode: 'confirmation_due',
    explanation: '确认截止时间已经到达。',
    sourceRefs: [{
      entityKind: 'commitment', entityId: 'commitment-1', version: 2, scheduleVersion: 3,
    }],
    observedAtUtc: NOW,
    ruleVersion: 'core.today.v1',
    time: {
      kind: 'instant' as const,
      atUtc: '2026-08-23T18:00:00.000Z',
      timeZone: 'America/Los_Angeles',
      relation: 'overdue' as const,
      label: '确认已逾期',
    },
    suggestedAction: {
      kind: 'confirm_commitment', label: '确认或调整时间', commandType: 'CONFIRM_COMMITMENT' as const,
    },
    target: {
      entityKind: 'commitment', entityId: 'commitment-1', customerId: 'customer-1',
      matterId: 'matter-1', commitmentId: 'commitment-1', version: 2, scheduleVersion: 3,
    },
  };
  return InterventionItemSchema.parse({ ...base, ...overrides });
}

const dependencies = {
  now: () => new Date(NOW),
  createId: () => NEXT_ID,
  createIdempotencyKey: () => 'command_22222222222222222222222222222222',
};

describe('SAAS-104 Today Commitment action adapter', () => {
  it('allows only core Today actions backed by an exact Commitment revision', () => {
    expect(availableTodayCommitmentActions(item()).map((action) => action.kind)).toEqual([
      'confirm', 'decline', 'reschedule', 'cancel',
    ]);

    const overdue = item({
      id: 'today:commitment_due:commitment-1:v2:s3',
      section: 'follow_up',
      reasonCode: 'commitment_due',
      suggestedAction: {
        kind: 'complete_commitment', label: '完成后记录结果', commandType: 'COMPLETE_COMMITMENT',
      },
    });
    expect(availableTodayCommitmentActions(overdue).map((action) => action.kind)).toEqual([
      'complete', 'reschedule', 'mark_missed', 'cancel',
    ]);

    const upcoming = item({
      id: 'today:commitment_due:commitment-1:v2:s3',
      section: 'follow_up',
      reasonCode: 'commitment_due',
      time: {
        kind: 'instant', atUtc: '2026-08-24T18:00:00.000Z', timeZone: 'America/Los_Angeles',
        relation: 'upcoming', label: '明天 11:00',
      },
      suggestedAction: {
        kind: 'complete_commitment', label: '完成后记录结果', commandType: 'COMPLETE_COMMITMENT',
      },
    });
    expect(availableTodayCommitmentActions(upcoming).map((action) => action.kind)).toEqual([
      'complete', 'reschedule', 'cancel',
    ]);

    expect(availableTodayCommitmentActions(item({ providerKey: 'vendor.signal' }))).toEqual([]);
    expect(availableTodayCommitmentActions(item({
      id: 'today:matter_without_next_commitment:matter-1:v2',
      section: 'follow_up',
      reasonCode: 'matter_without_next_commitment',
      sourceRefs: [{ entityKind: 'matter', entityId: 'matter-1', version: 2, scheduleVersion: null }],
      time: { kind: 'observed', atUtc: NOW, relation: 'missing', label: '当前未记录下一步' },
      suggestedAction: { kind: 'create_commitment', label: '补一个下一步', commandType: 'CREATE_COMMITMENT' },
      target: {
        entityKind: 'matter', entityId: 'matter-1', customerId: 'customer-1', matterId: 'matter-1',
        commitmentId: null, version: 2, scheduleVersion: null,
      },
    }))).toEqual([]);
  });

  it('binds status commands to the exact target revision and trims an optional cancel reason', () => {
    expect(buildTodayCommitmentActionDraft({ item: item(), kind: 'confirm', occurredAtUtc: NOW }, dependencies))
      .toMatchObject({
        idempotencyKey: 'command_22222222222222222222222222222222',
        command: {
          type: 'CONFIRM_COMMITMENT', customerId: 'customer-1', commitmentId: 'commitment-1',
          baseVersion: 2, expectedScheduleVersion: 3, confirmedAtUtc: NOW,
        },
      });
    expect(buildTodayCommitmentActionDraft({ item: item(), kind: 'decline' }, dependencies).command)
      .toMatchObject({ type: 'DECLINE_COMMITMENT', declinedAtUtc: NOW });
    expect(buildTodayCommitmentActionDraft({ item: item(), kind: 'cancel', reason: '  客户行程变化  ' }, dependencies).command)
      .toMatchObject({ type: 'CANCEL_COMMITMENT', canceledAtUtc: NOW, reason: '客户行程变化' });
  });

  it('builds timed and all-day reschedules without fabricating an all-day UTC instant', () => {
    const timed = buildTodayCommitmentActionDraft({
      item: item(),
      kind: 'reschedule',
      schedule: {
        isAllDay: false,
        localDateTime: '2026-08-27T15:00',
        localDate: '',
        timeZone: 'Asia/Shanghai',
        requiresConfirmation: true,
        confirmationDueLocalDateTime: '2026-08-26T15:00',
      },
    }, dependencies);
    expect(timed.command).toMatchObject({
      type: 'RESCHEDULE_COMMITMENT', baseVersion: 2, expectedScheduleVersion: 3,
      schedule: {
        scheduledAtUtc: '2026-08-27T07:00:00.000Z', dueAtUtc: null,
        localDate: null, confirmationDueAtUtc: '2026-08-26T07:00:00.000Z',
        requiresConfirmation: true,
      },
    });

    const allDay = buildTodayCommitmentActionDraft({
      item: item(),
      kind: 'reschedule',
      schedule: {
        isAllDay: true,
        localDateTime: '',
        localDate: '2026-08-28',
        timeZone: 'Asia/Shanghai',
        requiresConfirmation: false,
        confirmationDueLocalDateTime: '',
      },
    }, dependencies);
    expect(allDay.command).toMatchObject({
      type: 'RESCHEDULE_COMMITMENT',
      schedule: {
        scheduledAtUtc: null, dueAtUtc: null, localDate: '2026-08-28',
        confirmationDueAtUtc: null, isAllDay: true,
      },
    });
  });

  it('rejects invalid wall-clock schedules, late confirmation deadlines, and manual missed before overdue', () => {
    const reschedule = (localDateTime: string, confirmationDueLocalDateTime = '') => () => (
      buildTodayCommitmentActionDraft({
        item: item(), kind: 'reschedule',
        schedule: {
          isAllDay: false, localDateTime, localDate: '', timeZone: 'America/Los_Angeles',
          requiresConfirmation: Boolean(confirmationDueLocalDateTime), confirmationDueLocalDateTime,
        },
      }, dependencies)
    );
    expect(reschedule('2026-03-08T02:30')).toThrow('该本地时间在当前时区不存在');
    expect(reschedule('2026-11-01T01:30')).toThrow('该本地时间因夏令时切换存在两种可能');
    expect(reschedule('2026-08-27T15:00', '2026-08-27T16:00')).toThrow('确认截止时间必须早于下一步时间');

    const due = item({
      id: 'today:commitment_due:commitment-1:v2:s3',
      section: 'follow_up',
      reasonCode: 'commitment_due',
      time: {
        kind: 'instant', atUtc: '2026-08-23T20:00:00.000Z', timeZone: 'America/Los_Angeles',
        relation: 'due', label: '今天 13:00',
      },
      suggestedAction: {
        kind: 'complete_commitment', label: '完成后记录结果', commandType: 'COMPLETE_COMMITMENT',
      },
    });
    expect(() => buildTodayCommitmentActionDraft({ item: due, kind: 'mark_missed' }, dependencies))
      .toThrow('只有已经逾期的下一步才能标记错过');
  });

  it('creates a user-authored linked next Commitment without copying provider prose', () => {
    const completed = item({
      id: 'today:commitment_completed:commitment-1:v2:s3',
      section: 'completed',
      reasonCode: 'commitment_completed',
      time: {
        kind: 'local_date', localDate: '2026-08-23', timeZone: 'America/Los_Angeles',
        relation: 'completed', label: '今天已完成',
      },
      suggestedAction: {
        kind: 'create_next_commitment', label: '补充下一步', commandType: 'CREATE_NEXT_COMMITMENT',
      },
    });
    const draft = buildTodayCommitmentActionDraft({
      item: completed,
      kind: 'create_next',
      actorUserId: 'user-cao',
      next: {
        title: '  明确采购评审人  ',
        schedule: {
          isAllDay: false,
          localDateTime: '2026-08-27T15:00',
          localDate: '',
          timeZone: 'Asia/Shanghai',
          requiresConfirmation: false,
          confirmationDueLocalDateTime: '',
        },
      },
    }, dependencies);
    expect(draft.command).toEqual({
      type: 'CREATE_NEXT_COMMITMENT',
      previousCommitmentId: 'commitment-1',
      expectedPreviousVersion: 2,
      commitment: {
        id: NEXT_ID,
        customerId: 'customer-1',
        matterId: 'matter-1',
        personId: null,
        title: '明确采购评审人',
        kind: 'follow_up',
        ownerUserId: 'user-cao',
        confirmationStatus: 'not_required',
        scheduledAtUtc: '2026-08-27T07:00:00.000Z',
        dueAtUtc: null,
        timeZone: 'Asia/Shanghai',
        isAllDay: false,
        localDate: null,
        confirmationDueAtUtc: null,
        source: 'manual_today',
        sourceRef: null,
      },
    });
    expect(JSON.stringify(draft.command)).not.toContain(completed.explanation);
    expect(JSON.stringify(draft.command)).not.toContain(completed.title);
  });

  it('submits once and separates a saved command from both refresh outcomes', async () => {
    const draft = buildTodayCommitmentActionDraft({ item: item(), kind: 'confirm' }, dependencies);
    const submit = vi.fn(async () => ({ commitmentId: 'commitment-1' }));
    const refreshToday = vi.fn(() => { throw new Error('today refresh failed'); });
    const refreshState = vi.fn(async () => undefined);

    await expect(saveAndRefreshTodayCommitmentActionDraft(
      draft, submit, refreshToday, refreshState,
    )).resolves.toMatchObject({
      saved: true, todayRefreshed: false, stateRefreshed: true,
      receipt: { commitmentId: 'commitment-1' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(draft.command, draft.idempotencyKey);
    expect(refreshToday).toHaveBeenCalledTimes(1);
    expect(refreshState).toHaveBeenCalledTimes(1);
  });
});
