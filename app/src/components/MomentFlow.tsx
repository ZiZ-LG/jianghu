// 场景 A · 手机竖屏「时刻流」（屏效三场景架构）：今日一屏 → 拜访卡 → 速审流。
// 只消费与回填，不编辑不画图；深度工作在桌面作战室（进商机后仍提示横屏）。
// 设计稿：docs/原型-三场景核心界面-设计稿.html（A1/A2/A3）。每屏 ≤7 信息元素、一屏一决策。
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Account, PlanAction } from '../types';
import { SENTIMENT_LABEL, ROLE_LABEL } from '../types';
import type { InboxPerson, InboxProposal, InboxRel, InboxReminder } from '../api';
import { previewProposalImpact } from '../lib/impact';
import { ACT_LABEL } from '../lib/pdeUi';

type Page = { kind: 'home' } | { kind: 'visit'; accId: string; oppId: string; personId: string } | { kind: 'review' };

interface Props {
  accounts: Account[];
  inbox: { rels: InboxRel[]; persons: InboxPerson[]; proposals: InboxProposal[]; reminders: InboxReminder[]; total: number };
  userName: string;
  theme: string;
  onToggleTheme: () => void;
  onOpenIntel: () => void;
  onEnterAccount: (accId: string, oppId: string | null) => void;
  onExitToDesktop: () => void;
  onLogout: () => void;
  onAcceptProposal: (id: string) => void; onRejectProposal: (id: string) => void;
  onAcceptPerson: (id: string) => void; onRejectPerson: (id: string) => void;
  onAcceptRel: (id: string) => void; onRejectRel: (id: string) => void;
  onDismissReminder: (id: string) => void;
  readonly?: boolean; // viewer 只读投影：口述/拍板入口不渲染，浏览与拜访卡保留
}

const today = () => new Date().toISOString().slice(0, 10);

