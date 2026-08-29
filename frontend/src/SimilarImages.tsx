import type { CSSProperties } from "preact";

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
  const safeColumnCount = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: safeColumnCount }, () => [] as GalleryImage[]);
  const heights = Array.from({ length: safeColumnCount }, () => 0);
  for (const image of images) {
    const target = heights.indexOf(Math.min(...heights));
    columns[target]!.push(image);
    heights[target] += image.height / Math.max(1, image.width) + 0.12;
  }

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
        <div className="viewer-similar-pagination">
          {hasMore ? (
            <button
              type="button"
              className="viewer-similar-load-more"
              onClick={onLoadMore}
              disabled={loadingMore}
              aria-busy={loadingMore}
            >
              {loadingMore && <LoaderCircle className="spin" size={15} />}
              <span>{loadingMore ? "正在加载" : "加载更多相似图片"}</span>
              {!loadingMore && <small>{images.length} / {total}</small>}
            </button>
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

export function SimilarImageSkeleton() {
  return (
    <div className="viewer-similar-skeleton" aria-label="正在查找相似图片">
      {[1, 2, 3, 4, 5, 6].map((item) => <span key={item} />)}
    </div>
  );
}
