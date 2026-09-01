import type { CSSProperties, JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  Download,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
  ScanSearch,
  X,
} from "./icons";
import { PhotoInformation } from "./PhotoInformation";
import { SimilarImageMasonry, SimilarImageSkeleton } from "./SimilarImages";
import type { GalleryImage } from "./types";
import {
  DEFAULT_TRANSFORM,
  clamp,
  drawViewerCanvas,
  initialViewerSourceState,
  isDirectOriginalReady,
  mouseSideDirection,
  pendingViewerSourceState,
  pointDistance,
  pointMidpoint,
  resolveViewerDisplaySource,
  rubberBand,
  selectViewerSourceStrategy,
  useViewportSize,
  viewerMediaDimensions,
  viewportRenderDimensions,
} from "./viewerLogic";
import type {
  PointerPoint,
  ViewerSourcePresentation,
  ViewerSourceState,
  ViewerTransform,
} from "./viewerLogic";
import {
  canPreloadViewerNeighbors,
  getViewerOriginalAsset,
  getReadyViewerViewportRenderAsset,
  getViewerThumbnailStatus,
  getViewerViewportRenderAsset,
  prepareViewerImages,
  supportsViewerViewportBitmaps,
  viewerOriginalUrl,
  viewerThumbnailUrl,
} from "./viewerAssets";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_DELAY_MS = 280;
const VIEWER_SCROLL_EPSILON = 2;
const WHEEL_HANDOFF_DELAY_MS = 220;
const MAX_RENDER_EDGE = 4096;
const MOBILE_SWIPE_MOTION_MS = 170;
const MOBILE_SWIPE_CLEANUP_MS = MOBILE_SWIPE_MOTION_MS + 50;
const MOBILE_RENDER_SETTLE_MS = MOBILE_SWIPE_CLEANUP_MS + 16;
const MOBILE_NEIGHBOR_PRELOAD_DELAY_MS = 120;
const TOUCH_SWIPE_MIN_DISTANCE_PX = 36;
const TOUCH_SWIPE_MAX_DISTANCE_PX = 56;
const TOUCH_SWIPE_DISTANCE_RATIO = 0.08;
const TOUCH_SWIPE_FLICK_MIN_DISTANCE_PX = 20;
const TOUCH_SWIPE_FLICK_VELOCITY = 0.32;

type GestureStart = {
  point: PointerPoint;
  transform: ViewerTransform;
  scrollTop: number;
  startedAt: number;
  pointerType: string;
};

type GestureMode = "pan" | "navigate" | "page" | "dismiss" | "pinch";

type ViewerPage = "image" | "transition" | "details";

type ViewerScrollSnapshot = {
  imageId: string;
  viewportWidth: number;
  viewportHeight: number;
  detailsTop: number;
  scrollTop: number;
  page: ViewerPage;
};

type PinchStart = {
  distance: number;
  midpoint: PointerPoint;
  transform: ViewerTransform;
};

type ThumbnailLoadState = {
  id: string;
  loaded: boolean;
  failed: boolean;
};

type FullResolutionState = {
  id: string;
  requested: boolean;
  loaded: boolean;
  failed: boolean;
};

type PreparedSwipeSnapshot = {
  imageId: string;
  element: HTMLDivElement;
};

type GestureGeometry = {
  surfaceWidth: number;
  surfaceHeight: number;
  mediaWidth: number;
  mediaHeight: number;
  surfaceBounds: DOMRect;
};

type GestureHandlers = {
  begin: (id: number, point: PointerPoint, pointerType: string) => void;
  move: (id: number, point: PointerPoint) => void;
  finish: (id: number, point: PointerPoint, pointerType: string) => void;
  cancel: () => void;
};

type IdleScheduler = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type ImageViewerProps = {
  images: GalleryImage[];
  activeIndex: number;
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onNavigate: (direction: -1 | 1) => void;
  onClose: () => void;
  similarActive: boolean;
  similarImages: GalleryImage[];
  similarTotal: number;
  similarHasMore: boolean;
  similarLoading: boolean;
  similarLoadingMore: boolean;
  similarError: string | null;
  onSearchSimilar: (image: GalleryImage) => void;
  onLoadMoreSimilar: () => void;
  onOpenSimilar: (image: GalleryImage) => void;
};

