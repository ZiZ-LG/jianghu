import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { Person, OppRole, BurningIssue, UCV, Role, Sentiment, ProcurementType, ProcurementStatus } from '../types';
import {
  ROLE_LABEL, SENTIMENT_LABEL, FAMILY_7Q, CONFIDENCES, BI_CATEGORIES,
  PROCUREMENT_TYPE_LABEL, PROCUREMENT_STATUS_LABEL,
} from '../types';
import { type Action, uid } from '../store';
import type { MutationCoordinator } from '../lib/sync/mutationCoordinator';
import { SyncStatus } from './SyncStatus';

const ROLES: Role[] = ['A', 'D', 'U', 'R', 'C'];
const SENTIMENTS: Sentiment[] = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];

export function DetailDrawer({
  accId, oppId, person, oppRole, bis, ucvs, dispatch, draftDispatch, flushDraft, coordinator, onViewCloud, onClose, embedded,
}: {
  accId: string; oppId: string;
  person: Person;
  oppRole?: OppRole;
  bis: BurningIssue[];
  ucvs: UCV[];
  dispatch: Dispatch<Action>;
  draftDispatch?: Dispatch<Action>;
  flushDraft?: (action: Action) => void | Promise<void>;
  coordinator?: MutationCoordinator;
  onViewCloud?: () => void | Promise<void>;
  onClose: () => void;
  embedded?: boolean; // 焦点面板「档案」tab 复用：去掉 .drawer 外壳与标题栏，只渲染 body
}) {
  const [logText, setLogText] = useState('');
  const [logSensitive, setLogSensitive] = useState(false);
  const [personDraft, setPersonDraft] = useState(person);
  const [biDrafts, setBiDrafts] = useState<Record<string, string>>(() => Object.fromEntries(bis.map((bi) => [bi.id, bi.description])));
  const [ucvDrafts, setUcvDrafts] = useState<Record<string, { description: string; competitorCannot: string }>>(
    () => Object.fromEntries(ucvs.map((u) => [u.id, { description: u.description, competitorCannot: u.competitorCannot }])),
  );
  const personDirty = useRef(false);
  const personIdRef = useRef(person.id);
  const biDirty = useRef(new Set<string>());
  const ucvDirty = useRef(new Set<string>());
  const pendingDraftActions = useRef(new Map<string, Action>());
  useEffect(() => setPersonDraft((current) => {
    const switchedPerson = personIdRef.current !== person.id;
    const draftMatchesCloud = current.name === person.name
      && current.title === person.title
      && JSON.stringify(current.form) === JSON.stringify(person.form);
    if (switchedPerson || !personDirty.current || draftMatchesCloud) {
      personIdRef.current = person.id;
      personDirty.current = false;
      return person;
    }
    return current;
  }), [person]);
  useEffect(() => setBiDrafts((current) => Object.fromEntries(bis.map((bi) => {
    if (!biDirty.current.has(bi.id) || current[bi.id] === bi.description) {
      biDirty.current.delete(bi.id);
      return [bi.id, bi.description];
    }
    return [bi.id, current[bi.id]];
  }))), [bis]);
  useEffect(() => setUcvDrafts((current) => Object.fromEntries(ucvs.map((u) => {
    const cloud = { description: u.description, competitorCannot: u.competitorCannot };
    if (!ucvDirty.current.has(u.id) || JSON.stringify(current[u.id]) === JSON.stringify(cloud)) {
      ucvDirty.current.delete(u.id);
      return [u.id, cloud];
    }
    return [u.id, current[u.id]];
  }))), [ucvs]);
  const personFlushAction: Action = { type: 'UPDATE_PERSON', accId, personId: person.id, patch: {} };
  useEffect(() => () => {
    for (const action of pendingDraftActions.current.values()) void flushDraft?.(action);
    pendingDraftActions.current.clear();
  }, [accId, oppId, person.id, flushDraft]);
  const patchPerson = (patch: Partial<Person>) => {
    personDirty.current = true;
    pendingDraftActions.current.set(`person:${person.id}`, personFlushAction);
    setPersonDraft((current) => ({ ...current, ...patch, form: patch.form ? { ...current.form, ...patch.form } : current.form }));
    (draftDispatch ?? dispatch)({ type: 'UPDATE_PERSON', accId, personId: person.id, patch });
  };
  const patchForm = (fp: Partial<Person['form']>) => patchPerson({ form: { ...personDraft.form, ...fp } });
  const setRole = (patch: Partial<OppRole>) => dispatch({ type: 'SET_ROLE', accId, oppId, personId: person.id, patch });
  const viewCloud = async () => {
    await onViewCloud?.();
    personDirty.current = false;
    biDirty.current.clear();
    ucvDirty.current.clear();
  };

  const addBI = () => dispatch({ type: 'ADD_BI', accId, oppId, bi: { id: uid('bi'), personId: person.id, description: '', category: '其他', isPrivate: true, confidence: '推理' } });
  const addUCV = () => bis[0] && dispatch({ type: 'ADD_UCV', accId, oppId, ucv: { id: uid('ucv'), targetBiId: bis[0].id, description: '', competitorCannot: '', status: '建议' } });
  const addLog = () => {
    if (!logText.trim()) return;
    const date = new Date().toISOString().slice(0, 10);
    dispatch({ type: 'ADD_LOG', accId, personId: person.id, log: { date, content: logText.trim(), sensitive: logSensitive, visibility: logSensitive ? 'team' : 'org' } });
    setLogText(''); setLogSensitive(false);
  };

  const body = (
      <div className="drawer-body">
        {coordinator && <SyncStatus coordinator={coordinator} entityKey={`person:${person.id}`} onViewCloud={viewCloud} />}
        <div className="person-hd">
          <div className="avatar">{personDraft.name[0] || '?'}</div>
          <div style={{ flex: 1 }}>
            <input className="inline-name" value={personDraft.name} onChange={(e) => patchPerson({ name: e.target.value })}
              onBlur={() => { void flushDraft?.(personFlushAction); }} placeholder="姓名" />
            <input className="inline-title" value={personDraft.title} onChange={(e) => patchPerson({ title: e.target.value })}
              onBlur={() => { void flushDraft?.(personFlushAction); }} placeholder="职务" />
          </div>
        </div>

        {person.isCompetitor ? (
          <div className="empty-hint">竞争对手不分配角色；用客户方人员的「✕ 倒向对手」标记其影响。</div>
        ) : (
          <>
            <div className="section-t">本项目角色与态度</div>
            <div className="edit-row">
              <label><span>角色</span>
                <select value={oppRole?.role ?? ''} onChange={(e) => {
                  if (!e.target.value) dispatch({ type: 'REMOVE_ROLE', accId, oppId, personId: person.id });
                  else setRole({ role: e.target.value as Role });
                }}>
                  <option value="">未分配</option>
                  {ROLES.map((r) => <option key={r} value={r}>{r} · {ROLE_LABEL[r]}</option>)}
                </select>
              </label>
              <label><span>支持度</span>
                <select value={oppRole?.sentiment ?? 'unknown'} disabled={!oppRole} onChange={(e) => setRole({ sentiment: e.target.value as Sentiment })}>
                  {SENTIMENTS.map((s) => <option key={s} value={s}>{SENTIMENT_LABEL[s]}</option>)}
                </select>
              </label>
            </div>
            {oppRole && (
              <>
                <div className="edit-row">
                  <label><span>信息可信度</span>
                    <select value={oppRole.confidence} onChange={(e) => setRole({ confidence: e.target.value as OppRole['confidence'] })}>
                      {CONFIDENCES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label><span style={{ display: 'block' }}>关键影响人(P4)</span>
                    <label className="chk-line" style={{ marginTop: 6 }}>
                      <input type="checkbox" checked={!!oppRole.isKeyInfluencer} onChange={(e) => setRole({ isKeyInfluencer: e.target.checked })} />锁定
                    </label>
                  </label>
                </div>
                <div className="edit-row">
                  <label><span>招采关键人类型</span>
                    <select value={oppRole.procurementType ?? ''} onChange={(e) => setRole({ procurementType: (e.target.value || undefined) as ProcurementType })}>
                      <option value="">非招采关键人</option>
                      {Object.entries(PROCUREMENT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <label><span>招采公关状态(P2)</span>
                    <select value={oppRole.procurementStatus ?? 'none'} disabled={!oppRole.procurementType} onChange={(e) => setRole({ procurementStatus: e.target.value as ProcurementStatus })}>
                      {Object.entries(PROCUREMENT_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                </div>
              </>
            )}

            <div className="section-t">FORM 情报</div>
            <label className="fld sm"><span>F 家庭</span><textarea rows={1} value={personDraft.form.family} onChange={(e) => patchForm({ family: e.target.value })} onBlur={() => { void flushDraft?.(personFlushAction); }} /></label>
            <label className="fld sm"><span>O 事业</span><textarea rows={1} value={personDraft.form.occupation} onChange={(e) => patchForm({ occupation: e.target.value })} onBlur={() => { void flushDraft?.(personFlushAction); }} /></label>
            <label className="fld sm"><span>R 休闲</span><textarea rows={1} value={personDraft.form.recreation} onChange={(e) => patchForm({ recreation: e.target.value })} onBlur={() => { void flushDraft?.(personFlushAction); }} /></label>
            <label className="fld sm"><span>M 金钱与梦想</span><textarea rows={1} value={personDraft.form.moneyMotivation} onChange={(e) => patchForm({ moneyMotivation: e.target.value })} onBlur={() => { void flushDraft?.(personFlushAction); }} /></label>

            <div className="section-t">家庭 7 问（C1 计分项）</div>
            <div className="fam7">
              {FAMILY_7Q.map((q) => (
                <label key={q} className="fam7-edit">
                  <b>{q}</b>
                  <input value={personDraft.form.family7[q] ?? ''} onChange={(e) => patchForm({ family7: { ...personDraft.form.family7, [q]: e.target.value } })}
                    onBlur={() => { void flushDraft?.(personFlushAction); }} placeholder="待补" />
                </label>
              ))}
            </div>

            <div className="section-t">燃眉之急 BI <button className="add-mini" onClick={addBI}>＋</button></div>
            {bis.length === 0 && <div className="empty-hint">暂无 BI，点 ＋ 添加（C2 计分）</div>}
            {bis.map((bi) => (
              <div className="bi-card" key={bi.id}>
                <div className="row-between">
                  <select className="mini-select" value={bi.category} onChange={(e) => dispatch({ type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: { category: e.target.value } })}>
                    {BI_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select className="mini-select" value={bi.confidence} onChange={(e) => dispatch({ type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: { confidence: e.target.value as BurningIssue['confidence'] } })}>
                      {CONFIDENCES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                    <button className="row-del" onClick={() => dispatch({ type: 'DELETE_BI', accId, oppId, biId: bi.id })}>🗑</button>
                  </div>
                </div>
                <textarea rows={2} className="bare-area" placeholder="D 的私人/紧急痛点…" value={biDrafts[bi.id] ?? bi.description}
                  onChange={(e) => { biDirty.current.add(bi.id); pendingDraftActions.current.set(`bi:${bi.id}`, { type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: {} }); setBiDrafts((current) => ({ ...current, [bi.id]: e.target.value })); (draftDispatch ?? dispatch)({ type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: { description: e.target.value } }); }}
                  onBlur={() => { void flushDraft?.({ type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: {} }); }} />
              </div>
            ))}

            <div className="section-t">独特价值 UCV → C6 <button className="add-mini" onClick={addUCV} disabled={bis.length === 0}>＋</button></div>
            {bis.length === 0 && <div className="empty-hint">先添加 BI，UCV 需针对某个 BI</div>}
            {ucvs.map((u) => (
              <div className="ucv-card" key={u.id}>
                <div className="row-between">
                  <select className="mini-select" value={u.status} onChange={(e) => dispatch({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: { status: e.target.value as UCV['status'] } })}>
                    <option>建议</option><option>获认可</option><option>已解决</option>
                  </select>
                  <button className="row-del" onClick={() => dispatch({ type: 'DELETE_UCV', accId, oppId, ucvId: u.id })}>🗑</button>
                </div>
                <textarea rows={2} className="bare-area" placeholder="对手给不了的、能解决 BI 的独特价值…" value={ucvDrafts[u.id]?.description ?? u.description}
                  onChange={(e) => { ucvDirty.current.add(u.id); pendingDraftActions.current.set(`ucv:${u.id}`, { type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: {} }); setUcvDrafts((current) => ({ ...current, [u.id]: { description: e.target.value, competitorCannot: current[u.id]?.competitorCannot ?? u.competitorCannot } })); (draftDispatch ?? dispatch)({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: { description: e.target.value } }); }}
                  onBlur={() => { void flushDraft?.({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: {} }); }} />
                <input className="bare-input" placeholder="对手给不了的点" value={ucvDrafts[u.id]?.competitorCannot ?? u.competitorCannot}
                  onChange={(e) => { ucvDirty.current.add(u.id); pendingDraftActions.current.set(`ucv:${u.id}`, { type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: {} }); setUcvDrafts((current) => ({ ...current, [u.id]: { description: current[u.id]?.description ?? u.description, competitorCannot: e.target.value } })); (draftDispatch ?? dispatch)({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: { competitorCannot: e.target.value } }); }}
                  onBlur={() => { void flushDraft?.({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: {} }); }} />
              </div>
            ))}

            <div className="section-t">交往日志</div>
            <div className="log-add">
              <input value={logText} onChange={(e) => setLogText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLog()} placeholder="记一次互动…" />
              <label className="chk-line"><input type="checkbox" checked={logSensitive} onChange={(e) => setLogSensitive(e.target.checked)} />敏感</label>
              <button className="btn primary sm" onClick={addLog}>记录</button>
            </div>
            {person.logs.length > 0 ? (
              <div className="timeline">
                {person.logs.map((log, i) => (
                  <div className="tl-item" key={i}>
                    <div className="dt">{log.date}{log.sensitive && <span className="sensitive-tag">敏感·仅团队</span>}</div>
                    <div className="ct">{log.content}</div>
                  </div>
                ))}
              </div>
            ) : <div className="empty-hint">暂无记录</div>}
          </>
        )}

        {/* 删除节点：与「删除关系线」一致——放在详情页底部 */}
        <button className="btn ghost" style={{ width: '100%', marginTop: 18, color: '#b91c1c' }}
          onClick={() => { if (confirm(`删除干系人「${person.name}」？将一并移除其角色/关系/BI。`)) { dispatch({ type: 'DELETE_PERSON', accId, personId: person.id }); onClose(); } }}>
          🗑 删除该干系人
        </button>
      </div>
  );
  if (embedded) return body;
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="t">情报档案</span>
        <button className="x-btn" onClick={onClose}>×</button>
      </div>
      {body}
    </div>
  );
}