export function MomentFlow(p: Props) {
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [menuOpen, setMenuOpen] = useState(false);
  // 活跃商机（前 3）→ 四动作徽章（引擎不可用时静默无徽章，不阻塞首页）
  const opps = useMemo(() => p.accounts.flatMap((a) => a.opportunities.filter((o) => (o as any).status !== 'won' && (o as any).status !== 'lost').map((o) => ({ accId: a.id, accName: a.name, oppId: o.id, name: o.name }))).slice(0, 3), [p.accounts]);
  const [evs, setEvs] = useState<Record<string, any>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, any> = {};
      await Promise.all(opps.map(async (o) => { try { out[o.oppId] = await api.pdeEv(o.oppId); } catch { /* 引擎不可用→无徽章 */ } }));
      if (alive) setEvs(out);
    })();
    return () => { alive = false; };
  }, [opps]);

  // 今日行动（跨客户）：startDate ≤ 今天 ≤ endDate 且未完成
  const todays = useMemo(() => {
    const t = today();
    const out: Array<PlanAction & { accId: string; personName?: string }> = [];
    for (const a of p.accounts) for (const pa of a.planActions ?? []) {
      if (pa.done || !pa.startDate) continue;
      if (pa.startDate <= t && t <= (pa.endDate || pa.startDate)) {
        out.push({ ...pa, accId: a.id, personName: a.persons.find((x) => x.id === pa.personId)?.name });
      }
    }
    return out.slice(0, 5);
  }, [p.accounts]);

  // 待拍板 top（提案按 |趋赢力Δ| 降序，与收件箱同口径）
  const topProposal = useMemo(() => {
    const scored = p.inbox.proposals.map((cp) => {
      const acc = p.accounts.find((a) => a.id === cp.accountId);
      const opp = acc?.opportunities.find((o) => o.id === cp.opportunityId);
      const imp = acc ? previewProposalImpact(acc, opp, { entityKind: cp.entityKind, entityId: cp.entityId, field: cp.field, newValue: cp.newValue }) : null;
      return { cp, delta: imp ? Math.abs(imp.after - imp.before) : 0, imp };
    }).sort((a, b) => b.delta - a.delta);
    return scored[0] ?? null;
  }, [p.inbox.proposals, p.accounts]);

  if (page.kind === 'visit') return <VisitCard {...p} accId={page.accId} oppId={page.oppId} personId={page.personId} onBack={() => setPage({ kind: 'home' })} />;
  if (page.kind === 'review') return <QuickReview {...p} onBack={() => setPage({ kind: 'home' })} />;

  const d = new Date();
  return (
    <div className="mf">
      <div className="mf-head">
        <div>
          <div className="mf-date">{d.getMonth() + 1}月{d.getDate()}日 · {'日一二三四五六'[d.getDay()]}</div>
          <div className="mf-hello">早上好，{p.userName}</div>
        </div>
        <button className="mf-gear" onClick={() => setMenuOpen((v) => !v)}>⚙️</button>
      </div>
      {menuOpen && (
        <div className="mf-menu">
          <button onClick={() => { p.onToggleTheme(); setMenuOpen(false); }}>{p.theme === 'dark' ? '☀️ 白天模式' : '🌙 夜间模式'}</button>
          <button onClick={p.onExitToDesktop}>🖥️ 切到完整版</button>
          <button onClick={p.onLogout}>🚪 退出登录</button>
        </div>
      )}
      {!p.readonly && <div className="mf-heartbeat">⚙️ 引擎监测中{p.inbox.total > 0 ? ` · 待你拍板 ${p.inbox.total} 条` : ' · 一切正常'}</div>}

      {opps.length > 0 && (
        <div className="mf-opps">
          {opps.map((o) => {
            const ev = evs[o.oppId];
            const act = ev ? ACT_LABEL[ev.recommendation?.action] : null;
            return (
              <button key={o.oppId} className={`mf-opp${act ? ` mf-opp-${act.cls}` : ''}`} onClick={() => p.onEnterAccount(o.accId, o.oppId)}>
                <div className="mf-opp-name">{o.name}</div>
                <div className="mf-opp-row">
                  {act ? <span className={`mf-act mf-act-${act.cls}`}>{act.icon} {act.text}</span> : <span className="mf-act">…</span>}
                  {ev && <b>{Math.round(ev.pwin * 100)}%</b>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="mf-sec">📅 今日行动{todays.length ? ` · ${todays.length}` : ''}</div>
      {todays.length === 0 && <div className="mf-empty">今天没有排定的行动。{!p.readonly && '🎙️ 说点什么，或进作战室排一手。'}</div>}
      {todays.map((t) => (
        <button key={t.id} className="mf-card" onClick={() => t.personId && setPage({ kind: 'visit', accId: t.accId, oppId: t.opportunityId, personId: t.personId })}>
          <div className="mf-card-t">{t.title}{t.personName ? ` · ${t.personName}` : ''}</div>
          <div className="mf-card-s">{t.personId ? '❓ 拜访卡已备好 ›' : '（未指定对象）'}</div>
        </button>
      ))}

      {!p.readonly && (<>
      <div className="mf-sec">📥 待你拍板 · {p.inbox.total}</div>
      {p.inbox.total === 0 ? <div className="mf-empty">暂无待审。</div> : (
        <button className="mf-card mf-card-warn" onClick={() => setPage({ kind: 'review' })}>
          <div className="mf-card-t">
            {topProposal ? `${topProposal.cp.entityName || '干系人'}：${topProposal.cp.field === 'sentiment' ? '支持度' : topProposal.cp.field}变更提案` : `${p.inbox.total} 条候选待处理`}
          </div>
          <div className="mf-card-s">{topProposal?.imp ? `趋赢力 ${topProposal.imp.before}% → ${topProposal.imp.after}% · ` : ''}逐条拍板 ›</div>
        </button>
      )}
      </>)}

      <div className="mf-spacer" />
      {!p.readonly && <button className="mf-cta" onClick={p.onOpenIntel}>🎙️ 说点什么</button>}
    </div>
  );
}

// ── 拜访卡（A2）：他是谁 + 情报新鲜度 + 这次问什么（VoI 引擎）──
function VisitCard(p: Props & { accId: string; oppId: string; personId: string; onBack: () => void }) {
  const acc = p.accounts.find((a) => a.id === p.accId);
  const opp = acc?.opportunities.find((o) => o.id === p.oppId);
  const person = acc?.persons.find((x) => x.id === p.personId);
  const role = opp?.roles.find((r) => r.personId === p.personId);
  const [intel, setIntel] = useState<any>(null);
  const [ev, setEv] = useState<any>(null);
  useEffect(() => {
    api.pdeIntel(p.oppId).then(setIntel).catch(() => setIntel({ items: [] }));
    api.pdeEv(p.oppId).then(setEv).catch(() => {});
  }, [p.oppId]);

  const mine = (intel?.items ?? []).filter((i: any) => i.kind === 'stance' && i.stakeholderId === p.personId);
  const global = (intel?.items ?? []).filter((i: any) => i.kind !== 'stance' || i.stakeholderId !== p.personId).slice(0, 2);
  const questions = [...mine, ...global].slice(0, 3);
  const detail = ev?.stakeholders?.find((s: any) => s.id === p.personId);
  const thin = detail && detail.n_eff < 3;

  return (
    <div className="mf">
      <div className="mf-head"><button className="mf-back" onClick={p.onBack}>‹ 今日</button><span className="mf-date">拜访前</span></div>
      <div className="mf-vhead">
        <div className="mf-avatar">{(person?.name ?? '?').slice(0, 1)}</div>
        <div>
          <div className="mf-vname">{person?.name ?? '未知'} {role && <span className="mf-vrole">{role.role} · {ROLE_LABEL[role.role]}</span>}</div>
          <div className="mf-card-s">{person?.title || ''}{opp ? ` · ${opp.name}` : ''}</div>
        </div>
      </div>
      {role && (
        <div className={`mf-stance${thin ? ' mf-stance-warn' : ''}`}>
          支持度：{SENTIMENT_LABEL[role.sentiment]}（{role.confidence}）
          {thin && <span className="mf-warn"> ⚠️ 情报不扎实，先摸底</span>}
        </div>
      )}
      <div className="mf-sec">❓ 这次问什么（按情报价值排序）</div>
      {intel === null && <div className="mf-empty">引擎推演中…</div>}
      {intel !== null && questions.length === 0 && <div className="mf-empty">该商机情报已扎实——直接推进正事。</div>}
      {questions.map((q: any, i: number) => (
        <div key={i} className="mf-q">
          <div className="mf-q-row"><span>{i + 1}. {q.question}</span>{q.voi != null && <b className="mf-price">≈值 {Math.round(q.voi)} 万</b>}</div>
          {(q.infoActions ?? []).slice(0, 1).map((a: any, j: number) => (
            <div key={j} className="mf-q-gist">💡 {a.title}：{a.gist}</div>
          ))}
        </div>
      ))}
      <div className="mf-spacer" />
      {!p.readonly && <div className="mf-hint">拜访结束后 → 🎙️ 说两句，我来记</div>}
      {!p.readonly && <button className="mf-cta" onClick={p.onOpenIntel}>🎙️ 说点什么</button>}
    </div>
  );
}

// ── 速审流（A3）：一次一卡、按影响降序、5 秒一条 ──
function QuickReview(p: Props & { onBack: () => void }) {
  // 进入时快照队列（提案按 |Δ| 降序 → 人物 → 关系 → 提醒），处理过的本地跳过，避免列表刷新跳动
  const [queue] = useState(() => {
    const props = p.inbox.proposals.map((cp) => {
      const acc = p.accounts.find((a) => a.id === cp.accountId);
      const opp = acc?.opportunities.find((o) => o.id === cp.opportunityId);
      const imp = acc ? previewProposalImpact(acc, opp, { entityKind: cp.entityKind, entityId: cp.entityId, field: cp.field, newValue: cp.newValue }) : null;
      return { kind: 'proposal' as const, id: cp.id, cp, imp, delta: imp ? Math.abs(imp.after - imp.before) : 0 };
    }).sort((a, b) => b.delta - a.delta);
    return [
      ...props,
      ...p.inbox.persons.map((x) => ({ kind: 'person' as const, id: x.id, x })),
      ...p.inbox.rels.map((x) => ({ kind: 'rel' as const, id: x.id, x })),
      ...p.inbox.reminders.map((x) => ({ kind: 'reminder' as const, id: x.id, x })),
    ] as any[];
  });
  const [idx, setIdx] = useState(0);
  const cur = queue[idx];
  const next = () => setIdx((i) => i + 1);
  const act = (accept: boolean) => {
    if (!cur) return;
    if (cur.kind === 'proposal') accept ? p.onAcceptProposal(cur.id) : p.onRejectProposal(cur.id);
    else if (cur.kind === 'person') accept ? p.onAcceptPerson(cur.id) : p.onRejectPerson(cur.id);
    else if (cur.kind === 'rel') accept ? p.onAcceptRel(cur.id) : p.onRejectRel(cur.id);
    else p.onDismissReminder(cur.id);
    next();
  };

  return (
    <div className="mf">
      <div className="mf-head"><button className="mf-back" onClick={p.onBack}>‹ 今日</button><span className="mf-date">待你拍板 {Math.min(idx + 1, queue.length)}/{queue.length}</span></div>
      {!cur ? (
        <>
          <div className="mf-done">✅ 都处理完了</div>
          <button className="mf-cta" onClick={p.onBack}>返回今日</button>
        </>
      ) : (
        <>
          <div className="mf-review">
            {cur.kind === 'proposal' && (<>
              <div className="mf-card-s">✏️ 变更提案 · 来自{cur.cp.origin || 'AI'} · 置信 {(cur.cp.confidence ?? 0.5).toFixed(2)}</div>
              <div className="mf-review-t">{cur.cp.entityName || '干系人'}：{cur.cp.field === 'sentiment' ? '支持度' : cur.cp.field} {cur.cp.oldValue} → <b>{cur.cp.newValue}</b></div>
              {cur.cp.evidence && <div className="mf-evidence">「{cur.cp.evidence}」</div>}
              {cur.imp && <div className="mf-impact">采纳后：趋赢力 {cur.imp.before}% → <b className={cur.imp.after >= cur.imp.before ? 'mf-up' : 'mf-down'}>{cur.imp.after}%</b></div>}
            </>)}
            {cur.kind === 'person' && (<>
              <div className="mf-card-s">👤 人物候选 · 来自{cur.x.origin}</div>
              <div className="mf-review-t">{cur.x.name} <span className="mf-card-s">{cur.x.title}</span></div>
              {cur.x.evidence && <div className="mf-evidence">「{cur.x.evidence}」</div>}
            </>)}
            {cur.kind === 'rel' && (<>
              <div className="mf-card-s">🔗 关系候选 · {cur.x.layer} · 来自{cur.x.origin}</div>
              <div className="mf-review-t">{cur.x.sourceName} — {cur.x.targetName} <span className="mf-card-s">{cur.x.label}</span></div>
              {cur.x.evidence && <div className="mf-evidence">「{cur.x.evidence}」</div>}
            </>)}
            {cur.kind === 'reminder' && (<>
              <div className="mf-card-s">⏰ 引擎提醒</div>
              <div className="mf-review-t">{cur.x.title}</div>
              <div className="mf-evidence">{cur.x.detail}</div>
            </>)}
          </div>
          <div className="mf-btns">
            {cur.kind === 'reminder' ? (
              <><button className="mf-btn" onClick={next}>稍后</button><button className="mf-btn mf-btn-ok" onClick={() => act(false)}>知道了</button></>
            ) : (
              <><button className="mf-btn" onClick={() => act(false)}>✗ 驳回</button><button className="mf-btn mf-btn-ok" onClick={() => act(true)}>✓ 采纳</button></>
            )}
          </div>
        </>
      )}
    </div>
  );
}
