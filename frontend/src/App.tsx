import { useGalleryData } from "./app/useGalleryData";
import { useViewerSimilarSearch } from "./app/useViewerSimilarSearch";
import { useViewerReturn } from "./app/useViewerReturn";
import { errorMessage } from "./app/errors";
import { useTransitionPresence } from "./hooks/useTransitionPresence";
import { useVisualViewport } from "./hooks/useVisualViewport";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { galleryPageLookahead } from "./galleryLoading";
import { lazy } from "preact/compat";
import { DeferredContent } from "./DeferredContent";
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
import { useAutoHideTopbar } from "./useAutoHideTopbar";
import { DEFAULT_IMAGE_FILTERS, imageFilterLabels } from "./GalleryFilters";
import { contentCategory } from "./contentCategories";
import { AlbumBackLink, AlbumGrid, AlbumsView } from "./AlbumsView";
import { useAlbumSelection } from "./SelectableAlbums";
import type { LocalMediaPage } from "./LocalStorageView";
import { authentication } from "./auth";
import type { SettingsSection } from "./SettingsDialog";
import { galleryHref, readGalleryLocation } from "./galleryLocation";
import type { GalleryLocation } from "./galleryLocation";
import {
  captureViewerAnchor,
  imageCardById,
} from "./galleryViewport";
import { ImageViewer } from "./ImageViewer";
import { PhotoInformationDialog } from "./PhotoInformationDialog";
import { ImageSearchSummary } from "./ImageSearch";
import { useImageSimilarity } from "./useImageSimilarity";
import type { ImageSearchSource } from "./useImageSimilarity";
import { appendUniqueImages } from "./galleryImages";
import { GallerySkeleton } from "./JustifiedGallery";
import { SelectableGallery, type SelectableGalleryHandle } from "./SelectableGallery";
import { MANAGEMENT_CHANGED, useManagement } from "./management";
import { ensureSelectionHistory, handleSelectionHistory, writeHistoryState } from "./selectionHistory";
import { useSelectionDismiss } from "./useSelectionDismiss";
import {
  getContentCategories,
  getGalleryImage,
  getSimilarImages,
  searchByUploadedImage,
} from "./api";
import type {
  ContentCategory,
  GalleryImage,
  GallerySection,
  ImageCardAction,
  ImageFilters,
} from "./types";
import {
  prepareViewerImages,
  releaseViewerAssets,
  VIEWER_PAGE_PREFETCH_DISTANCE,
} from "./viewerAssets";
import { useViewerAssetLifecycle } from "./useViewerAssetLifecycle";
import { stopMediaPreview } from "./MediaPreview";
import { galleryHistoryState, readViewerHistoryEntry, viewerHistoryState, type SimilarImagePageState, type ViewerBranch, type ViewerHistoryEntry } from "./viewerHistory";

const UploadDialog = lazy(() => import("./UploadDialog").then(module => ({ default: module.UploadDialog })));
const SettingsDialog = lazy(() => import("./SettingsDialog").then(module => ({ default: module.SettingsDialog })));
const LocalStorageView = lazy(() => import("./LocalStorageView").then(module => ({ default: module.LocalStorageView })));
const ExternalStorageView = lazy(() => import("./ExternalStorageView").then(module => ({ default: module.ExternalStorageView })));
const TrashView = lazy(() => import("./TrashView").then(module => ({ default: module.TrashView })));
const DuplicateImages = lazy(() => import("./DuplicateImages").then(module => ({ default: module.DuplicateImages })));

const SIMILAR_PAGE_SIZE = 30;
const MOBILE_NAV_EXIT_MS = 240;

