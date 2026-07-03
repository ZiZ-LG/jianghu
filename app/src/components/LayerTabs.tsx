import type { Layer } from '../types';

// P16：Tooltip 说清四层各自看什么——L1 名义 vs L2 实权的对比是 G64111 核心洞察，不合并
const TABS: { id: Layer; label: string; sub: string; hint: string }[] = [
  { id: 'L1', label: 'L1', sub: '组织架构', hint: '名义上级/下级——组织图上的正式关系' },
  { id: 'L2', label: 'L2', sub: '决策权力', hint: '实权谁听谁的——常与 L1 错位，是 G64111 破局关键' },
  { id: 'L3', label: 'L3', sub: '情感阵营', hint: '谁跟谁走得近/结盟——攻心/借力线' },
  { id: 'L4', label: 'L4', sub: '战略本质', hint: '利益/立场的深层根因——本质冲突或共谋' },
];

// 关系层级 = 点亮/熄灭多选（可层叠并显，而非单选只看一层）。亮着的层的连线一并显示在画布。
export function LayerTabs({ visible, onToggle }: { visible: Set<Layer>; onToggle: (l: Layer) => void }) {
  return (
    <div className="topbar layer-toggles">
      {TABS.map((t) => (
        <button key={t.id} className={`tab lay-toggle${visible.has(t.id) ? ' on' : ''}`}
          onClick={() => onToggle(t.id)} aria-pressed={visible.has(t.id)}
          title={`${t.label} ${t.sub}：${t.hint}（点击${visible.has(t.id) ? '熄灭' : '点亮'}此层）`}>
          {t.label} <small>{t.sub}</small>
        </button>
      ))}
    </div>
  );
}
