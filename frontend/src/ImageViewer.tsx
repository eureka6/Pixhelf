import type { CSSProperties, JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  Maximize2,
  Minus,
  Minimize2,
  Plus,
  RefreshCw,
  X,
} from "./icons";
import type { GalleryImage } from "./types";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_DELAY_MS = 280;
const ORIGINAL_PRELOAD_LIMIT = 6;
const SECOND_NEIGHBOR_PRELOAD_DELAY_MS = 500;
const MAX_RENDER_EDGE = 4096;

type ViewerTransform = {
  scale: number;
  x: number;
  y: number;
};

type PointerPoint = {
  x: number;
  y: number;
};

type GestureStart = {
  point: PointerPoint;
  transform: ViewerTransform;
  startedAt: number;
  pointerType: string;
};

type PinchStart = {
  distance: number;
  midpoint: PointerPoint;
  transform: ViewerTransform;
};

type OriginalLoadState = {
  id: string;
  attempt: number;
  loaded: boolean;
  failed: boolean;
};

type NetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
};

type ViewportSize = {
  width: number;
  height: number;
};

type GestureHandlers = {
  begin: (id: number, point: PointerPoint, pointerType: string) => void;
  move: (id: number, point: PointerPoint) => void;
  finish: (id: number, point: PointerPoint, pointerType: string) => void;
  cancel: () => void;
};

const DEFAULT_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };
const originalPreloads = new Map<string, HTMLImageElement>();

function readViewportSize(): ViewportSize {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function useViewportSize(): ViewportSize {
  const [size, setSize] = useState(readViewportSize);
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setSize(readViewportSize());
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    viewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      viewport?.removeEventListener("resize", schedule);
    };
  }, []);
  return size;
}

function thumbnailUrl(image: GalleryImage): string {
  return `/api/images/${encodeURIComponent(image.id)}/thumbnail`;
}

function originalUrl(image: GalleryImage, attempt = 0): string {
  const url = `/api/images/${encodeURIComponent(image.id)}/original`;
  return attempt ? `${url}?retry=${attempt}` : url;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pointDistance(first: PointerPoint, second: PointerPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointMidpoint(first: PointerPoint, second: PointerPoint): PointerPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function rubberBand(distance: number, limit: number): number {
  if (!distance) return 0;
  return Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) / limit));
}

