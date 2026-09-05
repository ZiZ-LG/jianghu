import { useState, type FormEvent } from 'react';
import {
  IntelligenceItemCommandSchema, SalesHypothesisCommandSchema, StakeholderFocusCommandSchema,
  type PersonalWorkbenchDetail, type PersonalWorkbenchCommand,
} from '@jianghu/domain-contracts';
import { api } from '../api';
import { createOpaqueEntityId } from '../lib/opaqueId';
import { usePersonalSubmission } from '../lib/personalWorkbench';
import { personalActionCommand, toLocalMinute } from '../lib/personalMap';
import { resolveBrowserTimeZone, zonedLocalDateTimeToUtc } from '../lib/quickCapture';
import { PersonalForm } from './PersonalForm';

type FormProps = { detail: PersonalWorkbenchDetail; onSaved: () => void; onClose: () => void };

export function PersonChoice({ detail, value, onChange, optional = false, label = '行动对象' }: {
  detail: PersonalWorkbenchDetail; value: string; onChange: (id: string) => void; optional?: boolean; label?: string;
}) {
  return <label>{label}<select required={!optional} value={value} onChange={event => onChange(event.target.value)}>
    <option value="">{optional ? '商机整体，暂未指定人物' : '选择已知人物'}</option>
    {detail.workspace.people.map(person => <option key={person.id} value={person.id}>{person.name} · {person.title || '职务待核实'}</option>)}
  </select></label>;
}

export function PersonalPersonForm({ detail, onSaved, onClose }: FormProps) {
  const [name, setName] = useState(''), [title, setTitle] = useState(''), [role, setRole] = useState('');
  const [existing, setExisting] = useState(''), [id] = useState(() => createOpaqueEntityId('person'));
  const action = usePersonalSubmission();
  const choices = detail.availablePeople.filter(person => !detail.workspace.people.some(item => item.id === person.id));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parent = { customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id };
    const command: PersonalWorkbenchCommand = existing ? { type: 'JOIN_MATTER_PERSON', ...parent, personId: existing }
      : { type: 'CREATE_MATTER_PERSON', ...parent, personId: id, name, title, decisionRole: role.trim() || null };
    if (await action.submit(command, key => api.personalCommand(command, key))) onSaved();
  };
  return <PersonalForm title="加入已知人物" {...action} onSubmit={submit} onClose={onClose}>
    {choices.length ? <label>复用客户联系人<select value={existing} onChange={event => setExisting(event.target.value)}><option value="">记录一位新人物</option>{choices.map(person => <option key={person.id} value={person.id}>{person.name} · {person.title || '职务待核实'}</option>)}</select></label> : null}
    {!existing ? <><label>姓名<input required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>职务<input maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="可以暂时留空" /></label>
      <label>在这次决策中的作用<input maxLength={120} value={role} onChange={event => setRole(event.target.value)} placeholder="例如：技术评估，推动能力待核实" /></label>
      <p className="personal-muted">尚不知道谁决策时，可以保留缺口；不用添加虚构人物。</p></> : <p className="personal-muted">复用同一联系人；本次商机的决策作用单独记录。</p>}
  </PersonalForm>;
}

export function PersonalRoleForm({ detail, personId, onSaved, onClose }: FormProps & { personId: string }) {
  const participant = detail.participants.find(person => person.personId === personId)!;
  const [role, setRole] = useState(participant.decisionRole ?? '');
  const [basisId, setBasisId] = useState(participant.basisState === 'current' ? participant.basis?.id ?? '' : '');
  const action = usePersonalSubmission();
  const evidence = detail.workspace.intelligence.filter(item => item.targets.some(target => target.kind === 'person' && target.id === personId));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const basis = evidence.find(item => item.id === basisId);
    const command: PersonalWorkbenchCommand = { type: 'SET_PERSON_DECISION_ROLE', customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id,
      personId, baseVersion: participant.version, decisionRole: role.trim() || null, basis: basis && role.trim() ? { id: basis.id, version: basis.version } : null };
    if (await action.submit({ command, basisId }, key => {
      if (basisId && !basis && role.trim()) throw new Error('原依据未在当前列表中，请重新选择依据，或明确保留为待核实');
      return api.personalCommand(command, key);
    })) onSaved();
  };
  return <PersonalForm title="更新本次决策作用" {...action} onSubmit={submit} onClose={onClose}>
    <label>这位人物如何参与本次决策<input maxLength={120} value={role} onChange={event => setRole(event.target.value)} placeholder="留空表示还不清楚" /></label>
    <label>引用当前依据<select value={basisId} onChange={event => setBasisId(event.target.value)}><option value="">尚无依据，保留待核实</option>{basisId && !evidence.some(item => item.id === basisId) ? <option value={basisId} disabled>原依据未在当前列表，请重新选择</option> : null}{evidence.map(item => <option key={item.id} value={item.id}>{item.statement.slice(0, 80)}</option>)}</select></label>
    <p className="personal-muted">引用转述或推断后仍保留来源性质，不会变成已证实事实。</p>
  </PersonalForm>;
}

