import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  InterventionItemSchema,
  type InterventionItem,
} from '@jianghu/domain-contracts';
import {
  availableTodayCommitmentActions,
  type TodayCommitmentActionKind,
} from '../lib/commitmentActions';
import { CommitmentActionEditor } from './CommitmentActionEditor';

const NOW = '2026-08-23T19:00:00.000Z';

function fixture(kind: TodayCommitmentActionKind): InterventionItem {
  const reasonCode = kind === 'create_next'
    ? 'commitment_completed'
    : kind === 'mark_missed' || kind === 'complete' ? 'commitment_due' : 'confirmation_due';
  const section = reasonCode === 'commitment_completed'
    ? 'completed'
    : reasonCode === 'commitment_due' ? 'follow_up' : 'pending_confirmation';
  const commandType = reasonCode === 'commitment_completed'
    ? 'CREATE_NEXT_COMMITMENT'
    : reasonCode === 'commitment_due' ? 'COMPLETE_COMMITMENT' : 'CONFIRM_COMMITMENT';
  return InterventionItemSchema.parse({
    id: `today:${reasonCode}:commitment-1:v2:s3`,
    section,
    providerKey: 'core.today',
    title: '确认周一会议',
    context: { customerName: '远山制造', matterName: '方案交流' },
    reasonCode,
    explanation: '需要用户处理。',
    sourceRefs: [{ entityKind: 'commitment', entityId: 'commitment-1', version: 2, scheduleVersion: 3 }],
    observedAtUtc: NOW,
    ruleVersion: 'core.today.v1',
    time: reasonCode === 'commitment_completed'
      ? {
          kind: 'local_date', localDate: '2026-08-23', timeZone: 'America/Los_Angeles',
          relation: 'completed', label: '今天已完成',
        }
      : {
          kind: 'instant', atUtc: '2026-08-23T18:00:00.000Z', timeZone: 'America/Los_Angeles',
          relation: 'overdue', label: '已逾期',
        },
    suggestedAction: { kind: 'test_action', label: '处理', commandType },
    target: {
      entityKind: 'commitment', entityId: 'commitment-1', customerId: 'customer-1',
      matterId: 'matter-1', commitmentId: 'commitment-1', version: 2, scheduleVersion: 3,
    },
  });
}

function renderEditor(kind: TodayCommitmentActionKind): string {
  const item = fixture(kind);
  const action = availableTodayCommitmentActions(item).find((candidate) => candidate.kind === kind);
  expect(action, `${kind} must be available in its fixture`).toBeDefined();
  return renderToStaticMarkup(createElement(CommitmentActionEditor, {
    item,
    action: action!,
    actorUserId: 'user-cao',
    saving: false,
    error: null,
    onCancel: () => undefined,
    onInputChanged: () => undefined,
    onSubmit: () => undefined,
  }));
}

describe('SAAS-104 CommitmentActionEditor', () => {
  it('uses an explicit accessible second-confirmation surface for status writes', () => {
    const cancel = renderEditor('cancel');
    expect(cancel).toContain('role="dialog"');
    expect(cancel).toContain('aria-modal="true"');
    expect(cancel).toContain('确认取消');
    expect(cancel).toContain('v2 / schedule 3');
    expect(cancel).toContain('<label');
    expect(cancel).toContain('取消原因（可选）');
    expect(cancel).toContain('type="submit"');
    expect(cancel).toContain('type="button"');

    const missed = renderEditor('mark_missed');
    expect(missed).toContain('这会把正式状态标记为“已错过”');
    expect(missed).toContain('确认标记错过');
  });

  it('renders labeled schedule fields for reschedule and linked-next creation', () => {
    const reschedule = renderEditor('reschedule');
    expect(reschedule).toContain('type="datetime-local"');
    expect(reschedule).toContain('type="checkbox"');
    expect(reschedule).toContain('时区');
    expect(reschedule).toContain('需要对方确认');

    const createNext = renderEditor('create_next');
    expect(createNext).toContain('新的下一步');
    expect(createNext).toContain('name="nextTitle"');
    expect(createNext).not.toContain('value="确认周一会议"');
  });
});
