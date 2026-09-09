import {
  ImageIcon,
  LoaderCircle,
  RefreshCw,
} from "./icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { formatCount } from "./format";
import { Header, Sidebar } from "./GalleryNavigation";
import { AlbumHeading, AlbumsView } from "./AlbumsView";
import { ExternalStorageView } from "./ExternalStorageView";
import { SettingsDialog } from "./SettingsDialog";
import { authentication } from "./auth";
import type { SettingsSection } from "./SettingsDialog";
import { galleryHref, readGalleryLocation } from "./galleryLocation";
import type { GalleryLocation } from "./galleryLocation";
import {
  captureViewerAnchor,
  imageCardById,
  scrollTopForAnchor,
  scrollWindowImmediately,
} from "./galleryViewport";
import type { ViewerAnchor } from "./galleryViewport";
import { ImageViewer } from "./ImageViewer";
import { PhotoInformationDialog } from "./PhotoInformationDialog";
import { SimilarSearchView } from "./SimilarSearchView";
import { useImageSimilarity } from "./useImageSimilarity";
import type { ImageSearchSource } from "./useImageSimilarity";
import { appendUniqueImages } from "./galleryImages";
import { GallerySkeleton, JustifiedGallery } from "./JustifiedGallery";
import type { JustifiedGalleryHandle } from "./JustifiedGallery";
import {
  getGallery,
  getImages,
  getSimilarImages,
  getStatus,
  takeInitialBootstrap,
} from "./api";
import type {
  GalleryImage,
  GallerySection,
  GallerySummary,
  ImageCardAction,
  ThumbnailStatus,
} from "./types";
import {
  getDecodedViewerOriginal,
  prepareViewerImages,
} from "./viewerAssets";

const PAGE_SIZE = 60;
const SIMILAR_PAGE_SIZE = 30;
const MOBILE_PAGE_PREFETCH_MARGIN = "1400px 0px";
const DESKTOP_PAGE_PREFETCH_MARGIN = "900px 0px";
const SIDEBAR_STORAGE_KEY = "pixhelf.sidebar-collapsed";
const GALLERY_POLL_INTERVAL_MS = 10_000;
const MOBILE_NAV_EXIT_MS = 240;
const VIEWER_RETURN_SETTLE_MS = 32;
const VIEWER_RETURN_TIMEOUT_MS = 480;
const VIEWER_RETURN_ANIMATION_MS = 260;
const VIEWER_HISTORY_STATE_KEY = "__pixhelfViewer";
const VIEWER_HISTORY_STATE_VERSION = 1;
const INITIAL_BOOTSTRAP = takeInitialBootstrap();

