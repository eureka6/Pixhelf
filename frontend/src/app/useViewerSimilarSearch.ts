import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getSimilarImages, searchByUploadedImage } from "../api";
import { appendUniqueImages } from "../galleryImages";
import type { GalleryImage } from "../types";
import type { SimilarImagePageState } from "../viewerHistory";
import type { VideoFrame } from "../videoFrame";
import { errorMessage } from "./errors";

const EMPTY_SIMILAR_IMAGE_PAGE: SimilarImagePageState = {
  source: null,
  images: [],
  total: 0,
  nextOffset: null,
};

type SearchState = { page: SimilarImagePageState; loading: boolean; loadingMore: boolean; error: string | null };
type SearchRequest = { source: GalleryImage | null; controller: AbortController; pending: Promise<GalleryImage[]> | null };
const EMPTY_STATE: SearchState = { page: EMPTY_SIMILAR_IMAGE_PAGE, loading: false, loadingMore: false, error: null };

export function useViewerSimilarSearch(backgroundComplete: boolean) {
  const [{ page: similarPage, loading: similarLoading, loadingMore: similarLoadingMore, error: similarError }, setState] = useState(EMPTY_STATE);
  const requestRef = useRef<SearchRequest | null>(null);
  const backgroundCompletionRef = useRef(backgroundComplete);
  useEffect(() => () => requestRef.current?.controller.abort(), []);

  // One controller owns the first page and every subsequent page of a query.
  const replaceRequest = useCallback((source: GalleryImage | null) => {
    requestRef.current?.controller.abort();
    return requestRef.current = { source, controller: new AbortController(), pending: null };
  }, []);

  const restoreSimilarSearch = useCallback((page: SimilarImagePageState | null) => {
    replaceRequest(page?.source ?? null);
    setState({ ...EMPTY_STATE, page: page ?? EMPTY_SIMILAR_IMAGE_PAGE });
  }, [replaceRequest]);
  const resetSimilarSearch = useCallback(() => restoreSimilarSearch(null), [restoreSimilarSearch]);

  const loadPage = useCallback((page: SimilarImagePageState, offset: number, initial: boolean): Promise<GalleryImage[]> => {
    const { source, frame } = page;
    if (!source) return Promise.resolve([]);
    const request = initial ? replaceRequest(source) : requestRef.current;
    if (!request || request.source !== source || request.controller.signal.aborted) return Promise.resolve([]);
    if (request.pending) return request.pending;
    const { signal } = request.controller;
    setState(current => ({ page: initial ? page : current.page, loading: initial, loadingMore: !initial, error: null }));
    const options = { offset, limit: 30, exclude: source.id };
    request.pending = (frame ? searchByUploadedImage(frame.file, options, signal) : getSimilarImages(source.id, options, signal))
      .then(result => {
        if (signal.aborted) return [];
        setState(current => ({ ...EMPTY_STATE, page: {
          source, frame, images: initial ? result.items : appendUniqueImages(current.page.images, result.items),
          total: result.total, nextOffset: result.nextOffset,
        } }));
        return result.items;
      }).catch(reason => {
        if (!signal.aborted) setState(current => ({
          ...current, loading: false, loadingMore: false,
          error: errorMessage(reason, initial ? "无法查找相似图片" : "无法继续加载相似图片"),
        }));
        return [];
      }).finally(() => { request.pending = null; });
    return request.pending;
  }, [replaceRequest]);

  const searchSimilar = useCallback((source: GalleryImage, force = false, capturedFrame?: VideoFrame) => {
    const sameSource = similarPage.source?.id === source.id;
    const frame = capturedFrame ?? (sameSource ? similarPage.frame : undefined);
    if (!force && sameSource && (similarLoading || !similarError)) return;

    void loadPage({ source, frame, images: [], total: 0, nextOffset: null }, 0, true);
  }, [similarError, similarLoading, similarPage.source?.id, similarPage.frame, loadPage]);

  const searchVideoFrame = useCallback((source: GalleryImage, frame: VideoFrame) => {
    searchSimilar(source, true, frame);
  }, [searchSimilar]);

  useEffect(() => {
    const justCompleted = backgroundComplete && !backgroundCompletionRef.current;
    backgroundCompletionRef.current = backgroundComplete;
    if (justCompleted && similarPage.source) {
      searchSimilar(similarPage.source, true);
    }
  }, [searchSimilar, similarPage.source, backgroundComplete]);

  const loadMoreSimilar = useCallback((): Promise<GalleryImage[]> => {
    const offset = similarPage.nextOffset;
    return similarLoading || offset === null ? Promise.resolve([]) : loadPage(similarPage, offset, false);
  }, [similarLoading, similarPage, loadPage]);

  return { similarPage, similarLoading, similarLoadingMore, similarError,
    resetSimilarSearch, restoreSimilarSearch, searchSimilar, searchVideoFrame, loadMoreSimilar };
}
