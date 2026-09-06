import type { CSSProperties, RefObject } from "preact";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GalleryImage } from "./types";

export const MAX_MASONRY_COLUMNS = 5;

export type MasonryMetrics = {
  width: number;
  columnCount: number;
  gap: number;
};

export function useMasonryMetrics(
  ref: RefObject<HTMLElement | null>,
  initialColumnCount: number,
  onBeforeChange?: () => void,
): MasonryMetrics & { measure: () => void } {
  const [metrics, setMetrics] = useState<MasonryMetrics>({
    width: 0,
    columnCount: Math.min(MAX_MASONRY_COLUMNS, Math.max(2, initialColumnCount)),
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
      const minimumCardWidth = 218;
      const declaredGap = Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--masonry-gap"),
      );
      const gap = Number.isFinite(declaredGap) ? declaredGap : 6;
      const next = Math.floor((width + gap) / (minimumCardWidth + gap));
      const roundedWidth = Math.round(width * 100) / 100;
      const columnCount = Math.min(MAX_MASONRY_COLUMNS, Math.max(2, next));
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

export function layoutMasonryImages<T extends Pick<GalleryImage, "width" | "height">>(
  images: T[],
  { width, columnCount, gap }: MasonryMetrics,
) {
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
}
