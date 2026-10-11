import {
  ImageIcon,
  Heart,
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
import { useOverlayNavigation } from "./useOverlayNavigation";
import { UploadDialog } from "./UploadDialog";
import { useAutoHideTopbar } from "./useAutoHideTopbar";
import { DEFAULT_IMAGE_FILTERS, imageFilterLabels } from "./GalleryFilters";
import { contentCategory } from "./contentCategories";
import { AlbumBackLink, AlbumGrid, AlbumsView } from "./AlbumsView";
import { useAlbumSelection } from "./SelectableAlbums";
import { LocalStorageView, type LocalMediaPage } from "./LocalStorageView";
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
  visualViewportBounds,
} from "./galleryViewport";
import type { ViewerAnchor } from "./galleryViewport";
import { ImageViewer } from "./ImageViewer";
import { PhotoInformationDialog } from "./PhotoInformationDialog";
import { SimilarSearchView } from "./SimilarSearchView";
import { useImageSimilarity } from "./useImageSimilarity";
import type { ImageSearchSource } from "./useImageSimilarity";
import { appendUniqueImages } from "./galleryImages";
import { GallerySkeleton } from "./JustifiedGallery";
import { SelectableGallery, type SelectableGalleryHandle } from "./SelectableGallery";
import { TrashView } from "./TrashView";
import { MANAGEMENT_CHANGED, useManagement } from "./management";
import { ensureSelectionHistory, handleSelectionHistory, writeHistoryState } from "./selectionHistory";
import { useSelectionDismiss } from "./useSelectionDismiss";
import {
  getGallery,
  getContentCategories,
  getImages,
  getGalleryImage,
  getSimilarImages,
  searchByUploadedImage,
  getStatus,
  takeInitialBootstrap,
} from "./api";
import type {
  ContentCategory,
  GalleryImage,
  GallerySection,
  GallerySummary,
  ImageCardAction,
  ImageFilters,
  ThumbnailStatus,
} from "./types";
import {
  prepareViewerImages,
  releaseViewerAssets,
  releaseViewerMedia,
  VIEWER_PAGE_PREFETCH_DISTANCE,
} from "./viewerAssets";
import { useViewerAssetLifecycle } from "./useViewerAssetLifecycle";
import { stopMediaPreview } from "./MediaPreview";
import type { VideoFrame } from "./videoFrame";
import { galleryHistoryState, readViewerHistoryEntry, viewerHistoryState, type SimilarImagePageState, type ViewerBranch, type ViewerHistoryEntry } from "./viewerHistory";

const PAGE_SIZE = 60;
const SIMILAR_PAGE_SIZE = 30;
const MOBILE_PAGE_PREFETCH_MARGIN = "1400px 0px";
const DESKTOP_PAGE_PREFETCH_MARGIN = "900px 0px";
const GALLERY_POLL_INTERVAL_MS = 10_000;
const MOBILE_NAV_EXIT_MS = 240;
const VIEWER_RETURN_SETTLE_MS = 32;
const VIEWER_RETURN_TIMEOUT_MS = 480;
const VIEWER_RETURN_ANIMATION_MS = 280;
const INITIAL_BOOTSTRAP = takeInitialBootstrap();

