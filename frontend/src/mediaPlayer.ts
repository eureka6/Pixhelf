import type AVPlayer from "@libmedia/avplayer/AVPlayer";
import { createMediaSource } from "./mediaSource";
import type { VideoFrame } from "./videoFrame";

type PlayerModule = typeof import("@libmedia/avplayer/AVPlayer");
export type PlayerState = "preparing" | "loading" | "ready" | "playing" | "paused" | "ended" | "failed";
export type PlayerCallbacks = {
  state?: (state: PlayerState) => void;
  loaded?: (duration: number) => void;
  audioUnsupported?: (unsupported: boolean) => void;
  autoplayBlocked?: () => void;
  buffered?: (ranges: [number, number][]) => void;
  frame?: () => void;
  time?: (seconds: number) => void;
  error?: (error: Error) => void;
};

export type VideoPlayer = Pick<MediaPlayer, "play" | "pause" | "seek" | "volume" | "rate" | "captureFrame" | "destroy">;

const assetBase = import.meta.env.DEV
  ? new URL("/assets/libmedia/", location.origin).href
  : new URL(/* @vite-ignore */ "./libmedia/", import.meta.url).href;
let library: Promise<PlayerModule> | undefined;

function loadLibrary(): Promise<PlayerModule> {
  return library ??= import(/* @vite-ignore */ `${assetBase}avplayer.js`).catch(error => {
    library = undefined;
    throw error;
  });
}

// One adapter owns the asynchronous command queue and the lifetime of each
// player. Both viewers and previews feed original HTTP Range bytes to libmedia.
export class MediaPlayer {
  private container: HTMLDivElement;
  private engine: AVPlayer | undefined;
  private sourceAbort = new AbortController();
  private pending: Promise<void>;
  private disposed = false;
  private failed = false;
  private resize: ResizeObserver;
  private timeout = 0;
  private clock = 0;
  private playing = false;
  private loaded = false;
  private duration = 0;
  private volumeValue = 1;
  private rateValue = 1;

  constructor(host: HTMLDivElement, source: string, filename: string,
    private muted: boolean, private callbacks: PlayerCallbacks = {}, cover = false) {
    const container = this.container = document.createElement("div");
    container.className = "media-player-surface";
    host.appendChild(container);
    container.dataset.player = "libmedia";
    container.dataset.muted = String(muted);
    this.volumeValue = muted ? 0 : 1;
    container.dataset.currentTime = "0";
    this.setState("loading");
    this.resize = new ResizeObserver(() => {
      if (!this.disposed) this.engine?.resize(container.clientWidth, container.clientHeight);
    });
    this.resize.observe(container);
    this.pending = this.initialize(source, filename, cover).catch(error => this.fail(error));
  }

  private async initialize(source: string, filename: string, cover: boolean) {
    const { default: Player, AVPlayerSupportedCodecs } = await loadLibrary();
    if (this.disposed) return;
    Player.setLogLevel(3);
    const engine = this.engine = new Player({
      container: this.container,
      wasmBaseUrl: `${assetBase}wasm`,
      // libmedia renders both WebCodecs and Wasm frames to its own canvas.
      checkUseMSE: () => false,
      enableWebGPU: false,
      enableWorker: true,
      loop: false,
      preLoadTime: this.muted ? 0.5 : 1,
    });
    engine.setVolume(this.volumeValue, true);
    engine.setRenderMode(cover ? 1 : 0);
    engine.on("firstVideoRendered", () => { if (!this.disposed && !this.failed) this.callbacks.frame?.(); });
    engine.on("played", () => {
      if (this.disposed) return;
      this.playing = true;
      window.clearInterval(this.clock);
      this.clock = window.setInterval(() => this.updateTime(), 200);
      this.setState("playing");
    });
    for (const state of ["paused", "ended"] as const) {
      engine.on(state, () => {
        this.playing = false;
        window.clearInterval(this.clock);
        this.updateTime();
        this.setState(state);
      });
    }
    engine.on("seeking", () => this.setState("loading"));
    engine.on("seeked", () => { this.updateTime(); this.setState(this.playing ? "playing" : "paused"); });
    engine.on("time", timestamp => this.updateTime(timestamp));
    engine.on("error", error => this.fail(error));
    engine.on("timeout", () => this.fail(new Error("视频加载超时，请重试。")));
    await engine.load(createMediaSource(Player, source, filename, this.sourceAbort.signal));
    if (this.disposed || this.failed) return;
    const streams = engine.getStreams();
    // libmedia 1.3.1's AVI table recognizes "XVID" but omits the lowercase
    // "xvid" tag used by these MPEG-4 Part 2 files. Correct the parsed codec
    // descriptor; the source bytes and decoding still belong to libmedia.
    if (filename.toLowerCase().endsWith(".avi")) {
      for (const stream of streams) {
        const codec = stream.codecparProxy;
        if (codec.codecType === 0 && codec.codecId === 0 && codec.codecTag === 0x64697678) codec.codecId = 12;
      }
    }
    const supported = (stream: typeof streams[number]) => AVPlayerSupportedCodecs.includes(stream.codecparProxy.codecId);
    if (!streams.some(stream => stream.codecparProxy.codecType === 0 && supported(stream))) {
      throw new Error("暂时无法播放此视频的格式或编码，可下载原视频后播放。");
    }
    this.loaded = true;
    engine.setPlaybackRate(this.rateValue);
    this.duration = Math.max(0, Number(engine.getDuration()) / 1000);
    this.container.dataset.duration = String(this.duration);
    this.callbacks.loaded?.(this.duration);
    this.setState("ready");
  }

