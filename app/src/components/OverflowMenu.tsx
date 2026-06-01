import { useEffect, useRef, useState } from 'react';

export interface OverflowItem {
  label: string;
  onClick: () => void;
  primary?: boolean;   // 高亮项（如「AI 推演」）
  badge?: string;      // 右侧角标（如待办数）
}

/** 移动端用：把一排操作收进「⋯」下拉菜单，点空白/选项即收起。 */
export function OverflowMenu({
  label = '⋯ 操作', items, align = 'right',
}: {
  label?: string;
  items: OverflowItem[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  return (
    <div className="ovf" ref={ref}>
      <button className="btn ghost xs ovf-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{label}</button>
      {open && (
        <div className={`ovf-pop ovf-${align}`}>
          {items.map((it, i) => (
            <button key={i} className={`ovf-item${it.primary ? ' primary' : ''}`} onClick={() => { setOpen(false); it.onClick(); }}>
              <span>{it.label}</span>
              {it.badge && <span className="ovf-badge">{it.badge}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
