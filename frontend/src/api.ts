import type {
  GallerySummary,
  ImagesPage,
  SortMode,
  ThumbnailStatus,
} from "./types";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`请求失败 (${response.status})`);
  }
  return (await response.json()) as T;
}

export function getGallery(signal?: AbortSignal): Promise<GallerySummary> {
  return getJson<GallerySummary>("/api/gallery", signal);
}

export function getStatus(signal?: AbortSignal): Promise<ThumbnailStatus> {
  return getJson<ThumbnailStatus>("/api/status", signal);
}

export function getImages(
  options: {
    album: string;
    search: string;
    sort: SortMode;
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
  return getJson<ImagesPage>(`/api/images?${params}`, signal);
}

