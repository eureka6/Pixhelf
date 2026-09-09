import type { RefObject } from "preact";
import { useLayoutEffect } from "preact/hooks";

export const CARD_SELECTOR = ".image-card, .viewer-similar-card, .viewer-media";
export const CARD_MENU_EVENT = "pixhelf:card-menu";
export type CardMenuRequest = { touch: boolean; point?: { x: number; y: number } };

export function useCardInteraction(ref: RefObject<HTMLDivElement>, enabled = true) {
  useLayoutEffect(() => {
    const gallery = ref.current;
    if (!enabled || !gallery) return;
    let timer = 0;
    let contact: { card: HTMLElement; pointerId: number; x: number; y: number } | null = null;
    let consumed: { card: HTMLElement; pointerId?: number } | null = null;
    const input = (type: string) => {
      if (gallery.dataset.cardInput !== type) gallery.dataset.cardInput = type;
    };
    const cardAt = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest(".photo-card-controls")) return null;
      const card = target.closest<HTMLElement>(CARD_SELECTOR);
      return card && gallery.contains(card) ? card : null;
    };
    const cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
      contact = null;
    };
    const show = (card: HTMLElement, request: CardMenuRequest, pointerId?: number) => {
      if (request.touch) consumed = { card, pointerId };
      card.dispatchEvent(new CustomEvent(CARD_MENU_EVENT, { detail: request }));
    };
    const down = (event: PointerEvent) => {
      input(event.pointerType === "mouse" ? "mouse" : "touch");
      // A new contact can select a menu item; only the opening gesture is consumed.
      consumed = null;
      cancel();
      if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0) return;
      const card = cardAt(event.target);
      if (!card) return;
      contact = { card, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      timer = window.setTimeout(() => {
        if (!contact || !card.isConnected) return;
        timer = 0;
        show(card, { touch: true, point: { x: contact.x, y: contact.y } }, contact.pointerId);
      }, 500);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "mouse") input("mouse");
      if (!consumed && contact?.pointerId === event.pointerId
        && Math.hypot(event.clientX - contact.x, event.clientY - contact.y) > 10) cancel();
    };
    const end = (event: PointerEvent) => {
      if (contact?.pointerId === event.pointerId) cancel();
      // Keep click suppression through pointerup/pointercancel: browsers may still send a click.
    };
    const context = (event: MouseEvent) => {
      const card = cardAt(event.target);
      if (!card) return;
      event.preventDefault();
      const touch = event instanceof PointerEvent && event.pointerType
        ? event.pointerType !== "mouse" : gallery.dataset.cardInput === "touch";
      const pointerId = contact?.pointerId;
      cancel();
      show(card, { touch, point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined }, pointerId);
    };
    const followsLongPress = (event: MouseEvent) => consumed && event.detail > 0
      && ((event.target instanceof Node && consumed.card.contains(event.target))
        || (event instanceof PointerEvent && event.pointerId === consumed.pointerId));
    const mouseDown = (event: MouseEvent) => {
      // Touch compatibility events must not move focus back from the menu to the photo.
      if (followsLongPress(event)) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (!followsLongPress(event)) return;
      consumed = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const touchMove = (event: TouchEvent) => {
      if (consumed && contact && event.cancelable) event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      input("keyboard");
      consumed = null;
      cancel();
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        const card = cardAt(event.target);
        if (card) { event.preventDefault(); show(card, { touch: false }); }
      }
    };

    const listeners = new AbortController();
    const { signal } = listeners;
    const capture = { capture: true, signal };
    document.addEventListener("pointerdown", down, capture);
    document.addEventListener("pointermove", move, { ...capture, passive: true });
    document.addEventListener("pointerup", end, capture);
    document.addEventListener("pointercancel", end, capture);
    document.addEventListener("contextmenu", context, capture);
    document.addEventListener("mousedown", mouseDown, capture);
    document.addEventListener("click", click, capture);
    document.addEventListener("touchmove", touchMove, { ...capture, passive: false });
    document.addEventListener("keydown", key, capture);
    document.addEventListener("scroll", cancel, capture);
    document.addEventListener("visibilitychange", cancel, { signal });
    window.addEventListener("blur", cancel, { signal });
    return () => {
      cancel();
      listeners.abort();
    };
  }, [enabled, ref]);
}
