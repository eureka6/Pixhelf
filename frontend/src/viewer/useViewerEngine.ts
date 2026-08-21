import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

interface Motion extends Point {
  scale: number;
}

interface CanvasGeometry extends Point, Size {}

type VisualUpdate =
  | { kind: "motion"; motion: Motion }
  | { kind: "track"; motion: Motion };

type GestureMode = "idle" | "pending" | "navigation" | "dismiss" | "pan" | "pinch";

interface Gesture {
  mode: GestureMode;
  pointerId: number;
  pointerType: string;
  start: Point;
  last: Point;
  lastTime: number;
  velocity: Point;
  origin: Motion;
  pinchDistance: number;
  pinchMidpoint: Point;
  canvasCenter: Point;
  moved: boolean;
}

interface EngineOptions {
  imageId: string;
  frameSize: Size;
  maximumZoom: number;
  canPrevious: boolean;
  canNext: boolean;
  onNavigate: (direction: -1 | 1) => void;
  onEdge: (direction: -1 | 1) => void;
  onDismiss: () => void;
  onTap: (point: Point, pointerType: string) => void;
  onDragStart: () => void;
  onInteraction: () => void;
}

interface AnimateOptions {
  duration?: number;
  commitRaster?: boolean;
  onComplete?: () => void;
}

const EMPTY_GESTURE: Gesture = {
  mode: "idle",
  pointerId: -1,
  pointerType: "mouse",
  start: { x: 0, y: 0 },
  last: { x: 0, y: 0 },
  lastTime: 0,
  velocity: { x: 0, y: 0 },
  origin: { x: 0, y: 0, scale: 1 },
  pinchDistance: 0,
  pinchMidpoint: { x: 0, y: 0 },
  canvasCenter: { x: 0, y: 0 },
  moved: false,
};

