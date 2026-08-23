// 作战档案 · 文档视图（路 A · 字段级内联编辑）：把客户/商机/拜访渲染成文档样式，
// 可编辑字段原地 input/勾选、失焦即 dispatch 写回系统。打分与角色只读（在画布/抽屉改）。
import { useEffect, useState } from 'react';
import { c5WriteItems, type Account, type Opportunity, type VisitNote, type AccountProfile, type Note } from '../types';
import {
  customerTypeLabel, ROLE_LABEL, SENTIMENT_CHAR, FAMILY_7Q, C3_ITEMS, C5_ITEMS,
} from '../types';
import { scoreFromDomain, BAND_LABEL, ITEM_MAX, type ItemKey } from '../lib/g64111';
import { uid, type Action } from '../store';
import { CuratedSummary } from './CuratedSummary';
import { api } from '../api';

/** 失焦提交的内联字段：本地编辑、值变了才 dispatch（避免每键写库）。 */
function Field({ value, onSave, ph, area, ro }: { value: string; onSave: (v: string) => void; ph?: string; area?: boolean; ro?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]); // 外部数据变化时同步（如别人改了 / 撤销）
  const commit = () => { if (v !== value) onSave(v); };
  if (ro) return <span className={`mdv-field-ro${area ? ' mdv-area-ro' : ''}`}>{value || '—'}</span>; // viewer：纯文本呈现
  return area
    ? <textarea className="mdv-field mdv-area" value={v} placeholder={ph ?? '—'} onChange={(e) => setV(e.target.value)} onBlur={commit} rows={2} />
    : <input className="mdv-field" value={v} placeholder={ph ?? '—'} onChange={(e) => setV(e.target.value)} onBlur={commit} />;
}

