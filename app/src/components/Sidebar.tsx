// 左栏 · 诊断思考台（第1刀纯化 + 第7刀屏效§4 落地）：客户/商机表头 + 趋赢力打分台——对话已收进推演坞（一处入口，解两处冗余）。
// 屏效§4：默认只显 数字+加权小字+band+top3 缺口，点开才见 11 项——分项全列与坞列①缺口行的重复由此收敛。
// 干系人名单不再需要——画布的牌桌卡片就是名单。
import { useState } from 'react';
import type { Account, Opportunity } from '../types';
import type { ScoreBreakdown, ItemKey } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL } from '../lib/g64111';
import { useCountUp, usePersistentState } from '../ui';
import { ACT_LABEL } from '../lib/pdeUi';

const ITEMS: ItemKey[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', '1K'];
const GROUPS = ['6必清', '4优势', '1决胜'] as const;
const GROUP_MAX: Record<string, number> = { '6必清': 35, '4优势': 45, '1决胜': 20 };
const SIGNED = new Set<ItemKey>(['P1', 'P2', 'P3', 'P4', '1K']); // 可为负的优势/决胜项
const BAND_COLOR: Record<string, string> = {
  ABSOLUTE_ADVANTAGE: '#059669', RELATIVE_ADVANTAGE: '#2563eb', RELATIVE_DISADVANTAGE: '#f97316', ABSOLUTE_DISADVANTAGE: '#b91c1c',
};

// 每项打分的依据(怎么得分) + 提分(怎么补)，对齐 docs/G64111-评分规格.md，方便用户核对标准、有针对性提分
const ITEM_BASIS: Record<ItemKey, { rule: string; raise: string }> = {
  C1: { rule: '组织图齐备（A/D/U/R/C 各角色已识别上图）+ 主拍板人 D 的 FORM 家庭 7 问（籍贯/年纪/生日/院校/配偶/子女/父母）填得越全分越高。', raise: '补齐缺失角色卡；在 D 的详情抽屉补 FORM 家庭信息。' },
  C2: { rule: '拍板人 D 的燃眉问题（BI）已明确识别并记录（置信度 ≥ 明确）。', raise: '在 D 的详情里补一条燃眉问题 BI，并标为已明确。' },
  C3: { rule: '立项 7 项材料齐备且排好优先序。', raise: '对照立项清单补齐材料并排序。' },
  C4: { rule: '已准确判断并介入当前销售阶段。', raise: '确认商机当前阶段、对齐打法。' },
  C5: { rule: '招采 5 要素（流程 / 时间 / 预算 / 评标办法 / 对手）摸清。', raise: '把招采 5 要素逐项摸清补录。' },
  C6: { rule: '我方独特价值（UCV）被客户明确 / 书面认可。', raise: '推动 D 认可 UCV；先口头、后书面。' },
  P1: { rule: '多数关键人明确表态：☆/+ 计正、−/x 计负，总和封顶 ±5。', raise: '把中立 / 未知的关键人争取到明确支持。' },
  P2: { rule: '招采关键人（采购 / 代理 / 甲方代表）倒向我方；全缺位则整体失血 −5。', raise: '锁定招采关键人，谈成密谋或至少口头支持。' },
  P3: { rule: '与拍板人 D 的关系深度：密谋级最高 +20，倒戈最低 −20；多 D 取最低那位。', raise: '把与 D 的关系推进到密谋级。' },
  P4: { rule: '已标记的关键影响人支持（仅第一个关键影响人计分 0–10）。', raise: '识别并争取关键影响人到明确支持。' },
  '1K': { rule: '与批准人 A 的关系：密谋级最高 +20，倒戈 −20。', raise: '打通到 A 的通路，谈成密谋级共识。' },
};

function Item({ k, score, open, onToggle }: { k: ItemKey; score: number; open: boolean; onToggle: () => void }) {
  const max = ITEM_MAX[k];
  const pct = Math.max(2, Math.min(100, (score / max) * 100));
  const color = score < 0 ? '#b91c1c' : score < max * 0.6 ? '#f59e0b' : '#16a34a';
  const sc = score % 1 === 0 ? `${score}` : score.toFixed(1);
  const disp = SIGNED.has(k) && score > 0 ? `+${sc}` : sc;
  const b = ITEM_BASIS[k];
  return (
    <div className={`wt-wrap${open ? ' open' : ''}`}>
      <div className="wt-item" onClick={onToggle} title="展开打分依据 / 怎么提分">
        <div className="wt-row1">
          <span className="wt-chev">{open ? '▾' : '▸'}</span>
          <span className="wt-nm">{ITEM_LABEL[k]}</span>
          <span className="wt-sc">{disp}/{max}</span>
        </div>
        <span className="wt-bar"><i style={{ width: `${pct}%`, background: color }} /></span>
      </div>
      {open && (
        <div className="wt-detail">
          <div className="wt-rule">{b.rule}</div>
          <div className="wt-raise"><b>↑ 提分</b>：{b.raise}</div>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ account, opp, breakdown, weighted = null, pde = null, onOpenEngine, onSelectOpp, onAddOpp, onBack, onCollapse, gapCount = 0, onOpenGaps }: {
  account: Account;
  opp: Opportunity | null;
  breakdown: ScoreBreakdown | null;
  weighted?: number | null;   // 第7刀：PDE 加权分（按证据可信度折扣）——双轨分归位到趋赢力本尊旁，引擎不可用为 null 隐藏
  pde?: { action: string; pwin: number; flag: string } | null; // 第8刀：四动作徽章收编左栏（坞头药丸/徽章退役，局势信息一处）
  onOpenEngine?: () => void;  // 点徽章 → 坞开「引擎详解」抽屉（跨组件信号）
  onSelectOpp: (id: string) => void;
  onAddOpp: () => void;
  onBack: () => void;
  onCollapse: () => void;
  gapCount?: number;          // M3 缺口数（>0 时趋赢力台显示「补分」入口）
  onOpenGaps?: () => void;    // M3 打开缺口刷卡
}) {
  const [open, setOpen] = useState<Set<ItemKey>>(() => new Set());
  const toggle = (k: ItemKey) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const [showAll, setShowAll] = usePersistentState('jianghu.diagAllItems', false); // 屏效§4：默认 top3 缺口，点开才见 11 项

  const pct = useCountUp(breakdown ? Math.round(breakdown.percent * 100) : 0); // 动效：趋赢力数字滚动入场
  const groupScore: Record<string, number> = breakdown
    ? { '6必清': breakdown.clears, '4优势': breakdown.priorities, '1决胜': breakdown.key }
    : { '6必清': 0, '4优势': 0, '1决胜': 0 };
  // top3 缺口：按缺口绝对值降序（负分项天然靠前）——「一眼短板」
  const top3 = breakdown
    ? [...ITEMS].filter((k) => breakdown.items[k] < ITEM_MAX[k]).sort((a, b) => (ITEM_MAX[b] - breakdown.items[b]) - (ITEM_MAX[a] - breakdown.items[a])).slice(0, 3)
    : [];

  return (
    <aside className="sidebar diag-sidebar">
      <div className="sidebar-header">
        <button className="back-btn" onClick={onBack} title="返回客户列表">‹</button>
        <div className="logo">江</div>
        <div className="sidebar-title">{account.name}<small>{account.persons.length} 干系人 · {account.opportunities.length} 商机</small></div>
        <button className="collapse-btn" onClick={onCollapse} title="折叠侧边栏">«</button>
      </div>

      <div className="diag-opp">
        {opp ? (
          <select className="mt-opp-select" value={opp.id} onChange={(e) => onSelectOpp(e.target.value)} title="切换商机">
            {account.opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : <span className="diag-opp-none">未选择商机</span>}
        <button className="add-mini" onClick={onAddOpp} title="新建商机">＋</button>
      </div>

      <div className="diag-score">
        {breakdown ? (
          <>
            {/* P7 头部重排：左=趋赢力+大字% 横排；右=加权/补情报药丸竖叠——四元素不再挤一行（252px 曾把「趋赢力」压成竖排） */}
            <div className="diag-top">
              <div className="diag-top-main">
                <span className="diag-cap">趋赢力</span>
                <span className="diag-pct" style={{ color: breakdown.total < 0 ? '#b91c1c' : 'var(--ink)' }}>{pct}<small>%</small></span>
              </div>
              <div className="diag-pills">
                {weighted != null && (
                  <span className="diag-weighted" title={`双轨分：名义 ${breakdown.total} 分＝打分表原值；加权 ${Math.round(weighted)} 分＝按证据可信度折扣。差 ${Math.round(breakdown.total - weighted)} 分＝情报还没坐实的部分。作战工具，非考核指标。`}>
                    加权 {Math.round(weighted)}
                  </span>
                )}
                {onOpenGaps && gapCount > 0 && (
                  <button className="diag-gaps-pill" onClick={onOpenGaps} title="缺什么情报一目了然：要问的下次拜访带着问，能勾的案头当场勾">
                    🎒 补情报·{gapCount}
                  </button>
                )}
              </div>
            </div>
            <div className="diag-band-row">
              <div className="diag-band" style={{ background: BAND_COLOR[breakdown.band] }}>{BAND_LABEL[breakdown.band]}</div>
              {pde && ACT_LABEL[pde.action] && (
                <button className={`mf-act mf-act-${ACT_LABEL[pde.action]!.cls} dock-act-btn`} onClick={onOpenEngine}
                  title={`引擎建议：赢面 ${Math.round(pde.pwin * 100)}%（点开看详解：理由 / 薄弱关键人 / 赢面走势 / 假设推演）${pde.flag ? ` · ${pde.flag.includes('no_pot') ? '未设合同额，金额降级' : '置信偏低，先摸底'}` : ''}`}>
                  {ACT_LABEL[pde.action]!.icon}{ACT_LABEL[pde.action]!.text}·赢面{Math.round(pde.pwin * 100)}%{pde.flag ? '⚠︎' : ''}
                </button>
              )}
            </div>
            {showAll ? (
              <>
                {GROUPS.map((g) => (
                  <div className="diag-grp-block" key={g}>
                    <div className="diag-grp"><span>{g}</span><span className="diag-grp-sc">{groupScore[g]} / {GROUP_MAX[g]}</span></div>
                    {ITEMS.filter((k) => ITEM_GROUP[k] === g).map((k) => <Item key={k} k={k} score={breakdown.items[k]} open={open.has(k)} onToggle={() => toggle(k)} />)}
                  </div>
                ))}
                <button className="diag-expand" onClick={() => setShowAll(false)}>收起 ⌃ 只看 top3 短板</button>
              </>
            ) : (
              <>
                <div className="diag-grp"><span>top3 短板</span></div>
                {top3.map((k) => <Item key={k} k={k} score={breakdown.items[k]} open={open.has(k)} onToggle={() => toggle(k)} />)}
                {top3.length === 0 && <div className="diag-total">无明显缺口 🎉</div>}
                <button className="diag-expand" onClick={() => setShowAll(true)}>展开全部 11 项 ⌄</button>
              </>
            )}
            <div className="diag-total">总分 {breakdown.total}/100 · 点每项看依据 / 怎么提分</div>
          </>
        ) : (
          <div className="empty-hint" style={{ padding: 12 }}>选择 / 新建商机后显示趋赢力打分</div>
        )}
      </div>

    </aside>
  );
}
