import { memo } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";
import { CARD_MENU_EVENT, CARD_TOUCH_EVENT, clearCardFeedback, markCardPreviewPlayed } from "./cardInteraction";
import { MediaPlayer, type VideoPlayer } from "./mediaPlayer";
import { NativeMediaPlayer } from "./nativeMediaPlayer";
import type { GalleryImage } from "./types";
import { viewerOriginalUrl } from "./viewerAssets";

type PlaybackInput = "mouse" | "touch" | "keyboard" | "viewer";
export const MEDIA_PREVIEW_PLAY_EVENT = "pixhelf:media-preview-play";
let stopActivePlayback: (() => void) | null = null;

export function stopMediaPreview(): void { stopActivePlayback?.(); }
document.addEventListener("visibilitychange", () => { if (document.hidden) stopMediaPreview(); });
window.addEventListener("pagehide", stopMediaPreview);

export const MediaPreview = memo(function MediaPreview({ image, autoPlay = false }: {
  image: GalleryImage; autoPlay?: boolean;
}) {
  const isVideo = Boolean(image.video);
  const source = image.preview ?? (isVideo ? viewerOriginalUrl(image) : image.motion);
  const layerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const viewport = viewportRef.current;
    const card = layer?.parentElement;
    if (!source || !layer || !viewport || !card) return;
    const blocked = () => document.hidden || card.closest("[inert]") || card.querySelector(".photo-card-menu");
    let player: VideoPlayer | null = null;
    let input: PlaybackInput = "mouse";
    let completed = false;
    let failed = false;
    let generation = 0;
    let playbackListeners: AbortController | null = null;
    let visibility: IntersectionObserver | null = null;
    let viewerVisibility: IntersectionObserver | null = null;
    delete layer.dataset.failed;

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
      if (player) return;
      stopActivePlayback?.();
      stopActivePlayback = stop;
      completed = false;
      const attempt = ++generation;
      const current = () => generation === attempt;
      layer.dataset.loading = "true";
      const Player = image.preview ? NativeMediaPlayer : MediaPlayer;
      player = new Player(viewport, source, isVideo ? image.name : "motion.mov", true, {
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
          layer.title = isVideo ? "暂时无法预览此视频，可打开播放器或下载原视频" : "暂时无法播放此 live，仍可查看照片";
          stop();
        },
      }, true);
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
    return () => { listeners.abort(); viewerVisibility?.disconnect(); stop(); };
  }, [image.id, image.preview, source, image.name, autoPlay, isVideo]);

  if (!source) return null;
  return (
    <div ref={layerRef} className={`media-preview${isVideo ? " video-preview" : ""}`} data-playing="false" data-loading="false" title={isVideo ? "视频预览" : "live 照片"}>
      <div className="media-preview-viewport" aria-hidden="true"><div ref={viewportRef} className="media-preview-player" /></div>
      {!isVideo && <span className="live-photo-badge" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeDasharray="1.4 2" />
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" />
        </svg>live
      </span>}
      <span className="media-preview-loading" role="progressbar" aria-label={isVideo ? "加载视频预览" : "加载 live"} />
    </div>
  );
});
