import { useState, type FormEvent, type ReactNode } from 'react';
import type { PersonalWorkbenchDetail, PersonalWorkbenchList, PersonalWorkbenchCommand } from '@jianghu/domain-contracts';
import { api } from '../api';
import { createOpaqueEntityId } from '../lib/opaqueId';
import { personalLifecycleLabel, personalTime, selectPersonalMatters, usePersonalRead, usePersonalSubmission } from '../lib/personalWorkbench';
import { personalMatterPath, personalRouteContext, quickCapturePath } from '../lib/productRoutes';
import { CrmRelationshipGraph } from './CrmRelationshipGraph';

export function PersonalForm({ title, busy, error, onSubmit, onClose, children, submitLabel = '确认保存' }: {
  title: string; busy: boolean; error: string; onSubmit: (event: FormEvent) => void; onClose: () => void; children: ReactNode; submitLabel?: string;
}) {
  return <form className="personal-form" aria-label={title} onSubmit={onSubmit}>
    <header><h3>{title}</h3><button type="button" className="btn ghost sm" disabled={busy} onClick={onClose}>收起</button></header>
    <fieldset disabled={busy}>{children}</fieldset>
    {error ? <p className="personal-error" role="alert">{error}</p> : null}
    <button className="btn primary" type="submit" disabled={busy}>{busy ? '正在保存…' : submitLabel}</button>
  </form>;
}

export function PersonalCustomerForm({ actorUserId, onSaved, onClose }: { actorUserId: string; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(''), [id] = useState(() => createOpaqueEntityId('customer'));
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const command = { type: 'CREATE_CUSTOMER' as const, customer: { id, name, categoryKey: null, primaryOwnerUserId: actorUserId } };
    if (await action.submit(command, key => api.createCustomer(command, key))) onSaved();
  };
  return <PersonalForm title="添加客户" {...action} onSubmit={submit} onClose={onClose} submitLabel="保存客户">
    <label>客户名称<input required autoFocus maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="例如：滨海建设集团" /></label>
  </PersonalForm>;
}

function MatterForm({ customers, initial, onSaved, onClose }: {
  customers: PersonalWorkbenchList['customers']; initial?: PersonalWorkbenchDetail['opportunity']; onSaved: (matterId: string) => void; onClose: () => void;
}) {
  const [id] = useState(() => initial?.matter.id ?? createOpaqueEntityId('matter'));
  const [customerId, setCustomerId] = useState(initial?.matter.customerId ?? (customers.length === 1 ? customers[0].id : ''));
  const [title, setTitle] = useState(initial?.matter.title ?? '');
  const [goal, setGoal] = useState(initial?.customerBusinessGoal ?? '');
  const [stage, setStage] = useState(initial?.salesProgress ?? '');
  const [priority, setPriority] = useState(initial?.matter.priority === 'high');
  const action = usePersonalSubmission();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fields = { title, customerBusinessGoal: goal.trim() || null, salesProgress: stage.trim() || null, priority: priority ? 'high' as const : null };
    const command: PersonalWorkbenchCommand = initial
      ? { type: 'UPDATE_PERSONAL_MATTER', customerId, matterId: id, baseVersion: initial.matter.version, patch: fields }
      : { type: 'CREATE_PERSONAL_MATTER', customerId, matterId: id, ...fields };
    if (await action.submit(command, key => api.personalCommand(command, key))) onSaved(id);
  };
  return <PersonalForm title={initial ? '更新商机' : '记录一条商机或线索'} {...action} onSubmit={submit} onClose={onClose}>
    {!initial ? <label>所属客户<select value={customerId} required onChange={event => setCustomerId(event.target.value)}><option value="">选择客户</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label> : null}
    <label>商机名称<input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：项目平台建设" /></label>
    <label>客户希望改善什么<textarea maxLength={2000} value={goal} onChange={event => setGoal(event.target.value)} placeholder="可以先留空，后续沟通再核实" /></label>
    <label>当前阶段<input maxLength={40} value={stage} onChange={event => setStage(event.target.value)} placeholder="留空表示待判断，例如：业务需求核实" /></label>
    <label className="personal-check"><input type="checkbox" checked={priority} onChange={event => setPriority(event.target.checked)} />标为当前重点</label>
  </PersonalForm>;
}

function ReadFeedback({ loading, error, reload }: { loading: boolean; error: string; reload: () => Promise<void> }) {
  if (error) return <div className="personal-error" role="alert"><p>{error}</p><button className="btn" onClick={() => void reload()}>重新加载</button></div>;
  return loading ? <p className="personal-loading" role="status">正在核验当前商机与权限…</p> : null;
}

