import { useLayoutEffect, useRef } from "preact/hooks";
import { formatDuration } from "./format";
import { Check, ListIcon, LoaderCircle, Play } from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import type { GalleryImage } from "./types";
import { viewerThumbnailUrl } from "./viewerAssets";

type VideoEpisodesProps = {
  images: GalleryImage[];
  activeId: string;
  hasMore: boolean;
  loadingMore: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (image: GalleryImage) => void;
};

export function VideoEpisodes({ images, activeId, hasMore, loadingMore, open, onOpenChange, onSelect }: VideoEpisodesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const episodes = images.filter(image => image.video);
  useLayoutEffect(() => {
    if (!open) return;
    const selected = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    selected?.focus({ preventScroll: true });
    if (selected && ref.current) ref.current.scrollTop = selected.offsetTop - ref.current.clientHeight / 2;
  }, [open, activeId]);

  const close = () => {
    onOpenChange(false);
    ref.current?.closest(".video-episodes-menu")?.querySelector<HTMLElement>(".toolbar-popover-trigger")?.focus({ preventScroll: true });
  };

  return <ToolbarPopover id="video-episodes" open={open} onOpenChange={onOpenChange}
    icon={<ListIcon size={22} strokeWidth={1.7} />} openLabel="剧集" closeLabel="收起剧集" panelLabel="剧集"
    rootClassName="video-episodes-menu" triggerClassName="video-control video-episodes-toggle" panelClassName="video-episodes-panel">
    <div className="video-episodes-heading"><span>剧集</span><span>{episodes.length}{hasMore ? "+" : ""}{loadingMore && <LoaderCircle size={14} className="spin" />}</span></div>
    <div ref={ref} className="video-episodes-list" role="menu" aria-label="选择剧集" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus({ preventScroll: true });
      if (buttons[next]) event.currentTarget.scrollTop = buttons[next].offsetTop - event.currentTarget.clientHeight / 2;
    }}>
      {episodes.map((episode, index) => <button key={episode.id} type="button" role="menuitemradio"
        aria-checked={episode.id === activeId} title={episode.name} onClick={() => {
          close();
          if (episode.id !== activeId) onSelect(episode);
        }}>
        <span className="video-episode-cover">
          <Play size={22} strokeWidth={1.3} />
          {open && <img src={viewerThumbnailUrl(episode)} alt="" width={112} height={63} loading="lazy" decoding="async"
            onError={event => { event.currentTarget.hidden = true; }} />}
          {episode.id === activeId && <span className="video-episode-selected"><Check size={12} /></span>}
        </span>
        <span className="video-episode-copy">
          <span className="video-episode-name">{episode.name.replace(/\.[^.]+$/, "") || episode.name}</span>
          <span className="video-episode-meta"><span>第 {index + 1} 集</span><span>{formatDuration(episode.video?.duration ?? null)}</span></span>
        </span>
      </button>)}
    </div>
  </ToolbarPopover>;
}