function createExploreSeed(): string {
  const values = new Uint32Array(4);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function App() {
  const manager = useManagement();
  useVisualViewport();
  const [location, setLocation] = useState(readGalleryLocation);
  const locationRef = useRef(location);
  const { section, path } = location;
  const album = section === "albums" ? path : "";
  const browsingLocal = section === "local";
  const browsingStorage = section === "storage";
  const browsingFavorites = section === "favorites";
  const browsingTrash = section === "trash";
  const browsingSimilar = section === "similar";
  const browsingDuplicates = browsingSimilar && !path;
  const browsingImageSearch = browsingSimilar && Boolean(path);
  const browsingAlbums = section === "albums" && !album;
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [imageFilters, setImageFilters] = useState<ImageFilters>(DEFAULT_IMAGE_FILTERS);
  const [exploreSeed, setExploreSeed] = useState("");
  const { summary, status, imagePage, loading, loadingMore, error, setError,
    debouncedSearch, textSearchReady, textSearchMode, loadMoreLibrary,
    reloadToken, reloadGallery, resetLibrary,
  } = useGalleryData(location, search, imageFilters, exploreSeed);
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [storageRevision, setStorageRevision] = useState(0);
  const [localMedia, setLocalMedia] = useState<LocalMediaPage | null>(null);
  const [infoImage, setInfoImage] = useState<GalleryImage | null>(null);
  const [uploadedQuery, setUploadedQuery] = useState<File | null>(null);
  const [duplicateImages, setDuplicateImages] = useState<GalleryImage[]>([]);
  const [galleryQuerySnapshot, setGalleryQuerySnapshot] = useState<GalleryImage | null>(null);
  const queryImageId = browsingImageSearch && path !== "upload" ? path : "";
  const querySource = useMemo<ImageSearchSource | null>(() => queryImageId
    ? { kind: "gallery", imageId: queryImageId, image: galleryQuerySnapshot?.id === queryImageId ? galleryQuerySnapshot : undefined }
    : browsingImageSearch && uploadedQuery ? { kind: "upload", file: uploadedQuery } : null,
  [queryImageId, galleryQuerySnapshot, uploadedQuery, browsingImageSearch]);
  const imageSimilarity = useImageSimilarity(querySource, browsingImageSearch);
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
  const { similarPage, similarLoading, similarLoadingMore, similarError,
    resetSimilarSearch, restoreSimilarSearch, searchSimilar, searchVideoFrame, loadMoreSimilar,
  } = useViewerSimilarSearch(Boolean(status?.backgroundComplete));
  const { viewerReturnRequest, viewerAnchorRef, beginViewerReturn, cancelViewerReturn } = useViewerReturn(viewerImageId);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const desktopNav = useOverlayNavigation(compactLayout);
  const sidebarCollapsed = !desktopNav.open;
  const { mounted: mobileNavMounted, finishExit: finishMobileNavExit } = useTransitionPresence(
    mobileNavOpen,
    MOBILE_NAV_EXIT_MS,
  );
  const topbar = useAutoHideTopbar(Boolean(searchOpen || menuOpen || uploadOpen || desktopNav.open || mobileNavMounted || viewerImageId
    || viewerReturnRequest || settingsSection || infoImage), location, sidebarCollapsed);
  const filtersAvailable = !browsingAlbums && !browsingLocal && !browsingStorage && !browsingTrash && !browsingSimilar;
  const filterLabels = imageFilterLabels(imageFilters, textSearchReady && !browsingFavorites ? search : "", categories);
  const viewerImageIdRef = useRef<string | null>(null);
  const viewerHistoryActiveRef = useRef(false);
  const viewerHistoryClosingRef = useRef(false);
  const { images, total, nextOffset } = browsingImageSearch ? imageSimilarity : browsingDuplicates ? { images: duplicateImages, total: duplicateImages.length, nextOffset: null } : browsingLocal && localMedia ? localMedia : imagePage;
  const pageLoadingMore = browsingImageSearch ? imageSimilarity.loadingMore : browsingLocal ? Boolean(localMedia?.loadingMore) : loadingMore;
  const pageLoading = browsingImageSearch ? imageSimilarity.loading : (browsingDuplicates || browsingLocal || browsingStorage || browsingTrash) ? false : browsingAlbums ? !summary : loading;
  const pageError = browsingImageSearch ? imageSimilarity.error : error;
  const visibleImages = useMemo(() => browsingImageSearch && search.trim()
    ? images.filter(image => image.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : images,
  [browsingImageSearch, images, search]);
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
  useSelectionDismiss(selectionActive && !browsingDuplicates, manager.busy, Boolean(viewerImageId), clearSelection);
  useEffect(() => {
    const changed = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action !== "favorite") {
        setViewerImageId(null);
        setViewerDiscoveredImages([]);
        updateViewerBranch(null);
        viewerLoadJobRef.current?.controller.abort();
        if (browsingImageSearch) imageSimilarity.retry();
      }
      if (action !== "favorite" || browsingFavorites) reloadGallery();
    };
    window.addEventListener(MANAGEMENT_CHANGED, changed);
    return () => window.removeEventListener(MANAGEMENT_CHANGED, changed);
  }, [browsingFavorites, browsingImageSearch, imageSimilarity.retry, reloadGallery]);
  const viewerImages = useMemo(
    () => viewerBranch?.images ?? appendUniqueImages(visibleImages, viewerDiscoveredImages),
    [visibleImages, viewerDiscoveredImages, viewerBranch],
  );

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location, debouncedSearch, exploreSeed, imageFilters]);

  useLayoutEffect(() => {
    viewerImageIdRef.current = viewerImageId;
  }, [viewerImageId]);

  useEffect(() => () => {
    releaseViewerAssets();
    viewerLoadJobRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (!mobileNavMounted && !(compactLayout && menuOpen)) return;
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
  }, [mobileNavMounted, compactLayout, menuOpen]);

  useEffect(() => {
    if (!compactLayout && mobileNavOpen) setMobileNavOpen(false);
  }, [compactLayout, mobileNavOpen]);

  const loadMore = browsingImageSearch ? imageSimilarity.loadMore : browsingLocal && localMedia ? localMedia.loadMore : loadMoreLibrary;

  const activateLocation = useCallback((next: GalleryLocation) => {
    clearSelection();
    desktopNav.close();
    locationRef.current = next;
    resetLibrary(next);
    setLocation(next);
    setSearch("");
    setSearchOpen(false);
    setExploreSeed("");
    setImageFilters(DEFAULT_IMAGE_FILTERS);
    setMobileNavOpen(false);
    setMenuOpen(false);
    setInfoImage(null);
    setSlideshowRequest(0);
    viewerImageIdRef.current = null;
    setViewerImageId(null);
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    cancelViewerReturn();
    resetSimilarSearch();
  }, [resetSimilarSearch, clearSelection, desktopNav.close, cancelViewerReturn, resetLibrary]);

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

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextOffset === null || pageLoading || pageLoadingMore || pageError || viewerImageId) return;
    const lookahead = galleryPageLookahead();
    let active = true;
    const gallery = sentinel.parentElement?.querySelector<HTMLElement>(".justified-gallery");
    const ready = () => !gallery || (Number(gallery.dataset.layoutWidth) > 0 && gallery.getBoundingClientRect().height > 0);
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A queued notification may describe the position before a scroll or resize.
        if (active && entry.isIntersecting && ready()
          && sentinel.getBoundingClientRect().top <= window.innerHeight + lookahead) void loadMore();
      },
      { rootMargin: `${lookahead}px 0px` },
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
  }, [compactLayout, loadMore, nextOffset, pageLoading, pageLoadingMore, pageError, viewerImageId]);

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
    const hasGallery = Boolean(document.querySelector(".content .justified-gallery"));
    const anchor = viewerAnchorRef.current ?? {
      cardRatio: 0.5,
      viewportRatio: 0.5,
      fallbackScrollY: window.scrollY,
    };
    beginViewerReturn(hasGallery ? {
      ...anchor,
      imageId: currentImageId,
    } : null);
    if (!hasGallery) viewerAnchorRef.current = null;
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    viewerImageIdRef.current = null;
    setViewerImageId(null);
  }, [resetSimilarSearch, updateViewerBranch, beginViewerReturn]);

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
    beginViewerReturn(entry.returnAnchor ? { ...entry.returnAnchor, parentImageId: entry.image.id } : null, returning);
    const snapshot = entry.image;
    updateViewerBranch(entry.branch);
    viewerLoadJobRef.current?.controller.abort();
    const card = imageCardById(snapshot.id);
    if (!currentImageId) viewerAnchorRef.current = card ? captureViewerAnchor(card) : null;
    const candidates = entry.branch?.images ?? appendUniqueImages(images, [snapshot]);
    const index = candidates.findIndex(image => image.id === snapshot.id);
    prepareViewerImages(candidates, index);
    restoreSimilarSearch(entry.similarPage);
    setViewerDiscoveredImages(current => appendUniqueImages(current, [snapshot]));
    viewerImageIdRef.current = snapshot.id;
    setViewerImageId(snapshot.id);
  }, [images, restoreSimilarSearch, updateViewerBranch, beginViewerReturn]);

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
    viewerAnchorRef.current = captureViewerAnchor(card, pointerY);
    stopMediaPreview();
    prepareViewerImages(images, images.findIndex((image) => image.id === imageId));
    resetSimilarSearch();
    setViewerDiscoveredImages([]);
    updateViewerBranch(null);
    viewerLoadJobRef.current?.controller.abort();
    cancelViewerReturn();
    viewerImageIdRef.current = imageId;
    setViewerImageId(imageId);
  }, [recordViewerHistory, images, openSimilarSearch, resetSimilarSearch, updateViewerBranch, cancelViewerReturn]);

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

  useEffect(() => {
    if (!viewerImageId || !viewerCanLoadMore) return;
    const index = viewerBranch?.index ?? galleryViewerIndex;
    const count = viewerBranch?.images.length ?? images.length;
    if (index >= 0 && index >= count - VIEWER_PAGE_PREFETCH_DISTANCE) void loadMoreViewer();
  }, [galleryViewerIndex, images.length, loadMoreViewer, viewerCanLoadMore, viewerImageId, viewerBranch]);

  const showViewerImage = useCallback((candidate: GalleryImage, branch: ViewerBranch | null) => {
    if (viewerHistoryClosingRef.current) return;
    recordViewerHistory(candidate, branch, true);
    updateViewerBranch(branch);
    setViewerDiscoveredImages(current => appendUniqueImages(current, [candidate]));
    const candidates = branch?.images ?? appendUniqueImages(viewerImages, [candidate]);
    const index = candidates.findIndex(image => image.id === candidate.id);
    prepareViewerImages(candidates, index);
    viewerImageIdRef.current = candidate.id;
    setViewerImageId(candidate.id);
    resetSimilarSearch();
    cancelViewerReturn();
  }, [recordViewerHistory, resetSimilarSearch, updateViewerBranch, viewerImages, cancelViewerReturn]);

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
    recordViewerHistory(candidate, branch);
    updateViewerBranch(branch);
    prepareViewerImages(branch.images, index);
    resetSimilarSearch();
    cancelViewerReturn();
    viewerImageIdRef.current = candidate.id;
    setViewerImageId(candidate.id);
  }, [openViewerImage, recordViewerHistory, resetSimilarSearch, similarPage, updateViewerBranch, viewerBranch, viewerImage, cancelViewerReturn]);

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
    resetLibrary(location);
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
    reloadGallery();
  };

  useEffect(() => {
    if (summary && album && !summary.albums.some(item => item.path === album)) {
      navigateTo("albums", "", true);
    }
  }, [album, summary]);

  useEffect(() => {
    if (browsingImageSearch && !querySource) {
      navigateTo("similar", "", true);
      setSearchOpen(true);
    }
  }, [browsingImageSearch, querySource]);
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
        similarSearch={browsingImageSearch}
        duplicateSearch={browsingDuplicates}
        onSearchChange={changeSearch}
        onToggleNavigation={() => {
          if (compactLayout) setMobileNavOpen(open => !open);
          else if (galleryLayoutRef.current) galleryLayoutRef.current.resize(desktopNav.toggle);
          else desktopNav.toggle();
        }}
        onHoverNavigation={desktopNav.enter}
        onLeaveNavigation={desktopNav.leave}
        onHome={goHome}
        activeSection={section}
        onChoose={section => navigateTo(section)}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onUpload={() => { desktopNav.close(); setUploadOpen(true); }}
        onImageSearch={file => { setUploadedQuery(file); setGalleryQuerySnapshot(null); navigateTo("similar", "upload"); }}
        navigationOpen={compactLayout ? mobileNavOpen : !sidebarCollapsed}
        navigationPinned={desktopNav.pinned}
        mobileNavigationMounted={mobileNavMounted}
        compactLayout={compactLayout}
        onSelectionTarget={setSelectionToolbar}
        filters={filtersAvailable ? imageFilters : null}
        onFiltersChange={changeFilters}
        onContentChange={changeContent}
        onResetFilters={resetFilters}
        categories={categories}
        categoriesHint={categoriesHint}
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
        onChoose={section => navigateTo(section)}
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
        {pageError && !browsingLocal && !browsingStorage && (
          <div className="error-banner" role="alert">
            <span>{pageError}</span>
            <button
              type="button"
              onClick={() => browsingSimilar ? imageSimilarity.retry() : reloadGallery()}
              aria-label={browsingSimilar ? "重试" : "重新加载"}
              title={browsingSimilar ? "重试" : "重新加载"}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        )}

        <DeferredContent key={section}>
        {browsingDuplicates ? <DuplicateImages ref={galleryLayoutRef} search={debouncedSearch} revision={summary?.revision} viewing={Boolean(viewerImageId)}
          onImagesChange={setDuplicateImages} onOpen={openViewer} toolbarTarget={selectionToolbar} onSelectionChange={setSelectedIds} />
        : (browsingFavorites || browsingTrash || browsingLocal) && authentication.guest ? <div className="empty-state"><strong>图库管理仅限管理员访问</strong><a href="/login">管理员登录</a></div> : browsingLocal ? <LocalStorageView path={path} search={search} albums={summary?.albums ?? []} onOpen={openLocal} onAlbum={chooseAlbum} onImage={viewLocalImage} onMediaChange={setLocalMedia} /> : browsingTrash ? <TrashView search={search} toolbarTarget={selectionToolbar} /> : browsingStorage ? (
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
            {browsingImageSearch && <button type="button" className="duplicate-action similar-back" onClick={() => navigateTo("similar")}>返回重复图片</button>}
            {browsingSimilar && querySource && <ImageSearchSummary source={querySource} name={imageSimilarity.reference?.name}
              total={total} loading={pageLoading} onReplace={() => setSearchOpen(true)}
              onClear={() => { setUploadedQuery(null); setGalleryQuerySnapshot(null); navigateTo("library"); }} />}
            {selectedAlbum && <AlbumBackLink onOpen={chooseAlbum} />}
            {filtersAvailable && filterLabels.length > 0 && <div className="gallery-filter-summary" role="status">
              <span>{filterLabels.join(" · ")}<small>{loading ? "正在筛选…" : `${formatCount(total)} 项`}</small></span>
              <div className="gallery-filter-actions">
                {imageFilters.sort === "explore" && <button type="button" className="gallery-filter-reset gallery-reshuffle" disabled={loading || total < 2}
                  aria-busy={loading} title="保留当前条件，重新打乱顺序" onClick={() => changeFilters(imageFilters, true)}><RefreshCw size={14} className={loading ? "spin" : ""} />换一组</button>}
                <button type="button" className="gallery-filter-reset" aria-label="重置搜索与筛选" onClick={resetFilters}>重置</button>
              </div>
            </div>}
            {browsingFavorites && <header className="management-page-heading"><h1><Heart size={23} />收藏</h1><span>{visibleAlbums.length ? `${visibleAlbums.length} 个相册 · ${total} 个文件` : `${total} 项`}</span></header>}
            {browsingFavorites && visibleAlbums.length > 0 && <section className="favorite-albums" aria-label="收藏的相册"><h2>相册</h2><AlbumGrid albums={visibleAlbums} onOpen={chooseAlbum} onStorage={openLocal} onCover={id => void viewAlbumCover(id)} selection={albumSelection.selection} /></section>}
            {pageLoading ? (
              <GallerySkeleton />
            ) : visibleImages.length ? (
              <SelectableGallery
                key={`${section}:${path}:${debouncedSearch}:${exploreSeed}:${imageFilters.kind}:${imageFilters.orientation}:${imageFilters.sort}`}
                ref={galleryLayoutRef}
                toolbarTarget={selectionToolbar}
                onSelectionChange={setSelectedIds}
                onSelectionStart={albumSelection.clear}
                images={visibleImages}
                preserveViewport={viewerIndex < 0 && !viewerReturnRequest}
                onOpen={openViewer}
              />
            ) : (browsingFavorites && visibleAlbums.length > 0) || (browsingSimilar && pageError) ? null : browsingSimilar ? (
              <div className="empty-state"><ImageIcon size={30} strokeWidth={1.6} />
                <strong>{search.trim() ? "没有匹配的结果" : "没有找到相似图片"}</strong>
                <span>{search.trim() ? "试试其他文件名" : "换一张图片试试"}</span>
              </div>
            ) : (
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

            <div ref={sentinelRef} className={`load-sentinel${browsingSimilar ? " similar-results-footer" : ""}`} aria-live="polite">
              {pageLoadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
              {browsingSimilar && !pageLoading && !pageLoadingMore && nextOffset !== null && <button type="button" onClick={() => void loadMore()}>加载更多</button>}
              {!pageLoading && nextOffset === null && visibleImages.length > 0 && (
                <span>{browsingSimilar ? `已显示 ${formatCount(visibleImages.length)} 张${search.trim() ? "匹配图片" : "相似图片"}` : `已显示全部 ${formatCount(total)} 项`}</span>
              )}
            </div>
          </>
        )}
        </DeferredContent>
      </main>
      {albumSelection.controls(selectionToolbar)}
      {uploadOpen && !authentication.guest && <DeferredContent onClose={() => setUploadOpen(false)}><UploadDialog albums={summary?.albums ?? []}
        initialDestination={browsingLocal ? path : album} onClose={() => setUploadOpen(false)}
        onUploaded={() => window.dispatchEvent(new CustomEvent(MANAGEMENT_CHANGED, { detail: "upload" }))} /></DeferredContent>}
      {settingsSection && !authentication.guest && (
        <DeferredContent onClose={() => setSettingsSection(null)}>
        <SettingsDialog
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
          onCategoriesSaved={next => { categoriesController.current?.abort(); setCategories(next); setCategoriesHint(""); }}
          onStorageSaved={() => {
            setStorageRevision(value => value + 1);
            if (browsingStorage) navigateTo("storage");
          }}
        />
        </DeferredContent>
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