export function PersonalMatterList({ readonly, actorUserId, onNavigate, onDataChanged }: {
  readonly: boolean; actorUserId: string; onNavigate: (path: string) => void; onDataChanged: () => Promise<unknown>;
}) {
  const view = usePersonalRead(signal => api.personalWorkbench(signal));
  const [search, setSearch] = useState(''), [state, setState] = useState('active'), [stage, setStage] = useState('all');
  const [editor, setEditor] = useState<'customer' | 'matter' | null>(null);
  const entries = view.data ? selectPersonalMatters(view.data.entries, search, state, stage) : [];
  const stages = [...new Set(view.data?.entries.flatMap(entry => entry.salesProgress ? [entry.salesProgress] : []) ?? [])];
  const changed = () => { setEditor(null); void view.reload(); void onDataChanged().catch(() => undefined); };
  return <section data-personal-workbench={view.error ? 'error' : view.data ? 'ready' : 'loading'}>
    <ReadFeedback {...view} />
    {view.data ? <div hidden={view.loading}>
      <div className="personal-toolbar"><span>{view.data.entries.length} 条商机与线索</span><div>
        <button className="btn ghost" onClick={() => void view.reload()}>刷新</button>
        {!readonly ? <><button className="btn ghost" onClick={() => setEditor('customer')}>添加客户</button><button className="btn primary" onClick={() => setEditor(view.data!.customers.length ? 'matter' : 'customer')}>新建商机</button></> : null}
      </div></div>
      {editor === 'customer' && !readonly ? <PersonalCustomerForm actorUserId={actorUserId} onSaved={changed} onClose={() => setEditor(null)} /> : null}
      {editor === 'matter' && !readonly ? <MatterForm customers={view.data.customers} onSaved={id => { onNavigate(personalMatterPath(id)); void onDataChanged().catch(() => undefined); }} onClose={() => setEditor(null)} /> : null}
      <div className="personal-filters">
        <label>搜索<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="客户、商机或业务目标" /></label>
        <label>推进状态<select value={state} onChange={event => setState(event.target.value)}><option value="active">推进中</option><option value="paused">已暂停</option><option value="completed">已结束</option><option value="all">全部</option></select></label>
        <label>阶段<select value={stage} onChange={event => setStage(event.target.value)}><option value="all">全部阶段</option><option value="unassessed">待判断线索</option>{stages.map(value => <option key={value} value={`stage:${value}`}>{value}</option>)}</select></label>
      </div>
      <p className="personal-muted personal-sort">当前重点优先，再按下一步时间排列。阶段由你决定。</p>
      {entries.length === 0 ? <div className="personal-empty"><h2>{view.data.entries.length ? '没有符合条件的商机' : '先留住一个机会'}</h2><p>{view.data.entries.length ? '可以切换状态或清空筛选。' : '从客户和商机名称开始，业务目标、人物和阶段可以逐步补充。'}</p></div> : <ul className="personal-matter-list" aria-label="商机列表">
        {entries.map(entry => <li key={entry.matter.id}>
          <button className="personal-matter-row" data-personal-matter={entry.matter.id} onClick={() => onNavigate(personalMatterPath(entry.matter.id))}>
            <div className="personal-matter-identity"><small>{entry.customerName}{entry.matter.priority === 'high' ? ' · 当前重点' : ''}</small><h2>{entry.matter.title}</h2><span>{entry.salesProgress ?? '待判断'} · {personalLifecycleLabel(entry.matter.lifecycleStatus, entry.matter.outcomeKey)}</span></div>
            <div><small>关键缺口</small><p>{entry.keyGap ?? '尚未选定，可以从地图中梳理'}</p></div>
            <div><small>下一步</small><p>{entry.nextCommitment?.title ?? '还没有下一步'}</p>{entry.nextCommitment ? <time>{personalTime(entry.nextCommitment.scheduledAtUtc ?? entry.nextCommitment.dueAtUtc)}</time> : null}</div>
            <span aria-hidden="true">↗</span>
          </button>
        </li>)}
      </ul>}
    </div> : null}
  </section>;
}

