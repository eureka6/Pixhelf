import type { GalleryImage } from "./types";

export function viewerThumbnailUrl(image: GalleryImage): string {
  return `/api/images/${encodeURIComponent(image.id)}/thumbnail`;
}

export function originalImageUrl(image: GalleryImage): string {
  const extension = image.name.slice(image.name.lastIndexOf(".") + 1).toLowerCase();
  return `/api/images/${encodeURIComponent(image.id)}.${encodeURIComponent(extension)}`;
}

export function viewerOriginalUrl(image: GalleryImage, attempt = 0): string {
  const url = image.display ?? originalImageUrl(image);
  return attempt ? `${url}?retry=${attempt}` : url;
}
