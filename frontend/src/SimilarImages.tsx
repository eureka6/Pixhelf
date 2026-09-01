import type { CSSProperties } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { LoaderCircle, RefreshCw } from "./icons";
import type { GalleryImage } from "./types";
import { viewerThumbnailUrl } from "./viewerAssets";

function SimilarImageCard({
  image,
  onOpen,
}: {
  image: GalleryImage;
  onOpen: (image: GalleryImage) => void;
}) {
  return (
    <figure
      className="viewer-similar-card"
      title={image.name}
      data-image-id={image.id}
      role="button"
      tabIndex={0}
      aria-label={`查看相似图片 ${image.name}`}
      onClick={() => onOpen(image)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(image);
      }}
    >
      <div className="viewer-similar-card-media">
        <img
          src={viewerThumbnailUrl(image)}
          alt={image.name}
          loading="lazy"
          decoding="async"
          width={image.width}
          height={image.height}
          draggable={false}
          onError={(event) => {
            event.currentTarget.dataset.failed = "true";
          }}
        />
        <span className="viewer-similar-card-fallback" aria-hidden="true">
          <RefreshCw size={18} />
        </span>
      </div>
      <figcaption>{image.name}</figcaption>
    </figure>
  );
}

export function SimilarImageMasonry({
  images,
  total,
  columnCount,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  onOpen,
}: {
  images: GalleryImage[];
  total: number;
  columnCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onOpen: (image: GalleryImage) => void;
}) {
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const safeColumnCount = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: safeColumnCount }, () => [] as GalleryImage[]);
  const heights = Array.from({ length: safeColumnCount }, () => 0);
  for (const image of images) {
    const target = heights.indexOf(Math.min(...heights));
    columns[target]!.push(image);
    heights[target] += image.height / Math.max(1, image.width) + 0.12;
  }

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMore || loadingMore || error) return;
    const scrollRoot = sentinel.closest<HTMLElement>(".image-viewer");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      {
        root: scrollRoot,
        rootMargin: "800px 0px",
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, hasMore, images.length, loadingMore, onLoadMore]);

  return (
    <>
      <div
        className="viewer-similar-masonry"
        data-columns={safeColumnCount}
        style={{ "--similar-columns": safeColumnCount } as CSSProperties}
      >
        {columns.map((column, index) => (
          <div key={index} className="viewer-similar-column">
            {column.map((candidate) => (
              <SimilarImageCard key={candidate.id} image={candidate} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
      {error && (
        <div className="viewer-similar-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onLoadMore}>重试</button>
        </div>
      )}
      {!error && (
        <div
          ref={loadMoreSentinelRef}
          className="viewer-similar-pagination"
          data-state={hasMore ? (loadingMore ? "loading" : "ready") : "complete"}
          aria-live="polite"
        >
          {hasMore ? (
            <span className="viewer-similar-auto-load" aria-busy={loadingMore}>
              {loadingMore && <LoaderCircle className="spin" size={15} />}
              <span>{loadingMore ? "正在续载相似图片" : "继续下滑自动加载"}</span>
            </span>
          ) : (
            <span className="viewer-similar-count">
              已显示全部 {total.toLocaleString()} 张相似图片
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function SimilarImageSkeleton({ columnCount }: { columnCount: number }) {
  const safeColumnCount = Math.max(1, Math.floor(columnCount));
  const itemCount = Math.max(4, safeColumnCount * 2);
  return (
    <div
      className="viewer-similar-skeleton"
      aria-label="正在查找相似图片"
      data-columns={safeColumnCount}
      style={{ "--similar-columns": safeColumnCount } as CSSProperties}
    >
      {Array.from({ length: itemCount }, (_, index) => <span key={index} />)}
    </div>
  );
}
