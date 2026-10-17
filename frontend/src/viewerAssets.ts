import type { GalleryImage } from "./types";
import { checkAuthentication } from "./auth";
import { clearViewerOriginalCache, getViewerOriginalBlob, getViewerOriginalSource, invalidateViewerOriginal } from "./viewerOriginalCache";
import { viewerOriginalUrl, viewerThumbnailUrl } from "./mediaUrls";
import { canPrefetchMedia, constrainedNetwork } from "./networkPolicy";
export { viewerOriginalUrl, viewerThumbnailUrl } from "./mediaUrls";

const THUMBNAIL_CACHE_LIMIT = 32;
const ORIGINAL_CACHE_LIMIT = 4;
const VIEWPORT_RENDER_CACHE_LIMIT = 4;
const THUMBNAIL_PRELOAD_DISTANCE = 10;
const ORIGINAL_PRELOAD_DISTANCE = 2;
const ASSET_LOAD_TIMEOUT_MS = 30_000;
// Fetch the next page before the thumbnail window needs its first image.
export const VIEWER_PAGE_PREFETCH_DISTANCE = THUMBNAIL_PRELOAD_DISTANCE * 2;

type AssetPriority = "high" | "low";

type ViewerAssetStatus = "loading" | "ready" | "failed";

type ViewerImageAsset = {
  element: HTMLImageElement;
  promise: Promise<void>;
  status: ViewerAssetStatus;
  lastUsed: number;
  cancel: () => void;
  release: () => void;
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
  timeout: number;
  resolve: () => void;
};

const thumbnailAssets = new Map<string, ViewerImageAsset>();
const originalAssets = new Map<string, ViewerImageAsset>();
const viewportRenderAssets = new Map<string, ViewerRenderAsset>();
const viewportRenderQueue: ViewportRenderJob[] = [];
let activeViewportRenderJob: ViewportRenderJob | null = null;
let assetClock = 0;
let originalPreloadGeneration = 0;

export function canPreloadViewerNeighbors(): boolean {
  return canPrefetchMedia();
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
  for (const [url, asset] of candidates) {
    if (cache.size <= limit) break;
    cache.delete(url);
    asset.release();
  }
}

function loadImageAsset(
  cache: Map<string, ViewerImageAsset>,
  url: string,
  limit: number,
  priority: AssetPriority,
): ViewerImageAsset {
  const cached = cache.get(url);
  // Retry failures on demand, not on every hover or speculative preload.
  if (cached && (cached.status !== "failed" || priority === "low")) {
    cached.lastUsed = ++assetClock;
    if (priority === "high") cached.element.fetchPriority = "high";
    return cached;
  }
  cached?.cancel();

  const element = new Image();
  const controller = new AbortController();
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
    cancel: () => {
      controller.abort();
      settle("failed");
      element.removeAttribute("src");
    },
    release: () => controller.abort(),
  };
  let settled = false;
  let timeout = 0;
  const settle = (status: Exclude<ViewerAssetStatus, "loading">) => {
    if (settled) return;
    settled = true;
    if (status === "failed") controller.abort();
    window.clearTimeout(timeout);
    element.removeEventListener("load", onLoad);
    element.removeEventListener("error", onError);
    asset.status = status;
    asset.lastUsed = ++assetClock;
    resolveAsset();
    pruneCache(cache, limit, url);
  };
  const onLoad = () => {
    const decoded = typeof element.decode === "function"
      ? element.decode().catch(() => undefined)
      : Promise.resolve();
    void decoded.then(() => {
      settle(element.naturalWidth > 0 ? "ready" : "failed");
    });
  };
  const onError = () => {
    if (settled) return;
    if (cache === originalAssets) invalidateViewerOriginal(url);
    settle("failed");
    // These preload elements are detached, so document-level image error handlers cannot see them.
    void checkAuthentication();
  };
  element.addEventListener("load", onLoad);
  element.addEventListener("error", onError);
  cache.set(url, asset);
  if (cache === originalAssets) {
    void getViewerOriginalSource(url, controller.signal, priority).then(source => {
      if (!settled) element.src = source;
    }).catch(onError);
  } else element.src = url;
  timeout = window.setTimeout(() => {
    if (settled) return;
    asset.cancel();
  }, ASSET_LOAD_TIMEOUT_MS);
  pruneCache(cache, limit, url);
  return asset;
}

function cancelUnusedPreloads(cache: Map<string, ViewerImageAsset>, needed: Set<string>): void {
  for (const [url, asset] of cache) {
    if (asset.status !== "loading" || needed.has(url.replace(/\?retry=\d+$/, ""))) continue;
    cache.delete(url);
    asset.cancel();
  }
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
  if (job.cancelled) return;
  job.cancelled = true;
  window.clearTimeout(job.timeout);
  job.controller.abort();
  job.asset.status = "failed";
  if (viewportRenderAssets.get(job.key) === job.asset) {
    viewportRenderAssets.delete(job.key);
  }
  // Settle consumers immediately even if the browser is still decoding. Keep
  // the active slot until that work ends, then close any late bitmap below.
  job.resolve();
}