/** 自由文本层 · 笔记区（显示挂某实体的 note + 记一条 + 删；零 schema，复用 ADD/DELETE_NOTE） */
export function NotesSection({ notes, onAdd, onDelete, ro }: { notes: Note[]; onAdd: (content: string) => void; onDelete: (id: string) => void; ro?: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => { const c = draft.trim(); if (c) { onAdd(c); setDraft(''); } };
  return (
    <div className="mdv-notes">
      {!ro && <div className="mdv-note-add">
        <input className="mdv-field" value={draft} placeholder="记一条零散信息，回车保存…"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="mdv-note-btn" onClick={add} disabled={!draft.trim()}>记一条</button>
      </div>}
      {notes.length === 0 && <p className="mdv-empty">暂无笔记</p>}
      {notes.map((n) => (
        <blockquote key={n.id} className="mdv-note">
          <span className="mdv-note-text">{n.content}</span>
          {n.source && n.source !== 'manual' && <span className="mdv-note-src">· {n.source}</span>}
          {!ro && <button className="mdv-note-del" onClick={() => onDelete(n.id)} aria-label="删除笔记">✕</button>}
        </blockquote>
      ))}
    </div>
  );
}

/** 前端临时 id 复用全局 128-bit CSPRNG 生成器；内网 HTTP 也可用 getRandomValues。 */
const newId = uid;

type DocSel = { kind: 'customer' } | { kind: 'opp'; id: string } | { kind: 'visit'; id: string };

export function MdDocView({ account, sel, dispatch, readonly = false }: { account: Account; sel: DocSel; dispatch: (a: Action) => void; readonly?: boolean }) {
  if (sel.kind === 'opp') {
    const o = account.opportunities.find((x) => x.id === sel.id);
    return o ? <OppDoc account={account} opp={o} dispatch={dispatch} readonly={readonly} /> : <p className="mdv-empty">商机不存在</p>;
  }
  if (sel.kind === 'visit') {
    const vn = (account.visitNotes ?? []).find((x) => x.id === sel.id);
    return vn ? <VisitDoc account={account} visit={vn} dispatch={dispatch} readonly={readonly} /> : <p className="mdv-empty">拜访记录不存在</p>;
  }
  return <CustomerDoc account={account} dispatch={dispatch} readonly={readonly} />;
}

function primaryRole(account: Account, pid: string) {
  for (const o of account.opportunities) { const r = o.roles.find((x) => x.personId === pid); if (r) return r; }
  return undefined;
}

function CustomerDoc({ account, dispatch, readonly = false }: { account: Account; dispatch: (a: Action) => void; readonly?: boolean }) {
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  useEffect(() => {
    if (readonly) return;
    void api.members().then((r) => setMembers(r.members)).catch(() => setMembers([]));
  }, [readonly]);
  const set = (patch: Omit<Partial<Account>, 'customerType'>) => dispatch({ type: 'UPDATE_ACCOUNT', accId: account.id, patch });
  const pf = account.profile ?? {};
  const setPf = (k: keyof AccountProfile, v: string) => set({ profile: { ...pf, [k]: v } });
  const scored = account.opportunities.map((o) => ({ o, b: scoreFromDomain(account, o) }));
  const keyPersons = account.persons.filter((p) => { const r = primaryRole(account, p.id); return r && (r.role === 'A' || r.role === 'D'); });

  return (
    <div className="mdv">
      <h1>{account.name} · 客户档案</h1>
      <CuratedSummary entityKind="account" entityId={account.id} readonly={readonly} />
      <blockquote>
        <div><b>客户类型</b>：{customerTypeLabel(account.customerType)} <span className="mdv-ro">只读</span></div>
        <div><b>大区</b>：<Field ro={readonly} value={account.region ?? ''} ph="如 华北" onSave={(v) => set({ region: v })} /></div>
        <div><b>集团 / 母公司</b>：<Field ro={readonly} value={account.group ?? ''} onSave={(v) => set({ group: v })} /></div>
        <div><b>主负责人</b>：{readonly
          ? <span className="mdv-field-ro">{account.primaryOwner || '—'}</span>
          : <select className="mdv-field" value={account.primaryOwnerUserId ?? ''} onChange={(e) => {
              const member = members.find((m) => m.id === e.target.value);
              set({ primaryOwnerUserId: member?.id ?? null, primaryOwner: member?.name ?? '' });
            }}>
              <option value="">未归属（需人工指定）</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}
            </select>}
        </div>
      </blockquote>

      <h2>一、客户画像</h2>
      <table className="mdv-table"><tbody>
        {([['工商基础', 'business'], ['集团关系', 'group'], ['招投标', 'bidding'], ['风险信号', 'risk'], ['我方现有合作', 'ourCooperation'], ['销售背景', 'salesNote']] as [string, Exclude<keyof AccountProfile, '_mcpOrigin'>][]).map(([label, k]) => (
          <tr key={k}><th>{label}</th><td><Field ro={readonly} value={pf[k] ?? ''} area onSave={(v) => setPf(k, v)} /></td></tr>
        ))}
      </tbody></table>

      <h2>二、ADURC 组织与角色 <span className="mdv-ro">只读 · 在画布改</span></h2>
      <table className="mdv-table"><thead><tr><th>姓名</th><th>角色</th><th>倾向</th><th>职位</th></tr></thead><tbody>
        {account.persons.filter((p) => !p.isCompetitor).map((p) => {
          const r = primaryRole(account, p.id);
          return <tr key={p.id}><td>{p.name}</td><td>{r ? `${r.role} ${ROLE_LABEL[r.role]}` : '—'}</td><td>{r ? SENTIMENT_CHAR[r.sentiment] : '？'}</td><td>{p.title}</td></tr>;
        })}
      </tbody></table>

      <h2>三、关键人物 FORM</h2>
      {keyPersons.length === 0 && <p className="mdv-empty">尚未识别 A/D 关键人</p>}
      {keyPersons.map((p) => {
        const patchForm = (fp: Partial<typeof p.form>) => dispatch({ type: 'UPDATE_PERSON', accId: account.id, personId: p.id, patch: { form: { ...p.form, ...fp } } });
        return (
          <div key={p.id}>
            <h3>{p.name} · {ROLE_LABEL[primaryRole(account, p.id)!.role]}</h3>
            <table className="mdv-table"><tbody>
              {FAMILY_7Q.map((q) => (
                <tr key={q}><th>{q}</th><td><Field ro={readonly} value={p.form.family7?.[q] ?? ''} onSave={(v) => patchForm({ family7: { ...p.form.family7, [q]: v } })} /></td></tr>
              ))}
              <tr><th>职业经历</th><td><Field ro={readonly} value={p.form.occupation} area onSave={(v) => patchForm({ occupation: v })} /></td></tr>
              <tr><th>爱好 / 志趣</th><td><Field ro={readonly} value={p.form.recreation} onSave={(v) => patchForm({ recreation: v })} /></td></tr>
              <tr><th>金钱与动机</th><td><Field ro={readonly} value={p.form.moneyMotivation} onSave={(v) => patchForm({ moneyMotivation: v })} /></td></tr>
            </tbody></table>
          </div>
        );
      })}

      <h2>四、项目机会索引 <span className="mdv-ro">只读 · 详情见商机档案</span></h2>
      <table className="mdv-table"><thead><tr><th>项目</th><th>趋赢力</th><th>态势</th><th>对手</th></tr></thead><tbody>
        {scored.length === 0 && <tr><td colSpan={4} className="mdv-empty">暂无商机</td></tr>}
        {scored.map(({ o, b }) => <tr key={o.id}><td>{o.name}</td><td>{Math.round(b.percent * 100)}%</td><td>{BAND_LABEL[b.band]}</td><td>{o.competitor || '—'}</td></tr>)}
      </tbody></table>

      <h2>五、拜访记录 <span className="mdv-ro">只读 · 在拜访档案改</span></h2>
      {(account.visitNotes ?? []).length === 0 && <p className="mdv-empty">暂无拜访</p>}
      {(account.visitNotes ?? []).map((v) => <blockquote key={v.id}><b>{v.date || '⏳'} {v.topic}</b>：{v.summary || '—'}</blockquote>)}

      <h2>六、笔记 · 情报 <span className="mdv-ro">自由文本层 · 零散信息</span></h2>
      <NotesSection ro={readonly}
        notes={(account.notes ?? []).filter((n) => !n.personId && !n.opportunityId)}
        onAdd={(content) => dispatch({ type: 'ADD_NOTE', accId: account.id, note: { id: newId('note'), content, source: 'manual' } })}
        onDelete={(id) => dispatch({ type: 'DELETE_NOTE', accId: account.id, noteId: id })}
      />
    </div>
  );
}

