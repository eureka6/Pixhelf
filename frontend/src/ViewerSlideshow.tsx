import { createContext, type ComponentChildren, type RefObject } from "preact";
import { useContext, useLayoutEffect, useRef, useState, type StateUpdater } from "preact/hooks";
import type { GalleryImage } from "./types";
import type { PlayerState } from "./mediaPlayer";
import { preloadLivePhoto } from "./livePhotoPreload";

const SLIDE_INTERVAL_MS = 5_000;
const LIVE_PHOTO_END_HOLD_MS = 2_000;
const SlideshowPause = createContext<{ paused: boolean; setPaused: (value: StateUpdater<boolean>) => void }>({ paused: false, setPaused: () => {} });

export function SlideshowSession({ request, children }: { request: number; children: ComponentChildren }) {
  const [paused, setPaused] = useState(false);
  useLayoutEffect(() => { setPaused(false); }, [request]);
  return <SlideshowPause.Provider value={{ paused, setPaused }}>{children}</SlideshowPause.Provider>;
}

export const useSlideshowPause = () => useContext(SlideshowPause);

type SlideshowProps = {
  viewerRef: RefObject<HTMLElement>;
  images: GalleryImage[];
  activeIndex: number;
  hasMore: boolean;
  ready: boolean;
  blocked: boolean;
  mediaState?: PlayerState;
  onLoadMore: () => Promise<GalleryImage[]>;
  onOpen: (image: GalleryImage) => void;
  onPlayingChange: (playing: boolean) => void;
  onPlaybackChange?: (running: boolean) => void;
};

export function ViewerSlideshow(props: SlideshowProps) {
  const { viewerRef, activeIndex, images, blocked, ready, mediaState, onPlayingChange, onPlaybackChange } = props;
  const { paused, setPaused } = useSlideshowPause();
  const [due, setDue] = useState<string | undefined>();
  const [available, setAvailable] = useState(!document.hidden);
  const windowFocused = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const imageId = images[activeIndex]?.id;
  const video = Boolean(images[activeIndex]?.video);
  const motion = Boolean(images[activeIndex]?.motion);
  const mediaReady = !motion || mediaState === "playing" || mediaState === "ended" || mediaState === "failed";
  const running = !paused && !blocked && available;
  const playing = running && ready && (video ? mediaState === "playing" || mediaState === "ended" : mediaReady);
  const currentMotion = images[activeIndex]?.motion;
  const nextMotion = (images[activeIndex + 1] ?? (props.hasMore ? undefined : images[0]))?.motion;
  const motionPreloads = useRef(new Map<string, () => void>());

  useLayoutEffect(() => {
    // A slideshow is an explicit playback request. Fetch both complete clips
    // immediately, including while the still image or dissolve is loading.
    // Keep ownership when the next clip becomes current; aborting and acquiring
    // it again would restart a slow download at every transition.
    const update = () => {
      const sources = new Set(document.hidden ? [] : [currentMotion, nextMotion].filter((source): source is string => Boolean(source)));
      for (const source of sources) {
        if (!motionPreloads.current.has(source)) motionPreloads.current.set(source, preloadLivePhoto(source, true));
      }
      for (const [source, release] of motionPreloads.current) {
        if (sources.has(source)) continue;
        release();
        motionPreloads.current.delete(source);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [currentMotion, nextMotion]);
  useLayoutEffect(() => () => {
    for (const release of motionPreloads.current.values()) release();
    motionPreloads.current.clear();
  }, []);

  useLayoutEffect(() => { onPlaybackChange?.(running); }, [running, onPlaybackChange]);

  useLayoutEffect(() => {
    onPlayingChange(playing);
    return () => onPlayingChange(false);
  }, [playing, onPlayingChange]);

  useLayoutEffect(() => {
    const update = () => {
      const active = document.activeElement;
      setAvailable(!document.hidden && windowFocused.current
        && (active === document.body || Boolean(active && viewerRef.current?.contains(active))));
    };
    const blur = () => { windowFocused.current = false; update(); };
    const focus = () => { windowFocused.current = true; update(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.defaultPrevented || event.isComposing
        || event.metaKey || event.ctrlKey || event.altKey || document.hidden) return;
      const active = document.activeElement;
      if (active !== document.body && !viewerRef.current?.contains(active)) return;
      if (active instanceof HTMLElement && (active.isContentEditable || active.closest("button, a, input, select, textarea, [role=menu]"))) return;
      event.preventDefault();
      setPaused(value => !value);
    };
    const controller = new AbortController();
    const { signal } = controller;
    document.addEventListener("visibilitychange", update, { signal });
    document.addEventListener("focusin", update, { signal });
    window.addEventListener("blur", blur, { signal });
    window.addEventListener("focus", focus, { signal });
    window.addEventListener("keydown", keydown, { signal });
    update();
    return () => controller.abort();
  }, [viewerRef, setPaused]);

  useLayoutEffect(() => {
    setDue(undefined);
    if (!running || !ready || video || motion) return;
    const timer = window.setTimeout(() => setDue(imageId), SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [imageId, running, ready, video, motion]);

  useLayoutEffect(() => {
    if (!running || !ready) return;
    const ended = mediaState === "ended" || mediaState === "failed";
    if (video || motion ? !ended : due !== imageId) return;
    let cancelled = false;
    let timer = 0;
    const advance = async () => {
      const current = latest.current;
      if (cancelled || current.blocked || current.images[current.activeIndex]?.id !== imageId) return;
      let next = current.images[current.activeIndex + 1];
      if (!next && current.hasMore) {
        try {
          const incoming = await current.onLoadMore();
          if (cancelled) return;
          next = incoming[0];
        } catch {
          if (!cancelled) setPaused(true);
          return;
        }
      }
      next ??= current.images[0];
      if (cancelled) return;
      if (next && next.id !== imageId) latest.current.onOpen(next);
      else setPaused(true);
    };
    // Leave the final motion frame on screen before starting the dissolve.
    // Pausing, opening a menu or leaving the slide cancels this hold as well.
    const delay = (video || motion) && mediaState === "failed" ? 1500 : video ? 500 : motion ? LIVE_PHOTO_END_HOLD_MS : 0;
    timer = window.setTimeout(() => void advance(), delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [imageId, running, ready, due, video, motion, mediaState, setPaused]);

  return null;
}
