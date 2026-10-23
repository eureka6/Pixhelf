import type { RefObject } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { galleryThumbnailLookahead } from "./galleryLoading";
import { visualViewportBounds, type GalleryViewportAnchor } from "./galleryViewport";
import type { JustifiedItem } from "./justified";
import type { GalleryImage } from "./types";

// Rows are ordered vertically; include every card in an intersecting row.
function galleryItemRange(items: readonly JustifiedItem<unknown>[], top: number, bottom: number) {
  const lowerBound = (after: (item: JustifiedItem<unknown>) => boolean) => {
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (after(items[middle])) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  return {
    start: lowerBound(item => item.style.top + item.style.height > top),
    end: lowerBound(item => item.style.top >= bottom),
  };
}

function focusedImageId(gallery: HTMLDivElement | null) {
  const card = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>(".image-card") : null;
  return card && gallery?.contains(card) ? card.dataset.imageId : undefined;
}

export function useGalleryWindow(
  ref: RefObject<HTMLDivElement>, items: JustifiedItem<GalleryImage>[],
  anchor: GalleryViewportAnchor | null, retainedImageId?: string | null,
) {
  const viewport = useRef({ top: 0, bottom: window.innerHeight });
  const [, refresh] = useState(0);
  const byId = useMemo(() => new Map(items.map(item => [item.image.id, item])), [items]);
  const overscan = galleryThumbnailLookahead();
  const resizedAnchor = anchor && byId.get(anchor.imageId);
  const height = resizedAnchor ? visualViewportBounds().height : 0;
  // Render the destination rows before the resize effect restores the anchor.
  const top = resizedAnchor
    ? resizedAnchor.style.top + resizedAnchor.style.height * anchor.cardRatio
      - height * anchor.viewportRatio
    : viewport.current.top;
  const bottom = resizedAnchor ? top + height : viewport.current.bottom;
  const range = galleryItemRange(items, top - overscan, bottom + overscan);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const focusedId = focusedImageId(ref.current);
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;

  useLayoutEffect(() => {
    const gallery = ref.current;
    if (!gallery) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = gallery.getBoundingClientRect();
      const visual = visualViewportBounds();
      viewport.current = { top: visual.top - bounds.top, bottom: visual.bottom - bounds.top };
      const lookahead = galleryThumbnailLookahead();
      const next = galleryItemRange(items, viewport.current.top - lookahead, viewport.current.bottom + lookahead);
      const nextFocused = focusedImageId(gallery);
      if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end || nextFocused !== focusedIdRef.current) {
        rangeRef.current = next;
        focusedIdRef.current = nextFocused;
        refresh(value => value + 1);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const resize = new ResizeObserver(schedule);
    // Content above the gallery can move it without changing the viewport.
    resize.observe(gallery.parentElement ?? gallery);
    const listeners = new AbortController();
    const options = { passive: true, signal: listeners.signal };
    window.addEventListener("scroll", schedule, options);
    window.addEventListener("resize", schedule, options);
    window.visualViewport?.addEventListener("resize", schedule, options);
    window.visualViewport?.addEventListener("scroll", schedule, options);
    gallery.addEventListener("focusin", schedule, options);
    gallery.addEventListener("focusout", schedule, options);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      listeners.abort();
    };
  }, [items, ref]);

  const visible = items.slice(range.start, range.end);
  for (const id of new Set([retainedImageId, focusedId, anchor?.imageId])) {
    const item = id ? byId.get(id) : undefined;
    if (item && (item.index < range.start || item.index >= range.end)) visible.push(item);
  }
  return visible.sort((a, b) => a.index - b.index);
}
