import {
  CommitmentCommandSchema,
  QUICK_CAPTURE_TITLE_MAX_LENGTH,
  type CommitmentCommand,
  type InterventionItem,
} from '@jianghu/domain-contracts';
import { createOpaqueEntityId } from './opaqueId';
import { zonedLocalDateTimeToUtc } from './quickCapture';

export type TodayCommitmentActionKind =
  | 'confirm'
  | 'decline'
  | 'reschedule'
  | 'complete'
  | 'cancel'
  | 'mark_missed'
  | 'create_next';

export interface TodayCommitmentAction {
  kind: TodayCommitmentActionKind;
  label: string;
  confirmLabel: string;
  commandType: CommitmentCommand['type'];
  danger: boolean;
}

const ACTIONS = {
  confirm: {
    kind: 'confirm', label: '确认', confirmLabel: '确认下一步',
    commandType: 'CONFIRM_COMMITMENT', danger: false,
  },
  decline: {
    kind: 'decline', label: '拒绝', confirmLabel: '确认拒绝',
    commandType: 'DECLINE_COMMITMENT', danger: true,
  },
  reschedule: {
    kind: 'reschedule', label: '调整时间', confirmLabel: '确认调整时间',
    commandType: 'RESCHEDULE_COMMITMENT', danger: false,
  },
  complete: {
    kind: 'complete', label: '标记完成', confirmLabel: '确认完成',
    commandType: 'COMPLETE_COMMITMENT', danger: false,
  },
  cancel: {
    kind: 'cancel', label: '取消', confirmLabel: '确认取消',
    commandType: 'CANCEL_COMMITMENT', danger: true,
  },
  mark_missed: {
    kind: 'mark_missed', label: '标记错过', confirmLabel: '确认标记错过',
    commandType: 'MARK_COMMITMENT_MISSED', danger: true,
  },
  create_next: {
    kind: 'create_next', label: '补充下一步', confirmLabel: '确认创建下一步',
    commandType: 'CREATE_NEXT_COMMITMENT', danger: false,
  },
} as const satisfies Record<TodayCommitmentActionKind, TodayCommitmentAction>;

const CONFIRMATION_ACTIONS = Object.freeze([
  ACTIONS.confirm, ACTIONS.decline, ACTIONS.reschedule, ACTIONS.cancel,
]);
const FOLLOW_UP_ACTIONS = Object.freeze([
  ACTIONS.complete, ACTIONS.reschedule, ACTIONS.cancel,
]);
const OVERDUE_ACTIONS = Object.freeze([
  ACTIONS.complete, ACTIONS.reschedule, ACTIONS.mark_missed, ACTIONS.cancel,
]);
const CREATE_NEXT_ACTIONS = Object.freeze([ACTIONS.create_next]);

function hasExactCommitmentTarget(item: InterventionItem): boolean {
  const target = item.target;
  return target.entityKind === 'commitment'
    && target.commitmentId === target.entityId
    && target.commitmentId !== null
    && target.scheduleVersion !== null
    && item.sourceRefs.some((source) => (
      source.entityKind === 'commitment'
      && source.entityId === target.entityId
      && source.version === target.version
      && source.scheduleVersion === target.scheduleVersion
    ));
}

export function availableTodayCommitmentActions(
  item: InterventionItem,
): readonly TodayCommitmentAction[] {
  if (item.providerKey !== 'core.today' || !hasExactCommitmentTarget(item)) return [];
  if (item.reasonCode === 'confirmation_due'
    && item.suggestedAction.commandType === 'CONFIRM_COMMITMENT') {
    return CONFIRMATION_ACTIONS;
  }
  if (item.reasonCode === 'commitment_due'
    && item.suggestedAction.commandType === 'COMPLETE_COMMITMENT') {
    return item.time.relation === 'overdue' ? OVERDUE_ACTIONS : FOLLOW_UP_ACTIONS;
  }
  if (item.reasonCode === 'commitment_completed'
    && item.suggestedAction.commandType === 'CREATE_NEXT_COMMITMENT') {
    return CREATE_NEXT_ACTIONS;
  }
  return [];
}

export interface TodayCommitmentScheduleInput {
  isAllDay: boolean;
  localDateTime: string;
  localDate: string;
  timeZone: string;
  requiresConfirmation: boolean;
  confirmationDueLocalDateTime: string;
}

