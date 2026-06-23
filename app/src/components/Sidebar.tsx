// 左栏 · 诊断思考台：客户/商机表头 + 趋赢力打分台（每项可展开看依据/提分）+ 可拖拽调高的对话框。
// 干系人名单不再需要——画布的牌桌卡片就是名单。
import { useRef, useState } from 'react';
import type { Account, Opportunity } from '../types';
import type { ScoreBreakdown, ItemKey } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL } from '../lib/g64111';
import { usePersistentState } from '../ui';
import { ChatPanel } from './ChatPanel';

const ITEMS: ItemKey[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2', 'P3', 'P4', '1K'];
const GROUPS = ['6必清', '4优势', '1决胜'] as const;
const GROUP_MAX: Record<string, number> = { '6必清': 35, '4优势': 45, '1决胜': 20 };
const SIGNED = new Set<ItemKey>(['P1', 'P2', 'P3', 'P4', '1K']); // 可为负的优势/决胜项
const BAND_COLOR: Record<string, string> = {
  ABSOLUTE_ADVANTAGE: '#059669', RELATIVE_ADVANTAGE: '#2563eb', RELATIVE_DISADVANTAGE: '#f97316', ABSOLUTE_DISADVANTAGE: '#b91c1c',
};

// 每项打分的依据(怎么得分) + 提分(怎么补)，对齐 docs/G64111-评分规格.md，方便用户核对标准、有针对性提分
const ITEM_BASIS: Record<ItemKey, { rule: string; raise: string }> = {
  C1: { rule: '组织图齐备（A/D/U/TB/R 各角色已识别上图）+ 主拍板人 D 的 FORM 家庭 7 问（籍贯/年纪/生日/院校/配偶/子女/父母）填得越全分越高。', raise: '补齐缺失角色卡；在 D 的详情抽屉补 FORM 家庭信息。' },
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

export function Sidebar({ account, opp, breakdown, onSelectOpp, onAddOpp, onBack, onCollapse, onChatDone }: {
  account: Account;
  opp: Opportunity | null;
  breakdown: ScoreBreakdown | null;
  onSelectOpp: (id: string) => void;
  onAddOpp: () => void;
  onBack: () => void;
  onCollapse: () => void;
  onChatDone: () => void;
}) {
  const [open, setOpen] = useState<Set<ItemKey>>(() => new Set());
  const toggle = (k: ItemKey) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // 对话框高度：趋赢力与对话框之间的分隔条可上下拖拽调节；对话变高 → 上方趋赢力出滚动条
  const [chatH, setChatH] = usePersistentState('jianghu.chatHeight', 280);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { y: e.clientY, h: chatH };
    const onMove = (ev: PointerEvent) => { const d = dragRef.current; if (!d) return; setChatH(Math.max(120, Math.min(640, d.h + (d.y - ev.clientY)))); };
    const onUp = () => { dragRef.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pct = breakdown ? Math.round(breakdown.percent * 100) : 0;
  const groupScore: Record<string, number> = breakdown
    ? { '6必清': breakdown.clears, '4优势': breakdown.priorities, '1决胜': breakdown.key }
    : { '6必清': 0, '4优势': 0, '1决胜': 0 };

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
            <div className="diag-top">
              <span className="diag-cap">趋赢力</span>
              <span className="diag-pct" style={{ color: breakdown.total < 0 ? '#b91c1c' : 'var(--ink)' }}>{pct}<small>%</small></span>
            </div>
            <div className="diag-band" style={{ background: BAND_COLOR[breakdown.band] }}>{BAND_LABEL[breakdown.band]}</div>
            {GROUPS.map((g) => (
              <div className="diag-grp-block" key={g}>
                <div className="diag-grp"><span>{g}</span><span className="diag-grp-sc">{groupScore[g]} / {GROUP_MAX[g]}</span></div>
                {ITEMS.filter((k) => ITEM_GROUP[k] === g).map((k) => <Item key={k} k={k} score={breakdown.items[k]} open={open.has(k)} onToggle={() => toggle(k)} />)}
              </div>
            ))}
            <div className="diag-total">总分 {breakdown.total}/100 · 点每项看依据 / 怎么提分</div>
          </>
        ) : (
          <div className="empty-hint" style={{ padding: 12 }}>选择 / 新建商机后显示趋赢力打分</div>
        )}
      </div>

      <div className="diag-resizer" onPointerDown={onResizeDown} title="拖动调节对话框高度">
        <span className="diag-resizer-grip">⇕</span>
      </div>

      <ChatPanel account={account} opp={opp} onDone={onChatDone} height={chatH} />
    </aside>
  );
}
