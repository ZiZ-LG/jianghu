// 策略沙盘 · 推演工作台（关系地图 → 沙盘 → 行动策划 的中间「桥」）。
// 结构化三栏：现状(只读引 G64111 缺口/格局) → 方向(策略卡，挂靠低分项) → 终局(目标/截止日 + 就绪度)。
// P0：手工 CRUD + 就绪度（纯前端算）。派发到行动策划 / 风险 / 弹药 / AI 顺推见 P1/P2。
import type { Account, Opportunity, StrategyCard } from '../types';
import { SENTIMENT_CHAR, SENTIMENT_COLOR, ROLE_LABEL } from '../types';
import type { Action } from '../store';
import { newStrategyCard } from '../store';
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

  // 策略卡（本商机、非弃用，按 orderIndex）
  const cards = (account.strategyCards ?? [])
    .filter((c) => c.opportunityId === opp.id && c.status !== 'dismissed')
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

  // 就绪度：缺口被策略卡 gapItem 命中的覆盖率
  const coveredGaps = new Set(cards.map((c) => c.gapItem).filter(Boolean));
  const coveredCount = gaps.filter((g) => coveredGaps.has(g.key)).length;
  const coverage = gaps.length ? Math.round((coveredCount / gaps.length) * 100) : 100;

  const pct = Math.round(breakdown.percent * 100);
  const tone = BAND_TONE[breakdown.band];

  const addCard = (gapItem = '') => {
    const card = newStrategyCard(account.id, opp.id, gapItem);
    card.orderIndex = cards.length;
    dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
  };
  const updateCard = (cardId: string, patch: Partial<StrategyCard>) =>
    dispatch({ type: 'UPDATE_STRATEGY_CARD', accId: account.id, cardId, patch });
  const deleteCard = (cardId: string) => dispatch({ type: 'DELETE_STRATEGY_CARD', accId: account.id, cardId });
  const updateGoal = (patch: Partial<Opportunity>) => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch });

  return (
    <div className="sandbox">
      <div className="sandbox-top">
        <span className="mt-name">{opp.name}</span>
        <ViewTabs view={view} onChange={onChangeView} />
        <span className="sb-band-pill" style={{ color: tone, borderColor: tone }}>● {BAND_LABEL[breakdown.band]} · 趋赢力 {pct}%</span>
        <button className="btn primary xs" onClick={onOpenConsole}>🧠 AI 推演</button>
      </div>

      <div className="sandbox-body">
        {/* ① 现状栏（只读·引自关系地图 G64111） */}
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
        </section>

        {/* ② 方向栏（策略卡 CRUD，挂靠 G64111 低分项） */}
        <section className="sandbox-col sb-dirs">
          <h3 className="sb-h">方向 · 策略卡 <span className="sb-count">{cards.length}</span></h3>
          <button className="btn ghost sm sb-addcard" onClick={() => addCard()}>＋ 新建策略卡</button>
          <div className="sb-cards">
            {cards.length === 0 && <div className="sb-empty">还没有策略卡。从左侧缺口点「＋」，或「新建策略卡」开始排打法。</div>}
            {cards.map((card) => (
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
              </div>
            ))}
          </div>
        </section>

        {/* ③ 终局栏（目标 / 截止日 + 就绪度） */}
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

          <div className="sb-ready">
            <h4 className="sb-sub">🎯 就绪度</h4>
            <div className="sb-ready-row"><span>现状趋赢力</span><b style={{ color: tone }}>{pct}%</b></div>
            <div className="sb-ready-row"><span>缺口覆盖</span><b>{coveredCount}/{gaps.length}（{coverage}%）</b></div>
            <div className="sb-ready-bar"><div className="sb-ready-fill" style={{ width: `${Math.max(0, coverage)}%` }} /></div>
            <div className="sb-ready-hint">把每个缺口都挂上策略卡，再「送行动策划」落地（P1）。</div>
          </div>
        </section>
      </div>
    </div>
  );
}
