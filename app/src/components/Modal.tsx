import { useEffect, useId, useRef, type ReactNode } from 'react';
import { focusableElements, lastModalInteractionTarget, takeNextModalReturnFocus, trapTabKey } from '../lib/focusTrap';

export function Modal({
  title, onClose, children, footer, width = 460,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const marked = takeNextModalReturnFocus();
    const findMarked = () => {
      const byId = marked?.id ? document.getElementById(marked.id) : null;
      const byKey = marked?.key
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-overflow-trigger]')).find((element) => element.dataset.overflowTrigger === marked.key) ?? null
        : null;
      const original = marked?.element?.isConnected ? marked.element : null;
      return byId ?? byKey ?? original ?? (marked ? document.querySelector<HTMLElement>('.ovf-trigger') : null);
    };
    const currentMarked = findMarked();
    const previouslyFocused = currentMarked?.isConnected
      ? currentMarked
      : lastModalInteractionTarget() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    dialog?.focus();
    const focusTimer = window.setTimeout(() => {
      const first = dialog ? focusableElements(dialog)[0] : null;
      (first ?? dialog)?.focus();
    }, 50);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      } else {
        trapTabKey(event, dialog);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      const restoreFocus = () => {
        const fallback = findMarked() ?? lastModalInteractionTarget();
        const target = fallback ?? (previouslyFocused?.isConnected ? previouslyFocused : null);
        target?.focus();
      };
      window.requestAnimationFrame(() => window.requestAnimationFrame(restoreFocus));
    };
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <span id={titleId}>{title}</span>
          <button type="button" className="x-btn" aria-label={`关闭${title}`} onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
