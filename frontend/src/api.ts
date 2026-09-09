import { authentication, requireLogin } from "./auth";
import type {
  Album,
  BootstrapData,
  GalleryImage,
  GallerySummary,
  ImagesPage,
  PhotoDetails,
  SortMode,
  ThumbnailStatus,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;
const IMAGE_SEARCH_REQUEST_TIMEOUT_MS = 60_000;
const SIMILAR_REQUEST_TIMEOUT_MS = 60_000;
const PHOTO_DETAILS_REQUEST_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;
type JsonValidator<T> = (value: unknown) => value is T;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isAlbum(value: unknown): value is Album {
  return isObject(value)
    && typeof value.path === "string"
    && typeof value.name === "string"
    && isNonNegativeInteger(value.count)
    && (value.cover === null || typeof value.cover === "string");
}

function isGalleryImage(value: unknown): value is GalleryImage {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isPositiveInteger(value.width)
    && isPositiveInteger(value.height);
}

function isGallerySummary(value: unknown): value is GallerySummary {
  return isObject(value)
    && isNonNegativeInteger(value.total)
    && Array.isArray(value.albums)
    && value.albums.every(isAlbum)
    && typeof value.revision === "string";
}

function isImagesPage(value: unknown): value is ImagesPage {
  return isObject(value)
    && Array.isArray(value.items)
    && value.items.every(isGalleryImage)
    && isNonNegativeInteger(value.total)
    && isNonNegativeInteger(value.offset)
    && isPositiveInteger(value.limit)
    && (value.nextOffset === null || (isNonNegativeInteger(value.nextOffset)
      && value.nextOffset > value.offset && value.nextOffset < value.total));
}

function isHistogramChannel(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 256
    && value.every(isNonNegativeInteger);
}

function isPhotoDetails(value: unknown): value is PhotoDetails {
  return isObject(value)
    && isNonNegativeInteger(value.fileSize)
    && isNonNegativeInteger(value.modifiedMs)
    && Array.isArray(value.exif)
    && value.exif.every((field) => isObject(field)
      && typeof field.label === "string"
      && typeof field.value === "string")
    && isObject(value.histogram)
    && isHistogramChannel(value.histogram.red)
    && isHistogramChannel(value.histogram.green)
    && isHistogramChannel(value.histogram.blue)
    && isHistogramChannel(value.histogram.luminance);
}

function isThumbnailStatus(value: unknown): value is ThumbnailStatus {
  return isObject(value)
    && isNonNegativeInteger(value.total)
    && isNonNegativeInteger(value.ready)
    && isNonNegativeInteger(value.queued)
    && isNonNegativeInteger(value.processing)
    && isNonNegativeInteger(value.failed)
    && typeof value.initialBatchReady === "boolean"
    && typeof value.backgroundComplete === "boolean"
    && isObject(value.textSearch)
    && typeof value.textSearch.enabled === "boolean"
    && isNonNegativeInteger(value.textSearch.total)
    && isNonNegativeInteger(value.textSearch.ready)
    && isNonNegativeInteger(value.textSearch.queued)
    && isNonNegativeInteger(value.textSearch.processing)
    && isNonNegativeInteger(value.textSearch.failed)
    && typeof value.textSearch.backgroundComplete === "boolean";
}

function isBootstrapData(value: unknown): value is BootstrapData {
  return isObject(value)
    && isGallerySummary(value.summary)
    && isThumbnailStatus(value.status)
    && isImagesPage(value.images);
}

async function requestJson<T>(
  url: string,
  validate: JsonValidator<T>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  request?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const headers = new Headers(request?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await fetch(url, {
      cache: "no-cache",
      ...request,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) requireLogin();
      if (request?.method === "POST") {
        if (response.status === 413) throw new Error("图片不能超过 20 MB");
        const payload = await response.json().catch(() => null);
        if (typeof payload?.error === "string") throw new Error(payload.error);
      }
      throw new Error(`请求失败 (${response.status})`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("服务器返回了无效数据");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("服务器返回了无效数据", { cause: error });
    }
    if (!validate(payload)) throw new Error("服务器返回了无效数据");
    return payload;
  } catch (error) {
    if (timedOut) throw new Error("请求超时，请稍后重试", { cause: error });
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

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

export function getImages(
  options: {
    album: string;
    search: string;
    sort: SortMode;
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
  return requestJson(
    `/api/images?${params}`,
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

export function searchByUploadedImage(file: File, options: { offset: number; limit: number }, signal?: AbortSignal): Promise<ImagesPage> {
  const params = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) });
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
