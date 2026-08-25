import {
  Check,
  Dices,
  Folder,
  ImageIcon,
  Images,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  X,
} from "./icons";
import type { CSSProperties, RefObject } from "preact";
import { memo } from "preact/compat";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { ToolbarPopover } from "./ToolbarPopover";
import { ImageViewer } from "./ImageViewer";
import { getGallery, getImages, getStatus, takeInitialBootstrap } from "./api";
import type {
  GalleryImage,
  GallerySummary,
  ThumbnailStatus,
} from "./types";
import {
  getDecodedViewerOriginal,
  preloadOriginalImage,
  prepareViewerImages,
  viewerThumbnailUrl,
} from "./viewerAssets";

const PAGE_SIZE = 60;
const CARD_PREFETCH_MARGIN = "1200px 0px";
const MOBILE_PAGE_PREFETCH_MARGIN = "1400px 0px";
const DESKTOP_PAGE_PREFETCH_MARGIN = "900px 0px";
const SIDEBAR_STORAGE_KEY = "pixhelf.sidebar-collapsed";
const GALLERY_POLL_INTERVAL_MS = 10_000;
const IMAGE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MOBILE_NAV_EXIT_MS = 240;
const VIEWER_RETURN_SETTLE_MS = 32;
const VIEWER_RETURN_TIMEOUT_MS = 480;
const VIEWER_RETURN_ANIMATION_MS = 260;
const READY_THUMBNAIL_CACHE_LIMIT = 2048;
const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");
const INITIAL_BOOTSTRAP = takeInitialBootstrap();