function SourceFields({ statement, setStatement, nature, setNature, source, setSource, occurred, setOccurred }: {
  statement: string; setStatement: (value: string) => void; nature: 'observed' | 'reported' | 'inferred'; setNature: (value: 'observed' | 'reported' | 'inferred') => void;
  source: string; setSource: (value: string) => void; occurred: string; setOccurred: (value: string) => void;
}) {
  return <><label>记录的内容<textarea required maxLength={2000} value={statement} onChange={event => setStatement(event.target.value)} /></label>
    <label>信息性质<select value={nature} onChange={event => setNature(event.target.value as typeof nature)}><option value="reported">别人转述，待核实</option><option value="observed">本人亲历的记录</option><option value="inferred">个人推断，待验证</option></select></label>
    <label>从哪里得知<input required maxLength={1000} value={source} onChange={event => setSource(event.target.value)} placeholder="例如：王主任在 9 月 5 日电话中提到" /></label>
    <label>发生时间{nature === 'observed' ? '（亲历记录必填）' : '（可留空）'}<input required={nature === 'observed'} type="datetime-local" value={occurred} onChange={event => setOccurred(event.target.value)} /></label></>;
}

export function PersonalEvidenceForm({ detail, personId, relationId, onSaved, onClose }: FormProps & { personId?: string; relationId?: string }) {
  const [id] = useState(() => createOpaqueEntityId('intelligence')), [learnedAt] = useState(() => new Date().toISOString());
  const [statement, setStatement] = useState(''), [nature, setNature] = useState<'observed' | 'reported' | 'inferred'>('reported');
  const [source, setSource] = useState(''), [occurred, setOccurred] = useState('');
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fields = { statement, nature, source, occurred, learnedAt, personId, relationId };
    if (await action.submit(fields, key => api.intelligenceCommand(IntelligenceItemCommandSchema.parse({
      type: 'CREATE_INTELLIGENCE_ITEM', item: { id, customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id,
        assertionType: nature, statement, source: { kind: 'manual', description: source, refId: null, refVersion: null },
        occurredAt: occurred ? zonedLocalDateTimeToUtc(occurred, resolveBrowserTimeZone()) : null, learnedAt, confidence: 0.5,
        targets: [{ kind: relationId ? 'relation' : personId ? 'person' : 'matter', id: relationId ?? personId ?? detail.workspace.matter.id }],
      },
    }), key))) onSaved();
  };
  return <PersonalForm title="补充一条依据" {...action} onSubmit={submit} onClose={onClose}>
    <SourceFields {...{ statement, setStatement, nature, setNature, source, setSource, occurred, setOccurred }} />
  </PersonalForm>;
}

export function PersonalRelationForm({ detail, sourcePersonId, onSaved, onClose }: FormProps & { sourcePersonId?: string }) {
  const [id] = useState(() => createOpaqueEntityId('relation'));
  const [from, setFrom] = useState(sourcePersonId ?? ''), [to, setTo] = useState(''), [label, setLabel] = useState(''), [directed, setDirected] = useState(true);
  const [statement, setStatement] = useState(''), [nature, setNature] = useState<'observed' | 'reported' | 'inferred'>('reported');
  const [source, setSource] = useState(''), [occurred, setOccurred] = useState('');
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await action.submit({ from, to, label, directed, statement, nature, source, occurred }, key => api.personalCommand({ type: 'CREATE_PERSONAL_RELATION',
      customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id, relationId: id, sourcePersonId: from, targetPersonId: to, label, directed,
      basis: { statement, assertionType: nature, sourceDescription: source, occurredAt: occurred ? zonedLocalDateTimeToUtc(occurred, resolveBrowserTimeZone()) : null },
    }, key))) onSaved();
  };
  return <PersonalForm title="记录人物关系与依据" {...action} onSubmit={submit} onClose={onClose}>
    <PersonChoice detail={detail} value={from} onChange={setFrom} label="从谁开始" /><PersonChoice detail={detail} value={to} onChange={setTo} label="关联到谁" />
    <label>关系说明<input required maxLength={200} value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：承诺引荐、技术汇报" /></label>
    <label className="personal-check"><input type="checkbox" checked={directed} onChange={event => setDirected(event.target.checked)} />有明确方向</label>
    <SourceFields {...{ statement, setStatement, nature, setNature, source, setSource, occurred, setOccurred }} />
    <p className="personal-muted">确认后记录关系与来源。转述和推断仍标为待核实。</p>
  </PersonalForm>;
}

