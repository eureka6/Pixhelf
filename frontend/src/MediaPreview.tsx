import { memo } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";
import { CARD_MENU_EVENT, CARD_TOUCH_EVENT, clearCardFeedback, markCardPreviewPlayed } from "./cardInteraction";
import { MediaPlayer, type PlayerCallbacks, type VideoPlayer } from "./mediaPlayer";
import { NativeMediaPlayer } from "./nativeMediaPlayer";
import { LivePhotoPlayer } from "./livePhotoPlayer";
import { canPreloadLivePhotos, preloadLivePhoto } from "./livePhotoPreload";
import type { GalleryImage } from "./types";
import { viewerOriginalUrl } from "./viewerAssets";
import { isAnimatedImage } from "./mediaUrls";

type PlaybackInput = "mouse" | "touch" | "keyboard" | "viewer";
export const MEDIA_PREVIEW_PLAY_EVENT = "pixhelf:media-preview-play";
let stopActivePlayback: (() => void) | null = null;

export function stopMediaPreview(): void { stopActivePlayback?.(); }
document.addEventListener("visibilitychange", () => { if (document.hidden) stopMediaPreview(); });
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

export const MediaPreview = memo(function MediaPreview({ image, autoPlay = false }: {
  image: GalleryImage; autoPlay?: boolean;
}) {
  const isVideo = Boolean(image.video);
  const animated = isAnimatedImage(image);
  // Live Photos own their original playback; only ordinary videos use prepared previews.
  const preview = isVideo ? image.preview : undefined;
  const source = preview ?? (isVideo || animated ? viewerOriginalUrl(image) : image.motion);
  const layerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const viewport = viewportRef.current;
    const card = layer?.parentElement;
    if (!source || !layer || !viewport || !card) return;
    const blocked = () => document.hidden || card.closest("[inert]") || card.querySelector(".photo-card-menu");
    let player: Pick<VideoPlayer, "play" | "destroy"> | null = null;
    let input: PlaybackInput = "mouse";
    let completed = false;
    let failed = false;
    let generation = 0;
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

    const stop = () => {
      generation++;
      playbackListeners?.abort();
      playbackListeners = null;
      visibility?.disconnect();
      visibility = null;
      player?.destroy();
      player = null;
      if (stopActivePlayback === stop) stopActivePlayback = null;
      layer.dataset.playing = layer.dataset.loading = "false";
      clearCardFeedback(card);
    };
    const start = (nextInput: PlaybackInput) => {
      if (failed || blocked()) return;
      input = autoPlay ? "viewer" : nextInput;
      if (player) { player.play(); return; }
      stopActivePlayback?.();
      stopActivePlayback = stop;
      completed = false;
      const attempt = ++generation;
      const current = () => generation === attempt;
      layer.dataset.loading = "true";
      const callbacks: PlayerCallbacks = {
        state(state) {
          if (!current()) return;
          layer.dataset.loading = String(state === "loading" || state === "preparing");
          if (state === "ended") { completed = true; stop(); }
        },
        frame() {
          if (!current()) return;
          layer.dataset.playing = "true";
          layer.dataset.loading = "false";
          markCardPreviewPlayed(image.id);
        },
        error() {
          if (!current()) return;
          failed = true;
          layer.dataset.failed = "true";
          layer.title = isVideo ? "暂时无法预览此视频，可打开播放器或下载原视频" : "暂时无法预览动态，可打开图片重试";
          stop();
        },
      };
      player = animated ? animatedPreview(viewport, source, callbacks)
        : !isVideo ? new LivePhotoPlayer(viewport, source, callbacks, autoPlay)
        : preview ? new NativeMediaPlayer(viewport, source, image.name, true, callbacks, true)
        : new MediaPlayer(viewport, source, image.name, true, callbacks, true);
      // Attach the player before releasing the preload's ownership, so an
      // in-progress original download continues without restarting.
      stopPreload();
      player.play();
      playbackListeners = new AbortController();
      const options = { capture: true, passive: true, signal: playbackListeners.signal };
      document.addEventListener("scroll", () => { if (input === "mouse" || input === "keyboard") stop(); }, options);
      window.addEventListener("blur", event => { if (event.target === window) stop(); }, options);
      document.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse" && event.target instanceof Node && !card.contains(event.target)) stop();
      }, options);
      if (!autoPlay) {
        visibility = new IntersectionObserver(entries => {
          if (current() && entries.some(entry => !entry.isIntersecting)) stop();
        });
        visibility.observe(card);
      }
    };
    const listeners = new AbortController();
    const options = { passive: true, signal: listeners.signal };
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
      card.addEventListener(MEDIA_PREVIEW_PLAY_EVENT, () => start("viewer"), options);
      viewerVisibility = new IntersectionObserver(entries => {
        const entry = entries.at(-1);
        if (entry?.isIntersecting && !completed) start("viewer");
        else if (entry && !entry.isIntersecting && !completed) stop();
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
    card.addEventListener(CARD_MENU_EVENT, stop, options);
    return () => { listeners.abort(); viewerVisibility?.disconnect(); preloadVisibility?.disconnect(); stopPreload(); stop(); };
  }, [image.id, preview, source, image.name, autoPlay, isVideo, animated]);

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