type ImagePageState = {
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

type SimilarImagePageState = {
  source: GalleryImage | null;
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

type ViewerHistoryEntry = {
  version: number;
  image: GalleryImage;
};

type ViewerReturnRequest = ViewerAnchor & {
  imageId: string;
  sequence: number;
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

const EMPTY_SIMILAR_IMAGE_PAGE: SimilarImagePageState = {
  source: null,
  images: [],
  total: 0,
  nextOffset: null,
};

function readViewerHistoryEntry(state: unknown): ViewerHistoryEntry | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = (state as Record<string, unknown>)[VIEWER_HISTORY_STATE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const image = entry.image;
  if (
    entry.version !== VIEWER_HISTORY_STATE_VERSION
    || !image
    || typeof image !== "object"
    || Array.isArray(image)
  ) return null;
  const candidate = image as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.name !== "string"
    || typeof candidate.width !== "number"
    || typeof candidate.height !== "number"
  ) return null;
  return value as ViewerHistoryEntry;
}

function viewerHistoryState(image: GalleryImage): Record<string, unknown> {
  const current = window.history.state;
  const preserved = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  return {
    ...preserved,
    [VIEWER_HISTORY_STATE_KEY]: {
      version: VIEWER_HISTORY_STATE_VERSION,
      image,
    } satisfies ViewerHistoryEntry,
  };
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

  const sourceRect = media.getBoundingClientRect();
  if (sourceRect.width <= 0 || sourceRect.height <= 0) return null;

  const layer = document.createElement("div");
  layer.className = "viewer-return-layer";
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

function useTransitionPresence(visible: boolean, duration: number) {
  const [mounted, setMounted] = useState(visible);

  useLayoutEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;

    // The transition event normally removes the drawer. Cover hidden tabs and breakpoint changes.
    const timer = window.setTimeout(() => setMounted(false), duration + 100);
    return () => window.clearTimeout(timer);
  }, [duration, mounted, visible]);

  const finishExit = useCallback(() => {
    if (!visible) setMounted(false);
  }, [visible]);

  return { mounted: visible || mounted, finishExit };
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function createExploreSeed(): string {
  const values = new Uint32Array(4);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function App() {
  useVisualViewportTop();
  const [location, setLocation] = useState(readGalleryLocation);
  const locationRef = useRef(location);
  const { section, path } = location;
  const album = section === "albums" ? path : "";
  const browsingStorage = section === "storage";
  const browsingSimilar = section === "similar";
  const browsingAlbums = section === "albums" && !album;
  const hasInitialImages = Boolean(INITIAL_BOOTSTRAP && section === "library");
  const [summary, setSummary] = useState<GallerySummary | null>(
    INITIAL_BOOTSTRAP?.summary ?? null,
  );
  const [status, setStatus] = useState<ThumbnailStatus | null>(
    INITIAL_BOOTSTRAP?.status ?? null,
  );
  const [imagePage, setImagePage] = useState<ImagePageState>(() => (
    hasInitialImages && INITIAL_BOOTSTRAP
      ? {
          images: INITIAL_BOOTSTRAP.images.items,
          total: INITIAL_BOOTSTRAP.images.total,
          nextOffset: INITIAL_BOOTSTRAP.images.nextOffset,
        }
      : EMPTY_IMAGE_PAGE
  ));
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [exploreSeed, setExploreSeed] = useState("");
  const [loading, setLoading] = useState(!hasInitialImages && !browsingAlbums && !browsingStorage && !browsingSimilar);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [storageRevision, setStorageRevision] = useState(0);
  const [infoImage, setInfoImage] = useState<GalleryImage | null>(null);
  const [uploadedQuery, setUploadedQuery] = useState<File | null>(null);
  const [galleryQuerySnapshot, setGalleryQuerySnapshot] = useState<GalleryImage | null>(null);
  const lastSimilarPathRef = useRef(browsingSimilar ? path : "");
  const queryImageId = browsingSimilar ? path : lastSimilarPathRef.current;
  const querySource = useMemo<ImageSearchSource | null>(() => queryImageId
    ? { kind: "gallery", imageId: queryImageId, image: galleryQuerySnapshot?.id === queryImageId ? galleryQuerySnapshot : undefined }
    : uploadedQuery ? { kind: "upload", file: uploadedQuery } : null,
  [queryImageId, galleryQuerySnapshot, uploadedQuery]);
  const imageSimilarity = useImageSimilarity(querySource, browsingSimilar);
  const galleryLayoutRef = useRef<JustifiedGalleryHandle>(null);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [viewerDiscoveredImages, setViewerDiscoveredImages] = useState<GalleryImage[]>([]);
  const [similarPage, setSimilarPage] = useState<SimilarImagePageState>(
    EMPTY_SIMILAR_IMAGE_PAGE,
  );
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);
  const [viewerReturnRequest, setViewerReturnRequest] = useState<ViewerReturnRequest | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const { mounted: mobileNavMounted, finishExit: finishMobileNavExit } = useTransitionPresence(
    mobileNavOpen,
    MOBILE_NAV_EXIT_MS,
  );
  const textSearchReady = Boolean(
    status?.backgroundComplete
    && status.textSearch.enabled
    && status.textSearch.backgroundComplete
    && status.textSearch.ready > 0,
  );
  const textSearchMode: "filename" | "indexing" | "semantic" = status?.textSearch.enabled
    ? textSearchReady
      ? "semantic"
      : status.backgroundComplete && status.textSearch.backgroundComplete
        ? "filename"
        : "indexing"
    : "filename";
  const delayedSearch = useDebounced(
    search.trim(),
    status?.textSearch.enabled ? 500 : 250,
  );
  const debouncedSearch = search.trim() ? delayedSearch : "";
  const requestVersionRef = useRef(0);
  const summaryRevisionRef = useRef<string | null>(
    INITIAL_BOOTSTRAP?.summary.revision ?? null,
  );
  const skipInitialImagesRef = useRef(hasInitialImages);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const loadMorePromiseRef = useRef<Promise<GalleryImage[]> | null>(null);
  const similarRequestVersionRef = useRef(0);
  const similarControllerRef = useRef<AbortController | null>(null);
  const similarLoadMoreControllerRef = useRef<AbortController | null>(null);
  const similarLoadMorePromiseRef = useRef<Promise<GalleryImage[]> | null>(null);
  const backgroundCompletionRef = useRef(
    Boolean(INITIAL_BOOTSTRAP?.status.backgroundComplete),
  );
  const viewerImageIdRef = useRef<string | null>(null);
  const viewerAnchorRef = useRef<ViewerAnchor | null>(null);
  const viewerReturnSequenceRef = useRef(0);
  const viewerReturnFlightRef = useRef<ViewerReturnFlight | null>(null);
  const viewerHistoryActiveRef = useRef(false);
  const viewerHistoryClosingRef = useRef(false);
  const { images, total, nextOffset } = browsingSimilar ? imageSimilarity : imagePage;
  const pageLoadingMore = browsingSimilar ? imageSimilarity.loadingMore : loadingMore;
  const selectedAlbum = useMemo(() => summary?.albums.find(item => item.path === album), [summary, album]);
  const viewerImages = useMemo(
    () => appendUniqueImages(images, viewerDiscoveredImages),
    [images, viewerDiscoveredImages],
  );

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location, debouncedSearch, exploreSeed]);

  useLayoutEffect(() => {
    viewerImageIdRef.current = viewerImageId;
  }, [viewerImageId]);

  useEffect(() => () => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
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
        const complete = next.backgroundComplete && next.textSearch.backgroundComplete;
        timer = window.setTimeout(poll, complete ? 10000 : 1500);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
      }
    };
    const initialDelay = INITIAL_BOOTSTRAP
      ? (
          INITIAL_BOOTSTRAP.status.backgroundComplete
          && INITIAL_BOOTSTRAP.status.textSearch.backgroundComplete
            ? 10_000
            : 1_500
        )
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
    const requestVersion = ++requestVersionRef.current;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadMorePromiseRef.current = null;
    setLoadingMore(false);
    setError(null);
    setImagePage(EMPTY_IMAGE_PAGE);
    if (browsingAlbums || browsingStorage || browsingSimilar) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
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
  }, [location, debouncedSearch, exploreSeed, reloadToken, textSearchReady]);

  const loadMoreLibrary = useCallback((): Promise<GalleryImage[]> => {
    if (browsingAlbums || browsingStorage || browsingSimilar || loading || nextOffset === null) return Promise.resolve([]);
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
  }, [location, debouncedSearch, exploreSeed, loading, nextOffset]);
  const loadMore = browsingSimilar ? imageSimilarity.loadMore : loadMoreLibrary;

  const resetSimilarSearch = useCallback(() => {
    similarRequestVersionRef.current += 1;
    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    similarControllerRef.current = null;
    similarLoadMoreControllerRef.current = null;
    similarLoadMorePromiseRef.current = null;
    setSimilarPage(EMPTY_SIMILAR_IMAGE_PAGE);
    setSimilarLoading(false);
    setSimilarLoadingMore(false);
    setSimilarError(null);
  }, []);

  const activateLocation = useCallback((next: GalleryLocation) => {
    locationRef.current = next;
    if (next.section === "similar") lastSimilarPathRef.current = next.path;
    requestVersionRef.current++;
    skipInitialImagesRef.current = false;
    loadMoreControllerRef.current?.abort();
    setLocation(next);
    setImagePage(EMPTY_IMAGE_PAGE);
    setLoading(next.section === "library" || (next.section === "albums" && Boolean(next.path)));
    setLoadingMore(false);
    setError(null);
    setSearch("");
    setSearchOpen(false);
    setExploreSeed("");
    setMobileNavOpen(false);
    setInfoImage(null);
    viewerImageIdRef.current = null;
    setViewerImageId(null);
    setViewerDiscoveredImages([]);
    setViewerReturnRequest(null);
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    resetSimilarSearch();
  }, [resetSimilarSearch]);

  const openSimilarSearch = useCallback((source: GalleryImage) => {
    setGalleryQuerySnapshot(source);
    const href = galleryHref("similar", source.id);
    if (viewerHistoryActiveRef.current || readViewerHistoryEntry(window.history.state)) {
      window.history.replaceState(null, "", href);
    } else if (href !== window.location.pathname + window.location.search) {
      window.history.pushState(null, "", href);
    }
    viewerHistoryActiveRef.current = false;
    viewerHistoryClosingRef.current = false;
    activateLocation({ section: "similar", path: source.id });
  }, [activateLocation]);

  const searchSimilar = useCallback((source: GalleryImage, force = false) => {
    const sameSource = similarPage.source?.id === source.id;
    if (!force && sameSource && (similarLoading || !similarError)) return;

    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    similarLoadMoreControllerRef.current = null;
    similarLoadMorePromiseRef.current = null;
    const controller = new AbortController();
    const requestVersion = ++similarRequestVersionRef.current;
    similarControllerRef.current = controller;
    setSimilarPage({ source, images: [], total: 0, nextOffset: null });
    setSimilarLoading(true);
    setSimilarLoadingMore(false);
    setSimilarError(null);

    void getSimilarImages(
      source.id,
      { offset: 0, limit: SIMILAR_PAGE_SIZE },
      controller.signal,
    )
      .then((page) => {
        if (requestVersion !== similarRequestVersionRef.current) return;
        setSimilarPage({
          source,
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
        setViewerDiscoveredImages((current) => appendUniqueImages(current, page.items));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && requestVersion === similarRequestVersionRef.current) {
          setSimilarError(errorMessage(reason, "无法查找相似图片"));
        }
      })
      .finally(() => {
        if (similarControllerRef.current === controller) {
          similarControllerRef.current = null;
          if (requestVersion === similarRequestVersionRef.current) setSimilarLoading(false);
        }
      });
  }, [similarError, similarLoading, similarPage.source?.id]);

  useEffect(() => {
    const complete = Boolean(status?.backgroundComplete);
    const justCompleted = complete && !backgroundCompletionRef.current;
    backgroundCompletionRef.current = complete;
    if (justCompleted && similarPage.source) {
      searchSimilar(similarPage.source, true);
    }
  }, [searchSimilar, similarPage.source, status]);

  const loadMoreSimilar = useCallback((): Promise<GalleryImage[]> => {
    const source = similarPage.source;
    const offset = similarPage.nextOffset;
    if (!source || similarLoading || offset === null) return Promise.resolve([]);
    const pending = similarLoadMorePromiseRef.current;
    if (pending) return pending;

    const controller = new AbortController();
    const requestVersion = similarRequestVersionRef.current;
    similarLoadMoreControllerRef.current = controller;
    setSimilarLoadingMore(true);
    setSimilarError(null);

    const promise = (async () => {
      try {
        const page = await getSimilarImages(
          source.id,
          { offset, limit: SIMILAR_PAGE_SIZE },
          controller.signal,
        );
        if (requestVersion !== similarRequestVersionRef.current) return [];
        setSimilarPage((current) => current.source?.id === source.id
          ? {
              source,
              images: appendUniqueImages(current.images, page.items),
              total: page.total,
              nextOffset: page.nextOffset,
            }
          : current);
        setViewerDiscoveredImages((current) => appendUniqueImages(current, page.items));
        return page.items;
      } catch (reason) {
        if (!controller.signal.aborted && requestVersion === similarRequestVersionRef.current) {
          setSimilarError(errorMessage(reason, "无法继续加载相似图片"));
        }
        return [];
      } finally {
        if (similarLoadMoreControllerRef.current === controller) {
          similarLoadMoreControllerRef.current = null;
          similarLoadMorePromiseRef.current = null;
          if (requestVersion === similarRequestVersionRef.current) {
            setSimilarLoadingMore(false);
          }
        }
      }
    })();
    similarLoadMorePromiseRef.current = promise;
    return promise;
  }, [similarLoading, similarPage.nextOffset, similarPage.source]);

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
    ? viewerImages.findIndex((image) => image.id === viewerImageId)
    : -1;
  const galleryViewerIndex = viewerImageId
    ? images.findIndex((image) => image.id === viewerImageId)
    : -1;
  const viewerImage = viewerIndex >= 0 ? viewerImages[viewerIndex] : null;
  const similarActive = Boolean(
    viewerImage && similarPage.source?.id === viewerImage.id,
  );
  const viewerCanLoadMore = Boolean(
    viewerImage && (
      images.some((candidate) => candidate.id === viewerImage.id)
        ? nextOffset !== null
        : similarActive && similarPage.nextOffset !== null
    ),
  );

  const closeViewerState = useCallback(() => {
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
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    viewerImageIdRef.current = null;
    setViewerImageId(null);
  }, [resetSimilarSearch]);

  const restoreViewerFromHistory = useCallback((snapshot: GalleryImage) => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    const card = imageCardById(snapshot.id);
    viewerAnchorRef.current = card ? captureViewerAnchor(card) : null;
    prepareViewerImages([snapshot], 0);
    resetSimilarSearch();
    setViewerDiscoveredImages((current) => appendUniqueImages(current, [snapshot]));
    setViewerReturnRequest(null);
    viewerImageIdRef.current = snapshot.id;
    setViewerImageId(snapshot.id);
  }, [resetSimilarSearch]);

  const enterViewerHistory = useCallback((snapshot: GalleryImage) => {
    try {
      const state = viewerHistoryState(snapshot);
      if (readViewerHistoryEntry(window.history.state)) {
        window.history.replaceState(state, "", window.location.href);
      } else {
        window.history.pushState(state, "", window.location.href);
      }
      viewerHistoryActiveRef.current = true;
      viewerHistoryClosingRef.current = false;
    } catch {
      viewerHistoryActiveRef.current = false;
      viewerHistoryClosingRef.current = false;
    }
  }, []);

  const openViewer = useCallback((
    imageId: string,
    card: HTMLElement,
    pointerY?: number,
    action: ImageCardAction = "view",
  ) => {
    const snapshot = images.find((image) => image.id === imageId);
    if (!snapshot) return;
    if (action === "details") { setInfoImage(snapshot); return; }
    if (action === "similar") { openSimilarSearch(snapshot); return; }
    if (!viewerImageIdRef.current && snapshot) enterViewerHistory(snapshot);
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    viewerAnchorRef.current = captureViewerAnchor(card, pointerY);
    prepareViewerImages(images, images.findIndex((image) => image.id === imageId));
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    setViewerReturnRequest(null);
    viewerImageIdRef.current = imageId;
    setViewerImageId(imageId);
  }, [enterViewerHistory, images, openSimilarSearch, resetSimilarSearch]);

  const closeViewer = useCallback(() => {
    if (!viewerImageIdRef.current || viewerHistoryClosingRef.current) return;
    if (
      viewerHistoryActiveRef.current
      && readViewerHistoryEntry(window.history.state)
    ) {
      viewerHistoryClosingRef.current = true;
      window.history.back();
      return;
    }
    viewerHistoryActiveRef.current = false;
    closeViewerState();
  }, [closeViewerState]);

  useEffect(() => {
    const applyHistoryState = (state: unknown) => {
      const next = readGalleryLocation();
      if (next.section !== locationRef.current.section || next.path !== locationRef.current.path) {
        activateLocation(next);
      }
      const entry = readViewerHistoryEntry(state);
      viewerHistoryActiveRef.current = Boolean(entry);
      viewerHistoryClosingRef.current = false;
      if (entry) {
        if (viewerImageIdRef.current !== entry.image.id) {
          restoreViewerFromHistory(entry.image);
        }
      } else if (viewerImageIdRef.current) {
        closeViewerState();
      }
    };
    const onPopState = (event: PopStateEvent) => applyHistoryState(event.state);
    window.addEventListener("popstate", onPopState);
    const currentEntry = readViewerHistoryEntry(window.history.state);
    viewerHistoryActiveRef.current = Boolean(currentEntry);
    if (currentEntry && !viewerImageIdRef.current) {
      restoreViewerFromHistory(currentEntry.image);
    }
    return () => window.removeEventListener("popstate", onPopState);
  }, [activateLocation, closeViewerState, restoreViewerFromHistory]);

  useLayoutEffect(() => {
    if (!viewerImage || !viewerHistoryActiveRef.current) return;
    const entry = readViewerHistoryEntry(window.history.state);
    if (!entry || entry.image.id === viewerImage.id) return;
    try {
      window.history.replaceState(
        viewerHistoryState(viewerImage),
        "",
        window.location.href,
      );
    } catch {
      viewerHistoryActiveRef.current = false;
    }
  }, [viewerImage]);

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
    let observedGallery: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeObserverPrimed = false;

    const observeLayout = (card: HTMLElement) => {
      const gallery = card.closest<HTMLElement>(".justified-gallery");
      if (resizeObserver && card !== observedCard) {
        if (observedCard) resizeObserver.unobserve(observedCard);
        resizeObserver.observe(card);
        observedCard = card;
      }
      if (resizeObserver && gallery && gallery !== observedGallery) {
        if (observedGallery) resizeObserver.unobserve(observedGallery);
        resizeObserver.observe(gallery);
        observedGallery = gallery;
      }
    };

    const alignToCard = (): HTMLElement | null => {
      const card = imageCardById(request.imageId);
      if (!card) return null;
      observeLayout(card);

      const targetScroll = scrollTopForAnchor(card, request);
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
        scrollWindowImmediately(scrollTopForAnchor(null, request));
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
    const gallery = document.querySelector(".justified-gallery");
    if (gallery) mutationObserver.observe(gallery, { childList: true });
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
    if (!viewerImageId || galleryViewerIndex < 0 || nextOffset === null) return;
    if (galleryViewerIndex >= images.length - 5) void loadMore();
  }, [galleryViewerIndex, images.length, loadMore, nextOffset, viewerImageId]);

  const openViewerImage = useCallback((candidate: GalleryImage, action: ImageCardAction = "view") => {
    if (action === "details") { setInfoImage(candidate); return; }
    if (action === "similar") { openSimilarSearch(candidate); return; }
    setViewerDiscoveredImages((current) => appendUniqueImages(current, [candidate]));
    prepareViewerImages([candidate], 0);
    viewerImageIdRef.current = candidate.id;
    setViewerImageId(candidate.id);
    searchSimilar(candidate);
  }, [openSimilarSearch, searchSimilar]);

  const navigateViewer = useCallback((direction: -1 | 1) => {
    const currentImageId = viewerImageIdRef.current;
    if (!currentImageId) return;
    const currentIndex = viewerImages.findIndex((image) => image.id === currentImageId);
    if (currentIndex < 0) return;
    const target = viewerImages[currentIndex + direction];
    if (target) {
      viewerImageIdRef.current = target.id;
      setViewerImageId(target.id);
      return;
    }
    if (direction < 0) return;

    const startingId = currentImageId;
    const pending = similarPage.source?.id === currentImageId
      && similarPage.nextOffset !== null
      ? loadMoreSimilar()
      : nextOffset !== null && images.some((candidate) => candidate.id === currentImageId)
        ? loadMore()
        : Promise.resolve([]);
    void pending.then((incoming) => {
      const next = incoming[0];
      if (!next || viewerImageIdRef.current !== startingId) return;
      viewerImageIdRef.current = next.id;
      setViewerImageId(next.id);
    });
  }, [images, loadMore, loadMoreSimilar, nextOffset, similarPage, viewerImages]);

  const navigateTo = (section: GallerySection, path = "", replace = false) => {
    const href = galleryHref(section, path);
    if (href !== window.location.pathname + window.location.search) {
      window.history[replace ? "replaceState" : "pushState"](null, "", href);
    }
    viewerHistoryActiveRef.current = false;
    viewerHistoryClosingRef.current = false;
    activateLocation({ section, path: section === "storage" ? path || "/" : section === "library" ? "" : path });
  };
  const chooseAlbum = (path: string) => navigateTo("albums", path);
  const changeSearch = (value: string) => {
    setSearch(value);
    setExploreSeed("");
    setViewerImageId(null);
  };
  const goHome = () => {
    navigateTo("library");
    setReloadToken((value) => value + 1);
  };
  const startExploring = () => {
    if (browsingAlbums || browsingStorage || browsingSimilar) navigateTo("library");
    setSearchOpen(false);
    setMobileNavOpen(false);
    setViewerImageId(null);
    setExploreSeed(createExploreSeed());
  };

  useEffect(() => {
    if (summary && album && !summary.albums.some(item => item.path === album)) {
      navigateTo("albums", "", true);
    }
  }, [album, summary]);

  const pageLoading = browsingSimilar ? imageSimilarity.loading : browsingStorage ? false : browsingAlbums ? !summary : loading;
  return (
    <div
      className="app-shell"
      data-gallery-section={section}
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-navigation-open={mobileNavOpen}
      data-viewer-returning={Boolean(viewerReturnRequest)}
      data-viewer-return-image-id={viewerReturnRequest?.imageId}
    >
      <div className="topbar-surface" aria-hidden="true" />
      <Header
        search={search}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        searchMode={textSearchMode}
        albumSearch={browsingAlbums}
        storageSearch={browsingStorage}
        similarSearch={browsingSimilar}
        onSearchChange={changeSearch}
        onExplore={startExploring}
        exploreActive={Boolean(exploreSeed)}
        exploreLoading={Boolean(exploreSeed) && loading}
        onHome={goHome}
        onToggleNavigation={() => {
          if (compactLayout) {
            setMobileNavOpen((open) => !open);
          } else {
            const updateLayout = () => setSidebarCollapsed((collapsed) => !collapsed);
            if (galleryLayoutRef.current) galleryLayoutRef.current.resize(updateLayout);
            else updateLayout();
          }
        }}
        navigationOpen={compactLayout ? mobileNavOpen : !sidebarCollapsed}
        compactLayout={compactLayout}
      />
      <div
        className="request-progress"
        data-visible={pageLoading}
        role="progressbar"
        aria-label="正在更新图库"
        aria-hidden={!pageLoading}
      >
        <span key={reloadToken} />
      </div>
      <Sidebar
        summary={summary}
        activeSection={section}
        onChoose={section => navigateTo(section, section === "similar" ? lastSimilarPathRef.current : "")}
        onHome={goHome}
        mobileOpen={mobileNavOpen}
        mobileMounted={mobileNavMounted}
        onMobileExited={finishMobileNavExit}
        onClose={() => setMobileNavOpen(false)}
        desktopCollapsed={sidebarCollapsed}
        onSettings={() => setSettingsSection("account")}
      />

      <main className="content" aria-busy={pageLoading || pageLoadingMore}>
        {error && !browsingStorage && !browsingSimilar && (
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

        {browsingSimilar ? (
          <SimilarSearchView
            source={querySource}
            results={imageSimilarity}
            filter={search}
            onUpload={file => { setUploadedQuery(file); setGalleryQuerySnapshot(null); navigateTo("similar"); }}
            onClear={() => { setUploadedQuery(null); setGalleryQuerySnapshot(null); navigateTo("similar"); }}
            onOpen={openViewer}
            layoutRef={galleryLayoutRef}
            preserveViewport={viewerIndex < 0 && !viewerReturnRequest}
          />
        ) : browsingStorage ? (
          authentication.guest ? (
            <div className="empty-state"><strong>外部存储仅限管理员访问</strong><a className="sidebar-login-link" href="/login">管理员登录</a></div>
          ) : <ExternalStorageView
            path={path}
            search={search}
            revision={storageRevision}
            onOpen={path => navigateTo("storage", path)}
            onConfigure={() => setSettingsSection("storage")}
          />
        ) : browsingAlbums ? (
          <AlbumsView albums={summary?.albums} search={search} onOpen={chooseAlbum} />
        ) : (
          <>
            {selectedAlbum && <AlbumHeading album={selectedAlbum} onOpen={chooseAlbum} />}
            {loading ? (
              <GallerySkeleton />
            ) : images.length ? (
              <JustifiedGallery
                ref={galleryLayoutRef}
                images={images}
                preserveViewport={viewerIndex < 0 && !viewerReturnRequest}
                onOpen={openViewer}
              />
            ) : (
              <div className="empty-state">
                <ImageIcon size={30} strokeWidth={1.6} />
                <strong>{selectedAlbum?.count === 0 ? "相册暂无图片" : summary?.total === 0 ? "图库暂无图片" : "没有找到图片"}</strong>
                <span>
                  {summary?.total === 0 || selectedAlbum?.count === 0
                    ? "添加图片后将自动显示"
                    : textSearchReady && debouncedSearch
                      ? "换一种自然语言描述，或减少限定词"
                      : "请调整相册或搜索条件"}
                </span>
              </div>
            )}

            <div ref={sentinelRef} className="load-sentinel" aria-live="polite">
              {loadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
              {!loading && nextOffset === null && images.length > 0 && (
                <span>已显示全部 {formatCount(total)} 张图片</span>
              )}
            </div>
          </>
        )}
      </main>
      {settingsSection && !authentication.guest && (
        <SettingsDialog
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
          onStorageSaved={() => {
            setStorageRevision(value => value + 1);
            if (browsingStorage) navigateTo("storage");
          }}
        />
      )}
      {!browsingAlbums && !browsingStorage && viewerIndex >= 0 && (
        <ImageViewer
          images={viewerImages}
          activeIndex={viewerIndex}
          hasMore={viewerCanLoadMore}
          loadingMore={pageLoadingMore || similarLoadingMore}
          onNavigate={navigateViewer}
          onClose={closeViewer}
          similarActive={similarActive}
          similarImages={similarActive ? similarPage.images : []}
          similarTotal={similarActive ? similarPage.total : 0}
          similarHasMore={similarActive && similarPage.nextOffset !== null}
          similarLoading={similarActive && similarLoading}
          similarLoadingMore={similarActive && similarLoadingMore}
          similarError={similarActive ? similarError : null}
          onSearchSimilar={searchSimilar}
          onLoadMoreSimilar={loadMoreSimilar}
          onOpenImage={openViewerImage}
        />
      )}
      {infoImage && <PhotoInformationDialog image={infoImage} onClose={() => setInfoImage(null)} />}
    </div>
  );
}

export default App;