type ImagePageState = {
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

type ViewerAnchor = {
  cardRatio: number;
  viewportRatio: number;
  fallbackScrollY: number;
};

type ViewerReturnRequest = ViewerAnchor & {
  imageId: string;
  sequence: number;
};

type MasonryViewportAnchor = ViewerAnchor & {
  imageId: string;
};

type ViewerReturnFlight = {
  layer: HTMLDivElement;
  backdrop: HTMLDivElement;
  media: HTMLElement;
  animations: Animation[];
};

const EMPTY_IMAGE_PAGE: ImagePageState = {
  images: [],
  total: 0,
  nextOffset: null,
};

function clampValue(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function imageCardById(imageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.masonry .image-card[data-image-id="${CSS.escape(imageId)}"]`,
  );
}

function visualViewportBounds(): { top: number; height: number } {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    height: Math.max(1, viewport?.height ?? window.innerHeight),
  };
}

function captureViewerAnchor(card: HTMLElement, pointerY?: number): ViewerAnchor {
  const rect = card.getBoundingClientRect();
  const viewport = visualViewportBounds();
  const viewportBottom = viewport.top + viewport.height;
  const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
    ?? viewport.top;
  const visibleTop = Math.max(rect.top, viewport.top, topbarBottom);
  const visibleBottom = Math.min(rect.bottom, viewportBottom);
  const visibleCenter = visibleBottom > visibleTop
    ? (visibleTop + visibleBottom) / 2
    : clampValue(rect.top + rect.height / 2, viewport.top, viewportBottom);
  const requestedPoint = pointerY !== undefined && Number.isFinite(pointerY)
    ? pointerY
    : visibleCenter;
  const anchorY = clampValue(
    requestedPoint,
    Math.min(visibleTop, visibleBottom),
    Math.max(visibleTop, visibleBottom),
  );
  return {
    cardRatio: rect.height > 0
      ? clampValue((anchorY - rect.top) / rect.height, 0, 1)
      : 0.5,
    viewportRatio: clampValue((anchorY - viewport.top) / viewport.height, 0, 1),
    fallbackScrollY: window.scrollY,
  };
}

function captureMasonryViewportAnchor(masonry: HTMLElement): MasonryViewportAnchor | null {
  if (window.scrollY <= 1) return null;
  const viewport = visualViewportBounds();
  const viewportBottom = viewport.top + viewport.height;
  const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
    ?? viewport.top;
  const safeTop = Math.min(viewportBottom, Math.max(viewport.top, topbarBottom + 8));
  const safeBottom = Math.max(safeTop, viewportBottom - 8);
  const referenceY = safeTop + (safeBottom - safeTop) * .45;
  const viewportCenterX = (window.visualViewport?.offsetLeft ?? 0)
    + (window.visualViewport?.width ?? window.innerWidth) / 2;
  const cards = [...masonry.querySelectorAll<HTMLElement>(".image-card")]
    .map((card) => ({ card, rect: card.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > safeTop && rect.top < safeBottom);
  if (!cards.length) return null;

  const focusedCard = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>(".image-card")
    : null;
  const focused = focusedCard
    ? cards.find(({ card }) => card === focusedCard)
    : undefined;
  const selected = focused ?? cards.reduce((best, candidate) => {
    const verticalDistance = candidate.rect.top <= referenceY
      && candidate.rect.bottom >= referenceY
      ? 0
      : Math.min(
        Math.abs(candidate.rect.top - referenceY),
        Math.abs(candidate.rect.bottom - referenceY),
      );
    const bestVerticalDistance = best.rect.top <= referenceY
      && best.rect.bottom >= referenceY
      ? 0
      : Math.min(
        Math.abs(best.rect.top - referenceY),
        Math.abs(best.rect.bottom - referenceY),
      );
    if (verticalDistance !== bestVerticalDistance) {
      return verticalDistance < bestVerticalDistance ? candidate : best;
    }
    const horizontalDistance = Math.abs(
      candidate.rect.left + candidate.rect.width / 2 - viewportCenterX,
    );
    const bestHorizontalDistance = Math.abs(
      best.rect.left + best.rect.width / 2 - viewportCenterX,
    );
    return horizontalDistance < bestHorizontalDistance ? candidate : best;
  });
  const visibleTop = Math.max(safeTop, selected.rect.top);
  const visibleBottom = Math.min(safeBottom, selected.rect.bottom);
  const anchorY = focused
    ? (visibleTop + visibleBottom) / 2
    : clampValue(referenceY, visibleTop, visibleBottom);
  return {
    imageId: selected.card.dataset.imageId ?? "",
    cardRatio: selected.rect.height > 0
      ? clampValue((anchorY - selected.rect.top) / selected.rect.height, 0, 1)
      : .5,
    viewportRatio: clampValue((anchorY - viewport.top) / viewport.height, 0, 1),
    fallbackScrollY: window.scrollY,
  };
}

function restoreMasonryViewportAnchor(
  masonry: HTMLElement,
  anchor: MasonryViewportAnchor,
): void {
  const card = masonry.querySelector<HTMLElement>(
    `.image-card[data-image-id="${CSS.escape(anchor.imageId)}"]`,
  );
  if (!card) {
    scrollWindowImmediately(anchor.fallbackScrollY);
    return;
  }
  const rect = card.getBoundingClientRect();
  const viewport = visualViewportBounds();
  const viewportBottom = viewport.top + viewport.height;
  const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
    ?? viewport.top;
  const safeTop = Math.min(viewportBottom, Math.max(viewport.top, topbarBottom + 8));
  const safeBottom = Math.max(safeTop, viewportBottom - 8);
  const desiredY = clampValue(
    viewport.top + anchor.viewportRatio * viewport.height,
    safeTop,
    safeBottom,
  );
  const actualY = rect.top + rect.height * anchor.cardRatio;
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  );
  const maximumScroll = Math.max(0, documentHeight - window.innerHeight);
  scrollWindowImmediately(clampValue(
    window.scrollY + actualY - desiredY,
    0,
    maximumScroll,
  ));
}

function scrollWindowImmediately(top: number): void {
  const root = document.documentElement;
  const previousBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo({ top, left: window.scrollX, behavior: "auto" });
  root.style.scrollBehavior = previousBehavior;
}

function disposeViewerReturnFlight(flight: ViewerReturnFlight | null): void {
  if (!flight) return;
  for (const animation of flight.animations) animation.cancel();
  flight.layer.remove();
}

function createViewerReturnFlight(): ViewerReturnFlight | null {
  const viewer = document.querySelector<HTMLElement>(".image-viewer");
  const media = viewer?.querySelector<HTMLElement>(".viewer-media");
  if (!viewer || !media) return null;

  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportBottom = viewportTop + viewportHeight;
  const mediaRect = media.getBoundingClientRect();
  const detailsPreview = viewer.querySelector<HTMLElement>(".viewer-details-summary img");
  const detailsRect = detailsPreview?.getBoundingClientRect();
  const mediaVisible = mediaRect.bottom > viewportTop && mediaRect.top < viewportBottom;
  const detailsVisible = detailsRect
    ? detailsRect.bottom > viewportTop && detailsRect.top < viewportBottom
    : false;
  const sourceRect = !mediaVisible && detailsVisible ? detailsRect! : mediaRect;
  if (sourceRect.width <= 0 || sourceRect.height <= 0) return null;

  const layer = document.createElement("div");
  layer.className = "viewer-return-layer";
  layer.dataset.phase = "settling";
  layer.dataset.imageId = viewer.dataset.imageId ?? "";
  layer.dataset.createdAt = String(performance.now());
  const backdrop = document.createElement("div");
  backdrop.className = "viewer-return-backdrop";
  const clone = media.cloneNode(true) as HTMLElement;
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
    transformOrigin: "top left",
    transition: "none",
    animation: "none",
    opacity: "1",
    borderRadius: "6px",
    boxShadow: "0 12px 38px rgba(0, 0, 0, .28)",
  });

  const thumbnailSource = media.querySelector<HTMLImageElement>(".viewer-thumbnail");
  const originalSource = media.querySelector<HTMLElement>(".viewer-original");
  const originalUrl = originalSource instanceof HTMLImageElement
    ? originalSource.currentSrc || originalSource.src
    : originalSource?.dataset.originalUrl ?? "";
  const decodedOriginal = originalUrl ? getDecodedViewerOriginal(originalUrl) : null;
  const thumbnail = thumbnailSource?.cloneNode(false) as HTMLImageElement | undefined;
  const original = viewer.dataset.fullLoaded === "true"
    ? (decodedOriginal
      ?? (originalSource instanceof HTMLImageElement && originalSource.complete
        ? originalSource
        : null))?.cloneNode(false) as HTMLImageElement | undefined
    : undefined;
  const visualLayers = [thumbnail, original].filter(
    (visual): visual is HTMLImageElement => Boolean(visual),
  );
  clone.replaceChildren(...visualLayers);
  visualLayers.forEach((visual, index) => {
    visual.className = index === visualLayers.length - 1 && original
      ? "viewer-return-visual viewer-return-original"
      : "viewer-return-visual viewer-return-thumbnail";
    visual.alt = "";
    visual.setAttribute("aria-hidden", "true");
    visual.draggable = false;
    Object.assign(visual.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "contain",
      opacity: "1",
      filter: "none",
      transform: "none",
      transition: "none",
    });
  });

  layer.append(backdrop, clone);
  document.body.append(layer);
  return { layer, backdrop, media: clone, animations: [] };
}

function initialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function useVisualViewportTop(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;
    let settleTimer = 0;
    const update = () => {
      frame = 0;
      const pageOffset = viewport.pageTop - window.scrollY;
      const offset = Math.max(0, viewport.offsetTop, pageOffset);
      document.documentElement.style.setProperty(
        "--visual-viewport-top",
        `${Math.round(offset * 100) / 100}px`,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(update, 120);
    };

    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.documentElement.style.removeProperty("--visual-viewport-top");
    };
  }, []);
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function useDelayedUnmount(visible: boolean, delay: number): boolean {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;

    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [delay, mounted, visible]);

  return mounted;
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function appendUniqueImages(
  current: GalleryImage[],
  incoming: GalleryImage[],
): GalleryImage[] {
  const ids = new Set(current.map((image) => image.id));
  const unique = incoming.filter((image) => {
    if (ids.has(image.id)) return false;
    ids.add(image.id);
    return true;
  });
  return unique.length ? [...current, ...unique] : current;
}

function createExploreSeed(): string {
  const values = new Uint32Array(4);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

const CARD_LOAD_CALLBACKS = new WeakMap<Element, () => void>();
const READY_THUMBNAIL_IDS = new Set<string>();
let cardLoadObserver: IntersectionObserver | null = null;

function rememberReadyThumbnail(id: string): void {
  READY_THUMBNAIL_IDS.delete(id);
  READY_THUMBNAIL_IDS.add(id);
  if (READY_THUMBNAIL_IDS.size > READY_THUMBNAIL_CACHE_LIMIT) {
    const oldest = READY_THUMBNAIL_IDS.values().next().value;
    if (oldest !== undefined) READY_THUMBNAIL_IDS.delete(oldest);
  }
}

function observeCardLoad(element: Element, load: () => void): () => void {
  if (!("IntersectionObserver" in window)) {
    load();
    return () => undefined;
  }
  if (!cardLoadObserver) {
    cardLoadObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = CARD_LOAD_CALLBACKS.get(entry.target);
          CARD_LOAD_CALLBACKS.delete(entry.target);
          observer.unobserve(entry.target);
          callback?.();
        }
      },
      { rootMargin: CARD_PREFETCH_MARGIN },
    );
  }
  CARD_LOAD_CALLBACKS.set(element, load);
  cardLoadObserver.observe(element);
  return () => {
    CARD_LOAD_CALLBACKS.delete(element);
    cardLoadObserver?.unobserve(element);
  };
}

function App() {
  useVisualViewportTop();
  const [summary, setSummary] = useState<GallerySummary | null>(
    INITIAL_BOOTSTRAP?.summary ?? null,
  );
  const [status, setStatus] = useState<ThumbnailStatus | null>(
    INITIAL_BOOTSTRAP?.status ?? null,
  );
  const [imagePage, setImagePage] = useState<ImagePageState>(() => (
    INITIAL_BOOTSTRAP
      ? {
          images: INITIAL_BOOTSTRAP.images.items,
          total: INITIAL_BOOTSTRAP.images.total,
          nextOffset: INITIAL_BOOTSTRAP.images.nextOffset,
        }
      : EMPTY_IMAGE_PAGE
  ));
  const [album, setAlbum] = useState("");
  const [search, setSearch] = useState("");
  const [exploreSeed, setExploreSeed] = useState("");
  const [loading, setLoading] = useState(!INITIAL_BOOTSTRAP);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [viewerReturnRequest, setViewerReturnRequest] = useState<ViewerReturnRequest | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const mobileNavMounted = useDelayedUnmount(mobileNavOpen, MOBILE_NAV_EXIT_MS);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const requestVersionRef = useRef(0);
  const summaryRevisionRef = useRef<string | null>(
    INITIAL_BOOTSTRAP?.summary.revision ?? null,
  );
  const skipInitialImagesRef = useRef(Boolean(INITIAL_BOOTSTRAP));
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const loadMorePromiseRef = useRef<Promise<GalleryImage[]> | null>(null);
  const viewerImageIdRef = useRef<string | null>(null);
  const viewerAnchorRef = useRef<ViewerAnchor | null>(null);
  const viewerReturnSequenceRef = useRef(0);
  const viewerReturnFlightRef = useRef<ViewerReturnFlight | null>(null);
  const { images, total, nextOffset } = imagePage;

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [album, debouncedSearch, exploreSeed]);

  useLayoutEffect(() => {
    viewerImageIdRef.current = viewerImageId;
  }, [viewerImageId]);

  useEffect(() => () => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
  }, []);

  useEffect(() => {
    if (!mobileNavMounted) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavMounted]);

  useEffect(() => {
    if (!compactLayout && mobileNavOpen) setMobileNavOpen(false);
  }, [compactLayout, mobileNavOpen]);

  useEffect(() => {
    if (summary && album && !summary.albums.some((item) => item.path === album)) {
      setAlbum("");
      setMobileNavOpen(false);
    }
  }, [album, summary]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // The layout still works when storage is disabled.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (reloadToken === 0 && INITIAL_BOOTSTRAP) return;
    const controller = new AbortController();
    getGallery(controller.signal)
      .then((next) => {
        summaryRevisionRef.current = next.revision;
        setSummary(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason, "无法读取图库"));
        }
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getGallery(controller.signal);
        if (controller.signal.aborted) return;
        const previousRevision = summaryRevisionRef.current;
        if (previousRevision !== next.revision) {
          summaryRevisionRef.current = next.revision;
          setSummary(next);
          if (previousRevision) setReloadToken((value) => value + 1);
        }
      } catch {
        // A later poll retries transient scan or network failures.
      } finally {
        if (!controller.signal.aborted) {
          timer = window.setTimeout(poll, GALLERY_POLL_INTERVAL_MS);
        }
      }
    };
    timer = window.setTimeout(poll, GALLERY_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getStatus(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        timer = window.setTimeout(poll, next.backgroundComplete ? 10000 : 1500);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
      }
    };
    const initialDelay = INITIAL_BOOTSTRAP
      ? (INITIAL_BOOTSTRAP.status.backgroundComplete ? 10_000 : 1_500)
      : 0;
    timer = window.setTimeout(poll, initialDelay);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (skipInitialImagesRef.current) {
      skipInitialImagesRef.current = false;
      return;
    }
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadMorePromiseRef.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setImagePage(EMPTY_IMAGE_PAGE);
    getImages(
      {
        album,
        search: debouncedSearch,
        sort: exploreSeed ? "explore" : "name-asc",
        seed: exploreSeed,
        offset: 0,
        limit: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((page) => {
        if (requestVersion !== requestVersionRef.current) return;
        setImagePage({
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason, "无法读取图片"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      const loadMoreController = loadMoreControllerRef.current;
      loadMoreControllerRef.current = null;
      loadMorePromiseRef.current = null;
      loadMoreController?.abort();
    };
  }, [album, debouncedSearch, exploreSeed, reloadToken]);

  const loadMore = useCallback((): Promise<GalleryImage[]> => {
    if (loading || nextOffset === null) return Promise.resolve([]);
    const pending = loadMorePromiseRef.current;
    if (pending) return pending;

    const controller = new AbortController();
    const requestVersion = requestVersionRef.current;
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);

    const promise = (async () => {
      try {
        const page = await getImages(
          {
            album,
            search: debouncedSearch,
            sort: exploreSeed ? "explore" : "name-asc",
            seed: exploreSeed,
            offset: nextOffset,
            limit: PAGE_SIZE,
          },
          controller.signal,
        );
        if (requestVersion !== requestVersionRef.current) return [];
        setImagePage((current) => ({
          images: appendUniqueImages(current.images, page.items),
          total: page.total,
          nextOffset: page.nextOffset,
        }));
        return page.items;
      } catch (reason) {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
          setError(errorMessage(reason, "无法继续加载图片"));
        }
        return [];
      } finally {
        if (loadMoreControllerRef.current === controller) {
          loadMoreControllerRef.current = null;
          loadMorePromiseRef.current = null;
          if (requestVersion === requestVersionRef.current) setLoadingMore(false);
        }
      }
    })();
    loadMorePromiseRef.current = promise;
    return promise;
  }, [album, debouncedSearch, exploreSeed, loading, nextOffset]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextOffset === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadMore();
      },
      {
        rootMargin: compactLayout
          ? MOBILE_PAGE_PREFETCH_MARGIN
          : DESKTOP_PAGE_PREFETCH_MARGIN,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [compactLayout, loadMore, nextOffset]);

  const viewerIndex = viewerImageId
    ? images.findIndex((image) => image.id === viewerImageId)
    : -1;

  const openViewer = useCallback((
    imageId: string,
    card: HTMLElement,
    pointerY?: number,
  ) => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    viewerAnchorRef.current = captureViewerAnchor(card, pointerY);
    prepareViewerImages(images, images.findIndex((image) => image.id === imageId));
    setViewerReturnRequest(null);
    viewerImageIdRef.current = imageId;
    setViewerImageId(imageId);
  }, [images]);

  const closeViewer = useCallback(() => {
    const currentImageId = viewerImageIdRef.current;
    if (!currentImageId) return;
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = createViewerReturnFlight();
    const anchor = viewerAnchorRef.current ?? {
      cardRatio: 0.5,
      viewportRatio: 0.5,
      fallbackScrollY: window.scrollY,
    };
    viewerReturnSequenceRef.current += 1;
    setViewerReturnRequest({
      ...anchor,
      imageId: currentImageId,
      sequence: viewerReturnSequenceRef.current,
    });
    viewerImageIdRef.current = null;
    setViewerImageId(null);
  }, []);

  useLayoutEffect(() => {
    if (viewerImageId || !viewerReturnRequest) return;
    const request = viewerReturnRequest;
    const requestFlight = viewerReturnFlightRef.current;
    let frame = 0;
    let settleTimer = 0;
    let timeoutTimer = 0;
    let stopped = false;
    let animating = false;
    let finished = false;
    let animationGeneration = 0;
    let animationTarget: HTMLElement | null = null;
    let observedCard: HTMLElement | null = null;
    let observedMasonry: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeObserverPrimed = false;

    const observeLayout = (card: HTMLElement) => {
      const masonry = card.closest<HTMLElement>(".masonry");
      if (resizeObserver && card !== observedCard) {
        if (observedCard) resizeObserver.unobserve(observedCard);
        resizeObserver.observe(card);
        observedCard = card;
      }
      if (resizeObserver && masonry && masonry !== observedMasonry) {
        if (observedMasonry) resizeObserver.unobserve(observedMasonry);
        resizeObserver.observe(masonry);
        observedMasonry = masonry;
      }
    };

    const alignToCard = (): HTMLElement | null => {
      const card = imageCardById(request.imageId);
      if (!card) return null;
      observeLayout(card);

      const rect = card.getBoundingClientRect();
      const viewport = visualViewportBounds();
      const viewportBottom = viewport.top + viewport.height;
      const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
        ?? viewport.top;
      const safeTop = Math.min(
        viewportBottom,
        Math.max(viewport.top, topbarBottom + 8),
      );
      const safeBottom = Math.max(safeTop, viewportBottom - 8);
      const desiredViewportY = clampValue(
        viewport.top + request.viewportRatio * viewport.height,
        safeTop,
        safeBottom,
      );
      const cardAnchorY = rect.top + rect.height * request.cardRatio;
      const documentHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      );
      const maximumScroll = Math.max(0, documentHeight - window.innerHeight);
      const targetScroll = clampValue(
        window.scrollY + cardAnchorY - desiredViewportY,
        0,
        maximumScroll,
      );
      if (Math.abs(targetScroll - window.scrollY) > 0.5) {
        scrollWindowImmediately(targetScroll);
      }
      return card;
    };

    const finalize = (card: HTMLElement | null) => {
      if (finished) return;
      finished = true;
      stopped = true;
      disposeViewerReturnFlight(requestFlight);
      if (viewerReturnFlightRef.current === requestFlight) viewerReturnFlightRef.current = null;
      if (card?.isConnected) card.focus({ preventScroll: true });
      setViewerReturnRequest((current) => {
        if (current?.sequence !== request.sequence) return current;
        viewerAnchorRef.current = null;
        return null;
      });
    };

    const pauseAnimationForLayout = () => {
      const flight = requestFlight;
      if (!animating || !flight) return;
      const mediaRect = flight.media.getBoundingClientRect();
      const backdropOpacity = window.getComputedStyle(flight.backdrop).opacity;
      animationGeneration += 1;
      for (const animation of flight.animations) animation.cancel();
      flight.animations.length = 0;
      Object.assign(flight.media.style, {
        left: `${mediaRect.left}px`,
        top: `${mediaRect.top}px`,
        width: `${mediaRect.width}px`,
        height: `${mediaRect.height}px`,
        transform: "none",
      });
      flight.backdrop.style.opacity = backdropOpacity;
      if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
      animationTarget = null;
      animating = false;
      flight.layer.dataset.phase = "settling";
      flight.layer.dataset.retargets = String(
        Number.parseInt(flight.layer.dataset.retargets ?? "0", 10) + 1,
      );
    };

    const complete = () => {
      if (stopped || animating) return;
      const card = alignToCard();
      if (!card) {
        const maximumScroll = Math.max(
          0,
          Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
            - window.innerHeight,
        );
        scrollWindowImmediately(clampValue(request.fallbackScrollY, 0, maximumScroll));
      }

      const flight = requestFlight;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!flight || reducedMotion || typeof flight.media.animate !== "function") {
        finalize(card);
        return;
      }

      animating = true;
      const generation = ++animationGeneration;
      flight.layer.dataset.phase = card ? "flying" : "fading";
      flight.layer.dataset.flyingAt = String(performance.now());
      flight.layer.dataset.duration = String(VIEWER_RETURN_ANIMATION_MS);
      const animations: Animation[] = [];
      if (card) {
        const sourceRect = flight.media.getBoundingClientRect();
        const targetRect = card.getBoundingClientRect();
        const scaleX = targetRect.width / Math.max(1, sourceRect.width);
        const scaleY = targetRect.height / Math.max(1, sourceRect.height);
        card.dataset.viewerReturnTarget = "true";
        animationTarget = card;
        animations.push(flight.media.animate([
          { transform: "translate3d(0, 0, 0) scale(1, 1)" },
          {
            transform: `translate3d(${targetRect.left - sourceRect.left}px, ${targetRect.top - sourceRect.top}px, 0) scale(${scaleX}, ${scaleY})`,
          },
        ], {
          duration: VIEWER_RETURN_ANIMATION_MS,
          easing: "cubic-bezier(.22, 1, .36, 1)",
          fill: "forwards",
        }));
      } else {
        animations.push(flight.media.animate([
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(.98)" },
        ], {
          duration: 120,
          easing: "ease-out",
          fill: "forwards",
        }));
      }
      animations.push(flight.backdrop.animate([
        { opacity: Number.parseFloat(window.getComputedStyle(flight.backdrop).opacity) || 0 },
        { opacity: 0 },
      ], {
        duration: card ? 165 : 120,
        easing: "cubic-bezier(.2, .8, .2, 1)",
        fill: "forwards",
      }));
      flight.animations.push(...animations);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (
          viewerReturnFlightRef.current !== flight ||
          generation !== animationGeneration
        ) return;
        if (card) delete card.dataset.viewerReturnTarget;
        finalize(card);
      });
    };

    const schedule = () => {
      if (stopped) return;
      if (animating) pauseAnimationForLayout();
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        alignToCard();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(complete, VIEWER_RETURN_SETTLE_MS);
      });
    };

    resizeObserver = new ResizeObserver(() => {
      if (!resizeObserverPrimed) {
        resizeObserverPrimed = true;
        return;
      }
      schedule();
    });
    const mutationObserver = new MutationObserver(schedule);
    const masonry = document.querySelector(".masonry");
    if (masonry) mutationObserver.observe(masonry, { childList: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();
    timeoutTimer = window.setTimeout(complete, VIEWER_RETURN_TIMEOUT_MS);

    return () => {
      stopped = true;
      finished = true;
      if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(timeoutTimer);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [viewerImageId, viewerReturnRequest]);

  useEffect(() => {
    if (!viewerImageId || viewerIndex < 0 || nextOffset === null) return;
    if (viewerIndex >= images.length - 5) void loadMore();
  }, [images.length, loadMore, nextOffset, viewerImageId, viewerIndex]);

  const navigateViewer = useCallback((direction: -1 | 1) => {
    const currentImageId = viewerImageIdRef.current;
    if (!currentImageId) return;
    const currentIndex = images.findIndex((image) => image.id === currentImageId);
    if (currentIndex < 0) return;
    const target = images[currentIndex + direction];
    if (target) {
      viewerImageIdRef.current = target.id;
      setViewerImageId(target.id);
      return;
    }
    if (direction < 0 || nextOffset === null) return;

    const startingId = currentImageId;
    void loadMore().then((incoming) => {
      const next = incoming[0];
      if (!next || viewerImageIdRef.current !== startingId) return;
      viewerImageIdRef.current = next.id;
      setViewerImageId(next.id);
    });
  }, [images, loadMore, nextOffset]);

  const galleryPath = `/${album.replace(/^\/+/, "")}`;
  const chooseAlbum = (path: string) => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setAlbum(path);
    setExploreSeed("");
    setViewerImageId(null);
    setMobileNavOpen(false);
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    setExploreSeed("");
    setViewerImageId(null);
  };
  const startExploring = () => {
    setViewerImageId(null);
    setExploreSeed(createExploreSeed());
  };
  const goHome = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setAlbum("");
    setSearch("");
    setExploreSeed("");
    setViewerImageId(null);
    setMobileNavOpen(false);
  };
  return (
    <div
      className="app-shell"
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-navigation-open={mobileNavOpen}
      data-viewer-returning={Boolean(viewerReturnRequest)}
      data-viewer-return-image-id={viewerReturnRequest?.imageId}
    >
      <Header
        search={search}
        onSearchChange={changeSearch}
        onExplore={startExploring}
        exploreActive={Boolean(exploreSeed)}
        exploreLoading={Boolean(exploreSeed) && loading}
        onHome={goHome}
        onToggleNavigation={() => setMobileNavOpen((open) => !open)}
        navigationOpen={mobileNavOpen}
      />
      <div
        className="request-progress"
        data-visible={loading}
        role="progressbar"
        aria-label="正在更新图库"
        aria-hidden={!loading}
      >
        <span />
      </div>
      <SidebarToggleButton
        className="gallery-sidebar-toggle"
        expanded={compactLayout ? mobileNavOpen : !sidebarCollapsed}
        onClick={() => {
          if (compactLayout) {
            setMobileNavOpen((open) => !open);
          } else {
            setSidebarCollapsed((collapsed) => !collapsed);
          }
        }}
        controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"}
      />
      <Sidebar
        summary={summary}
        status={status}
        activeAlbum={album}
        galleryPath={galleryPath}
        galleryCount={total}
        onChoose={chooseAlbum}
        mobileOpen={mobileNavOpen}
        mobileMounted={mobileNavMounted}
        onClose={() => setMobileNavOpen(false)}
        desktopCollapsed={sidebarCollapsed}
      />

      <main className="content" aria-busy={loading || loadingMore}>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              aria-label="重新加载"
              title="重新加载"
            >
              <RefreshCw size={17} />
            </button>
          </div>
        )}

        {loading ? (
          <GallerySkeleton />
        ) : images.length ? (
          <MasonryGallery
            images={images}
            initialColumnCount={compactLayout ? 2 : 5}
            preserveViewport={viewerIndex < 0 && !viewerReturnRequest}
            onOpen={openViewer}
          />
        ) : (
          <div className="empty-state">
            <ImageIcon size={30} strokeWidth={1.6} />
            <strong>{summary?.total === 0 ? "图库暂无图片" : "没有找到图片"}</strong>
            <span>
              {summary?.total === 0 ? "添加图片后将自动显示" : "请调整相册或搜索条件"}
            </span>
          </div>
        )}

        <div ref={sentinelRef} className="load-sentinel" aria-live="polite">
          {loadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
          {!loading && nextOffset === null && images.length > 0 && (
            <span>已显示全部 {formatCount(total)} 张图片</span>
          )}
        </div>
      </main>
      {viewerIndex >= 0 && (
        <ImageViewer
          images={images}
          activeIndex={viewerIndex}
          total={total}
          hasMore={nextOffset !== null}
          loadingMore={loadingMore}
          onNavigate={navigateViewer}
          onClose={closeViewer}
        />
      )}
    </div>
  );
}

function Header({
  search,
  onSearchChange,
  onExplore,
  exploreActive,
  exploreLoading,
  onHome,
  onToggleNavigation,
  navigationOpen,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  onExplore: () => void;
  exploreActive: boolean;
  exploreLoading: boolean;
  onHome: () => void;
  onToggleNavigation: () => void;
  navigationOpen: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [exploreMotionKey, setExploreMotionKey] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (navigationOpen) {
      searchInputRef.current?.blur();
      setSearchOpen(false);
    }
  }, [navigationOpen]);

  const handleSearchOpenChange = (open: boolean) => {
    if (open && navigationOpen) onToggleNavigation();
    setSearchOpen(open);
  };
  const handleExplore = () => {
    searchInputRef.current?.blur();
    setSearchOpen(false);
    if (navigationOpen) onToggleNavigation();
    setExploreMotionKey((value) => value + 1);
    onExplore();
  };
  const handleHome = () => {
    searchInputRef.current?.blur();
    setSearchOpen(false);
    onHome();
  };

  return (
    <header className="topbar" data-search-open={searchOpen}>
      <div className="topbar-leading">
        <a
          className="brand"
          href="/"
          aria-label="返回 Pixhelf 主页"
          title="返回主页"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            handleHome();
          }}
        >
          <span className="brand-mark"><Images size={21} /></span>
          <span>Pixhelf</span>
        </a>
      </div>
      <div className="topbar-actions" role="toolbar" aria-label="图库工具">
        <button
          type="button"
          className={`icon-button toolbar-action-button explore-toggle ${exploreActive ? "is-active" : ""} ${exploreLoading ? "is-loading" : ""}`}
          onClick={handleExplore}
          aria-label={exploreActive ? "换一组图片" : "随机探索"}
          aria-pressed={exploreActive}
          aria-busy={exploreLoading}
          title={exploreActive ? "换一组" : "随机探索"}
        >
          <Dices
            key={exploreMotionKey}
            className={`explore-icon ${exploreMotionKey ? "is-rolling" : ""}`}
            size={18}
          />
          <span className="toolbar-state-dot" aria-hidden="true" />
        </button>
        <ToolbarPopover
          id="gallery-search-field"
          open={searchOpen}
          onOpenChange={handleSearchOpenChange}
          openLabel="打开搜索"
          closeLabel="收起搜索"
          panelLabel="搜索图片"
          icon={
            <>
              <Search className="search-toggle-icon" size={18} />
              <span className="toolbar-state-dot" aria-hidden="true" />
            </>
          }
          rootClassName={`topbar-search ${search ? "has-query" : ""}`}
          triggerClassName="search-toggle"
          panelClassName="search-popover-panel"
        >
          <Search className="search-popover-icon" aria-hidden="true" size={17} />
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onInput={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="搜索文件名"
            aria-label="搜索文件名"
            enterKeyHint="search"
            autoComplete="off"
            tabIndex={searchOpen ? 0 : -1}
          />
          {search && (
            <button
              type="button"
              className="clear-search"
              onClick={() => onSearchChange("")}
              aria-label="清空搜索"
              title="清空搜索"
              tabIndex={searchOpen ? 0 : -1}
            >
              <X size={15} />
            </button>
          )}
        </ToolbarPopover>
      </div>
    </header>
  );
}

function SidebarToggleButton({
  className,
  controls,
  expanded,
  onClick,
}: {
  className: string;
  controls: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const label = expanded ? "收起侧栏" : "展开侧栏";
  return (
    <button
      type="button"
      className={`icon-button sidebar-toggle-button ${className} ${expanded ? "is-expanded" : "is-collapsed"}`}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
    >
      <span key={String(expanded)} className="sidebar-toggle-glyph" aria-hidden="true">
        {expanded ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
      </span>
    </button>
  );
}

function SidebarStatus({ status }: { status: ThumbnailStatus | null }) {
  if (!status) {
    return (
      <div className="sidebar-status muted" role="status">
        <LoaderCircle className="spin" size={15} />
        <span>连接中</span>
      </div>
    );
  }
  const complete = status.backgroundComplete;
  return (
    <div
      className={`sidebar-status ${complete ? "complete" : ""}`}
      title={complete ? "缩略图处理完成" : "正在后台处理缩略图"}
      role="status"
    >
      {complete ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />}
      <span>{complete ? "已就绪" : "处理中"}</span>
      <strong>{formatCount(status.ready)} / {formatCount(status.total)}</strong>
    </div>
  );
}

function Sidebar({
  summary,
  status,
  activeAlbum,
  galleryPath,
  galleryCount,
  onChoose,
  mobileOpen,
  mobileMounted,
  onClose,
  desktopCollapsed,
}: {
  summary: GallerySummary | null;
  status: ThumbnailStatus | null;
  activeAlbum: string;
  galleryPath: string;
  galleryCount: number;
  onChoose: (path: string) => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onClose: () => void;
  desktopCollapsed: boolean;
}) {
  const navigation = (
    <>
      <div className="sidebar-control-slot" aria-hidden="true" />
      <nav className="album-nav" aria-label="相册">
        <AlbumButton
          label="全部图片"
          count={summary?.total ?? 0}
          active={!activeAlbum}
          onClick={() => onChoose("")}
          all
        />
        {summary?.albums.map((item) => (
          <AlbumButton
            key={item.path}
            label={item.name}
            detail={item.path.includes("/") ? item.path : undefined}
            count={item.count}
            active={activeAlbum === item.path}
            onClick={() => onChoose(item.path)}
          />
        ))}
      </nav>
      <SidebarStatus status={status} />
      <div className="sidebar-gallery-meta">
        <span className="sidebar-gallery-path" title={galleryPath}>{galleryPath}</span>
        <span className="sidebar-gallery-count">{formatCount(galleryCount)} 张图片</span>
      </div>
    </>
  );

  return (
    <>
      <aside
        id="desktop-album-navigation"
        className="sidebar desktop-sidebar"
        aria-label="相册导航"
        aria-hidden={desktopCollapsed}
        inert={desktopCollapsed}
      >
        {navigation}
      </aside>
      {mobileMounted && (
        <div
          className="mobile-nav-layer"
          data-state={mobileOpen ? "open" : "closing"}
          role="presentation"
          aria-hidden={!mobileOpen}
          inert={!mobileOpen}
        >
          <button
            className="mobile-nav-scrim"
            type="button"
            onClick={onClose}
            aria-label="关闭相册导航"
          />
          <aside
            id="mobile-album-navigation"
            className="sidebar mobile-sidebar"
            role="dialog"
            aria-label="相册导航"
          >
            {navigation}
          </aside>
        </div>
      )}
    </>
  );
}

function AlbumButton({
  label,
  detail,
  count,
  active,
  onClick,
  all = false,
}: {
  label: string;
  detail?: string;
  count: number;
  active: boolean;
  onClick: () => void;
  all?: boolean;
}) {
  return (
    <button
      type="button"
      className={`album-link ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={detail ?? label}
    >
      {all ? <Images size={17} /> : <Folder size={17} />}
      <span className="album-copy">
        <strong>{label}</strong>
      </span>
      <span className="album-count">{formatCount(count)}</span>
    </button>
  );
}

type MasonryMetrics = {
  width: number;
  columnCount: number;
  gap: number;
};

function useMasonryMetrics(
  ref: RefObject<HTMLDivElement | null>,
  initialColumnCount: number,
  onBeforeChange?: () => void,
): MasonryMetrics {
  const [metrics, setMetrics] = useState<MasonryMetrics>({
    width: 0,
    columnCount: initialColumnCount,
    gap: 6,
  });
  const metricsRef = useRef(metrics);
  const beforeChangeRef = useRef(onBeforeChange);
  beforeChangeRef.current = onBeforeChange;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let pendingWidth = element.clientWidth;
    const update = (width: number) => {
      if (width <= 0) return;
      const minimumCardWidth = 218;
      const declaredGap = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--masonry-gap"),
      );
      const gap = Number.isFinite(declaredGap) ? declaredGap : 6;
      const next = Math.floor((width + gap) / (minimumCardWidth + gap));
      const roundedWidth = Math.round(width * 100) / 100;
      const columnCount = Math.min(6, Math.max(2, next));
      const current = metricsRef.current;
      if (
        current.width === roundedWidth
        && current.columnCount === columnCount
        && current.gap === gap
      ) return;
      if (current.width > 0) beforeChangeRef.current?.();
      const nextMetrics = { width: roundedWidth, columnCount, gap };
      metricsRef.current = nextMetrics;
      setMetrics(nextMetrics);
    };
    const schedule = (width: number) => {
      pendingWidth = width;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update(pendingWidth);
      });
    };

    update(pendingWidth);
    const observer = new ResizeObserver(([entry]) => schedule(entry.contentRect.width));
    observer.observe(element);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return metrics;
}

