import { useLayoutEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";
import { prepareViewerImages, releaseViewerAssets, suspendViewerPreloads } from "./viewerAssets";

export function useViewerAssetLifecycle(images: GalleryImage[], activeIndex: number): void {
  const latest = useRef({ images, activeIndex });
  latest.current = { images, activeIndex };
  const active = activeIndex >= 0;

  // Own assets for the whole viewer session, including photo/video transitions.
  useLayoutEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const { signal } = controller;
    const suspend = () => {
      const { images, activeIndex } = latest.current;
      const current = images[activeIndex];
      if (current) suspendViewerPreloads(current);
    };
    const update = () => {
      if (document.visibilityState !== "visible") { suspend(); return; }
      const { images, activeIndex } = latest.current;
      prepareViewerImages(images, activeIndex, {
        preloadOriginals: images[activeIndex]?.video ? false : undefined,
      });
    };
    document.addEventListener("visibilitychange", update, { signal });
    window.addEventListener("pagehide", suspend, { signal });
    window.addEventListener("pageshow", update, { signal });
    if (document.visibilityState !== "visible") suspend();
    return () => {
      controller.abort();
      releaseViewerAssets();
    };
  }, [active]);
}