function shouldPreloadViewerImages(): boolean {
  if (document.visibilityState !== "visible") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (connection?.saveData) return false;
  return connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

export function preloadOriginalImage(image: GalleryImage): void {
  if (!shouldPreloadViewerImages()) return;
  const url = originalUrl(image);
  if (originalPreloads.has(url)) return;

  const loader = new Image();
  loader.decoding = "async";
  loader.fetchPriority = "low";
  loader.src = url;
  originalPreloads.set(url, loader);

  while (originalPreloads.size > ORIGINAL_PRELOAD_LIMIT) {
    const oldestUrl = originalPreloads.keys().next().value as string | undefined;
    if (!oldestUrl) break;
    const oldest = originalPreloads.get(oldestUrl);
    if (oldest && !oldest.complete) oldest.src = "";
    originalPreloads.delete(oldestUrl);
  }
}

export function ImageViewer({
  images,
  activeIndex,
  total,
  hasMore,
  loadingMore,
  onNavigate,
  onClose,
}: {
  images: GalleryImage[];
  activeIndex: number;
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onNavigate: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  const image = images[activeIndex]!;
  const viewport = useViewportSize();
  const canPrevious = activeIndex > 0;
  const canNext = activeIndex < images.length - 1 || hasMore;
  const waitingForNext = loadingMore && activeIndex === images.length - 1;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const gestureStartRef = useRef<GestureStart | null>(null);
  const pinchStartRef = useRef<PinchStart | null>(null);
  const gestureAxisRef = useRef<"x" | "y" | null>(null);
  const pinchedRef = useRef(false);
  const lastTapRef = useRef<{ at: number; point: PointerPoint } | null>(null);
  const lastTouchAtRef = useRef(0);
  const gestureHandlersRef = useRef<GestureHandlers | null>(null);
  const retryTimerRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(
    () => typeof document !== "undefined"
      && document.fullscreenEnabled
      && "requestFullscreen" in HTMLElement.prototype,
  );
  const [transform, setTransform] = useState<ViewerTransform>(DEFAULT_TRANSFORM);
  const transformRef = useRef<ViewerTransform>(DEFAULT_TRANSFORM);
  const [nativeFallbackId, setNativeFallbackId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<OriginalLoadState>({
    id: image.id,
    attempt: 0,
    loaded: false,
    failed: false,
  });
  const currentLoadState = loadState.id === image.id
    ? loadState
    : { id: image.id, attempt: 0, loaded: false, failed: false };
  const fullSource = originalUrl(image, currentLoadState.attempt);
  const useBitmapRenderer = typeof createImageBitmap === "function"
    && nativeFallbackId !== image.id;

  const commitTransform = (next: ViewerTransform) => {
    transformRef.current = next;
    setTransform(next);
  };

  const constrainTransform = (next: ViewerTransform): ViewerTransform => {
    const scale = clamp(next.scale, MIN_SCALE, MAX_SCALE);
    if (scale <= MIN_SCALE) return DEFAULT_TRANSFORM;

    const surface = surfaceRef.current;
    const media = mediaRef.current;
    if (!surface || !media) return { scale, x: next.x, y: next.y };
    const maximumX = Math.max(0, (media.offsetWidth * scale - surface.clientWidth) / 2);
    const maximumY = Math.max(0, (media.offsetHeight * scale - surface.clientHeight) / 2);
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

  useLayoutEffect(() => {
    window.clearTimeout(retryTimerRef.current);
    pointersRef.current.clear();
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    gestureAxisRef.current = null;
    pinchedRef.current = false;
    lastTapRef.current = null;
    setNativeFallbackId(null);
    setDragging(false);
    commitTransform(DEFAULT_TRANSFORM);
    setLoadState({ id: image.id, attempt: 0, loaded: false, failed: false });
  }, [image.id]);

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
            onNavigate(-1);
          }
          break;
        case "ArrowRight":
          if (canNext) {
            event.preventDefault();
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
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canNext, canPrevious, onClose, onNavigate]);

  useEffect(() => {
    if (!shouldPreloadViewerImages()) return;
    const next = images[activeIndex + 1];
    const previous = images[activeIndex - 1];
    if (next) preloadOriginalImage(next);
    if (previous) preloadOriginalImage(previous);

    if (!currentLoadState.loaded) return;
    const timer = window.setTimeout(() => {
      const secondNext = images[activeIndex + 2];
      if (secondNext) preloadOriginalImage(secondNext);
    }, SECOND_NEIGHBOR_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, currentLoadState.loaded, images]);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  const handleOriginalError = () => {
    if (currentLoadState.attempt === 0) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        setLoadState({ id: image.id, attempt: 1, loaded: false, failed: false });
      }, 900);
      return;
    }
    setLoadState({
      id: image.id,
      attempt: currentLoadState.attempt,
      loaded: false,
      failed: true,
    });
  };

  const retryOriginal = () => {
    window.clearTimeout(retryTimerRef.current);
    setLoadState({
      id: image.id,
      attempt: currentLoadState.attempt + 1,
      loaded: false,
      failed: false,
    });
  };

  useEffect(() => {
    if (!useBitmapRenderer) return;
    const controller = new AbortController();
    let bitmap: ImageBitmap | null = null;
    let disposed = false;

    const renderOriginal = async () => {
      try {
        const response = await fetch(fullSource, {
          signal: controller.signal,
          cache: currentLoadState.attempt ? "reload" : "force-cache",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(`original request failed: ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("original response is empty");

        const sourceScale = Math.min(
          1,
          MAX_RENDER_EDGE / Math.max(1, image.width, image.height),
        );
        const resizeWidth = Math.max(1, Math.round(image.width * sourceScale));
        const resizeHeight = Math.max(1, Math.round(image.height * sourceScale));
        try {
          bitmap = await createImageBitmap(blob, {
            imageOrientation: "from-image",
            resizeWidth,
            resizeHeight,
            resizeQuality: "high",
          });
        } catch {
          try {
            // Some WebKit versions decode the format but reject resize options.
            bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
          } catch {
            // The native image element remains a compatibility fallback for browsers
            // whose createImageBitmap implementation supports fewer image variants.
            if (!disposed) setNativeFallbackId(image.id);
            return;
          }
        }
        if (disposed) {
          bitmap.close();
          bitmap = null;
          return;
        }

        const bitmapScale = Math.min(
          1,
          MAX_RENDER_EDGE / Math.max(1, bitmap.width, bitmap.height),
        );
        const renderWidth = Math.max(1, Math.round(bitmap.width * bitmapScale));
        const renderHeight = Math.max(1, Math.round(bitmap.height * bitmapScale));
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: true });
        if (!canvas || !context) throw new Error("canvas renderer is unavailable");
        canvas.width = renderWidth;
        canvas.height = renderHeight;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.clearRect(0, 0, renderWidth, renderHeight);
        context.drawImage(bitmap, 0, 0, renderWidth, renderHeight);
        bitmap.close();
        bitmap = null;

        window.clearTimeout(retryTimerRef.current);
        setLoadState({
          id: image.id,
          attempt: currentLoadState.attempt,
          loaded: true,
          failed: false,
        });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        console.warn("Pixhelf could not render the original image", error);
        handleOriginalError();
      }
    };

    void renderOriginal();
    return () => {
      disposed = true;
      controller.abort();
      bitmap?.close();
    };
  }, [fullSource, image.id, image.width, image.height, useBitmapRenderer]);

  const beginContact = (id: number, point: PointerPoint, pointerType: string) => {
    if (pointerType !== "mouse") lastTouchAtRef.current = performance.now();
    pointersRef.current.set(id, point);
    setDragging(true);

    if (pointersRef.current.size === 1) {
      gestureStartRef.current = {
        point,
        transform: transformRef.current,
        startedAt: performance.now(),
        pointerType,
      };
      gestureAxisRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      pinchedRef.current = true;
      lastTapRef.current = null;
      pinchStartRef.current = {
        distance: Math.max(1, pointDistance(first, second)),
        midpoint: pointMidpoint(first, second),
        transform: transformRef.current,
      };
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
      const surface = surfaceRef.current;
      if (!surface) return;
      const bounds = surface.getBoundingClientRect();
      const center = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
      const imagePoint = {
        x: (start.midpoint.x - center.x - start.transform.x) / start.transform.scale,
        y: (start.midpoint.y - center.y - start.transform.y) / start.transform.scale,
      };
      commitTransform(constrainTransform({
        scale,
        x: midpoint.x - center.x - imagePoint.x * scale,
        y: midpoint.y - center.y - imagePoint.y * scale,
      }));
      return;
    }

    const start = gestureStartRef.current;
    if (!start || pointersRef.current.size !== 1) return;
    const deltaX = point.x - start.point.x;
    const deltaY = point.y - start.point.y;
    if (!gestureAxisRef.current && Math.hypot(deltaX, deltaY) > 7) {
      gestureAxisRef.current = Math.abs(deltaX) >= Math.abs(deltaY) ? "x" : "y";
    }

    if (start.transform.scale > MIN_SCALE) {
      commitTransform(constrainTransform({
        ...start.transform,
        x: start.transform.x + deltaX,
        y: start.transform.y + deltaY,
      }));
      return;
    }

    const surface = surfaceRef.current;
    if (gestureAxisRef.current === "x") {
      commitTransform({
        scale: 1,
        x: rubberBand(deltaX, Math.max(90, (surface?.clientWidth ?? 360) * 0.32)),
        y: 0,
      });
    } else if (gestureAxisRef.current === "y") {
      commitTransform({
        scale: 1,
        x: 0,
        y: rubberBand(deltaY, Math.max(80, (surface?.clientHeight ?? 640) * 0.2)),
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
    const pointerCount = pointersRef.current.size;
    pointersRef.current.delete(id);

    if (pointerCount > 1) {
      const remaining = pointersRef.current.values().next().value as PointerPoint | undefined;
      pinchStartRef.current = null;
      if (remaining) {
        gestureStartRef.current = {
          point: remaining,
          transform: transformRef.current,
          startedAt: performance.now(),
          pointerType,
        };
      }
      return;
    }

    setDragging(false);
    const start = gestureStartRef.current;
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    const wasPinched = pinchedRef.current;
    pinchedRef.current = false;
    if (wasPinched) {
      commitTransform(constrainTransform(transformRef.current));
      return;
    }
    if (!start) return;

    const deltaX = point.x - start.point.x;
    const deltaY = point.y - start.point.y;
    const elapsed = Math.max(1, performance.now() - start.startedAt);
    const isTap = Math.hypot(deltaX, deltaY) < 10 && elapsed < 320;

    if (start.transform.scale > MIN_SCALE) {
      if (isTap && start.pointerType !== "mouse") {
        handleTouchTap(point);
        return;
      }
      commitTransform(constrainTransform(transformRef.current));
      return;
    }

    const surface = surfaceRef.current;
    const horizontalThreshold = Math.max(54, (surface?.clientWidth ?? 360) * 0.11);
    const horizontalFlick = Math.abs(deltaX) > 30 && Math.abs(deltaX) / elapsed > 0.48;
    const verticalThreshold = Math.max(84, (surface?.clientHeight ?? 640) * 0.12);
    const verticalFlick = deltaY > 38 && deltaY / elapsed > 0.52;

    if (
      gestureAxisRef.current === "x" &&
      Math.abs(deltaX) > Math.abs(deltaY) &&
      (Math.abs(deltaX) >= horizontalThreshold || horizontalFlick)
    ) {
      if (deltaX < 0 && canNext) {
        commitTransform(DEFAULT_TRANSFORM);
        onNavigate(1);
        return;
      }
      if (deltaX > 0 && canPrevious) {
        commitTransform(DEFAULT_TRANSFORM);
        onNavigate(-1);
        return;
      }
    }
    if (
      gestureAxisRef.current === "y" &&
      deltaY > Math.abs(deltaX) &&
      (deltaY >= verticalThreshold || verticalFlick)
    ) {
      onClose();
      return;
    }

    commitTransform(DEFAULT_TRANSFORM);
    if (isTap && start.pointerType !== "mouse") {
      handleTouchTap(point);
    }
  };

  const cancelContacts = () => {
    pointersRef.current.clear();
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    gestureAxisRef.current = null;
    pinchedRef.current = false;
    setDragging(false);
    commitTransform(constrainTransform(transformRef.current));
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

  const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    zoomAt(transformRef.current.scale * factor, { x: event.clientX, y: event.clientY });
  };

  const displayPosition = Math.min(total, activeIndex + 1);
  const zoomPercent = Math.round(transform.scale * 100);
  const viewerStyle = {
    "--viewer-dismiss-progress": String(
      transform.scale === 1
        ? clamp(Math.max(0, transform.y) / Math.max(1, surfaceRef.current?.clientHeight ?? 640), 0, 0.45)
        : 0,
    ),
  } as CSSProperties;
  const compactViewport = viewport.width <= 720;
  const availableWidth = Math.max(1, viewport.width - (compactViewport ? 12 : 144));
  const availableHeight = Math.max(1, viewport.height - (compactViewport ? 66 : 82));
  const imageRatio = image.width / Math.max(1, image.height);
  const mediaWidth = Math.min(availableWidth, availableHeight * imageRatio);
  const mediaHeight = mediaWidth / imageRatio;
  const mediaStyle = {
    width: `${mediaWidth}px`,
    height: `${mediaHeight}px`,
    aspectRatio: `${image.width} / ${image.height}`,
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
  } as CSSProperties;
  const viewer = (
    <div
      ref={dialogRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-viewer-title"
      data-full-loaded={currentLoadState.loaded}
      data-full-failed={currentLoadState.failed}
      data-zoomed={transform.scale > MIN_SCALE}
      data-dragging={dragging}
      data-renderer={useBitmapRenderer ? "bitmap" : "native"}
      style={viewerStyle}
    >
      <div className="viewer-backdrop" aria-hidden="true" />

      <header className="viewer-header">
        <div className="viewer-heading">
          <strong id="image-viewer-title" title={image.name}>{image.name}</strong>
          <span>
            {image.width} × {image.height}
            <i aria-hidden="true" />
            {displayPosition} / {total}
          </span>
        </div>
        <div className="viewer-header-actions">
          <a
            className="viewer-control"
            href={originalUrl(image)}
            download={image.name}
            aria-label="下载原图"
            title="下载原图"
          >
            <Download size={19} />
          </a>
          {fullscreenAvailable && (
            <button
              type="button"
              className="viewer-control viewer-fullscreen"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "退出全屏" : "进入全屏"}
              title={fullscreen ? "退出全屏" : "全屏查看"}
            >
              {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
            </button>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="viewer-control viewer-close"
            onClick={onClose}
            aria-label="关闭查看器"
            title="关闭 (Esc)"
          >
            <X size={21} />
          </button>
        </div>
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
          <div ref={mediaRef} className="viewer-media" style={mediaStyle}>
            <img
              className="viewer-thumbnail"
              src={thumbnailUrl(image)}
              width={image.width}
              height={image.height}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            {useBitmapRenderer ? (
              <canvas
                ref={canvasRef}
                key={fullSource}
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
                onLoad={() => {
                  window.clearTimeout(retryTimerRef.current);
                  setLoadState({
                    id: image.id,
                    attempt: currentLoadState.attempt,
                    loaded: true,
                    failed: false,
                  });
                }}
                onError={handleOriginalError}
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
        <ChevronLeft size={27} />
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
          : <ChevronRight size={27} />}
      </button>

      <div className="viewer-bottom-bar">
        <div className="viewer-zoom-controls" role="group" aria-label="缩放控制">
          <button
            type="button"
            className="viewer-control"
            onClick={() => zoomBy(-0.5)}
            disabled={transform.scale <= MIN_SCALE}
            aria-label="缩小"
            title="缩小 (-)"
          >
            <Minus size={18} />
          </button>
          <button
            type="button"
            className="viewer-zoom-value"
            onClick={() => commitTransform(DEFAULT_TRANSFORM)}
            disabled={transform.scale <= MIN_SCALE}
            aria-label={`当前缩放 ${zoomPercent}%，点击适应屏幕`}
            title="适应屏幕 (0)"
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="viewer-control"
            onClick={() => zoomBy(0.5)}
            disabled={transform.scale >= MAX_SCALE}
            aria-label="放大"
            title="放大 (+)"
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      {currentLoadState.failed && (
        <button type="button" className="viewer-load-error" onClick={retryOriginal}>
          <RefreshCw size={15} />
          <span>原图加载失败，点击重试</span>
        </button>
      )}
    </div>
  );

  return createPortal(viewer, document.body);
}
