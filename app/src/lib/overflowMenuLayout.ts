const MENU_GAP = 6;
const MENU_MIN_WIDTH = 184;
const VIEWPORT_MARGIN = 8;

export interface OverflowMenuLayout {
  position: 'fixed';
  top: number;
  left: number;
  right: 'auto';
  maxHeight: number;
}

export function computeOverflowMenuLayout(
  anchor: { left: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right',
): OverflowMenuLayout {
  const requestedLeft = align === 'right' ? anchor.right - MENU_MIN_WIDTH : anchor.left;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - MENU_MIN_WIDTH - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(requestedLeft, VIEWPORT_MARGIN), maxLeft);
  const top = anchor.bottom + MENU_GAP;

  return {
    position: 'fixed',
    top,
    left,
    right: 'auto',
    maxHeight: Math.max(0, viewport.height - top - VIEWPORT_MARGIN),
  };
}
