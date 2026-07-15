import type { InboxEvidence, InboxPerson, InboxProposal, InboxRel, InboxReminder } from '../api';
import type { Account, PlanAction } from '../types';
import { previewProposalImpact } from './impact';

export interface MomentFlowInbox {
  proposals: InboxProposal[];
  persons: InboxPerson[];
  rels: InboxRel[];
  reminders: InboxReminder[];
  evidences: InboxEvidence[];
  total: number;
}

export interface MomentFlowInput {
  accounts: Account[];
  inbox: MomentFlowInbox;
  todayYmd: string;
}

export interface VisitCaptureContext {
  accId: string;
  oppId: string;
  personId?: string;
}

export type MomentFlowAction = PlanAction & {
  accId: string;
  personName?: string;
  visitContext?: VisitCaptureContext;
};

export type QuickReviewItem =
  | { kind: 'proposal'; id: string; data: InboxProposal; impact: ReturnType<typeof previewProposalImpact> }
  | { kind: 'person'; id: string; data: InboxPerson }
  | { kind: 'rel'; id: string; data: InboxRel }
  | { kind: 'reminder'; id: string; data: InboxReminder }
  | { kind: 'evidence'; id: string; data: InboxEvidence };

export interface MomentFlowViewModel {
  todayActions: MomentFlowAction[];
  reviewQueue: QuickReviewItem[];
}

export function visitActionView(action: MomentFlowAction): { canOpen: boolean; status: string } {
  if (action.visitContext?.personId) return { canOpen: true, status: '❓ 拜访卡已备好 ›' };
  if (action.personId) return { canOpen: false, status: '拜访上下文不可用 · 请回作战室重新选择' };
  return { canOpen: false, status: '（未指定对象 · 请回作战室选择）' };
}

export function buildMomentFlow({ accounts, inbox, todayYmd }: MomentFlowInput): MomentFlowViewModel {
  const todayActions: MomentFlowAction[] = [];
  for (const account of accounts) for (const planAction of account.planActions ?? []) {
    const effectiveDueDate = planAction.endDate || planAction.startDate;
    if (planAction.done || !effectiveDueDate) continue;
    if (effectiveDueDate <= todayYmd) {
      const person = account.persons.find((item) => item.id === planAction.personId);
      const opportunity = account.opportunities.find((item) => item.id === planAction.opportunityId);
      todayActions.push({
        ...planAction,
        accId: account.id,
        personName: person?.name,
        ...(person && opportunity ? {
          visitContext: {
            accId: account.id,
            oppId: opportunity.id,
            personId: person.id,
          },
        } : {}),
      });
    }
  }
  todayActions.sort((left, right) => {
    const leftDue = left.endDate || left.startDate;
    const rightDue = right.endDate || right.startDate;
    const leftOverdue = leftDue < todayYmd ? 0 : 1;
    const rightOverdue = rightDue < todayYmd ? 0 : 1;
    return leftOverdue - rightOverdue
      || leftDue.localeCompare(rightDue)
      || left.startDate.localeCompare(right.startDate)
      || left.accId.localeCompare(right.accId)
      || left.id.localeCompare(right.id);
  });
  const proposals = inbox.proposals.map((data) => {
    const account = accounts.find((item) => item.id === data.accountId);
    const opportunity = account?.opportunities.find((item) => item.id === data.opportunityId);
    const impact = account
      ? previewProposalImpact(account, opportunity, {
        entityKind: data.entityKind,
        entityId: data.entityId,
        field: data.field,
        newValue: data.newValue,
      })
      : null;
    return { data, impact, delta: impact ? Math.abs(impact.after - impact.before) : 0 };
  }).sort((left, right) => right.delta - left.delta);
  return {
    todayActions,
    reviewQueue: [
      ...proposals.map(({ data, impact }) => ({ kind: 'proposal' as const, id: data.id, data, impact })),
      ...inbox.evidences.map((data) => ({ kind: 'evidence' as const, id: data.id, data })),
      ...inbox.persons.map((data) => ({ kind: 'person' as const, id: data.id, data })),
      ...inbox.rels.map((data) => ({ kind: 'rel' as const, id: data.id, data })),
      ...inbox.reminders.map((data) => ({ kind: 'reminder' as const, id: data.id, data })),
    ],
  };
}

export async function resolveQuickReviewDecision(index: number, review: () => Promise<void>): Promise<{ index: number; error: string }> {
  try {
    await review();
    return { index: index + 1, error: '' };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause || '未知错误');
    return { index, error: `审核失败：${message}` };
  }
}