function cancelUnusedViewportRenderJobs(needed: (job: ViewportRenderJob) => boolean): void {
  for (let index = viewportRenderQueue.length - 1; index >= 0; index -= 1) {
    const job = viewportRenderQueue[index]!;
    if (needed(job)) continue;
    viewportRenderQueue.splice(index, 1);
    cancelViewportRenderJob(job);
  }
  if (activeViewportRenderJob && !needed(activeViewportRenderJob)) {
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
    job.timeout = window.setTimeout(() => cancelViewportRenderJob(job), ASSET_LOAD_TIMEOUT_MS);
    try {
      const blob = await getViewerOriginalBlob(viewerOriginalUrl(image, attempt), controller.signal, asset.priority);
      if (job.cancelled) return;
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
      if (!job.cancelled) invalidateViewerOriginal(viewerOriginalUrl(image, attempt));
      asset.status = "failed";
    } finally {
      window.clearTimeout(job.timeout);
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
  if (priority === "high") cancelUnusedViewportRenderJobs(job => job.key === key);
  const cached = viewportRenderAssets.get(key);
  if (cached && (cached.status !== "failed" || priority === "low")) {
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
    timeout: 0,
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

export function suspendViewerPreloads(current: GalleryImage): void {
  originalPreloadGeneration++;
  cancelUnusedPreloads(thumbnailAssets, new Set([viewerThumbnailUrl(current)]));
  cancelUnusedPreloads(originalAssets, new Set([viewerOriginalUrl(current)]));
  cancelUnusedViewportRenderJobs(job => job.image.id === current.id);
}

export function releaseViewerAssets(): void {
  originalPreloadGeneration++;
  // Small, completed thumbnails remain bounded and useful in the gallery.
  cancelUnusedPreloads(thumbnailAssets, new Set());
  const originals = [...originalAssets.values()];
  originalAssets.clear();
  for (const asset of originals) asset.cancel();
  cancelUnusedViewportRenderJobs(() => false);
  for (const asset of viewportRenderAssets.values()) asset.bitmap?.close();
  viewportRenderAssets.clear();
  clearViewerOriginalCache();
}

export function releaseViewerMedia(container: ParentNode): void {
  // Detached images can keep downloading, and canvases retain their pixel buffers.
  container.querySelectorAll("img").forEach(image => {
    image.removeAttribute("srcset");
    image.removeAttribute("src");
  });
  container.querySelectorAll("canvas").forEach(canvas => {
    canvas.width = 0;
    canvas.height = 0;
  });
}

export function preloadOriginalImage(image: GalleryImage): void {
  if (
    image.video || supportsViewerViewportBitmaps()
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
  const generation = ++originalPreloadGeneration;
  const preloadOriginals = options.preloadOriginals
    ?? !supportsViewerViewportBitmaps();
  const preloadNeighbors = canPreloadViewerNeighbors();

  // Cache limits only evict completed images. Cancel obsolete downloads as well
  // so rapid navigation cannot leave a growing queue ahead of the current image.
  const thumbnailDistance = document.visibilityState !== "visible" ? 0 : constrainedNetwork() ? 2 : THUMBNAIL_PRELOAD_DISTANCE;
  const thumbnails = images.slice(Math.max(0, activeIndex - thumbnailDistance), activeIndex + thumbnailDistance + 1);
  cancelUnusedPreloads(thumbnailAssets, new Set(thumbnails.map(viewerThumbnailUrl)));
  const originalDistance = preloadNeighbors ? (preloadOriginals ? ORIGINAL_PRELOAD_DISTANCE : 1) : 0;
  const originals = images.slice(Math.max(0, activeIndex - originalDistance), activeIndex + originalDistance + 1);
  cancelUnusedPreloads(originalAssets, new Set(originals.map(image => viewerOriginalUrl(image))));
  const renderIds = new Set(images[activeIndex]!.video ? [] : originals.map(image => image.id));
  cancelUnusedViewportRenderJobs(job => renderIds.has(job.image.id));

  // Nearby thumbnails keep navigation responsive even when original speculation
  // is disabled. Only the current image competes at high priority.
  for (let distance = 0; distance <= thumbnailDistance; distance += 1) {
    const offsets = distance === 0 ? [0] : [distance, -distance];
    for (const offset of offsets) {
      const image = images[activeIndex + offset];
      if (image) preloadViewerThumbnail(image, distance === 0 ? "high" : "low");
    }
  }

  // Viewport-bitmap clients fetch compressed originals directly into bounded bitmaps.
  // Avoid also decoding the same originals into hidden HTMLImageElements.
  if (!preloadOriginals) return;

  // The active desktop original is always requested. Neighboring originals are
  // speculative and respect Save-Data/slow-network signals.
  const current = images[activeIndex]!;
  if (current.video) return;
  const active = getViewerOriginalAsset(current, 0, "high");
  if (!preloadNeighbors) return;
  // Finish the displayed photo first, then warm one original at a time. A
  // navigation/close/visibility change invalidates this queue synchronously.
  void (async () => {
    await active.promise;
    if (active.status !== "ready") return;
    for (let distance = 1; distance <= ORIGINAL_PRELOAD_DISTANCE; distance++) {
      for (const offset of [distance, -distance]) {
        if (generation !== originalPreloadGeneration || !canPreloadViewerNeighbors()) return;
        const image = images[activeIndex + offset];
        if (image && !image.video) await getViewerOriginalAsset(image, 0, "low").promise;
      }
    }
  })();
}
