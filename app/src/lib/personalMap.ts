import { CreateCommitmentCommandSchema, type PersonalWorkbenchDetail } from '@jianghu/domain-contracts';
import { zonedLocalDateTimeToUtc } from './quickCapture';

export function personalActionCommand(detail: PersonalWorkbenchDetail, input: {
  id: string; actorUserId: string; personId: string; title: string; expectedSignal: string;
  localDateTime: string; timeZone: string; hypothesisId?: string;
}) {
  const matter = detail.opportunity.matter;
  if (input.personId && !detail.workspace.people.some(person => person.id === input.personId)) throw new Error('人物已不在当前商机，请刷新');
  const hypothesis = input.hypothesisId ? detail.workspace.hypotheses.find(item => item.hypothesis.id === input.hypothesisId)?.hypothesis : null;
  if (input.hypothesisId && (!hypothesis || (hypothesis.personId !== null && hypothesis.personId !== input.personId))) throw new Error('判断与行动对象不一致，请重新选择');
  if (!input.expectedSignal.trim()) throw new Error('请填写这一步希望得到的结果或信号');
  return CreateCommitmentCommandSchema.parse({ type: 'CREATE_COMMITMENT', commitment: {
    id: input.id, customerId: matter.customerId, matterId: matter.id, personId: input.personId || null,
    title: input.title, expectedSignal: input.expectedSignal, kind: hypothesis ? 'verification' : 'follow_up',
    ownerUserId: input.actorUserId, confirmationStatus: 'not_required',
    scheduledAtUtc: zonedLocalDateTimeToUtc(input.localDateTime, input.timeZone), dueAtUtc: null,
    timeZone: input.timeZone, isAllDay: false, localDate: null, confirmationDueAtUtc: null,
    source: 'manual', sourceRef: null,
    hypothesisRef: hypothesis ? { hypothesisId: hypothesis.id, hypothesisRevisionId: hypothesis.currentRevisionId } : null,
  } });
}

export function toLocalMinute(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const assertionLabel = { observed: '亲历记录', reported: '转述 · 待核实', inferred: '个人推断 · 待验证' } as const;
export const hypothesisStatusLabel = { untested: '待验证', testing: '验证中', supported: '用户确认有支持', contradicted: '存在反证', retired: '已停止采用' } as const;
