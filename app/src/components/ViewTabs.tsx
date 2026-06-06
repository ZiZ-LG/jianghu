// 客户级「镜头」切换：关系地图（侦探墙体系）↔ 商机策划（日历）。与关系地图内 LayerTabs(L1-L4) 切「层」区分。
export type CustomerView = 'wall' | 'planner';

const VIEWS: { id: CustomerView; icon: string; label: string }[] = [
  { id: 'wall', icon: '🗺️', label: '关系地图' },
  { id: 'planner', icon: '📅', label: '商机策划' },
];

export function ViewTabs({ view, onChange }: { view: CustomerView; onChange: (v: CustomerView) => void }) {
  return (
    <div className="view-tabs" role="tablist" aria-label="客户视图切换">
      {VIEWS.map((v) => (
        <button key={v.id} role="tab" aria-selected={view === v.id}
          className={`vtab${view === v.id ? ' active' : ''}`} onClick={() => onChange(v.id)}>
          <span aria-hidden>{v.icon}</span> {v.label}
        </button>
      ))}
    </div>
  );
}
