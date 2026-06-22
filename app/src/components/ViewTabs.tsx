// 客户级「镜头」切换：关系地图 ↔ 行动计划。策略沙盘已并入关系地图底部「推演坞」，不再是独立镜头。
// 'sandbox' 保留在类型里仅为兼容旧持久态（App 会归一到 'wall'）。与关系地图内 LayerTabs(L1-L4) 切「层」区分。
export type CustomerView = 'wall' | 'sandbox' | 'planner';

const VIEWS: { id: CustomerView; icon: string; label: string }[] = [
  { id: 'wall', icon: '🗺️', label: '关系地图' },
  { id: 'planner', icon: '📅', label: '行动计划' },
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