export interface BuildTodayCommitmentActionInput {
  item: InterventionItem;
  kind: TodayCommitmentActionKind;
  occurredAtUtc?: string;
  schedule?: TodayCommitmentScheduleInput;
  reason?: string;
  actorUserId?: string;
  next?: {
    title: string;
    schedule: TodayCommitmentScheduleInput;
  };
}

export interface TodayCommitmentActionDraft {
  action: TodayCommitmentAction;
  command: CommitmentCommand;
  idempotencyKey: string;
  summary: {
    actionLabel: string;
    targetLabel: string;
    scheduleLabel: string | null;
  };
}

export interface TodayCommitmentActionBuildDependencies {
  now: () => Date;
  createId: (prefix: 'commitment') => string;
  createIdempotencyKey: () => string;
}

const DEFAULT_BUILD_DEPENDENCIES: TodayCommitmentActionBuildDependencies = {
  now: () => new Date(),
  createId: createOpaqueEntityId,
  createIdempotencyKey: () => createOpaqueEntityId('command'),
};

type BuiltSchedule = {
  scheduledAtUtc: string | null;
  dueAtUtc: null;
  timeZone: string;
  isAllDay: boolean;
  localDate: string | null;
  confirmationDueAtUtc: string | null;
  requiresConfirmation: boolean;
};

function buildSchedule(input: TodayCommitmentScheduleInput): BuiltSchedule {
  const localDateTime = input.localDateTime.trim();
  const localDate = input.localDate.trim();
  const confirmationDueLocalDateTime = input.confirmationDueLocalDateTime.trim();
  if (!input.requiresConfirmation && confirmationDueLocalDateTime) {
    throw new Error('未要求确认时不能填写确认截止时间');
  }
  if (input.requiresConfirmation && !confirmationDueLocalDateTime) {
    throw new Error('请填写确认截止时间');
  }

  const scheduledAtUtc = input.isAllDay
    ? null
    : zonedLocalDateTimeToUtc(localDateTime, input.timeZone);
  const confirmationDueAtUtc = input.requiresConfirmation
    ? zonedLocalDateTimeToUtc(confirmationDueLocalDateTime, input.timeZone)
    : null;
  if (scheduledAtUtc && confirmationDueAtUtc && confirmationDueAtUtc >= scheduledAtUtc) {
    throw new Error('确认截止时间必须早于下一步时间');
  }

  return {
    scheduledAtUtc,
    dueAtUtc: null,
    timeZone: input.timeZone,
    isAllDay: input.isAllDay,
    localDate: input.isAllDay ? localDate : null,
    confirmationDueAtUtc,
    requiresConfirmation: input.requiresConfirmation,
  };
}

function occurrence(input: BuildTodayCommitmentActionInput, dependencies: TodayCommitmentActionBuildDependencies): string {
  return input.occurredAtUtc ?? dependencies.now().toISOString();
}

function exactTarget(item: InterventionItem) {
  const { target } = item;
  if (!hasExactCommitmentTarget(item) || target.commitmentId === null || target.scheduleVersion === null) {
    throw new Error('当前提醒缺少可执行的正式修订，请刷新后重试');
  }
  return {
    customerId: target.customerId,
    commitmentId: target.commitmentId,
    baseVersion: target.version,
    expectedScheduleVersion: target.scheduleVersion,
  };
}

