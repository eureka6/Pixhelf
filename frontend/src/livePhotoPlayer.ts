import { MediaPlayer, type PlayerCallbacks, type PlayerState } from "./mediaPlayer";
import { motionBlob } from "./mediaSource";
import { motionVideoCodec } from "./motionCodec";

// Remember native decode failures for this file version, never user-gesture or
// network failures. A replay can immediately use the compatible decoder.
const unsupportedSources = new Set<string>();

function rememberUnsupported(source: string) {
  unsupportedSources.add(source);
  if (unsupportedSources.size > 32) unsupportedSources.delete(unsupportedSources.values().next().value!);
}

export async function supportsNativeMotion(source: string, blob: Blob | undefined): Promise<boolean> {
  if (unsupportedSources.has(source)) return false;
  if (blob) {
    const codec = await motionVideoCodec(blob);
    if (codec && !document.createElement("video").canPlayType(`video/mp4; codecs="${codec}"`)) {
      rememberUnsupported(source);
      return false;
    }
  }
  return true;
}

export class LivePhotoPlayer {
  private surface = document.createElement("div");
  private video = document.createElement("video");
  private canvas = document.createElement("canvas");
  private sourceAbort = new AbortController();
  private nativeAbort = new AbortController();
  private fallback: MediaPlayer | undefined;
  private disposed = false;
  private wantsPlay = false;
  private playPending = false;
  private framed = false;
  private frame = 0;
  private timeout = 0;
  private stallTimer = 0;
  private resumedBuffer = false;
  private resumeAttempts = 0;
  private lastPaint = -Infinity;
  private lastTime = -1;
  private objectUrl: string | undefined;

  constructor(private host: HTMLDivElement, private source: string,
    private callbacks: PlayerCallbacks, private fullSize: boolean) {
    const { surface, video, canvas } = this;
    surface.className = "media-player-surface live-photo-surface";
    surface.dataset.player = "native-live";
    surface.dataset.muted = "true";
    surface.dataset.currentTime = "0";
    video.muted = video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    video.disablePictureInPicture = true;
    video.tabIndex = -1;
    surface.append(video, canvas);
    host.append(surface);
    this.setState("loading");
    void this.initialize().catch(error => { if (!this.disposed) this.fail(error); });
  }

