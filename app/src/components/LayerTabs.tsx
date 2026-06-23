import type { Layer } from '../types';

const TABS: { id: Layer; label: string; sub: string }[] = [
  { id: 'L1', label: 'L1', sub: '组织架构' },
  { id: 'L2', label: 'L2', sub: '决策权力' },
  { id: 'L3', label: 'L3', sub: '情感阵营' },
  { id: 'L4', label: 'L4', sub: '战略本质' },
];

// 关系层级 = 点亮/熄灭多选（可层叠并显，而非单选只看一层）。亮着的层的连线一并显示在画布。
export function LayerTabs({ visible, onToggle }: { visible: Set<Layer>; onToggle: (l: Layer) => void }) {
  return (
    <div className="topbar layer-toggles">
      {TABS.map((t) => (
        <button key={t.id} className={`tab lay-toggle${visible.has(t.id) ? ' on' : ''}`}
          onClick={() => onToggle(t.id)} aria-pressed={visible.has(t.id)}
          title={`${visible.has(t.id) ? '熄灭' : '点亮'} ${t.label} ${t.sub}`}>
          {t.label} <small>{t.sub}</small>
        </button>
      ))}
    </div>
  );
}
