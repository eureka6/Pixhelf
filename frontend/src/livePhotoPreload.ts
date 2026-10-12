import { isMotionCached, motionBlob, retainMotionSource } from "./mediaSource";
import { supportsNativeMotion } from "./livePhotoPlayer";
import { preloadMediaPlayer } from "./mediaPlayer";

type Preload = { source: string; owners: number; immediate: number; abort?: AbortController; timeout?: number; finished: boolean };
const preloads = new Map<string, Preload>();
let running = 0;

function drain() {
  for (const preload of [...preloads.values()].sort((a, b) => Number(b.immediate > 0) - Number(a.immediate > 0))) {
    if (running >= 4) break;
    if (!preload.owners || preload.abort || preload.finished) continue;
    // Current/next slideshow clips cannot queue behind gallery speculation.
    if (running >= 2 && !preload.immediate) continue;
    const abort = preload.abort = new AbortController();
    preload.timeout = window.setTimeout(() => abort.abort(), preload.immediate ? 30_000 : 10_000);
    running++;
    // Original bytes use the same bounded cache as playback. No decoder or
    // video element is kept alive while the user is merely browsing photos.
    void motionBlob(preload.source, abort.signal).then(async blob => {
      if (!abort.signal.aborted && !await supportsNativeMotion(preload.source, blob) && !abort.signal.aborted) {
        await preloadMediaPlayer();
      }
    }).catch(() => {}).finally(() => {
      window.clearTimeout(preload.timeout);
      preload.finished = true;
      running--;
      drain();
    });
  }
}

export function canPreloadLivePhotos(): boolean {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !document.hidden && !connection?.saveData && !/^(slow-)?2g$/.test(connection?.effectiveType ?? "");
}

export function preloadLivePhoto(source: string, immediate = false): () => void {
  let preload = preloads.get(source);
  if (!preload) {
    preload = { source, owners: 0, finished: false, immediate: 0 };
    preloads.set(source, preload);
  }
  const current = preload;
  // The bounded byte cache may have evicted an earlier speculative download.
  // A remembered completion alone does not mean this clip is still available.
  if (current.finished && !isMotionCached(source)) {
    current.finished = false;
    current.abort = undefined;
  }
  if (immediate) {
    if (!current.immediate++ && current.abort && !current.finished) {
      window.clearTimeout(current.timeout);
      current.timeout = window.setTimeout(() => current.abort?.abort(), 30_000);
    }
  }
  current.owners++;
  const releaseBytes = immediate ? retainMotionSource(source) : undefined;
  drain();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (immediate) current.immediate--;
    releaseBytes?.();
    if (--current.owners) return;
    // Photo/video viewer handoffs unmount one slideshow controller and mount
    // the next in the same commit. Let that new owner keep the pending fetch.
    queueMicrotask(() => {
      if (current.owners) return;
      current.abort?.abort();
      if (preloads.get(source) === current) preloads.delete(source);
      drain();
    });
  };
}
