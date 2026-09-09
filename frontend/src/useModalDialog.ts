import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

function canRestoreFocus(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element !== document.body
    && element.isConnected && !element.closest("[inert]") && element.getClientRects().length > 0;
}

function onBackdrop(event: MouseEvent, dialog: HTMLDialogElement): boolean {
  const rect = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom);
}

export function useModalDialog(onClose: () => void, {
  dismissible = true,
  fallbackFocus,
}: { dismissible?: boolean; fallbackFocus?: () => HTMLElement | null } = {}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      const target = canRestoreFocus(opener) ? opener : fallbackRef.current?.();
      if (canRestoreFocus(target)) target.focus({ preventScroll: true });
    };
  }, []);

  return {
    ref,
    onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDialogElement>) => event.stopPropagation(),
    onCancel: (event: JSX.TargetedEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (dismissible) onClose();
    },
    onPointerDown: (event: JSX.TargetedPointerEvent<HTMLDialogElement>) => {
      backdropPress.current = onBackdrop(event, event.currentTarget);
    },
    onPointerCancel: () => { backdropPress.current = false; },
    onClick: (event: JSX.TargetedMouseEvent<HTMLDialogElement>) => {
      const close = backdropPress.current && onBackdrop(event, event.currentTarget);
      backdropPress.current = false;
      if (dismissible && close) onClose();
    },
  };
}
