import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  LoaderCircle,
  Maximize,
  Minimize,
  Minus,
  Plus,
  RefreshCw,
  Scan,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { GalleryImage } from "./types";
import { type Point, useViewerEngine } from "./viewer/useViewerEngine";

const DOUBLE_TAP_DELAY = 230;
const VIEWER_PREVIEW_EDGE = 2560;

type SourceStatus = "loading" | "ready" | "failed";

interface SourceState {
  imageId: string;
  status: SourceStatus;
}

interface PendingTap extends Point {
  time: number;
  pointerType: string;
}

interface RetryState {
  imageId: string;
  attempt: number;
}

interface ImageViewerProps {
  images: GalleryImage[];
  index: number;
  total: number;
  onIndexChange: (index: number) => void;
  onNeedMore: () => void;
  onClose: () => void;
}

interface ViewportSize {
  width: number;
  height: number;
}

function viewportSize(): ViewportSize {
  return {
    width: Math.round(window.visualViewport?.width ?? window.innerWidth),
    height: Math.round(window.visualViewport?.height ?? window.innerHeight),
  };
}

function useViewportSize(): ViewportSize {
  const [size, setSize] = useState(viewportSize);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setSize(viewportSize()));
    };
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  return size;
}

function fittedSize(image: GalleryImage, viewport: ViewportSize) {
  const compact = viewport.width <= 720;
  const availableWidth = Math.max(1, viewport.width - (compact ? 8 : 72));
  const availableHeight = Math.max(1, viewport.height - (compact ? 8 : 40));
  const ratio = Math.min(
    availableWidth / Math.max(image.width, 1),
    availableHeight / Math.max(image.height, 1),
    1,
  );
  return {
    width: Math.max(1, Math.round(image.width * ratio)),
    height: Math.max(1, Math.round(image.height * ratio)),
  };
}

