import type { PlayerCallbacks, PlayerState, VideoPlayer } from "./mediaPlayer";
import { captureVideoFrame } from "./videoFrame";

// Prepared MP4s use the browser's decoder and byte-range seeking. Preparation
// polling has its own lifetime: a long encode is not a playback timeout.
export class NativeMediaPlayer implements VideoPlayer {
  private video: HTMLVideoElement;
  private abort = new AbortController();
  private disposed = false;
  private loaded = false;
  private framed = false;
  private wantsPlay = false;
  private poll = 0;
  private timeout = 0;
  private frameRequest = 0;

  constructor(host: HTMLDivElement, source: string, _filename: string,
    muted: boolean, private callbacks: PlayerCallbacks = {}, cover = false) {
    const video = this.video = document.createElement("video");
    video.className = "media-player-surface";
    video.dataset.player = "native";
    video.dataset.muted = String(muted);
    video.dataset.currentTime = "0";
    video.muted = video.defaultMuted = muted;
    video.playsInline = true;
    video.preload = "auto";
    video.style.objectFit = cover ? "cover" : "contain";
    host.appendChild(video);
    const on = (event: string, callback: () => void) => video.addEventListener(event, () => {
      if (!this.disposed) callback();
    }, { signal: this.abort.signal });
    on("loadedmetadata", () => {
      this.loaded = true;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.dataset.duration = String(duration);
      this.callbacks.loaded?.(duration);
      this.setState("ready");
      if (this.wantsPlay) this.play();
    });
    on("loadeddata", () => this.frame());
    on("playing", () => { this.setState("playing"); this.frame(); });
    on("pause", () => { this.updateTime(); this.setState("paused"); });
    on("ended", () => { this.wantsPlay = false; this.updateTime(); this.setState("ended"); });
    on("waiting", () => { if (this.wantsPlay) this.setState("loading"); });
    on("seeking", () => this.setState("loading"));
    on("seeked", () => { this.updateTime(); this.setState(video.paused ? "paused" : "playing"); });
    on("timeupdate", () => this.updateTime());
    on("progress", () => {
      const ranges: [number, number][] = [];
      for (let index = 0; index < video.buffered.length; index++) ranges.push([video.buffered.start(index), video.buffered.end(index)]);
      this.callbacks.buffered?.(ranges);
    });
    on("error", () => this.fail(new Error("视频加载失败，请重试或下载原视频。")));
    this.setState("preparing");
    void this.prepare(new URL(source, document.baseURI));
  }

  private async prepare(source: URL) {
    const status = new URL(source);
    status.searchParams.set("status", "true");
    const request = new AbortController();
    const cancel = () => request.abort();
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    const timeout = window.setTimeout(cancel, 15_000);
    try {
      const response = await fetch(status, { credentials: "same-origin", cache: "no-store", signal: request.signal });
      const result: unknown = await response.json();
      if (this.disposed) return;
      const state = result && typeof result === "object" && "state" in result ? result.state : undefined;
      if (response.status === 202 && (state === "queued" || state === "processing")) {
        source.searchParams.delete("retry");
        this.poll = window.setTimeout(() => { void this.prepare(source); }, 1500);
        return;
      }
      if (!response.ok || state !== "ready") {
        throw new Error(state === "failed" ? "视频准备失败，请重试或下载原视频。" : "无法加载视频，请重试。");
      }
      source.searchParams.delete("retry");
      this.setState("loading");
      this.video.src = source.href;
      this.video.load();
    } catch (error) {
      if (!this.disposed) this.fail(error);
    } finally {
      window.clearTimeout(timeout);
      this.abort.signal.removeEventListener("abort", cancel);
    }
  }

  private setState(state: PlayerState) {
    if (this.disposed) return;
    this.video.dataset.playerState = state;
    window.clearTimeout(this.timeout);
    if (state === "loading") this.timeout = window.setTimeout(() => this.fail(new Error("视频加载超时，请重试。")), 30_000);
    this.callbacks.state?.(state);
  }

  private frame() {
    if (this.framed || this.frameRequest || this.video.readyState < 2) return;
    const rendered = () => {
      this.frameRequest = 0;
      if (this.disposed || this.framed) return;
      this.framed = true;
      this.callbacks.frame?.();
    };
    if (this.video.requestVideoFrameCallback) this.frameRequest = this.video.requestVideoFrameCallback(rendered);
    else rendered();
  }

  private updateTime() {
    this.video.dataset.currentTime = String(this.video.currentTime);
    this.callbacks.time?.(this.video.currentTime);
  }

  private fail(reason: unknown) {
    if (this.disposed) return;
    this.setState("failed");
    this.callbacks.error?.(reason instanceof Error ? reason : new Error(String(reason)));
    this.destroy();
  }

  captureFrame() {
    if (this.disposed) return Promise.reject(new Error("视频已关闭，请重新打开后重试。"));
    return captureVideoFrame(this.video);
  }

  play() {
    if (this.disposed) return;
    this.wantsPlay = true;
    if (this.loaded) void this.video.play().catch(error => {
      if (this.disposed || !this.wantsPlay || error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError") {
        this.wantsPlay = false;
        this.setState("paused");
        this.callbacks.autoplayBlocked?.();
      } else this.fail(error);
    });
  }

  pause() {
    this.wantsPlay = false;
    if (!this.disposed) this.video.pause();
  }

  seek(seconds: number) {
    if (this.disposed || !this.loaded || !Number.isFinite(seconds) || !Number.isFinite(this.video.duration)) return;
    // Assign the newest target directly; repeated scrubs never queue old seeks.
    this.video.currentTime = Math.max(0, Math.min(seconds, this.video.duration));
    this.updateTime();
  }

  volume(value: number) {
    if (this.disposed) return;
    this.video.volume = Math.max(0, Math.min(value, 1));
    this.video.muted = value === 0;
    this.video.dataset.muted = String(this.video.muted);
  }

  rate(value: number) { if (!this.disposed) this.video.playbackRate = value; }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlay = false;
    window.clearTimeout(this.poll);
    window.clearTimeout(this.timeout);
    this.abort.abort();
    if (this.frameRequest) this.video.cancelVideoFrameCallback(this.frameRequest);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.dataset.playerState = "destroyed";
    this.video.remove();
  }
}