function OppDoc({ account, opp, dispatch, readonly = false }: { account: Account; opp: Opportunity; dispatch: (a: Action) => void; readonly?: boolean }) {
  const set = (patch: Partial<Opportunity>) => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch });
  const b = scoreFromDomain(account, opp);
  const c5Items = c5WriteItems(opp.c5Items);
  const toggle = (which: 'c3Items' | 'c5Items', k: string) => {
    const current = which === 'c5Items'
      ? c5Items as Record<string, boolean | undefined>
      : opp.c3Items;
    set({ [which]: { ...current, [k]: !current[k] } } as Partial<Opportunity>);
  };
  const groups: [string, ItemKey[]][] = [['6必清', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']], ['4优势', ['P1', 'P2', 'P3', 'P4']], ['1决胜', ['1K']]];

  return (
    <div className="mdv">
      <h1>{opp.name} · 商机档案</h1>
      <CuratedSummary entityKind="opportunity" entityId={opp.id} readonly={readonly} />
      <blockquote>
        <div><b>所属客户</b>：{account.name} ｜ <b>阶段</b>：{opp.pipelineStage} / {opp.engageStage} <span className="mdv-ro">只读</span></div>
        <div><b>单一销售目标</b>：<Field ro={readonly} value={opp.singleSalesGoal} area onSave={(v) => set({ singleSalesGoal: v })} /></div>
        <div><b>客户业务目标</b>：<Field ro={readonly} value={opp.customerBusinessGoal ?? ''} onSave={(v) => set({ customerBusinessGoal: v })} /></div>
        <div><b>购买动机</b>：<Field ro={readonly} value={opp.buyingMotivation ?? ''} onSave={(v) => set({ buyingMotivation: v })} /></div>
        <div><b>主要对手</b>：<Field ro={readonly} value={opp.competitor ?? ''} onSave={(v) => set({ competitor: v })} /></div>
        <div><b>趋赢力</b>：{Math.round(b.percent * 100)}% · {BAND_LABEL[b.band]} <span className="mdv-ro">系统实时算 · 只读</span></div>
      </blockquote>

      <h2>一、立项材料（C3）</h2>
      <table className="mdv-table"><tbody>{C3_ITEMS.map((k) => (
        <tr key={k}><th>{k}</th><td>{readonly ? <span>{opp.c3Items[k] ? '✓ 已掌握' : '待补充'}</span> : <label className="mdv-check"><input type="checkbox" checked={!!opp.c3Items[k]} onChange={() => toggle('c3Items', k)} /> {opp.c3Items[k] ? '已掌握' : '待补充'}</label>}</td></tr>
      ))}</tbody></table>

      <h2>二、招采事项（C5）</h2>
      <table className="mdv-table"><tbody>{C5_ITEMS.map((k) => (
        <tr key={k}><th>{k}</th><td>{readonly ? <span>{c5Items[k] ? '✓ 已掌握' : '待补充'}</span> : <label className="mdv-check"><input type="checkbox" checked={!!c5Items[k]} onChange={() => toggle('c5Items', k)} /> {c5Items[k] ? '已掌握' : '待补充'}</label>}</td></tr>
      ))}</tbody></table>

      <h2>三、G64111 趋赢力打分 <span className="mdv-ro">系统据角色/BI/招采实时算 · 只读</span></h2>
      <table className="mdv-table"><thead><tr><th>类别</th><th>项</th><th>满分</th><th>当前分</th></tr></thead><tbody>
        {groups.map(([g, ks]) => ks.map((k) => <tr key={k}><td>{g}</td><td>{k}</td><td>{ITEM_MAX[k]}</td><td>{b.items[k]}</td></tr>))}
        <tr className="mdv-total"><td colSpan={3}><b>趋赢力总分</b></td><td><b>{b.total} / 100</b></td></tr>
      </tbody></table>

      <h2>四、笔记 · 情报 <span className="mdv-ro">自由文本层 · 本商机</span></h2>
      <NotesSection ro={readonly}
        notes={(account.notes ?? []).filter((n) => n.opportunityId === opp.id)}
        onAdd={(content) => dispatch({ type: 'ADD_NOTE', accId: account.id, note: { id: newId('note'), opportunityId: opp.id, content, source: 'manual' } })}
        onDelete={(id) => dispatch({ type: 'DELETE_NOTE', accId: account.id, noteId: id })}
      />
    </div>
  );
}

function VisitDoc({ account, visit, dispatch, readonly = false }: { account: Account; visit: VisitNote; dispatch: (a: Action) => void; readonly?: boolean }) {
  const set = (patch: Partial<VisitNote>) => dispatch({ type: 'UPDATE_VISIT', accId: account.id, visitId: visit.id, patch });
  const oppName = visit.opportunityId ? account.opportunities.find((o) => o.id === visit.opportunityId)?.name : '';
  const who = visit.participants?.map((x) => `${x.name}（${x.side === 'our' ? '我方' : '客户'}）`).join('、') || '—';
  return (
    <div className="mdv">
      <h1>拜访记录 · {visit.date || '⏳'}</h1>
      <blockquote>
        <div><b>客户</b>：{account.name}{oppName ? ` ｜ 关联商机：${oppName}` : ''} <span className="mdv-ro">只读</span></div>
        <div><b>日期</b>：{visit.date || '⏳'} ｜ <b>参与人</b>：{who} <span className="mdv-ro">只读</span></div>
        <div><b>主题</b>：<Field ro={readonly} value={visit.topic} onSave={(v) => set({ topic: v })} /></div>
      </blockquote>
      <h2>纪要正文</h2>
      <Field ro={readonly} value={visit.summary} area onSave={(v) => set({ summary: v })} />
    </div>
  );
}
