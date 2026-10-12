import type { RefObject } from "preact";
import { useCallback, useLayoutEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";
import { releaseViewerMedia } from "./viewerAssets";

const DISSOLVE_MS = 900;

type Transition = {
  imageId: string;
  request: number;
  layer: HTMLElement;
  animations: Animation[];
};

// Capture the displayed pixels once, at screen resolution, including GIFs and
// the mobile canvas renderer. A full stage backdrop also dissolves letterboxing.
function snapshotSlide(stage: HTMLElement, media: HTMLElement): HTMLElement | null {
  const bounds = media.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const canvas = document.createElement("canvas");
  const density = Math.min(window.devicePixelRatio || 1, 2, 2048 / Math.max(bounds.width, bounds.height));
  canvas.width = Math.max(1, Math.round(bounds.width * density));
  canvas.height = Math.max(1, Math.round(bounds.height * density));
  const context = canvas.getContext("2d");
  if (!context) return null;
  let drawn = false;
  for (const source of media.querySelectorAll<HTMLImageElement | HTMLCanvasElement>(":scope > img, :scope > canvas")) {
    const style = getComputedStyle(source);
    const opacity = Number(style.opacity);
    if (style.visibility === "hidden" || opacity <= 0 || (source instanceof HTMLImageElement ? !source.complete || !source.naturalWidth : !source.width || !source.height)) continue;
    try {
      context.globalAlpha = opacity;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      drawn = true;
    } catch { /* Another displayed layer can still supply the snapshot. */ }
  }

  // Live Photos render inside their own surface. Preserve the displayed motion
  // frame, including native aspect fitting and libmedia's MOV display matrix.
  const surface = media.querySelector<HTMLElement>('.media-preview[data-playing="true"] .media-player-surface');
  if (surface) {
    context.save();
    context.globalAlpha = 1;
    context.scale(canvas.width / media.clientWidth, canvas.height / media.clientHeight);
    context.translate(surface.offsetLeft + surface.clientWidth / 2, surface.offsetTop + surface.clientHeight / 2);
    const transform = getComputedStyle(surface).transform;
    if (transform !== "none") {
      const matrix = new DOMMatrix(transform);
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    for (const source of surface.querySelectorAll<HTMLCanvasElement | HTMLVideoElement>("canvas, video")) {
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) continue;
      const style = getComputedStyle(source);
      if (style.visibility === "hidden" || Number(style.opacity) <= 0) continue;
      const fit = style.objectFit;
      const scale = fit === "cover" ? Math.max(source.clientWidth / width, source.clientHeight / height)
        : Math.min(source.clientWidth / width, source.clientHeight / height);
      const w = fit === "fill" ? source.clientWidth : width * scale;
      const h = fit === "fill" ? source.clientHeight : height * scale;
      try {
        context.drawImage(source,
          source.offsetLeft - surface.clientWidth / 2 + (source.clientWidth - w) / 2,
          source.offsetTop - surface.clientHeight / 2 + (source.clientHeight - h) / 2, w, h);
        drawn = true;
      } catch { /* A different decoded layer can still provide the frame. */ }
    }
    context.restore();
  }
  if (!drawn) { canvas.width = canvas.height = 0; return null; }

  const origin = stage.getBoundingClientRect();
  const appearance = getComputedStyle(media);
  const frame = document.createElement("div");
  frame.className = "viewer-slideshow-snapshot";
  Object.assign(frame.style, {
    left: `${bounds.left - origin.left}px`, top: `${bounds.top - origin.top}px`,
    width: `${bounds.width}px`, height: `${bounds.height}px`,
    background: appearance.backgroundColor, border: appearance.border,
    borderRadius: appearance.borderRadius, boxShadow: appearance.boxShadow,
  });
  frame.append(canvas);
  const layer = document.createElement("div");
  layer.className = "viewer-slideshow-outgoing";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.append(frame);
  return layer;
}

export function useSlideshowTransition({ viewerRef, stageRef, mediaRef, imageId, request, ready, onOpen }: {
  viewerRef: RefObject<HTMLElement>;
  stageRef: RefObject<HTMLElement>;
  mediaRef: RefObject<HTMLElement>;
  imageId: string;
  request: number;
  ready: boolean;
  onOpen: (image: GalleryImage) => void;
}) {
  const transition = useRef<Transition | null>(null);
  const finish = useCallback(() => {
    const current = transition.current;
    transition.current = null;
    viewerRef.current?.removeAttribute("data-slideshow-transition");
    if (!current) return;
    current.animations.forEach(animation => animation.cancel());
    releaseViewerMedia(current.layer);
    current.layer.remove();
  }, [viewerRef]);

  useLayoutEffect(() => {
    const current = transition.current;
    if (!current) return;
    if (current.imageId !== imageId || current.request !== request) { finish(); return; }
    if (!ready || current.animations.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    const incoming = mediaRef.current;
    if (!incoming) { finish(); return; }
    // Keep the old frame fully opaque until the incoming photo or motion frame
    // has actually painted. Live playback proceeds underneath the dissolve.
    // Only the outgoing layer fades, so the midpoint never dips through black.
    viewerRef.current?.setAttribute("data-slideshow-transition", "dissolving");
    const dissolve = current.layer.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: DISSOLVE_MS, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "both",
    });
    const drift = incoming.animate([{ scale: "1.018" }, { scale: "1" }], {
      duration: DISSOLVE_MS, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "both",
    });
    current.animations.push(dissolve, drift);
    void dissolve.finished.then(() => {
      if (transition.current === current) finish();
    }, () => {});
  }, [imageId, request, ready, mediaRef, viewerRef, finish]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const controller = new AbortController();
    const { signal } = controller;
    // User input always takes over immediately, including during a slow load.
    for (const event of ["pointerdown", "wheel", "keydown", "contextmenu", "scroll"]) {
      viewer.addEventListener(event, finish, { signal, capture: true, passive: true });
    }
    for (const event of ["resize", "blur", "pagehide"]) window.addEventListener(event, finish, { signal });
    document.addEventListener("visibilitychange", finish, { signal });
    document.addEventListener("fullscreenchange", finish, { signal });
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", finish, { signal });
    return () => { controller.abort(); finish(); };
  }, [viewerRef, finish]);

  return (next: GalleryImage) => {
    finish();
    const stage = stageRef.current;
    const media = mediaRef.current;
    if (request && next.id !== imageId && stage && media) {
      const layer = snapshotSlide(stage, media);
      if (layer) {
        transition.current = { imageId: next.id, request, layer, animations: [] };
        viewerRef.current?.setAttribute("data-slideshow-transition", "waiting");
        stage.append(layer);
      }
    }
    onOpen(next);
  };
}
