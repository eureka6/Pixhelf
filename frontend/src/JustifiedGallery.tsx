import type { CSSProperties } from "preact";
import { flushSync, forwardRef, memo } from "preact/compat";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  captureGalleryViewportAnchor,
  restoreGalleryViewportAnchor,
  visualViewportBounds,
} from "./galleryViewport";
import type { GalleryViewportAnchor } from "./galleryViewport";
import { ImageIcon } from "./icons";
import { ImageCardActions } from "./ImageCardActions";
import { LivePhoto } from "./LivePhoto";
import { useGalleryMetrics } from "./galleryMetrics";
import { useCardInteraction } from "./cardInteraction";
import { layoutJustifiedImages, layoutJustifiedSkeleton } from "./justified";
import type { GalleryImage, ImageCardAction } from "./types";
import { preloadOriginalImage, viewerThumbnailUrl } from "./viewerAssets";

const CARD_PREFETCH_MARGIN = "1200px 0px";
const IMAGE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const READY_THUMBNAIL_CACHE_LIMIT = 2048;

type ThumbnailState = "loading" | "loaded" | "retrying" | "failed";

export type JustifiedGalleryHandle = {
  resize: (updateLayout: () => void) => void;
};

type GalleryResizeAnimation = {
  gallery: HTMLElement;
  animations: Animation[];
};

const CARD_LOAD_CALLBACKS = new WeakMap<Element, () => void>();
const READY_THUMBNAIL_IDS = new Set<string>();
let cardLoadObserver: IntersectionObserver | null = null;

function rememberReadyThumbnail(id: string): void {
  READY_THUMBNAIL_IDS.delete(id);
  READY_THUMBNAIL_IDS.add(id);
  if (READY_THUMBNAIL_IDS.size > READY_THUMBNAIL_CACHE_LIMIT) {
    const oldest = READY_THUMBNAIL_IDS.values().next().value;
    if (oldest !== undefined) READY_THUMBNAIL_IDS.delete(oldest);
  }
}

function observeCardLoad(element: Element, load: () => void): () => void {
  if (!("IntersectionObserver" in window)) {
    load();
    return () => undefined;
  }
  if (!cardLoadObserver) {
    cardLoadObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = CARD_LOAD_CALLBACKS.get(entry.target);
          CARD_LOAD_CALLBACKS.delete(entry.target);
          observer.unobserve(entry.target);
          callback?.();
        }
      },
      { rootMargin: CARD_PREFETCH_MARGIN },
    );
  }
  CARD_LOAD_CALLBACKS.set(element, load);
  cardLoadObserver.observe(element);
  return () => {
    CARD_LOAD_CALLBACKS.delete(element);
    cardLoadObserver?.unobserve(element);
  };
}

type JustifiedGalleryProps = {
  images: GalleryImage[];
  preserveViewport: boolean;
  onOpen: (id: string, card: HTMLElement, pointerY?: number, action?: ImageCardAction) => void;
};

