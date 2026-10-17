import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getSimilarImages, searchByUploadedImage } from "../api";
import { appendUniqueImages } from "../galleryImages";
import type { GalleryImage } from "../types";
import type { SimilarImagePageState } from "../viewerHistory";
import type { VideoFrame } from "../videoFrame";
import { errorMessage } from "./errors";

const SIMILAR_PAGE_SIZE = 30;
const EMPTY_SIMILAR_IMAGE_PAGE: SimilarImagePageState = {
  source: null,
  images: [],
  total: 0,
  nextOffset: null,
};

export function useViewerSimilarSearch(backgroundComplete: boolean) {
  const [similarPage, setSimilarPage] = useState<SimilarImagePageState>(
    EMPTY_SIMILAR_IMAGE_PAGE,
  );
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarLoadingMore, setSimilarLoadingMore] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);
  const similarRequestVersionRef = useRef(0);
  const similarControllerRef = useRef<AbortController | null>(null);
  const similarLoadMoreControllerRef = useRef<AbortController | null>(null);
  const similarLoadMorePromiseRef = useRef<Promise<GalleryImage[]> | null>(null);
  const backgroundCompletionRef = useRef(
    backgroundComplete,
  );
  useEffect(() => () => {
    similarRequestVersionRef.current += 1;
    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
  }, []);

  const resetSimilarSearch = useCallback(() => {
    similarRequestVersionRef.current += 1;
    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    similarControllerRef.current = null;
    similarLoadMoreControllerRef.current = null;
    similarLoadMorePromiseRef.current = null;
    setSimilarPage(EMPTY_SIMILAR_IMAGE_PAGE);
    setSimilarLoading(false);
    setSimilarLoadingMore(false);
    setSimilarError(null);
  }, []);

  const searchSimilar = useCallback((source: GalleryImage, force = false, capturedFrame?: VideoFrame) => {
    const sameSource = similarPage.source?.id === source.id;
    const frame = capturedFrame ?? (sameSource ? similarPage.frame : undefined);
    if (!force && sameSource && (similarLoading || !similarError)) return;

    similarControllerRef.current?.abort();
    similarLoadMoreControllerRef.current?.abort();
    similarLoadMoreControllerRef.current = null;
    similarLoadMorePromiseRef.current = null;
    const controller = new AbortController();
    const requestVersion = ++similarRequestVersionRef.current;
    similarControllerRef.current = controller;
    setSimilarPage({ source, frame, images: [], total: 0, nextOffset: null });
    setSimilarLoading(true);
    setSimilarLoadingMore(false);
    setSimilarError(null);

    const options = { offset: 0, limit: SIMILAR_PAGE_SIZE, exclude: source.id };
    void (frame ? searchByUploadedImage(frame.file, options, controller.signal)
      : getSimilarImages(source.id, options, controller.signal))
      .then((page) => {
        if (controller.signal.aborted || requestVersion !== similarRequestVersionRef.current) return;
        setSimilarPage({
          source,
          frame,
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && requestVersion === similarRequestVersionRef.current) {
          setSimilarError(errorMessage(reason, "无法查找相似图片"));
        }
      })
      .finally(() => {
        if (similarControllerRef.current === controller) {
          similarControllerRef.current = null;
          if (requestVersion === similarRequestVersionRef.current) setSimilarLoading(false);
        }
      });
  }, [similarError, similarLoading, similarPage.source?.id, similarPage.frame]);

  const searchVideoFrame = useCallback((source: GalleryImage, frame: VideoFrame) => {
    searchSimilar(source, true, frame);
  }, [searchSimilar]);

  useEffect(() => {
    const complete = backgroundComplete;
    const justCompleted = complete && !backgroundCompletionRef.current;
    backgroundCompletionRef.current = complete;
    if (justCompleted && similarPage.source) {
      searchSimilar(similarPage.source, true);
    }
  }, [searchSimilar, similarPage.source, backgroundComplete]);

  const loadMoreSimilar = useCallback((): Promise<GalleryImage[]> => {
    const source = similarPage.source;
    const frame = similarPage.frame;
    const offset = similarPage.nextOffset;
    if (!source || similarLoading || offset === null) return Promise.resolve([]);
    const pending = similarLoadMorePromiseRef.current;
    if (pending) return pending;

    const controller = new AbortController();
    const requestVersion = similarRequestVersionRef.current;
    similarLoadMoreControllerRef.current = controller;
    setSimilarLoadingMore(true);
    setSimilarError(null);

    const promise = (async () => {
      try {
        const options = { offset, limit: SIMILAR_PAGE_SIZE, exclude: source.id };
        const page = await (frame ? searchByUploadedImage(frame.file, options, controller.signal)
          : getSimilarImages(source.id, options, controller.signal));
        if (controller.signal.aborted || requestVersion !== similarRequestVersionRef.current) return [];
        setSimilarPage((current) => current.source?.id === source.id
          ? {
              source,
              frame,
              images: appendUniqueImages(current.images, page.items),
              total: page.total,
              nextOffset: page.nextOffset,
            }
          : current);
        return page.items;
      } catch (reason) {
        if (!controller.signal.aborted && requestVersion === similarRequestVersionRef.current) {
          setSimilarError(errorMessage(reason, "无法继续加载相似图片"));
        }
        return [];
      } finally {
        if (similarLoadMoreControllerRef.current === controller) {
          similarLoadMoreControllerRef.current = null;
          similarLoadMorePromiseRef.current = null;
          if (requestVersion === similarRequestVersionRef.current) {
            setSimilarLoadingMore(false);
          }
        }
      }
    })();
    similarLoadMorePromiseRef.current = promise;
    return promise;
  }, [similarLoading, similarPage.nextOffset, similarPage.source, similarPage.frame]);

  const restoreSimilarSearch = useCallback((page: SimilarImagePageState | null) => {
    resetSimilarSearch();
    if (page) setSimilarPage(page);
  }, [resetSimilarSearch]);

  return { similarPage, similarLoading, similarLoadingMore, similarError,
    resetSimilarSearch, restoreSimilarSearch, searchSimilar, searchVideoFrame, loadMoreSimilar };
}
