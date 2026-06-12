// 策略引擎局势栏（E0 收起态）—— 沙盘顶部，module-top 之下、策略泳道之上。
// 界面零德扑词（术语全走 adapter 的 G64111 文案）；EV 为主数字、赢面小字永不裸出。
// 展开态（方案包对比）在 E1 落地，本期「推演方案」按钮预留禁用。
import { useMemo } from 'react';
import type { Account, Opportunity } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import { analyzeDeal } from '../lib/pde';

export function EngineBar({ account, opp, breakdown }: { account: Account; opp: Opportunity; breakdown: ScoreBreakdown }) {
  const r = useMemo(() => analyzeDeal(account, opp, breakdown), [account, opp, breakdown]);
  const ev = r.ev != null ? Math.round(r.ev) : null;
  const pWinPct = Math.round(r.pWin * 100);
  // 还需投入未估时 EV 是乐观上界，诚实标注（防伪精确；录入口在 E1）
  const costSet = typeof opp.meta?.plannedCostW === 'number' && (opp.meta.plannedCostW as number) > 0;

  return (
    <div className={`eng-bar tone-${r.stanceTone}`}>
      <div className="eng-row">
        <span className="eng-title">⚡ 局势判断</span>
        <span className={`eng-stance tone-${r.stanceTone}`}>{r.stanceLabel}</span>
        {ev != null
          ? <span className="eng-ev">预期回报 {ev > 0 ? '+' : ''}{ev} 万{!costSet && <span className="eng-ev-note"> · 未计投入</span>}</span>
          : <span className="eng-ev eng-ev-unset">设预计金额后显示预期回报</span>}
        <span className="eng-sub">赢面参考 {pWinPct}% · {r.confidenceText} · 仅供内部决策</span>
        <button className="eng-expand" disabled title="方案包推演（E1）即将上线">推演方案 ⌄</button>
      </div>
      <p className="eng-read">解读：{r.jointReading}。<span className="eng-why">依据：{r.reasonText}。</span></p>
    </div>
  );
}
