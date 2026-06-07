// 策略沙盘 · 推演工作台（关系地图 → 沙盘 → 行动策划 的中间「桥」）。
// 结构化三栏：现状(只读引 G64111 + 风险/弹药) → 方向(策略卡，挂靠低分项，可送行动策划) → 终局(目标/截止日 + 倒推里程碑 + 就绪度)。
// P0：手工 CRUD + 就绪度。P1：策略卡→送行动策划(生成 PlanAction 落 DealPlanner)、倒推里程碑(共享 OppMilestone)、风险/弹药 CRUD。
import type { Account, Opportunity, StrategyCard } from '../types';
import { SENTIMENT_CHAR, SENTIMENT_COLOR, ROLE_LABEL } from '../types';
import type { Action } from '../store';
import { newStrategyCard, newStrategyRisk, newStrategyResource, newPlanAction, newMilestone } from '../store';
import type { ScoreBreakdown, ItemKey, Band741 } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL, BAND_STRATEGY } from '../lib/g64111';
import { ViewTabs, type CustomerView } from './ViewTabs';

// 741 四档语义色（同 types.ts ROLE_COLOR/SENTIMENT_COLOR 的硬编码语义色惯例）
const BAND_TONE: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '#16a34a',
  RELATIVE_ADVANTAGE: '#2563eb',
  RELATIVE_DISADVANTAGE: '#f59e0b',
  ABSOLUTE_DISADVANTAGE: '#dc2626',
};
const GROUPS = ['6必清', '4优势', '1决胜'] as const;
const p2 = (n: number) => String(n).padStart(2, '0');
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