  private async initialize() {
    const { video } = this;
    const on = (event: string, callback: () => void) => video.addEventListener(event, callback, { signal: this.nativeAbort.signal });
    on("loadedmetadata", () => {
      this.surface.dataset.duration = String(video.duration);
      if (this.wantsPlay) this.play();
    });
    on("loadeddata", () => {
      if (!video.videoWidth || !video.videoHeight) {
        // Metadata and decoded data are ready, but no video track is usable.
        // Audio-only MOV acceptance must not add another second of waiting.
        this.useFallback(true);
      }
    });
    on("playing", () => this.watchBufferedPlayback());
    on("waiting", () => { if (this.wantsPlay) { this.setState("loading"); this.watchBufferedPlayback(); } });
    on("ended", () => {
      if (!this.framed) { this.useFallback(true); return; }
      this.wantsPlay = false;
      this.setState("ended");
    });
    on("error", () => {
      if (video.error?.code === 3 || video.error?.code === 4) this.useFallback(true);
      else this.fail(new Error("实况加载失败，请重试"));
    });
    const blob = await motionBlob(this.source, this.sourceAbort.signal);
    if (this.disposed) return;
    const native = await supportsNativeMotion(this.source, blob);
    if (this.disposed) return;
    if (!native) { this.useFallback(); return; }
    video.src = blob ? this.objectUrl = URL.createObjectURL(blob) : this.source;
    // Some browsers accept a container but expose only its audio track. A
    // "playing" event alone must not hide the loader or stall the photo forever.
    window.clearTimeout(this.timeout);
    this.timeout = window.setTimeout(() => this.useFallback(), 8000);
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) { this.useFallback(); return; }
    // Browser-decoded frames already include the MOV display matrix. Copy them
    // without another rotation, avoiding black HEVC surfaces during photo zoom.
    const paint = (now: number) => {
      if (this.disposed || this.nativeAbort.signal.aborted) return;
      if (video.readyState >= 2 && !video.seeking) {
        if (this.wantsPlay && video.paused && !video.ended && !this.playPending && this.resumeAttempts < 2) {
          this.resumeAttempts++;
          this.play();
        }
        if (!video.paused && video.videoWidth && video.videoHeight && now - this.lastPaint >= 1000 / 30
          && video.currentTime !== this.lastTime) {
          const width = video.videoWidth, height = video.videoHeight;
          const scale = this.fullSize ? Math.min(1, Math.sqrt(3840 * 2160 / (width * height)))
            : Math.min(1, 480 * Math.min(devicePixelRatio || 1, 3) / Math.max(width, height));
          const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
          if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
          try { context.drawImage(video, 0, 0, w, h); }
          catch { this.useFallback(); return; }
          this.lastPaint = this.framed ? now - (now - this.lastPaint) % (1000 / 30) : now;
          this.lastTime = video.currentTime;
          this.resumeAttempts = 0;
          this.surface.dataset.currentTime = String(video.currentTime);
          this.setState("playing");
          if (!this.framed) { this.framed = true; this.callbacks.frame?.(); }
        }
      }
      if (!this.disposed && !this.nativeAbort.signal.aborted) this.frame = requestAnimationFrame(paint);
    };
    this.frame = requestAnimationFrame(paint);
  }

  private setState(state: PlayerState) {
    if (this.disposed || this.surface.dataset.playerState === state) return;
    this.surface.dataset.playerState = state;
    window.clearTimeout(this.timeout);
    if (state === "loading") this.timeout = window.setTimeout(() => this.fail(new Error("实况加载超时，请重试")), 30_000);
    this.callbacks.state?.(state);
  }

  private watchBufferedPlayback() {
    window.clearTimeout(this.stallTimer);
    if (this.resumedBuffer) return;
    const time = this.video.currentTime;
    this.stallTimer = window.setTimeout(() => {
      const video = this.video;
      if (this.disposed || !this.wantsPlay || video.ended || video.seeking || Math.abs(video.currentTime - time) > .03) return;
      // WebKit can stop advancing a completely buffered MOV after "playing".
      // Resume once without seeking, reloading, or applying the matrix again.
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= time && video.buffered.end(i) > time + .15) {
          this.resumedBuffer = true;
          video.pause();
          this.play();
          break;
        }
      }
    }, 600);
  }

  private releaseNative() {
    this.nativeAbort.abort();
    window.clearTimeout(this.timeout);
    window.clearTimeout(this.stallTimer);
    cancelAnimationFrame(this.frame);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined; }
    this.canvas.width = this.canvas.height = 1;
    this.surface.dataset.playerState = "destroyed";
    this.surface.remove();
  }

  private useFallback(remember = false) {
    if (this.disposed || this.nativeAbort.signal.aborted) return;
    if (remember) rememberUnsupported(this.source);
    this.releaseNative();
    this.fallback = new MediaPlayer(this.host, this.source, "motion.mov", true, this.callbacks, true,
      { sourceResolution: this.fullSize, retainBytes: true, quickStart: true });
    if (this.wantsPlay) this.fallback.play();
  }

  private fail(reason: unknown) {
    if (this.disposed) return;
    this.setState("failed");
    this.callbacks.error?.(reason instanceof Error ? reason : new Error(String(reason)));
    this.destroy();
  }

  play() {
    if (this.disposed) return;
    this.wantsPlay = true;
    if (this.fallback) { this.fallback.play(); return; }
    if (this.video.readyState < 1 || this.playPending || this.nativeAbort.signal.aborted) return;
    this.playPending = true;
    void this.video.play().catch(error => {
      if (this.disposed || this.nativeAbort.signal.aborted || error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError") {
        this.wantsPlay = false;
        this.setState("paused");
        this.callbacks.autoplayBlocked?.();
      } else if (error?.name === "NotSupportedError") this.useFallback(true);
      else this.fail(error);
    }).finally(() => { this.playPending = false; });
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlay = false;
    this.sourceAbort.abort();
    this.releaseNative();
    this.fallback?.destroy();
  }
}
