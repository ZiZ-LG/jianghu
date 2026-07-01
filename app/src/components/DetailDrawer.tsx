import { useState, type Dispatch } from 'react';
import type { Person, OppRole, BurningIssue, UCV, Role, Sentiment, ProcurementType, ProcurementStatus } from '../types';
import {
  ROLE_LABEL, SENTIMENT_LABEL, FAMILY_7Q, CONFIDENCES, BI_CATEGORIES,
  PROCUREMENT_TYPE_LABEL, PROCUREMENT_STATUS_LABEL,
} from '../types';
import { type Action, uid } from '../store';

const ROLES: Role[] = ['A', 'D', 'U', 'R', 'C'];
const SENTIMENTS: Sentiment[] = ['star', 'plus', 'neutral', 'unknown', 'minus', 'x'];

export function DetailDrawer({
  accId, oppId, person, oppRole, bis, ucvs, dispatch, onClose, embedded,
}: {
  accId: string; oppId: string;
  person: Person;
  oppRole?: OppRole;
  bis: BurningIssue[];
  ucvs: UCV[];
  dispatch: Dispatch<Action>;
  onClose: () => void;
  embedded?: boolean; // 焦点面板「档案」tab 复用：去掉 .drawer 外壳与标题栏，只渲染 body
}) {
  const [logText, setLogText] = useState('');
  const [logSensitive, setLogSensitive] = useState(false);

  const patchPerson = (patch: Partial<Person>) => dispatch({ type: 'UPDATE_PERSON', accId, personId: person.id, patch });
  const patchForm = (fp: Partial<Person['form']>) => patchPerson({ form: { ...person.form, ...fp } });
  const setRole = (patch: Partial<OppRole>) => dispatch({ type: 'SET_ROLE', accId, oppId, personId: person.id, patch });

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
        <div className="person-hd">
          <div className="avatar">{person.name[0] || '?'}</div>
          <div style={{ flex: 1 }}>
            <input className="inline-name" value={person.name} onChange={(e) => patchPerson({ name: e.target.value })} placeholder="姓名" />
            <input className="inline-title" value={person.title} onChange={(e) => patchPerson({ title: e.target.value })} placeholder="职务" />
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
            <label className="fld sm"><span>F 家庭</span><textarea rows={1} value={person.form.family} onChange={(e) => patchForm({ family: e.target.value })} /></label>
            <label className="fld sm"><span>O 事业</span><textarea rows={1} value={person.form.occupation} onChange={(e) => patchForm({ occupation: e.target.value })} /></label>
            <label className="fld sm"><span>R 休闲</span><textarea rows={1} value={person.form.recreation} onChange={(e) => patchForm({ recreation: e.target.value })} /></label>
            <label className="fld sm"><span>M 金钱与梦想</span><textarea rows={1} value={person.form.moneyMotivation} onChange={(e) => patchForm({ moneyMotivation: e.target.value })} /></label>

            <div className="section-t">家庭 7 问（C1 计分项）</div>
            <div className="fam7">
              {FAMILY_7Q.map((q) => (
                <label key={q} className="fam7-edit">
                  <b>{q}</b>
                  <input value={person.form.family7[q] ?? ''} onChange={(e) => patchForm({ family7: { ...person.form.family7, [q]: e.target.value } })} placeholder="待补" />
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
                <textarea rows={2} className="bare-area" placeholder="D 的私人/紧急痛点…" value={bi.description}
                  onChange={(e) => dispatch({ type: 'UPDATE_BI', accId, oppId, biId: bi.id, patch: { description: e.target.value } })} />
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
                <textarea rows={2} className="bare-area" placeholder="对手给不了的、能解决 BI 的独特价值…" value={u.description}
                  onChange={(e) => dispatch({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: { description: e.target.value } })} />
                <input className="bare-input" placeholder="对手给不了的点" value={u.competitorCannot}
                  onChange={(e) => dispatch({ type: 'UPDATE_UCV', accId, oppId, ucvId: u.id, patch: { competitorCannot: e.target.value } })} />
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
