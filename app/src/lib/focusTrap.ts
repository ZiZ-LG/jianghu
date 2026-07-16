export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalReturnFocus {
  element: HTMLElement | null;
  id: string | null;
  key: string | null;
}

let pendingModalReturnFocus: ModalReturnFocus | null = null;

const interactionState = globalThis as typeof globalThis & {
  __jianghuModalFocus?: { installed: boolean; last: HTMLElement | null; overflowKey: string | null };
};
interactionState.__jianghuModalFocus ??= { installed: false, last: null, overflowKey: null };
if (typeof document !== 'undefined' && !interactionState.__jianghuModalFocus.installed) {
  const record = (target: EventTarget | null) => {
    const element = target instanceof Element
      ? target.closest<HTMLElement>('button, a[href], input, select, textarea, [role="button"], [tabindex]')
      : null;
    if (element && !element.closest('.modal')) {
      const overflowTrigger = element.closest('.ovf')?.querySelector<HTMLElement>('[data-overflow-trigger]') ?? null;
      interactionState.__jianghuModalFocus!.last = overflowTrigger ?? element;
      interactionState.__jianghuModalFocus!.overflowKey = overflowTrigger?.dataset.overflowTrigger ?? null;
    }
  };
  document.addEventListener('pointerdown', (event) => record(event.target), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') record(document.activeElement);
  }, true);
  interactionState.__jianghuModalFocus.installed = true;
}

export function lastModalInteractionTarget(): HTMLElement | null {
  const state = interactionState.__jianghuModalFocus;
  const target = state?.last ?? null;
  if (target?.isConnected) return target;
  if (!state?.overflowKey) return null;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-overflow-trigger]'))
    .find((element) => element.dataset.overflowTrigger === state.overflowKey) ?? null;
}

export function markNextModalReturnFocus(element: HTMLElement | null, id = element?.id || null, key: string | null = null): void {
  pendingModalReturnFocus = { element, id, key };
}

export function takeNextModalReturnFocus(): ModalReturnFocus | null {
  const value = pendingModalReturnFocus;
  pendingModalReturnFocus = null;
  return value;
}

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
}

export function trapTabKey(event: KeyboardEvent | React.KeyboardEvent, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === root || active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === root || active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
