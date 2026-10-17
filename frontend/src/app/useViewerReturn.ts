import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { imageCardById, scrollTopForAnchor, scrollWindowImmediately, type ViewerAnchor } from "../galleryViewport";
import { createViewerReturnFlight, disposeViewerReturnFlight, type ViewerReturnFlight } from "./viewerReturnSnapshot";

const VIEWER_RETURN_SETTLE_MS = 32;
const VIEWER_RETURN_TIMEOUT_MS = 480;
const VIEWER_RETURN_ANIMATION_MS = 280;

type ViewerReturnRequest = ViewerAnchor & {
  parentImageId?: string;
  imageId: string;
  sequence: number;
};

// Owns temporary DOM, observers and scroll restoration for gallery and nested returns.
export function useViewerReturn(viewerImageId: string | null) {
  const [viewerReturnRequest, setViewerReturnRequest] = useState<ViewerReturnRequest | null>(null);
  const viewerAnchorRef = useRef<ViewerAnchor | null>(null);
  const viewerReturnSequenceRef = useRef(0);
  const viewerReturnFlightRef = useRef<ViewerReturnFlight | null>(null);

  const cancelViewerReturn = useCallback(() => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
    setViewerReturnRequest(null);
  }, []);

  const beginViewerReturn = useCallback((request: Omit<ViewerReturnRequest, "sequence"> | null, animate = true) => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = request && animate ? createViewerReturnFlight() : null;
    setViewerReturnRequest(request ? { ...request, sequence: ++viewerReturnSequenceRef.current } : null);
  }, []);

  useEffect(() => () => {
    disposeViewerReturnFlight(viewerReturnFlightRef.current);
    viewerReturnFlightRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!viewerReturnRequest) return;
    const request = viewerReturnRequest;
    if (request.parentImageId ? viewerImageId !== request.parentImageId : Boolean(viewerImageId)) return;
    const scrollRoot = request.parentImageId ? document.querySelector<HTMLElement>(".image-viewer") ?? undefined : undefined;
    if (request.parentImageId && !scrollRoot) return;
    const gallerySelector = scrollRoot ? ".viewer-similar-gallery" : ".justified-gallery";
    const findGallery = () => (scrollRoot ?? document).querySelector<HTMLElement>(gallerySelector);
    const getScroll = () => scrollRoot?.scrollTop ?? window.scrollY;
    let trackedScroll = getScroll();
    let scrollTranslation = 0;
    let userControlled = false;
    const setScroll = (top: number) => {
      if (userControlled) return;
      if (scrollRoot) scrollRoot.scrollTo({ top, behavior: "instant" });
      else scrollWindowImmediately(top);
      trackedScroll = getScroll();
    };
    const requestFlight = viewerReturnFlightRef.current;
    if (scrollRoot && requestFlight) scrollRoot.append(requestFlight.layer);
    let frame = 0;
    let settleTimer = 0;
    let timeoutTimer = 0;
    let stopped = false;
    let animating = false;
    let finished = false;
    let animationTarget: HTMLElement | null = null;
    let animationEndpoint = "";
    let observedCard: HTMLElement | null = null;
    let observedGallery: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeObserverPrimed = false;

    const observeLayout = (card: HTMLElement) => {
      const gallery = card.closest<HTMLElement>(gallerySelector);
      if (resizeObserver && card !== observedCard) {
        if (observedCard) resizeObserver.unobserve(observedCard);
        resizeObserver.observe(card);
        observedCard = card;
      }
      if (resizeObserver && gallery && gallery !== observedGallery) {
        if (observedGallery) resizeObserver.unobserve(observedGallery);
        resizeObserver.observe(gallery);
        observedGallery = gallery;
      }
    };

    const alignToCard = (): HTMLElement | null => {
      const card = imageCardById(request.imageId, findGallery());
      if (!card || card.getBoundingClientRect().height <= 0) return null;
      observeLayout(card);

      const targetScroll = scrollTopForAnchor(card, request, scrollRoot);
      if (Math.abs(targetScroll - getScroll()) > 0.5) {
        setScroll(targetScroll);
      }
      return card;
    };

    const informationLoading = () => Boolean(scrollRoot?.querySelector('.viewer-photo-information[aria-busy="true"]'));
    const releaseRequest = () => {
      stopped = true;
      setViewerReturnRequest(current => {
        if (current?.sequence !== request.sequence) return current;
        if (!request.parentImageId) viewerAnchorRef.current = null;
        return null;
      });
    };
    const settleReturn = () => {
      if (!scrollRoot) { releaseRequest(); return; }
      window.clearTimeout(settleTimer);
      // Metadata can finish before its final layout is painted. Recheck the
      // anchor after layout settles instead of releasing it in that same frame.
      settleTimer = window.setTimeout(() => {
        if (stopped || !finished || informationLoading()) return;
        alignToCard();
        releaseRequest();
      }, VIEWER_RETURN_SETTLE_MS);
    };
    const finalize = (card: HTMLElement | null) => {
      if (finished) return;
      finished = true;
      disposeViewerReturnFlight(requestFlight);
      if (viewerReturnFlightRef.current === requestFlight) viewerReturnFlightRef.current = null;
      if (!userControlled && card?.isConnected) card.focus({ preventScroll: true });
      // Returning after a reload can fetch metadata above the waterfall. Keep
      // its card anchored through that layout change, until the user takes over.
      if (!informationLoading()) settleReturn();
    };
    const takeOver = () => { userControlled = true; if (finished) releaseRequest(); };
    const followScroll = () => {
      const top = getScroll();
      const delta = trackedScroll - top;
      if (Math.abs(delta) < 0.5) return;
      trackedScroll = top;
      takeOver();
      if (!finished && requestFlight) {
        // Compose scroll movement separately from the shrink animation, so its
        // destination follows the waterfall without restarting its timeline.
        scrollTranslation += delta;
        requestFlight.media.style.translate = `0 ${scrollTranslation}px`;
      }
    };

    const transformFrame = ([x, y, scaleX, scaleY]: number[]) => ({
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`,
    });
    const targetTransform = (card: HTMLElement, flight: ViewerReturnFlight) => {
      const target = card.getBoundingClientRect();
      return [target.left - flight.source.left, target.top - flight.source.top - scrollTranslation,
        target.width / flight.source.width, target.height / flight.source.height];
    };
    const retargetAnimation = (card: HTMLElement | null) => {
      const flight = requestFlight;
      const effect = flight?.animations[0]?.effect;
      if (flight?.layer.dataset.phase !== "flying" || !card || !(effect instanceof KeyframeEffect)) return;
      if (animationTarget !== card) {
        if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
        card.dataset.viewerReturnTarget = "true";
        animationTarget = card;
      }
      const target = targetTransform(card, flight);
      const endpoint = transformFrame(target);
      if (endpoint.transform === animationEndpoint) return;
      const progress = effect.getComputedTiming().progress ?? 0;
      const current = new DOMMatrix(getComputedStyle(flight.media).transform);
      // Solve the start frame at the current eased progress: the rendered pose
      // and original deadline stay unchanged while the destination moves.
      const start = 1 - progress > .00001
        ? [current.e, current.f, current.a, current.d].map((value, index) =>
          (value - target[index] * progress) / (1 - progress))
        : target;
      effect.setKeyframes([transformFrame(start), endpoint]);
      animationEndpoint = endpoint.transform;
      flight.layer.dataset.retargets = String(
        Number.parseInt(flight.layer.dataset.retargets ?? "0", 10) + 1,
      );
    };

    const complete = () => {
      if (stopped) return;
      const card = alignToCard();
      if (finished) { if (!informationLoading()) settleReturn(); return; }
      if (animating) { retargetAnimation(card); return; }
      if (!card) {
        setScroll(scrollTopForAnchor(null, request, scrollRoot));
      }

      const flight = requestFlight;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!flight || reducedMotion || typeof flight.media.animate !== "function") {
        finalize(card);
        return;
      }

      animating = true;
      const flying = card && flight.visible;
      flight.layer.dataset.phase = flying ? "flying" : "fading";
      flight.layer.dataset.flyingAt = String(performance.now());
      flight.layer.dataset.duration = String(flying ? VIEWER_RETURN_ANIMATION_MS : 150);
      const animations: Animation[] = [];
      if (flying) {
        const endpoint = transformFrame(targetTransform(card, flight));
        animationEndpoint = endpoint.transform;
        card.dataset.viewerReturnTarget = "true";
        animationTarget = card;
        animations.push(flight.media.animate([
          transformFrame([0, 0, 1, 1]), endpoint,
        ], {
          duration: VIEWER_RETURN_ANIMATION_MS,
          easing: "cubic-bezier(.2, .7, .2, 1)",
          fill: "forwards",
        }));
      } else {
        animations.push(flight.media.animate([
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(.98)" },
        ], {
          duration: 150,
          easing: "ease-out",
          fill: "forwards",
        }));
      }
      animations.push(flight.backdrop.animate([
        { opacity: Number.parseFloat(window.getComputedStyle(flight.backdrop).opacity) || 0 },
        { opacity: 0 },
      ], {
        duration: flying ? 200 : 150,
        easing: "cubic-bezier(.2, .8, .2, 1)",
        fill: "forwards",
      }));
      flight.animations.push(...animations);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (stopped || viewerReturnFlightRef.current !== flight) return;
        if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
        finalize(animationTarget ?? card);
      });
    };

    const schedule = () => {
      if (stopped || frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        complete();
      });
    };

    resizeObserver = new ResizeObserver(() => {
      if (!resizeObserverPrimed) {
        resizeObserverPrimed = true;
        return;
      }
      schedule();
    });
    const mutationObserver = new MutationObserver(schedule);
    const gallery = findGallery();
    if (gallery) mutationObserver.observe(gallery, { childList: true });
    if (scrollRoot) {
      resizeObserver.observe(scrollRoot);
      const information = scrollRoot.querySelector(".viewer-photo-information");
      if (information) resizeObserver.observe(information);
      mutationObserver.observe(scrollRoot, { attributes: true, attributeFilter: ["aria-busy"], subtree: true });
    }
    const scrollEvents = scrollRoot ?? window;
    scrollEvents.addEventListener("scroll", followScroll, { passive: true });
    for (const event of ["pointerdown", "wheel", "keydown"]) scrollEvents.addEventListener(event, takeOver, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();
    timeoutTimer = window.setTimeout(complete, VIEWER_RETURN_TIMEOUT_MS);

    return () => {
      stopped = true;
      finished = true;
      if (animationTarget) delete animationTarget.dataset.viewerReturnTarget;
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(timeoutTimer);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      scrollEvents.removeEventListener("scroll", followScroll);
      for (const event of ["pointerdown", "wheel", "keydown"]) scrollEvents.removeEventListener(event, takeOver, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [viewerImageId, viewerReturnRequest]);

  return { viewerReturnRequest, viewerAnchorRef, beginViewerReturn, cancelViewerReturn };
}
