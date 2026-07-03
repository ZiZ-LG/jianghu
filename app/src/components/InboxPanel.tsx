// 审核收件箱（机器写初稿·人审）：Hub 级聚合当前租户所有待审——巡检提醒 + 关系/人物候选 + v2.0 字段更新提案 + M3 证据待审（第5类）。
// 按客户分组 + 类型筛选 + 多选批量。提案卡带 改前→改后 diff + 趋赢力影响预览 + 改后采纳（下拉）；提醒卡只读（仅「忽略」，不建边/不改值）；
// 证据卡=审事实（这条信号是真的吗），批准才进 E2 燃料池——与提案卡（审判断=要不要改分）双层人审各有语义。
// 采纳/驳回沿用既有链路（采纳后由 App getState 重拉整树保证跨客户一致）。
import { useMemo, useState } from 'react';
import type { Account } from '../types';
import type { InboxRel, InboxPerson, InboxProposal, InboxReminder, InboxEvidence } from '../api';
import { previewProposalImpact } from '../lib/impact';
import { Modal } from './Modal';

const LAYER_COLOR: Record<string, string> = { L1: '#2563eb', L2: '#9333ea', L3: '#16a34a', L4: '#ef4444' };
const ORIGIN: Record<string, string> = { graph: '📊 图谱', llm: '🤖 AI', qcc: '🏢 企查查', mcp: '🌐 AI 调研', ai: '🤖 AI', voice: '🎙️ 录音', recording: '🎧 录音转写', engine: '⚙️ 引擎' };
const SENT_LABEL: Record<string, string> = { star: '排他支持', plus: '明确支持', neutral: '中立', unknown: '未知', minus: '负面/抗拒', x: '倒向对手' };
const FIELD_LABEL: Record<string, string> = { sentiment: '支持度', confidence: '可信度', isKeyInfluencer: '关键影响人' }; // P13 扩广度
const KIND_LABEL: Record<string, string> = { stalled: '商机停滞', no_decider: '决策链缺口', sentiment_recheck: '支持度复查' };
const SENT_OPTS = ['star', 'plus', 'neutral', 'minus', 'x'];
const CONFIDENCE_OPTS = ['共识', '明确', '推理', '不清']; // P13：可信度四档，OppRole.confidence 值域
const TIER_LABEL: Record<string, string> = { weak: '弱', mid: '中', strong: '强' };
// P13：值→显示文案泛化——sentiment 走标签映射；isKeyInfluencer 布尔→是/否；其余原样
const valLabel = (field: string, v: string) => (
  field === 'sentiment' ? (SENT_LABEL[v] ?? v)
  : field === 'isKeyInfluencer' ? (v === 'true' ? '是' : v === 'false' ? '否' : v)
  : v
);

type Item =
  | { kind: 'reminder'; id: string; accountId: string; accountName: string; data: InboxReminder }
  | { kind: 'person'; id: string; accountId: string; accountName: string; data: InboxPerson }
  | { kind: 'rel'; id: string; accountId: string; accountName: string; data: InboxRel }
  | { kind: 'proposal'; id: string; accountId: string; accountName: string; data: InboxProposal }
  | { kind: 'evidence'; id: string; accountId: string; accountName: string; data: InboxEvidence };