const RASTER_PIXEL_BUDGET = 40_000_000;
const RASTER_EDGE_LIMIT = 8192;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function magnitude(point: Point): number {
  return Math.hypot(point.x, point.y);
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function resist(value: number, limit: number, factor = 0.2): number {
  if (value > limit) return limit + (value - limit) * factor;
  if (value < -limit) return -limit + (value + limit) * factor;
  return value;
}

function easeOutQuart(value: number): number {
  return 1 - (1 - value) ** 4;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useViewerEngine(options: EngineOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const canvasRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef(0);
  const trackAnimationRef = useRef(0);
  const inputFrameRef = useRef(0);
  const navigatingRef = useRef(false);
  const navigationUnlockRef = useRef(0);
  const rasterTimerRef = useRef(0);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture>({ ...EMPTY_GESTURE });
  const layoutImageRef = useRef(options.imageId);
  const currentRef = useRef<Motion>({ x: 0, y: 0, scale: 1 });
  const targetRef = useRef<Motion>({ x: 0, y: 0, scale: 1 });
  const trackMotionRef = useRef<Motion>({ x: 0, y: 0, scale: 1 });
  const queuedVisualRef = useRef<VisualUpdate | null>(null);
  const geometryRef = useRef<CanvasGeometry>({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const rasterScaleRef = useRef(1);
  const [settledScale, setSettledScale] = useState(1);
  const [interacting, setInteracting] = useState(false);

  const captureGeometry = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    geometryRef.current = {
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    };
  }, []);

  const pageSpan = useCallback(() => {
    const width = geometryRef.current.width;
    return width + (width <= 720 ? 12 : 28);
  }, []);

  const boundsFor = useCallback((scale: number) => {
    const { frameSize } = optionsRef.current;
    const { width, height } = geometryRef.current;
    return {
      x: Math.max(0, (frameSize.width * scale - width) / 2),
      y: Math.max(0, (frameSize.height * scale - height) / 2),
    };
  }, []);

  const constrain = useCallback((motion: Motion): Motion => {
    const maximumZoom = Math.max(1, optionsRef.current.maximumZoom);
    const scale = clamp(motion.scale, 1, maximumZoom);
    const bounds = boundsFor(scale);
    return {
      x: clamp(motion.x, -bounds.x, bounds.x),
      y: clamp(motion.y, -bounds.y, bounds.y),
      scale,
    };
  }, [boundsFor]);

  const applyMotion = useCallback((motion: Motion) => {
    const element = motionRef.current;
    if (!element) return;
    const rasterScale = rasterScaleRef.current;
    element.style.transform = `translate3d(${motion.x.toFixed(2)}px, ${motion.y.toFixed(2)}px, 0) scale(${(motion.scale / rasterScale).toFixed(4)})`;
    element.dataset.zoomed = String(motion.scale > 1.01);
  }, []);

  const commitRaster = useCallback((
    motion = currentRef.current,
    settle = true,
    displayedMotion = motion,
  ) => {
    const element = motionRef.current;
    if (!element) return;
    const { frameSize } = optionsRef.current;
    const density = clamp(window.devicePixelRatio || 1, 1, 3);
    const areaScale = Math.sqrt(
      RASTER_PIXEL_BUDGET /
      Math.max(frameSize.width * frameSize.height * density * density, 1),
    );
    const edgeScale = Math.min(
      RASTER_EDGE_LIMIT / Math.max(frameSize.width * density, 1),
      RASTER_EDGE_LIMIT / Math.max(frameSize.height * density, 1),
    );
    const maximumRasterScale = Math.max(1, Math.min(areaScale, edgeScale));
    const requestedRasterScale = motion.scale <= 1.01
      ? 1
      : Math.max(1, Math.min(motion.scale, maximumRasterScale));
    // Keep an already-promoted backing layer while zoomed. Dropping it on
    // every zoom-out makes the browser resample a smaller bitmap and can
    // soften the next quick pinch. The fit state still releases it.
    const rasterScale = motion.scale <= 1.01
      ? 1
      : Math.max(
        requestedRasterScale,
        Math.min(rasterScaleRef.current, maximumRasterScale),
      );
    rasterScaleRef.current = rasterScale;
    const snap = (value: number) => Math.round(value * density) / density;
    const width = snap(frameSize.width * rasterScale);
    const height = snap(frameSize.height * rasterScale);
    const left = snap((frameSize.width - width) / 2);
    const top = snap((frameSize.height - height) / 2);
    element.style.width = `${width.toFixed(2)}px`;
    element.style.height = `${height.toFixed(2)}px`;
    element.style.left = `${left.toFixed(2)}px`;
    element.style.top = `${top.toFixed(2)}px`;
    element.style.setProperty("--viewer-will-change", settle ? "auto" : "transform");
    element.dataset.scale = motion.scale.toFixed(4);
    element.dataset.rasterScale = rasterScale.toFixed(4);
    // A preheat can happen before an animation reaches its destination. Keep
    // the currently displayed transform while changing the backing layer so
    // promotion itself never causes a visible jump.
    applyMotion(displayedMotion);
    if (settle) setSettledScale(motion.scale);
  }, [applyMotion]);

  // Keep a little headroom in the backing layer while the user is zooming.
  // Rebuilding on every pointer event is expensive, so only promote it after
  // a meaningful scale increase. Zooming out can keep the larger layer and
  // therefore remains sharp without another allocation.
  const prepareRaster = useCallback((motion: Motion) => {
    const scale = Math.max(1, motion.scale);
    const currentRaster = rasterScaleRef.current;
    if (scale <= currentRaster * 1.25) return;
    commitRaster(constrain(motion), false, currentRef.current);
  }, [commitRaster, constrain]);

  const scheduleRaster = useCallback((delay = 100) => {
    window.clearTimeout(rasterTimerRef.current);
    rasterTimerRef.current = window.setTimeout(() => commitRaster(), delay);
  }, [commitRaster]);

  const stopImageAnimation = useCallback(() => {
    window.cancelAnimationFrame(animationRef.current);
    animationRef.current = 0;
    motionRef.current?.style.setProperty("--viewer-will-change", "auto");
  }, []);

  const setMotion = useCallback((motion: Motion) => {
    currentRef.current = motion;
    targetRef.current = motion;
    applyMotion(motion);
  }, [applyMotion]);

  const animateMotion = useCallback((destination: Motion, animation: AnimateOptions = {}) => {
    stopImageAnimation();
    window.clearTimeout(rasterTimerRef.current);
    const target = constrain(destination);
    prepareRaster(target);
    targetRef.current = target;
    const duration = reducedMotion() ? 0 : (animation.duration ?? 240);
    if (!duration) {
      setMotion(target);
      if (animation.commitRaster !== false) commitRaster(target);
      animation.onComplete?.();
      return;
    }

    motionRef.current?.style.setProperty("--viewer-will-change", "transform");
    const start = currentRef.current;
    const startedAt = performance.now();
    const tick = (time: number) => {
      const progress = clamp((time - startedAt) / duration, 0, 1);
      const eased = easeOutQuart(progress);
      const next = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        scale: start.scale + (target.scale - start.scale) * eased,
      };
      currentRef.current = next;
      applyMotion(next);
      if (progress < 1) {
        animationRef.current = window.requestAnimationFrame(tick);
        return;
      }
      animationRef.current = 0;
      currentRef.current = target;
      applyMotion(target);
      if (animation.commitRaster !== false) commitRaster(target);
      animation.onComplete?.();
    };
    animationRef.current = window.requestAnimationFrame(tick);
  }, [applyMotion, commitRaster, constrain, prepareRaster, setMotion, stopImageAnimation]);

  const applyTrack = useCallback((x: number, y = 0, scale = 1) => {
    const canvas = canvasRef.current;
    const progress = clamp(
      Math.max(0, y) / Math.max(geometryRef.current.height * 0.7, 1),
      0,
      1,
    );
    trackMotionRef.current = { x, y, scale };
    const track = trackRef.current;
    if (track) {
      track.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    }
    if (canvas) {
      canvas.style.setProperty("--viewer-dismiss-progress", progress.toFixed(4));
    }
  }, []);

  const flushVisual = useCallback(() => {
    window.cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = 0;
    const update = queuedVisualRef.current;
    queuedVisualRef.current = null;
    if (!update) return;
    if (update.kind === "motion") applyMotion(update.motion);
    else applyTrack(update.motion.x, update.motion.y, update.motion.scale);
  }, [applyMotion, applyTrack]);

  const queueVisual = useCallback((update: VisualUpdate) => {
    queuedVisualRef.current = update;
    if (inputFrameRef.current) return;
    inputFrameRef.current = window.requestAnimationFrame(() => {
      inputFrameRef.current = 0;
      const pending = queuedVisualRef.current;
      queuedVisualRef.current = null;
      if (!pending) return;
      if (pending.kind === "motion") applyMotion(pending.motion);
      else applyTrack(pending.motion.x, pending.motion.y, pending.motion.scale);
    });
  }, [applyMotion, applyTrack]);

  const stopTrackAnimation = useCallback(() => {
    window.cancelAnimationFrame(trackAnimationRef.current);
    trackAnimationRef.current = 0;
    trackRef.current?.style.setProperty("will-change", "auto");
  }, []);

  const animateTrack = useCallback((
    from: Point & { scale: number },
    to: Point & { scale: number },
    duration: number,
    onComplete?: () => void,
  ) => {
    stopTrackAnimation();
    trackRef.current?.style.setProperty("will-change", "transform");
    const actualDuration = reducedMotion() ? 0 : duration;
    if (!actualDuration) {
      applyTrack(to.x, to.y, to.scale);
      trackRef.current?.style.setProperty("will-change", "auto");
      onComplete?.();
      return;
    }
    const startedAt = performance.now();
    const tick = (time: number) => {
      const progress = clamp((time - startedAt) / actualDuration, 0, 1);
      const eased = easeOutQuart(progress);
      applyTrack(
        from.x + (to.x - from.x) * eased,
        from.y + (to.y - from.y) * eased,
        from.scale + (to.scale - from.scale) * eased,
      );
      if (progress < 1) {
        trackAnimationRef.current = window.requestAnimationFrame(tick);
        return;
      }
      trackAnimationRef.current = 0;
      trackRef.current?.style.setProperty("will-change", "auto");
      onComplete?.();
    };
    trackAnimationRef.current = window.requestAnimationFrame(tick);
  }, [applyTrack, stopTrackAnimation]);

  const zoomAround = useCallback((base: Motion, scale: number, point: Point): Motion => {
    const geometry = geometryRef.current;
    const center = {
      x: geometry.x + geometry.width / 2,
      y: geometry.y + geometry.height / 2,
    };
    const ratio = scale / Math.max(base.scale, 0.001);
    return constrain({
      x: point.x - center.x - (point.x - center.x - base.x) * ratio,
      y: point.y - center.y - (point.y - center.y - base.y) * ratio,
      scale,
    });
  }, [constrain]);

  const resetZoom = useCallback(() => {
    optionsRef.current.onInteraction();
    animateMotion({ x: 0, y: 0, scale: 1 }, { duration: 180 });
  }, [animateMotion]);

  const zoomTo = useCallback((scale: number, point?: Point) => {
    const maximum = Math.max(1, optionsRef.current.maximumZoom);
    const nextScale = clamp(scale, 1, maximum);
    const geometry = geometryRef.current;
    const anchor = point ?? {
      x: geometry.x + geometry.width / 2,
      y: geometry.y + geometry.height / 2,
    };
    optionsRef.current.onInteraction();
    animateMotion(zoomAround(currentRef.current, nextScale, anchor), { duration: 180 });
  }, [animateMotion, zoomAround]);

  const zoomBy = useCallback((factor: number) => {
    zoomTo(currentRef.current.scale * factor);
  }, [zoomTo]);

  const toggleZoomAt = useCallback((point: Point) => {
    if (currentRef.current.scale > 1.08) {
      resetZoom();
      return;
    }
    zoomTo(Math.min(4, Math.max(1, optionsRef.current.maximumZoom)), point);
  }, [resetZoom, zoomTo]);

  const completeNavigation = useCallback((direction: -1 | 1) => {
    const sourceId = optionsRef.current.imageId;
    optionsRef.current.onNavigate(direction);
    window.clearTimeout(navigationUnlockRef.current);
    navigationUnlockRef.current = window.setTimeout(() => {
      navigatingRef.current = false;
      if (optionsRef.current.imageId === sourceId) applyTrack(0, 0, 1);
    }, 500);
  }, [applyTrack]);

  const navigate = useCallback((direction: -1 | 1) => {
    if (navigatingRef.current) return false;
    const available = direction < 0 ? optionsRef.current.canPrevious : optionsRef.current.canNext;
    if (!available) {
      optionsRef.current.onEdge(direction);
      return false;
    }
    optionsRef.current.onDragStart();
    flushVisual();
    navigatingRef.current = true;
    const slide = () => {
      const destination = -direction * pageSpan();
      animateTrack(
        trackMotionRef.current,
        { x: destination, y: 0, scale: 1 },
        260,
        () => completeNavigation(direction),
      );
    };
    if (currentRef.current.scale > 1.01) {
      animateMotion(
        { x: 0, y: 0, scale: 1 },
        { duration: 160, onComplete: slide },
      );
    } else {
      stopImageAnimation();
      slide();
    }
    return true;
  }, [animateMotion, animateTrack, completeNavigation, flushVisual, pageSpan, stopImageAnimation]);

  const beginPinch = useCallback(() => {
    const pointers = [...pointersRef.current.values()];
    if (pointers.length < 2) return;
    const first = pointers[0];
    const second = pointers[1];
    const geometry = geometryRef.current;
    flushVisual();
    applyTrack(0, 0, 1);
    optionsRef.current.onDragStart();
    gestureRef.current = {
      ...EMPTY_GESTURE,
      mode: "pinch",
      origin: currentRef.current,
      pinchDistance: Math.max(1, distance(first, second)),
      pinchMidpoint: midpoint(first, second),
      canvasCenter: {
        x: geometry.x + geometry.width / 2,
        y: geometry.y + geometry.height / 2,
      },
      moved: true,
    };
    setInteracting(true);
  }, [applyTrack, flushVisual]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (navigatingRef.current) return;
    event.preventDefault();
    captureGeometry();
    flushVisual();
    stopImageAnimation();
    stopTrackAnimation();
    window.clearTimeout(rasterTimerRef.current);
    targetRef.current = currentRef.current;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and older WebViews may not expose pointer capture.
    }
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, { ...point });
    optionsRef.current.onInteraction();

    if (pointersRef.current.size >= 2) {
      beginPinch();
      return;
    }
    gestureRef.current = {
      ...EMPTY_GESTURE,
      mode: "pending",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      start: { ...point },
      last: { ...point },
      lastTime: performance.now(),
      origin: currentRef.current,
    };
  }, [beginPinch, captureGeometry, flushVisual, stopImageAnimation, stopTrackAnimation]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const tracked = pointersRef.current.get(event.pointerId);
    if (!tracked) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const gesture = gestureRef.current;

    if (gesture.mode === "pinch") {
      const pointers = [...pointersRef.current.values()];
      if (pointers.length < 2) return;
      const first = pointers[0];
      const second = pointers[1];
      const midpointNow = midpoint(first, second);
      const rawScale = gesture.origin.scale *
        (distance(first, second) / Math.max(gesture.pinchDistance, 1));
      const maximum = Math.max(1, optionsRef.current.maximumZoom);
      const scale = rawScale < 1
        ? 1 - (1 - rawScale) * 0.22
        : rawScale > maximum
          ? maximum + (rawScale - maximum) * 0.16
          : rawScale;
      const center = gesture.canvasCenter;
      const local = {
        x: (gesture.pinchMidpoint.x - center.x - gesture.origin.x) / gesture.origin.scale,
        y: (gesture.pinchMidpoint.y - center.y - gesture.origin.y) / gesture.origin.scale,
      };
      const next = {
        x: midpointNow.x - center.x - local.x * scale,
        y: midpointNow.y - center.y - local.y * scale,
        scale,
      };
      currentRef.current = next;
      targetRef.current = next;
      prepareRaster(next);
      motionRef.current?.style.setProperty("--viewer-will-change", "transform");
      queueVisual({ kind: "motion", motion: next });
      return;
    }

    if (gesture.pointerId !== event.pointerId || gesture.mode === "idle") return;
    const point = { x: event.clientX, y: event.clientY };
    const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
    const now = performance.now();
    const elapsed = Math.max(1, now - gesture.lastTime);
    gesture.velocity = {
      x: gesture.velocity.x * 0.62 + ((point.x - gesture.last.x) / elapsed) * 0.38,
      y: gesture.velocity.y * 0.62 + ((point.y - gesture.last.y) / elapsed) * 0.38,
    };
    gesture.last = point;
    gesture.lastTime = now;

    if (gesture.mode === "pending" && magnitude(delta) >= (gesture.pointerType === "mouse" ? 5 : 9)) {
      gesture.moved = true;
      optionsRef.current.onDragStart();
      setInteracting(true);
      if (gesture.origin.scale > 1.01) gesture.mode = "pan";
      else if (Math.abs(delta.x) > Math.abs(delta.y) * 1.08) gesture.mode = "navigation";
      else if (gesture.pointerType === "mouse") gesture.mode = "idle";
      else gesture.mode = "dismiss";
    }

    if (gesture.mode === "navigation") {
      let x = delta.x;
      if ((x > 0 && !optionsRef.current.canPrevious) || (x < 0 && !optionsRef.current.canNext)) {
        x *= 0.22;
      }
      queueVisual({ kind: "track", motion: { x, y: 0, scale: 1 } });
      return;
    }

    if (gesture.mode === "dismiss") {
      const y = delta.y >= 0 ? delta.y * 0.94 : delta.y * 0.16;
      const progress = clamp(Math.max(0, y) / Math.max(geometryRef.current.height * 0.7, 1), 0, 1);
      queueVisual({
        kind: "track",
        motion: { x: delta.x * 0.08, y, scale: 1 - progress * 0.055 },
      });
      return;
    }

    if (gesture.mode === "pan") {
      const scale = gesture.origin.scale;
      const bounds = boundsFor(scale);
      const next = {
        x: resist(gesture.origin.x + delta.x, bounds.x),
        y: resist(gesture.origin.y + delta.y, bounds.y),
        scale,
      };
      currentRef.current = next;
      targetRef.current = next;
      motionRef.current?.style.setProperty("--viewer-will-change", "transform");
      queueVisual({ kind: "motion", motion: next });
    }
  }, [boundsFor, prepareRaster, queueVisual]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    const tracked = pointersRef.current.has(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (!tracked) return;
    flushVisual();

    if (gesture.mode === "pinch") {
      const remaining = [...pointersRef.current.entries()];
      if (remaining.length === 1) {
        window.clearTimeout(rasterTimerRef.current);
        const [pointerId, point] = remaining[0];
        gestureRef.current = {
          ...EMPTY_GESTURE,
          mode: "pan",
          pointerId,
          pointerType: "touch",
          start: { ...point },
          last: { ...point },
          lastTime: performance.now(),
          origin: currentRef.current,
          moved: true,
        };
        return;
      }
      const target = constrain(currentRef.current);
      animateMotion(target, { duration: 220 });
      gestureRef.current = { ...EMPTY_GESTURE };
      setInteracting(false);
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    const endPoint = cancelled
      ? gesture.last
      : { x: event.clientX, y: event.clientY };
    const delta = {
      x: endPoint.x - gesture.start.x,
      y: endPoint.y - gesture.start.y,
    };
    const displayedTrack = trackMotionRef.current;
    let keepInteracting = false;
    if (cancelled && gesture.mode === "pan") {
      animateMotion(constrain(currentRef.current), { duration: 180 });
    } else if (cancelled) {
      animateTrack(displayedTrack, { x: 0, y: 0, scale: 1 }, 180);
    } else if (gesture.mode === "navigation") {
      const width = geometryRef.current.width;
      const direction: -1 | 1 = delta.x > 0 ? -1 : 1;
      const available = direction < 0 ? optionsRef.current.canPrevious : optionsRef.current.canNext;
      const commit = available &&
        (Math.abs(delta.x) > Math.min(120, width * 0.2) || Math.abs(gesture.velocity.x) > 0.55);
      if (commit) {
        navigatingRef.current = true;
        const destination = -direction * pageSpan();
        animateTrack(
          displayedTrack,
          { x: destination, y: 0, scale: 1 },
          230,
          () => completeNavigation(direction),
        );
      } else {
        if (!available) optionsRef.current.onEdge(direction);
        animateTrack(displayedTrack, { x: 0, y: 0, scale: 1 }, 210);
      }
    } else if (gesture.mode === "dismiss") {
      const height = geometryRef.current.height;
      const commit = delta.y > Math.min(150, height * 0.18) ||
        (delta.y > 50 && gesture.velocity.y > 0.65);
      if (commit) {
        navigatingRef.current = true;
        keepInteracting = true;
        animateTrack(
          displayedTrack,
          { x: delta.x * 0.12, y: height * 1.08, scale: 0.92 },
          240,
          optionsRef.current.onDismiss,
        );
      } else {
        animateTrack(
          displayedTrack,
          { x: 0, y: 0, scale: 1 },
          220,
        );
      }
    } else if (gesture.mode === "pan") {
      const inertial = {
        x: currentRef.current.x + clamp(gesture.velocity.x * 130, -180, 180),
        y: currentRef.current.y + clamp(gesture.velocity.y * 130, -180, 180),
        scale: currentRef.current.scale,
      };
      animateMotion(constrain(inertial), { duration: 260 });
    } else if (gesture.mode === "pending" && !gesture.moved) {
      optionsRef.current.onTap(endPoint, gesture.pointerType);
    }

    gestureRef.current = { ...EMPTY_GESTURE };
    if (!keepInteracting) setInteracting(false);
  }, [animateMotion, animateTrack, completeNavigation, constrain, flushVisual, pageSpan]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (optionsRef.current.maximumZoom <= 1.01) return;
      optionsRef.current.onInteraction();
      stopImageAnimation();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 18
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * geometryRef.current.height
          : event.deltaY;
      targetRef.current = currentRef.current;
      const base = currentRef.current;
      const scale = clamp(
        base.scale * Math.exp(-delta * 0.00135),
        1,
        Math.max(1, optionsRef.current.maximumZoom),
      );
      const target = zoomAround(base, scale, { x: event.clientX, y: event.clientY });
      const motionReduced = reducedMotion();
      animateMotion(target, { duration: 90, commitRaster: motionReduced });
      if (!motionReduced) scheduleRaster(120);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [animateMotion, scheduleRaster, stopImageAnimation, zoomAround]);

  useEffect(() => {
    const update = () => captureGeometry();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [captureGeometry]);

  useLayoutEffect(() => {
    captureGeometry();
    flushVisual();
    stopImageAnimation();
    stopTrackAnimation();
    window.clearTimeout(rasterTimerRef.current);
    window.clearTimeout(navigationUnlockRef.current);
    pointersRef.current.clear();
    gestureRef.current = { ...EMPTY_GESTURE };
    if (layoutImageRef.current !== options.imageId) {
      layoutImageRef.current = options.imageId;
      currentRef.current = { x: 0, y: 0, scale: 1 };
      targetRef.current = { x: 0, y: 0, scale: 1 };
      rasterScaleRef.current = 1;
    } else {
      const motion = constrain(currentRef.current);
      currentRef.current = motion;
      targetRef.current = motion;
    }
    navigatingRef.current = false;
    applyTrack(0, 0, 1);
    commitRaster(currentRef.current);
    setInteracting(false);
  }, [options.imageId, options.frameSize.height, options.frameSize.width, applyTrack, captureGeometry, commitRaster, constrain, flushVisual, stopImageAnimation, stopTrackAnimation]);

  useEffect(() => {
    if (currentRef.current.scale <= options.maximumZoom + 0.001) return;
    animateMotion(constrain(currentRef.current));
  }, [options.maximumZoom, animateMotion, constrain]);

  useEffect(() => () => {
    window.cancelAnimationFrame(animationRef.current);
    window.cancelAnimationFrame(trackAnimationRef.current);
    window.cancelAnimationFrame(inputFrameRef.current);
    window.clearTimeout(rasterTimerRef.current);
    window.clearTimeout(navigationUnlockRef.current);
  }, []);

  return {
    canvasRef,
    trackRef,
    motionRef,
    settledScale,
    interacting,
    canZoom: options.maximumZoom > 1.01,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, false),
    handlePointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, true),
    handleLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, true),
    navigate,
    resetZoom,
    toggleZoomAt,
    zoomBy,
  };
}

export type ViewerEngine = ReturnType<typeof useViewerEngine>;
export type ViewerElementRef = RefObject<HTMLDivElement | null>;