function maximumZoom(
  image: GalleryImage,
  frame: ViewportSize,
  previewReady: boolean,
  originalReady: boolean,
) {
  if (!previewReady && !originalReady) return 1;
  const sourceEdge = originalReady
    ? Math.max(image.width, image.height)
    : Math.min(VIEWER_PREVIEW_EDGE, Math.max(image.width, image.height));
  const nativeScale = sourceEdge / Math.max(frame.width, frame.height, 1);
  return Math.max(1, Math.min(6, nativeScale));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function ImageViewer({
  images,
  index,
  total,
  onIndexChange,
  onNeedMore,
  onClose,
}: ImageViewerProps) {
  const image = images[index];
  const previous = images[index - 1] ?? null;
  const next = images[index + 1] ?? null;
  const viewport = useViewportSize();
  const compact = viewport.width <= 720;
  const frameSize = useMemo(() => fittedSize(image, viewport), [image, viewport]);
  const slideSpan = viewport.width + (compact ? 12 : 28);
  const [sourceState, setSourceState] = useState<SourceState>({
    imageId: image.id,
    status: "loading",
  });
  const [previewState, setPreviewState] = useState<SourceState>({
    imageId: image.id,
    status: "loading",
  });
  const [thumbnailState, setThumbnailState] = useState<SourceState>({
    imageId: image.id,
    status: "loading",
  });
  // Keep the large source out of the network queue while the sharp preview is
  // being fetched. A short timeout keeps the original a reliable fallback on
  // slow or unavailable preview endpoints.
  const [originalGate, setOriginalGate] = useState({ imageId: image.id, open: false });
  const [retryState, setRetryState] = useState<RetryState>({
    imageId: image.id,
    attempt: 0,
  });
  const sourceAttempt = retryState.imageId === image.id ? retryState.attempt : 0;
  const [controlsVisible, setControlsVisible] = useState(true);
  const [closing, setClosing] = useState(false);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [pendingNext, setPendingNext] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const currentImageIdRef = useRef(image.id);
  const sourceAttemptRef = useRef(sourceAttempt);
  const closeTimerRef = useRef(0);
  const controlsTimerRef = useRef(0);
  const tapTimerRef = useRef(0);
  const pendingTimerRef = useRef(0);
  const pendingRetryRef = useRef(0);
  const tapRef = useRef<PendingTap | null>(null);
  const tapHandlerRef = useRef<(point: Point, pointerType: string) => void>(() => undefined);
  currentImageIdRef.current = image.id;
  sourceAttemptRef.current = sourceAttempt;

  const originalReady = sourceState.imageId === image.id && sourceState.status === "ready";
  const originalFailed = sourceState.imageId === image.id && sourceState.status === "failed";
  const previewReady = previewState.imageId === image.id && previewState.status === "ready";
  const thumbnailReady = thumbnailState.imageId === image.id && thumbnailState.status === "ready";
  const originalEnabled = originalGate.imageId === image.id && originalGate.open;
  const maxZoom = useMemo(
    () => maximumZoom(
      image,
      frameSize,
      previewReady,
      originalReady,
    ),
    [frameSize, image, originalReady, previewReady],
  );

  const clearTap = useCallback(() => {
    window.clearTimeout(tapTimerRef.current);
    tapTimerRef.current = 0;
    tapRef.current = null;
  }, []);

  const scheduleControlsHide = useCallback(() => {
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => {
      const root = rootRef.current;
      if (root?.querySelector(".viewer-chrome:focus-within")) return;
      setControlsVisible(false);
    }, compact ? 1700 : 1400);
  }, [compact]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const requestOriginal = useCallback(() => {
    setOriginalGate((current) =>
      current.imageId === image.id && !current.open
        ? { imageId: image.id, open: true }
        : current,
    );
  }, [image.id]);

  const requestClose = useCallback(() => {
    if (closing) return;
    clearTap();
    window.clearTimeout(controlsTimerRef.current);
    setClosing(true);
    if (document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
    closeTimerRef.current = window.setTimeout(onClose, 170);
  }, [clearTap, closing, onClose]);

  const handleNavigate = useCallback((direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    clearTap();
    setPendingNext(false);
    onIndexChange(target);
    revealControls();
  }, [clearTap, images.length, index, onIndexChange, revealControls]);

  const handleEdge = useCallback((direction: -1 | 1) => {
    if (direction > 0 && index + 1 < total && !pendingNext) {
      setPendingNext(true);
      onNeedMore();
    }
  }, [index, onNeedMore, pendingNext, total]);

  const engine = useViewerEngine({
    imageId: image.id,
    frameSize,
    maximumZoom: maxZoom,
    canPrevious: Boolean(previous),
    canNext: Boolean(next),
    onNavigate: handleNavigate,
    onEdge: handleEdge,
    onDismiss: requestClose,
    onTap: (point, pointerType) => tapHandlerRef.current(point, pointerType),
    onDragStart: clearTap,
    onInteraction: () => {
      revealControls();
      requestOriginal();
    },
  });

  const commitSingleTap = useCallback(() => {
    setControlsVisible((visible) => {
      if (visible) window.clearTimeout(controlsTimerRef.current);
      else scheduleControlsHide();
      return !visible;
    });
  }, [scheduleControlsHide]);

  const handleTap = useCallback((point: Point, pointerType: string) => {
    const now = performance.now();
    const pending = tapRef.current;
    const tapDelay = pointerType === "touch" ? DOUBLE_TAP_DELAY : 200;
    const threshold = pointerType === "touch" ? 34 : 24;
    const compatible = pending &&
      pending.pointerType === pointerType &&
      now - pending.time <= tapDelay + 40 &&
      Math.hypot(pending.x - point.x, pending.y - point.y) <= threshold;

    if (compatible) {
      clearTap();
      engine.toggleZoomAt(point);
      return;
    }
    if (pending) {
      window.clearTimeout(tapTimerRef.current);
      commitSingleTap();
    }
    tapRef.current = { ...point, time: now, pointerType };
    tapTimerRef.current = window.setTimeout(() => {
      tapRef.current = null;
      tapTimerRef.current = 0;
      commitSingleTap();
    }, tapDelay);
  }, [clearTap, commitSingleTap, engine]);

  tapHandlerRef.current = handleTap;

  const canvasHandlers = {
    onPointerDown: engine.handlePointerDown,
    onPointerMove: engine.handlePointerMove,
    onPointerUp: engine.handlePointerUp,
    onPointerCancel: engine.handlePointerCancel,
    onLostPointerCapture: engine.handleLostPointerCapture,
  };

  useEffect(() => {
    setAnnouncement(`${image.name}，第 ${index + 1} 张，共 ${total} 张`);
  }, [image.id, image.name, index, total]);

  useEffect(() => {
    if (!pendingNext || index + 1 >= images.length) return;
    let cancelled = false;
    const advance = () => {
      if (cancelled) return;
      if (engine.navigate(1)) {
        setPendingNext(false);
        return;
      }
      pendingRetryRef.current = window.setTimeout(advance, 120);
    };
    advance();
    return () => {
      cancelled = true;
      window.clearTimeout(pendingRetryRef.current);
    };
  }, [engine.navigate, images.length, index, pendingNext]);

  useEffect(() => {
    if (!pendingNext) return;
    window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => setPendingNext(false), 8000);
    return () => window.clearTimeout(pendingTimerRef.current);
  }, [pendingNext]);

  useEffect(() => {
    if (index >= images.length - 4 && index + 1 < total) onNeedMore();
  }, [images.length, index, onNeedMore, total]);

  const handleOriginalLoad = useCallback(async (event: SyntheticEvent<HTMLImageElement>) => {
    const element = event.currentTarget;
    const imageId = element.dataset.imageId;
    const attempt = Number(element.dataset.sourceAttempt ?? -1);
    try {
      await element.decode();
    } catch {
      // A completed image can still reject decode on some WebKit versions.
    }
    if (
      imageId &&
      imageId === currentImageIdRef.current &&
      attempt === sourceAttemptRef.current &&
      element.isConnected &&
      element.complete &&
      element.naturalWidth > 0
    ) {
      setSourceState({ imageId, status: "ready" });
    }
  }, []);

  const handleThumbnailLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const imageId = event.currentTarget.dataset.imageId;
    if (
      imageId &&
      imageId === currentImageIdRef.current &&
      event.currentTarget.isConnected &&
      event.currentTarget.complete &&
      event.currentTarget.naturalWidth > 0
    ) {
      setThumbnailState({ imageId, status: "ready" });
    }
  }, []);

  const handlePreviewLoad = useCallback(async (event: SyntheticEvent<HTMLImageElement>) => {
    const element = event.currentTarget;
    const imageId = element.dataset.imageId;
    try {
      await element.decode();
    } catch {
      // A completed image can still reject decode on some WebKit versions.
    }
    if (
      imageId &&
      imageId === currentImageIdRef.current &&
      element.isConnected &&
      element.complete &&
      element.naturalWidth > 0
    ) {
      setPreviewState({ imageId, status: "ready" });
    }
  }, []);

  const handlePreviewError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const imageId = event.currentTarget.dataset.imageId;
    if (imageId && imageId === currentImageIdRef.current && event.currentTarget.isConnected) {
      setPreviewState({ imageId, status: "failed" });
    }
  }, []);

  useEffect(() => {
    setSourceState({ imageId: image.id, status: "loading" });
    setPreviewState({ imageId: image.id, status: "loading" });
    setThumbnailState({ imageId: image.id, status: "loading" });
    setOriginalGate({ imageId: image.id, open: false });

    const timer = window.setTimeout(() => {
      setOriginalGate((current) =>
        current.imageId === image.id ? { imageId: image.id, open: true } : current,
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [image.id]);

  useEffect(() => {
    const previewFailed = previewState.imageId === image.id && previewState.status === "failed";
    if (!previewReady && !previewFailed) return;
    setOriginalGate((current) =>
      current.imageId === image.id ? { imageId: image.id, open: true } : current,
    );
  }, [image.id, previewReady, previewState.status]);

  const handleOriginalError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const element = event.currentTarget;
    const imageId = element.dataset.imageId;
    const attempt = Number(element.dataset.sourceAttempt ?? -1);
    if (
      imageId &&
      imageId === currentImageIdRef.current &&
      attempt === sourceAttemptRef.current &&
      element.isConnected
    ) {
      setSourceState({ imageId, status: "failed" });
    }
  }, []);

  useEffect(() => {
    if (!previewReady || !next?.previewUrl) return;
    let cancelled = false;
    const prefetchTimer = window.setTimeout(() => {
      if (cancelled) return;
      const preloader = new Image();
      preloader.decoding = "async";
      preloader.fetchPriority = "low";
      preloader.src = next.previewUrl;
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(prefetchTimer);
    };
  }, [image.id, next?.previewUrl, previewReady]);

  const retryOriginal = useCallback(() => {
    setSourceState({ imageId: image.id, status: "loading" });
    setRetryState((current) => ({
      imageId: image.id,
      attempt: current.imageId === image.id ? current.attempt + 1 : 1,
    }));
    revealControls();
  }, [image.id, revealControls]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      // Browsers may deny fullscreen in embedded contexts.
    }
  }, []);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const app = document.querySelector<HTMLElement>(".app-shell");
    const previousInert = app?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    if (app) app.inert = true;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    const frame = window.requestAnimationFrame(() => rootRef.current?.focus());
    scheduleControlsHide();
    return () => {
      window.cancelAnimationFrame(frame);
      if (app) app.inert = previousInert;
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [scheduleControlsHide]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const controlsHidden = rootRef.current?.dataset.controlsVisible === "false";
        const focusable = [...(rootRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [])].filter((element) =>
          element.offsetParent !== null &&
          (!controlsHidden || element.classList.contains("viewer-essential"))
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1)!;
        if (document.activeElement === rootRef.current) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          requestClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          engine.navigate(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          engine.navigate(1);
          break;
        case "+":
        case "=":
          event.preventDefault();
          engine.zoomBy(1.4);
          break;
        case "-":
          event.preventDefault();
          engine.zoomBy(1 / 1.4);
          break;
        case "0":
          event.preventDefault();
          engine.resetZoom();
          break;
        case "f":
        case "F":
          event.preventDefault();
          void toggleFullscreen();
          break;
        case " ":
          if ((event.target as HTMLElement | null)?.closest("button, a, input, select, textarea")) {
            return;
          }
          event.preventDefault();
          commitSingleTap();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commitSingleTap, engine, requestClose, toggleFullscreen]);

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current);
    window.clearTimeout(controlsTimerRef.current);
    window.clearTimeout(tapTimerRef.current);
    window.clearTimeout(pendingTimerRef.current);
    window.clearTimeout(pendingRetryRef.current);
  }, []);

  const originalUrl = sourceAttempt
    ? `${image.originalUrl}?retry=${sourceAttempt}`
    : image.originalUrl;
  const frameStyle = {
    width: frameSize.width,
    height: frameSize.height,
  } satisfies CSSProperties;

  return createPortal(
    <div
      ref={rootRef}
      className={`image-viewer ${closing ? "is-closing" : ""}`}
      data-controls-visible={controlsVisible}
      data-interacting={engine.interacting}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      tabIndex={-1}
      onFocusCapture={revealControls}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" && event.buttons === 0) revealControls();
      }}
    >
      <div
        ref={engine.canvasRef}
        className="viewer-canvas"
        aria-label={`${image.name}，第 ${index + 1} 张，共 ${total} 张`}
        {...canvasHandlers}
      >
        <div ref={engine.trackRef} className="viewer-track">
          {previous && (
            <NeighborSlide
              image={previous}
              viewport={viewport}
              offset={-slideSpan}
            />
          )}

          <div className="viewer-slide viewer-slide-current">
            <div className="viewer-media" style={frameStyle}>
              <div
                ref={engine.motionRef}
                className="viewer-transform"
                data-zoomed="false"
                onContextMenu={(event) => event.preventDefault()}
              >
                <div className="viewer-image-frame">
                  <img
                    className="viewer-image viewer-image-thumbnail"
                    src={image.thumbnailUrl}
                    alt=""
                    data-image-id={image.id}
                    draggable={false}
                    decoding="async"
                    loading="eager"
                    fetchPriority="high"
                    onLoad={handleThumbnailLoad}
                  />
                  <img
                    key={`${image.id}-preview`}
                    className={`viewer-image viewer-image-preview ${previewReady && !originalReady ? "is-ready" : ""}`}
                    src={image.previewUrl}
                    alt=""
                    data-image-id={image.id}
                    draggable={false}
                    decoding="async"
                    fetchPriority="high"
                    onLoad={handlePreviewLoad}
                    onError={handlePreviewError}
                  />
                  {originalEnabled && (
                    <img
                      key={`${image.id}-${sourceAttempt}`}
                      className={`viewer-image viewer-image-original ${originalReady ? "is-ready" : ""}`}
                      src={originalUrl}
                      alt={image.name}
                      data-image-id={image.id}
                      data-source-attempt={sourceAttempt}
                      draggable={false}
                      decoding="async"
                      loading="eager"
                      fetchPriority="auto"
                      onLoad={handleOriginalLoad}
                      onError={handleOriginalError}
                    />
                  )}
                  {!thumbnailReady && !previewReady && !originalReady && !originalFailed && (
                    <span className="viewer-loading" aria-label="正在载入原图">
                      <LoaderCircle className="spin" size={22} />
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {next && (
            <NeighborSlide
              image={next}
              viewport={viewport}
              offset={slideSpan}
            />
          )}
        </div>
      </div>

      <header
        className="viewer-topbar viewer-chrome"
        onPointerEnter={() => window.clearTimeout(controlsTimerRef.current)}
        onPointerLeave={scheduleControlsHide}
        onFocusCapture={() => window.clearTimeout(controlsTimerRef.current)}
        onBlurCapture={scheduleControlsHide}
      >
        <div className="viewer-about">
          <span className="viewer-counter">
            {formatCount(index + 1)} <i>/</i> {formatCount(total)}
          </span>
          <span className="viewer-file-copy">
            <strong title={image.name}>{image.name}</strong>
            <small>
              {formatCount(image.width)} x {formatCount(image.height)} · {formatBytes(image.size)}
            </small>
          </span>
        </div>
      </header>

      <ViewerButton
        label="关闭查看器"
        className="viewer-close viewer-essential"
        onClick={requestClose}
      >
        <X size={22} />
      </ViewerButton>

      {!compact && (
        <>
          <ViewerButton
            label="上一张"
            className="viewer-nav viewer-nav-previous viewer-chrome"
            onClick={() => engine.navigate(-1)}
            disabled={!previous}
          >
            <ChevronLeft size={28} />
          </ViewerButton>
          <ViewerButton
            label={pendingNext ? "正在载入下一张" : "下一张"}
            className="viewer-nav viewer-nav-next viewer-chrome"
            onClick={() => engine.navigate(1)}
            disabled={index + 1 >= total}
          >
            {pendingNext ? <LoaderCircle className="spin" size={21} /> : <ChevronRight size={28} />}
          </ViewerButton>
        </>
      )}

      <div
        className="viewer-dock viewer-chrome"
        onPointerEnter={() => window.clearTimeout(controlsTimerRef.current)}
        onPointerLeave={scheduleControlsHide}
        onFocusCapture={() => window.clearTimeout(controlsTimerRef.current)}
        onBlurCapture={scheduleControlsHide}
      >
        {!compact && (
          <>
            <ViewerButton label="缩小" onClick={() => engine.zoomBy(1 / 1.4)} disabled={!engine.canZoom}>
              <Minus size={19} />
            </ViewerButton>
            <output className="viewer-zoom-value" aria-live="off">
              {engine.settledScale <= 1.01 ? "适应" : `${Math.round(engine.settledScale * 100)}%`}
            </output>
            <ViewerButton label="放大" onClick={() => engine.zoomBy(1.4)} disabled={!engine.canZoom}>
              <Plus size={19} />
            </ViewerButton>
          </>
        )}
        <ViewerButton label="适应窗口" onClick={engine.resetZoom} disabled={engine.settledScale <= 1.01}>
          <Scan size={19} />
        </ViewerButton>
        <span className="viewer-dock-divider" aria-hidden="true" />
        <a
          className="viewer-icon-button"
          href={image.originalUrl}
          download={image.name}
          aria-label="下载原图"
          title="下载原图"
        >
          <Download size={19} />
        </a>
        {!compact && (
          <ViewerButton
            label={fullscreen ? "退出全屏" : "进入全屏"}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          </ViewerButton>
        )}
      </div>

      {originalFailed && (
        <div className="viewer-source-error viewer-chrome" role="status">
          <ImageOff size={17} />
          <span>原图载入失败</span>
          <button type="button" onClick={retryOriginal}>
            <RefreshCw size={15} />
            重试
          </button>
        </div>
      )}

      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>,
    document.body,
  );
}

function NeighborSlide({
  image,
  viewport,
  offset,
}: {
  image: GalleryImage;
  viewport: ViewportSize;
  offset: number;
}) {
  const size = fittedSize(image, viewport);
  return (
    <div
      className="viewer-slide viewer-slide-neighbor"
      style={{ transform: `translate3d(${offset}px, 0, 0)` }}
      aria-hidden="true"
    >
      <div className="viewer-neighbor-frame" style={{ width: size.width, height: size.height }}>
        <img
          src={image.thumbnailUrl}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          fetchPriority="low"
        />
      </div>
    </div>
  );
}

function ViewerButton({
  label,
  onClick,
  className = "",
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`viewer-icon-button ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
