import { memo } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";
import { CARD_MENU_EVENT, CARD_TOUCH_EVENT, clearCardFeedback, markCardPreviewPlayed } from "./cardInteraction";
import { MediaPlayer, type PlayerCallbacks, type PlayerState, type VideoPlayer } from "./mediaPlayer";
import { NativeMediaPlayer } from "./nativeMediaPlayer";
import { acquireLivePhoto } from "./livePhotoCache";
import { canPreloadLivePhotos, preloadLivePhoto } from "./livePhotoPreload";
import type { GalleryImage } from "./types";
import { viewerOriginalUrl } from "./viewerAssets";
import { isAnimatedImage } from "./mediaUrls";

type PlaybackInput = "mouse" | "touch" | "keyboard" | "viewer";
export const MEDIA_PREVIEW_PLAY_EVENT = "pixhelf:media-preview-play";
let activePreview: { dispose: () => void; visibilityChanged: () => void } | null = null;

export function stopMediaPreview(): void { activePreview?.dispose(); }
document.addEventListener("visibilitychange", () => activePreview?.visibilityChanged());
window.addEventListener("pagehide", stopMediaPreview);

function animatedPreview(host: HTMLElement, source: string, callbacks: PlayerCallbacks) {
  const image = new Image();
  let timeout = 0;
  image.className = "animated-preview-image";
  image.alt = "";
  image.decoding = "async";
  image.draggable = false;
  image.onload = () => { window.clearTimeout(timeout); callbacks.state?.("playing"); callbacks.frame?.(); };
  image.onerror = () => callbacks.error?.(new Error("动图加载失败"));
  host.append(image);
  return {
    play() {
      if (image.hasAttribute("src")) return;
      timeout = window.setTimeout(() => callbacks.error?.(new Error("动图加载超时")), 15_000);
      image.src = source;
    },
    destroy() {
      window.clearTimeout(timeout);
      image.onload = image.onerror = null;
      image.removeAttribute("src");
      image.remove();
    },
  };
}

