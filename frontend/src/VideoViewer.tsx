import { createPortal } from "preact/compat";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { formatDuration } from "./format";
import { useGalleryMetrics } from "./galleryMetrics";
import { imageCardById } from "./galleryViewport";
import type { ImageViewerProps } from "./ImageViewer";
import { ChevronLeft, ChevronUp, LoaderCircle, RefreshCw, ScanSearch, SkipBack, SkipForward, X } from "./icons";
import { ImageCardActions } from "./ImageCardActions";
import { stopMediaPreview } from "./MediaPreview";
import type { VideoPlayer } from "./mediaPlayer";
import { PhotoInformation } from "./PhotoInformation";
import { SimilarImageGallery, SimilarImageSkeleton } from "./SimilarImages";
import { useModalDialog } from "./useModalDialog";
import { VideoEpisodes } from "./VideoEpisodes";
import { VideoPlayback, type PlaybackState } from "./VideoPlayback";
import { prepareViewerImages, viewerOriginalUrl, viewerThumbnailUrl } from "./viewerAssets";

export function VideoViewer({ images, activeIndex, hasMore, loadingMore, onLoadMoreImages, onClose, onOpenImage,
  similarActive, similarImages, similarTotal, similarHasMore, similarLoading, similarLoadingMore, similarError,
  onSearchSimilar, onSearchVideoFrame, similarFrameTime, onLoadMoreSimilar,
}: ImageViewerProps) {
  const image = images[activeIndex]!;
  const videoRef = useRef<VideoPlayer | null>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const similarRef = useRef<HTMLElement>(null);
  const similarMetrics = useGalleryMetrics(similarRef);
  const detailsVisible = useRef(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureJob = useRef<object | null>(null);
  const [state, setState] = useState<PlaybackState>("loading");
  const episodes = images.filter(image => image.video);
  const episodeIndex = episodes.findIndex(episode => episode.id === image.id);
  const previousEpisode = episodes[episodeIndex - 1];
  const nextEpisode = episodes[episodeIndex + 1];
  const canNext = Boolean(nextEpisode) || hasMore;
  const [findingNext, setFindingNext] = useState(false);
  const navigationJob = useRef<object | null>(null);
  const navigationLatest = useRef({ hasMore, onLoadMoreImages, onOpenImage });
  navigationLatest.current = { hasMore, onLoadMoreImages, onOpenImage };
  const waitingForNext = findingNext || (loadingMore && !nextEpisode);
  const navigateEpisode = async (direction: -1 | 1) => {
    const target = direction < 0 ? previousEpisode : nextEpisode;
    if (target) { onOpenImage(target); return; }
    if (direction < 0 || !hasMore || navigationJob.current) return;
    const job = navigationJob.current = {};
    setFindingNext(true);
    try {
      // Photo-only pages must not interrupt navigation between episodes.
      while (navigationLatest.current.hasMore && navigationJob.current === job) {
        const incoming = await navigationLatest.current.onLoadMoreImages();
        if (navigationJob.current !== job) return;
        const next = incoming.find(image => image.video);
        if (next) { navigationLatest.current.onOpenImage(next); return; }
        if (!incoming.length) return;
        // Let the new pagination cursor reach the next load callback.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    } finally {
      if (navigationJob.current === job) { navigationJob.current = null; setFindingNext(false); }
    }
  };
  const dialog = useModalDialog(onClose, {
    fallbackFocus: () => imageCardById(image.id)?.querySelector<HTMLElement>(".photo-card-open") ?? null,
  });

  useEffect(() => {
    stopMediaPreview();
    const root = document.getElementById("root");
    const inert = root?.inert ?? false;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      if (root) root.inert = inert;
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
    };
  }, []);

  useLayoutEffect(() => {
    detailsVisible.current = false;
    setDetails(false);
    setMenu(false);
    setEpisodesOpen(false);
    setFindingNext(false);
    navigationJob.current = null;
    setCapturing(false);
    setCaptureError(null);
    captureJob.current = null;
    dialog.ref.current?.scrollTo({ top: 0, behavior: "instant" });
    return () => { captureJob.current = null; navigationJob.current = null; };
  }, [image.id]);
  useEffect(() => { prepareViewerImages(images, activeIndex, { preloadOriginals: false }); }, [images, activeIndex]);

  const searchCurrentFrame = useCallback(async () => {
    const player = videoRef.current;
    if (!player || captureJob.current) return;
    const job = captureJob.current = {};
    player.pause();
    setCapturing(true);
    setCaptureError(null);
    try {
      const frame = await player.captureFrame();
      if (captureJob.current === job && videoRef.current === player) onSearchVideoFrame(image, frame);
    } catch (error) {
      if (captureJob.current === job && videoRef.current === player) {
        setCaptureError(error instanceof Error ? error.message : "无法截取当前画面，请重试。");
      }
    } finally {
      if (captureJob.current === job) { captureJob.current = null; setCapturing(false); }
    }
  }, [image, onSearchVideoFrame]);
  useEffect(() => {
    if (details && !similarActive && !captureError && state === "ready") void searchCurrentFrame();
  }, [details, similarActive, captureError, state, searchCurrentFrame]);

  const menuChanged = useCallback((open: boolean) => {
    setMenu(open);
    if (open) videoRef.current?.pause();
  }, []);
  const showSimilar = similarActive || capturing || Boolean(captureError);
  const scrollBehavior = (): ScrollBehavior => matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
  const returnToPlayback = () => {
    dialog.ref.current?.scrollTo({ top: 0, behavior: scrollBehavior() });
    dialog.ref.current?.querySelector<HTMLElement>(".video-viewer-stage")?.focus({ preventScroll: true });
  };
  const showDetails = async (target: "details" | "similar" = "details") => {
    const viewer = dialog.ref.current;
    videoRef.current?.pause();
    if (target === "similar") void searchCurrentFrame();
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { return; }
    }
    // Let the similar section expand before the browser clamps the scroll target.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!viewer?.isConnected || viewer.dataset.imageId !== image.id) return;
    const section = target === "similar" ? similarRef.current : detailsRef.current;
    section?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  };

  return createPortal(
    <dialog {...dialog} className="image-viewer video-viewer" aria-label={`视频查看器：${image.name}`}
      data-image-id={image.id} data-image-name={image.name} data-media-type="video" data-video-state={state}
      data-scroll-mode="continuous" data-page={details ? "details" : "image"}
      onScroll={event => {
        const next = event.currentTarget.scrollTop >= event.currentTarget.clientHeight / 2;
        if (next === detailsVisible.current) return;
        detailsVisible.current = next;
        setDetails(next);
        if (next) videoRef.current?.pause();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && episodesOpen) {
          event.preventDefault();
          setEpisodesOpen(false);
          dialog.ref.current?.querySelector<HTMLElement>(".video-episodes-toggle")?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Escape" && (dialog.ref.current?.scrollTop ?? 0) > 2) {
          event.preventDefault();
          returnToPlayback();
          return;
        }
        if ((event.target as HTMLElement).matches("input, select, textarea")) return;
        if (event.altKey) {
          if (event.key === "ArrowLeft" && previousEpisode) { event.preventDefault(); void navigateEpisode(-1); }
          if (event.key === "ArrowRight" && canNext && !waitingForNext) { event.preventDefault(); void navigateEpisode(1); }
        } else if (event.key === "PageDown" && !details) {
          event.preventDefault(); void showDetails();
        } else if (event.key === "PageUp" && details) {
          event.preventDefault(); returnToPlayback();
        }
      }}>
      <VideoPlayback source={image.playback ?? viewerOriginalUrl(image)} prepared={Boolean(image.playback)} autoPlay
        downloadSource={viewerOriginalUrl(image)} name={image.name} poster={viewerThumbnailUrl(image)}
        durationHint={image.video?.duration ?? 0} playerRef={videoRef} onState={setState} keepControlsVisible={menu || episodesOpen}
        header={<header className="video-viewer-header video-controls-region">
          <button type="button" className="video-control video-return viewer-close" aria-label="关闭查看器" title="返回图库 (Esc)" onClick={onClose}>
            <ChevronLeft size={22} strokeWidth={1.7} />
          </button>
          <h1 className="video-viewer-title" title={image.name}>{image.name.replace(/\.[^.]+$/, "") || image.name}</h1>
        </header>}
        previousControl={previousEpisode && <button type="button" className="video-control video-previous" aria-label="上一集"
          data-tooltip="上一集 · Alt + ←" onClick={() => { void navigateEpisode(-1); }}><SkipBack size={20} strokeWidth={1.6} /></button>}
        nextControl={canNext && <button type="button" className="video-control video-next" aria-label="下一集"
          data-tooltip="下一集 · Alt + →" disabled={waitingForNext} onClick={() => { void navigateEpisode(1); }}>
          {waitingForNext ? <LoaderCircle size={18} className="spin" /> : <SkipForward size={20} strokeWidth={1.6} />}
        </button>}
        options={<VideoEpisodes images={images} activeId={image.id} hasMore={hasMore} loadingMore={loadingMore}
          open={episodesOpen} onOpenChange={setEpisodesOpen} onSelect={onOpenImage} />}
        contextMenu={<ImageCardActions key={image.id} image={image} onMenuChange={menuChanged} similarDisabled={state !== "ready"}
          onAction={action => {
            if (action === "view") { returnToPlayback(); videoRef.current?.play(); }
            else void showDetails(action === "similar" ? "similar" : "details");
          }} />} />
      <section ref={detailsRef} className="viewer-details-page video-viewer-details" aria-label="视频信息" tabIndex={-1} data-details-image-name={image.name}>
        <div className="viewer-details-inner">
          <header className="video-details-toolbar">
            <button type="button" onClick={returnToPlayback}><ChevronUp size={17} />返回播放</button>
            <button type="button" className="video-details-close" aria-label="关闭视频查看器" onClick={onClose}><X size={18} /></button>
          </header>
          <div className="viewer-details-content">
            <PhotoInformation image={image} />
            <section ref={similarRef} className={`viewer-similar-section${showSimilar ? "" : " is-idle"}`} tabIndex={-1}
              aria-labelledby={showSimilar ? "video-similar-title" : undefined} data-similar-active={showSimilar} data-frame-time={similarFrameTime}>
              {showSimilar && <>
                <div className="viewer-similar-heading"><h3 id="video-similar-title">相似画面{!capturing && similarFrameTime !== undefined && <span className="video-similar-time"> · {formatDuration(similarFrameTime)}</span>}</h3><ScanSearch size={20} /></div>
                {capturing ? <SimilarImageSkeleton metrics={similarMetrics} />
                  : captureError ? <div className="viewer-similar-error" role="alert"><span>{captureError}</span><button type="button" onClick={() => { void searchCurrentFrame(); }}><RefreshCw size={15} />重试</button></div>
                  : similarLoading && !similarImages.length ? <SimilarImageSkeleton metrics={similarMetrics} />
                  : similarError && !similarImages.length ? <div className="viewer-similar-error" role="alert">
                    <span>{similarError}</span><button type="button" onClick={() => onSearchSimilar(image)}><RefreshCw size={15} />重试</button>
                  </div> : similarImages.length ? <SimilarImageGallery images={similarImages} total={similarTotal} metrics={similarMetrics}
                    hasMore={similarHasMore} loadingMore={similarLoadingMore} error={similarError} onLoadMore={onLoadMoreSimilar} onOpen={onOpenImage} />
                    : <div className="viewer-similar-empty"><ScanSearch size={22} /><span>暂时没有找到相似内容</span></div>}
              </>}
            </section>
          </div>
        </div>
      </section>
    </dialog>, document.body,
  );
}
