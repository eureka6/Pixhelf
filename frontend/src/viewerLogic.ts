import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";

import type { GalleryImage } from "./types";
import { getViewerOriginalStatus, viewerOriginalUrl } from "./viewerAssets";

const MAX_NATIVE_IMAGE_EDGE = 12_288;
const MOBILE_VIEWPORT_RENDER_EDGE = 2048;

export type ViewerTransform = {
  scale: number;
  x: number;
  y: number;
};

export type PointerPoint = {
  x: number;
  y: number;
};

export type ViewerSourcePresentation = "direct" | "upgrade";

export type ViewerSourceStrategy = "viewport-upgrade" | "bounded-canvas" | "direct-original";

export type ViewerSourceState = {
  id: string;
  attempt: number;
  loaded: boolean;
  failed: boolean;
  presentation: ViewerSourcePresentation;
};

type ViewerDisplayState = {
  sourceLoaded: boolean;
  thumbnailLoaded: boolean;
  viewportBitmapRenderer: boolean;
  nativeOriginalActive: boolean;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export const DEFAULT_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };

function readViewportSize(): ViewportSize {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

export function useViewportSize(frameRef: RefObject<HTMLElement | null>): ViewportSize {
  const [size, setSize] = useState(readViewportSize);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      if (width <= 0 || height <= 0) return;
      setSize((previous) => previous.width === width && previous.height === height
        ? previous
        : { width, height });
    };
    // Browser chrome changes the visible area without resizing the image frame.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);
  return size;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function pointDistance(first: PointerPoint, second: PointerPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function pointMidpoint(first: PointerPoint, second: PointerPoint): PointerPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

export function rubberBand(distance: number, limit: number): number {
  if (!distance) return 0;
  return Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) / limit));
}

export function mouseSideDirection(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}

export function viewerMediaDimensions(
  image: GalleryImage,
  viewport: ViewportSize,
): { width: number; height: number } {
  const availableWidth = Math.max(1, viewport.width);
  const availableHeight = Math.max(1, viewport.height);
  const imageRatio = Math.max(1, image.width) / Math.max(1, image.height);
  const width = Math.min(availableWidth, availableHeight * imageRatio);
  return { width, height: width / imageRatio };
}

export function viewportRenderDimensions(
  image: GalleryImage,
  viewport: ViewportSize,
): { width: number; height: number } {
  const media = viewerMediaDimensions(image, viewport);
  const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const requestedWidth = media.width * density;
  const requestedHeight = media.height * density;
  const scale = Math.min(
    1,
    MOBILE_VIEWPORT_RENDER_EDGE / Math.max(1, requestedWidth, requestedHeight),
  );
  return {
    width: Math.max(1, Math.round(requestedWidth * scale)),
    height: Math.max(1, Math.round(requestedHeight * scale)),
  };
}

export function selectViewerSourceStrategy(
  image: GalleryImage,
  renderSize: ViewportSize,
  viewportBitmapsSupported: boolean,
): ViewerSourceStrategy {
  const sourceFitsViewport = image.width <= renderSize.width
    && image.height <= renderSize.height;
  if (viewportBitmapsSupported && !sourceFitsViewport) return "viewport-upgrade";
  if (Math.max(image.width, image.height) > MAX_NATIVE_IMAGE_EDGE) return "bounded-canvas";
  return "direct-original";
}

export function isDirectOriginalReady(
  image: GalleryImage,
  strategy: ViewerSourceStrategy,
  displayedSources: ReadonlySet<string>,
): boolean {
  return strategy === "direct-original" && (
    displayedSources.has(viewerOriginalUrl(image))
    || getViewerOriginalStatus(image) === "ready"
  );
}

export function initialViewerSourceState(id: string, ready: boolean): ViewerSourceState {
  return {
    id,
    attempt: 0,
    loaded: ready,
    failed: false,
    presentation: ready ? "direct" : "upgrade",
  };
}

export function pendingViewerSourceState(
  id: string,
  attempt: number,
  failed = false,
): ViewerSourceState {
  return { id, attempt, loaded: false, failed, presentation: "upgrade" };
}

export function resolveViewerDisplaySource({
  sourceLoaded,
  thumbnailLoaded,
  viewportBitmapRenderer,
  nativeOriginalActive,
}: ViewerDisplayState): "original" | "viewport-bitmap" | "thumbnail" | "placeholder" {
  if (nativeOriginalActive) return "original";
  if (sourceLoaded) return viewportBitmapRenderer ? "viewport-bitmap" : "original";
  return thumbnailLoaded ? "thumbnail" : "placeholder";
}

export function drawViewerCanvas(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
  sourceKey: string,
): void {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("canvas renderer is unavailable");
  const renderWidth = Math.max(1, Math.round(width));
  const renderHeight = Math.max(1, Math.round(height));
  canvas.width = renderWidth;
  canvas.height = renderHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, renderWidth, renderHeight);
  context.drawImage(source, 0, 0, renderWidth, renderHeight);
  canvas.dataset.renderedSource = sourceKey;
}
