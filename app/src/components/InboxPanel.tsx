// 审核收件箱（机器写初稿·人审）：Hub 级聚合当前租户所有待审——v1 关系/人物候选 + v2.0 字段更新提案。
// 按客户分组 + 类型筛选 + 多选批量。提案卡带 改前→改后 diff + 趋赢力影响预览 + 改后采纳（下拉）。
// 采纳/驳回沿用既有链路（采纳后由 App getState 重拉整树保证跨客户一致）。
import { useMemo, useState } from 'react';
import type { Account } from '../types';
import type { InboxRel, InboxPerson, InboxProposal } from '../api';
import { previewProposalImpact } from '../lib/impact';
import { Modal } from './Modal';

const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const ORIGIN: Record<string, string> = { graph: '📊 图谱', llm: '🤖 AI', qcc: '🏢 企查查', mcp: '🌐 AI 调研', ai: '🤖 AI', voice: '🎙️ 录音', engine: '⚙️ 引擎' };
const SENT_LABEL: Record<string, string> = { star: '排他支持', plus: '明确支持', neutral: '中立', unknown: '未知', minus: '负面/抗拒', x: '倒向对手' };
const FIELD_LABEL: Record<string, string> = { sentiment: '支持度', confidence: '可信度' };
const SENT_OPTS = ['star', 'plus', 'neutral', 'minus', 'x'];
const valLabel = (field: string, v: string) => (field === 'sentiment' ? (SENT_LABEL[v] ?? v) : v);

type Item =
  | { kind: 'person'; id: string; accountId: string; accountName: string; data: InboxPerson }
  | { kind: 'rel'; id: string; accountId: string; accountName: string; data: InboxRel }
  | { kind: 'proposal'; id: string; accountId: string; accountName: string; data: InboxProposal };

