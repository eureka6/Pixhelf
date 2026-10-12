import { useLayoutEffect, useRef } from "preact/hooks";
import { ensureSelectionHistory } from "./selectionHistory";

const INTERACTIVE = '.image-card, .album-card, .album-folder, .viewer-similar-card, .image-viewer, .video-viewer, .mobile-nav-layer, .bottom-dock, .photo-card-menu, .selection-menu, .gallery-selection-bar, dialog, button, a, input, textarea, select, label, summary, [role="button"], [role="checkbox"], [role="slider"], [contenteditable="true"]';
const blank = (target: EventTarget | null) => target instanceof Element && !target.closest(INTERACTIVE);

export function useSelectionDismiss(active: boolean, busy: boolean, viewing: boolean, clear: () => void) {
  const latest = useRef({ active, busy, viewing, clear });
  latest.current = { active, busy, viewing, clear };
  useLayoutEffect(() => { if (active && !viewing) ensureSelectionHistory(); }, [active, viewing]);
  useLayoutEffect(() => {
    let contact: { id: number; x: number; y: number; touch: boolean } | null = null;
    const enabled = () => latest.current.active && !latest.current.busy && !latest.current.viewing
      && !document.querySelector('dialog[open], [data-selection-dragging]');
    const cancel = () => { contact = null; };
    const down = (event: PointerEvent) => {
      const touch = event.pointerType !== "mouse";
      // Mobile browsers can retarget a tap in a narrow gap to a nearby photo.
      // Use the actual point before the card's touch feedback changes its bounds.
      const target = touch ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
      contact = enabled() && event.isPrimary && event.button === 0 && blank(target)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, touch } : null;
    };
    const move = (event: PointerEvent) => {
      if (contact?.id === event.pointerId && Math.hypot(event.clientX - contact.x, event.clientY - contact.y) >= 6) cancel();
    };
    const click = (event: MouseEvent) => {
      const dismiss = contact && !event.defaultPrevented && event.button === 0 && enabled() && (contact.touch || blank(event.target));
      cancel();
      if (dismiss) {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current.clear();
      }
    };
    const listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener("pointerdown", down, { capture: true, signal });
    window.addEventListener("pointermove", move, { capture: true, passive: true, signal });
    window.addEventListener("pointercancel", cancel, { capture: true, signal });
    window.addEventListener("scroll", cancel, { capture: true, passive: true, signal });
    window.addEventListener("blur", cancel, { signal });
    window.addEventListener("click", click, { capture: true, signal });
    return () => listeners.abort();
  }, []);
}
