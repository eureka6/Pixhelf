import { authentication, requireLogin } from "./auth";
import { SharedDownloads } from "./sharedDownloads";

// Keep compressed originals independently of the small decoded-image window.
// Looping a slideshow must not download large photos again after that window
// (or the browser's HTTP cache) evicts them. The viewer session owns this cache.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCES = 64;
const originals = new Map<string, Blob>();
let bytes = 0;
const downloads = new SharedDownloads<Blob>();
const objectUrls = new Map<Blob, { url: string; owners: number }>();

function remember(source: string, blob: Blob) {
  if (blob.size > MAX_BYTES) return;
  originals.set(source, blob);
  bytes += blob.size;
  while (bytes > MAX_BYTES || originals.size > MAX_SOURCES) {
    const [url, oldest] = originals.entries().next().value!;
    originals.delete(url);
    bytes -= oldest.size;
  }
}

export function getViewerOriginalBlob(source: string, signal: AbortSignal, priority: "high" | "low" = "high"): Promise<Blob> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const cached = originals.get(source);
  if (cached) {
    originals.delete(source);
    originals.set(source, cached);
    return Promise.resolve(cached);
  }
  return downloads.get(source, signal, async signal => {
    const options: RequestInit & { priority: "high" | "low" } = {
      cache: authentication.enabled ? "no-cache" : /[?&]retry=/.test(source) ? "reload" : "force-cache",
      credentials: "same-origin", priority, signal,
    };
    const response = await fetch(source, options);
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) requireLogin();
      throw new Error(`原图加载失败 (${response.status})`);
    }
    const blob = await response.blob();
    signal.throwIfAborted();
    if (!blob.size) throw new Error("原图内容为空");
    remember(source, blob);
    return blob;
  });
}

export function clearViewerOriginalCache(): void {
  downloads.clear();
  originals.clear();
  bytes = 0;
}

export function invalidateViewerOriginal(source: string): void {
  const blob = originals.get(source);
  if (!blob) return;
  originals.delete(source);
  bytes -= blob.size;
}

// Hidden preloads and the displayed <img> share a URL as well as bytes, so the
// browser can reuse decoded pixels. Only mounted/decoded images retain URLs.
export async function getViewerOriginalSource(source: string, signal: AbortSignal, priority: "high" | "low" = "high"): Promise<string> {
  const blob = await getViewerOriginalBlob(source, signal, priority);
  signal.throwIfAborted();
  let entry = objectUrls.get(blob);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), owners: 0 };
    objectUrls.set(blob, entry);
  }
  const current = entry;
  current.owners++;
  signal.addEventListener("abort", () => {
    if (--current.owners) return;
    URL.revokeObjectURL(current.url);
    objectUrls.delete(blob);
  }, { once: true });
  return current.url;
}
