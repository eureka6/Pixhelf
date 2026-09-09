import type { RefObject } from "preact";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

export type GalleryMetrics = {
  width: number;
  gap: number;
};

export function useGalleryMetrics(
  ref: RefObject<HTMLElement | null>,
  onBeforeChange?: () => void,
): GalleryMetrics & { measure: () => void } {
  const [metrics, setMetrics] = useState<GalleryMetrics>({
    width: 0,
    gap: 6,
  });
  const metricsRef = useRef(metrics);
  const measureRef = useRef<(() => void) | null>(null);
  const measure = useCallback(() => measureRef.current?.(), []);
  const beforeChangeRef = useRef(onBeforeChange);
  beforeChangeRef.current = onBeforeChange;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let pendingWidth = element.clientWidth;
    const update = (width: number) => {
      if (width <= 0) return;
      const declaredGap = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--gallery-gap"),
      );
      const gap = Number.isFinite(declaredGap) ? declaredGap : 6;
      const roundedWidth = Math.round(width * 100) / 100;
      const current = metricsRef.current;
      if (
        current.width === roundedWidth
        && current.gap === gap
      ) return;
      if (current.width > 0) beforeChangeRef.current?.();
      const nextMetrics = { width: roundedWidth, gap };
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

    measureRef.current = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      update(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(([entry]) => schedule(entry.contentRect.width));
    observer.observe(element);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      measureRef.current = null;
      observer.disconnect();
    };
  }, [measure, ref]);
  return useMemo(() => ({ ...metrics, measure }), [measure, metrics]);
}
