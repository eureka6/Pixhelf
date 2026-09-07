import type { CSSProperties } from "preact";
import { memo } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

import { ImageIcon, LoaderCircle } from "./icons";
import { layoutMasonryImages, layoutMasonrySkeleton } from "./masonry";
import type { MasonryMetrics } from "./masonry";
import type { GalleryImage } from "./types";
import { viewerThumbnailUrl } from "./viewerAssets";

const SimilarImageCard = memo(function SimilarImageCard({
  image,
  layoutStyle,
  nameVisible,
  onNameTouch,
  onOpen,
}: {
  image: GalleryImage;
  layoutStyle: CSSProperties;
  nameVisible: boolean;
  onNameTouch: (id: string) => void;
  onOpen: (image: GalleryImage) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const element = imageRef.current;
    if (element?.complete && element.naturalWidth > 0) setLoaded(true);
  }, [image.id]);

  return (
    <figure
      className="viewer-similar-card"
      title={image.name}
      data-image-id={image.id}
      data-name-visible={nameVisible}
      data-loaded={loaded}
      data-failed={failed}
      data-loading={!loaded && !failed}
      style={layoutStyle}
      role="button"
      tabIndex={0}
      aria-label={`查看相似图片 ${image.name}`}
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") onNameTouch(image.id);
      }}
      onClick={() => onOpen(image)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(image);
      }}
    >
      {!failed ? (
        <img
          ref={imageRef}
          src={viewerThumbnailUrl(image)}
          alt={image.name}
          loading="lazy"
          decoding="async"
          width={image.width}
          height={image.height}
          draggable={false}
          className={loaded ? "loaded" : ""}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="image-fallback" role="img" aria-label={`${image.name} 加载失败`}>
          <ImageIcon size={24} />
        </span>
      )}
      <figcaption className="image-name">{image.name}</figcaption>
    </figure>
  );
});

export function SimilarImageMasonry({
  images,
  total,
  metrics,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  onOpen,
}: {
  images: GalleryImage[];
  total: number;
  metrics: MasonryMetrics;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onOpen: (image: GalleryImage) => void;
}) {
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const [activeNameId, setActiveNameId] = useState<string | null>(null);
  const showName = useCallback((id: string) => setActiveNameId(id), []);
  const layout = useMemo(() => layoutMasonryImages(images, metrics), [images, metrics]);

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
        data-columns={metrics.columnCount}
        style={{ height: layout.height } as CSSProperties}
      >
        {layout.items.map(({ image, style }) => (
          <SimilarImageCard
            key={image.id}
            image={image}
            layoutStyle={style}
            nameVisible={activeNameId === image.id}
            onNameTouch={showName}
            onOpen={onOpen}
          />
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

export function SimilarImageSkeleton({ metrics }: { metrics: MasonryMetrics }) {
  const layout = useMemo(() => layoutMasonrySkeleton(metrics), [metrics]);
  return (
    <div
      className="viewer-similar-skeleton"
      aria-label="正在查找相似图片"
      data-columns={metrics.columnCount}
      style={{ height: layout.height } as CSSProperties}
    >
      {layout.items.map(({ index, style }) => (
        <span key={index} aria-hidden="true" style={style} />
      ))}
    </div>
  );
}
