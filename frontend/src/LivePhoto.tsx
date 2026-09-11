import { memo } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";
import { CARD_MENU_EVENT, CARD_TOUCH_EVENT, clearCardFeedback, markLivePhotoPlayed } from "./cardInteraction";
import type { GalleryImage } from "./types";
import { viewerThumbnailUrl } from "./viewerAssets";

type PlaybackInput = "mouse" | "touch" | "keyboard" | "viewer";
export const LIVE_PHOTO_PLAY_EVENT = "pixhelf:live-photo-play";
const VIEWER_VIDEO_MAX_EDGE = 1440;
const VIEWER_VIDEO_FRAME_INTERVAL = 1000 / 30;
const IS_WEBKIT = /AppleWebKit\//.test(navigator.userAgent)
  && !/(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
let stopActivePlayback: ((release?: boolean) => void) | null = null;
let player: HTMLVideoElement | null = null;
let lifecycleInstalled = false;

function releasePlayer(): void {
  if (!player || stopActivePlayback) return;
  player.pause();
  if (player.hasAttribute("src")) {
    player.removeAttribute("src");
    player.load();
  }
  player.remove();
  player = null;
}

function acquirePlayer(viewport: HTMLDivElement): HTMLVideoElement {
  // Reuse within a card; moving a decoded surface into the viewer can paint black.
  if (player && player.parentElement !== viewport) releasePlayer();
  if (!player) {
    player = document.createElement("video");
    player.className = "live-photo-video";
    player.muted = player.defaultMuted = true;
    player.setAttribute("muted", "");
    player.setAttribute("playsinline", "");
    player.setAttribute("webkit-playsinline", "");
    player.loop = false;
    player.preload = "auto";
    player.disablePictureInPicture = true;
    player.tabIndex = -1;
  }
  if (!lifecycleInstalled) {
    lifecycleInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopLivePhotoPlayback();
    });
    window.addEventListener("pagehide", stopLivePhotoPlayback);
  }
  return player;
}

export function stopLivePhotoPlayback(): void {
  stopActivePlayback?.();
  releasePlayer();
}

function bufferedPercent(video: HTMLVideoElement | null): number {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return 0;
  const ranges = video.buffered;
  let buffered = 0;
  for (let i = 0; i < ranges.length; i++) buffered += ranges.end(i) - ranges.start(i);
  return Math.min(100, Math.floor(buffered / video.duration * 100));
}