export const JustifiedGallery = memo(forwardRef<JustifiedGalleryHandle, JustifiedGalleryProps>(function JustifiedGallery({
  images,
  preserveViewport,
  onOpen,
}, handleRef) {
  const ref = useRef<HTMLDivElement>(null);
  useCardInteraction(ref, preserveViewport);
  const resizeAnchorRef = useRef<GalleryViewportAnchor | null>(null);
  const stableViewportAnchorRef = useRef<GalleryViewportAnchor | null>(null);
  const resizeGuardUntilRef = useRef(0);
  const resizeAnimationRef = useRef<GalleryResizeAnimation | null>(null);
  const stopResizeAnimation = useCallback(() => {
    const current = resizeAnimationRef.current;
    if (!current) return;
    resizeAnimationRef.current = null;
    current.animations.forEach((animation) => animation.cancel());
    delete current.gallery.dataset.resizing;
  }, []);
  const captureResizeAnchor = useCallback(() => {
    stopResizeAnimation();
    const gallery = ref.current;
    resizeAnchorRef.current = preserveViewport && gallery
      ? stableViewportAnchorRef.current ?? captureGalleryViewportAnchor(gallery)
      : null;
  }, [preserveViewport, stopResizeAnimation]);
  const { width, gap, measure } = useGalleryMetrics(
    ref,
    captureResizeAnchor,
  );

  useImperativeHandle(handleRef, () => ({
    resize(updateLayout) {
      const gallery = ref.current;
      if (!gallery) {
        updateLayout();
        return;
      }
      const before = [...gallery.querySelectorAll<HTMLElement>(".image-card")]
        .map((card) => ({ card, rect: card.getBoundingClientRect() }));
      captureResizeAnchor();
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reducedMotion) gallery.dataset.resizing = "true";

      // Commit the final width before painting, then animate from the previous visual positions.
      flushSync(updateLayout);
      flushSync(measure);
      if (reducedMotion) return;

      const positions = before.map(({ card, rect }) => ({
        card,
        before: rect,
        after: card.getBoundingClientRect(),
      }));
      const viewport = visualViewportBounds();
      const isVisible = (rect: DOMRect) => rect.bottom > viewport.top
        && rect.top < viewport.bottom;
      const styles = getComputedStyle(gallery);
      const duration = Number.parseFloat(styles.getPropertyValue("--motion-medium")) || 220;
      const easing = styles.getPropertyValue("--ease-standard").trim() || "ease";
      const current: GalleryResizeAnimation = { gallery, animations: [] };
      for (const { card, before, after } of positions) {
        if (!isVisible(before) && !isVisible(after)) continue;
        const x = before.left - after.left;
        const y = before.top - after.top;
        if (
          Math.abs(x) < .1 && Math.abs(y) < .1
          && Math.abs(before.width - after.width) < .1
          && Math.abs(before.height - after.height) < .1
        ) continue;
        current.animations.push(card.animate([
          {
            transform: `translate3d(${x}px, ${y}px, 0) scale(${before.width / Math.max(1, after.width)}, ${before.height / Math.max(1, after.height)})`,
          },
          { transform: "none" },
        ], { duration, easing }));
      }
      resizeAnimationRef.current = current;
      void Promise.allSettled(current.animations.map((animation) => animation.finished)).then(() => {
        if (resizeAnimationRef.current !== current) return;
        resizeAnimationRef.current = null;
        delete gallery.dataset.resizing;
      });
    },
  }), [captureResizeAnchor, measure]);

  useEffect(() => stopResizeAnimation, [stopResizeAnimation]);
  useEffect(() => {
    if (!preserveViewport) stopResizeAnimation();
  }, [preserveViewport, stopResizeAnimation]);

  useLayoutEffect(() => {
    const anchor = resizeAnchorRef.current;
    const gallery = ref.current;
    let correctionFrame = 0;
    resizeAnchorRef.current = null;
    if (anchor && gallery && preserveViewport) {
      resizeGuardUntilRef.current = performance.now() + 120;
      restoreGalleryViewportAnchor(gallery, anchor);
      correctionFrame = window.requestAnimationFrame(() => {
        restoreGalleryViewportAnchor(gallery, anchor);
      });
    }
    // Keep fractional scroll rounding from accumulating across resize frames.
    stableViewportAnchorRef.current = preserveViewport && gallery
      ? anchor ?? captureGalleryViewportAnchor(gallery)
      : null;
    return () => window.cancelAnimationFrame(correctionFrame);
  }, [gap, images, preserveViewport, width]);

  useEffect(() => {
    const gallery = ref.current;
    if (!gallery || !preserveViewport) {
      stableViewportAnchorRef.current = null;
      return;
    }
    let frame = 0;
    const rememberViewportAnchor = () => {
      frame = 0;
      if (
        resizeAnchorRef.current
        || performance.now() < resizeGuardUntilRef.current
      ) return;
      stableViewportAnchorRef.current = captureGalleryViewportAnchor(gallery);
    };
    const scheduleViewportAnchor = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(rememberViewportAnchor);
    };
    const rememberFocusedAnchor = () => {
      if (frame) window.cancelAnimationFrame(frame);
      rememberViewportAnchor();
    };
    const guardViewportResize = () => {
      resizeGuardUntilRef.current = performance.now() + 120;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    rememberViewportAnchor();
    window.addEventListener("scroll", scheduleViewportAnchor, { passive: true });
    window.addEventListener("resize", guardViewportResize);
    window.visualViewport?.addEventListener("resize", guardViewportResize);
    gallery.addEventListener("focusin", rememberFocusedAnchor);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleViewportAnchor);
      window.removeEventListener("resize", guardViewportResize);
      window.visualViewport?.removeEventListener("resize", guardViewportResize);
      gallery.removeEventListener("focusin", rememberFocusedAnchor);
    };
  }, [preserveViewport]);

  const layout = useMemo(
    () => layoutJustifiedImages(images, { width, gap }),
    [gap, images, width],
  );

  return (
    <div
      ref={ref}
      className="justified-gallery"
      data-layout="justified"
      data-layout-width={width}
      data-rows={layout.rowCount}
      style={{ height: layout.height } as CSSProperties}
    >
      {layout.items.map(({ image, index, row, style }) => (
        <ImageCard
          key={image.id}
          image={image}
          layoutStyle={style}
          eager={row === 0}
          highPriority={index === 0}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}));

const ImageCard = memo(function ImageCard({
  image,
  layoutStyle,
  eager,
  highPriority,
  onOpen,
}: {
  image: GalleryImage;
  layoutStyle: CSSProperties;
  eager: boolean;
  highPriority: boolean;
  onOpen: JustifiedGalleryProps["onOpen"];
}) {
  const alreadyReady = READY_THUMBNAIL_IDS.has(image.id);
  const [loadState, setLoadState] = useState<ThumbnailState>(alreadyReady ? "loaded" : "loading");
  const loaded = loadState === "loaded";
  const failed = loadState === "failed";
  const [attempt, setAttempt] = useState(0);
  const [loadRequested, setLoadRequested] = useState(eager || alreadyReady);
  const cardRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const retryTimerRef = useRef(0);
  const handleAction = useCallback((action: ImageCardAction) => {
    if (cardRef.current) onOpen(image.id, cardRef.current, undefined, action);
  }, [image.id, onOpen]);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);
  useEffect(() => {
    if (eager) {
      setLoadRequested(true);
      return;
    }
    if (loadRequested) return;
    const card = cardRef.current;
    if (!card) return;
    return observeCardLoad(card, () => setLoadRequested(true));
  }, [eager, loadRequested]);

  const thumbnailUrl = viewerThumbnailUrl(image);
  const imageUrl = attempt ? `${thumbnailUrl}?retry=${attempt}` : thumbnailUrl;

  const markLoaded = useCallback(() => {
    window.clearTimeout(retryTimerRef.current);
    rememberReadyThumbnail(image.id);
    setLoadState("loaded");
  }, [image.id]);

  useLayoutEffect(() => {
    const element = imageRef.current;
    if (element?.complete && element.naturalWidth > 0) markLoaded();
  }, [imageUrl, loadRequested, markLoaded]);

  const handleError = () => {
    window.clearTimeout(retryTimerRef.current);
    READY_THUMBNAIL_IDS.delete(image.id);
    const delay = IMAGE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      setLoadState("failed");
      return;
    }
    setLoadState("retrying");
    retryTimerRef.current = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      setLoadState("loading");
    }, delay);
  };

  return (
    <figure
      ref={cardRef}
      className="image-card"
      data-image-id={image.id}
      data-image-name={image.name}
      data-loaded={loaded}
      data-failed={failed}
      data-loading={loadRequested && !loaded && !failed}
      data-retrying={loadState === "retrying"}
      data-eager={eager}
      data-high-priority={highPriority}
      style={{
        ...layoutStyle,
        aspectRatio: `${image.width} / ${image.height}`,
      } as CSSProperties}
      onPointerEnter={() => preloadOriginalImage(image)}
      onPointerDown={() => preloadOriginalImage(image)}
      onFocus={() => preloadOriginalImage(image)}
      onClick={(event) => onOpen(
        image.id,
        event.currentTarget,
        event.detail > 0 ? event.clientY : undefined,
      )}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(image.id, event.currentTarget);
      }}
      role="group"
      tabIndex={-1}
      aria-label={image.name}
    >
      {!failed && loadRequested ? (
        <img
          ref={imageRef}
          src={imageUrl}
          alt={image.name}
          loading="eager"
          decoding="async"
          fetchPriority={highPriority ? "high" : "auto"}
          width={image.width}
          height={image.height}
          draggable={false}
          className={loaded ? "loaded" : ""}
          onLoad={markLoaded}
          onError={handleError}
        />
      ) : failed ? (
        <span className="image-fallback" role="img" aria-label={`${image.name} 加载失败`}>
          <ImageIcon size={24} />
        </span>
      ) : null}
      {loaded && image.motion && <LivePhoto image={image} />}
      <button type="button" className="photo-card-open" aria-label={`查看 ${image.name}${image.motion ? "，live 照片" : ""}`} aria-haspopup="dialog" />
      <ImageCardActions image={image} onAction={handleAction} />
    </figure>
  );
});

export function GallerySkeleton() {
  const ref = useRef<HTMLDivElement>(null);
  const { width, gap } = useGalleryMetrics(ref);
  const layout = useMemo(
    () => layoutJustifiedSkeleton({ width, gap }),
    [gap, width],
  );

  return (
    <div
      ref={ref}
      className="skeleton-grid"
      data-layout="justified"
      data-layout-width={width}
      style={{ height: layout.height } as CSSProperties}
      aria-label="正在加载图库"
    >
      {layout.items.map(({ index, style }) => (
        <span
          key={index}
          aria-hidden="true"
          style={style}
        />
      ))}
    </div>
  );
}