type ImagePageState = {
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

type ViewerReturnRequest = ViewerAnchor & {
  parentImageId?: string;
  imageId: string;
  sequence: number;
};

type ViewerReturnFlight = {
  layer: HTMLDivElement;
  backdrop: HTMLDivElement;
  media: HTMLElement;
  source: DOMRect;
  visible: boolean;
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

function disposeViewerReturnFlight(flight: ViewerReturnFlight | null): void {
  if (!flight) return;
  for (const animation of flight.animations) animation.cancel();
  releaseViewerMedia(flight.layer);
  flight.layer.remove();
}

function createViewerReturnFlight(): ViewerReturnFlight | null {
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
      document.documentElement.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
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
      document.documentElement.style.removeProperty("--visual-viewport-height");
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
  const manager = useManagement();
  useVisualViewportTop();
  const [location, setLocation] = useState(readGalleryLocation);
  const locationRef = useRef(location);
  const { section, path } = location;
  const album = section === "albums" ? path : "";
  const browsingLocal = section === "local";
  const browsingStorage = section === "storage";
  const browsingFavorites = section === "favorites";
  const browsingTrash = section === "trash";
  const browsingSimilar = section === "similar";
  const browsingAlbums = section === "albums" && !album;
  const hasInitialImages = Boolean(INITIAL_BOOTSTRAP && section === "library");
  const [summary, setSummary] = useState<GallerySummary | null>(
    INITIAL_BOOTSTRAP?.summary ?? null,
  );
  const [status, setStatus] = useState<ThumbnailStatus | null>(
    INITIAL_BOOTSTRAP?.status ?? null,
  );
  const [imagePage, setImagePageState] = useState<ImagePageState>(() => (
    hasInitialImages && INITIAL_BOOTSTRAP
      ? {
          images: INITIAL_BOOTSTRAP.images.items,
          total: INITIAL_BOOTSTRAP.images.total,
          nextOffset: INITIAL_BOOTSTRAP.images.nextOffset,
        }
      : EMPTY_IMAGE_PAGE
  ));
  const imagePageRef = useRef(imagePage);
  const setImagePage = useCallback((page: ImagePageState) => {
    // Invalidate old pagination callbacks before the next render flushes effects.
    imagePageRef.current = page;
    setImagePageState(page);
  }, []);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [imageFilters, setImageFilters] = useState<ImageFilters>(DEFAULT_IMAGE_FILTERS);
  const [categories, setCategories] = useState<ContentCategory[]>([]);
  const [categoriesHint, setCategoriesHint] = useState("正在读取分类…");
  const categoriesController = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController();
    categoriesController.current = controller;
    void getContentCategories(controller.signal).then(value => {
      if (!controller.signal.aborted) { setCategories(value); setCategoriesHint(""); }
    }).catch(() => {
      if (!controller.signal.aborted) setCategoriesHint("分类暂时无法读取，请刷新重试。");
    });
    return () => controller.abort();
  }, []);
  const [exploreSeed, setExploreSeed] = useState("");
  const [loading, setLoading] = useState(!hasInitialImages && !browsingAlbums && !browsingLocal && !browsingStorage && !browsingTrash && !browsingSimilar);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [storageRevision, setStorageRevision] = useState(0);
  const [localMedia, setLocalMedia] = useState<LocalMediaPage | null>(null);
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
  const [selectionToolbar, setSelectionToolbar] = useState<HTMLDivElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const galleryLayoutRef = useRef<SelectableGalleryHandle>(null);
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [slideshowRequest, setSlideshowRequest] = useState(0);
  const [viewerDiscoveredImages, setViewerDiscoveredImages] = useState<GalleryImage[]>([]);
  const [viewerBranch, setViewerBranch] = useState<ViewerBranch | null>(null);
  const viewerBranchRef = useRef<ViewerBranch | null>(null);
  const [viewerLoadingMore, setViewerLoadingMore] = useState(false);
  const viewerLoadJobRef = useRef<{ images: GalleryImage[]; controller: AbortController; promise: Promise<GalleryImage[]> } | null>(null);
  const updateViewerBranch = useCallback((branch: ViewerBranch | null) => {
    viewerBranchRef.current = branch;
    setViewerBranch(branch);
  }, []);
  const [similarPage, setSimilarPage] = useState<SimilarImagePageState>(
    EMPTY_SIMILAR_IMAGE_PAGE,
  );
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);
  const [viewerReturnRequest, setViewerReturnRequest] = useState<ViewerReturnRequest | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const desktopNav = useOverlayNavigation(compactLayout);
  const sidebarCollapsed = !desktopNav.open;
  const { mounted: mobileNavMounted, finishExit: finishMobileNavExit } = useTransitionPresence(
    mobileNavOpen,
    MOBILE_NAV_EXIT_MS,
  );
  const topbar = useAutoHideTopbar(Boolean(searchOpen || menuOpen || uploadOpen || desktopNav.open || mobileNavMounted || viewerImageId
    || viewerReturnRequest || settingsSection || infoImage), location, sidebarCollapsed);
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
  const filtersAvailable = !browsingAlbums && !browsingLocal && !browsingStorage && !browsingTrash && !browsingSimilar;
  const filterLabels = imageFilterLabels(imageFilters, textSearchReady && !browsingFavorites ? search : "", categories);
  const requestImages = useCallback((offset: number, signal: AbortSignal) => getImages({
    album, favorites: browsingFavorites, search: debouncedSearch,
    ...imageFilters, seed: exploreSeed, offset, limit: PAGE_SIZE,
  }, signal), [album, browsingFavorites, debouncedSearch, exploreSeed, imageFilters]);
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
  const { images, total, nextOffset } = browsingSimilar ? imageSimilarity : browsingLocal && localMedia ? localMedia : imagePage;
  const pageLoadingMore = browsingSimilar ? imageSimilarity.loadingMore : browsingLocal ? Boolean(localMedia?.loadingMore) : loadingMore;
  const selectedAlbum = useMemo(() => summary?.albums.find(item => item.path === album), [summary, album]);
  const visibleAlbums = useMemo(() => {
    const albums = summary?.albums ?? [];
    const query = search.trim().toLocaleLowerCase();
    if (browsingFavorites) return albums.filter(item => manager.favoriteAlbums.has(item.path) && (!query || item.path.toLocaleLowerCase().includes(query)));
    if (browsingAlbums) return albums.filter(item => !query || item.path.toLocaleLowerCase().includes(query));
    return [];
  }, [summary, search, browsingFavorites, browsingAlbums, manager.favoriteAlbums]);
  const albumSelection = useAlbumSelection(visibleAlbums, `${section}:${path}:${search}`, () => galleryLayoutRef.current?.clearSelection());
  const selectionActive = selectedIds.size > 0 || Boolean(albumSelection.selection?.active);
  const clearSelection = useCallback(() => {
    galleryLayoutRef.current?.clearSelection();
    setSelectedIds(new Set());
    albumSelection.clear();
  }, [albumSelection.clear]);
  const selectionStateRef = useRef({ active: selectionActive, clear: clearSelection });
  selectionStateRef.current = { active: selectionActive, clear: clearSelection };
  useSelectionDismiss(selectionActive, manager.busy, Boolean(viewerImageId), clearSelection);
  useEffect(() => {
    const changed = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action !== "favorite") {
        setViewerImageId(null);
        setViewerDiscoveredImages([]);
        updateViewerBranch(null);
        viewerLoadJobRef.current?.controller.abort();
        if (browsingSimilar) imageSimilarity.retry();
      }
      if (action !== "favorite" || browsingFavorites) setReloadToken(value => value + 1);
    };
    window.addEventListener(MANAGEMENT_CHANGED, changed);
    return () => window.removeEventListener(MANAGEMENT_CHANGED, changed);
  }, [browsingFavorites, browsingSimilar, imageSimilarity.retry]);
  const viewerImages = useMemo(
    () => viewerBranch?.images ?? appendUniqueImages(images, viewerDiscoveredImages),
    [images, viewerDiscoveredImages, viewerBranch],
  );

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location, debouncedSearch, exploreSeed, imageFilters]);

  useLayoutEffect(() => {
    viewerImageIdRef.current = viewerImageId;
  }, [viewerImageId]);

  useEffect(() => () => {
    releaseViewerAssets();
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    loadMoreControllerRef.current?.abort();
    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    viewerLoadJobRef.current?.controller.abort();
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
    if (reloadToken === 0 && INITIAL_BOOTSTRAP) return;
    const controller = new AbortController();
    getGallery(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
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
        const complete = next.backgroundComplete && next.textSearch.backgroundComplete
          && (!next.videos || (next.videos.playback.backgroundComplete && next.videos.preview.backgroundComplete));
        timer = window.setTimeout(poll, complete ? 10000 : 1500);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
      }
    };
    const initialDelay = INITIAL_BOOTSTRAP
      ? (
          INITIAL_BOOTSTRAP.status.backgroundComplete
          && INITIAL_BOOTSTRAP.status.textSearch.backgroundComplete
          && (!INITIAL_BOOTSTRAP.status.videos || (INITIAL_BOOTSTRAP.status.videos.playback.backgroundComplete
            && INITIAL_BOOTSTRAP.status.videos.preview.backgroundComplete))
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
    if (browsingAlbums || browsingLocal || browsingStorage || browsingTrash || browsingSimilar) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    requestImages(0, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return;
        setImagePage({
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
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
  }, [location, requestImages, reloadToken, textSearchReady]);

  const loadMoreLibrary = useCallback((): Promise<GalleryImage[]> => {
    if (imagePageRef.current !== imagePage) return Promise.resolve([]);
    const offset = imagePage.nextOffset;
    if (browsingAlbums || browsingLocal || browsingStorage || browsingTrash || browsingSimilar || loading || offset === null) return Promise.resolve([]);
    const pending = loadMorePromiseRef.current;
    if (pending) return pending;

    const controller = new AbortController();
    const requestVersion = requestVersionRef.current;
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);

    const promise = (async () => {
      try {
        const page = await requestImages(offset, controller.signal);
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return [];
        const images = appendUniqueImages(imagePage.images, page.items);
        setImagePage({ images, total: page.total, nextOffset: page.nextOffset });
        return images.slice(imagePage.images.length);
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
  }, [location, requestImages, loading, imagePage]);
  const loadMore = browsingSimilar ? imageSimilarity.loadMore : browsingLocal && localMedia ? localMedia.loadMore : loadMoreLibrary;

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
    clearSelection();
    locationRef.current = next;
    if (next.section === "similar") lastSimilarPathRef.current = next.path;
    requestVersionRef.current++;
    skipInitialImagesRef.current = false;
    loadMoreControllerRef.current?.abort();
    setLocation(next);
    setImagePage(EMPTY_IMAGE_PAGE);
    setLoading(next.section === "library" || next.section === "favorites" || (next.section === "albums" && Boolean(next.path)));
    setLoadingMore(false);
    setError(null);
    setSearch("");
    setSearchOpen(false);
    setExploreSeed("");
    setImageFilters(DEFAULT_IMAGE_FILTERS);
    setMobileNavOpen(false);
    setInfoImage(null);
    setSlideshowRequest(0);
    viewerImageIdRef.current = null;
    setViewerImageId(null);
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    setViewerReturnRequest(null);
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    resetSimilarSearch();
  }, [resetSimilarSearch, clearSelection]);

  const openSimilarSearch = useCallback((source: GalleryImage) => {
    setGalleryQuerySnapshot(source);
    const href = galleryHref("similar", source.id);
    if (viewerHistoryActiveRef.current || readViewerHistoryEntry(window.history.state)) {
      writeHistoryState(null, href, true);
    } else if (href !== window.location.pathname + window.location.search) {
      writeHistoryState(null, href);
    }
    viewerHistoryActiveRef.current = false;
    viewerHistoryClosingRef.current = false;
    activateLocation({ section: "similar", path: source.id });
  }, [activateLocation]);

  const searchSimilar = useCallback((source: GalleryImage, force = false, capturedFrame?: VideoFrame) => {
    const sameSource = similarPage.source?.id === source.id;
    const frame = capturedFrame ?? (sameSource ? similarPage.frame : undefined);
    if (!force && sameSource && (similarLoading || !similarError)) return;

    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    similarLoadMoreControllerRef.current = null;
    similarLoadMorePromiseRef.current = null;
    const controller = new AbortController();
    const requestVersion = ++similarRequestVersionRef.current;
    similarControllerRef.current = controller;
    setSimilarPage({ source, frame, images: [], total: 0, nextOffset: null });
    setSimilarLoading(true);
    setSimilarLoadingMore(false);
    setSimilarError(null);

    const options = { offset: 0, limit: SIMILAR_PAGE_SIZE, exclude: source.id };
    void (frame ? searchByUploadedImage(frame.file, options, controller.signal)
      : getSimilarImages(source.id, options, controller.signal))
      .then((page) => {
        if (requestVersion !== similarRequestVersionRef.current) return;
        setSimilarPage({
          source,
          frame,
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
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
  }, [similarError, similarLoading, similarPage.source?.id, similarPage.frame]);

  const searchVideoFrame = useCallback((source: GalleryImage, frame: VideoFrame) => {
    searchSimilar(source, true, frame);
  }, [searchSimilar]);

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
    const frame = similarPage.frame;
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
        const options = { offset, limit: SIMILAR_PAGE_SIZE, exclude: source.id };
        const page = await (frame ? searchByUploadedImage(frame.file, options, controller.signal)
          : getSimilarImages(source.id, options, controller.signal));
        if (requestVersion !== similarRequestVersionRef.current) return [];
        setSimilarPage((current) => current.source?.id === source.id
          ? {
              source,
              frame,
              images: appendUniqueImages(current.images, page.items),
              total: page.total,
              nextOffset: page.nextOffset,
            }
          : current);
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
  }, [similarLoading, similarPage.nextOffset, similarPage.source, similarPage.frame]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextOffset === null || loading || loadingMore || error || viewerImageId) return;
    const margin = compactLayout ? MOBILE_PAGE_PREFETCH_MARGIN : DESKTOP_PAGE_PREFETCH_MARGIN;
    let active = true;
    const gallery = sentinel.parentElement?.querySelector<HTMLElement>(".justified-gallery");
    const ready = () => !gallery || (Number(gallery.dataset.layoutWidth) > 0 && gallery.getBoundingClientRect().height > 0);
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A queued notification may describe the position before a scroll or resize.
        if (active && entry.isIntersecting && ready()
          && sentinel.getBoundingClientRect().top <= window.innerHeight + parseFloat(margin)) void loadMore();
      },
      { rootMargin: margin },
    );
    // Do not treat the gallery's unmeasured, zero-height first frame as an empty page.
    const layout = new ResizeObserver(() => {
      if (!ready()) return;
      layout.disconnect();
      observer.observe(sentinel);
    });
    if (ready()) observer.observe(sentinel);
    else layout.observe(gallery!);
    return () => { active = false; layout.disconnect(); observer.disconnect(); };
  }, [compactLayout, loadMore, nextOffset, loading, loadingMore, error, viewerImageId]);

  const viewerIndex = viewerImageId
    ? viewerBranch?.index ?? viewerImages.findIndex((image) => image.id === viewerImageId)
    : -1;
  const galleryViewerIndex = viewerImageId
    ? images.findIndex((image) => image.id === viewerImageId)
    : -1;
  const viewerImage = viewerIndex >= 0 ? viewerImages[viewerIndex] : null;
  useViewerAssetLifecycle(viewerImages, viewerIndex);
  const similarActive = Boolean(
    viewerImage && similarPage.source?.id === viewerImage.id,
  );
  const viewerCanLoadMore = Boolean(viewerImage && (viewerBranch ? viewerBranch.nextOffset !== null : nextOffset !== null));

  const recordViewerHistory = useCallback((snapshot: GalleryImage, branch: ViewerBranch | null, replace = false,
    similarPage: SimilarImagePageState | null = null, returnAnchor: ViewerHistoryEntry["returnAnchor"] = null) => {
    const current = readViewerHistoryEntry(window.history.state);
    const entry: ViewerHistoryEntry = { version: 3, image: snapshot, branch,
      depth: branch ? branch.parent.depth + 1 : 1,
      session: current?.session ?? `${Date.now()}-${Math.random()}`, similarPage, returnAnchor,
      detached: replace ? current?.detached : undefined };
    try {
      writeHistoryState(viewerHistoryState(entry), window.location.href, Boolean(replace && current));
      viewerHistoryActiveRef.current = true;
      viewerHistoryClosingRef.current = false;
    } catch {
      viewerHistoryActiveRef.current = false;
    }
    return entry;
  }, []);

  const loadMoreViewer = useCallback((): Promise<GalleryImage[]> => {
    const branch = viewerBranchRef.current;
    if (!branch) return loadMore();
    if (branch.nextOffset === null) return Promise.resolve([]);
    const pending = viewerLoadJobRef.current;
    if (pending?.images === branch.images) return pending.promise;
    pending?.controller.abort();
    const controller = new AbortController();
    setViewerLoadingMore(true);
    const options = { offset: branch.nextOffset, limit: SIMILAR_PAGE_SIZE, exclude: branch.source.id };
    const job = { images: branch.images, controller, promise: Promise.resolve([] as GalleryImage[]) };
    job.promise = (async () => {
      try {
        const page = await (branch.frame ? searchByUploadedImage(branch.frame.file, options, controller.signal)
          : getSimilarImages(branch.source.id, options, controller.signal));
        const current = viewerBranchRef.current;
        if (controller.signal.aborted || current?.images !== branch.images) return [];
        const next = { ...current, images: appendUniqueImages(current.images, page.items), total: page.total, nextOffset: page.nextOffset };
        updateViewerBranch(next);
        const entry = readViewerHistoryEntry(window.history.state);
        recordViewerHistory(next.images[next.index]!, next, true, entry?.similarPage, entry?.returnAnchor);
        return next.images.slice(current.images.length);
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason, "无法继续加载相似图片"));
        return [];
      } finally {
        if (viewerLoadJobRef.current === job) {
          viewerLoadJobRef.current = null;
          setViewerLoadingMore(false);
        }
      }
    })();
    viewerLoadJobRef.current = job;
    return job.promise;
  }, [loadMore, recordViewerHistory, updateViewerBranch]);

  const closeViewerState = useCallback(() => {
    setSlideshowRequest(0);
    const currentImageId = viewerImageIdRef.current;
    if (!currentImageId) return;
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    const hasGallery = Boolean(document.querySelector(".content .justified-gallery"));
    viewerReturnFlightRef.current = hasGallery ? createViewerReturnFlight() : null;
    const anchor = viewerAnchorRef.current ?? {
      cardRatio: 0.5,
      viewportRatio: 0.5,
      fallbackScrollY: window.scrollY,
    };
    viewerReturnSequenceRef.current += 1;
    setViewerReturnRequest(hasGallery ? {
      ...anchor,
      imageId: currentImageId,
      sequence: viewerReturnSequenceRef.current,
    } : null);
    if (!hasGallery) viewerAnchorRef.current = null;
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    viewerImageIdRef.current = null;
    setViewerImageId(null);
  }, [resetSimilarSearch, updateViewerBranch]);

  const restoreViewerFromHistory = useCallback((requested: ViewerHistoryEntry, returning = false) => {
    setSlideshowRequest(0);
    const child = viewerBranchRef.current;
    const currentImageId = viewerImageIdRef.current;
    let entry = requested;
    if (returning && child && currentImageId) {
      const parent = child.parent;
      entry = { ...parent, similarPage: { source: child.source, images: child.images, total: child.total,
        nextOffset: child.nextOffset, frame: child.frame },
        returnAnchor: parent.returnAnchor ? { ...parent.returnAnchor, imageId: currentImageId } : null };
      try { writeHistoryState(viewerHistoryState(entry), window.location.href, true); } catch { /* Restoring the UI still works. */ }
    }
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = returning ? createViewerReturnFlight() : null;
    const snapshot = entry.image;
    updateViewerBranch(entry.branch);
    viewerLoadJobRef.current?.controller.abort();
    const card = imageCardById(snapshot.id);
    if (!currentImageId) viewerAnchorRef.current = card ? captureViewerAnchor(card) : null;
    const candidates = entry.branch?.images ?? appendUniqueImages(images, [snapshot]);
    const index = candidates.findIndex(image => image.id === snapshot.id);
    prepareViewerImages(candidates, index);
    resetSimilarSearch();
    if (entry.similarPage) setSimilarPage(entry.similarPage);
    setViewerDiscoveredImages(current => appendUniqueImages(current, [snapshot]));
    viewerReturnSequenceRef.current += 1;
    setViewerReturnRequest(entry.returnAnchor ? { ...entry.returnAnchor, parentImageId: snapshot.id,
      sequence: viewerReturnSequenceRef.current } : null);
    viewerImageIdRef.current = snapshot.id;
    setViewerImageId(snapshot.id);
  }, [images, resetSimilarSearch, updateViewerBranch]);

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
    setSlideshowRequest(current => action === "slideshow" ? current + 1 : 0);
    if (!viewerImageIdRef.current) {
      if (!authentication.guest) ensureSelectionHistory();
      recordViewerHistory(snapshot, null);
    }
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    viewerAnchorRef.current = captureViewerAnchor(card, pointerY);
    stopMediaPreview();
    prepareViewerImages(images, images.findIndex((image) => image.id === imageId));
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    setViewerReturnRequest(null);
    viewerImageIdRef.current = imageId;
    setViewerImageId(imageId);
  }, [recordViewerHistory, images, openSimilarSearch, resetSimilarSearch, updateViewerBranch]);

  const closeViewer = useCallback(() => {
    setSlideshowRequest(0);
    if (!viewerImageIdRef.current || viewerHistoryClosingRef.current) return;
    const entry = readViewerHistoryEntry(window.history.state);
    if (viewerHistoryActiveRef.current && entry && !entry.detached && entry.depth < window.history.length) {
      viewerHistoryClosingRef.current = true;
      window.history.back();
      return;
    }
    const parent = viewerBranchRef.current?.parent;
    if (parent) {
      restoreViewerFromHistory(parent, true);
      const restored = readViewerHistoryEntry(window.history.state);
      if (restored) writeHistoryState(viewerHistoryState({ ...restored, detached: true }), window.location.href, true);
    } else {
      try { writeHistoryState(galleryHistoryState(), window.location.href, true); } catch { /* History can be unavailable. */ }
      viewerHistoryActiveRef.current = false;
      closeViewerState();
    }
  }, [closeViewerState, restoreViewerFromHistory]);

  const selectViewerImage = useCallback((image: GalleryImage) => {
    galleryLayoutRef.current?.select(image);
  }, []);
  const selectViewerImages = useCallback((images: GalleryImage[]) => {
    galleryLayoutRef.current?.selectAll(images);
  }, []);

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
        const parent = viewerBranchRef.current?.parent;
        restoreViewerFromHistory(entry, Boolean(parent && parent.session === entry.session && parent.depth === entry.depth));
      } else if (viewerImageIdRef.current) {
        closeViewerState();
      }
    };
    const onPopState = (event: PopStateEvent) => {
      const selection = selectionStateRef.current;
      if (!handleSelectionHistory(event, selection.active, selection.clear)) applyHistoryState(event.state);
    };
    window.addEventListener("popstate", onPopState);
    const currentEntry = readViewerHistoryEntry(window.history.state);
    viewerHistoryActiveRef.current = Boolean(currentEntry);
    if (currentEntry && !viewerImageIdRef.current) {
      restoreViewerFromHistory(currentEntry);
    }
    return () => window.removeEventListener("popstate", onPopState);
  }, [activateLocation, closeViewerState, restoreViewerFromHistory]);

  useLayoutEffect(() => {
    if (!viewerReturnRequest) return;
    const request = viewerReturnRequest;
    if (request.parentImageId ? viewerImageId !== request.parentImageId : Boolean(viewerImageId)) return;
    const scrollRoot = request.parentImageId ? document.querySelector<HTMLElement>(".image-viewer") ?? undefined : undefined;
    if (request.parentImageId && !scrollRoot) return;
    const gallerySelector = scrollRoot ? ".viewer-similar-gallery" : ".justified-gallery";
    const findGallery = () => (scrollRoot ?? document).querySelector<HTMLElement>(gallerySelector);
    const getScroll = () => scrollRoot?.scrollTop ?? window.scrollY;
    let trackedScroll = getScroll();
    let scrollTranslation = 0;
    let userControlled = false;
    const setScroll = (top: number) => {
      if (userControlled) return;
      if (scrollRoot) scrollRoot.scrollTo({ top, behavior: "instant" });
      else scrollWindowImmediately(top);
      trackedScroll = getScroll();
    };
    const requestFlight = viewerReturnFlightRef.current;
    if (scrollRoot && requestFlight) scrollRoot.append(requestFlight.layer);
    let frame = 0;
    let settleTimer = 0;
    let timeoutTimer = 0;
    let stopped = false;
    let animating = false;
    let finished = false;
    let animationTarget: HTMLElement | null = null;
    let animationEndpoint = "";
    let observedCard: HTMLElement | null = null;
    let observedGallery: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeObserverPrimed = false;

    const observeLayout = (card: HTMLElement) => {
      const gallery = card.closest<HTMLElement>(gallerySelector);
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
      const card = imageCardById(request.imageId, findGallery());
      if (!card || card.getBoundingClientRect().height <= 0) return null;
      observeLayout(card);

      const targetScroll = scrollTopForAnchor(card, request, scrollRoot);
      if (Math.abs(targetScroll - getScroll()) > 0.5) {
        setScroll(targetScroll);
      }
      return card;
    };

    const informationLoading = () => Boolean(scrollRoot?.querySelector('.viewer-photo-information[aria-busy="true"]'));
    const releaseRequest = () => {
      stopped = true;
      setViewerReturnRequest(current => {
        if (current?.sequence !== request.sequence) return current;
        if (!request.parentImageId) viewerAnchorRef.current = null;
        return null;
      });
    };
    const settleReturn = () => {
      if (!scrollRoot) { releaseRequest(); return; }
      window.clearTimeout(settleTimer);
      // Metadata can finish before its final layout is painted. Recheck the
      // anchor after layout settles instead of releasing it in that same frame.
      settleTimer = window.setTimeout(() => {
        if (stopped || !finished || informationLoading()) return;
        alignToCard();
        releaseRequest();
      }, VIEWER_RETURN_SETTLE_MS);
    };
    const finalize = (card: HTMLElement | null) => {
      if (finished) return;
      finished = true;
      disposeViewerReturnFlight(requestFlight);
      if (viewerReturnFlightRef.current === requestFlight) viewerReturnFlightRef.current = null;
      if (!userControlled && card?.isConnected) card.focus({ preventScroll: true });
      // Returning after a reload can fetch metadata above the waterfall. Keep
      // its card anchored through that layout change, until the user takes over.
      if (!informationLoading()) settleReturn();
    };
    const takeOver = () => { userControlled = true; if (finished) releaseRequest(); };
    const followScroll = () => {
      const top = getScroll();
      const delta = trackedScroll - top;
      if (Math.abs(delta) < 0.5) return;
      trackedScroll = top;
      takeOver();
      if (!finished && requestFlight) {
        // Compose scroll movement separately from the shrink animation, so its
        // destination follows the waterfall without restarting its timeline.
        scrollTranslation += delta;
        requestFlight.media.style.translate = `0 ${scrollTranslation}px`;
      }
    };

    const transformFrame = ([x, y, scaleX, scaleY]: number[]) => ({
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`,
    });
    const targetTransform = (card: HTMLElement, flight: ViewerReturnFlight) => {
      const target = card.getBoundingClientRect();
      return [target.left - flight.source.left, target.top - flight.source.top - scrollTranslation,
        target.width / flight.source.width, target.height / flight.source.height];
    };
    const retargetAnimation = (card: HTMLElement | null) => {
      const flight = requestFlight;
      const effect = flight?.animations[0]?.effect;
      if (flight?.layer.dataset.phase !== "flying" || !card || !(effect instanceof KeyframeEffect)) return;
      if (animationTarget !== card) {
        if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
        card.dataset.viewerReturnTarget = "true";
        animationTarget = card;
      }
      const target = targetTransform(card, flight);
      const endpoint = transformFrame(target);
      if (endpoint.transform === animationEndpoint) return;
      const progress = effect.getComputedTiming().progress ?? 0;
      const current = new DOMMatrix(getComputedStyle(flight.media).transform);
      // Solve the start frame at the current eased progress: the rendered pose
      // and original deadline stay unchanged while the destination moves.
      const start = 1 - progress > .00001
        ? [current.e, current.f, current.a, current.d].map((value, index) =>
          (value - target[index] * progress) / (1 - progress))
        : target;
      effect.setKeyframes([transformFrame(start), endpoint]);
      animationEndpoint = endpoint.transform;
      flight.layer.dataset.retargets = String(
        Number.parseInt(flight.layer.dataset.retargets ?? "0", 10) + 1,
      );
    };

    const complete = () => {
      if (stopped) return;
      const card = alignToCard();
      if (finished) { if (!informationLoading()) settleReturn(); return; }
      if (animating) { retargetAnimation(card); return; }
      if (!card) {
        setScroll(scrollTopForAnchor(null, request, scrollRoot));
      }

      const flight = requestFlight;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!flight || reducedMotion || typeof flight.media.animate !== "function") {
        finalize(card);
        return;
      }

      animating = true;
      const flying = card && flight.visible;
      flight.layer.dataset.phase = flying ? "flying" : "fading";
      flight.layer.dataset.flyingAt = String(performance.now());
      flight.layer.dataset.duration = String(flying ? VIEWER_RETURN_ANIMATION_MS : 150);
      const animations: Animation[] = [];
      if (flying) {
        const endpoint = transformFrame(targetTransform(card, flight));
        animationEndpoint = endpoint.transform;
        card.dataset.viewerReturnTarget = "true";
        animationTarget = card;
        animations.push(flight.media.animate([
          transformFrame([0, 0, 1, 1]), endpoint,
        ], {
          duration: VIEWER_RETURN_ANIMATION_MS,
          easing: "cubic-bezier(.2, .7, .2, 1)",
          fill: "forwards",
        }));
      } else {
        animations.push(flight.media.animate([
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(.98)" },
        ], {
          duration: 150,
          easing: "ease-out",
          fill: "forwards",
        }));
      }
      animations.push(flight.backdrop.animate([
        { opacity: Number.parseFloat(window.getComputedStyle(flight.backdrop).opacity) || 0 },
        { opacity: 0 },
      ], {
        duration: flying ? 200 : 150,
        easing: "cubic-bezier(.2, .8, .2, 1)",
        fill: "forwards",
      }));
      flight.animations.push(...animations);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (stopped || viewerReturnFlightRef.current !== flight) return;
        if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
        finalize(animationTarget ?? card);
      });
    };

    const schedule = () => {
      if (stopped || frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        complete();
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
    const gallery = findGallery();
    if (gallery) mutationObserver.observe(gallery, { childList: true });
    if (scrollRoot) {
      resizeObserver.observe(scrollRoot);
      const information = scrollRoot.querySelector(".viewer-photo-information");
      if (information) resizeObserver.observe(information);
      mutationObserver.observe(scrollRoot, { attributes: true, attributeFilter: ["aria-busy"], subtree: true });
    }
    const scrollEvents = scrollRoot ?? window;
    scrollEvents.addEventListener("scroll", followScroll, { passive: true });
    for (const event of ["pointerdown", "wheel", "keydown"]) scrollEvents.addEventListener(event, takeOver, true);
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
      scrollEvents.removeEventListener("scroll", followScroll);
      for (const event of ["pointerdown", "wheel", "keydown"]) scrollEvents.removeEventListener(event, takeOver, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [viewerImageId, viewerReturnRequest]);

  useEffect(() => {
    if (!viewerImageId || !viewerCanLoadMore) return;
    const index = viewerBranch?.index ?? galleryViewerIndex;
    const count = viewerBranch?.images.length ?? images.length;
    if (index >= 0 && index >= count - VIEWER_PAGE_PREFETCH_DISTANCE) void loadMoreViewer();
  }, [galleryViewerIndex, images.length, loadMoreViewer, viewerCanLoadMore, viewerImageId, viewerBranch]);

  const showViewerImage = useCallback((candidate: GalleryImage, branch: ViewerBranch | null) => {
    if (viewerHistoryClosingRef.current) return;
    if (candidate.video) setSlideshowRequest(0);
    recordViewerHistory(candidate, branch, true);
    updateViewerBranch(branch);
    setViewerDiscoveredImages(current => appendUniqueImages(current, [candidate]));
    const candidates = branch?.images ?? appendUniqueImages(viewerImages, [candidate]);
    const index = candidates.findIndex(image => image.id === candidate.id);
    prepareViewerImages(candidates, index);
    viewerImageIdRef.current = candidate.id;
    setViewerImageId(candidate.id);
    resetSimilarSearch();
    setViewerReturnRequest(null);
  }, [recordViewerHistory, resetSimilarSearch, updateViewerBranch, viewerImages]);

  const openViewerImage = useCallback((candidate: GalleryImage, action: ImageCardAction = "view") => {
    if (action === "details") { setInfoImage(candidate); return; }
    if (action === "similar") { openSimilarSearch(candidate); return; }
    if (action === "slideshow") setSlideshowRequest(current => current + 1);
    if (candidate.id === viewerImageIdRef.current) return;
    const branch = viewerBranchRef.current;
    const index = branch?.images.findIndex(image => image === candidate) ?? -1;
    showViewerImage(candidate, branch && index >= 0 ? { ...branch, index } : null);
  }, [openSimilarSearch, showViewerImage]);

  const openRelatedViewerImage = useCallback((candidate: GalleryImage, action: ImageCardAction = "view", pointerY?: number) => {
    if (action !== "view" && action !== "slideshow") { openViewerImage(candidate, action); return; }
    if (!viewerImage || candidate.id === viewerImage.id) return;
    const index = similarPage.images.findIndex(image => image.id === candidate.id);
    const viewer = document.querySelector<HTMLElement>(".image-viewer");
    const card = imageCardById(candidate.id, viewer?.querySelector(".viewer-similar-gallery") ?? null);
    if (index < 0 || !viewer || !card) return;
    setSlideshowRequest(current => action === "slideshow" ? current + 1 : 0);
    const returnAnchor = { ...captureViewerAnchor(card, pointerY, viewer), imageId: candidate.id };
    const parent = recordViewerHistory(viewerImage, viewerBranch, true, similarPage, returnAnchor);
    const branch: ViewerBranch = { ...similarPage, source: viewerImage, index, parent };
    viewerLoadJobRef.current?.controller.abort();
    stopMediaPreview();
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    recordViewerHistory(candidate, branch);
    updateViewerBranch(branch);
    prepareViewerImages(branch.images, index);
    resetSimilarSearch();
    setViewerReturnRequest(null);
    viewerImageIdRef.current = candidate.id;
    setViewerImageId(candidate.id);
  }, [openViewerImage, recordViewerHistory, resetSimilarSearch, similarPage, updateViewerBranch, viewerBranch, viewerImage]);

  const navigateViewer = useCallback((direction: -1 | 1, signal?: AbortSignal) => {
    const currentImageId = viewerImageIdRef.current;
    if (!currentImageId || viewerHistoryClosingRef.current || signal?.aborted) return;
    const branch = viewerBranchRef.current;
    const candidates = branch?.images ?? viewerImages;
    const currentIndex = candidates.findIndex(image => image.id === currentImageId);
    if (currentIndex < 0) return;
    const target = candidates[currentIndex + direction];
    if (target) {
      showViewerImage(target, branch ? { ...branch, index: currentIndex + direction } : null);
      return;
    }
    if (direction < 0 || !viewerCanLoadMore) return;
    const startingBranch = branch;
    void loadMoreViewer().then(incoming => {
      const next = incoming[0];
      if (!next || signal?.aborted || viewerImageIdRef.current !== currentImageId) return;
      const branch = viewerBranchRef.current;
      if (startingBranch && (!branch || branch.source !== startingBranch.source || branch.index !== startingBranch.index)) return;
      showViewerImage(next, branch ? { ...branch, index: branch.images.indexOf(next) } : null);
    });
  }, [loadMoreViewer, showViewerImage, viewerCanLoadMore, viewerImages]);

  const navigateTo = (section: GallerySection, path = "", replace = false) => {
    const href = galleryHref(section, path);
    if (href !== window.location.pathname + window.location.search) {
      writeHistoryState(null, href, replace);
    }
    viewerHistoryActiveRef.current = false;
    viewerHistoryClosingRef.current = false;
    activateLocation({ section, path: section === "storage" ? path || "/" : section === "library" ? "" : path });
  };
  const chooseAlbum = (path: string) => navigateTo("albums", path);
  const openLocal = (path: string) => navigateTo("local", path);
  const viewAlbumCover = async (id: string) => {
    const origin = locationRef.current;
    try {
      const image = await getGalleryImage(id);
      if (locationRef.current === origin) {
        viewerAnchorRef.current = null;
        openViewerImage(image);
      }
    } catch (reason) { manager.notify(errorMessage(reason, "无法读取封面"), true); }
  };
  const viewLocalImage = (id: string) => {
    const image = localMedia?.images.find(image => image.id === id);
    if (image) { viewerAnchorRef.current = null; openViewerImage(image); }
    else void viewAlbumCover(id);
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    setViewerImageId(null);
  };
  const changeFilters = (next: ImageFilters, reshuffle = false) => {
    clearSelection();
    requestVersionRef.current++;
    skipInitialImagesRef.current = false;
    loadMoreControllerRef.current?.abort();
    setImagePage(EMPTY_IMAGE_PAGE);
    setLoading(true);
    setImageFilters({ ...next });
    setExploreSeed(current => next.sort === "explore" ? (reshuffle || !current ? createExploreSeed() : current) : "");
    setViewerImageId(null);
  };
  const changeContent = (query: string) => {
    if (query || contentCategory(search, categories)) changeSearch(query);
  };
  const resetFilters = () => {
    changeFilters(DEFAULT_IMAGE_FILTERS);
    changeSearch("");
  };
  const goHome = () => {
    setSearchOpen(false);
    navigateTo("library");
    setReloadToken((value) => value + 1);
  };

  useEffect(() => {
    if (summary && album && !summary.albums.some(item => item.path === album)) {
      navigateTo("albums", "", true);
    }
  }, [album, summary]);

  const pageLoading = browsingSimilar ? imageSimilarity.loading : (browsingLocal || browsingStorage || browsingTrash) ? false : browsingAlbums ? !summary : loading;
  return (
    <div
      className="app-shell"
      data-gallery-section={section}
      data-sidebar-collapsed={sidebarCollapsed}
      data-sidebar-pinned={desktopNav.pinned}
      data-mobile-navigation-open={mobileNavOpen}
      data-topbar-hidden={topbar.hidden}
      data-viewer-returning={Boolean(viewerReturnRequest)}
      data-viewer-return-image-id={viewerReturnRequest?.imageId}
    >
      <div className="topbar-surface" aria-hidden="true" />
      <Header
        hidden={topbar.hidden}
        onReveal={topbar.reveal}
        search={search}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        searchMode={browsingFavorites || browsingTrash ? "filename" : textSearchMode}
        albumSearch={browsingAlbums}
        storageSearch={browsingStorage}
        localSearch={browsingLocal}
        similarSearch={browsingSimilar}
        onSearchChange={changeSearch}
        onToggleNavigation={() => {
          if (compactLayout) setMobileNavOpen(open => !open);
          else if (galleryLayoutRef.current) galleryLayoutRef.current.resize(desktopNav.toggle);
          else desktopNav.toggle();
        }}
        onHoverNavigation={desktopNav.enter}
        onLeaveNavigation={desktopNav.leave}
        onHome={goHome}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onUpload={() => { desktopNav.close(); setUploadOpen(true); }}
        navigationOpen={compactLayout ? mobileNavOpen : !sidebarCollapsed}
        navigationPinned={desktopNav.pinned}
        compactLayout={compactLayout}
        filters={filtersAvailable ? imageFilters : null}
        onFiltersChange={changeFilters}
        onContentChange={changeContent}
        onResetFilters={resetFilters}
        categories={categories}
        categoriesHint={categoriesHint}
        onConfigureCategories={authentication.guest ? undefined : () => setSettingsSection("categories")}
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
        onChoose={section => {
          if (!compactLayout) desktopNav.pin();
          navigateTo(section, section === "similar" ? lastSimilarPathRef.current : "");
        }}
        mobileOpen={mobileNavOpen}
        mobileMounted={mobileNavMounted}
        onMobileExited={finishMobileNavExit}
        onClose={() => setMobileNavOpen(false)}
        desktopCollapsed={sidebarCollapsed}
        onDesktopEnter={desktopNav.enter}
        onDesktopLeave={desktopNav.leave}
        onSettings={() => { desktopNav.close(); setSettingsSection("account"); }}
      />

      <main className="content" aria-busy={pageLoading || pageLoadingMore}>
        {!browsingLocal && !browsingStorage && !browsingTrash && status?.videos && <div className="background-video-tasks" aria-label="视频准备任务">
          {(["playback", "preview"] as const).map(kind => {
            const job = status.videos![kind];
            if (!job.total || (job.backgroundComplete && !job.failed)) return null;
            const label = kind === "playback" ? "视频播放" : "视频预览";
            return <div key={kind} className="background-video-task">
              <span>{job.backgroundComplete ? label : `正在准备${label}`} · {job.ready}/{job.total}
                {job.failed > 0 && ` · ${job.failed} 个失败`}</span>
              <progress aria-label={`${label}准备进度`} max={job.total} value={job.ready + job.failed} />
            </div>;
          })}
        </div>}
        {error && !browsingLocal && !browsingStorage && !browsingSimilar && (
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

        {(browsingFavorites || browsingTrash || browsingLocal) && authentication.guest ? <div className="empty-state"><strong>图库管理仅限管理员访问</strong><a href="/login">管理员登录</a></div> : browsingLocal ? <LocalStorageView path={path} search={search} albums={summary?.albums ?? []} onOpen={openLocal} onAlbum={chooseAlbum} onImage={viewLocalImage} onMediaChange={setLocalMedia} /> : browsingTrash ? <TrashView search={search} /> : browsingSimilar ? (
          <SimilarSearchView
            source={querySource}
            results={imageSimilarity}
            filter={search}
            onUpload={file => { setUploadedQuery(file); setGalleryQuerySnapshot(null); navigateTo("similar"); }}
            onClear={() => { setUploadedQuery(null); setGalleryQuerySnapshot(null); navigateTo("similar"); }}
            onOpen={openViewer}
            layoutRef={galleryLayoutRef}
            toolbarTarget={selectionToolbar}
            onSelectionChange={setSelectedIds}
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
          <AlbumsView albums={summary?.albums} search={search} onOpen={chooseAlbum} onStorage={openLocal} onCover={id => void viewAlbumCover(id)} selection={albumSelection.selection} />
        ) : (
          <>
            {selectedAlbum && <AlbumBackLink onOpen={chooseAlbum} />}
            {filterLabels.length > 0 && <div className="gallery-filter-summary" role="status">
              <span>{filterLabels.join(" · ")}<small>{loading ? "正在筛选…" : `${formatCount(total)} 项`}</small></span>
              <div className="gallery-filter-actions">
                {imageFilters.sort === "explore" && <button type="button" className="gallery-filter-reset gallery-reshuffle" disabled={loading || total < 2}
                  aria-busy={loading} title="保留当前条件，重新打乱顺序" onClick={() => changeFilters(imageFilters, true)}><RefreshCw size={14} className={loading ? "spin" : ""} />换一组</button>}
                <button type="button" className="gallery-filter-reset" aria-label="重置搜索与筛选" onClick={resetFilters}>重置</button>
              </div>
            </div>}
            {browsingFavorites && <header className="management-page-heading"><h1><Heart size={23} />收藏</h1><span>{visibleAlbums.length ? `${visibleAlbums.length} 个相册 · ${total} 个文件` : `${total} 项`}</span></header>}
            {browsingFavorites && visibleAlbums.length > 0 && <section className="favorite-albums" aria-label="收藏的相册"><h2>相册</h2><AlbumGrid albums={visibleAlbums} onOpen={chooseAlbum} onStorage={openLocal} onCover={id => void viewAlbumCover(id)} selection={albumSelection.selection} /></section>}
            {loading ? (
              <GallerySkeleton />
            ) : images.length ? (
              <SelectableGallery
                key={`${section}:${path}:${debouncedSearch}:${exploreSeed}:${imageFilters.kind}:${imageFilters.orientation}:${imageFilters.sort}`}
                ref={galleryLayoutRef}
                toolbarTarget={selectionToolbar}
                onSelectionChange={setSelectedIds}
                onSelectionStart={albumSelection.clear}
                images={images}
                preserveViewport={viewerIndex < 0 && !viewerReturnRequest}
                onOpen={openViewer}
              />
            ) : browsingFavorites && visibleAlbums.length > 0 ? null : (
              <div className="empty-state">
                <ImageIcon size={30} strokeWidth={1.6} />
                <strong>{filterLabels.length ? "没有符合筛选条件的内容" : browsingFavorites ? debouncedSearch ? "没有匹配的收藏" : "暂无收藏" : selectedAlbum?.count === 0 ? "相册暂无内容" : summary?.total === 0 ? "图库暂无内容" : "没有找到图片或视频"}</strong>
                <span>
                  {browsingFavorites ? "选中图片、视频或相册，点击收藏即可添加" : summary?.total === 0 || selectedAlbum?.count === 0
                    ? "添加图片或视频后将自动显示"
                    : textSearchReady && debouncedSearch
                      ? "换一种自然语言描述，或减少限定词"
                      : "请调整相册或搜索条件"}
                </span>
              </div>
            )}

            <div ref={sentinelRef} className="load-sentinel" aria-live="polite">
              {loadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
              {!loading && nextOffset === null && images.length > 0 && (
                <span>已显示全部 {formatCount(total)} 项</span>
              )}
            </div>
          </>
        )}
      </main>
      <div className="bottom-selection" ref={setSelectionToolbar} />
      {albumSelection.controls(selectionToolbar)}
      {uploadOpen && !authentication.guest && <UploadDialog albums={summary?.albums ?? []}
        initialDestination={browsingLocal ? path : album} onClose={() => setUploadOpen(false)}
        onUploaded={() => window.dispatchEvent(new CustomEvent(MANAGEMENT_CHANGED, { detail: "upload" }))} />}
      {settingsSection && !authentication.guest && (
        <SettingsDialog
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
          onCategoriesSaved={next => { categoriesController.current?.abort(); setCategories(next); setCategoriesHint(""); }}
          onStorageSaved={() => {
            setStorageRevision(value => value + 1);
            if (browsingStorage) navigateTo("storage");
          }}
        />
      )}
      {!browsingStorage && !browsingTrash && viewerIndex >= 0 && (
        <ImageViewer
          images={viewerImages}
          activeIndex={viewerIndex}
          hasMore={viewerCanLoadMore}
          loadingMore={pageLoadingMore || viewerLoadingMore}
          onNavigate={navigateViewer}
          onLoadMoreImages={loadMoreViewer}
          onClose={closeViewer}
          slideshowRequest={slideshowRequest}
          onSelectImage={authentication.guest || browsingAlbums || browsingLocal ? undefined : selectViewerImage}
          selectedIds={selectedIds}
          onSelectImages={authentication.guest || browsingAlbums || browsingLocal ? undefined : selectViewerImages}
          onClearSelection={clearSelection}
          selectionDisabled={manager.busy}
          similarActive={similarActive}
          similarImages={similarActive ? similarPage.images : []}
          similarTotal={similarActive ? similarPage.total : 0}
          similarHasMore={similarActive && similarPage.nextOffset !== null}
          similarLoading={similarActive && similarLoading}
          similarLoadingMore={similarActive && similarLoadingMore}
          similarError={similarActive ? similarError : null}
          onSearchSimilar={searchSimilar}
          onSearchVideoFrame={searchVideoFrame}
          similarFrameTime={similarActive ? similarPage.frame?.time : undefined}
          onLoadMoreSimilar={loadMoreSimilar}
          onOpenImage={openViewerImage}
          onOpenSimilarImage={openRelatedViewerImage}
        />
      )}
      {infoImage && <PhotoInformationDialog image={infoImage} onClose={() => setInfoImage(null)} />}
    </div>
  );
}

export default App;
