// 审核收件箱 v1（机器写初稿·人审 主线）：Hub 级聚合当前租户所有待审候选（关系 + 人物），
// 按客户分组 + 类型筛选 + 多选批量采纳/驳回。复用 SuggestionPanel 的 sug-* 渲染语言。
// 采纳/驳回沿用既有 /api/suggest[/persons] 链路（采纳后由 App getState 重拉整树，保证跨客户一致）。
import { useMemo, useState } from 'react';
import type { InboxRel, InboxPerson } from '../api';
import { Modal } from './Modal';

const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const ORIGIN: Record<string, string> = { graph: '📊 图谱', llm: '🤖 AI', qcc: '🏢 企查查', mcp: '🌐 AI 调研', ai: '🤖 AI' };

type Item =
  | { kind: 'person'; id: string; accountId: string; accountName: string; data: InboxPerson }
  | { kind: 'rel'; id: string; accountId: string; accountName: string; data: InboxRel };

export function InboxPanel({ rels, persons, onAccept, onReject, onAcceptPerson, onRejectPerson, onClose }: {
  rels: InboxRel[];
  persons: InboxPerson[];
  onAccept: (id: string) => void;        // 关系候选采纳
  onReject: (id: string) => void;
  onAcceptPerson: (id: string) => void;  // 人物候选采纳
  onRejectPerson: (id: string) => void;
  onClose: () => void;
}) {
  const [acctFilter, setAcctFilter] = useState('');                       // '' = 全部客户
  const [typeFilter, setTypeFilter] = useState<'all' | 'person' | 'rel'>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());                 // 多选：item key = kind:id

  const accounts = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of persons) m.set(p.accountId, p.accountName);
    for (const r of rels) m.set(r.accountId, r.accountName);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [persons, rels]);

  const groups = useMemo(() => {
    const items: Item[] = [];
    if (typeFilter !== 'rel') for (const p of persons) if (!acctFilter || p.accountId === acctFilter) items.push({ kind: 'person', id: p.id, accountId: p.accountId, accountName: p.accountName, data: p });
    if (typeFilter !== 'person') for (const r of rels) if (!acctFilter || r.accountId === acctFilter) items.push({ kind: 'rel', id: r.id, accountId: r.accountId, accountName: r.accountName, data: r });
    const byAcct = new Map<string, { name: string; items: Item[] }>();
    for (const it of items) {
      const g = byAcct.get(it.accountId) ?? { name: it.accountName, items: [] };
      g.items.push(it); byAcct.set(it.accountId, g);
    }
    return [...byAcct.values()];
  }, [persons, rels, acctFilter, typeFilter]);

  const keyOf = (it: Item) => `${it.kind}:${it.id}`;
  const total = persons.length + rels.length;
  const toggleSel = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const batchApply = (accept: boolean) => {
    for (const g of groups) for (const it of g.items) {
      if (!sel.has(keyOf(it))) continue;
      if (it.kind === 'person') accept ? onAcceptPerson(it.id) : onRejectPerson(it.id);
      else accept ? onAccept(it.id) : onReject(it.id);
    }
    setSel(new Set());
  };

  return (
    <Modal title={`📥 审核收件箱${total > 0 ? ` · ${total}` : ''}`} width={680} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto', fontSize: 12, opacity: 0.7 }}>机器写入的关系/人物先进这里 · 采纳后才落库（绝不自动写入）</span>
        {sel.size > 0 ? (<>
          <button className="btn ghost" onClick={() => batchApply(false)}>忽略选中 {sel.size}</button>
          <button className="btn primary" onClick={() => batchApply(true)}>采纳选中 {sel.size}</button>
        </>) : <button className="btn ghost" onClick={onClose}>关闭</button>}
      </>}>

      {/* 筛选条：客户下拉 + 类型 */}
      <div className="inbox-filters">
        <select className="inbox-acct" value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)}>
          <option value="">全部客户（{accounts.length}）</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="inbox-types">
          {(['all', 'person', 'rel'] as const).map((t) => (
            <button key={t} className={`inbox-type${typeFilter === t ? ' on' : ''}`} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? '全部' : t === 'person' ? `👤 人物 ${persons.length}` : `🔗 关系 ${rels.length}`}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="sc-empty" style={{ padding: '36px 0' }}>
          <div style={{ fontSize: 30 }}>📭</div>
          <div>没有待审候选 · 机器写入的关系/人物会先进这里等你审</div>
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
                      {it.kind === 'person' ? (<>
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
                          <span className="sug-ev" style={{ opacity: 0.65 }}>🎯 {it.data.oppName}</span>
                          <span className="sug-ev">{it.data.evidence}</span>
                        </div>
                      </>)}
                    </div>
                    <div className="sug-actions">
                      <button className="btn primary sm" onClick={() => (it.kind === 'person' ? onAcceptPerson(it.id) : onAccept(it.id))}>采纳</button>
                      <button className="btn ghost sm" onClick={() => (it.kind === 'person' ? onRejectPerson(it.id) : onReject(it.id))}>忽略</button>
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