function buildCommand(
  input: BuildTodayCommitmentActionInput,
  dependencies: TodayCommitmentActionBuildDependencies,
): CommitmentCommand {
  const target = exactTarget(input.item);
  const occurredAtUtc = occurrence(input, dependencies);
  switch (input.kind) {
    case 'confirm':
      return { type: 'CONFIRM_COMMITMENT', ...target, confirmedAtUtc: occurredAtUtc };
    case 'decline':
      return { type: 'DECLINE_COMMITMENT', ...target, declinedAtUtc: occurredAtUtc };
    case 'complete':
      return { type: 'COMPLETE_COMMITMENT', ...target, completedAtUtc: occurredAtUtc };
    case 'cancel': {
      const reason = input.reason?.trim();
      return {
        type: 'CANCEL_COMMITMENT', ...target, canceledAtUtc: occurredAtUtc,
        ...(reason ? { reason } : {}),
      };
    }
    case 'mark_missed':
      return { type: 'MARK_COMMITMENT_MISSED', ...target, missedAtUtc: occurredAtUtc };
    case 'reschedule':
      if (!input.schedule) throw new Error('请填写新的时间');
      return { type: 'RESCHEDULE_COMMITMENT', ...target, schedule: buildSchedule(input.schedule) };
    case 'create_next': {
      const actorUserId = input.actorUserId?.trim() ?? '';
      if (!actorUserId) throw new Error('当前用户无效，请重新登录');
      if (!input.next) throw new Error('请填写新的下一步');
      const title = input.next.title.trim();
      if (!title) throw new Error('请填写新的下一步');
      if (title.length > QUICK_CAPTURE_TITLE_MAX_LENGTH) {
        throw new Error(`下一步不能超过 ${QUICK_CAPTURE_TITLE_MAX_LENGTH} 字`);
      }
      const schedule = buildSchedule(input.next.schedule);
      return {
        type: 'CREATE_NEXT_COMMITMENT',
        previousCommitmentId: target.commitmentId,
        expectedPreviousVersion: target.baseVersion,
        commitment: {
          id: dependencies.createId('commitment'),
          customerId: target.customerId,
          matterId: input.item.target.matterId,
          personId: null,
          title,
          kind: 'follow_up',
          ownerUserId: actorUserId,
          confirmationStatus: schedule.requiresConfirmation ? 'pending' : 'not_required',
          scheduledAtUtc: schedule.scheduledAtUtc,
          dueAtUtc: schedule.dueAtUtc,
          timeZone: schedule.timeZone,
          isAllDay: schedule.isAllDay,
          localDate: schedule.localDate,
          confirmationDueAtUtc: schedule.confirmationDueAtUtc,
          source: 'manual_today',
          sourceRef: null,
        },
      };
    }
  }
}

function scheduleLabel(input: BuildTodayCommitmentActionInput): string | null {
  const schedule = input.kind === 'create_next' ? input.next?.schedule : input.schedule;
  if (!schedule) return null;
  return schedule.isAllDay
    ? `${schedule.localDate.trim()} · 全天 · ${schedule.timeZone}`
    : `${schedule.localDateTime.trim()} · ${schedule.timeZone}`;
}

export function buildTodayCommitmentActionDraft(
  input: BuildTodayCommitmentActionInput,
  dependencies: TodayCommitmentActionBuildDependencies = DEFAULT_BUILD_DEPENDENCIES,
): TodayCommitmentActionDraft {
  if (input.kind === 'mark_missed'
    && (input.item.reasonCode !== 'commitment_due' || input.item.time.relation !== 'overdue')) {
    throw new Error('只有已经逾期的下一步才能标记错过');
  }
  const action = availableTodayCommitmentActions(input.item).find(({ kind }) => kind === input.kind);
  if (!action) throw new Error('当前提醒不允许该操作，请刷新后重试');
  const command = CommitmentCommandSchema.parse(buildCommand(input, dependencies));
  return {
    action,
    command,
    idempotencyKey: dependencies.createIdempotencyKey(),
    summary: {
      actionLabel: action.label,
      targetLabel: `${input.item.context.customerName} · ${input.item.title}`,
      scheduleLabel: scheduleLabel(input),
    },
  };
}

export function submitTodayCommitmentActionDraft<T>(
  draft: TodayCommitmentActionDraft,
  submit: (command: CommitmentCommand, idempotencyKey: string) => Promise<T>,
): Promise<T> {
  return submit(draft.command, draft.idempotencyKey);
}

export async function saveAndRefreshTodayCommitmentActionDraft<T>(
  draft: TodayCommitmentActionDraft,
  submit: (command: CommitmentCommand, idempotencyKey: string) => Promise<T>,
  refreshToday: () => Promise<unknown>,
  refreshState: () => Promise<unknown>,
) {
  const receipt = await submitTodayCommitmentActionDraft(draft, submit);
  const [todayResult, stateResult] = await Promise.allSettled([
    Promise.resolve().then(refreshToday),
    Promise.resolve().then(refreshState),
  ]);
  return {
    saved: true as const,
    receipt,
    todayRefreshed: todayResult.status === 'fulfilled',
    stateRefreshed: stateResult.status === 'fulfilled',
    ...(todayResult.status === 'rejected' ? { todayRefreshError: todayResult.reason } : {}),
    ...(stateResult.status === 'rejected' ? { stateRefreshError: stateResult.reason } : {}),
  };
}
