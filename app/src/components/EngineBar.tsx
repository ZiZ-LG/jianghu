// 策略引擎局势栏 —— 沙盘顶部，module-top 之下、策略泳道之上。
// E0 收起态：姿态判断 + 预期回报 + 赢面小字。E1 方案包：勾选混选 → 采纳落库。
// E2 证据闭环：录证据 → 分布演化 → 背离时生成支持度变更提案（人审采纳才改 OppRole，守铁律②）。
// 界面零德扑词（术语走 adapter）；EV 主数字、赢面小字永不裸出（防伪精确）。
import { useMemo, useState } from 'react';
import type { Account, Opportunity, Person, Sentiment } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import { ITEM_LABEL, type ItemKey } from '../lib/g64111';
import { analyzeDeal, buildPlaybooks, SIGNAL_CATALOG, SIGNAL_BY_KEY } from '../lib/pde';
import { newStrategyCard, newPlanAction, newEvidence, type Action } from '../store';

const p2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDaysYmd = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const COST_LABEL = { low: '投入低', mid: '投入中', high: '投入高' } as const;
const TIER_LABEL = { weak: '弱', mid: '中', strong: '强' } as const;
const SENT_TEXT: Record<Sentiment, string> = { star: '排他支持', plus: '支持', neutral: '中立', unknown: '未知', minus: '抗拒', x: '倒向对手' };
const gapName = (g: string) => (g && ITEM_LABEL[g as ItemKey]) || g;