export function ImageViewer({
  images,
  activeIndex,
  total,
  hasMore,
  loadingMore,
  onNavigate,
  onClose,
  similarActive,
  similarImages,
  similarTotal,
  similarHasMore,
  similarLoading,
  similarLoadingMore,
  similarError,
  onSearchSimilar,
  onLoadMoreSimilar,
  onOpenSimilar,
}: ImageViewerProps) {
  const image = images[activeIndex]!;
  const viewport = useViewportSize();
  const compactViewport = viewport.width <= 720;
  const similarColumnCount = viewport.width < 520
    ? 2
    : viewport.width < 960
      ? 3
      : viewport.width < 1280
        ? 4
        : 5;
  const mediaDimensions = viewerMediaDimensions(image, viewport);
  const viewportRender = viewportRenderDimensions(image, viewport);
  const viewportBitmapCapable = supportsViewerViewportBitmaps();
  const sourceStrategy = selectViewerSourceStrategy(
    image,
    viewportRender,
    viewportBitmapCapable,
  );
  const useViewportBitmapRenderer = sourceStrategy === "viewport-upgrade";
  const useSafeCanvasRenderer = sourceStrategy === "bounded-canvas";
  const useCanvasRenderer = sourceStrategy !== "direct-original";
  const canPrevious = activeIndex > 0;
  const canNext = activeIndex < images.length - 1 || hasMore;
  const waitingForNext = loadingMore && activeIndex === images.length - 1;
  const dialogRef = useRef<HTMLDivElement>(null);
  const detailsSectionRef = useRef<HTMLElement>(null);
  const similarSectionRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const gestureStartRef = useRef<GestureStart | null>(null);
  const pinchStartRef = useRef<PinchStart | null>(null);
  const gestureGeometryRef = useRef<GestureGeometry | null>(null);
  const gestureAxisRef = useRef<"x" | "y" | null>(null);
  const gestureModeRef = useRef<GestureMode | null>(null);
  const pinchedRef = useRef(false);
  const lastTapRef = useRef<{ at: number; point: PointerPoint } | null>(null);
  const lastTouchAtRef = useRef(0);
  const gestureHandlersRef = useRef<GestureHandlers | null>(null);
  const retryTimerRef = useRef(0);
  const sourceUpgradeTimerRef = useRef(0);
  const scrollTopRef = useRef(0);
  const scrollPageRef = useRef<ViewerPage>("image");
  const viewerScrollSnapshotRef = useRef<ViewerScrollSnapshot>({
    imageId: image.id,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    detailsTop: viewport.height,
    scrollTop: 0,
    page: "image",
  });
  const wheelZoomBlockedUntilRef = useRef(0);
  const displayedOriginalsRef = useRef(new Set<string>());
  const transformFrameRef = useRef(0);
  const pendingTransformRef = useRef<ViewerTransform | null>(null);
  const swipeCleanupTimerRef = useRef(0);
  const swipeOutgoingRef = useRef<HTMLElement | null>(null);
  const preparedSwipeSnapshotRef = useRef<PreparedSwipeSnapshot | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrollPage, setScrollPage] = useState<ViewerPage>("image");
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(
    () => typeof document !== "undefined"
      && document.fullscreenEnabled
      && "requestFullscreen" in HTMLElement.prototype,
  );
  const [transform, setTransform] = useState<ViewerTransform>(DEFAULT_TRANSFORM);
  const transformRef = useRef<ViewerTransform>(DEFAULT_TRANSFORM);
  const [thumbnailState, setThumbnailState] = useState<ThumbnailLoadState>({
    id: image.id,
    loaded: getViewerThumbnailStatus(image) === "ready",
    failed: false,
  });
  const directOriginalReady = isDirectOriginalReady(
    image,
    sourceStrategy,
    displayedOriginalsRef.current,
  );
  const [loadState, setLoadState] = useState<ViewerSourceState>(
    initialViewerSourceState(image.id, directOriginalReady),
  );
  const [fullResolutionState, setFullResolutionState] = useState<FullResolutionState>({
    id: image.id,
    requested: false,
    loaded: false,
    failed: false,
  });
  const currentLoadState = loadState.id === image.id
    ? loadState
    : initialViewerSourceState(image.id, directOriginalReady);
  const currentFullResolution = fullResolutionState.id === image.id
    ? fullResolutionState
    : { id: image.id, requested: false, loaded: false, failed: false };
  const thumbnailLoaded = thumbnailState.id === image.id
    ? thumbnailState.loaded
    : getViewerThumbnailStatus(image) === "ready";
  const thumbnailFailed = thumbnailState.id === image.id && thumbnailState.failed;
  const fullSource = viewerOriginalUrl(image, currentLoadState.attempt);

  const viewerIsBusy = (includeSwipe = true) => pointersRef.current.size > 0
    || (includeSwipe && Boolean(dialogRef.current?.hasAttribute("data-swipe-direction")));

  const markOriginalReady = (
    imageId: string,
    attempt: number,
    presentation: ViewerSourcePresentation = "upgrade",
  ) => {
    window.clearTimeout(sourceUpgradeTimerRef.current);
    const commit = () => {
      sourceUpgradeTimerRef.current = 0;
      if (dialogRef.current?.dataset.imageId !== imageId) return;
      if (presentation === "upgrade" && viewerIsBusy()) {
        sourceUpgradeTimerRef.current = window.setTimeout(commit, 48);
        return;
      }
      setLoadState((current) => {
        if (current.id === imageId && current.attempt !== attempt) return current;
        if (
          current.id === imageId
          && current.loaded
          && (current.presentation === "direct" || presentation === "upgrade")
        ) return current;
        return {
          id: imageId,
          attempt,
          loaded: true,
          failed: false,
          presentation,
        };
      });
    };
    commit();
  };

  const applyTransformToDom = (next: ViewerTransform) => {
    const media = mediaRef.current;
    if (media) {
      media.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    }
    const viewer = dialogRef.current;
    if (!viewer) return;
    const surfaceHeight = gestureGeometryRef.current?.surfaceHeight
      ?? surfaceRef.current?.clientHeight
      ?? 640;
    const dismissProgress = next.scale === MIN_SCALE
      ? clamp(Math.max(0, next.y) / Math.max(1, surfaceHeight), 0, 0.45)
      : 0;
    viewer.style.setProperty("--viewer-dismiss-progress", String(dismissProgress));
    const zoomed = next.scale > MIN_SCALE;
    viewer.dataset.zoomed = String(zoomed);
    if (useViewportBitmapRenderer) {
      const nativeActive = zoomed && viewer.dataset.nativeOriginalLoaded === "true";
      viewer.dataset.nativeOriginalActive = String(nativeActive);
      viewer.dataset.displaySource = resolveViewerDisplaySource({
        sourceLoaded: viewer.dataset.fullLoaded === "true",
        thumbnailLoaded: viewer.dataset.thumbnailLoaded === "true",
        viewportBitmapRenderer: true,
        nativeOriginalActive: nativeActive,
      });
    }
  };

  const cancelTransformFrame = () => {
    if (transformFrameRef.current) {
      window.cancelAnimationFrame(transformFrameRef.current);
      transformFrameRef.current = 0;
    }
    pendingTransformRef.current = null;
  };

  const flushStagedTransform = () => {
    if (transformFrameRef.current) {
      window.cancelAnimationFrame(transformFrameRef.current);
      transformFrameRef.current = 0;
    }
    const pending = pendingTransformRef.current;
    pendingTransformRef.current = null;
    if (pending) applyTransformToDom(pending);
  };

  const stageTransform = (next: ViewerTransform) => {
    transformRef.current = next;
    pendingTransformRef.current = next;
    if (transformFrameRef.current) return;
    transformFrameRef.current = window.requestAnimationFrame(() => {
      transformFrameRef.current = 0;
      const pending = pendingTransformRef.current;
      pendingTransformRef.current = null;
      if (pending) applyTransformToDom(pending);
    });
  };

  const commitTransform = (next: ViewerTransform) => {
    cancelTransformFrame();
    transformRef.current = next;
    applyTransformToDom(next);
    setTransform(next);
  };

  const syncScrollPage = (top: number) => {
    const viewer = dialogRef.current;
    const detailsTop = detailsSectionRef.current?.offsetTop ?? viewer?.clientHeight ?? 0;
    const nextPage: ViewerPage = top <= VIEWER_SCROLL_EPSILON
      ? "image"
      : detailsTop > 0 && top >= detailsTop - VIEWER_SCROLL_EPSILON
        ? "details"
        : "transition";
    if (scrollPageRef.current === nextPage) return;
    scrollPageRef.current = nextPage;
    setScrollPage(nextPage);
    return nextPage;
  };

  const rememberViewerScroll = (
    viewer: HTMLDivElement,
    page = scrollPageRef.current,
  ) => {
    viewerScrollSnapshotRef.current = {
      imageId: image.id,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      detailsTop: detailsSectionRef.current?.offsetTop ?? viewer.clientHeight,
      scrollTop: viewer.scrollTop,
      page,
    };
  };

  const forceViewerScroll = (top: number) => {
    const viewer = dialogRef.current;
    if (!viewer) return;
    const previousBehavior = viewer.style.scrollBehavior;
    viewer.style.scrollBehavior = "auto";
    viewer.scrollTop = top;
    viewer.style.scrollBehavior = previousBehavior;
    scrollTopRef.current = viewer.scrollTop;
    const page = syncScrollPage(viewer.scrollTop) ?? scrollPageRef.current;
    rememberViewerScroll(viewer, page);
  };

  const constrainTransform = (
    next: ViewerTransform,
    geometry = gestureGeometryRef.current,
  ): ViewerTransform => {
    const scale = clamp(next.scale, MIN_SCALE, MAX_SCALE);
    if (scale <= MIN_SCALE) return DEFAULT_TRANSFORM;

    const surface = surfaceRef.current;
    const media = mediaRef.current;
    const surfaceWidth = geometry?.surfaceWidth ?? surface?.clientWidth;
    const surfaceHeight = geometry?.surfaceHeight ?? surface?.clientHeight;
    const mediaWidth = geometry?.mediaWidth ?? media?.offsetWidth;
    const mediaHeight = geometry?.mediaHeight ?? media?.offsetHeight;
    if (
      surfaceWidth === undefined
      || surfaceHeight === undefined
      || mediaWidth === undefined
      || mediaHeight === undefined
    ) return { scale, x: next.x, y: next.y };
    const maximumX = Math.max(0, (mediaWidth * scale - surfaceWidth) / 2);
    const maximumY = Math.max(0, (mediaHeight * scale - surfaceHeight) / 2);
    return {
      scale,
      x: clamp(next.x, -maximumX, maximumX),
      y: clamp(next.y, -maximumY, maximumY),
    };
  };

  const zoomAt = (nextScale: number, point?: PointerPoint) => {
    const surface = surfaceRef.current;
    const current = transformRef.current;
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (scale <= MIN_SCALE || !surface) {
      commitTransform(DEFAULT_TRANSFORM);
      return;
    }
    if ((dialogRef.current?.scrollTop ?? scrollTopRef.current) > VIEWER_SCROLL_EPSILON) {
      return;
    }
    forceViewerScroll(0);

    const bounds = surface.getBoundingClientRect();
    const center = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    const anchor = point ?? center;
    const imagePoint = {
      x: (anchor.x - center.x - current.x) / current.scale,
      y: (anchor.y - center.y - current.y) / current.scale,
    };
    commitTransform(constrainTransform({
      scale,
      x: anchor.x - center.x - imagePoint.x * scale,
      y: anchor.y - center.y - imagePoint.y * scale,
    }));
  };

  const zoomBy = (amount: number) => {
    zoomAt(transformRef.current.scale + amount);
  };

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scrollToDetails = (focus = false) => {
    commitTransform(DEFAULT_TRANSFORM);
    wheelZoomBlockedUntilRef.current = performance.now() + WHEEL_HANDOFF_DELAY_MS;
    const viewer = dialogRef.current;
    const details = detailsSectionRef.current;
    if (!viewer || !details) return;
    viewer.scrollTo({
      top: details.offsetTop,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    if (focus) {
      window.requestAnimationFrame(() => details.focus({ preventScroll: true }));
    }
  };

  const scrollToImage = (focus = false) => {
    wheelZoomBlockedUntilRef.current = performance.now() + WHEEL_HANDOFF_DELAY_MS;
    dialogRef.current?.scrollTo({
      top: 0,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    if (focus) {
      window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    }
  };

  const scrollToSimilar = () => {
    commitTransform(DEFAULT_TRANSFORM);
    wheelZoomBlockedUntilRef.current = performance.now() + WHEEL_HANDOFF_DELAY_MS;
    window.requestAnimationFrame(() => {
      similarSectionRef.current?.scrollIntoView({
        behavior: reducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    });
  };

  const parkViewerControlFocus = () => {
    const viewer = dialogRef.current;
    const active = document.activeElement;
    if (
      viewer
      && active instanceof HTMLElement
      && active !== viewer
      && viewer.contains(active)
    ) {
      viewer.focus({ preventScroll: true });
    }
  };

  const clearSwipeMotion = () => {
    window.clearTimeout(swipeCleanupTimerRef.current);
    swipeCleanupTimerRef.current = 0;
    dialogRef.current?.removeAttribute("data-swipe-direction");
    const outgoing = swipeOutgoingRef.current;
    swipeOutgoingRef.current = null;
    outgoing?.getAnimations().forEach((animation) => animation.cancel());
    outgoing?.remove();
  };

  const prepareSwipeSnapshot = (): PreparedSwipeSnapshot | null => {
    const media = mediaRef.current;
    if (!media) return null;
    const snapshot = media.cloneNode(true) as HTMLDivElement;
    snapshot.classList.add("viewer-swipe-outgoing");
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
      element.removeAttribute("id");
    });
    const thumbnail = snapshot.querySelector<HTMLElement>(".viewer-thumbnail");
    snapshot.querySelectorAll(".viewer-original").forEach((original) => original.remove());
    if (thumbnail) {
      thumbnail.style.opacity = "1";
      thumbnail.style.filter = "none";
    }
    return {
      imageId: image.id,
      element: snapshot,
    };
  };

  const takePreparedSwipeSnapshot = () => {
    const media = mediaRef.current;
    const prepared = preparedSwipeSnapshotRef.current;
    if (
      !media
      || !prepared
      || prepared.imageId !== image.id
    ) return null;
    preparedSwipeSnapshotRef.current = null;
    const bounds = media.getBoundingClientRect();
    const snapshot = prepared.element;
    Object.assign(snapshot.style, {
      position: "fixed",
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      transform: "translate3d(0, 0, 0)",
    });
    document.body.append(snapshot);
    return snapshot;
  };

  const navigateWithSwipeMotion = (direction: -1 | 1) => {
    if (!compactViewport || reducedMotion()) {
      commitTransform(DEFAULT_TRANSFORM);
      onNavigate(direction);
      return;
    }

    clearSwipeMotion();
    const releaseStartedAt = performance.now();
    const outgoing = takePreparedSwipeSnapshot();
    const viewer = dialogRef.current;
    if (viewer) viewer.dataset.swipeDirection = direction > 0 ? "next" : "previous";
    commitTransform(DEFAULT_TRANSFORM);
    onNavigate(direction);
    if (viewer) {
      viewer.dataset.swipeSnapshot = outgoing ? "prepared" : "skipped";
      viewer.dataset.swipeReleaseCostMs = (performance.now() - releaseStartedAt).toFixed(2);
    }

    if (outgoing) {
      swipeOutgoingRef.current = outgoing;
      const travel = Math.max(128, viewport.width * 0.38) * -direction;
      const animation = outgoing.animate(
        [
          { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
          { opacity: 0, transform: `translate3d(${travel}px, 0, 0) scale(.985)` },
        ],
        {
          duration: MOBILE_SWIPE_MOTION_MS,
          easing: "cubic-bezier(.18, .82, .24, 1)",
          fill: "forwards",
        },
      );
      void animation.finished.catch(() => undefined).then(() => {
        if (swipeOutgoingRef.current !== outgoing) return;
        swipeOutgoingRef.current = null;
        outgoing.remove();
      });
    }

    swipeCleanupTimerRef.current = window.setTimeout(() => {
      dialogRef.current?.removeAttribute("data-swipe-direction");
      const staleOutgoing = swipeOutgoingRef.current;
      swipeOutgoingRef.current = null;
      staleOutgoing?.remove();
      swipeCleanupTimerRef.current = 0;
    }, MOBILE_SWIPE_CLEANUP_MS);
  };

  useLayoutEffect(() => {
    window.clearTimeout(retryTimerRef.current);
    window.clearTimeout(sourceUpgradeTimerRef.current);
    sourceUpgradeTimerRef.current = 0;
    pointersRef.current.clear();
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    gestureGeometryRef.current = null;
    gestureAxisRef.current = null;
    gestureModeRef.current = null;
    pinchedRef.current = false;
    lastTapRef.current = null;
    setDragging(false);
    commitTransform(DEFAULT_TRANSFORM);
    wheelZoomBlockedUntilRef.current = 0;
    setThumbnailState({
      id: image.id,
      loaded: getViewerThumbnailStatus(image) === "ready",
      failed: false,
    });
    const originalReady = isDirectOriginalReady(
      image,
      sourceStrategy,
      displayedOriginalsRef.current,
    );
    setLoadState(initialViewerSourceState(image.id, originalReady));
    setFullResolutionState({
      id: image.id,
      requested: false,
      loaded: false,
      failed: false,
    });
  }, [
    image.id,
    sourceStrategy,
    viewportRender.height,
    viewportRender.width,
  ]);

  useLayoutEffect(() => {
    const viewer = dialogRef.current;
    if (!viewer) return;
    const previous = viewerScrollSnapshotRef.current;
    const imageChanged = previous.imageId !== image.id;
    const viewportChanged = previous.viewportWidth !== viewport.width
      || previous.viewportHeight !== viewport.height;

    if (transformRef.current.scale > MIN_SCALE) {
      if (imageChanged || viewportChanged) forceViewerScroll(0);
      commitTransform(constrainTransform(transformRef.current));
    } else if (imageChanged) {
      // Navigation starts each image at the top, while a resize keeps the current
      // position inside the image or details page.
      forceViewerScroll(0);
    } else if (viewportChanged) {
      const previousDetailsTop = Math.max(
        1,
        previous.detailsTop || previous.viewportHeight,
      );
      const nextDetailsTop = detailsSectionRef.current?.offsetTop ?? viewport.height;
      const wasInDetails = previous.page === "details"
        || previous.scrollTop >= previousDetailsTop - VIEWER_SCROLL_EPSILON;
      const nextTop = wasInDetails
        ? nextDetailsTop + Math.max(0, previous.scrollTop - previousDetailsTop)
        : previous.page === "transition"
          ? nextDetailsTop * clamp(previous.scrollTop / previousDetailsTop, 0, 1)
          : 0;
      const maximumScroll = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
      forceViewerScroll(clamp(nextTop, 0, maximumScroll));
    } else {
      rememberViewerScroll(viewer);
    }
  }, [image.id, viewport.width, viewport.height]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const root = document.getElementById("root");
    const rootWasInert = root?.inert ?? false;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    root && (root.inert = true);
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (root) root.inert = rootWasInert;
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const updateFullscreenState = () => {
      setFullscreen(document.fullscreenElement === dialogRef.current);
    };
    setFullscreenAvailable(Boolean(
      document.fullscreenEnabled && dialogRef.current?.requestFullscreen,
    ));
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreenState);
      if (document.fullscreenElement === dialogRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (
      scrollPage === "image"
      || scrollPageRef.current === "image"
      || similarActive
    ) return;
    onSearchSimilar(image);
  }, [image, onSearchSimilar, scrollPage, similarActive]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === dialogRef.current) {
        await document.exitFullscreen();
      } else {
        await dialogRef.current?.requestFullscreen();
      }
    } catch (error) {
      console.warn("Pixhelf could not change fullscreen mode", error);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((element) => !element.hasAttribute("inert"));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "Escape":
          if (document.fullscreenElement === dialogRef.current) return;
          event.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          if (canPrevious) {
            event.preventDefault();
            parkViewerControlFocus();
            onNavigate(-1);
          }
          break;
        case "ArrowRight":
          if (canNext) {
            event.preventDefault();
            parkViewerControlFocus();
            onNavigate(1);
          }
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomBy(0.5);
          break;
        case "-":
          event.preventDefault();
          zoomBy(-0.5);
          break;
        case "0":
          event.preventDefault();
          commitTransform(DEFAULT_TRANSFORM);
          break;
        case "ArrowDown":
        case "PageDown":
          if (
            transformRef.current.scale <= MIN_SCALE &&
            (dialogRef.current?.scrollTop ?? 0) < (detailsSectionRef.current?.offsetTop ?? Infinity)
          ) {
            event.preventDefault();
            scrollToDetails(true);
          }
          break;
        case "ArrowUp":
        case "PageUp":
          if (
            transformRef.current.scale <= MIN_SCALE &&
            (dialogRef.current?.scrollTop ?? 0) > 1
          ) {
            event.preventDefault();
            scrollToImage(true);
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canNext, canPrevious, onClose, onNavigate]);

  useEffect(() => {
    const pressedButtons = new Set<number>();
    const suppressSideButton = (event: MouseEvent | PointerEvent) => {
      if (mouseSideDirection(event.button) === null) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    const navigateFromSideButton = (event: MouseEvent | PointerEvent) => {
      const direction = mouseSideDirection(event.button);
      if (direction === null || !suppressSideButton(event)) return;
      if (pressedButtons.has(event.button)) return;
      pressedButtons.add(event.button);
      if (direction < 0 && canPrevious) onNavigate(-1);
      if (direction > 0 && canNext) onNavigate(1);
    };
    const releaseSideButton = (event: MouseEvent | PointerEvent) => {
      if (!suppressSideButton(event)) return;
      pressedButtons.delete(event.button);
    };
    const resetSideButtons = () => pressedButtons.clear();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") navigateFromSideButton(event);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (mouseSideDirection(event.button) !== null) suppressSideButton(event);
      resetSideButtons();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", releaseSideButton, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("mousedown", navigateFromSideButton, true);
    window.addEventListener("mouseup", releaseSideButton, true);
    window.addEventListener("auxclick", suppressSideButton, true);
    window.addEventListener("blur", resetSideButtons);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", releaseSideButton, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("mousedown", navigateFromSideButton, true);
      window.removeEventListener("mouseup", releaseSideButton, true);
      window.removeEventListener("auxclick", suppressSideButton, true);
      window.removeEventListener("blur", resetSideButtons);
    };
  }, [canNext, canPrevious, onNavigate]);

  useEffect(() => {
    prepareViewerImages(images, activeIndex, {
      preloadOriginals: !viewportBitmapCapable,
    });
    if (!viewportBitmapCapable) return;
    let disposed = false;
    let delayTimer = 0;
    let idleHandle = 0;
    const activeAsset = useViewportBitmapRenderer
      ? getViewerViewportRenderAsset(
        image,
        viewportRender.width,
        viewportRender.height,
        0,
        "high",
      )
      : getViewerOriginalAsset(image, 0, "high");
    const idleScheduler = window as IdleScheduler;
    const preloadNeighbors = async () => {
      if (disposed || !canPreloadViewerNeighbors()) return;
      // Forward navigation is the common path. Prepare one neighbor at a time, using
      // its original only when it is already no larger than the target render size.
      for (const offset of [1, -1]) {
        if (disposed) return;
        const candidate = images[activeIndex + offset];
        if (!candidate) continue;
        const render = viewportRenderDimensions(candidate, viewport);
        const strategy = selectViewerSourceStrategy(
          candidate,
          render,
          viewportBitmapCapable,
        );
        const asset = strategy === "viewport-upgrade"
          ? getViewerViewportRenderAsset(
            candidate,
            render.width,
            render.height,
            0,
            "low",
          )
          : getViewerOriginalAsset(candidate, 0, "low");
        if (asset.status === "loading") await asset.promise;
      }
    };
    const scheduleNeighbors = () => {
      if (disposed) return;
      delayTimer = window.setTimeout(() => {
        if (idleScheduler.requestIdleCallback) {
          idleHandle = idleScheduler.requestIdleCallback(
            () => void preloadNeighbors(),
            { timeout: 600 },
          );
        } else {
          void preloadNeighbors();
        }
      }, MOBILE_NEIGHBOR_PRELOAD_DELAY_MS);
    };
    if (activeAsset.status === "loading") void activeAsset.promise.then(scheduleNeighbors);
    else scheduleNeighbors();
    return () => {
      disposed = true;
      window.clearTimeout(delayTimer);
      if (idleHandle) idleScheduler.cancelIdleCallback?.(idleHandle);
    };
  }, [
    activeIndex,
    image,
    images,
    useViewportBitmapRenderer,
    viewportBitmapCapable,
    viewport.height,
    viewport.width,
  ]);

  useEffect(() => {
    if (
      !useViewportBitmapRenderer
      || currentFullResolution.requested
      || transform.scale <= MIN_SCALE
    ) return;
    setFullResolutionState((current) => current.id === image.id
      ? { ...current, requested: true, failed: false }
      : { id: image.id, requested: true, loaded: false, failed: false });
  }, [
    currentFullResolution.requested,
    image.id,
    transform.scale,
    useViewportBitmapRenderer,
  ]);

  useEffect(() => {
    if (!compactViewport || reducedMotion()) {
      preparedSwipeSnapshotRef.current = null;
      return;
    }
    let disposed = false;
    let prepared: PreparedSwipeSnapshot | null = null;
    let idleHandle = 0;
    let fallbackTimer = 0;
    const prepare = () => {
      if (disposed) return;
      prepared = prepareSwipeSnapshot();
      if (prepared) preparedSwipeSnapshotRef.current = prepared;
    };
    const idleScheduler = window as IdleScheduler;
    if (idleScheduler.requestIdleCallback) {
      idleHandle = idleScheduler.requestIdleCallback(prepare, { timeout: 180 });
    } else {
      fallbackTimer = globalThis.setTimeout(prepare, 32);
    }
    return () => {
      disposed = true;
      if (idleHandle) idleScheduler.cancelIdleCallback?.(idleHandle);
      globalThis.clearTimeout(fallbackTimer);
      if (preparedSwipeSnapshotRef.current === prepared) {
        preparedSwipeSnapshotRef.current = null;
      }
    };
  }, [
    compactViewport,
    image.id,
    thumbnailLoaded,
    viewportRender.height,
    viewportRender.width,
  ]);

  useEffect(() => () => {
    window.clearTimeout(retryTimerRef.current);
    window.clearTimeout(sourceUpgradeTimerRef.current);
    window.clearTimeout(swipeCleanupTimerRef.current);
    cancelTransformFrame();
    swipeOutgoingRef.current?.remove();
    preparedSwipeSnapshotRef.current = null;
  }, []);

  const handleOriginalError = () => {
    const { attempt } = currentLoadState;
    if (dialogRef.current?.dataset.imageId !== image.id) return;
    if (attempt === 0) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        if (dialogRef.current?.dataset.imageId !== image.id) return;
        setLoadState((current) => current.id === image.id && current.attempt !== attempt
          ? current
          : pendingViewerSourceState(image.id, attempt + 1));
      }, 900);
      return;
    }
    setLoadState((current) => current.id === image.id && current.attempt !== attempt
      ? current
      : pendingViewerSourceState(image.id, attempt, true));
  };

  const retryOriginal = () => {
    window.clearTimeout(retryTimerRef.current);
    setLoadState(pendingViewerSourceState(
      image.id,
      currentLoadState.attempt + 1,
    ));
  };

  useLayoutEffect(() => {
    if (
      !useViewportBitmapRenderer
      || viewerIsBusy()
    ) return;
    const asset = getReadyViewerViewportRenderAsset(
      image,
      viewportRender.width,
      viewportRender.height,
      currentLoadState.attempt,
    );
    const canvas = canvasRef.current;
    if (!asset?.bitmap || !canvas) return;
    const sourceKey = `${fullSource}@${asset.width}x${asset.height}`;
    try {
      if (canvas.dataset.renderedSource !== sourceKey) {
        drawViewerCanvas(canvas, asset.bitmap, asset.width, asset.height, sourceKey);
      }
      markOriginalReady(image.id, currentLoadState.attempt, "direct");
    } catch (error) {
      console.warn("Pixhelf could not reuse the prepared viewer image", error);
    }
  }, [
    fullSource,
    image.id,
    useViewportBitmapRenderer,
    viewportRender.height,
    viewportRender.width,
  ]);

  useEffect(() => {
    if (!useCanvasRenderer) return;
    let disposed = false;
    let frame = 0;
    let settleTimer = 0;
    const attempt = currentLoadState.attempt;
    const viewportAsset = useViewportBitmapRenderer
      ? getViewerViewportRenderAsset(
        image,
        viewportRender.width,
        viewportRender.height,
        attempt,
        "high",
      )
      : null;
    const originalAsset = useSafeCanvasRenderer
      ? getViewerOriginalAsset(image, attempt, "high")
      : null;

    const renderOriginal = () => {
      const status = viewportAsset?.status ?? originalAsset?.status;
      if (disposed || status === "loading") return;
      if (status === "failed") {
        handleOriginalError();
        return;
      }
      try {
        const renderScale = useViewportBitmapRenderer
          ? 1
          : Math.min(1, MAX_RENDER_EDGE / Math.max(1, image.width, image.height));
        const renderWidth = viewportAsset?.width
          ?? Math.max(1, Math.round(image.width * renderScale));
        const renderHeight = viewportAsset?.height
          ?? Math.max(1, Math.round(image.height * renderScale));
        const source = viewportAsset?.bitmap ?? originalAsset?.element;
        const canvas = canvasRef.current;
        if (!canvas || !source) throw new Error("canvas renderer is unavailable");
        const sourceKey = `${fullSource}@${renderWidth}x${renderHeight}`;
        if (canvas.dataset.renderedSource !== sourceKey) {
          drawViewerCanvas(canvas, source, renderWidth, renderHeight, sourceKey);
        }

        window.clearTimeout(retryTimerRef.current);
        markOriginalReady(image.id, attempt);
      } catch (error) {
        if (disposed) return;
        console.warn("Pixhelf could not render the original image", error);
        handleOriginalError();
      }
    };

    const scheduleRender = () => {
      if (disposed || frame || settleTimer) return;
      const swipeInProgress = useViewportBitmapRenderer
        && dialogRef.current?.hasAttribute("data-swipe-direction");
      if (viewerIsBusy(useViewportBitmapRenderer)) {
        settleTimer = window.setTimeout(() => {
          settleTimer = 0;
          scheduleRender();
        }, swipeInProgress ? MOBILE_RENDER_SETTLE_MS : 48);
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (viewerIsBusy(useViewportBitmapRenderer)) {
          scheduleRender();
          return;
        }
        renderOriginal();
      });
    };

    scheduleRender();
    const pending = viewportAsset ?? originalAsset;
    if (pending?.status === "loading") void pending.promise.then(scheduleRender);
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [
    fullSource,
    image.id,
    image.width,
    image.height,
    useCanvasRenderer,
    useSafeCanvasRenderer,
    useViewportBitmapRenderer,
    viewportRender.height,
    viewportRender.width,
  ]);

  const beginContact = (id: number, point: PointerPoint, pointerType: string) => {
    if (pointerType !== "mouse") lastTouchAtRef.current = performance.now();
    if (pointerType !== "mouse" && pointersRef.current.size === 0) clearSwipeMotion();
    if (pointersRef.current.size === 0) {
      const surface = surfaceRef.current;
      const media = mediaRef.current;
      if (surface && media) {
        gestureGeometryRef.current = {
          surfaceWidth: surface.clientWidth,
          surfaceHeight: surface.clientHeight,
          mediaWidth: media.offsetWidth,
          mediaHeight: media.offsetHeight,
          surfaceBounds: surface.getBoundingClientRect(),
        };
      }
    }
    pointersRef.current.set(id, point);
    setDragging(true);

    if (pointersRef.current.size === 1) {
      gestureStartRef.current = {
        point,
        transform: transformRef.current,
        scrollTop: dialogRef.current?.scrollTop ?? 0,
        startedAt: performance.now(),
        pointerType,
      };
      gestureAxisRef.current = null;
      gestureModeRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      pinchedRef.current = true;
      gestureModeRef.current = "pinch";
      lastTapRef.current = null;
      if ((dialogRef.current?.scrollTop ?? scrollTopRef.current) <= VIEWER_SCROLL_EPSILON) {
        pinchStartRef.current = {
          distance: Math.max(1, pointDistance(first, second)),
          midpoint: pointMidpoint(first, second),
          transform: transformRef.current,
        };
      } else {
        pinchStartRef.current = null;
      }
    }
  };

  const moveContact = (id: number, point: PointerPoint) => {
    if (!pointersRef.current.has(id)) return;
    pointersRef.current.set(id, point);

    if (pointersRef.current.size >= 2 && pinchStartRef.current) {
      const [first, second] = Array.from(pointersRef.current.values());
      const start = pinchStartRef.current;
      const midpoint = pointMidpoint(first, second);
      const scale = clamp(
        start.transform.scale * pointDistance(first, second) / start.distance,
        MIN_SCALE,
        MAX_SCALE,
      );
      const bounds = gestureGeometryRef.current?.surfaceBounds
        ?? surfaceRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const center = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
      const imagePoint = {
        x: (start.midpoint.x - center.x - start.transform.x) / start.transform.scale,
        y: (start.midpoint.y - center.y - start.transform.y) / start.transform.scale,
      };
      stageTransform(constrainTransform({
        scale,
        x: midpoint.x - center.x - imagePoint.x * scale,
        y: midpoint.y - center.y - imagePoint.y * scale,
      }));
      return;
    }
    if (pointersRef.current.size >= 2 || pinchedRef.current) return;

    const start = gestureStartRef.current;
    if (!start || pointersRef.current.size !== 1) return;
    const deltaX = point.x - start.point.x;
    const deltaY = point.y - start.point.y;
    if (!gestureAxisRef.current && Math.hypot(deltaX, deltaY) > 7) {
      gestureAxisRef.current = Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
      gestureModeRef.current = start.transform.scale > MIN_SCALE
        ? "pan"
        : start.scrollTop > VIEWER_SCROLL_EPSILON
          ? "page"
          : gestureAxisRef.current === "x"
            ? "navigate"
            : deltaY < 0
              ? "page"
              : "dismiss";
    }

    if (gestureModeRef.current === "pan") {
      forceViewerScroll(0);
      stageTransform(constrainTransform({
        ...start.transform,
        x: start.transform.x + deltaX,
        y: start.transform.y + deltaY,
      }));
      return;
    }

    const surface = surfaceRef.current;
    if (gestureModeRef.current === "navigate") {
      const navigationAvailable = deltaX < 0 ? canNext : deltaX > 0 && canPrevious;
      const maximumTravel = Math.max(
        1,
        (gestureGeometryRef.current?.surfaceWidth ?? surface?.clientWidth ?? 360) * 0.94,
      );
      stageTransform({
        scale: 1,
        x: navigationAvailable
          ? clamp(deltaX * 0.92, -maximumTravel, maximumTravel)
          : rubberBand(deltaX, Math.max(72, maximumTravel * 0.22)) * 0.38,
        y: 0,
      });
    } else if (gestureModeRef.current === "page") {
      const viewer = dialogRef.current;
      if (viewer) {
        const detailsTop = detailsSectionRef.current?.offsetTop ?? viewer.clientHeight;
        viewer.scrollTop = clamp(start.scrollTop - deltaY, 0, detailsTop);
        scrollTopRef.current = viewer.scrollTop;
        const page = syncScrollPage(viewer.scrollTop) ?? scrollPageRef.current;
        rememberViewerScroll(viewer, page);
        if (transformRef.current.x || transformRef.current.y) stageTransform(DEFAULT_TRANSFORM);
        return;
      }
    } else if (gestureModeRef.current === "dismiss") {
      stageTransform({
        scale: 1,
        x: 0,
        y: rubberBand(
          Math.max(0, deltaY),
          Math.max(
            80,
            (gestureGeometryRef.current?.surfaceHeight ?? surface?.clientHeight ?? 640) * 0.2,
          ),
        ),
      });
    }
  };

  const handleTouchTap = (point: PointerPoint) => {
    const now = performance.now();
    const lastTap = lastTapRef.current;
    if (
      lastTap &&
      now - lastTap.at <= DOUBLE_TAP_DELAY_MS &&
      pointDistance(lastTap.point, point) < 32
    ) {
      lastTapRef.current = null;
      zoomAt(
        transformRef.current.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE,
        point,
      );
      return;
    }
    lastTapRef.current = { at: now, point };
  };

  const finishContact = (
    id: number,
    point: PointerPoint,
    pointerType: string,
  ) => {
    flushStagedTransform();
    const pointerCount = pointersRef.current.size;
    pointersRef.current.delete(id);

    if (pointerCount > 1) {
      const remaining = pointersRef.current.values().next().value as PointerPoint | undefined;
      pinchStartRef.current = null;
      if (remaining) {
        gestureStartRef.current = {
          point: remaining,
          transform: transformRef.current,
          scrollTop: dialogRef.current?.scrollTop ?? 0,
          startedAt: performance.now(),
          pointerType,
        };
      }
      return;
    }

    setDragging(false);
    const start = gestureStartRef.current;
    const gestureMode = gestureModeRef.current;
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    gestureAxisRef.current = null;
    gestureModeRef.current = null;
    const wasPinched = pinchedRef.current;
    pinchedRef.current = false;
    if (wasPinched) {
      const viewer = dialogRef.current;
      const detailsTop = detailsSectionRef.current?.offsetTop ?? viewer?.clientHeight ?? 0;
      const currentScroll = viewer?.scrollTop ?? 0;
      if (currentScroll > VIEWER_SCROLL_EPSILON && detailsTop > 0) {
        if (currentScroll >= detailsTop * 0.18) scrollToDetails();
        else scrollToImage();
        gestureGeometryRef.current = null;
        return;
      }
      commitTransform(constrainTransform(transformRef.current));
      gestureGeometryRef.current = null;
      return;
    }
    if (!start) {
      gestureGeometryRef.current = null;
      return;
    }

    const deltaX = point.x - start.point.x;
    const deltaY = point.y - start.point.y;
    const elapsed = Math.max(1, performance.now() - start.startedAt);
    const isTap = Math.hypot(deltaX, deltaY) < 10 && elapsed < 320;

    if (start.transform.scale > MIN_SCALE) {
      if (isTap && start.pointerType !== "mouse") {
        handleTouchTap(point);
        gestureGeometryRef.current = null;
        return;
      }
      commitTransform(constrainTransform(transformRef.current));
      gestureGeometryRef.current = null;
      return;
    }

    const surface = surfaceRef.current;
    const surfaceWidth = gestureGeometryRef.current?.surfaceWidth
      ?? surface?.clientWidth
      ?? 360;
    const isTouchSwipe = start.pointerType === "touch";
    const horizontalDistance = Math.abs(deltaX);
    const horizontalThreshold = isTouchSwipe
      ? clamp(
        surfaceWidth * TOUCH_SWIPE_DISTANCE_RATIO,
        TOUCH_SWIPE_MIN_DISTANCE_PX,
        TOUCH_SWIPE_MAX_DISTANCE_PX,
      )
      : Math.max(54, surfaceWidth * 0.11);
    const horizontalFlick = horizontalDistance > (
      isTouchSwipe ? TOUCH_SWIPE_FLICK_MIN_DISTANCE_PX : 30
    ) && horizontalDistance / elapsed > (
      isTouchSwipe ? TOUCH_SWIPE_FLICK_VELOCITY : 0.48
    );
    const verticalThreshold = Math.max(
      84,
      (gestureGeometryRef.current?.surfaceHeight ?? surface?.clientHeight ?? 640) * 0.12,
    );
    const verticalFlick = deltaY > 38 && deltaY / elapsed > 0.52;
    const detailsFlick = deltaY < -38 && -deltaY / elapsed > 0.52;

    if (
      gestureMode === "navigate" &&
      horizontalDistance > Math.abs(deltaY) &&
      (horizontalDistance >= horizontalThreshold || horizontalFlick)
    ) {
      if (deltaX < 0 && canNext) {
        navigateWithSwipeMotion(1);
        gestureGeometryRef.current = null;
        return;
      }
      if (deltaX > 0 && canPrevious) {
        navigateWithSwipeMotion(-1);
        gestureGeometryRef.current = null;
        return;
      }
    }
    if (gestureMode === "page") {
      const viewer = dialogRef.current;
      const detailsTop = detailsSectionRef.current?.offsetTop ?? viewer?.clientHeight ?? 640;
      const currentScroll = viewer?.scrollTop ?? 0;
      if (detailsFlick || currentScroll >= detailsTop * 0.18) {
        scrollToDetails();
      } else {
        scrollToImage();
      }
      gestureGeometryRef.current = null;
      return;
    }
    if (
      gestureMode === "dismiss" &&
      deltaY > Math.abs(deltaX) &&
      (deltaY >= verticalThreshold || verticalFlick)
    ) {
      onClose();
      gestureGeometryRef.current = null;
      return;
    }

    commitTransform(DEFAULT_TRANSFORM);
    if (isTap && start.pointerType !== "mouse") {
      handleTouchTap(point);
    }
    gestureGeometryRef.current = null;
  };

  const cancelContacts = () => {
    flushStagedTransform();
    pointersRef.current.clear();
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    gestureAxisRef.current = null;
    gestureModeRef.current = null;
    pinchedRef.current = false;
    setDragging(false);
    const viewer = dialogRef.current;
    const detailsTop = detailsSectionRef.current?.offsetTop ?? viewer?.clientHeight ?? 0;
    if ((viewer?.scrollTop ?? 0) > 1 && detailsTop > 0) {
      if ((viewer?.scrollTop ?? 0) >= detailsTop * 0.18) {
        scrollToDetails();
      } else {
        scrollToImage();
      }
      gestureGeometryRef.current = null;
      return;
    }
    commitTransform(constrainTransform(transformRef.current));
    gestureGeometryRef.current = null;
  };

  const beginPointer = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    // Touch input is handled by non-passive native TouchEvent listeners below. Keeping
    // it out of this path prevents browsers that emit both event families from applying
    // every movement twice.
    if (event.pointerType === "touch") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some pen/browser combinations do not allow capture here.
    }
    beginContact(
      event.pointerId,
      { x: event.clientX, y: event.clientY },
      event.pointerType,
    );
  };

  const movePointer = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    moveContact(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const finishPointer = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    finishContact(
      event.pointerId,
      { x: event.clientX, y: event.clientY },
      event.pointerType,
    );
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may have released capture already.
    }
  };

  const cancelPointer = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") cancelContacts();
  };

  gestureHandlersRef.current = {
    begin: beginContact,
    move: moveContact,
    finish: finishContact,
    cancel: cancelContacts,
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const touchPoint = (touch: Touch): PointerPoint => ({
      x: touch.clientX,
      y: touch.clientY,
    });
    const handleTouchStart = (event: TouchEvent) => {
      event.preventDefault();
      for (const touch of Array.from(event.changedTouches)) {
        gestureHandlersRef.current?.begin(touch.identifier, touchPoint(touch), "touch");
      }
    };
    const handleTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      for (const touch of Array.from(event.changedTouches)) {
        gestureHandlersRef.current?.move(touch.identifier, touchPoint(touch));
      }
    };
    const handleTouchEnd = (event: TouchEvent) => {
      event.preventDefault();
      for (const touch of Array.from(event.changedTouches)) {
        gestureHandlersRef.current?.finish(touch.identifier, touchPoint(touch), "touch");
      }
    };
    const handleTouchCancel = (event: TouchEvent) => {
      event.preventDefault();
      gestureHandlersRef.current?.cancel();
    };

    surface.addEventListener("touchstart", handleTouchStart, { passive: false });
    surface.addEventListener("touchmove", handleTouchMove, { passive: false });
    surface.addEventListener("touchend", handleTouchEnd, { passive: false });
    surface.addEventListener("touchcancel", handleTouchCancel, { passive: false });
    return () => {
      surface.removeEventListener("touchstart", handleTouchStart);
      surface.removeEventListener("touchmove", handleTouchMove);
      surface.removeEventListener("touchend", handleTouchEnd);
      surface.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, []);

  const handleViewerScroll = (event: JSX.TargetedEvent<HTMLDivElement, Event>) => {
    const viewer = event.currentTarget;
    const previousTop = scrollTopRef.current;
    const nextTop = viewer.scrollTop;
    if (transformRef.current.scale > MIN_SCALE && nextTop > VIEWER_SCROLL_EPSILON) {
      forceViewerScroll(0);
      return;
    }
    scrollTopRef.current = nextTop;
    const page = syncScrollPage(nextTop) ?? scrollPageRef.current;
    rememberViewerScroll(viewer, page);
    if (nextTop > VIEWER_SCROLL_EPSILON || previousTop > VIEWER_SCROLL_EPSILON) {
      wheelZoomBlockedUntilRef.current = performance.now() + WHEEL_HANDOFF_DELAY_MS;
    }
  };

  const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    const now = performance.now();
    const scrollTop = dialogRef.current?.scrollTop ?? scrollTopRef.current;
    if (scrollTop > VIEWER_SCROLL_EPSILON) {
      if (event.ctrlKey) event.preventDefault();
      return;
    }
    const currentScale = transformRef.current.scale;
    if (currentScale <= MIN_SCALE && !event.ctrlKey && event.deltaY > 0) {
      if (now < wheelZoomBlockedUntilRef.current) event.preventDefault();
      return;
    }
    if (now < wheelZoomBlockedUntilRef.current) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const deltaMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? surfaceRef.current?.clientHeight ?? viewport.height
        : 1;
    const normalizedDelta = clamp(event.deltaY * deltaMultiplier, -160, 160);
    const nextScale = currentScale * Math.exp(-normalizedDelta * 0.002);
    if (currentScale > MIN_SCALE && nextScale <= MIN_SCALE) {
      wheelZoomBlockedUntilRef.current = now + WHEEL_HANDOFF_DELAY_MS;
    }
    zoomAt(nextScale, { x: event.clientX, y: event.clientY });
  };

  const displayPosition = Math.min(total, activeIndex + 1);
  const liveTransform = transformRef.current;
  const viewerStyle = {
    "--viewer-dismiss-progress": String(
      liveTransform.scale === 1
        ? clamp(
          Math.max(0, liveTransform.y)
            / Math.max(1, gestureGeometryRef.current?.surfaceHeight ?? surfaceRef.current?.clientHeight ?? 640),
          0,
          0.45,
        )
        : 0,
    ),
  } as CSSProperties;
  const mediaWidth = mediaDimensions.width;
  const mediaHeight = mediaDimensions.height;
  const nativeOriginalActive = currentFullResolution.loaded
    && liveTransform.scale > MIN_SCALE;
  const displaySource = resolveViewerDisplaySource({
    sourceLoaded: currentLoadState.loaded,
    thumbnailLoaded,
    viewportBitmapRenderer: useViewportBitmapRenderer,
    nativeOriginalActive,
  });
  const renderer = sourceStrategy === "viewport-upgrade"
    ? "viewport-bitmap"
    : sourceStrategy === "bounded-canvas"
      ? "safe-canvas"
      : "native";
  const mediaStyle = {
    width: `${mediaWidth}px`,
    height: `${mediaHeight}px`,
    aspectRatio: `${image.width} / ${image.height}`,
    transform: `translate3d(${liveTransform.x}px, ${liveTransform.y}px, 0) scale(${liveTransform.scale})`,
  } as CSSProperties;
  const renderActionSuite = (details = false) => (
    <div
      className={`viewer-header-actions${details ? " viewer-details-toolbar" : ""}`}
      role="group"
      aria-label={details ? "图片详情操作" : "图片查看操作"}
    >
      {details && (
        <button
          type="button"
          className="viewer-control viewer-details-return"
          onClick={() => scrollToImage(true)}
          aria-label="返回图片"
          title="返回图片"
        >
          <ChevronUp size={19} strokeWidth={1.8} />
        </button>
      )}
      <button
        type="button"
        className={`viewer-control viewer-similar-trigger${similarActive ? " is-active" : ""}`}
        onClick={() => {
          onSearchSimilar(image);
          scrollToSimilar();
        }}
        aria-label="以图搜图，查找相似图片"
        aria-pressed={similarActive}
        data-state={similarActive ? "active" : "idle"}
        title="以图搜图"
      >
        <ScanSearch size={19} />
      </button>
      <a
        className="viewer-control"
        href={viewerOriginalUrl(image)}
        download={image.name}
        aria-label="下载原图"
        title="下载原图"
      >
        <Download size={19} />
      </a>
      {fullscreenAvailable && (
        <button
          type="button"
          className={`viewer-control ${details ? "viewer-details-fullscreen" : "viewer-fullscreen"}${fullscreen ? " is-active" : ""}`}
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? "退出全屏" : "进入全屏"}
          aria-pressed={fullscreen}
          data-state={fullscreen ? "active" : "idle"}
          title={fullscreen ? "退出全屏" : "全屏查看"}
        >
          {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
        </button>
      )}
      <button
        ref={details ? undefined : closeButtonRef}
        type="button"
        className={`viewer-control ${details ? "viewer-details-close" : "viewer-close"}`}
        onClick={onClose}
        aria-label="关闭查看器"
        title="关闭 (Esc)"
      >
        <X size={21} />
      </button>
    </div>
  );
  const viewer = (
    <div
      ref={dialogRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`图片查看器：${image.name}`}
      data-image-id={image.id}
      data-image-name={image.name}
      data-full-loaded={currentLoadState.loaded}
      data-full-failed={currentLoadState.failed}
      data-source-presentation={currentLoadState.presentation}
      data-source-strategy={sourceStrategy}
      data-thumbnail-loaded={thumbnailLoaded}
      data-thumbnail-failed={thumbnailFailed}
      data-display-source={displaySource}
      data-native-original-requested={currentFullResolution.requested}
      data-native-original-loaded={currentFullResolution.loaded}
      data-native-original-active={nativeOriginalActive}
      data-zoomed={liveTransform.scale > MIN_SCALE}
      data-dragging={dragging}
      data-page={scrollPage}
      data-renderer={renderer}
      data-control-system="unified"
      data-ui-layout="floating"
      data-scroll-mode="continuous"
      data-mouse-side-navigation="true"
      data-mobile-swipe-motion="interruptible"
      data-mobile-gesture-renderer="raf-dom"
      data-mobile-original-policy={useViewportBitmapRenderer ? "zoom-only" : "direct"}
      tabIndex={-1}
      onScroll={handleViewerScroll}
      style={viewerStyle}
    >
      <section className="viewer-stage" aria-label="图片浏览区域">
        <div className="viewer-backdrop" aria-hidden="true" />

      <header className="viewer-header">
        {renderActionSuite()}
      </header>

      <div
        ref={surfaceRef}
        className="viewer-gesture-surface"
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPointer}
        onWheel={handleWheel}
        onDblClick={(event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (performance.now() - lastTouchAtRef.current < 500) return;
          zoomAt(
            transformRef.current.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE,
            { x: event.clientX, y: event.clientY },
          );
        }}
      >
        <div className="viewer-media-center">
          <div key={image.id} ref={mediaRef} className="viewer-media" style={mediaStyle}>
            <img
              key={`thumbnail-${image.id}`}
              className="viewer-thumbnail"
              src={viewerThumbnailUrl(image)}
              width={image.width}
              height={image.height}
              alt=""
              aria-hidden="true"
              loading="eager"
              decoding="async"
              fetchPriority="high"
              draggable={false}
              onLoad={() => setThumbnailState({
                id: image.id,
                loaded: true,
                failed: false,
              })}
              onError={() => setThumbnailState({
                id: image.id,
                loaded: false,
                failed: true,
              })}
            />
            {useCanvasRenderer ? (
              <canvas
                ref={canvasRef}
                key={`${fullSource}-${viewportRender.width}x${viewportRender.height}`}
                className="viewer-original viewer-original-canvas"
                role="img"
                aria-label={image.name}
                data-original-url={fullSource}
              />
            ) : (
              <img
                key={fullSource}
                className="viewer-original"
                src={fullSource}
                width={image.width}
                height={image.height}
                alt={image.name}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                draggable={false}
                onLoad={(event) => {
                  const original = event.currentTarget;
                  window.clearTimeout(retryTimerRef.current);
                  const decoded = typeof original.decode === "function"
                    ? original.decode().catch(() => undefined)
                    : Promise.resolve();
                  void decoded.then(() => {
                    displayedOriginalsRef.current.add(fullSource);
                    markOriginalReady(image.id, currentLoadState.attempt);
                  });
                }}
                onError={handleOriginalError}
              />
            )}
            {useViewportBitmapRenderer && currentFullResolution.requested && (
              <img
                key={`native-original-${fullSource}`}
                className="viewer-original viewer-native-original"
                src={fullSource}
                width={image.width}
                height={image.height}
                alt=""
                aria-hidden="true"
                loading="eager"
                decoding="async"
                fetchPriority="high"
                draggable={false}
                onLoad={() => {
                  displayedOriginalsRef.current.add(fullSource);
                  setFullResolutionState({
                    id: image.id,
                    requested: true,
                    loaded: true,
                    failed: false,
                  });
                }}
                onError={() => setFullResolutionState({
                  id: image.id,
                  requested: true,
                  loaded: false,
                  failed: true,
                })}
              />
            )}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="viewer-nav viewer-previous"
        onClick={() => onNavigate(-1)}
        disabled={!canPrevious}
        aria-label="上一张图片"
        title="上一张 (←)"
      >
        <ChevronLeft size={23} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="viewer-nav viewer-next"
        onClick={() => onNavigate(1)}
        disabled={!canNext || waitingForNext}
        aria-label={waitingForNext ? "正在加载下一张" : "下一张图片"}
        title="下一张 (→)"
      >
        {waitingForNext
          ? <LoaderCircle className="spin" size={20} />
          : <ChevronRight size={23} strokeWidth={1.8} />}
      </button>

      <div className="viewer-bottom-bar">
        <button
          type="button"
          className="viewer-scroll-cue"
          onClick={() => scrollToDetails(true)}
          aria-label="向下滚动到图片详情"
          title="查看图片详情"
        >
          <ChevronsDown size={38} strokeWidth={1.55} />
        </button>
      </div>

      {currentLoadState.failed && (
        <button type="button" className="viewer-load-error" onClick={retryOriginal}>
          <RefreshCw size={15} />
          <span>原图加载失败，点击重试</span>
        </button>
      )}
      </section>

      <section
        ref={detailsSectionRef}
        className="viewer-details-page"
        tabIndex={-1}
        aria-labelledby="image-viewer-details-title"
        data-details-image-name={image.name}
      >
        <div className="viewer-details-inner">
          <header className="viewer-details-header">
            <div className="viewer-details-heading">
              <h2 id="image-viewer-details-title">图片详情</h2>
              <span>{displayPosition} / {total}</span>
            </div>
            {renderActionSuite(true)}
          </header>

          <div className="viewer-details-content">
            <PhotoInformation image={image} />

            <section
                ref={similarSectionRef}
                className={`viewer-similar-section${similarActive ? "" : " is-idle"}`}
                aria-labelledby={similarActive ? "viewer-similar-title" : undefined}
                data-similar-active={similarActive}
              >
                {similarActive && (
                  <>
                    <div className="viewer-similar-heading">
                      <div>
                        <h3 id="viewer-similar-title">相似图片</h3>
                      </div>
                      <ScanSearch size={20} aria-hidden="true" />
                    </div>

                    {similarLoading && !similarImages.length ? (
                      <SimilarImageSkeleton columnCount={similarColumnCount} />
                    ) : similarError && !similarImages.length ? (
                      <div className="viewer-similar-error" role="alert">
                        <span>{similarError}</span>
                        <button type="button" onClick={() => onSearchSimilar(image)}>
                          <RefreshCw size={15} />
                          重试
                        </button>
                      </div>
                    ) : similarImages.length ? (
                      <SimilarImageMasonry
                        images={similarImages}
                        total={similarTotal}
                        columnCount={similarColumnCount}
                        hasMore={similarHasMore}
                        loadingMore={similarLoadingMore}
                        error={similarError}
                        onLoadMore={onLoadMoreSimilar}
                        onOpen={onOpenSimilar}
                      />
                    ) : (
                      <div className="viewer-similar-empty">
                        <ScanSearch size={22} />
                        <span>暂时没有找到相似图片</span>
                      </div>
                    )}
                  </>
                )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );

  return createPortal(viewer, document.body);
}
