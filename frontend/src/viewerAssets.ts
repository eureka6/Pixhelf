import type { GalleryImage } from "./types";

const THUMBNAIL_CACHE_LIMIT = 32;
const ORIGINAL_CACHE_LIMIT = 8;
const VIEWPORT_RENDER_CACHE_LIMIT = 4;
const THUMBNAIL_PRELOAD_DISTANCE = 10;
const ORIGINAL_PRELOAD_DISTANCE = 2;

type NetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
};

export type ViewerAssetStatus = "loading" | "ready" | "failed";

export type ViewerImageAsset = {
  element: HTMLImageElement;
  promise: Promise<void>;
  status: ViewerAssetStatus;
  lastUsed: number;
};

export type ViewerRenderAsset = {
  bitmap: ImageBitmap | null;
  promise: Promise<void>;
  status: ViewerAssetStatus;
  width: number;
  height: number;
  lastUsed: number;
};

const thumbnailAssets = new Map<string, ViewerImageAsset>();
const originalAssets = new Map<string, ViewerImageAsset>();
const viewportRenderAssets = new Map<string, ViewerRenderAsset>();
let assetClock = 0;

export function viewerThumbnailUrl(image: GalleryImage): string {
  return `/api/images/${encodeURIComponent(image.id)}/thumbnail`;
}

export function viewerOriginalUrl(image: GalleryImage, attempt = 0): string {
  const url = `/api/images/${encodeURIComponent(image.id)}/original`;
  return attempt ? `${url}?retry=${attempt}` : url;
}