export function EngineBar({ account, opp, breakdown, dispatch }: {
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown; dispatch: (a: Action) => void;
}) {
  const r = useMemo(() => analyzeDeal(account, opp, breakdown), [account, opp, breakdown]);
  const playbooks = useMemo(() => buildPlaybooks(account, opp, breakdown, r), [account, opp, breakdown, r]);
  const [open, setOpen] = useState<null | 'playbooks' | 'evidence'>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set()); // 忽略的背离提案 personId
  const [ev, setEv] = useState({ personId: '', signalKey: SIGNAL_CATALOG[0].key, direction: 0, tier: 'mid' as 'weak' | 'mid' | 'strong', raw: '' });

  const ev2 = r.ev != null ? Math.round(r.ev) : null;
  const pWinPct = Math.round(r.pWin * 100);
  const costSet = typeof opp.meta?.plannedCostW === 'number' && (opp.meta.plannedCostW as number) > 0;
  const nameById = useMemo(() => new Map(account.persons.map((p) => [p.id, p.name])), [account.persons]);
  const ratable = useMemo(() => opp.roles
    .map((x) => account.persons.find((p) => p.id === x.personId))
    .filter((p): p is Person => !!p && !p.isCompetitor), [opp.roles, account.persons]);
  const shifts = r.stanceShifts.filter((s) => !dismissed.has(s.personId));
  const events = [...(opp.evidenceEvents ?? [])].reverse();
  const curSignal = SIGNAL_BY_KEY.get(ev.signalKey);
  const needDir = curSignal?.direction === 0;

  const expand = () => {
    const all = new Set<string>();
    playbooks.forEach((pb, pi) => { pb.cards.forEach((_, ci) => all.add(`${pi}:c:${ci}`)); pb.actions.forEach((_, ai) => all.add(`${pi}:a:${ai}`)); });
    setPicked(all); setOpen('playbooks');
  };
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const adopt = () => {
    let ord = (account.strategyCards ?? []).filter((c) => c.opportunityId === opp.id).length;
    playbooks.forEach((pb, pi) => {
      pb.cards.forEach((c, ci) => {
        if (!picked.has(`${pi}:c:${ci}`)) return;
        const card = newStrategyCard(account.id, opp.id, c.gapItem);
        card.title = c.title; card.basis = c.basis; card.origin = 'ai'; card.orderIndex = ord++;
        if (c.personId) card.personId = c.personId;
        dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
      });
      pb.actions.forEach((a, ai) => {
        if (!picked.has(`${pi}:a:${ai}`)) return;
        const d0 = addDaysYmd(a.offsetDays);
        const pa = newPlanAction(account.id, opp.id, d0, d0, 'am');
        pa.title = a.title; pa.gapItem = a.gapItem; pa.origin = 'ai';
        if (a.personId) pa.personId = a.personId;
        if (a.scene) pa.scene = a.scene;
        dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
      });
    });
    setOpen(null);
  };

  const recordEvidence = () => {
    if (!ev.personId) return;
    const dir = curSignal && curSignal.direction !== 0 ? curSignal.direction : ev.direction;
    if (!dir) return; // 中性信号必须人工定向
    const e = newEvidence(account.id, opp.id, ev.personId, ev.signalKey, dir, ev.tier);
    e.rawContent = ev.raw; e.occurredAt = ymd(new Date());
    dispatch({ type: 'ADD_EVIDENCE', accId: account.id, oppId: opp.id, evidence: e });
    setEv({ ...ev, raw: '' });
  };
  const acceptShift = (personId: string, to: Sentiment) => {
    dispatch({ type: 'SET_ROLE', accId: account.id, oppId: opp.id, personId, patch: { sentiment: to } });
    setDismissed((s) => new Set(s).add(personId));
  };

  return (
    <div className={`eng-bar tone-${r.stanceTone}${open ? ' open' : ''}`}>
      <div className="eng-row">
        <span className="eng-title">⚡ 局势判断</span>
        <span className={`eng-stance tone-${r.stanceTone}`}>{r.stanceLabel}</span>
        {ev2 != null
          ? <span className="eng-ev">预期回报 {ev2 > 0 ? '+' : ''}{ev2} 万{!costSet && <span className="eng-ev-note"> · 未计投入</span>}</span>
          : <span className="eng-ev eng-ev-unset">设预计金额后显示预期回报</span>}
        <span className="eng-sub">赢面参考 {pWinPct}% · {r.confidenceText} · 仅供内部决策</span>
        <button className="eng-expand" onClick={() => setOpen(open === 'evidence' ? null : 'evidence')}>
          📍 录证据{events.length ? ` (${events.length})` : ''}
        </button>
        <button className="eng-expand" disabled={!playbooks.length} onClick={() => (open === 'playbooks' ? setOpen(null) : expand())}>
          {playbooks.length ? (open === 'playbooks' ? '收起 ⌃' : '推演方案 ⌄') : '暂无可推演方案'}
        </button>
      </div>
      <p className="eng-read">解读：{r.jointReading}。<span className="eng-why">依据：{r.reasonText}。</span></p>

      {/* 证据驱动的支持度变更提案（背离时；人审采纳才改 OppRole） */}
      {shifts.map((sh) => (
        <div className="eng-shift" key={sh.personId}>
          <span className="eng-shift-icon">🔔</span>
          <span className="eng-shift-text">
            <b>{sh.name}</b>：{sh.reason}——建议把支持度从「{SENT_TEXT[sh.fromSentiment]}」改为「{SENT_TEXT[sh.toSentiment]}」
          </span>
          <button className="btn primary xs" onClick={() => acceptShift(sh.personId, sh.toSentiment)}>采纳改分</button>
          <button className="btn ghost xs" onClick={() => setDismissed((s) => new Set(s).add(sh.personId))}>忽略</button>
        </div>
      ))}

      {open === 'evidence' && (
        <div className="eng-evidence">
          <div className="eng-ev-form">
            <select value={ev.personId} onChange={(e) => setEv({ ...ev, personId: e.target.value })}>
              <option value="">选干系人…</option>
              {ratable.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
            </select>
            <select value={ev.signalKey} onChange={(e) => setEv({ ...ev, signalKey: e.target.value })}>
              {SIGNAL_CATALOG.map((s) => <option key={s.key} value={s.key}>{s.label}{s.behavioral ? '' : '（言语）'}</option>)}
            </select>
            {needDir && (
              <select value={ev.direction} onChange={(e) => setEv({ ...ev, direction: Number(e.target.value) })}>
                <option value={0}>定向…</option><option value={1}>利好</option><option value={-1}>不利</option>
              </select>
            )}
            <select value={ev.tier} onChange={(e) => setEv({ ...ev, tier: e.target.value as 'weak' | 'mid' | 'strong' })}>
              <option value="weak">弱</option><option value="mid">中</option><option value="strong">强</option>
            </select>
            <input value={ev.raw} onChange={(e) => setEv({ ...ev, raw: e.target.value })} placeholder="原文/纪要片段（可选，可追溯）" />
            <button className="btn primary sm" disabled={!ev.personId || (needDir && !ev.direction)} onClick={recordEvidence}>录入</button>
          </div>
          <p className="eng-ev-hint">行为信号比口头表态权重更高；录入即生效、更新局势分布。证据偏离当前支持度时会自动提示改分。</p>
          {events.length > 0 && (
            <div className="eng-ev-list">
              {events.map((e) => {
                const sig = SIGNAL_BY_KEY.get(e.signalKey);
                return (
                  <div className="eng-ev-item" key={e.id}>
                    <span className={`eng-ev-dir ${e.direction > 0 ? 'up' : 'down'}`}>{e.direction > 0 ? '利好' : '不利'}</span>
                    <span className="eng-ev-sig">{sig?.label ?? e.signalKey}</span>
                    <span className="eng-ev-who">{nameById.get(e.personId) ?? '?'}</span>
                    <span className="eng-ev-tier">{TIER_LABEL[e.tier]}</span>
                    {e.rawContent && <span className="eng-ev-raw" title={e.rawContent}>“{e.rawContent}”</span>}
                    <button className="eng-ev-del" title="撤销该证据" onClick={() => dispatch({ type: 'DELETE_EVIDENCE', accId: account.id, oppId: opp.id, evidenceId: e.id })}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {open === 'playbooks' && (
        <div className="eng-playbooks">
          <div className="eng-pb-grid">
            {playbooks.map((pb, pi) => (
              <div key={pb.key} className={`eng-pb tone-${pb.tone}`}>
                <div className="eng-pb-head">
                  <span className="eng-pb-title">{pb.title}</span>
                  <span className="eng-pb-cost">{COST_LABEL[pb.costTier]}</span>
                </div>
                <p className="eng-pb-why">{pb.rationale}</p>
                <div className="eng-pb-items">
                  {pb.cards.map((c, ci) => (
                    <label key={`c${ci}`} className="eng-pick">
                      <input type="checkbox" checked={picked.has(`${pi}:c:${ci}`)} onChange={() => toggle(`${pi}:c:${ci}`)} />
                      <span>♟ {c.title}{c.gapItem && <i className="eng-tag">{gapName(c.gapItem)}</i>}</span>
                    </label>
                  ))}
                  {pb.actions.map((a, ai) => (
                    <label key={`a${ai}`} className="eng-pick">
                      <input type="checkbox" checked={picked.has(`${pi}:a:${ai}`)} onChange={() => toggle(`${pi}:a:${ai}`)} />
                      <span>🎯 {a.title}{a.gapItem && <i className="eng-gapcode">{a.gapItem}</i>}<i className={`eng-kind ${a.kind}`}>{a.kind === 'gain' ? '提分' : '补清'}</i></span>
                    </label>
                  ))}
                </div>
                <div className="eng-pb-foot">
                  {pb.clarityUp ? <span className="eng-pb-up clarity">预期把握度 ↑</span> : <span className="eng-pb-up">预期趋赢力 +{pb.expectedWinTendency}</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="eng-pb-bar">
            <span className="eng-pb-hint">可跨方案勾选 · 采纳后均可在沙盘/行动计划再编辑</span>
            <button className="btn primary sm" disabled={picked.size === 0} onClick={adopt}>采纳所选 {picked.size} 项 → 上沙盘与行动计划</button>
          </div>
        </div>
      )}
    </div>
  );
}
