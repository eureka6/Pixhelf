import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getGalleryImage, getSimilarImages, searchByUploadedImage } from "./api";
import { appendUniqueImages } from "./galleryImages";
import type { GalleryImage } from "./types";

export type ImageSearchSource =
  | { kind: "gallery"; imageId: string; image?: GalleryImage }
  | { kind: "upload"; file: File };

type SearchState = {
  source: ImageSearchSource | null;
  reference: GalleryImage | null;
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};

type SearchRequest = {
  source: ImageSearchSource;
  controller: AbortController;
  pending: Promise<GalleryImage[]> | null;
};

function emptyState(source: ImageSearchSource | null, loading = false): SearchState {
  return {
    source,
    reference: source?.kind === "gallery" ? source.image ?? null : null,
    images: [], total: 0, nextOffset: null, loading, loadingMore: false, error: null,
  };
}

function requestPage(source: ImageSearchSource, offset: number, signal: AbortSignal) {
  const options = { offset, limit: 60 };
  return source.kind === "gallery"
    ? getSimilarImages(source.imageId, options, signal)
    : searchByUploadedImage(source.file, options, signal);
}

export function useImageSimilarity(source: ImageSearchSource | null, active: boolean) {
  const [state, setState] = useState(() => emptyState(source, active && !!source));
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef<SearchRequest | null>(null);

  useEffect(() => {
    if (!active || !source) {
      if (!source) setState(emptyState(null));
      return;
    }
    // One controller owns the query, its metadata and all subsequent pages.
    const request: SearchRequest = { source, controller: new AbortController(), pending: null };
    const { signal } = request.controller;
    requestRef.current = request;
    setState(emptyState(source, true));
    const reference = source.kind === "gallery"
      ? source.image ?? getGalleryImage(source.imageId, signal)
      : null;

    void Promise.all([requestPage(source, 0, signal), reference]).then(([page, image]) => {
      if (signal.aborted) return;
      setState({
        source, reference: image, images: appendUniqueImages([], page.items),
        total: page.total, nextOffset: page.nextOffset,
        loading: false, loadingMore: false, error: null,
      });
    }).catch(reason => {
      if (signal.aborted) return;
      request.controller.abort();
      setState(current => ({
        ...current, loading: false,
        error: reason instanceof Error ? reason.message : "无法查找相似图片，请重试",
      }));
    });
    return () => {
      request.controller.abort();
      if (requestRef.current === request) requestRef.current = null;
    };
  }, [active, source, attempt]);

  const loadMore = useCallback((): Promise<GalleryImage[]> => {
    const request = requestRef.current;
    if (!active || !source || request?.source !== source || request.controller.signal.aborted
      || state.source !== source || state.loading || state.nextOffset === null) return Promise.resolve([]);
    if (request.pending) return request.pending;

    const { signal } = request.controller;
    setState(current => ({ ...current, loadingMore: true, error: null }));
    const promise = requestPage(source, state.nextOffset, signal).then(page => {
      if (signal.aborted) return [];
      const images = appendUniqueImages(state.images, page.items);
      setState(current => ({ ...current, images, total: page.total, nextOffset: page.nextOffset }));
      return images.slice(state.images.length);
    }).catch(reason => {
      if (!signal.aborted) setState(current => ({
        ...current, error: reason instanceof Error ? reason.message : "无法继续加载，请重试",
      }));
      return [];
    }).finally(() => {
      request.pending = null;
      if (!signal.aborted) setState(current => ({ ...current, loadingMore: false }));
    });
    request.pending = promise;
    return promise;
  }, [active, source, state]);

  const current = state.source === source ? state : emptyState(source, active && !!source);
  const retry = () => {
    if (current.images.length) void loadMore();
    else setAttempt(value => value + 1);
  };
  return { ...current, loadMore, retry };
}