export function PersonalMatterView({ detail, readonly, onRefresh, onNavigate, children }: {
  detail: PersonalWorkbenchDetail; readonly: boolean; onRefresh: () => Promise<void>; onNavigate: (path: string) => void; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false), [map, setMap] = useState(true);
  const { opportunity, workspace } = detail;
  const matter = opportunity.matter;
  const lifecycle = usePersonalSubmission();
  const changeLifecycle = async (value: 'active' | 'paused' | 'won' | 'lost') => {
    const command = { type: 'UPDATE_PERSONAL_MATTER' as const, customerId: matter.customerId, matterId: matter.id, baseVersion: matter.version, patch: { lifecycle: value } };
    if (await lifecycle.submit(command, key => api.personalCommand(command, key))) void onRefresh();
  };
  return <article className="personal-matter-detail" data-matter-context={matter.id}>
    <div className="personal-toolbar"><button className="btn ghost sm" onClick={() => onNavigate('/matters')}>← 全部商机</button><button className="btn ghost sm" onClick={() => void onRefresh()}>刷新依据</button></div>
    <header className="personal-matter-heading"><div><small>{workspace.customer.name}{matter.priority === 'high' ? ' · 当前重点' : ''}</small><h2>{matter.title}</h2><p>{opportunity.salesProgress ?? '待判断'} · {personalLifecycleLabel(matter.lifecycleStatus, matter.outcomeKey)}</p></div>
      {!readonly ? <button className="btn" onClick={() => setEditing(!editing)}>更新商机</button> : null}</header>
    {editing && !readonly ? <MatterForm key={matter.version} initial={opportunity} customers={[workspace.customer]} onSaved={() => { setEditing(false); void onRefresh(); }} onClose={() => setEditing(false)} /> : null}
    <section className="personal-goal"><span>客户业务目标</span><p>{opportunity.customerBusinessGoal || '业务目标待核实。先了解客户希望改善的结果。'}</p></section>
    <div className="personal-detail-summary"><div><small>当前关键缺口</small><p>{workspace.focus?.evidenceGap ?? '还未选定需要核实的问题'}</p></div><div><small>下一步</small><p>{detail.commitments.find(action => action.executionStatus === 'planned')?.title ?? '尚未安排行动'}</p></div></div>
    {children ?? <section className="personal-map-section">
      <header className="personal-toolbar"><h3>干系人地图</h3><div role="group" aria-label="地图阅读方式"><button className="btn ghost sm" aria-pressed={map} onClick={() => setMap(true)}>地图</button><button className="btn ghost sm" aria-pressed={!map} onClick={() => setMap(false)}>列表</button></div></header>
      {workspace.people.length === 0 ? <p className="personal-empty">目前还没有已知人物；未知决策人可以留待核实。</p> : map ? <CrmRelationshipGraph people={workspace.people} formalRelations={workspace.formalRelations} focusPersonId={workspace.focus?.personId} title={`${matter.title}的干系人地图`} /> : <ul className="personal-people-list">{workspace.people.map(person => <li key={person.id}><strong>{person.name}</strong><span>{person.title ?? '职务待核实'}</span><p>{detail.participants.find(item => item.personId === person.id)?.decisionRole ?? '本次决策角色待核实'}</p></li>)}</ul>}
      <div className="personal-action-strip"><span>从这条商机继续沟通</span><button className="btn primary" disabled={readonly} onClick={() => onNavigate(quickCapturePath(matter.customerId, matter.id))}>记录下一步</button></div>
    </section>}
    {!readonly ? <details className="personal-lifecycle"><summary>推进状态</summary><p>改变状态会保留当前阶段和已有记录。</p><div>{(['active', 'paused', 'won', 'lost'] as const).map(value => <button key={value} className="btn ghost sm" disabled={lifecycle.busy} onClick={() => void changeLifecycle(value)}>{({ active: '继续推进', paused: '暂停推进', won: '记录赢单', lost: '记录丢单' })[value]}</button>)}</div>{lifecycle.error ? <p role="alert">{lifecycle.error}</p> : null}</details> : null}
  </article>;
}

function PersonalMatterPanel({ matterId, readonly, onNavigate }: { matterId: string; readonly: boolean; onNavigate: (path: string) => void }) {
  const view = usePersonalRead(signal => api.personalMatter(matterId, signal));
  return <section data-personal-workbench={view.error ? 'error' : view.data ? 'ready' : 'loading'}>
    <ReadFeedback {...view} />
    {view.data ? <div hidden={view.loading}><PersonalMatterView detail={view.data} readonly={readonly} onRefresh={view.reload} onNavigate={onNavigate} /></div> : null}
  </section>;
}

export function PersonalWorkbench({ pathname, readonly, actorUserId, onNavigate, onDataChanged }: {
  pathname: string; readonly: boolean; actorUserId: string; onNavigate: (path: string) => void; onDataChanged: () => Promise<unknown>;
}) {
  const { matterId } = personalRouteContext(pathname);
  return matterId ? <PersonalMatterPanel key={`${actorUserId}:${matterId}:${readonly}`} matterId={matterId} readonly={readonly} onNavigate={onNavigate} />
    : <PersonalMatterList key={`${actorUserId}:${readonly}`} actorUserId={actorUserId} readonly={readonly} onNavigate={onNavigate} onDataChanged={onDataChanged} />;
}
