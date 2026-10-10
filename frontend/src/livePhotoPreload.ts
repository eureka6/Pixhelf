import { motionBlob } from "./mediaSource";
import { supportsNativeMotion } from "./livePhotoPlayer";
import { preloadMediaPlayer } from "./mediaPlayer";

type Preload = { source: string; owners: number; abort?: AbortController; finished: boolean };
const preloads = new Map<string, Preload>();
let running = 0;

function drain() {
  for (const preload of preloads.values()) {
    if (running >= 2) break;
    if (!preload.owners || preload.abort || preload.finished) continue;
    const abort = preload.abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 10_000);
    running++;
    // Original bytes use the same bounded cache as playback. No decoder or
    // video element is kept alive while the user is merely browsing photos.
    void motionBlob(preload.source, abort.signal).then(async blob => {
      if (!abort.signal.aborted && !await supportsNativeMotion(preload.source, blob) && !abort.signal.aborted) {
        await preloadMediaPlayer();
      }
    }).catch(() => {}).finally(() => {
      window.clearTimeout(timeout);
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

export function preloadLivePhoto(source: string): () => void {
  let preload = preloads.get(source);
  if (!preload) {
    preload = { source, owners: 0, finished: false };
    preloads.set(source, preload);
  }
  const current = preload;
  current.owners++;
  drain();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--current.owners) return;
    current.abort?.abort();
    preloads.delete(source);
    drain();
  };
}
