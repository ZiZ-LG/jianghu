import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { markNextModalReturnFocus } from '../lib/focusTrap';
import { computeOverflowMenuLayout, type OverflowMenuLayout } from '../lib/overflowMenuLayout';

export interface OverflowItem {
  label: string;
  onClick: () => void;
  primary?: boolean;   // 高亮项（如「AI 推演」）
  badge?: string;      // 右侧角标（如待办数）
  active?: boolean;    // 当前选中项（如当前关系层级），显示 ✓
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
  const triggerId = useId();
  const popoverId = `${triggerId}-menu`;
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<OverflowMenuLayout | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    let pendingFrame: number | null = null;
    const updateLayout = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const next = computeOverflowMenuLayout(rect, { width: window.innerWidth, height: window.innerHeight }, align);
      setLayout((current) => current
        && current.top === next.top
        && current.left === next.left
        && current.maxHeight === next.maxHeight
        ? current
        : next);
    };
    const scheduleLayout = () => {
      if (pendingFrame !== null) return;
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        updateLayout();
      });
    };
    updateLayout();
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('scroll', scheduleLayout, true);
    return () => {
      window.removeEventListener('resize', scheduleLayout);
      window.removeEventListener('scroll', scheduleLayout, true);
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, [align, open]);

  useEffect(() => {
    if (open && layout && document.activeElement === triggerRef.current) firstItemRef.current?.focus();
  }, [layout, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const popover = open && layout ? (
    <div
      id={popoverId}
      ref={popoverRef}
      role="group"
      aria-labelledby={triggerId}
      data-overflow-popover
      className={`ovf-pop ovf-${align}`}
      style={layout}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }}
    >
      {items.map((it, i) => (
        <button ref={i === 0 ? firstItemRef : undefined} key={i} className={`ovf-item${it.primary ? ' primary' : ''}${it.active ? ' active' : ''}`} onClick={() => {
          setOpen(false);
          markNextModalReturnFocus(triggerRef.current, triggerId, label);
          it.onClick();
        }}>
          <span>{it.label}</span>
          {it.badge && <span className="ovf-badge">{it.badge}</span>}
          {it.active && <span className="ovf-check">✓</span>}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="ovf" ref={ref}>
      <button
        id={triggerId}
        ref={triggerRef}
        data-overflow-trigger={label}
        className="btn ghost xs ovf-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
      >
        {label}
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}
