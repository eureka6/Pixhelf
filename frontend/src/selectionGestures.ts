import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { clearCardFeedback } from "./cardInteraction";
import type { GallerySelection } from "./JustifiedGallery";
import { MAX_SELECTION } from "./management";
import { visualViewportBounds } from "./galleryViewport";

type SelectionItem = { id: string; left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };
type Gesture = {
  pointerId: number;
  range: boolean;
  anchor: string | undefined;
  origin: Point;
  down: Point;
  point: Point;
  base: ReadonlySet<string>;
  additive: boolean;
  remove: boolean;
  dragging: boolean;
  last: ReadonlySet<string>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id));

export function useSelectionGestures(
  ref: RefObject<HTMLDivElement>, marqueeRef: RefObject<HTMLDivElement>,
  items: SelectionItem[], selection: GallerySelection | undefined, enabled: boolean,
) {
  const [dragging, setDragging] = useState(false);
  // Selection and pagination change during a drag; keep the listeners and its snapshot intact.
  const latest = useRef({ items, selection });
  latest.current = { items, selection };
  const available = enabled && Boolean(selection) && !selection?.disabled;

  useLayoutEffect(() => {
    const gallery = ref.current;
    const marquee = marqueeRef.current;
    if (!available || !gallery || !marquee) return;
    let gesture: Gesture | null = null;
    let frame = 0;
    let lastTime = 0;
    let dirty = false;
    let lastItems = items;
    let suppressClick = false;

    const finish = (restore = false) => {
      const current = gesture;
      gesture = null;
      cancelAnimationFrame(frame);
      frame = 0;
      marquee.hidden = true;
      delete gallery.dataset.selectionDragging;
      if (!current) return;
      if (gallery.hasPointerCapture(current.pointerId)) gallery.releasePointerCapture(current.pointerId);
      if (current.dragging) {
        setDragging(false);
        suppressClick = true;
        clearCardFeedback();
        if (restore) latest.current.selection?.change(current.base);
      }
    };

    const update = () => {
      const current = gesture;
      if (!current?.dragging) return;
      const rect = gallery.getBoundingClientRect();
      const point = {
        x: clamp(current.point.x - rect.left, 0, rect.width),
        y: clamp(current.point.y - rect.top, 0, rect.height),
      };
      const cards = latest.current.items;
      const next = new Set(current.range || current.additive ? current.base : []);
      const apply = (id: string) => {
        if (current.remove) next.delete(id);
        else if (next.size < MAX_SELECTION) next.add(id);
      };
      if (current.range) {
        const start = cards.findIndex(card => card.id === current.anchor);
        if (start < 0) { finish(true); return; }
        let end = start, closest = Infinity;
        // Nearest card also covers the small gaps between rows and columns.
        cards.forEach((card, index) => {
          const dx = Math.max(card.left - point.x, point.x - card.left - card.width, 0);
          const dy = Math.max(card.top - point.y, point.y - card.top - card.height, 0);
          const distance = dx * dx + dy * dy;
          if (distance < closest) { closest = distance; end = index; }
        });
        for (let index = Math.min(start, end); index <= Math.max(start, end); index++) apply(cards[index]!.id);
      } else {
        const left = Math.min(current.origin.x, point.x), top = Math.min(current.origin.y, point.y);
        const right = Math.max(current.origin.x, point.x), bottom = Math.max(current.origin.y, point.y);
        for (const card of cards) {
          if (card.left < right && card.left + card.width > left && card.top < bottom && card.top + card.height > top) apply(card.id);
        }
        marquee.hidden = false;
        Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(1, right - left)}px`, height: `${Math.max(1, bottom - top)}px` });
      }
      if (!sameIds(next, current.last)) {
        current.last = next;
        latest.current.selection?.change(next);
      }
    };

    const tick = (time: number) => {
      frame = 0;
      const current = gesture;
      if (!current?.dragging) return;
      const elapsed = Math.min(32, time - lastTime || 16);
      lastTime = time;
      const viewport = visualViewportBounds();
      const top = Math.max(viewport.top, document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0);
      const bottom = viewport.bottom;
      const rect = gallery.getBoundingClientRect();
      const edge = Math.min(64, (bottom - top) / 4);
      let speed = 0;
      if (edge > 0 && current.point.x >= rect.left - 24 && current.point.x <= rect.right + 24
        && current.point.y >= viewport.top && current.point.y <= viewport.bottom) {
        if (current.point.y < top + edge) speed = -clamp((top + edge - current.point.y) / edge, 0, 1);
        else if (current.point.y > bottom - edge) speed = clamp((current.point.y - bottom + edge) / edge, 0, 1);
      }
      if (speed) {
        const before = window.scrollY;
        window.scrollBy({ top: speed * elapsed * .75, behavior: "instant" });
        if (window.scrollY !== before) dirty = true;
      }
      if (dirty || lastItems !== latest.current.items) {
        dirty = false;
        lastItems = latest.current.items;
        update();
      }
      if (gesture?.dragging) frame = requestAnimationFrame(tick);
    };

    const down = (event: PointerEvent) => {
      if (gesture) { finish(true); return; }
      suppressClick = false;
      const target = event.target;
      const current = latest.current.selection;
      if (!current || current.disabled || !event.isPrimary || event.button !== 0 || event.altKey
        || !(target instanceof Element) || !gallery.contains(target)
        || target.closest('.photo-card-controls, [inert], [disabled]')
        || document.querySelector('dialog[open], .photo-card-menu:popover-open')) return;
      const range = event.pointerType !== "mouse";
      // Only the selector owns touch/pen dragging. The rest of each photo keeps native scrolling.
      if (range && !target.closest(".photo-card-select")) return;
      const rect = gallery.getBoundingClientRect();
      const card = target.closest<HTMLElement>(".image-card, .album-card, .album-folder");
      const anchor = card?.dataset.imageId ?? card?.dataset.albumPath;
      gesture = {
        pointerId: event.pointerId, range, anchor,
        origin: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        down: { x: event.clientX, y: event.clientY }, point: { x: event.clientX, y: event.clientY },
        base: new Set(current.ids),
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
        remove: range && Boolean(anchor && current.ids.has(anchor)),
        dragging: false, last: current.ids,
      };
    };
    const move = (event: PointerEvent) => {
      const current = gesture;
      if (!current || event.pointerId !== current.pointerId) return;
      if (event.pointerType === "mouse" && !(event.buttons & 1)) { finish(); return; }
      current.point = { x: event.clientX, y: event.clientY };
      if (!current.dragging) {
        if (Math.hypot(event.clientX - current.down.x, event.clientY - current.down.y) < (current.range ? 10 : 6)) return;
        current.dragging = true;
        setDragging(true);
        gallery.dataset.selectionDragging = current.range ? "range" : "box";
        clearCardFeedback();
        latest.current.selection?.change(current.base);
        gallery.setPointerCapture(event.pointerId);
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
      }
      event.preventDefault();
      dirty = true;
    };
    const up = (event: PointerEvent) => {
      if (gesture?.pointerId !== event.pointerId) return;
      gesture.point = { x: event.clientX, y: event.clientY };
      update();
      finish();
    };
    const cancelPointer = (event: PointerEvent) => { if (gesture?.pointerId === event.pointerId) finish(true); };
    const click = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const context = (event: Event) => {
      if (gesture?.dragging || gesture?.range || suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else finish();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture?.dragging) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    };
    const listeners = new AbortController();
    const { signal } = listeners;
    // Window capture consumes the click before card previews or the card's open handler.
    const capture = { capture: true, signal };
    window.addEventListener("pointerdown", down, capture);
    window.addEventListener("pointermove", move, { ...capture, passive: false });
    window.addEventListener("pointerup", up, capture);
    window.addEventListener("pointercancel", cancelPointer, capture);
    gallery.addEventListener("lostpointercapture", event => {
      // Taking over a touch releases the selector's implicit capture first.
      if (event.target === gallery) cancelPointer(event);
    }, { signal });
    window.addEventListener("click", click, capture);
    window.addEventListener("contextmenu", context, capture);
    window.addEventListener("keydown", key, capture);
    gallery.addEventListener("dragstart", event => { if (gesture) event.preventDefault(); }, { signal });
    // Prevent compatibility touch scrolling on browsers that still use Touch Events for panning.
    gallery.addEventListener("touchmove", event => { if (gesture?.range && event.cancelable) event.preventDefault(); }, { passive: false, signal });
    window.addEventListener("scroll", () => { dirty = true; }, { passive: true, signal });
    window.addEventListener("resize", () => { dirty = true; }, { signal });
    window.addEventListener("blur", () => finish(true), { signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) finish(true); }, { signal });
    return () => { finish(); listeners.abort(); };
  }, [available, ref, marqueeRef]);
  return dragging;
}