  private setState(state: PlayerState) {
    if (this.disposed || (this.failed && state !== "failed")) return;
    this.container.dataset.playerState = state;
    window.clearTimeout(this.timeout);
    if (state === "loading") this.timeout = window.setTimeout(() => this.fail(new Error("视频加载超时，请重试。")), 30_000);
    this.callbacks.state?.(state);
  }

  private updateTime(timestamp?: bigint) {
    if (this.disposed || this.failed || !this.engine) return;
    const seconds = Math.max(0, Number(timestamp ?? this.engine.currentTime) / 1000);
    this.container.dataset.currentTime = String(seconds);
    this.callbacks.time?.(seconds);
  }

  private fail(reason: unknown) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.engine?.setVolume(0, true);
    this.setState("failed");
    this.callbacks.error?.(reason instanceof Error ? reason : new Error(String(reason)));
    this.destroy();
  }

  private enqueue(command: (engine: AVPlayer) => Promise<void>) {
    this.pending = this.pending.then(async () => {
      if (!this.disposed && !this.failed && this.engine) await command(this.engine);
    }).catch(error => this.fail(error));
  }

  async captureFrame(): Promise<VideoFrame> {
    await this.pending;
    if (this.disposed || this.failed || !this.loaded || !this.engine) throw new Error("当前画面尚未就绪，请稍后重试。");
    const time = Number(this.engine.currentTime) / 1000;
    const snapshot = this.engine.snapshot("jpeg", .9);
    if (!snapshot.startsWith("data:image/jpeg;base64,")) throw new Error("无法截取当前画面，请重试。");
    const bytes = Uint8Array.from(atob(snapshot.split(",")[1]!), character => character.charCodeAt(0));
    return { file: new File([bytes], `frame-${time.toFixed(3)}.jpg`, { type: "image/jpeg" }), time };
  }

  play() {
    // Resume the audio context directly in the click/tap call stack.
    if (!this.muted && this.engine?.isSuspended()) void this.engine.resume().catch(error => this.fail(error));
    this.enqueue(async engine => {
      if (this.playing) return;
      this.setState("loading");
      await engine.play({ audio: !this.muted, video: true, subtitle: !this.muted });
      if (!this.disposed && !engine.hasVideo()) throw new Error("暂时无法播放此视频的编码，可下载原视频后播放。");
      if (!this.disposed && !this.muted) this.callbacks.audioUnsupported?.(
        engine.getStreams().some(stream => stream.codecparProxy.codecType === 1) && !engine.hasAudio());
    });
  }

  pause() { this.enqueue(async engine => { if (this.playing) await engine.pause(); }); }
  seek(seconds: number) {
    this.enqueue(async engine => {
      if (this.loaded && this.container.dataset.playerState !== "ready") {
        await engine.seek(BigInt(Math.round(Math.max(0, Math.min(seconds, this.duration)) * 1000)));
      }
    });
  }
  volume(value: number) {
    this.volumeValue = value;
    if (!this.disposed) this.engine?.setVolume(value, true);
  }
  rate(value: number) {
    this.rateValue = value;
    if (!this.disposed && this.loaded) this.engine?.setPlaybackRate(value);
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.timeout);
    window.clearInterval(this.clock);
    this.resize.disconnect();
    this.engine?.setVolume(0, true);
    this.container.dataset.playerState = "destroyed";
    // Hide immediately; libmedia removes its canvas after pending IO settles.
    this.container.hidden = true;
    this.container.remove();
    this.sourceAbort.abort();
    void this.pending.then(() => this.engine?.destroy()).catch(() => {});
  }
}
