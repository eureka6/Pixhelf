import { requestJson, REQUEST_TIMEOUT_MS } from "./api/request";
import { isBootstrapData, isDuplicatePage, isGalleryImage, isGallerySummary, isImagesPage,
  isPhotoDetails, isThumbnailStatus } from "./api/validators";
import { authentication } from "./auth";
import { isCategoryConfig } from "./contentCategories";
import type {
  DuplicatePage,
  BootstrapData,
  GalleryImage,
  GallerySummary,
  ImagesPage,
  ImageFilters,
  PhotoDetails,
  SortMode,
  ThumbnailStatus,
} from "./types";

export { isGalleryImage } from "./api/validators";

const IMAGE_SEARCH_REQUEST_TIMEOUT_MS = 60_000;
const SIMILAR_REQUEST_TIMEOUT_MS = 60_000;
const PHOTO_DETAILS_REQUEST_TIMEOUT_MS = 30_000;

export function takeInitialBootstrap(): BootstrapData | null {
  const element = document.getElementById("pixhelf-bootstrap");
  if (!element) return null;

  try {
    const source = element.textContent?.trim();
    if (!source || source.startsWith("__PIXHELF_")) return null;
    const payload: unknown = JSON.parse(source);
    return isBootstrapData(payload) ? payload : null;
  } catch {
    return null;
  } finally {
    element.remove();
  }
}

export function getGallery(signal?: AbortSignal): Promise<GallerySummary> {
  return requestJson("/api/gallery", isGallerySummary, signal);
}

export function getStatus(signal?: AbortSignal): Promise<ThumbnailStatus> {
  return requestJson("/api/status", isThumbnailStatus, signal);
}

export async function getContentCategories(signal?: AbortSignal) {
  return (await requestJson("/api/categories", isCategoryConfig, signal)).categories;
}

export function getImages(
  options: {
    album: string;
    favorites?: boolean;
    search: string;
    sort: SortMode;
    kind?: ImageFilters["kind"];
    orientation?: ImageFilters["orientation"];
    seed: string;
    offset: number;
    limit: number;
  },
  signal?: AbortSignal,
): Promise<ImagesPage> {
  const params = new URLSearchParams({
    offset: String(options.offset),
    limit: String(options.limit),
    sort: options.sort,
  });
  if (options.album) params.set("album", options.album);
  if (options.search) params.set("search", options.search);
  if (options.seed) params.set("seed", options.seed);
  if (options.kind && options.kind !== "all") params.set("kind", options.kind);
  if (options.orientation && options.orientation !== "all") params.set("orientation", options.orientation);
  return requestJson(
    `${options.favorites ? "/api/management/favorites" : "/api/images"}?${params}`,
    isImagesPage,
    signal,
    options.search ? IMAGE_SEARCH_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  );
}

export function getSimilarImages(
  imageId: string,
  options: { offset: number; limit: number },
  signal?: AbortSignal,
): Promise<ImagesPage> {
  const params = new URLSearchParams({
    offset: String(options.offset),
    limit: String(options.limit),
  });
  return requestJson(
    `/api/images/${encodeURIComponent(imageId)}/similar?${params}`,
    isImagesPage,
    signal,
    SIMILAR_REQUEST_TIMEOUT_MS,
  );
}

export function getGalleryImage(imageId: string, signal?: AbortSignal): Promise<GalleryImage> {
  return requestJson(`/api/images/${encodeURIComponent(imageId)}`, isGalleryImage, signal);
}

export function getDuplicates(offset: number, search: string, signal?: AbortSignal, refresh = false): Promise<DuplicatePage> {
  const params = new URLSearchParams({ offset: String(offset), limit: "12", search });
  if (refresh) params.set("refresh", "true");
  if (offset === 0) params.set("plan", "true");
  return requestJson(`/api/images/duplicates?${params}`, isDuplicatePage, signal);
}

export function searchByUploadedImage(file: File, options: { offset: number; limit: number; exclude?: string }, signal?: AbortSignal): Promise<ImagesPage> {
  const params = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) });
  if (options.exclude) params.set("exclude", options.exclude);
  return requestJson(`/api/images/similar?${params}`, isImagesPage, signal, SIMILAR_REQUEST_TIMEOUT_MS, {
    method: "POST", body: file, credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Pixhelf-Origin": window.location.origin,
      ...(authentication.csrfToken ? { "X-CSRF-Token": authentication.csrfToken } : {}),
    },
  });
}

export function getPhotoDetails(
  imageId: string,
  signal?: AbortSignal,
): Promise<PhotoDetails> {
  return requestJson(
    `/api/images/${encodeURIComponent(imageId)}/details`,
    isPhotoDetails,
    signal,
    PHOTO_DETAILS_REQUEST_TIMEOUT_MS,
  );
}
