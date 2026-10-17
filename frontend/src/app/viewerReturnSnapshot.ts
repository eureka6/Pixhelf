import { visualViewportBounds } from "../galleryViewport";
import { releaseViewerMedia } from "../viewerAssets";

export type ViewerReturnFlight = {
  layer: HTMLDivElement;
  backdrop: HTMLDivElement;
  media: HTMLElement;
  source: DOMRect;
  visible: boolean;
  animations: Animation[];
};

export function disposeViewerReturnFlight(flight: ViewerReturnFlight | null): void {
  if (!flight) return;
  for (const animation of flight.animations) animation.cancel();
  releaseViewerMedia(flight.layer);
  flight.layer.remove();
}

export function createViewerReturnFlight(): ViewerReturnFlight | null {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const viewer = document.querySelector<HTMLElement>(".image-viewer");
  const media = viewer?.querySelector<HTMLElement>(".viewer-media");
  if (!viewer || !media) return null;

  const sourceRect = media.getBoundingClientRect();
  if (sourceRect.width <= 0 || sourceRect.height <= 0) return null;
  const viewport = visualViewportBounds();
  const visible = Math.min(sourceRect.bottom, viewport.bottom) - Math.max(sourceRect.top, viewport.top) > 2;
  const mediaStyle = getComputedStyle(media);

  const layer = document.createElement("div");
  layer.className = "viewer-return-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.dataset.phase = "settling";
  layer.dataset.imageId = viewer.dataset.imageId ?? "";
  layer.dataset.createdAt = String(performance.now());
  const backdrop = document.createElement("div");
  backdrop.className = "viewer-return-backdrop";
  const clone = media.cloneNode(false) as HTMLElement;
  clone.className = "viewer-media viewer-return-media";
  clone.removeAttribute("ref");
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    transform: "none",
    translate: "none",
    transformOrigin: "top left",
    transition: "none",
    animation: "none",
    opacity: "1",
    borderRadius: mediaStyle.borderRadius,
    boxShadow: mediaStyle.boxShadow,
  });

  // Preserve the layers actually on screen, including mobile bitmaps and an
  // in-flight original-image fade. Copy canvas pixels only once.
  const sources = visible
    ? media.querySelectorAll<HTMLImageElement | HTMLCanvasElement>(":scope > img, :scope > canvas") : [];
  for (const source of sources) {
    const style = getComputedStyle(source);
    if (Number(style.opacity) <= 0) continue;
    let visual: HTMLImageElement | HTMLCanvasElement;
    if (source instanceof HTMLCanvasElement) {
      if (!source.width || !source.height) continue;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1440 / Math.max(source.width, source.height));
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      visual = canvas;
    } else {
      if (!source.complete || !source.naturalWidth) continue;
      visual = source.cloneNode(false) as HTMLImageElement;
      visual.alt = "";
    }
    visual.className = "viewer-return-visual";
    visual.draggable = false;
    Object.assign(visual.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: style.objectFit,
      opacity: style.opacity,
      filter: "none",
      transform: "none",
      transition: "none",
    });
    clone.append(visual);
  }
  // Fade any visible details with the backdrop, including a partially scrolled page.
  if (!visible) clone.style.display = "none";
  const details = viewer.querySelector<HTMLElement>(".viewer-details-page");
  if (details) {
    const bounds = details.getBoundingClientRect();
    if (bounds.top < viewport.bottom && bounds.bottom > viewport.top) {
      const snapshot = details.cloneNode(true) as HTMLElement;
      Object.assign(snapshot.style, { position: "absolute", left: `${bounds.left}px`,
        top: `${bounds.top}px`, width: `${bounds.width}px` });
      backdrop.append(snapshot);
    }
  }

  layer.append(backdrop, clone);
  document.body.append(layer);
  return { layer, backdrop, media: clone, source: sourceRect, visible, animations: [] };
}
