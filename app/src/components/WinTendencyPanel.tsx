import type { ScoreBreakdown, ItemKey } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL, BAND_STRATEGY } from '../lib/g64111';

const BAND_COLOR: Record<string, string> = {
  ABSOLUTE_ADVANTAGE: '#059669',
  RELATIVE_ADVANTAGE: '#2563eb',
  RELATIVE_DISADVANTAGE: '#f97316',
  ABSOLUTE_DISADVANTAGE: '#b91c1c',
};

const ITEMS: ItemKey[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', '1K'];

function ItemCell({ k, score }: { k: ItemKey; score: number }) {
  const max = ITEM_MAX[k];
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const isGap = score < max * 0.6;
  const color = score < 0 ? '#b91c1c' : isGap ? '#f97316' : '#16a34a';
  return (
    <div className={`item-cell${isGap ? ' gap' : ''}`}>
      <div className="top">
        <span className="nm">{ITEM_LABEL[k]}</span>
        <span className="sc" style={{ color }}>{score % 1 === 0 ? score : score.toFixed(1)}<span style={{ color: '#cbd5e1' }}>/{max}</span></span>
      </div>
      <div className="bar"><i style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

export function WinTendencyPanel({
  breakdown, collapsed = false, onToggle,
}: {
  breakdown: ScoreBreakdown;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pct = Math.round(breakdown.percent * 100);
  const color = BAND_COLOR[breakdown.band];
  const clears = ITEMS.filter((k) => ITEM_GROUP[k] === '6必清');
  const priorities = ITEMS.filter((k) => ITEM_GROUP[k] === '4优势');
  const key = ITEMS.filter((k) => ITEM_GROUP[k] === '1决胜');

  // 折叠态：只留一条迷你条（分数 + band + 展开按钮），把画布空间还给用户
  if (collapsed) {
    return (
      <div className="winpanel collapsed">
        <span className="cap">趋赢力</span>
        <b className="mini-score" style={{ color: breakdown.total < 0 ? '#b91c1c' : 'var(--ink)' }}>{pct}%</b>
        <span className="band-chip sm" style={{ background: color }}>{BAND_LABEL[breakdown.band]}</span>
        <span className="mini-total">总分 {breakdown.total}/100</span>
        <button className="win-toggle" onClick={onToggle} title="展开趋赢力面板">展开 ⌃</button>
      </div>
    );
  }

  return (
    <div className="winpanel">
      <div className="win-score">
        <span className="cap">趋赢力 Win-Tendency</span>
        <div className="big" style={{ color: breakdown.total < 0 ? '#b91c1c' : 'var(--ink)' }}>
          {pct}<small>%</small>
        </div>
        <div className="band-chip" style={{ background: color }}>{BAND_LABEL[breakdown.band]}</div>
        <div className="strat">{BAND_STRATEGY[breakdown.band]}</div>
      </div>
      <div className="win-items">
        <div className="grp">
          6 必清（{breakdown.clears}/35） · 4 优势（{breakdown.priorities}/45） · 1 决胜（{breakdown.key}/20）→ 总分 {breakdown.total}/100
          {onToggle && <button className="win-toggle" onClick={onToggle} title="折叠趋赢力面板">折叠 ⌄</button>}
        </div>
        <div className="item-grid">
          {clears.map((k) => <ItemCell key={k} k={k} score={breakdown.items[k]} />)}
          {priorities.map((k) => <ItemCell key={k} k={k} score={breakdown.items[k]} />)}
          {key.map((k) => <ItemCell key={k} k={k} score={breakdown.items[k]} />)}
        </div>
      </div>
    </div>
  );
}