export function StrategySandbox({
  account, opp, breakdown, dispatch, view, onChangeView, onOpenConsole,
}: {
  account: Account;
  opp: Opportunity;
  breakdown: ScoreBreakdown;
  dispatch: (a: Action) => void;
  view: CustomerView;
  onChangeView: (v: CustomerView) => void;
  onOpenConsole: () => void;
}) {
  const itemKeys = Object.keys(ITEM_MAX) as ItemKey[];
  const personById = new Map(account.persons.map((p) => [p.id, p]));

  // 缺口：低于满分的项，按缺口降序
  const gaps = itemKeys
    .map((k) => ({ key: k, score: breakdown.items[k], max: ITEM_MAX[k], deficit: ITEM_MAX[k] - breakdown.items[k] }))
    .filter((g) => g.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  // 关键干系人格局：A / D / 关键影响人
  const keyPlayers = opp.roles
    .filter((r) => r.role === 'A' || r.role === 'D' || r.isKeyInfluencer)
    .map((r) => ({ role: r.role, sentiment: r.sentiment, isKey: !!r.isKeyInfluencer, person: personById.get(r.personId) }))
    .filter((x) => x.person);

  // 本商机的策略卡 / 风险 / 弹药 / 里程碑
  const cards = (account.strategyCards ?? [])
    .filter((c) => c.opportunityId === opp.id && c.status !== 'dismissed')
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const risks = (account.strategyRisks ?? []).filter((r) => r.opportunityId === opp.id && r.status !== 'dismissed');
  const resources = (account.strategyResources ?? []).filter((x) => x.opportunityId === opp.id);
  const milestones = (account.milestones ?? []).filter((m) => m.opportunityId === opp.id);

  // 就绪度：缺口被策略卡 gapItem 命中的覆盖率
  const coveredGaps = new Set(cards.map((c) => c.gapItem).filter(Boolean));
  const coveredCount = gaps.filter((g) => coveredGaps.has(g.key)).length;
  const coverage = gaps.length ? Math.round((coveredCount / gaps.length) * 100) : 100;

  const pct = Math.round(breakdown.percent * 100);
  const tone = BAND_TONE[breakdown.band];

  // ── 策略卡 ──
  const addCard = (gapItem = '') => {
    const card = newStrategyCard(account.id, opp.id, gapItem);
    card.orderIndex = cards.length;
    dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
  };
  const updateCard = (cardId: string, patch: Partial<StrategyCard>) =>
    dispatch({ type: 'UPDATE_STRATEGY_CARD', accId: account.id, cardId, patch });
  const deleteCard = (cardId: string) => dispatch({ type: 'DELETE_STRATEGY_CARD', accId: account.id, cardId });

  // ── 派发：策略卡 → 行动策划（生成 PlanAction 快照，落 DealPlanner 时间轴）──
  const dispatchToPlanner = (card: StrategyCard) => {
    const d0 = todayYmd();
    const pa = newPlanAction(account.id, opp.id, d0, d0, 'am');
    pa.title = card.title;
    pa.gapItem = card.gapItem || '';
    if (card.personId) pa.personId = card.personId;
    if (card.basis) pa.scene = card.basis;
    pa.origin = 'ai';
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    updateCard(card.id, { dispatchedActionIds: [...(card.dispatchedActionIds ?? []), pa.id] });
  };

  // ── 终局 + 里程碑（里程碑 = DealPlanner OppMilestone，直接共享）──
  const updateGoal = (patch: Partial<Opportunity>) => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch });
  const addMilestone = () => {
    const ms = newMilestone(account.id, opp.id, opp.expectedSignDate || todayYmd(), 'am');
    dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: opp.id, milestone: ms });
  };
  const updateMilestone = (milestoneId: string, patch: { title?: string; startDate?: string; endDate?: string }) =>
    dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId, patch });
  const deleteMilestone = (milestoneId: string) => dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId });

  // ── 风险 / 假设 ──
  const addRisk = (kind: 'risk' | 'assumption') => dispatch({ type: 'ADD_STRATEGY_RISK', accId: account.id, oppId: opp.id, risk: newStrategyRisk(account.id, opp.id, kind) });
  const updateRisk = (riskId: string, patch: { text?: string; severity?: 'low' | 'mid' | 'high' }) =>
    dispatch({ type: 'UPDATE_STRATEGY_RISK', accId: account.id, riskId, patch });
  const deleteRisk = (riskId: string) => dispatch({ type: 'DELETE_STRATEGY_RISK', accId: account.id, riskId });

  // ── 弹药清单 ──
  const addResource = () => dispatch({ type: 'ADD_STRATEGY_RESOURCE', accId: account.id, oppId: opp.id, resource: newStrategyResource(account.id, opp.id) });
  const updateResource = (resourceId: string, patch: { label?: string; kind?: string }) =>
    dispatch({ type: 'UPDATE_STRATEGY_RESOURCE', accId: account.id, resourceId, patch });
  const deleteResource = (resourceId: string) => dispatch({ type: 'DELETE_STRATEGY_RESOURCE', accId: account.id, resourceId });

  return (
    <div className="sandbox">
      <div className="sandbox-top">
        <span className="mt-name">{opp.name}</span>
        <ViewTabs view={view} onChange={onChangeView} />
        <span className="sb-band-pill" style={{ color: tone, borderColor: tone }}>● {BAND_LABEL[breakdown.band]} · 趋赢力 {pct}%</span>
        <button className="btn primary xs" onClick={onOpenConsole}>🧠 AI 推演</button>
      </div>

      <div className="sandbox-body">
        {/* ① 现状栏（只读引 G64111 + 风险/弹药盘点） */}
        <section className="sandbox-col sb-now">
          <h3 className="sb-h">现状 · 来自关系地图</h3>
          <div className="sb-band-card" style={{ borderColor: tone }}>
            <div className="sb-band-top"><b style={{ color: tone }}>{BAND_LABEL[breakdown.band]}</b><span className="sb-pct">{pct}%</span></div>
            <div className="sb-band-strat">{BAND_STRATEGY[breakdown.band]}</div>
          </div>

          <h4 className="sb-sub">📉 G64111 缺口<span className="sb-hint-inline">点「＋」挂策略卡</span></h4>
          <div className="sb-gaps">
            {gaps.length === 0 && <div className="sb-empty-s">无明显缺口 · 各项接近满分 🎉</div>}
            {gaps.map((g) => (
              <div className="sb-gap" key={g.key}>
                <span className="sb-gap-label">{ITEM_LABEL[g.key]}</span>
                <span className="sb-gap-score">{g.score}/{g.max}</span>
                {coveredGaps.has(g.key)
                  ? <span className="sb-gap-cov" title="已有策略卡覆盖">✓</span>
                  : <button className="sb-gap-add" title="挂一张策略卡" onClick={() => addCard(g.key)}>＋</button>}
              </div>
            ))}
          </div>

          <h4 className="sb-sub">👥 关键干系人</h4>
          <div className="sb-players">
            {keyPlayers.length === 0 && <div className="sb-empty-s">尚未标记 A/D/关键影响人</div>}
            {keyPlayers.map((x, i) => (
              <div className="sb-player" key={i}>
                <span className="sb-role">{ROLE_LABEL[x.role]}</span>
                <span className="sb-pname">{x.person?.name}</span>
                <span className="sb-sent" style={{ color: SENTIMENT_COLOR[x.sentiment] }}>{SENTIMENT_CHAR[x.sentiment]}</span>
                {x.isKey && <span className="sb-keytag">关键</span>}
              </div>
            ))}
          </div>

          <h4 className="sb-sub">⚠️ 风险 / 假设
            <span className="sb-sub-acts">
              <button className="sb-mini-add" onClick={() => addRisk('risk')}>＋风险</button>
              <button className="sb-mini-add" onClick={() => addRisk('assumption')}>＋假设</button>
            </span>
          </h4>
          <div className="sb-risks">
            {risks.length === 0 && <div className="sb-empty-s">链路上会出事的、或推演依赖的前提</div>}
            {risks.map((r) => (
              <div className={`sb-risk k-${r.kind}`} key={r.id}>
                <div className="sb-risk-head">
                  <span className="sb-risk-kind">{r.kind === 'risk' ? '风险' : '假设'}</span>
                  <select className="sb-sev" value={r.severity || 'mid'} onChange={(e) => updateRisk(r.id, { severity: e.target.value as 'low' | 'mid' | 'high' })}>
                    <option value="low">低</option><option value="mid">中</option><option value="high">高</option>
                  </select>
                  <button className="sb-del" title="删除" onClick={() => deleteRisk(r.id)}>✕</button>
                </div>
                <input className="sb-risk-text" defaultValue={r.text} placeholder={r.kind === 'risk' ? '风险描述' : '依赖的前提假设'}
                  onBlur={(e) => e.target.value !== r.text && updateRisk(r.id, { text: e.target.value })} />
              </div>
            ))}
          </div>

          <h4 className="sb-sub">🎒 弹药清单<span className="sb-sub-acts"><button className="sb-mini-add" onClick={addResource}>＋</button></span></h4>
          <div className="sb-resources">
            {resources.length === 0 && <div className="sb-empty-s">可调用的牌：产品演示 / 标杆案例 / 高层关系 / 商务让步…</div>}
            {resources.map((x) => (
              <div className="sb-res" key={x.id}>
                <input className="sb-res-label" defaultValue={x.label} placeholder="弹药（如：CP3D 信创实测）"
                  onBlur={(e) => e.target.value !== x.label && updateResource(x.id, { label: e.target.value })} />
                <input className="sb-res-kind" defaultValue={x.kind ?? ''} placeholder="类型"
                  onBlur={(e) => e.target.value !== (x.kind ?? '') && updateResource(x.id, { kind: e.target.value })} />
                <button className="sb-del" title="删除" onClick={() => deleteResource(x.id)}>✕</button>
              </div>
            ))}
          </div>
        </section>

        {/* ② 方向栏（策略卡 CRUD + 送行动策划） */}
        <section className="sandbox-col sb-dirs">
          <h3 className="sb-h">方向 · 策略卡 <span className="sb-count">{cards.length}</span></h3>
          <button className="btn ghost sm sb-addcard" onClick={() => addCard()}>＋ 新建策略卡</button>
          <div className="sb-cards">
            {cards.length === 0 && <div className="sb-empty">还没有策略卡。从左侧缺口点「＋」，或「新建策略卡」开始排打法。</div>}
            {cards.map((card) => {
              const dispatched = (card.dispatchedActionIds?.length ?? 0) > 0;
              return (
                <div className="sb-card" key={card.id}>
                  <div className="sb-card-head">
                    <select className="sb-gapsel" value={card.gapItem || ''} onChange={(e) => updateCard(card.id, { gapItem: e.target.value })}>
                      <option value="">（不挂缺口）</option>
                      {GROUPS.map((grp) => (
                        <optgroup key={grp} label={grp}>
                          {itemKeys.filter((k) => ITEM_GROUP[k] === grp).map((k) => <option key={k} value={k}>{ITEM_LABEL[k]}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    {card.gapItem && <span className="sb-card-score">{breakdown.items[card.gapItem as ItemKey]}/{ITEM_MAX[card.gapItem as ItemKey]}</span>}
                    <button className="sb-del" title="删除" onClick={() => deleteCard(card.id)}>✕</button>
                  </div>
                  <input className="sb-card-title" defaultValue={card.title} placeholder="打法标题（如：借标杆案例撬动 D）"
                    onBlur={(e) => e.target.value !== card.title && updateCard(card.id, { title: e.target.value })} />
                  <textarea className="sb-card-basis" defaultValue={card.basis ?? ''} placeholder="依据 / 说明（为什么这么打）" rows={2}
                    onBlur={(e) => e.target.value !== (card.basis ?? '') && updateCard(card.id, { basis: e.target.value })} />
                  <select className="sb-card-person" value={card.personId || ''} onChange={(e) => updateCard(card.id, { personId: e.target.value || undefined })}>
                    <option value="">（目标干系人 · 可选）</option>
                    {account.persons.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
                  </select>
                  <div className="sb-card-foot">
                    {dispatched
                      ? <span className="sb-dispatched" title="已生成行动到商机策划">✓ 已派发 {card.dispatchedActionIds!.length} 个行动</span>
                      : <button className="btn ghost sm" disabled={!card.title} title={card.title ? '生成行动，落到商机策划时间轴' : '先填打法标题'} onClick={() => dispatchToPlanner(card)}>📤 送行动策划</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ③ 终局栏（目标 / 截止日 + 倒推里程碑 + 就绪度） */}
        <section className="sandbox-col sb-goal">
          <h3 className="sb-h">终局 · 目标</h3>
          <label className="sb-field">
            <span>单一销售目标</span>
            <textarea defaultValue={opp.singleSalesGoal} placeholder="本商机要拿下的明确结果" rows={3}
              onBlur={(e) => e.target.value !== opp.singleSalesGoal && updateGoal({ singleSalesGoal: e.target.value })} />
          </label>
          <label className="sb-field">
            <span>预计签约日（倒排基准）</span>
            <input type="date" defaultValue={opp.expectedSignDate || ''}
              onChange={(e) => updateGoal({ expectedSignDate: e.target.value })} />
          </label>

          <h4 className="sb-sub">🚩 里程碑（倒排）<span className="sb-sub-acts"><button className="sb-mini-add" onClick={addMilestone}>＋</button></span></h4>
          <div className="sb-milestones">
            {milestones.length === 0 && <div className="sb-empty-s">从终局倒排关键节点（开标 / 立项评审 / 签约…），直接落到商机策划时间轴</div>}
            {milestones.map((m) => (
              <div className="sb-ms" key={m.id}>
                <input className="sb-ms-title" defaultValue={m.title} placeholder="里程碑（如：立项评审）"
                  onBlur={(e) => e.target.value !== m.title && updateMilestone(m.id, { title: e.target.value })} />
                <input className="sb-ms-date" type="date" defaultValue={m.startDate || ''}
                  onChange={(e) => updateMilestone(m.id, { startDate: e.target.value, endDate: e.target.value })} />
                <button className="sb-del" title="删除" onClick={() => deleteMilestone(m.id)}>✕</button>
              </div>
            ))}
          </div>

          <div className="sb-ready">
            <h4 className="sb-sub">🎯 就绪度</h4>
            <div className="sb-ready-row"><span>现状趋赢力</span><b style={{ color: tone }}>{pct}%</b></div>
            <div className="sb-ready-row"><span>缺口覆盖</span><b>{coveredCount}/{gaps.length}（{coverage}%）</b></div>
            <div className="sb-ready-bar"><div className="sb-ready-fill" style={{ width: `${Math.max(0, coverage)}%` }} /></div>
            <div className="sb-ready-hint">缺口挂策略卡 →「送行动策划」落到商机策划时间轴。</div>
          </div>
        </section>
      </div>
    </div>
  );
}
