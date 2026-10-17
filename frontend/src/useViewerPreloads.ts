import { useEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";
import {
  canPreloadViewerNeighbors,
  getViewerOriginalAsset,
  getViewerViewportRenderAsset,
  prepareViewerImages,
  viewerNeighborOffsets,
} from "./viewerAssets";
import { selectViewerSourceStrategy, viewportRenderDimensions } from "./viewerLogic";

export function useViewerPreloads(
  images: GalleryImage[],
  activeIndex: number,
  viewport: { width: number; height: number },
  viewportBitmaps: boolean,
  originalReady: boolean,
): void {
  const ready = useRef(originalReady);
  ready.current = originalReady;
  const schedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    prepareViewerImages(images, activeIndex, { preloadOriginals: !viewportBitmaps });
    if (!viewportBitmaps) return;
    const offsets = viewerNeighborOffsets();
    const controller = new AbortController();
    const { signal } = controller;
    let pageActive = true;
    let generation = 0;
    const canRun = () => !signal.aborted && pageActive && canPreloadViewerNeighbors();
    const clear = () => {
      generation++;
    };
    const preload = async (scheduledGeneration: number) => {
      // The display owns the current original; prepare neighbors one at a time.
      for (const offset of offsets) {
        if (scheduledGeneration !== generation || !canRun()) return;
        const image = images[activeIndex + offset];
        if (!image || image.video) continue;
        const size = viewportRenderDimensions(image, viewport);
        const asset = selectViewerSourceStrategy(image, size, viewportBitmaps) === "viewport-upgrade"
          ? getViewerViewportRenderAsset(image, size.width, size.height, 0, "low")
          : getViewerOriginalAsset(image, 0, "low");
        if (asset.status === "loading") await asset.promise;
      }
    };
    const resume = () => {
      clear();
      if (!ready.current || !canRun()) return;
      void preload(generation);
    };
    schedule.current = resume;
    document.addEventListener("visibilitychange", resume, { signal });
    window.addEventListener("pagehide", () => { pageActive = false; clear(); }, { signal });
    window.addEventListener("pageshow", () => { pageActive = true; resume(); }, { signal });
    resume();
    return () => {
      controller.abort();
      clear();
      schedule.current = null;
    };
  }, [activeIndex, images, viewportBitmaps, viewport.height, viewport.width]);

  // This also resumes preloading after a successful retry of the current original.
  useEffect(() => { schedule.current?.(); }, [originalReady]);
}
