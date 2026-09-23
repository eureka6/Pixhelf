export type ViewerAnchor = {
  cardRatio: number;
  viewportRatio: number;
  fallbackScrollY: number;
};

export type GalleryViewportAnchor = ViewerAnchor & {
  imageId: string;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function imageCardById(
  imageId: string,
  gallery: HTMLElement | null = document.querySelector(".justified-gallery"),
): HTMLElement | null {
  return gallery?.querySelector<HTMLElement>(
    `[data-image-id="${CSS.escape(imageId)}"].image-card, [data-image-id="${CSS.escape(imageId)}"].viewer-similar-card`,
  ) ?? null;
}

export function visualViewportBounds() {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = Math.max(1, viewport?.height ?? window.innerHeight);
  return { top, height, bottom: top + height };
}

function galleryViewportBounds(scrollRoot?: HTMLElement) {
  const visual = visualViewportBounds();
  const bounds = scrollRoot?.getBoundingClientRect();
  const top = bounds ? Math.max(visual.top, bounds.top) : visual.top;
  const bottom = bounds ? Math.min(visual.bottom, bounds.bottom) : visual.bottom;
  const viewport = { top, bottom, height: Math.max(1, bottom - top) };
  const toolbar = scrollRoot ? scrollRoot.querySelector(".viewer-details-toolbar, .video-details-header") : document.querySelector(".topbar");
  const toolbarBounds = toolbar?.getBoundingClientRect();
  const topbarBottom = toolbarBounds && (!scrollRoot || toolbarBounds.top < viewport.bottom) ? toolbarBounds.bottom : viewport.top;
  const safeTop = Math.min(viewport.bottom, Math.max(viewport.top, topbarBottom + 8));
  return { ...viewport, safeTop, safeBottom: Math.max(safeTop, viewport.bottom - 8) };
}

function anchorAtPoint(
  rect: DOMRect,
  viewport: ReturnType<typeof visualViewportBounds>,
  anchorY: number,
  scrollRoot?: HTMLElement,
): ViewerAnchor {
  return {
    cardRatio: rect.height > 0 ? clamp((anchorY - rect.top) / rect.height, 0, 1) : .5,
    viewportRatio: clamp((anchorY - viewport.top) / viewport.height, 0, 1),
    fallbackScrollY: scrollRoot?.scrollTop ?? window.scrollY,
  };
}

export function captureViewerAnchor(card: HTMLElement, pointerY?: number, scrollRoot?: HTMLElement): ViewerAnchor {
  const rect = card.getBoundingClientRect();
  const viewport = galleryViewportBounds(scrollRoot);
  const topbarBottom = viewport.safeTop - 8;
  const visibleTop = Math.max(rect.top, viewport.top, topbarBottom);
  const visibleBottom = Math.min(rect.bottom, viewport.bottom);
  const visibleCenter = visibleBottom > visibleTop
    ? (visibleTop + visibleBottom) / 2
    : clamp(rect.top + rect.height / 2, viewport.top, viewport.bottom);
  const requestedPoint = pointerY !== undefined && Number.isFinite(pointerY)
    ? pointerY
    : visibleCenter;
  const anchorY = clamp(
    requestedPoint,
    Math.min(visibleTop, visibleBottom),
    Math.max(visibleTop, visibleBottom),
  );
  return anchorAtPoint(rect, viewport, anchorY, scrollRoot);
}

export function captureGalleryViewportAnchor(gallery: HTMLElement): GalleryViewportAnchor | null {
  if (window.scrollY <= 1) return null;
  const viewport = galleryViewportBounds();
  const { safeTop, safeBottom } = viewport;
  const referenceY = safeTop + (safeBottom - safeTop) * .45;
  const viewportCenterX = (window.visualViewport?.offsetLeft ?? 0)
    + (window.visualViewport?.width ?? window.innerWidth) / 2;
  const focusedCard = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>(".image-card")
    : null;
  let selected: {
    card: HTMLElement;
    rect: DOMRect;
    verticalDistance: number;
    horizontalDistance: number;
  } | undefined;

  for (const card of gallery.querySelectorAll<HTMLElement>(".image-card")) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= safeTop || rect.top >= safeBottom) continue;
    const verticalDistance = Math.max(rect.top - referenceY, referenceY - rect.bottom, 0);
    const horizontalDistance = Math.abs(rect.left + rect.width / 2 - viewportCenterX);
    const candidate = { card, rect, verticalDistance, horizontalDistance };
    if (card === focusedCard) {
      selected = candidate;
      break;
    }
    if (
      !selected
      || verticalDistance < selected.verticalDistance
      || (verticalDistance === selected.verticalDistance
        && horizontalDistance < selected.horizontalDistance)
    ) selected = candidate;
  }
  if (!selected) return null;

  const visibleTop = Math.max(safeTop, selected.rect.top);
  const visibleBottom = Math.min(safeBottom, selected.rect.bottom);
  const anchorY = selected.card === focusedCard
    ? (visibleTop + visibleBottom) / 2
    : clamp(referenceY, visibleTop, visibleBottom);
  return {
    imageId: selected.card.dataset.imageId ?? "",
    ...anchorAtPoint(selected.rect, viewport, anchorY),
  };
}

export function scrollTopForAnchor(card: HTMLElement | null, anchor: ViewerAnchor, scrollRoot?: HTMLElement): number {
  let top = anchor.fallbackScrollY;
  if (card) {
    const rect = card.getBoundingClientRect();
    const viewport = galleryViewportBounds(scrollRoot);
    const desiredY = clamp(
      viewport.top + anchor.viewportRatio * viewport.height,
      viewport.safeTop,
      viewport.safeBottom,
    );
    const actualY = rect.top + rect.height * anchor.cardRatio;
    top = (scrollRoot?.scrollTop ?? window.scrollY) + actualY - desiredY;
  }
  if (scrollRoot) return clamp(top, 0, Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight));
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  );
  return clamp(top, 0, Math.max(0, documentHeight - window.innerHeight));
}

export function restoreGalleryViewportAnchor(
  gallery: HTMLElement,
  anchor: GalleryViewportAnchor,
): void {
  scrollWindowImmediately(scrollTopForAnchor(imageCardById(anchor.imageId, gallery), anchor));
}

export function scrollWindowImmediately(top: number): void {
  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo({ top, left: window.scrollX, behavior: "auto" });
  root.style.scrollBehavior = previousBehavior;
}