export function InboxPanel({ rels, persons, proposals, accounts, onAccept, onReject, onAcceptPerson, onRejectPerson, onAcceptProposal, onRejectProposal, onClose }: {
  rels: InboxRel[];
  persons: InboxPerson[];
  proposals: InboxProposal[];
  accounts: Account[];                                  // 全树（算影响预览：找目标 account/opp）
  onAccept: (id: string) => void;                       // 关系候选采纳
  onReject: (id: string) => void;
  onAcceptPerson: (id: string) => void;                 // 人物候选采纳
  onRejectPerson: (id: string) => void;
  onAcceptProposal: (id: string, overrideValue?: string) => void; // 字段提案采纳（可改后采纳）
  onRejectProposal: (id: string) => void;
  onClose: () => void;
}) {
  const [acctFilter, setAcctFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'proposal' | 'person' | 'rel'>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({}); // 提案改后采纳：id → 选定值

  const acctList = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of persons) m.set(p.accountId, p.accountName);
    for (const r of rels) m.set(r.accountId, r.accountName);
    for (const cp of proposals) m.set(cp.accountId, cp.accountName);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [persons, rels, proposals]);

  const groups = useMemo(() => {
    const items: Item[] = [];
    const ok = (aid: string) => !acctFilter || aid === acctFilter;
    if (typeFilter === 'all' || typeFilter === 'proposal') for (const cp of proposals) if (ok(cp.accountId)) items.push({ kind: 'proposal', id: cp.id, accountId: cp.accountId, accountName: cp.accountName, data: cp });
    if (typeFilter === 'all' || typeFilter === 'person') for (const p of persons) if (ok(p.accountId)) items.push({ kind: 'person', id: p.id, accountId: p.accountId, accountName: p.accountName, data: p });
    if (typeFilter === 'all' || typeFilter === 'rel') for (const r of rels) if (ok(r.accountId)) items.push({ kind: 'rel', id: r.id, accountId: r.accountId, accountName: r.accountName, data: r });
    const byAcct = new Map<string, { name: string; items: Item[] }>();
    for (const it of items) {
      const g = byAcct.get(it.accountId) ?? { name: it.accountName, items: [] };
      g.items.push(it); byAcct.set(it.accountId, g);
    }
    return [...byAcct.values()];
  }, [persons, rels, proposals, acctFilter, typeFilter]);

  const keyOf = (it: Item) => `${it.kind}:${it.id}`;
  const total = persons.length + rels.length + proposals.length;
  const toggleSel = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const batchApply = (accept: boolean) => {
    for (const g of groups) for (const it of g.items) {
      if (!sel.has(keyOf(it))) continue;
      if (it.kind === 'person') accept ? onAcceptPerson(it.id) : onRejectPerson(it.id);
      else if (it.kind === 'rel') accept ? onAccept(it.id) : onReject(it.id);
      else accept ? onAcceptProposal(it.id, overrides[it.id]) : onRejectProposal(it.id);
    }
    setSel(new Set());
  };

  // 提案影响预览：从全树找目标 account/opp 算趋赢力 before/after
  const impactOf = (cp: InboxProposal) => {
    const acc = accounts.find((a) => a.id === cp.accountId);
    const opp = acc?.opportunities.find((o) => o.id === cp.opportunityId);
    if (!acc) return null;
    return previewProposalImpact(acc, opp, { entityKind: cp.entityKind, entityId: cp.entityId, field: cp.field, newValue: overrides[cp.id] ?? cp.newValue });
  };

  return (
    <Modal title={`📥 审核收件箱${total > 0 ? ` · ${total}` : ''}`} width={700} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto', fontSize: 12, opacity: 0.7 }}>机器写入先进这里 · 采纳后才落库（绝不自动写入）</span>
        {sel.size > 0 ? (<>
          <button className="btn ghost" onClick={() => batchApply(false)}>忽略选中 {sel.size}</button>
          <button className="btn primary" onClick={() => batchApply(true)}>采纳选中 {sel.size}</button>
        </>) : <button className="btn ghost" onClick={onClose}>关闭</button>}
      </>}>

      <div className="inbox-filters">
        <select className="inbox-acct" value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)}>
          <option value="">全部客户（{acctList.length}）</option>
          {acctList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="inbox-types">
          {(['all', 'proposal', 'person', 'rel'] as const).map((t) => (
            <button key={t} className={`inbox-type${typeFilter === t ? ' on' : ''}`} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? '全部' : t === 'proposal' ? `✏️ 改字段 ${proposals.length}` : t === 'person' ? `👤 人物 ${persons.length}` : `🔗 关系 ${rels.length}`}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="sc-empty" style={{ padding: '36px 0' }}>
          <div style={{ fontSize: 30 }}>📭</div>
          <div>没有待审候选 · 机器写入的关系/人物/字段改动会先进这里等你审</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-hint" style={{ padding: '8px 2px' }}>当前筛选无候选。</div>
      ) : (
        groups.map((g) => (
          <div key={g.name} className="inbox-group">
            <div className="inbox-group-h">🏢 {g.name}<span className="inbox-group-n">{g.items.length}</span></div>
            <div className="sug-list">
              {g.items.map((it) => {
                const k = keyOf(it);
                const checked = sel.has(k);
                return (
                  <div key={k} className={`sug-row${checked ? ' inbox-sel' : ''}`}>
                    <input type="checkbox" className="inbox-ck" checked={checked} onChange={() => toggleSel(k)} />
                    <div className="sug-main">
                      {it.kind === 'proposal' ? (() => {
                        const cp = it.data; const imp = impactOf(cp);
                        return (<>
                          <div className="sug-pair">
                            <span className="inbox-tag">✏️ 改字段</span>
                            <b>{cp.entityName}</b>
                            <span className="sug-edge" style={{ color: '#64748b' }}>· {FIELD_LABEL[cp.field] ?? cp.field}</span>
                            {imp && <span className="inbox-impact" style={{ background: imp.after >= imp.before ? '#16a34a' : '#dc2626' }}>趋赢力 {imp.before}%→{imp.after}%</span>}
                          </div>
                          <div className="sug-meta">
                            <span className="inbox-diff"><span className="diff-old">{valLabel(cp.field, cp.oldValue) || '（空）'}</span> → <span className="diff-new">{valLabel(cp.field, overrides[cp.id] ?? cp.newValue)}</span></span>
                            <span className="sug-origin">{ORIGIN[cp.origin] || cp.origin}</span>
                            {cp.oppName && <span className="sug-ev" style={{ opacity: 0.65 }}>🎯 {cp.oppName}</span>}
                            <span className="sug-ev">{cp.evidence}</span>
                          </div>
                        </>);
                      })() : it.kind === 'person' ? (<>
                        <div className="sug-pair">
                          <span className="inbox-tag">👤 人物</span>
                          <b>{it.data.name}</b>
                          {it.data.title && <span className="sug-edge" style={{ color: '#64748b' }}>· {it.data.title}</span>}
                          <span className="sug-conf">{Math.round(it.data.confidence * 100)}%</span>
                        </div>
                        <div className="sug-meta">
                          <span className="sug-origin">{ORIGIN[it.data.origin] || it.data.origin}</span>
                          {it.data.existingPersonId && <span className="sug-lyr" style={{ background: '#f59e0b' }}>已有同名</span>}
                          <span className="sug-ev">{it.data.evidence}{it.data.sourceUrl ? ` · ${it.data.sourceUrl}` : ''}</span>
                        </div>
                      </>) : (<>
                        <div className="sug-pair">
                          <span className="inbox-tag">🔗 关系</span>
                          <b>{it.data.sourceName}</b>
                          <span className="sug-edge" style={{ color: LAYER_COLOR[it.data.layer] }}>— {it.data.label} —</span>
                          <b>{it.data.targetName}</b>
                          <span className="sug-conf">{Math.round(it.data.confidence * 100)}%</span>
                        </div>
                        <div className="sug-meta">
                          <span className="sug-origin">{ORIGIN[it.data.origin] || it.data.origin}</span>
                          <span className="sug-lyr" style={{ background: LAYER_COLOR[it.data.layer] }}>{it.data.layer}</span>
                          {it.data.oppName && <span className="sug-ev" style={{ opacity: 0.65 }}>🎯 {it.data.oppName}</span>}
                          <span className="sug-ev">{it.data.evidence}</span>
                        </div>
                      </>)}
                    </div>
                    <div className="sug-actions">
                      {it.kind === 'proposal' && it.data.field === 'sentiment' && (
                        <select className="inbox-override" value={overrides[it.id] ?? it.data.newValue} onChange={(e) => setOverrides((o) => ({ ...o, [it.id]: e.target.value }))} title="改后采纳：选一个不同的值再采纳">
                          {SENT_OPTS.map((s) => <option key={s} value={s}>{SENT_LABEL[s]}</option>)}
                        </select>
                      )}
                      <button className="btn primary sm" onClick={() => (it.kind === 'person' ? onAcceptPerson(it.id) : it.kind === 'rel' ? onAccept(it.id) : onAcceptProposal(it.id, overrides[it.id]))}>采纳</button>
                      <button className="btn ghost sm" onClick={() => (it.kind === 'person' ? onRejectPerson(it.id) : it.kind === 'rel' ? onReject(it.id) : onRejectProposal(it.id))}>忽略</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}
