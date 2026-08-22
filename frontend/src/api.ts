import type {
  GallerySummary,
  ImagesPage,
  SortMode,
  ThumbnailStatus,
} from "./types";

const REQUEST_TIMEOUT_MS = 15_000;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
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
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`请求失败 (${response.status})`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("服务器返回了无效数据");
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("服务器返回了无效数据", { cause: error });
    }
  } catch (error) {
    if (timedOut) throw new Error("请求超时，请稍后重试", { cause: error });
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
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
  return getJson<ImagesPage>(`/api/images?${params}`, signal);
}