function createFramePainter(canvas: HTMLCanvasElement | null) {
  const context = canvas?.getContext("2d", { alpha: false });
  if (!canvas || !context) {
    if (canvas) canvas.hidden = true;
    return null;
  }
  let lastPaintAt = -Infinity;
  let lastPaintTime = -1;
  return (video: HTMLVideoElement, firstFrame: boolean): boolean => {
    const now = performance.now();
    const elapsed = now - lastPaintAt;
    if (!firstFrame && (elapsed < VIEWER_VIDEO_FRAME_INTERVAL || lastPaintTime === video.currentTime)) return false;
    const scale = Math.min(1, VIEWER_VIDEO_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    // Copy decoded pixels to avoid black native HEVC surfaces in transformed layers.
    try { context.drawImage(video, 0, 0, width, height); }
    catch { return false; }
    lastPaintAt = firstFrame ? now : now - elapsed % VIEWER_VIDEO_FRAME_INTERVAL;
    lastPaintTime = video.currentTime;
    return true;
  };
}

export const LivePhoto = memo(function LivePhoto({ image, autoPlay = false }: { image: GalleryImage; autoPlay?: boolean }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const viewport = viewportRef.current;
    const card = layer?.parentElement;
    const source = image.motion;
    if (!layer || !viewport || !card || !source) return;
    const sourceUrl = new URL(source, document.baseURI).href;
    const canvas = canvasRef.current;
    const paintImage = createFramePainter(canvas);
    const blocked = () => document.hidden || card.closest("[inert]") || card.querySelector(".photo-card-menu");
    layer.title = "live 照片";
    delete layer.dataset.failed;
    let video: HTMLVideoElement | null = null;
    let active = false;
    let completed = false;
    let failed = false;
    let generation = 0;
    let videoFrame = 0;
    let paintFrame = 0;
    let resumeFrame = 0;
    let dimensionTimer = 0;
    let bufferResumeTimer = 0;
    let bufferResumeUsed = false;
    let resumeAttempts = 0;
    let playPending = false;
    let waiting = false;
    let waitingAt = 0;
    let input: PlaybackInput = "mouse";
    let playbackListeners: AbortController | null = null;
    let visibility: IntersectionObserver | null = null;
    let viewerVisibility: IntersectionObserver | null = null;
    const updateLoadingProgress = () => {
      if (!active || layer.dataset.loading !== "true") return;
      const percent = bufferedPercent(video);
      layer.dataset.bufferKnown = String(percent > 0);
      layer.style.setProperty("--live-buffer-progress", String(percent / 100));
      if (percent > 0) progressRef.current?.setAttribute("aria-valuenow", String(percent));
      else progressRef.current?.removeAttribute("aria-valuenow");
    };
    const setLoading = (loading: boolean) => {
      if (layer.dataset.loading === String(loading)) return;
      layer.dataset.loading = String(loading);
      if (loading) updateLoadingProgress();
    };
    const stop = (release = true) => {
      generation++;
      active = false;
      playPending = false;
      waiting = false;
      setLoading(false);
      playbackListeners?.abort();
      playbackListeners = null;
      visibility?.disconnect();
      visibility = null;
      if (videoFrame) video?.cancelVideoFrameCallback?.(videoFrame);
      videoFrame = 0;
      cancelAnimationFrame(paintFrame);
      paintFrame = 0;
      cancelAnimationFrame(resumeFrame);
      resumeFrame = 0;
      window.clearTimeout(dimensionTimer);
      dimensionTimer = 0;
      window.clearTimeout(bufferResumeTimer);
      bufferResumeTimer = 0;
      clearCardFeedback(card);
      layer.dataset.playing = "false";
      // Cleanup may release this card's completed player, never another card's.
      if (stopActivePlayback === stop) {
        stopActivePlayback = null;
        video?.pause();
      }
      if (release && !stopActivePlayback && player?.parentElement === viewport) releasePlayer();
    };
    const fail = () => {
      if (!active) return;
      failed = true;
      layer.title = "当前浏览器无法播放此 live，仍可查看照片";
      layer.dataset.failed = "true";
      stop();
    };
    const play = () => {
      if (playPending || !active || !video) return;
      const attempt = generation;
      playPending = true;
      setLoading(true);
      void video.play().then(() => {
        if (generation === attempt) playPending = false;
      }).catch((error: unknown) => {
        if (!active || generation !== attempt || stopActivePlayback !== stop) return;
        playPending = false;
        // A tap can retry in browsers requiring a fresh user gesture.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          waiting = false;
          setLoading(false);
          return;
        }
        // Visibility and source changes can asynchronously interrupt play().
        if (error instanceof DOMException && error.name === "AbortError") { resume(); return; }
        if (error instanceof DOMException && error.name === "NotSupportedError") fail();
        else stop();
      });
    };
    const resume = () => {
      if (!active || video?.ended || resumeFrame || resumeAttempts >= 2 || document.hidden) return;
      const attempt = generation;
      resumeFrame = requestAnimationFrame(() => {
        resumeFrame = 0;
        if (!active || generation !== attempt || !video?.paused || video.ended || !card.isConnected || blocked()) return;
        resumeAttempts++;
        play();
      });
    };
    const showFrame = () => {
      if (!active || !video || video.paused || video.seeking || video.currentSrc !== sourceUrl
        || video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2) return;
      if (paintImage && !paintImage(video, layer.dataset.playing !== "true")) return;
      window.clearTimeout(dimensionTimer);
      dimensionTimer = 0;
      resumeAttempts = 0;
      if (layer.dataset.playing !== "true") {
        layer.dataset.playing = "true";
        markLivePhotoPlayed(image.id);
      }
      // WebKit can keep HAVE_CURRENT_DATA during a fully buffered replay. A
      // drawable frame with an advancing clock also means playback resumed.
      if (video.readyState >= 3 || Math.abs(video.currentTime - waitingAt) > 0.03) waiting = false;
      if (!waiting) setLoading(false);
    };
    const paint = () => {
      paintFrame = 0;
      if (!active) return;
      showFrame();
      // Compositor frame callbacks can stop when the canvas covers the video.
      // This loop copies at most 30 frames/s, without CPU pixel reads or caches.
      paintFrame = requestAnimationFrame(paint);
    };
    const loaded = () => {
      showFrame();
      if (!active || !video || video.currentSrc !== sourceUrl || dimensionTimer
        || (video.videoWidth > 0 && video.videoHeight > 0)) return;
      layer.dataset.playing = "false";
      const attempt = generation;
      // Some decoders expose audio before their first video dimensions. Allow
      // resize/loadeddata to supply the frame before treating it as audio-only.
      dimensionTimer = window.setTimeout(() => {
        dimensionTimer = 0;
        if (active && generation === attempt && video?.currentSrc === sourceUrl
          && video.readyState >= 2 && (video.videoWidth === 0 || video.videoHeight === 0)) fail();
      }, 1000);
    };
    const watchBufferedPlayback = () => {
      if (!IS_WEBKIT || bufferResumeUsed || !active || !video) return;
      window.clearTimeout(bufferResumeTimer);
      const attempt = generation;
      const stalledAt = video.currentTime;
      bufferResumeTimer = window.setTimeout(() => {
        bufferResumeTimer = 0;
        if (!active || generation !== attempt || !video || video.paused || video.ended
          || video.seeking || video.videoWidth === 0 || Math.abs(video.currentTime - stalledAt) > 0.03) return;
        // WebKit can stop its clock after announcing playing, even with decoded
        // frames buffered. Resume once, without seeking, replacing src or load().
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime
            && video.buffered.end(i) > video.currentTime + 0.15) {
            bufferResumeUsed = true;
            video.pause();
            resume();
            break;
          }
        }
      }, 600);
    };
    const playing = () => {
      if (!active || !video) return;
      watchBufferedPlayback();
      waiting = false;
      showFrame();
      // loadeddata may have already drawn this frame before playing is emitted.
      if (layer.dataset.playing === "true") setLoading(false);
      // Keep a decoder frame callback for the first presented frame.
      if (video.requestVideoFrameCallback && !videoFrame) {
        videoFrame = video.requestVideoFrameCallback(() => {
          videoFrame = 0;
          showFrame();
        });
      }
    };
    const buffering = () => {
      if (!active || !video || video.ended) return;
      watchBufferedPlayback();
      if (!video.seeking && video.readyState >= 3) return;
      waiting = true;
      waitingAt = video.currentTime;
      setLoading(true);
      updateLoadingProgress();
    };
    const start = (nextInput: PlaybackInput) => {
      if (autoPlay) nextInput = "viewer";
      if (failed || blocked()) return;
      if (active) {
        resumeAttempts = 0;
        if (nextInput === "touch" || nextInput === "viewer") input = nextInput;
        if (video?.paused) play();
        return;
      }
      stopActivePlayback?.(false);
      video = acquirePlayer(viewport);
      stopActivePlayback = stop;
      active = true;
      completed = false;
      bufferResumeUsed = false;
      resumeAttempts = 0;
      input = nextInput;
      const attempt = ++generation;
      playbackListeners = new AbortController();
      const options = { capture: true, passive: true, signal: playbackListeners.signal };
      const stopHover = () => { if (input === "mouse" || input === "keyboard") stop(); };
      document.addEventListener("scroll", stopHover, options);
      window.addEventListener("blur", event => { if (event.target === window) stop(); }, options);
      document.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse" && event.target instanceof Node && !card.contains(event.target)) stop();
      }, options);
      if (!autoPlay) {
        visibility = new IntersectionObserver(entries => {
          if (active && generation === attempt && entries.some(entry => !entry.isIntersecting)) stop();
        });
        visibility.observe(card);
      }
      video.addEventListener("playing", playing, options);
      for (const event of ["waiting", "stalled", "seeking"]) video.addEventListener(event, buffering, options);
      for (const event of ["progress", "loadedmetadata"]) video.addEventListener(event, updateLoadingProgress, options);
      for (const event of ["loadeddata", "seeked", "resize"]) video.addEventListener(event, loaded, options);
      video.addEventListener("pause", resume, options);
      video.addEventListener("timeupdate", showFrame, options);
      video.addEventListener("ended", () => {
        completed = true;
        // WebKit needs a fresh decoder to retain QuickTime rotation on replay.
        stop(IS_WEBKIT);
      }, options);
      video.addEventListener("error", fail, options);
      if (!video.muted) video.muted = true;
      const poster = viewerThumbnailUrl(image);
      if (video.getAttribute("poster") !== poster) video.poster = poster;
      if (video.parentElement !== viewport) viewport.appendChild(video);
      // Only a repeat interaction within this same card keeps its source.
      if (video.getAttribute("src") !== source) video.src = source;
      play();
      showFrame();
      if (paintImage && !paintFrame) paintFrame = requestAnimationFrame(paint);
    };
    const listeners = new AbortController();
    const options = { passive: true, signal: listeners.signal };
    if (autoPlay) {
      // The viewer dispatches this only for a tap, excluding drags and pinches.
      card.addEventListener(LIVE_PHOTO_PLAY_EVENT, () => start("viewer"), options);
    } else {
      card.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") start("mouse"); }, options);
      card.addEventListener("pointerleave", event => {
        if (event.pointerType === "mouse" && input === "mouse") stop(false);
      }, options);
      card.addEventListener(CARD_TOUCH_EVENT, () => start("touch"), options);
      card.addEventListener("click", () => { if (active && video?.paused) play(); }, options);
      card.addEventListener("focusin", event => {
        if (event.target instanceof Element && event.target.matches(".photo-card-open:focus-visible")) start("keyboard");
      }, options);
      card.addEventListener("focusout", () => { if (input === "keyboard") stop(); }, options);
    }
    card.addEventListener(CARD_MENU_EVENT, () => stop(), options);
    if (autoPlay) {
      let wasVisible = false;
      // Resume interrupted playback after a temporary non-visible layout, but
      // leave a completed clip stopped until the user taps the photo.
      viewerVisibility = new IntersectionObserver(entries => {
        const entry = entries.at(-1);
        if (!entry) return;
        if (entry.isIntersecting) {
          wasVisible = true;
          if (!completed) start("viewer");
        }
        else if (!completed) stop(wasVisible);
      });
      viewerVisibility.observe(card);
      start("viewer"); // Keep autoplay in the mounting/user-gesture call stack.
    } else if (window.matchMedia("(hover: hover) and (pointer: fine)").matches && card.matches(":hover")) start("mouse");
    return () => {
      listeners.abort();
      viewerVisibility?.disconnect();
      stop();
      if (canvas) canvas.width = canvas.height = 1;
    };
  }, [image.id, image.motion, autoPlay]);

  if (!image.motion) return null;
  return (
    <div ref={layerRef} className="live-photo" data-playing="false" data-loading="false" title="live 照片">
      <div ref={viewportRef} className="live-photo-viewport" aria-hidden="true">
        {autoPlay && <canvas ref={canvasRef} className="live-photo-canvas" width={1} height={1} />}
      </div>
      <span className="live-photo-badge" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeDasharray="1.4 2" />
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" />
          <circle cx="8" cy="8" r="1" fill="currentColor" />
        </svg>
        live
      </span>
      <span ref={progressRef} className="live-photo-loading" role="progressbar" aria-label="加载 live" aria-valuemin={0} aria-valuemax={100}>
        <span className="live-photo-progress" />
      </span>
    </div>
  );
});
