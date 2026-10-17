import { constrainedNetwork } from "./networkPolicy";

export type ThumbnailPriority = "high" | "low" | "auto";

// A distant server needs more lead time for small thumbnails. Keep this
// separate from the policy that suppresses speculative multi-megabyte originals.
export function galleryThumbnailLookahead(): number {
  return Math.round(Math.min(2400, Math.max(1000, window.innerHeight * (constrainedNetwork() ? 2 : 1.5))));
}

export function galleryPageLookahead(): number {
  // Pagination and the thumbnails it discovers are two sequential requests.
  return galleryThumbnailLookahead() + Math.max(800, window.innerHeight);
}

const pending = new Map<Element, (priority: ThumbnailPriority) => void>();
let nearby: IntersectionObserver | undefined;
let visible: IntersectionObserver | undefined;

function onScreen(rect: DOMRectReadOnly): boolean {
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

function observeNearby() {
  nearby?.disconnect();
  nearby = new IntersectionObserver(entries => {
    // Start visible requests before warming rows outside the viewport.
    entries.sort((a, b) => Number(onScreen(b.boundingClientRect)) - Number(onScreen(a.boundingClientRect)));
    for (const entry of entries) {
      if (entry.isIntersecting) pending.get(entry.target)?.(onScreen(entry.boundingClientRect) ? "high" : "low");
    }
  }, { rootMargin: `${galleryThumbnailLookahead()}px 0px` });
  for (const element of pending.keys()) nearby.observe(element);
}

export function observeGalleryThumbnail(element: Element, load: (priority: ThumbnailPriority) => void): () => void {
  if (!("IntersectionObserver" in window)) {
    load("high");
    return () => {};
  }
  pending.set(element, load);
  if (!visible) {
    visible = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) pending.get(entry.target)?.("high");
    });
    observeNearby();
    window.addEventListener("resize", observeNearby);
  } else nearby!.observe(element);
  visible.observe(element);
  // Layout effects can start the whole first screen before the observer's next
  // delivery, and promote a pending low-priority request when it enters view.
  if (onScreen(element.getBoundingClientRect())) load("high");
  return () => {
    pending.delete(element);
    nearby?.unobserve(element);
    visible?.unobserve(element);
    if (!pending.size) {
      nearby?.disconnect();
      visible?.disconnect();
      nearby = visible = undefined;
      window.removeEventListener("resize", observeNearby);
    }
  };
}
