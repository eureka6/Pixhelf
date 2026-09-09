import type { CSSProperties } from "preact";
import type { GalleryMetrics } from "./galleryMetrics";
import type { GalleryImage } from "./types";

const SKELETON_RATIOS = [1.4, 0.72, 1, 1.55, 0.8, 1.2, 0.67, 1.35, 0.9, 1.6, 0.76, 1.1];

export function layoutJustifiedImages<T extends Pick<GalleryImage, "width" | "height">>(
  images: T[],
  { width, gap }: GalleryMetrics,
) {
  const items: { image: T; index: number; row: number; style: CSSProperties }[] = [];
  if (width <= 0) return { height: 0, rowCount: 0, items };

  const targetHeight = Math.max(120, Math.min(220, width / 2.5));
  // Use the available gallery width, including space reclaimed by the sidebar.
  const maxImagesPerRow = width <= 720 ? 2 : width >= 1600 ? 6 : 5;
  const ratios = images.map(image => {
    const ratio = image.width / image.height;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  });
  let rowStart = 0;
  let ratioSum = 0;
  let top = 0;
  let rowCount = 0;

  const addRow = (end: number, sum: number, complete: boolean) => {
    const fittedHeight = (width - (end - rowStart - 1) * gap) / sum;
    // A short final row keeps a natural size instead of enlarging a few images.
    const height = complete ? fittedHeight : Math.min(targetHeight, fittedHeight);
    let left = 0;
    for (let index = rowStart; index < end; index++) {
      const cardWidth = height * ratios[index];
      items.push({
        image: images[index],
        index,
        row: rowCount,
        style: { left, top, width: cardWidth, height },
      });
      left += cardWidth + gap;
    }
    top += height + gap;
    rowCount++;
    rowStart = end;
  };

  for (let index = 0; index < images.length; index++) {
    ratioSum += ratios[index];
    const count = index - rowStart + 1;
    const fittedHeight = (width - (count - 1) * gap) / ratioSum;
    if (fittedHeight > targetHeight) {
      if (count < maxImagesPerRow) continue;
      // Portrait rows can grow taller once full, keeping each image readable.
      addRow(index + 1, ratioSum, true);
      ratioSum = 0;
      continue;
    }

    // Choose the row break closest to the target height. Completed rows depend
    // only on this prefix, so pagination can reflow only the unfinished row.
    if (count > 1) {
      const previousSum = ratioSum - ratios[index];
      const previousHeight = (width - (count - 2) * gap) / previousSum;
      if (previousHeight - targetHeight < targetHeight - fittedHeight) {
        addRow(index, previousSum, true);
        ratioSum = ratios[index];
        if (width / ratioSum > targetHeight) continue;
      }
    }
    addRow(index + 1, ratioSum, true);
    ratioSum = 0;
  }

  if (rowStart < images.length) addRow(images.length, ratioSum, false);
  return { items, rowCount, height: items.length ? top - gap : 0 };
}

export function layoutJustifiedSkeleton(metrics: GalleryMetrics) {
  const count = Math.max(12, Math.ceil(metrics.width / 200) * 5);
  return layoutJustifiedImages(
    Array.from({ length: count }, (_, index) => ({
      width: SKELETON_RATIOS[index % SKELETON_RATIOS.length] * 100,
      height: 100,
    })),
    metrics,
  );
}
