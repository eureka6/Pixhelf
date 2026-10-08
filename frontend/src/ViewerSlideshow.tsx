import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Pause, Play, X } from "./icons";
import type { GalleryImage } from "./types";

const SLIDE_INTERVAL_MS = 5_000;

type SlideshowProps = {
  viewerRef: RefObject<HTMLElement>;
  images: GalleryImage[];
  activeIndex: number;
  hasMore: boolean;
  ready: boolean;
  blocked: boolean;
  onLoadMore: () => Promise<GalleryImage[]>;
  onOpen: (image: GalleryImage) => void;
  onStop: () => void;
};

export function ViewerSlideshow(props: SlideshowProps) {
  const { viewerRef, activeIndex, images, blocked, ready, onStop } = props;
  const [paused, setPaused] = useState(false);
  const [available, setAvailable] = useState(!document.hidden);
  const latest = useRef(props);
  latest.current = props;
  const imageId = images[activeIndex]?.id;

  useLayoutEffect(() => {
    const update = () => {
      const active = document.activeElement;
      setAvailable(!document.hidden && (active === document.body || Boolean(active && viewerRef.current?.contains(active))));
    };
    const blur = () => setAvailable(false);
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
    window.addEventListener("focus", update, { signal });
    window.addEventListener("keydown", keydown, { signal });
    update();
    return () => controller.abort();
  }, [viewerRef]);

  useLayoutEffect(() => {
    if (paused || blocked || !available || !ready) return;
    let cancelled = false;
    let timer = 0;
    const advance = async () => {
      const current = latest.current;
      if (cancelled || current.blocked || current.images[current.activeIndex]?.id !== imageId) return;
      let next = current.images.slice(current.activeIndex + 1).find(image => !image.video);
      if (!next && current.hasMore) {
        try {
          const incoming = await current.onLoadMore();
          if (cancelled) return;
          next = incoming.find(image => !image.video);
          if (!next && incoming.length) {
            // Let the new page render before continuing past a page of videos.
            timer = window.setTimeout(() => void advance(), 0);
            return;
          }
          if (!next) { setPaused(true); return; }
        } catch {
          if (!cancelled) setPaused(true);
          return;
        }
      }
      next ??= current.images.find(image => !image.video);
      if (cancelled) return;
      if (next && next.id !== imageId) latest.current.onOpen(next);
      else setPaused(true);
    };
    timer = window.setTimeout(() => void advance(), SLIDE_INTERVAL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [imageId, paused, blocked, available, ready]);

  return <div className="viewer-slideshow" role="group" aria-label="幻灯片播放" data-paused={paused}>
    <button type="button" onClick={() => setPaused(value => !value)} aria-label={paused ? "继续幻灯片" : "暂停幻灯片"}
      title={paused ? "继续幻灯片 (空格)" : "暂停幻灯片 (空格)"}>
      {paused ? <Play size={18} /> : <Pause size={18} />}
    </button>
    <span>{paused ? "已暂停" : blocked || !available ? "暂缓切换" : !ready ? "载入图片…" : "每 5 秒"}</span>
    <button type="button" onClick={onStop} aria-label="结束幻灯片" title="结束幻灯片"><X size={18} /></button>
  </div>;
}
