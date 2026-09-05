import { useEffect, useRef, useState } from 'react';
import type { IntelligenceItemView, PersonalWorkbenchDetail } from '@jianghu/domain-contracts';
import { assertionLabel, hypothesisStatusLabel } from '../lib/personalMap';
import { personalTime } from '../lib/personalWorkbench';
import { CrmRelationshipGraph } from './CrmRelationshipGraph';
import { PersonalActionForm, PersonalEvidenceForm, PersonalFocusForm, PersonalHypothesisForm, PersonalPersonForm, PersonalRelationForm, PersonalRoleForm } from './PersonalMapForms';

type Selection = { kind: 'person' | 'relation'; id: string } | null;
type Editor = { kind: 'person' | 'role' | 'relation' | 'evidence' | 'focus' | 'action' | 'hypothesis'; revision: string; hypothesisId?: string } | null;

export function PersonalEvidenceList({ items }: { items: readonly IntelligenceItemView[] }) {
  return <div className="personal-evidence-list">{items.length ? items.map(item => <article key={item.id} data-intelligence-id={item.id} data-assertion-type={item.assertionType}>
    <header><strong>{assertionLabel[item.assertionType]}</strong><small>版本 {item.version + 1}</small></header>
    <p>{item.statement}</p><small>来源：{item.source.description}</small>
    <small>发生于 {personalTime(item.occurredAt)} · 得知于 {personalTime(item.learnedAt)}</small>
  </article>) : <p className="personal-muted">当前没有可见依据，保持待核实。</p>}</div>;
}