export function InboxPanel({ rels, persons, proposals, reminders, evidences, accounts, onAccept, onReject, onAcceptPerson, onRejectPerson, onAcceptProposal, onRejectProposal, onDismissReminder, onReviewEvidence, onClose }: {
  rels: InboxRel[];
  persons: InboxPerson[];
  proposals: InboxProposal[];
  reminders: InboxReminder[];                            // 巡检提醒（提醒型，只读）
  evidences: InboxEvidence[];                            // M3 证据待审（机器抽取的行为信号）
  accounts: Account[];                                  // 全树（算影响预览：找目标 account/opp）
  onAccept: (id: string, override?: { layer?: string; label?: string }) => void;   // 关系候选采纳（P10 可改层级/标签后采纳）
  onReject: (id: string) => void;
  onAcceptPerson: (id: string, override?: { name?: string; title?: string }) => void; // 人物候选采纳（P10 可改名字/职务后采纳）
  onRejectPerson: (id: string) => void;
  onAcceptProposal: (id: string, overrideValue?: string) => void; // 字段提案采纳（可改后采纳）
  onRejectProposal: (id: string) => void;
  onDismissReminder: (id: string) => void;              // 提醒忽略（不改业务库）
  onReviewEvidence: (id: string, action: 'approve' | 'reject', direction?: -1 | 0 | 1) => void; // 证据审核（批准可带定向）
  onClose: () => void;
}) {
  const [acctFilter, setAcctFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'reminder' | 'proposal' | 'person' | 'rel' | 'evidence'>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, string>>({}); // 提案改后采纳：id → 选定值
  const [evDirs, setEvDirs] = useState<Record<string, -1 | 0 | 1>>({});   // 证据改后采纳：id → 人工定向
  // P10 改后采纳扩到最后两类二元卡：人物（名字/职务）、关系（层级/标签）——编辑才建条目，采纳时带上
  const [personEdits, setPersonEdits] = useState<Record<string, { name: string; title: string }>>({});
  const [relEdits, setRelEdits] = useState<Record<string, { layer: string; label: string }>>({});

  const acctList = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reminders) m.set(r.accountId, r.accountName);
    for (const p of persons) m.set(p.accountId, p.accountName);
    for (const r of rels) m.set(r.accountId, r.accountName);
    for (const cp of proposals) m.set(cp.accountId, cp.accountName);
    for (const e of evidences) m.set(e.accountId, e.accountName);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [persons, rels, proposals, reminders, evidences]);

  // 提案影响（按原始 newValue，供排序用；展示处另按 overrides 现算）
  const rawImpact = (cp: InboxProposal) => {
    const acc = accounts.find((a) => a.id === cp.accountId);
    const opp = acc?.opportunities.find((o) => o.id === cp.opportunityId);
    return acc ? previewProposalImpact(acc, opp, { entityKind: cp.entityKind, entityId: cp.entityId, field: cp.field, newValue: cp.newValue }) : null;
  };

  const groups = useMemo(() => {
    const items: Item[] = [];
    const ok = (aid: string) => !acctFilter || aid === acctFilter;
    if (typeFilter === 'all' || typeFilter === 'reminder') for (const r of reminders) if (ok(r.accountId)) items.push({ kind: 'reminder', id: r.id, accountId: r.accountId, accountName: r.accountName, data: r });
    if (typeFilter === 'all' || typeFilter === 'proposal') for (const cp of proposals) if (ok(cp.accountId)) items.push({ kind: 'proposal', id: cp.id, accountId: cp.accountId, accountName: cp.accountName, data: cp });
    if (typeFilter === 'all' || typeFilter === 'evidence') for (const e of evidences) if (ok(e.accountId)) items.push({ kind: 'evidence', id: e.id, accountId: e.accountId, accountName: e.accountName, data: e });
    if (typeFilter === 'all' || typeFilter === 'person') for (const p of persons) if (ok(p.accountId)) items.push({ kind: 'person', id: p.id, accountId: p.accountId, accountName: p.accountName, data: p });
    if (typeFilter === 'all' || typeFilter === 'rel') for (const r of rels) if (ok(r.accountId)) items.push({ kind: 'rel', id: r.id, accountId: r.accountId, accountName: r.accountName, data: r });
    // 按价值排序（屏效 P0·人审注意力）：类型间优先级不变（提醒=「该动了」信号仍最前），
    // 类内按价值降序——提案 |趋赢力Δ| / 提醒 warn>info / 证据 tier 强>中>弱 / 人物·关系候选 置信度。影响最大的先见。
    const rank: Record<Item['kind'], number> = { reminder: 0, proposal: 1, evidence: 2, person: 3, rel: 4 };
    const valueOf = (it: Item): number => {
      if (it.kind === 'proposal') { const imp = rawImpact(it.data); return imp ? Math.abs(imp.after - imp.before) : 0; }
      if (it.kind === 'reminder') return it.data.severity === 'warn' ? 1 : 0;
      if (it.kind === 'evidence') return it.data.tier === 'strong' ? 2 : it.data.tier === 'mid' ? 1 : 0;
      return it.data.confidence ?? 0;
    };
    items.sort((a, b) => rank[a.kind] - rank[b.kind] || valueOf(b) - valueOf(a));
    const byAcct = new Map<string, { name: string; items: Item[] }>();
    for (const it of items) {
      const g = byAcct.get(it.accountId) ?? { name: it.accountName, items: [] };
      g.items.push(it); byAcct.set(it.accountId, g);
    }
    return [...byAcct.values()];
  }, [persons, rels, proposals, reminders, evidences, acctFilter, typeFilter, accounts]);

  const keyOf = (it: Item) => `${it.kind}:${it.id}`;
  const total = persons.length + rels.length + proposals.length + reminders.length + evidences.length;
  const toggleSel = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const batchApply = (accept: boolean) => {
    for (const g of groups) for (const it of g.items) {
      if (!sel.has(keyOf(it))) continue;
      if (it.kind === 'reminder') { if (!accept) onDismissReminder(it.id); } // 提醒只读：批量仅「忽略」，采纳无意义
      else if (it.kind === 'evidence') onReviewEvidence(it.id, accept ? 'approve' : 'reject', accept ? (evDirs[it.id] ?? undefined) : undefined);
      else if (it.kind === 'person') accept ? onAcceptPerson(it.id, personEdits[it.id]) : onRejectPerson(it.id);
      else if (it.kind === 'rel') accept ? onAccept(it.id, relEdits[it.id]) : onReject(it.id);
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
          {(['all', 'reminder', 'proposal', 'evidence', 'person', 'rel'] as const).map((t) => (
            <button key={t} className={`inbox-type${typeFilter === t ? ' on' : ''}`} onClick={() => setTypeFilter(t)}>
              {t === 'all' ? '全部' : t === 'reminder' ? `⏰ 提醒 ${reminders.length}` : t === 'proposal' ? `✏️ 改字段 ${proposals.length}` : t === 'evidence' ? `⚡ 信号 ${evidences.length}` : t === 'person' ? `👤 人物 ${persons.length}` : `🔗 关系 ${rels.length}`}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <div className="sc-empty" style={{ padding: '36px 0' }}>
          <div style={{ fontSize: 30 }}>📭</div>
          <div>没有待审候选 · 机器写入的提醒 / 关系 / 人物 / 字段改动会先进这里等你审</div>
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
                      {it.kind === 'reminder' ? (<>
                        <div className="sug-pair">
                          <span className="inbox-tag" style={it.data.severity === 'warn' ? { background: '#fee2e2', color: '#b91c1c', opacity: 1 } : undefined}>⏰ {KIND_LABEL[it.data.kind] ?? '提醒'}</span>
                          <b>{it.data.title}</b>
                        </div>
                        <div className="sug-meta">
                          <span className="sug-origin">⚙️ 巡检</span>
                          {it.data.oppName && <span className="sug-ev" style={{ opacity: 0.65 }}>🎯 {it.data.oppName}</span>}
                          <span className="sug-ev">{it.data.detail}</span>
                        </div>
                      </>) : it.kind === 'proposal' ? (() => {
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
                      })() : it.kind === 'evidence' ? (() => {
                        const ev = it.data;
                        const dir = evDirs[ev.id] ?? ev.direction;
                        return (<>
                          <div className="sug-pair">
                            <span className="inbox-tag" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)', opacity: 1 }}>⚡ 信号</span>
                            <b>{ev.personName}</b>
                            <span className="sug-edge" style={{ color: '#64748b' }}>· {ev.signalLabel}</span>
                            <span className="sug-lyr" style={{ background: dir > 0 ? '#16a34a' : dir < 0 ? '#dc2626' : '#94a3b8' }}>{dir > 0 ? '＋利好' : dir < 0 ? '－不利' : '○待定向'}</span>
                            <span className="sug-conf" title="信号固有档位（来自信号库）">{TIER_LABEL[ev.tier] ?? ev.tier}档</span>
                          </div>
                          <div className="sug-meta">
                            <span className="sug-origin">{ORIGIN[ev.origin] || ev.origin}</span>
                            {ev.oppName && <span className="sug-ev" style={{ opacity: 0.65 }}>🎯 {ev.oppName}</span>}
                            <span className="sug-ev">{ev.rawContent || '（无原文）'}</span>
                          </div>
                        </>);
                      })() : it.kind === 'person' ? (<>
                        <div className="sug-pair">
                          <span className="inbox-tag">👤 人物</span>
                          <b>{personEdits[it.id]?.name ?? it.data.name}{personEdits[it.id] && personEdits[it.id].name !== it.data.name && <span className="inbox-edited">✍️改</span>}</b>
                          {(personEdits[it.id]?.title ?? it.data.title) && <span className="sug-edge" style={{ color: '#64748b' }}>· {personEdits[it.id]?.title ?? it.data.title}</span>}
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
                          <span className="sug-edge" style={{ color: LAYER_COLOR[relEdits[it.id]?.layer ?? it.data.layer] }}>— {relEdits[it.id]?.label ?? it.data.label} —</span>
                          <b>{it.data.targetName}</b>
                          {relEdits[it.id] && (relEdits[it.id].layer !== it.data.layer || relEdits[it.id].label !== it.data.label) && <span className="inbox-edited">✍️改</span>}
                          <span className="sug-conf">{Math.round(it.data.confidence * 100)}%</span>
                        </div>
                        <div className="sug-meta">
                          <span className="sug-origin">{ORIGIN[it.data.origin] || it.data.origin}</span>
                          <span className="sug-lyr" style={{ background: LAYER_COLOR[relEdits[it.id]?.layer ?? it.data.layer] }}>{relEdits[it.id]?.layer ?? it.data.layer}</span>
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
                      {/* P13 扩广度：可信度四档 / 关键影响人是否 */}
                      {it.kind === 'proposal' && it.data.field === 'confidence' && (
                        <select className="inbox-override" value={overrides[it.id] ?? it.data.newValue} onChange={(e) => setOverrides((o) => ({ ...o, [it.id]: e.target.value }))} title="改后采纳：选一档可信度再采纳">
                          {CONFIDENCE_OPTS.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                      {it.kind === 'proposal' && it.data.field === 'isKeyInfluencer' && (
                        <select className="inbox-override" value={overrides[it.id] ?? it.data.newValue} onChange={(e) => setOverrides((o) => ({ ...o, [it.id]: e.target.value }))} title="改后采纳：是否为关键影响人">
                          <option value="true">是</option><option value="false">否</option>
                        </select>
                      )}
                      {it.kind === 'evidence' && (
                        <select className="inbox-override" value={String(evDirs[it.id] ?? it.data.direction)} onChange={(e) => setEvDirs((o) => ({ ...o, [it.id]: Number(e.target.value) as -1 | 0 | 1 }))} title="修改后采纳：中性信号需人工定向">
                          <option value="1">＋利好</option><option value="0">○中性</option><option value="-1">－不利</option>
                        </select>
                      )}
                      {/* P10 改后采纳：人物=名字/职务 inline 改；关系=层级/标签——改完点采纳即以改后值落库 */}
                      {it.kind === 'person' && (() => {
                        const ed = personEdits[it.id] ?? { name: it.data.name, title: it.data.title || '' };
                        const set = (patch: Partial<typeof ed>) => setPersonEdits((o) => ({ ...o, [it.id]: { ...ed, ...patch } }));
                        return (<span className="inbox-editrow">
                          <input className="inbox-edit" value={ed.name} placeholder="名字" title="改名字后采纳" onChange={(e) => set({ name: e.target.value })} />
                          <input className="inbox-edit" value={ed.title} placeholder="职务" title="改职务后采纳" onChange={(e) => set({ title: e.target.value })} />
                        </span>);
                      })()}
                      {it.kind === 'rel' && (() => {
                        const ed = relEdits[it.id] ?? { layer: it.data.layer, label: it.data.label };
                        const set = (patch: Partial<typeof ed>) => setRelEdits((o) => ({ ...o, [it.id]: { ...ed, ...patch } }));
                        return (<span className="inbox-editrow">
                          <select className="inbox-override" value={ed.layer} title="改层级后采纳" onChange={(e) => set({ layer: e.target.value })}>
                            {(['L1', 'L2', 'L3', 'L4'] as const).map((l) => <option key={l} value={l}>{l}</option>)}
                          </select>
                          <input className="inbox-edit" value={ed.label} placeholder="关系标签" title="改标签后采纳" onChange={(e) => set({ label: e.target.value })} />
                        </span>);
                      })()}
                      {it.kind === 'reminder' ? (
                        <button className="btn ghost sm" onClick={() => onDismissReminder(it.id)} title="忽略这条提醒（不影响业务数据）">忽略</button>
                      ) : it.kind === 'evidence' ? (<>
                        <button className="btn primary sm" title="批准：这条信号属实，计入引擎证据池" onClick={() => onReviewEvidence(it.id, 'approve', evDirs[it.id])}>批准</button>
                        <button className="btn ghost sm" title="拒绝：信号不实，不参与任何计算" onClick={() => onReviewEvidence(it.id, 'reject')}>拒绝</button>
                      </>) : (<>
                        <button className="btn primary sm" onClick={() => (it.kind === 'person' ? onAcceptPerson(it.id, personEdits[it.id]) : it.kind === 'rel' ? onAccept(it.id, relEdits[it.id]) : onAcceptProposal(it.id, overrides[it.id]))}>采纳</button>
                        <button className="btn ghost sm" onClick={() => (it.kind === 'person' ? onRejectPerson(it.id) : it.kind === 'rel' ? onReject(it.id) : onRejectProposal(it.id))}>忽略</button>
                      </>)}
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