const MasonryGallery = memo(function MasonryGallery({
  images,
  initialColumnCount,
  preserveViewport,
  onOpen,
}: {
  images: GalleryImage[];
  initialColumnCount: number;
  preserveViewport: boolean;
  onOpen: (id: string, card: HTMLElement, pointerY?: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const resizeAnchorRef = useRef<MasonryViewportAnchor | null>(null);
  const stableViewportAnchorRef = useRef<MasonryViewportAnchor | null>(null);
  const resizeGuardUntilRef = useRef(0);
  const [activeNameId, setActiveNameId] = useState<string | null>(null);
  const captureResizeAnchor = useCallback(() => {
    const masonry = ref.current;
    resizeAnchorRef.current = preserveViewport && masonry
      ? stableViewportAnchorRef.current ?? captureMasonryViewportAnchor(masonry)
      : null;
  }, [preserveViewport]);
  const { width, columnCount, gap } = useMasonryMetrics(
    ref,
    initialColumnCount,
    captureResizeAnchor,
  );

  useLayoutEffect(() => {
    const anchor = resizeAnchorRef.current;
    const masonry = ref.current;
    let correctionFrame = 0;
    resizeAnchorRef.current = null;
    if (anchor && masonry && preserveViewport) {
      restoreMasonryViewportAnchor(masonry, anchor);
      correctionFrame = window.requestAnimationFrame(() => {
        restoreMasonryViewportAnchor(masonry, anchor);
      });
    }
    stableViewportAnchorRef.current = preserveViewport && masonry
      ? captureMasonryViewportAnchor(masonry)
      : null;
    return () => window.cancelAnimationFrame(correctionFrame);
  }, [columnCount, gap, images, preserveViewport, width]);

  useEffect(() => {
    const masonry = ref.current;
    if (!masonry || !preserveViewport) {
      stableViewportAnchorRef.current = null;
      return;
    }
    let frame = 0;
    const rememberViewportAnchor = () => {
      frame = 0;
      if (
        resizeAnchorRef.current
        || performance.now() < resizeGuardUntilRef.current
      ) return;
      stableViewportAnchorRef.current = captureMasonryViewportAnchor(masonry);
    };
    const scheduleViewportAnchor = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(rememberViewportAnchor);
    };
    const rememberFocusedAnchor = () => {
      if (frame) window.cancelAnimationFrame(frame);
      rememberViewportAnchor();
    };
    const guardViewportResize = () => {
      resizeGuardUntilRef.current = performance.now() + 120;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    rememberViewportAnchor();
    window.addEventListener("scroll", scheduleViewportAnchor, { passive: true });
    window.addEventListener("resize", guardViewportResize);
    window.visualViewport?.addEventListener("resize", guardViewportResize);
    masonry.addEventListener("focusin", rememberFocusedAnchor);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleViewportAnchor);
      window.removeEventListener("resize", guardViewportResize);
      window.visualViewport?.removeEventListener("resize", guardViewportResize);
      masonry.removeEventListener("focusin", rememberFocusedAnchor);
    };
  }, [preserveViewport]);

  const showName = useCallback((id: string) => setActiveNameId(id), []);

  const layout = useMemo(() => {
    if (width <= 0) return { height: 0, items: [] };
    const cardWidth = Math.max(1, (width - gap * (columnCount - 1)) / columnCount);
    const heights = Array(columnCount).fill(0) as number[];
    const items = images.map((image, index) => {
      const target = heights.indexOf(Math.min(...heights));
      const cardHeight = Math.max(
        64,
        cardWidth * image.height / Math.max(image.width, 1),
      );
      const top = heights[target];
      heights[target] = top + cardHeight + gap;
      return {
        image,
        index,
        style: {
          left: target * (cardWidth + gap),
          top,
          width: cardWidth,
          height: cardHeight,
        } as CSSProperties,
      };
    });
    return {
      items,
      height: items.length ? Math.max(...heights) - gap : 0,
    };
  }, [columnCount, gap, images, width]);

  return (
    <div
      ref={ref}
      className="masonry"
      data-columns={columnCount}
      style={{ height: layout.height } as CSSProperties}
    >
      {layout.items.map(({ image, index, style }) => (
        <ImageCard
          key={image.id}
          image={image}
          layoutStyle={style}
          eager={index < columnCount}
          highPriority={index === 0}
          nameVisible={activeNameId === image.id}
          onNameTouch={showName}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
});

const ImageCard = memo(function ImageCard({
  image,
  layoutStyle,
  eager,
  highPriority,
  nameVisible,
  onNameTouch,
  onOpen,
}: {
  image: GalleryImage;
  layoutStyle: CSSProperties;
  eager: boolean;
  highPriority: boolean;
  nameVisible: boolean;
  onNameTouch: (id: string) => void;
  onOpen: (id: string, card: HTMLElement, pointerY?: number) => void;
}) {
  const alreadyReady = READY_THUMBNAIL_IDS.has(image.id);
  const [loaded, setLoaded] = useState(alreadyReady);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadRequested, setLoadRequested] = useState(eager || alreadyReady);
  const cardRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const retryTimerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);
  useEffect(() => {
    if (eager) {
      setLoadRequested(true);
      return;
    }
    if (loadRequested) return;
    const card = cardRef.current;
    if (!card) return;
    return observeCardLoad(card, () => setLoadRequested(true));
  }, [eager, loadRequested]);

  const thumbnailUrl = viewerThumbnailUrl(image);
  const retryQuery = attempt ? `retry=${attempt}` : "";
  const imageUrl = retryQuery ? `${thumbnailUrl}?${retryQuery}` : thumbnailUrl;

  const markLoaded = useCallback(() => {
    window.clearTimeout(retryTimerRef.current);
    rememberReadyThumbnail(image.id);
    setLoaded(true);
    setFailed(false);
    setRetrying(false);
  }, [image.id]);

  useLayoutEffect(() => {
    const element = imageRef.current;
    if (element?.complete && element.naturalWidth > 0) markLoaded();
  }, [imageUrl, loadRequested, markLoaded]);

  const handleError = () => {
    window.clearTimeout(retryTimerRef.current);
    READY_THUMBNAIL_IDS.delete(image.id);
    setLoaded(false);
    const delay = IMAGE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      setRetrying(false);
      setFailed(true);
      return;
    }
    setFailed(false);
    setRetrying(true);
    retryTimerRef.current = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      setRetrying(false);
    }, delay);
  };

  return (
    <figure
      ref={cardRef}
      className="image-card"
      title={image.name}
      data-image-id={image.id}
      data-name-visible={nameVisible}
      data-loaded={loaded}
      data-failed={failed}
      data-loading={loadRequested && !loaded && !failed}
      data-retrying={retrying}
      data-eager={eager}
      data-high-priority={highPriority}
      style={{
        ...layoutStyle,
        aspectRatio: `${image.width} / ${image.height}`,
      } as CSSProperties}
      onPointerEnter={() => preloadOriginalImage(image)}
      onPointerDown={(event) => {
        preloadOriginalImage(image);
        if (event.pointerType !== "mouse") onNameTouch(image.id);
      }}
      onFocus={() => preloadOriginalImage(image)}
      onClick={(event) => onOpen(
        image.id,
        event.currentTarget,
        event.detail > 0 ? event.clientY : undefined,
      )}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(image.id, event.currentTarget);
      }}
      role="button"
      tabIndex={0}
      aria-label={`查看 ${image.name}`}
      aria-haspopup="dialog"
    >
      {!failed && loadRequested ? (
        <img
          ref={imageRef}
          src={imageUrl}
          alt={image.name}
          loading="eager"
          decoding="async"
          fetchPriority={highPriority ? "high" : "auto"}
          width={image.width}
          height={image.height}
          draggable={false}
          className={loaded ? "loaded" : ""}
          onLoad={markLoaded}
          onError={handleError}
        />
      ) : failed ? (
        <span className="image-fallback" role="img" aria-label={`${image.name} 加载失败`}>
          <ImageIcon size={24} />
        </span>
      ) : null}
      <span className="image-name">{image.name}</span>
    </figure>
  );
});

function GallerySkeleton() {
  const ratios = [1.4, 0.72, 1, 1.55, 0.8, 1.2, 0.67, 1.35, 0.9, 1.6, 0.76, 1.1];
  return (
    <div className="skeleton-grid" aria-label="正在加载图库">
      {ratios.map((ratio, index) => (
        <span
          key={index}
          aria-hidden="true"
          style={{
            aspectRatio: String(ratio),
            "--skeleton-order": index,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

export default App;
