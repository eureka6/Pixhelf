import type { CSSProperties } from "preact";
import { memo } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

import { ImageIcon, LoaderCircle } from "./icons";
import { ImageCardActions } from "./ImageCardActions";
import { layoutJustifiedImages, layoutJustifiedSkeleton } from "./justified";
import type { GalleryMetrics } from "./galleryMetrics";
import { useCardInteraction } from "./cardInteraction";
import type { GalleryImage, ImageCardAction } from "./types";
import { viewerThumbnailUrl } from "./viewerAssets";

const SimilarImageCard = memo(function SimilarImageCard({
  image,
  layoutStyle,
  onOpen,
}: {
  image: GalleryImage;
  layoutStyle: CSSProperties;
  onOpen: (image: GalleryImage, action?: ImageCardAction) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleAction = useCallback((action: ImageCardAction) => onOpen(image, action), [image, onOpen]);

  useLayoutEffect(() => {
    const element = imageRef.current;
    if (element?.complete && element.naturalWidth > 0) setLoaded(true);
  }, [image.id]);

  return (
    <figure
      className="viewer-similar-card"
      data-image-id={image.id}
      data-image-name={image.name}
      data-loaded={loaded}
      data-failed={failed}
      data-loading={!loaded && !failed}
      style={layoutStyle}
      role="group"
      tabIndex={-1}
      aria-label={image.name}
      onClick={() => onOpen(image)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
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
      <button type="button" className="photo-card-open" aria-label={`查看相似图片 ${image.name}`} aria-haspopup="dialog" />
      <ImageCardActions image={image} onAction={handleAction} />
    </figure>
  );
});

export function SimilarImageGallery({
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
  metrics: GalleryMetrics;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onOpen: (image: GalleryImage, action?: ImageCardAction) => void;
}) {
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  useCardInteraction(galleryRef);
  const layout = useMemo(() => layoutJustifiedImages(images, metrics), [images, metrics]);

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
        ref={galleryRef}
        className="viewer-similar-gallery"
        data-layout="justified"
        data-layout-width={metrics.width}
        data-rows={layout.rowCount}
        style={{ height: layout.height } as CSSProperties}
      >
        {layout.items.map(({ image, style }) => (
          <SimilarImageCard
            key={image.id}
            image={image}
            layoutStyle={style}
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

export function SimilarImageSkeleton({ metrics }: { metrics: GalleryMetrics }) {
  const layout = useMemo(() => layoutJustifiedSkeleton(metrics), [metrics]);
  return (
    <div
      className="viewer-similar-skeleton"
      aria-label="正在查找相似图片"
      data-layout="justified"
      data-layout-width={metrics.width}
      style={{ height: layout.height } as CSSProperties}
    >
      {layout.items.map(({ index, style }) => (
        <span key={index} aria-hidden="true" style={style} />
      ))}
    </div>
  );
}
