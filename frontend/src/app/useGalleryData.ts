import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getGallery, getImages, getStatus, takeInitialBootstrap } from "../api";
import { appendUniqueImages } from "../galleryImages";
import type { GalleryLocation } from "../galleryLocation";
import type { GalleryImage, GallerySummary, ImageFilters, ThumbnailStatus } from "../types";
import { useDebounced } from "../hooks/useDebounced";
import { errorMessage } from "./errors";
import { startVisiblePolling } from "./visiblePolling";

const PAGE_SIZE = 60;
const GALLERY_POLL_INTERVAL_MS = 10_000;
const INITIAL_BOOTSTRAP = takeInitialBootstrap();

type ImagePageState = {
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

const EMPTY_IMAGE_PAGE: ImagePageState = {
  images: [],
  total: 0,
  nextOffset: null,
};

function hasLibraryImages(location: GalleryLocation): boolean {
  return location.section === "library" || location.section === "favorites"
    || (location.section === "albums" && Boolean(location.path));
}

function backgroundJobsComplete(status: ThumbnailStatus): boolean {
  return status.backgroundComplete && status.textSearch.backgroundComplete
    && (!status.videos || (status.videos.playback.backgroundComplete && status.videos.preview.backgroundComplete));
}

// Owns bootstrap, polling and library pagination. Navigation can invalidate a page
// synchronously, before effects run, so old load-more callbacks cannot append to it.
export function useGalleryData(location: GalleryLocation, search: string, imageFilters: ImageFilters, exploreSeed: string) {
  const { section, path } = location;
  const album = section === "albums" ? path : "";
  const browsingFavorites = section === "favorites";
  const enabled = hasLibraryImages(location);
  const [reloadToken, setReloadToken] = useState(0);
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
  const [loading, setLoading] = useState(!hasInitialImages && enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => () => {
    requestVersionRef.current += 1;
    loadMoreControllerRef.current?.abort();
  }, []);

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

  useEffect(() => startVisiblePolling(async signal => {
    const next = await getGallery(signal);
    if (signal.aborted) return GALLERY_POLL_INTERVAL_MS;
    const previousRevision = summaryRevisionRef.current;
    if (previousRevision !== next.revision) {
      summaryRevisionRef.current = next.revision;
      setSummary(next);
      if (previousRevision) setReloadToken((value) => value + 1);
    }
    return GALLERY_POLL_INTERVAL_MS;
  }, GALLERY_POLL_INTERVAL_MS), []);

  useEffect(() => {
    const initialDelay = INITIAL_BOOTSTRAP
      ? (backgroundJobsComplete(INITIAL_BOOTSTRAP.status) ? 10_000 : 1_500)
      : 0;
    return startVisiblePolling(async signal => {
      const next = await getStatus(signal);
      if (!signal.aborted) setStatus(next);
      return backgroundJobsComplete(next) ? 10_000 : 1_500;
    }, initialDelay);
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
    if (!enabled) {
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
  }, [enabled, location, requestImages, reloadToken, textSearchReady, setImagePage]);

  const loadMoreLibrary = useCallback((): Promise<GalleryImage[]> => {
    if (imagePageRef.current !== imagePage) return Promise.resolve([]);
    const offset = imagePage.nextOffset;
    if (!enabled || loading || offset === null) return Promise.resolve([]);
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
  }, [enabled, location, requestImages, loading, imagePage, setImagePage]);
  const reloadGallery = useCallback(() => setReloadToken(value => value + 1), []);
  const resetLibrary = useCallback((next: GalleryLocation) => {
    requestVersionRef.current += 1;
    skipInitialImagesRef.current = false;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadMorePromiseRef.current = null;
    setImagePage(EMPTY_IMAGE_PAGE);
    setLoading(hasLibraryImages(next));
    setLoadingMore(false);
    setError(null);
  }, [setImagePage]);

  return { summary, status, imagePage, loading, loadingMore, error, setError,
    debouncedSearch, textSearchReady, textSearchMode, loadMoreLibrary,
    reloadToken, reloadGallery, resetLibrary };
}
