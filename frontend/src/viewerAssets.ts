import type { GalleryImage } from "./types";
import { authentication, checkAuthentication, requireLogin } from "./auth";

const THUMBNAIL_CACHE_LIMIT = 32;
const ORIGINAL_CACHE_LIMIT = 4;
const VIEWPORT_RENDER_CACHE_LIMIT = 4;
const THUMBNAIL_PRELOAD_DISTANCE = 10;
const ORIGINAL_PRELOAD_DISTANCE = 2;
const ASSET_LOAD_TIMEOUT_MS = 30_000;

type AssetPriority = "high" | "low";

type NetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
};

type ViewerAssetStatus = "loading" | "ready" | "failed";

type ViewerImageAsset = {
  element: HTMLImageElement;
  promise: Promise<void>;
  status: ViewerAssetStatus;
  lastUsed: number;
};

type ViewerRenderAsset = {
  bitmap: ImageBitmap | null;
  promise: Promise<void>;
  status: ViewerAssetStatus;
  width: number;
  height: number;
  priority: AssetPriority;
  lastUsed: number;
};

type ViewportRenderJob = {
  asset: ViewerRenderAsset;
  image: GalleryImage;
  attempt: number;
  key: string;
  controller: AbortController;
  cancelled: boolean;
  resolve: () => void;
};

const thumbnailAssets = new Map<string, ViewerImageAsset>();
const originalAssets = new Map<string, ViewerImageAsset>();
const viewportRenderAssets = new Map<string, ViewerRenderAsset>();
const viewportRenderQueue: ViewportRenderJob[] = [];
let activeViewportRenderJob: ViewportRenderJob | null = null;
let assetClock = 0;

export function viewerThumbnailUrl(image: GalleryImage): string {
  return `/api/images/${encodeURIComponent(image.id)}/thumbnail`;
}

export function viewerOriginalUrl(image: GalleryImage, attempt = 0): string {
  const url = `/api/images/${encodeURIComponent(image.id)}/original`;
  return attempt ? `${url}?retry=${attempt}` : url;
}