export function PersonalMapWorkspace({ detail, actorUserId, readonly, onRefresh, onToday }: {
  detail: PersonalWorkbenchDetail; actorUserId: string; readonly: boolean; onRefresh: () => Promise<void>; onToday: () => void;
}) {
  const { workspace } = detail;
  const [mode, setMode] = useState<'map' | 'list'>('map'), [selection, setSelection] = useState<Selection>(null);
  const [showCandidates, setShowCandidates] = useState(false), [showHypotheses, setShowHypotheses] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  // A changed or withdrawn source closes a draft before it can carry old text into a new command.
  const revision = JSON.stringify([workspace.matter.version, workspace.people.map(x => [x.id, x.version]), workspace.formalRelations.map(x => [x.id, x.version]),
    detail.participants, workspace.intelligence.map(x => [x.id, x.version]), workspace.focus, workspace.hypotheses.map(x => [x.hypothesis.id, x.hypothesis.version, x.hypothesis.currentRevisionId])]);
  const currentEditor = !readonly && editor?.revision === revision ? editor : null;
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (currentEditor) editorRef.current?.scrollIntoView({ block: 'nearest' }); }, [currentEditor]);
  const person = selection?.kind === 'person' ? workspace.people.find(item => item.id === selection.id) : null;
  const relation = selection?.kind === 'relation' ? workspace.formalRelations.find(item => item.id === selection.id) : null;
  const participant = person ? detail.participants.find(item => item.personId === person.id) : null;
  const evidence = workspace.intelligence.filter(item => selection ? item.targets.some(target => target.kind === selection.kind && target.id === selection.id) : item.targets.some(target => target.kind === 'matter'));
  const selectedName = person?.name ?? (relation ? `${workspace.people.find(item => item.id === relation.sourcePersonId)?.name} ${relation.directed ? '→' : '—'} ${workspace.people.find(item => item.id === relation.targetPersonId)?.name}` : '从人物与依据开始');
  const select = (value: Selection) => { setSelection(value); setEditor(null); };
  const open = (kind: NonNullable<Editor>['kind'], hypothesisId?: string) => setEditor({ kind, revision, hypothesisId });
  const saved = () => { setEditor(null); void onRefresh(); };
  const formProps = { detail, onSaved: saved, onClose: () => setEditor(null) };
  return <section className="personal-map-section" data-personal-map={workspace.matter.id}>
    <header className="personal-toolbar"><h3>干系人地图</h3><div role="group" aria-label="地图阅读方式">
      <button className="btn ghost sm" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>地图</button><button className="btn ghost sm" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>列表</button>
      {!readonly ? <button className="btn" onClick={() => open('person')}>加入已知人物</button> : null}
    </div></header>
    <p className="personal-muted">实线是已记录的关系，是否属实请查看来源。未知决策人可以先留空。</p>
    {workspace.candidateRelations.length || workspace.hypotheses.length ? <div className="personal-map-layers">
      {workspace.candidateRelations.length ? <label><input type="checkbox" checked={showCandidates} onChange={event => setShowCandidates(event.target.checked)} />显示待审核候选 · 虚线 ?</label> : null}
      {workspace.hypotheses.length ? <label><input type="checkbox" checked={showHypotheses} onChange={event => setShowHypotheses(event.target.checked)} />显示我的判断 · 点线</label> : null}
    </div> : null}
    <div className="personal-map-layout">
      <div className="personal-map-reading">
        {workspace.people.length === 0 ? <div className="personal-empty"><h3>先加入一位已知人物</h3><p>可以只填姓名，再补职务、决策作用与来源。</p></div> : mode === 'map' ? <CrmRelationshipGraph
          people={workspace.people} formalRelations={workspace.formalRelations} candidateRelations={workspace.candidateRelations} hypotheses={workspace.hypotheses}
          showCandidates={showCandidates} showHypotheses={showHypotheses} focusPersonId={workspace.focus?.status === 'active' ? workspace.focus.personId : null}
          selectedPersonId={person?.id} selectedRelationId={relation?.id} onSelectPerson={id => select({ kind: 'person', id })} onSelectRelation={id => select({ kind: 'relation', id })}
          title={`${workspace.matter.title}的干系人地图，可选择人物和关系查看依据`}
        /> : <div className="personal-map-list">
          <h4>已知人物</h4>{workspace.people.map(item => <button key={item.id} className="personal-map-list-row" aria-pressed={person?.id === item.id} onClick={() => select({ kind: 'person', id: item.id })}>
            <strong>{item.name}</strong><span>{item.title || '职务待核实'}</span><small>{detail.participants.find(row => row.personId === item.id)?.decisionRole ?? '本次作用待核实'}</small>
          </button>)}
          <h4>已记录关系</h4>{workspace.formalRelations.length ? workspace.formalRelations.map(item => <button key={item.id} className="personal-map-list-row" aria-pressed={relation?.id === item.id} onClick={() => select({ kind: 'relation', id: item.id })}>
            <strong>{workspace.people.find(person => person.id === item.sourcePersonId)?.name} {item.directed ? '→' : '—'} {workspace.people.find(person => person.id === item.targetPersonId)?.name}</strong><span>{item.label || '关系待说明'}</span>
          </button>) : <p className="personal-muted">尚未记录人物之间的关系。</p>}
        </div>}
      </div>
      <aside className="personal-map-inspector" aria-label="当前选择的详情" data-selected-entity={person?.id ?? relation?.id ?? ''}>
        <header><h3>{selectedName}</h3>{selection ? <button className="btn ghost sm" onClick={() => select(null)}>回到商机</button> : null}</header>
        {person ? <><p>{person.title || '职务待核实'}</p><h4>本次决策作用</h4><p>{participant?.decisionRole ?? '尚不清楚，可以保持未知'}</p>
          <p className="personal-muted">{participant?.basisState === 'current' ? '已引用当前可见依据；信息性质见下方来源。' : participant?.basisState === 'needs_review' ? '原依据已变化或不可见，旧作用与正文已隐藏。请重新核实。' : '尚未引用依据，作用待核实。'}</p></> : relation ? <><p>{relation.label || '关系说明待补充'}</p><p className="personal-muted">已人工记录；转述或推断不会自动成为事实。</p></> : <p>点选人物或关系，查看此商机里的作用与来源；也可以切到列表阅读。</p>}
        {!readonly ? <div className="personal-inspector-actions">
          {person && participant ? <><button className="btn ghost sm" onClick={() => open('role')}>更新决策作用</button><button className="btn ghost sm" onClick={() => open('focus')}>关注此人</button></> : null}
          {person && workspace.people.length > 1 ? <button className="btn ghost sm" onClick={() => open('relation')}>记录人物关系</button> : null}
          <button className="btn ghost sm" onClick={() => open('evidence')}>补充依据</button>
          <button className="btn ghost sm" onClick={() => open('hypothesis')}>保留待验证判断</button>
        </div> : null}
        <h4>当前可见依据</h4><PersonalEvidenceList items={evidence} />
      </aside>
    </div>
    {editor && editor.revision !== revision ? <p role="status" className="personal-muted">当前资料已更新，草稿已收起。请核对新依据后重新打开。</p> : null}
    {currentEditor ? <div ref={editorRef} className="personal-map-editor" key={`${currentEditor.kind}:${person?.id ?? relation?.id ?? 'matter'}:${revision}`}>
      {currentEditor.kind === 'person' ? <PersonalPersonForm {...formProps} /> : null}
      {currentEditor.kind === 'role' && person && participant ? <PersonalRoleForm {...formProps} personId={person.id} /> : null}
      {currentEditor.kind === 'relation' ? <PersonalRelationForm {...formProps} sourcePersonId={person?.id} /> : null}
      {currentEditor.kind === 'evidence' ? <PersonalEvidenceForm {...formProps} personId={person?.id} relationId={relation?.id} /> : null}
      {currentEditor.kind === 'focus' ? <PersonalFocusForm {...formProps} personId={person?.id} /> : null}
      {currentEditor.kind === 'action' ? <PersonalActionForm {...formProps} actorUserId={actorUserId} personId={person?.id} hypothesisId={currentEditor.hypothesisId} /> : null}
      {currentEditor.kind === 'hypothesis' ? <PersonalHypothesisForm {...formProps} actorUserId={actorUserId} personId={person?.id} /> : null}
    </div> : null}
    {workspace.focus ? <section className="personal-current-focus"><h4>{workspace.focus.status === 'expired' ? '需要重新核实的关注' : '当前关注'} · {workspace.people.find(person => person.id === workspace.focus?.personId)?.name}</h4>
      <p>{workspace.focus.desiredChange}</p><p>关键缺口：{workspace.focus.evidenceGap ?? '查看已引用依据'}</p><small>{workspace.focus.rationale} · 保留到 {personalTime(workspace.focus.validUntil)}</small>
    </section> : null}
    {showCandidates ? <section className="personal-candidate-list" aria-label="尚未采纳的候选关系"><h4>待审核候选关系</h4>{workspace.candidateRelations.map(item => <article key={item.candidateId}><strong>候选 ? {item.sourceEndpoint.label} → {item.targetEndpoint.label}</strong><p>{item.label}</p><blockquote>{item.source.quote}</blockquote><small>{item.source.title} · {item.source.locator}</small></article>)}</section> : null}
    {showHypotheses ? <section className="personal-hypothesis-list"><h4>我的判断</h4>{workspace.hypotheses.map(({ hypothesis }) => <article key={hypothesis.id} data-sales-hypothesis={hypothesis.id}>
      <strong>{hypothesisStatusLabel[hypothesis.status]} · {hypothesis.currentRevision.claim}</strong><p>依据：{hypothesis.currentRevision.reason || '待补充'}</p><p>预期：{hypothesis.currentRevision.expectedSignals.join('；') || '待补充'}</p><p>反证条件：{hypothesis.currentRevision.falsificationConditions.join('；') || '待补充'}</p>
      {!readonly && hypothesis.status !== 'retired' ? <button className="btn" onClick={() => { setSelection(hypothesis.personId ? { kind: 'person', id: hypothesis.personId } : null); open('action', hypothesis.id); }}>建立验证行动</button> : null}
    </article>)}</section> : null}
    <section className="personal-action-strip"><div><strong>{person ? `围绕${person.name}安排下一步` : '把需要核实的问题变成下一步'}</strong><p className="personal-muted">先写清对象、目的、时间与预期，再确认保存。</p></div>
      {!readonly ? <button className="btn primary" onClick={() => open('action')}>建立行动草稿</button> : null}
    </section>
    <section className="personal-commitments"><header className="personal-toolbar"><h3>这条商机的行动</h3><button className="btn ghost sm" onClick={onToday}>去今日继续 ↗</button></header>
      {detail.commitments.length ? <ul>{detail.commitments.map(item => <li key={item.id} data-personal-commitment={item.id}><div><strong>{item.title}</strong><small>{item.personId ? workspace.people.find(person => person.id === item.personId)?.name ?? '人物已不可见' : '商机整体'} · {personalTime(item.scheduledAtUtc ?? item.dueAtUtc)} · {({ planned: '待执行', completed: '已完成', canceled: '已取消', missed: '未执行' })[item.executionStatus]}</small></div><p>预期：{item.expectedSignal || '尚未填写'}</p></li>)}</ul> : <p className="personal-muted">目前还没有行动，打开草稿后可以再修改或收起。</p>}
    </section>
  </section>;
}
