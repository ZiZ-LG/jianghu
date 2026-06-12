// 策略引擎局势栏 —— 沙盘顶部，module-top 之下、策略泳道之上。
// 收起态(E0)：姿态判断 + 预期回报 + 赢面小字。展开态(E1)：方案包对比，勾选混选 → 采纳落库。
// 界面零德扑词（术语走 adapter 的 G64111 文案）；EV 主数字、赢面小字永不裸出（防伪精确）。
import { useMemo, useState } from 'react';
import type { Account, Opportunity } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import { ITEM_LABEL, type ItemKey } from '../lib/g64111';
import { analyzeDeal, buildPlaybooks } from '../lib/pde';
import { newStrategyCard, newPlanAction, type Action } from '../store';

const p2 = (n: number) => String(n).padStart(2, '0');
const addDaysYmd = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const COST_LABEL = { low: '投入低', mid: '投入中', high: '投入高' } as const;
const gapName = (g: string) => (g && ITEM_LABEL[g as ItemKey]) || g;

export function EngineBar({ account, opp, breakdown, dispatch }: {
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown; dispatch: (a: Action) => void;
}) {
  const r = useMemo(() => analyzeDeal(account, opp, breakdown), [account, opp, breakdown]);
  const playbooks = useMemo(() => buildPlaybooks(account, opp, breakdown, r), [account, opp, breakdown, r]);
  const [open, setOpen] = useState(false);
  // 选中项：card→`${pi}:c:${ci}`，action→`${pi}:a:${ai}`；展开时默认全选
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const ev = r.ev != null ? Math.round(r.ev) : null;
  const pWinPct = Math.round(r.pWin * 100);
  const costSet = typeof opp.meta?.plannedCostW === 'number' && (opp.meta.plannedCostW as number) > 0;

  const expand = () => {
    const all = new Set<string>();
    playbooks.forEach((pb, pi) => {
      pb.cards.forEach((_, ci) => all.add(`${pi}:c:${ci}`));
      pb.actions.forEach((_, ai) => all.add(`${pi}:a:${ai}`));
    });
    setPicked(all);
    setOpen(true);
  };
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const adopt = () => {
    const baseOrder = (account.strategyCards ?? []).filter((c) => c.opportunityId === opp.id).length;
    let ord = baseOrder;
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
    setOpen(false);
  };

  return (
    <div className={`eng-bar tone-${r.stanceTone}${open ? ' open' : ''}`}>
      <div className="eng-row">
        <span className="eng-title">⚡ 局势判断</span>
        <span className={`eng-stance tone-${r.stanceTone}`}>{r.stanceLabel}</span>
        {ev != null
          ? <span className="eng-ev">预期回报 {ev > 0 ? '+' : ''}{ev} 万{!costSet && <span className="eng-ev-note"> · 未计投入</span>}</span>
          : <span className="eng-ev eng-ev-unset">设预计金额后显示预期回报</span>}
        <span className="eng-sub">赢面参考 {pWinPct}% · {r.confidenceText} · 仅供内部决策</span>
        <button className="eng-expand" disabled={!playbooks.length} onClick={() => (open ? setOpen(false) : expand())}>
          {playbooks.length ? (open ? '收起 ⌃' : '推演方案 ⌄') : '暂无可推演方案'}
        </button>
      </div>
      <p className="eng-read">解读：{r.jointReading}。<span className="eng-why">依据：{r.reasonText}。</span></p>

      {open && (
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
                      <span>🎯 {a.title}<i className={`eng-kind ${a.kind}`}>{a.kind === 'gain' ? '提分' : '补清'}</i></span>
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