export const MediaPreview = memo(function MediaPreview({ image, autoPlay = false, paused = false, playbackRequest = 0, onStateChange }: {
  image: GalleryImage; autoPlay?: boolean; paused?: boolean; playbackRequest?: number; onStateChange?: (state: PlayerState) => void;
}) {
  const isVideo = Boolean(image.video);
  const animated = isAnimatedImage(image);
  // Live Photos own their original playback; only ordinary videos use prepared previews.
  const preview = isVideo ? image.preview : undefined;
  const source = preview ?? (isVideo || animated ? viewerOriginalUrl(image) : image.motion);
  const layerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<{ pause: (paused: boolean) => void; restart: () => void } | null>(null);
  const previousRequest = useRef(playbackRequest);
  const latest = useRef({ paused, playbackRequest, onStateChange });
  latest.current = { paused, playbackRequest, onStateChange };

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const viewport = viewportRef.current;
    const card = layer?.parentElement;
    if (!source || !layer || !viewport || !card) return;
    previousRequest.current = playbackRequest;
    const blocked = () => latest.current.paused || document.hidden || (autoPlay && (!visible || !focused))
      || card.closest("[inert]") || card.querySelector(".photo-card-menu");
    let player: (Pick<VideoPlayer, "play" | "destroy"> & { readonly warm?: boolean; pause?: () => void; prepareReplay?: () => void }) | null = null;
    let input: PlaybackInput = "mouse";
    let completed = false;
    let failed = false;
    let generation = 0;
    let active = false;
    let suspended = false;
    let visible = true;
    let focused = true;
    let framed = false;
    let idleTimer = 0;
    let playbackListeners: AbortController | null = null;
    let visibility: IntersectionObserver | null = null;
    let viewerVisibility: IntersectionObserver | null = null;
    let preloadVisibility: IntersectionObserver | null = null;
    let preloadTimer = 0;
    let releasePreload: (() => void) | undefined;
    delete layer.dataset.failed;

    const stopPreload = () => {
      window.clearTimeout(preloadTimer);
      preloadTimer = 0;
      releasePreload?.();
      releasePreload = undefined;
    };

    const notify = (state: PlayerState) => {
      layer.dataset.playbackState = state;
      latest.current.onStateChange?.(state);
    };
    const detachPlayback = (keepFrame = false) => {
      playbackListeners?.abort();
      playbackListeners = null;
      visibility?.disconnect();
      visibility = null;
      layer.dataset.playing = String(keepFrame);
      layer.dataset.loading = "false";
      clearCardFeedback(card);
    };
    const dispose = (notifyChange = true) => {
      generation++;
      if (notifyChange && active) notify("paused");
      active = false;
      window.clearTimeout(idleTimer);
      detachPlayback();
      // The transition has already copied the retained end frame. Rewind only
      // when releasing it, so a later gallery/viewer visit can replay normally.
      if (completed) player?.prepareReplay?.();
      player?.destroy();
      player = null;
      if (activePreview === controller) activePreview = null;
    };
    const suspend = () => {
      if (!active || suspended) return;
      suspended = true;
      layer.dataset.loading = "false";
      player?.pause?.();
      notify("paused");
    };
    const stop = () => {
      if (!active) return;
      active = false;
      const keepFrame = completed && autoPlay && latest.current.playbackRequest > 0 && framed && !failed;
      detachPlayback(keepFrame);
      notify(completed ? "ended" : "paused");
      if (player?.prepareReplay && framed && !failed) {
        // Keep this surface ready for immediate replay. Handoffs and unmounts
        // return the paused decoder to the bounded cache shared with the viewer.
        // A slideshow snapshots the last motion frame for the next slide.
        // Rewinding or revealing the poster here inserts a still-photo flash.
        if (completed && !keepFrame) player.prepareReplay();
        else player.pause?.();
        if (!keepFrame) idleTimer = window.setTimeout(dispose, 60_000);
      } else dispose();
    };
    const start = (nextInput: PlaybackInput) => {
      if (failed || blocked()) return;
      input = autoPlay ? "viewer" : nextInput;
      if (active) { suspended = false; player?.play(); return; }
      if (activePreview !== controller) stopMediaPreview();
      activePreview = controller;
      window.clearTimeout(idleTimer);
      active = true;
      suspended = false;
      if (completed) player?.prepareReplay?.();
      completed = false;
      layer.dataset.loading = "true";
      notify("loading");
      if (!player) {
        framed = false;
        const attempt = ++generation;
        const current = () => generation === attempt;
        const callbacks: PlayerCallbacks = {
          state(state) {
            if (!current() || !active) return;
            if (state === "ended") { completed = true; stop(); }
            else if (!suspended) {
              layer.dataset.loading = String(state === "loading" || state === "preparing");
              if (state !== "playing" || framed) notify(state);
            }
          },
          frame() {
            if (!current() || !active || suspended) return;
            layer.dataset.playing = "true";
            layer.dataset.loading = "false";
            framed = true;
            notify("playing");
            markCardPreviewPlayed(image.id);
          },
          error() {
            if (!current()) return;
            failed = true;
            layer.dataset.failed = "true";
            layer.title = isVideo ? "暂时无法预览此视频，可打开播放器或下载原视频" : "暂时无法预览动态，可打开图片重试";
            dispose(false);
            notify("failed");
          },
        };
        player = animated ? animatedPreview(viewport, source, callbacks)
          : !isVideo ? acquireLivePhoto(viewport, source, callbacks, autoPlay)
          : preview ? new NativeMediaPlayer(viewport, source, image.name, true, callbacks, true)
          : new MediaPlayer(viewport, source, image.name, true, callbacks, true);
        if (autoPlay && playbackRequest && player.warm) player.prepareReplay?.();
      }
      // Attach the player before releasing the preload's ownership, so an
      // in-progress original download continues without restarting.
      layer.dataset.warm = String(Boolean(player.warm));
      stopPreload();
      player.play();
      playbackListeners = new AbortController();
      const options = { capture: true, passive: true, signal: playbackListeners.signal };
      document.addEventListener("scroll", () => { if (input === "mouse" || input === "keyboard") stop(); }, options);
      document.addEventListener("pointerdown", event => {
        if (!autoPlay && event.pointerType === "mouse" && event.target instanceof Node && !card.contains(event.target)) stop();
      }, options);
      if (!autoPlay) {
        visibility = new IntersectionObserver(entries => {
          if (active && entries.some(entry => !entry.isIntersecting)) stop();
        });
        visibility.observe(card);
      }
    };
    const controller = { dispose, visibilityChanged() {
      if (document.hidden) {
        if (autoPlay) suspend();
        else dispose();
      } else if (autoPlay && !completed) start("viewer");
    } };
    const listeners = new AbortController();
    const options = { passive: true, signal: listeners.signal };
    window.addEventListener("blur", event => {
      if (event.target !== window) return;
      focused = false;
      if (autoPlay) suspend();
      else dispose();
    }, options);
    window.addEventListener("focus", event => {
      if (event.target !== window) return;
      focused = true;
      if (autoPlay && !completed) start("viewer");
    }, options);
    if (!autoPlay && !isVideo && !animated) {
      const schedulePreload = () => {
        stopPreload();
        if (player || blocked() || !canPreloadLivePhotos()) return;
        const bounds = card.getBoundingClientRect();
        if (bounds.bottom <= 0 || bounds.top >= innerHeight || bounds.right <= 0 || bounds.left >= innerWidth) return;
        // Briefly passing a card while scrolling should not download its clip.
        preloadTimer = window.setTimeout(() => {
          preloadTimer = 0;
          if (!player && !blocked() && canPreloadLivePhotos()) releasePreload = preloadLivePhoto(source);
        }, 250);
      };
      preloadVisibility = new IntersectionObserver(entries => {
        if (entries.at(-1)?.isIntersecting) schedulePreload();
        else stopPreload();
      });
      preloadVisibility.observe(card);
      document.addEventListener("visibilitychange", schedulePreload, options);
    }
    if (autoPlay) {
      controlRef.current = {
        pause(paused) {
          if (paused) suspend();
          else if (!completed) start("viewer");
        },
        restart() { stop(); player?.prepareReplay?.(); completed = false; start("viewer"); },
      };
      card.addEventListener(MEDIA_PREVIEW_PLAY_EVENT, () => start("viewer"), options);
      viewerVisibility = new IntersectionObserver(entries => {
        const entry = entries.at(-1);
        if (!entry) return;
        visible = entry.isIntersecting;
        if (visible && !completed) start("viewer");
        else if (!visible) suspend();
      });
      viewerVisibility.observe(card);
      start("viewer");
    } else {
      card.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") start("mouse"); }, options);
      card.addEventListener("pointerleave", event => { if (event.pointerType === "mouse" && input === "mouse") stop(); }, options);
      card.addEventListener(CARD_TOUCH_EVENT, () => start("touch"), options);
      card.addEventListener("focusin", event => {
        if (event.target instanceof Element && event.target.matches(".photo-card-open:focus-visible")) start("keyboard");
      }, options);
      card.addEventListener("focusout", () => { if (input === "keyboard") stop(); }, options);
      if (window.matchMedia("(hover: hover) and (pointer: fine)").matches && card.matches(":hover")) start("mouse");
    }
    card.addEventListener(CARD_MENU_EVENT, () => { if (autoPlay) suspend(); else dispose(); }, options);
    return () => { controlRef.current = null; listeners.abort(); viewerVisibility?.disconnect(); preloadVisibility?.disconnect(); stopPreload(); dispose(false); };
  }, [image.id, preview, source, image.name, autoPlay, isVideo, animated]);

  useLayoutEffect(() => { controlRef.current?.pause(paused); }, [paused]);
  useLayoutEffect(() => {
    if (playbackRequest && playbackRequest !== previousRequest.current) controlRef.current?.restart();
    previousRequest.current = playbackRequest;
  }, [playbackRequest]);

  if (!source) return null;
  return (
    <div ref={layerRef} className={`media-preview${isVideo ? " video-preview" : ""}`} data-playing="false" data-loading="false" title={isVideo ? "视频预览" : animated ? "GIF 动图" : "live 照片"}>
      <div className="media-preview-viewport" aria-hidden="true"><div ref={viewportRef} className="media-preview-player" /></div>
      {animated ? <span className="gif-badge" aria-hidden="true">GIF</span> : !isVideo && <span className="live-photo-badge" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeDasharray="1.4 2" />
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" />
        </svg>live
      </span>}
      <span className="media-preview-loading" role="progressbar" aria-label={isVideo ? "加载视频预览" : animated ? "加载 GIF" : "加载 live"} />
    </div>
  );
});