export function canPreloadViewerNeighbors(): boolean {
  if (document.visibilityState !== "visible") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (connection?.saveData) return false;
  return connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

export function supportsViewerViewportBitmaps(): boolean {
  if (typeof createImageBitmap !== "function") return false;
  if (window.innerWidth <= 720) return true;
  return navigator.maxTouchPoints > 0
    && window.matchMedia("(pointer: coarse)").matches;
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
  priority: AssetPriority,
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
  let timeout = 0;
  const settle = (status: Exclude<ViewerAssetStatus, "loading">) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
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
  element.addEventListener("error", () => {
    settle("failed");
    // These preload elements are detached, so document-level image error handlers cannot see them.
    void checkAuthentication();
  }, { once: true });
  cache.set(url, asset);
  element.src = url;
  timeout = window.setTimeout(() => {
    if (settled) return;
    element.removeAttribute("src");
    settle("failed");
  }, ASSET_LOAD_TIMEOUT_MS);
  pruneCache(cache, limit, url);
  return asset;
}

function preloadViewerThumbnail(
  image: GalleryImage,
  priority: AssetPriority,
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
  priority: AssetPriority = "high",
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

function viewportRenderRequest(
  image: GalleryImage,
  width: number,
  height: number,
  attempt: number,
): { key: string; width: number; height: number } {
  const renderWidth = Math.max(1, Math.round(width));
  const renderHeight = Math.max(1, Math.round(height));
  return {
    key: `${viewerOriginalUrl(image, attempt)}@${renderWidth}x${renderHeight}`,
    width: renderWidth,
    height: renderHeight,
  };
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

function cancelViewportRenderJob(job: ViewportRenderJob): void {
  job.cancelled = true;
  job.controller.abort();
  job.asset.status = "failed";
  if (viewportRenderAssets.get(job.key) === job.asset) {
    viewportRenderAssets.delete(job.key);
  }
}

function cancelStaleViewportRenderJobs(activeKey: string): void {
  for (let index = viewportRenderQueue.length - 1; index >= 0; index -= 1) {
    const job = viewportRenderQueue[index]!;
    if (job.key === activeKey) continue;
    viewportRenderQueue.splice(index, 1);
    cancelViewportRenderJob(job);
    job.resolve();
  }
  if (activeViewportRenderJob && activeViewportRenderJob.key !== activeKey) {
    cancelViewportRenderJob(activeViewportRenderJob);
  }
}

function startNextViewportRenderJob(): void {
  if (activeViewportRenderJob || viewportRenderQueue.length === 0) return;
  viewportRenderQueue.sort((first, second) => {
    if (first.asset.priority !== second.asset.priority) {
      return first.asset.priority === "high" ? -1 : 1;
    }
    return second.asset.lastUsed - first.asset.lastUsed;
  });
  const job = viewportRenderQueue.shift()!;
  activeViewportRenderJob = job;
  void (async () => {
    const { asset, attempt, controller, image, key, resolve } = job;
    const timeout = window.setTimeout(() => controller.abort(), ASSET_LOAD_TIMEOUT_MS);
    try {
      const requestOptions: RequestInit & { priority: "high" | "low" } = {
        cache: authentication.enabled ? "no-cache" : attempt ? "reload" : "force-cache",
        credentials: "same-origin",
        priority: asset.priority,
        signal: controller.signal,
      };
      const response = await fetch(viewerOriginalUrl(image, attempt), requestOptions);
      if (!response.ok) {
        if (response.status === 401) requireLogin();
        throw new Error(`original request failed: ${response.status}`);
      }
      if (!response.headers.get("content-type")?.startsWith("image/")) {
        throw new Error("original response is not an image");
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("original response is empty");
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        resizeWidth: asset.width,
        resizeHeight: asset.height,
        resizeQuality: "high",
      });
      if (job.cancelled) {
        bitmap.close();
        return;
      }
      asset.bitmap = bitmap;
      asset.status = "ready";
    } catch {
      asset.status = "failed";
    } finally {
      window.clearTimeout(timeout);
      if (job.cancelled) {
        asset.bitmap?.close();
        asset.bitmap = null;
        asset.status = "failed";
        if (viewportRenderAssets.get(key) === asset) viewportRenderAssets.delete(key);
      }
      asset.lastUsed = ++assetClock;
      if (activeViewportRenderJob === job) activeViewportRenderJob = null;
      resolve();
      pruneViewportRenderCache(key);
      startNextViewportRenderJob();
    }
  })();
}

export function getViewerViewportRenderAsset(
  image: GalleryImage,
  width: number,
  height: number,
  attempt = 0,
  priority: AssetPriority = "high",
): ViewerRenderAsset {
  const request = viewportRenderRequest(image, width, height, attempt);
  const { key } = request;
  if (priority === "high") cancelStaleViewportRenderJobs(key);
  const cached = viewportRenderAssets.get(key);
  if (cached) {
    cached.lastUsed = ++assetClock;
    if (priority === "high") cached.priority = "high";
    startNextViewportRenderJob();
    return cached;
  }

  let resolveAsset: () => void = () => undefined;
  const asset: ViewerRenderAsset = {
    bitmap: null,
    promise: new Promise<void>((resolve) => {
      resolveAsset = resolve;
    }),
    status: "loading",
    width: request.width,
    height: request.height,
    priority,
    lastUsed: ++assetClock,
  };
  viewportRenderAssets.set(key, asset);
  // Decode the compressed response straight into the viewport-sized bitmap. Using an
  // HTMLImageElement here keeps the *full* decoded original alive as well; a single
  // high-resolution phone photo can otherwise retain hundreds of megabytes while the
  // user is swiping through neighboring images.
  viewportRenderQueue.push({
    asset,
    image,
    attempt,
    key,
    controller: new AbortController(),
    cancelled: false,
    resolve: resolveAsset,
  });
  startNextViewportRenderJob();
  pruneViewportRenderCache(key);
  return asset;
}

export function getReadyViewerViewportRenderAsset(
  image: GalleryImage,
  width: number,
  height: number,
  attempt = 0,
): ViewerRenderAsset | null {
  const { key } = viewportRenderRequest(image, width, height, attempt);
  const asset = viewportRenderAssets.get(key);
  if (asset?.status !== "ready" || !asset.bitmap) return null;
  asset.lastUsed = ++assetClock;
  return asset;
}

export function getDecodedViewerOriginal(source: string): HTMLImageElement | null {
  const parsed = new URL(source, window.location.href);
  const asset = originalAssets.get(`${parsed.pathname}${parsed.search}`);
  return asset?.status === "ready" ? asset.element : null;
}

export function preloadOriginalImage(image: GalleryImage): void {
  if (
    supportsViewerViewportBitmaps()
    || !canPreloadViewerNeighbors()
  ) return;
  getViewerOriginalAsset(image, 0, "low");
}

export function prepareViewerImages(
  images: GalleryImage[],
  activeIndex: number,
  options: { preloadOriginals?: boolean } = {},
): void {
  if (activeIndex < 0 || activeIndex >= images.length) return;
  const preloadOriginals = options.preloadOriginals
    ?? !supportsViewerViewportBitmaps();

  // Thumbnail preparation is deliberately independent from masonry visibility. It is
  // cheap enough to keep a generous navigation window decoded even on constrained links.
  for (let distance = 0; distance <= THUMBNAIL_PRELOAD_DISTANCE; distance += 1) {
    const offsets = distance === 0 ? [0] : [distance, -distance];
    for (const offset of offsets) {
      const image = images[activeIndex + offset];
      if (image) preloadViewerThumbnail(image, distance <= 2 ? "high" : "low");
    }
  }

  // Viewport-bitmap clients fetch compressed originals directly into bounded bitmaps.
  // Avoid also decoding the same originals into hidden HTMLImageElements.
  if (!preloadOriginals) return;

  // The active desktop original is always requested. Neighboring originals are
  // speculative and respect Save-Data/slow-network signals.
  getViewerOriginalAsset(images[activeIndex]!, 0, "high");
  if (!canPreloadViewerNeighbors()) return;
  for (let distance = 1; distance <= ORIGINAL_PRELOAD_DISTANCE; distance += 1) {
    const next = images[activeIndex + distance];
    const previous = images[activeIndex - distance];
    if (next) getViewerOriginalAsset(next, 0, distance === 1 ? "high" : "low");
    if (previous) getViewerOriginalAsset(previous, 0, distance === 1 ? "high" : "low");
  }
}