export function PersonalFocusForm({ detail, personId, onSaved, onClose }: FormProps & { personId?: string }) {
  const [id] = useState(() => createOpaqueEntityId('focus')), [person, setPerson] = useState(personId ?? detail.workspace.focus?.personId ?? '');
  const [desired, setDesired] = useState(''), [rationale, setRationale] = useState(''), [gap, setGap] = useState('');
  const [until, setUntil] = useState(() => toLocalMinute(new Date(Date.now() + 7 * 86_400_000)));
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await action.submit({ person, desired, rationale, gap, until }, key => api.stakeholderFocusCommand(StakeholderFocusCommandSchema.parse({ type: 'SET_STAKEHOLDER_FOCUS',
      focus: { id, customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id, personId: person,
        desiredChange: desired, rationale, evidenceGap: gap, basisRefs: [], validUntil: zonedLocalDateTimeToUtc(until, resolveBrowserTimeZone()) },
      expectedCurrentFocusId: detail.workspace.focus?.id ?? null, expectedCurrentFocusVersion: detail.workspace.focus?.version ?? null,
    }), key))) onSaved();
  };
  return <PersonalForm title="确定当前关注与缺口" {...action} onSubmit={submit} onClose={onClose}>
    <PersonChoice detail={detail} value={person} onChange={setPerson} label="当前先接近谁" />
    <label>希望推动什么变化<input required maxLength={2000} value={desired} onChange={event => setDesired(event.target.value)} /></label>
    <label>为什么先关注此人<input required maxLength={1000} value={rationale} onChange={event => setRationale(event.target.value)} /></label>
    <label>需要核实的关键缺口<textarea required maxLength={1000} value={gap} onChange={event => setGap(event.target.value)} placeholder="例如：王主任能否安排业务负责人共同讨论目标" /></label>
    <label>这次关注保留到<input required type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></label>
    <p className="personal-muted">这是暂时的推进重点，不代表已确认决策人。确认后替换当前关注，旧记录保留。</p>
  </PersonalForm>;
}

export function PersonalActionForm({ detail, actorUserId, personId, hypothesisId, onSaved, onClose }: FormProps & { actorUserId: string; personId?: string; hypothesisId?: string }) {
  const hypothesis = detail.workspace.hypotheses.find(item => item.hypothesis.id === hypothesisId)?.hypothesis;
  const [id] = useState(() => createOpaqueEntityId('commitment')), [person, setPerson] = useState(personId ?? hypothesis?.personId ?? '');
  const [title, setTitle] = useState(''), [signal, setSignal] = useState(hypothesis?.currentRevision.expectedSignals.join('；') ?? '');
  const [when, setWhen] = useState(''), [zone] = useState(resolveBrowserTimeZone);
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = { id, actorUserId, personId: person, title, expectedSignal: signal, localDateTime: when, timeZone: zone, hypothesisId };
    if (await action.submit(input, key => api.commitment(personalActionCommand(detail, input), key))) onSaved();
  };
  return <PersonalForm title="行动草稿（尚未保存）" {...action} onSubmit={submit} onClose={onClose} submitLabel="确认保存下一步">
    <p className="personal-muted">{detail.workspace.customer.name} / {detail.workspace.matter.title}{hypothesis ? ` · 验证判断：${hypothesis.currentRevision.claim}` : ''}</p>
    <PersonChoice detail={detail} value={person} onChange={setPerson} optional />
    <label>这一步要做什么<input required autoFocus maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：请王主任引荐业务负责人" /></label>
    <label>什么时候<input required type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
    <label>希望得到什么结果或信号<textarea required maxLength={2000} value={signal} onChange={event => setSignal(event.target.value)} placeholder="例如：拿到与业务负责人讨论目标的具体时间" /></label>
    <small className="personal-muted">时间按 {zone} 保存；确认后进入这条商机与今日行动。</small>
  </PersonalForm>;
}

export function PersonalHypothesisForm({ detail, actorUserId, personId, onSaved, onClose }: FormProps & { actorUserId: string; personId?: string }) {
  const [id] = useState(() => createOpaqueEntityId('hypothesis')), [revisionId] = useState(() => createOpaqueEntityId('revision'));
  const [claim, setClaim] = useState(''), [reason, setReason] = useState(''), [signal, setSignal] = useState(''), [refute, setRefute] = useState('');
  const [review, setReview] = useState(() => toLocalMinute(new Date(Date.now() + 7 * 86_400_000)));
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await action.submit({ claim, reason, signal, refute, review }, key => api.salesHypothesisCommand(SalesHypothesisCommandSchema.parse({ type: 'CREATE_SALES_HYPOTHESIS', hypothesis: {
      id, customerId: detail.workspace.customer.id, matterId: detail.workspace.matter.id, personId: personId ?? null, ownerUserId: actorUserId,
      nextReviewAt: zonedLocalDateTimeToUtc(review, resolveBrowserTimeZone()), revision: { id: revisionId, claim, reason, expectedSignals: [signal], falsificationConditions: [refute] },
    } }), key))) onSaved();
  };
  return <PersonalForm title="保留一个待验证判断" {...action} onSubmit={submit} onClose={onClose}>
    <label>我的判断<textarea required maxLength={2000} value={claim} onChange={event => setClaim(event.target.value)} /></label>
    <label>为什么这样判断<input required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <label>什么信号会支持它<input required maxLength={500} value={signal} onChange={event => setSignal(event.target.value)} /></label>
    <label>什么情况说明判断不成立<input required maxLength={500} value={refute} onChange={event => setRefute(event.target.value)} /></label>
    <label>何时回来复核<input required type="datetime-local" value={review} onChange={event => setReview(event.target.value)} /></label>
  </PersonalForm>;
}
