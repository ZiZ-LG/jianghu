import type { Layer } from '../types';

const TABS: { id: Layer; label: string; sub: string }[] = [
  { id: 'L1', label: 'L1', sub: '组织架构' },
  { id: 'L2', label: 'L2', sub: '决策权力' },
  { id: 'L3', label: 'L3', sub: '情感阵营' },
  { id: 'L4', label: 'L4', sub: '战略本质' },
];

export function LayerTabs({ layer, onChange }: { layer: Layer; onChange: (l: Layer) => void }) {
  return (
    <div className="topbar">
      {TABS.map((t) => (
        <button key={t.id} className={`tab${layer === t.id ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label} <small>{t.sub}</small>
        </button>
      ))}
    </div>
  );
}