function canSpeculativelyPreloadOriginals(): boolean {
  if (document.visibilityState !== "visible") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (connection?.saveData) return false;
  return connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

function pruneCache(
  cache: Map<string, ViewerImageAsset>,
  limit: number,
  protectedUrl?: string,
): void {
  if (cache.size <= limit) return;
  const candidates = [...cache.entries()]
    .filter(([url, asset]) => url !== protectedUrl && asset.status !== "loading")
    .sort(([, first], [, second]) => first.lastUsed - second.lastUsed);
  for (const [url] of candidates) {
    if (cache.size <= limit) break;
    cache.delete(url);
  }
}

function loadImageAsset(
  cache: Map<string, ViewerImageAsset>,
  url: string,
  limit: number,
  priority: "high" | "low",
): ViewerImageAsset {
  const cached = cache.get(url);
  if (cached) {
    cached.lastUsed = ++assetClock;
    if (priority === "high") cached.element.fetchPriority = "high";
    return cached;
  }

  const element = new Image();
  element.decoding = "async";
  element.fetchPriority = priority;
  let resolveAsset: () => void = () => undefined;
  const asset: ViewerImageAsset = {
    element,
    promise: new Promise<void>((resolve) => {
      resolveAsset = resolve;
    }),
    status: "loading",
    lastUsed: ++assetClock,
  };
  let settled = false;
  const settle = (status: Exclude<ViewerAssetStatus, "loading">) => {
    if (settled) return;
    settled = true;
    asset.status = status;
    asset.lastUsed = ++assetClock;
    resolveAsset();
    pruneCache(cache, limit, url);
  };
  element.addEventListener("load", () => {
    const decoded = typeof element.decode === "function"
      ? element.decode().catch(() => undefined)
      : Promise.resolve();
    void decoded.then(() => {
      settle(element.naturalWidth > 0 ? "ready" : "failed");
    });
  }, { once: true });
  element.addEventListener("error", () => settle("failed"), { once: true });
  cache.set(url, asset);
  element.src = url;
  pruneCache(cache, limit, url);
  return asset;
}

export function preloadViewerThumbnail(
  image: GalleryImage,
  priority: "high" | "low" = "low",
): ViewerImageAsset {
  return loadImageAsset(
    thumbnailAssets,
    viewerThumbnailUrl(image),
    THUMBNAIL_CACHE_LIMIT,
    priority,
  );
}

export function getViewerThumbnailStatus(image: GalleryImage): ViewerAssetStatus | "idle" {
  return thumbnailAssets.get(viewerThumbnailUrl(image))?.status ?? "idle";
}

export function getViewerOriginalAsset(
  image: GalleryImage,
  attempt = 0,
  priority: "high" | "low" = "high",
): ViewerImageAsset {
  return loadImageAsset(
    originalAssets,
    viewerOriginalUrl(image, attempt),
    ORIGINAL_CACHE_LIMIT,
    priority,
  );
}

export function getViewerOriginalStatus(
  image: GalleryImage,
  attempt = 0,
): ViewerAssetStatus | "idle" {
  return originalAssets.get(viewerOriginalUrl(image, attempt))?.status ?? "idle";
}

function viewportRenderKey(
  image: GalleryImage,
  width: number,
  height: number,
  attempt: number,
): string {
  return `${viewerOriginalUrl(image, attempt)}@${width}x${height}`;
}

function pruneViewportRenderCache(protectedKey?: string): void {
  if (viewportRenderAssets.size <= VIEWPORT_RENDER_CACHE_LIMIT) return;
  const candidates = [...viewportRenderAssets.entries()]
    .filter(([key, asset]) => key !== protectedKey && asset.status !== "loading")
    .sort(([, first], [, second]) => first.lastUsed - second.lastUsed);
  for (const [key, asset] of candidates) {
    if (viewportRenderAssets.size <= VIEWPORT_RENDER_CACHE_LIMIT) break;
    asset.bitmap?.close();
    viewportRenderAssets.delete(key);
  }
}

export function getViewerViewportRenderAsset(
  image: GalleryImage,
  width: number,
  height: number,
  attempt = 0,
  priority: "high" | "low" = "high",
): ViewerRenderAsset {
  const renderWidth = Math.max(1, Math.round(width));
  const renderHeight = Math.max(1, Math.round(height));
  const key = viewportRenderKey(image, renderWidth, renderHeight, attempt);
  const cached = viewportRenderAssets.get(key);
  if (cached) {
    cached.lastUsed = ++assetClock;
    return cached;
  }

  let resolveAsset: () => void = () => undefined;
  const asset: ViewerRenderAsset = {
    bitmap: null,
    promise: new Promise<void>((resolve) => {
      resolveAsset = resolve;
    }),
    status: "loading",
    width: renderWidth,
    height: renderHeight,
    lastUsed: ++assetClock,
  };
  viewportRenderAssets.set(key, asset);
  const original = getViewerOriginalAsset(image, attempt, priority);
  void original.promise.then(async () => {
    try {
      if (original.status !== "ready" || typeof createImageBitmap !== "function") {
        asset.status = "failed";
        return;
      }
      asset.bitmap = await createImageBitmap(original.element, {
        resizeWidth: renderWidth,
        resizeHeight: renderHeight,
        resizeQuality: "high",
      });
      asset.status = "ready";
    } catch {
      asset.status = "failed";
    } finally {
      asset.lastUsed = ++assetClock;
      resolveAsset();
      pruneViewportRenderCache(key);
    }
  });
  pruneViewportRenderCache(key);
  return asset;
}

export function getViewerViewportRenderStatus(
  image: GalleryImage,
  width: number,
  height: number,
  attempt = 0,
): ViewerAssetStatus | "idle" {
  const key = viewportRenderKey(
    image,
    Math.max(1, Math.round(width)),
    Math.max(1, Math.round(height)),
    attempt,
  );
  return viewportRenderAssets.get(key)?.status ?? "idle";
}

export function getDecodedViewerOriginal(source: string): HTMLImageElement | null {
  const parsed = new URL(source, window.location.href);
  const asset = originalAssets.get(`${parsed.pathname}${parsed.search}`);
  return asset?.status === "ready" ? asset.element : null;
}

export function preloadOriginalImage(image: GalleryImage): void {
  if (!canSpeculativelyPreloadOriginals()) return;
  getViewerOriginalAsset(image, 0, "low");
}

export function prepareViewerImages(images: GalleryImage[], activeIndex: number): void {
  if (activeIndex < 0 || activeIndex >= images.length) return;

  // Thumbnail preparation is deliberately independent from masonry visibility. It is
  // cheap enough to keep a generous navigation window decoded even on constrained links.
  for (let distance = 0; distance <= THUMBNAIL_PRELOAD_DISTANCE; distance += 1) {
    const offsets = distance === 0 ? [0] : [distance, -distance];
    for (const offset of offsets) {
      const image = images[activeIndex + offset];
      if (image) preloadViewerThumbnail(image, distance <= 2 ? "high" : "low");
    }
  }

  // The active original is always requested. Neighboring originals are speculative and
  // respect Save-Data/slow-network signals; their thumbnails remain available either way.
  getViewerOriginalAsset(images[activeIndex]!, 0, "high");
  if (!canSpeculativelyPreloadOriginals()) return;
  for (let distance = 1; distance <= ORIGINAL_PRELOAD_DISTANCE; distance += 1) {
    const next = images[activeIndex + distance];
    const previous = images[activeIndex - distance];
    if (next) getViewerOriginalAsset(next, 0, distance === 1 ? "high" : "low");
    if (previous) getViewerOriginalAsset(previous, 0, distance === 1 ? "high" : "low");
  }
}
