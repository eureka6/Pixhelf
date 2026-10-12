import { LivePhotoPlayer } from "./livePhotoPlayer";
import type { PlayerCallbacks } from "./mediaPlayer";
import { retainMotionSource } from "./mediaSource";

// A gallery/slideshow revisit needs the decoder as well as the compressed bytes.
// Bound both the number of retained players and their decoded frame dimensions;
// three entries churned even while browsing a small album of Live Photos.
const CAPACITY = 12;
const PIXEL_BUDGET = 32 * 1024 * 1024;
const IDLE_MS = 5 * 60_000;
const players = new Map<string, CachedPlayer>();

class CachedPlayer {
  readonly player: LivePhotoPlayer;
  callbacks: PlayerCallbacks | undefined;
  framed = false;
  failed = false;
  disposed = false;
  prepared = false;
  idleTimer = 0;
  private releaseBytes: () => void;

  constructor(readonly source: string, host: HTMLDivElement, callbacks: PlayerCallbacks, fullSize: boolean) {
    this.callbacks = callbacks;
    this.releaseBytes = retainMotionSource(source);
    this.player = new LivePhotoPlayer(host, source, {
      state: state => this.callbacks?.state?.(state),
      frame: () => { this.framed = true; this.callbacks?.frame?.(); trim(); },
      error: error => {
        this.failed = true;
        this.callbacks?.error?.(error);
        this.destroy();
      },
    }, fullSize);
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.idleTimer);
    this.callbacks = undefined;
    this.player.destroy();
    this.releaseBytes();
    this.releaseBytes = () => {};
    if (players.get(this.source) === this) players.delete(this.source);
  }
}

function trim() {
  let pixels = [...players.values()].reduce((sum, entry) => sum + entry.player.pixelCount, 0);
  for (const entry of players.values()) {
    if (players.size <= CAPACITY && pixels <= PIXEL_BUDGET) break;
    if (!entry.callbacks) {
      pixels -= entry.player.pixelCount;
      entry.destroy();
    }
  }
}

export function acquireLivePhoto(host: HTMLDivElement, source: string, callbacks: PlayerCallbacks, fullSize: boolean) {
  let entry = players.get(source);
  // Preview handoff releases the previous owner before acquiring the next one.
  if (entry?.callbacks) entry = undefined;
  if (!entry) entry = new CachedPlayer(source, host, callbacks, fullSize);
  else {
    window.clearTimeout(entry.idleTimer);
    entry.callbacks = callbacks;
    entry.player.attach(host, fullSize);
  }
  const current = entry;
  players.delete(source);
  players.set(source, current);
  trim();
  let released = false;
  const prepareReplay = () => {
    if (released || current.prepared) return;
    current.prepared = true;
    current.player.prepareReplay();
  };
  return {
    get warm() { return current.framed && !current.failed && !current.disposed; },
    play() {
      if (released) return;
      current.prepared = false;
      current.player.play();
    },
    pause() { if (!released) current.player.pause(); },
    prepareReplay,
    destroy() {
      if (released) return;
      current.callbacks = undefined;
      if (current.framed && !current.failed && !current.disposed) {
        // A handoff during playback resumes the existing decoded position.
        // Rewinding here queues an expensive HEVC seek in front of the new
        // owner's play(), even when both the bytes and decoder are cached.
        current.player.pause();
        // Detach cached surfaces so they cannot participate in layout or paint.
        current.player.attach(document.createElement("div"), fullSize);
        current.idleTimer = window.setTimeout(() => current.destroy(), IDLE_MS);
      } else current.destroy();
      released = true;
      trim();
    },
  };
}

window.addEventListener("pagehide", () => {
  for (const entry of players.values()) entry.destroy();
});
