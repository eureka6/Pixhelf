import type { RefObject } from "preact";
import { useLayoutEffect } from "preact/hooks";

export const CARD_SELECTOR = ".image-card, .viewer-similar-card, .viewer-media";
export const CARD_MENU_EVENT = "pixhelf:card-menu";
export const CARD_TOUCH_EVENT = "pixhelf:card-touch";
export type CardMenuRequest = { touch: boolean; point?: { x: number; y: number } };

let feedbackCard: HTMLElement | null = null;
let feedbackVisibility: IntersectionObserver | null = null;
let lastPlayedLivePhoto: string | null = null;

export function markLivePhotoPlayed(imageId: string): void {
  lastPlayedLivePhoto = imageId;
}

export function clearCardFeedback(card?: HTMLElement): void {
  if (card && card !== feedbackCard) return;
  if (feedbackCard) delete feedbackCard.dataset.cardActive;
  feedbackCard = null;
  feedbackVisibility?.disconnect();
  feedbackVisibility = null;
}

function activateCardFeedback(card: HTMLElement): void {
  if (feedbackCard === card) return;
  clearCardFeedback();
  feedbackCard = card;
  card.dataset.cardActive = "true";
  feedbackVisibility = new IntersectionObserver(entries => {
    if (feedbackCard === card && entries.some(entry => !entry.isIntersecting)) clearCardFeedback(card);
  });
  feedbackVisibility.observe(card);
}

export function useCardInteraction(ref: RefObject<HTMLDivElement>, enabled = true) {
  useLayoutEffect(() => {
    const gallery = ref.current;
    if (!enabled || !gallery) return;
    let timer = 0;
    let contact: { card: HTMLElement; pointerId: number; x: number; y: number } | null = null;
    let consumed: { card: HTMLElement; pointerId?: number } | null = null;
    let finger: { x: number; y: number } | null = null;
    let touched: HTMLElement | null = null;
    let touchFrame = 0;
    let touchClick = false;
    const input = (type: string) => {
      if (gallery.dataset.cardInput !== type) gallery.dataset.cardInput = type;
    };
    const fromTouch = (event: MouseEvent) => event instanceof PointerEvent && event.pointerType
      ? event.pointerType !== "mouse" : gallery.dataset.cardInput === "touch";
    const cardAt = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest(".photo-card-controls, [inert]")) return null;
      const card = target.closest<HTMLElement>(CARD_SELECTOR);
      return card && gallery.contains(card) ? card : null;
    };
    const cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
      contact = null;
    };
    const show = (card: HTMLElement, request: CardMenuRequest, pointerId?: number) => {
      clearCardFeedback(card);
      if (request.touch) consumed = { card, pointerId };
      card.dispatchEvent(new CustomEvent(CARD_MENU_EVENT, { detail: request }));
    };
    const touchCard = (card: HTMLElement | null) => {
      if (!card || card.querySelector(".photo-card-menu")) return;
      touched = card;
      activateCardFeedback(card);
    };
    const touchAtFinger = () => {
      touchFrame = 0;
      if (finger) touchCard(cardAt(document.elementFromPoint(finger.x, finger.y)));
    };
    const trackTouch = (event: TouchEvent) => {
      if (event.type === "touchstart") touchClick = true;
      if (event.touches.length !== 1) { finger = null; return; }
      const touch = event.touches[0]!;
      finger = { x: touch.clientX, y: touch.clientY };
      touchAtFinger();
    };
    const finishTouch = () => {
      // Keep the feedback after release; playback is triggered by the tap below.
      if (touched?.isConnected && !touched.closest("[inert]")) touchCard(touched);
      finger = null;
      touched = null;
    };
    const down = (event: PointerEvent) => {
      touchClick = event.pointerType !== "mouse";
      input(event.pointerType === "mouse" ? "mouse" : "touch");
      // A new contact can select a menu item; only the opening gesture is consumed.
      consumed = null;
      cancel();
      if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0) return;
      const card = cardAt(event.target);
      if (!card) return;
      touchCard(card);
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
      const pointerId = contact?.pointerId;
      cancel();
      show(card, { touch: fromTouch(event), point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined }, pointerId);
    };
    const followsLongPress = (event: MouseEvent) => consumed && event.detail > 0
      && ((event.target instanceof Node && consumed.card.contains(event.target))
        || (event instanceof PointerEvent && event.pointerId === consumed.pointerId));
    const mouseDown = (event: MouseEvent) => {
      // Touch compatibility events must not move focus back from the menu to the photo.
      if (followsLongPress(event)) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (followsLongPress(event)) {
        consumed = null;
        touchClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // WebKit labels the compatibility click after a touch as pointerType=mouse.
      // Keep the input type from the gesture's start until this click is consumed.
      const touch = touchClick || fromTouch(event);
      touchClick = false;
      if (!touch || event.detail === 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const card = cardAt(event.target);
      if (!card || card.matches(".viewer-media")) return;
      const live = card.querySelector<HTMLElement>(".live-photo");
      if (!live || live.dataset.failed === "true"
        || live.dataset.playing === "true" || live.dataset.loading === "true"
        || card.dataset.imageId === lastPlayedLivePhoto) return;
      // The most recently played photo opens even after playback ends. Once a
      // different live photo plays, this photo needs a playback tap again.
      event.preventDefault();
      event.stopImmediatePropagation();
      activateCardFeedback(card);
      card.dispatchEvent(new Event(CARD_TOUCH_EVENT));
    };
    const touchMove = (event: TouchEvent) => {
      if (consumed && contact && event.cancelable) event.preventDefault();
      trackTouch(event);
    };
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      input("keyboard");
      touchClick = false;
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
    document.addEventListener("touchstart", trackTouch, { ...capture, passive: true });
    document.addEventListener("touchmove", touchMove, { ...capture, passive: false });
    document.addEventListener("touchend", finishTouch, { ...capture, passive: true });
    document.addEventListener("touchcancel", () => { finger = null; touched = null; }, { ...capture, passive: true });
    document.addEventListener("keydown", key, capture);
    document.addEventListener("scroll", () => {
      cancel();
      if (finger && !touchFrame) touchFrame = requestAnimationFrame(touchAtFinger);
    }, capture);
    document.addEventListener("visibilitychange", () => { cancel(); if (document.hidden) clearCardFeedback(); }, { signal });
    window.addEventListener("blur", cancel, { signal });
    return () => {
      cancel();
      cancelAnimationFrame(touchFrame);
      if (feedbackCard && (gallery.contains(feedbackCard) || !feedbackCard.isConnected)) clearCardFeedback();
      listeners.abort();
    };
  }, [enabled, ref]);
}
