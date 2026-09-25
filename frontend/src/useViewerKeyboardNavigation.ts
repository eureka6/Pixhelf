import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";

const INITIAL_REPEAT_INTERVAL_MS = 240;
const MIN_REPEAT_INTERVAL_MS = 160;
const REPEAT_ACCELERATION_MS = 1200;

type Direction = -1 | 1;
type HeldArrow = {
  key: string;
  direction: Direction;
  lastStep: number;
  repeatStarted: number | null;
  controller: AbortController;
};

type KeyboardNavigationOptions = {
  viewerRef: RefObject<HTMLElement>;
  canPrevious: boolean;
  canNext: boolean;
  hasMore: boolean;
  onNavigate: (direction: Direction, signal: AbortSignal) => void;
  onLoadMoreImages: () => Promise<GalleryImage[]>;
};

export function useViewerKeyboardNavigation(options: KeyboardNavigationOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { viewerRef } = options;

  // Keep the held key and its cadence alive across image changes and new callbacks.
  useLayoutEffect(() => {
    let held: HeldArrow | null = null;
    let pendingTap: AbortController | null = null;
    let timer = 0;
    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      held?.controller.abort();
      pendingTap?.abort();
      pendingTap = null;
      held = null;
    };
    const ownsFocus = () => {
      const viewer = viewerRef.current;
      const active = document.activeElement;
      return !document.hidden && Boolean(viewer?.isConnected)
        && (active === document.body || Boolean(active && viewer?.contains(active)))
        && !(active instanceof HTMLElement && (
          active.isContentEditable || active.closest("input, textarea, select, [role='menu']")
        ));
    };
    const interval = (gesture: HeldArrow) => {
      const progress = Math.min(1, (performance.now() - gesture.repeatStarted!) / REPEAT_ACCELERATION_MS);
      const eased = progress * progress * (3 - 2 * progress);
      return INITIAL_REPEAT_INTERVAL_MS + (MIN_REPEAT_INTERVAL_MS - INITIAL_REPEAT_INTERVAL_MS) * eased;
    };
    const schedule = (gesture: HeldArrow, delay: number) => {
      timer = window.setTimeout(() => repeat(gesture), delay);
    };
    const repeat = (gesture: HeldArrow) => {
      timer = 0;
      if (held !== gesture) return;
      if (!ownsFocus()) { stop(); return; }
      const current = latest.current;
      if (gesture.direction < 0 ? !current.canPrevious : !current.canNext) {
        if (gesture.direction < 0 || !current.hasMore) { stop(); return; }
        // Fetch the page without queuing a navigation. Releasing or reversing the
        // key invalidates this continuation, even if the request finishes later.
        void current.onLoadMoreImages().then(incoming => {
          if (held !== gesture) return;
          if (!incoming.length || !ownsFocus()) { stop(); return; }
          // Restart gently after a network wait; never catch up missed repeats.
          gesture.repeatStarted = performance.now();
          schedule(gesture, INITIAL_REPEAT_INTERVAL_MS);
        }, () => { if (held === gesture) stop(); });
        return;
      }
      gesture.lastStep = performance.now();
      current.onNavigate(gesture.direction, gesture.controller.signal);
      if (held === gesture) schedule(gesture, interval(gesture));
    };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !ownsFocus()) {
        stop();
        return;
      }
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
      if (!direction) { stop(); return; }
      event.preventDefault();
      if (!event.repeat) {
        stop();
        const current = latest.current;
        if (direction < 0 ? !current.canPrevious : !current.canNext && !current.hasMore) return;
        held = { key: event.key, direction, lastStep: performance.now(), repeatStarted: null, controller: new AbortController() };
        current.onNavigate(direction, held.controller.signal);
        return;
      }
      // Let the OS decide when a press becomes a hold. Once it does, one timer
      // supplies a smooth cadence instead of following the OS repeat frequency.
      if (!held || held.key !== event.key || held.repeatStarted !== null) return;
      held.repeatStarted = performance.now();
      const delay = Math.max(0, INITIAL_REPEAT_INTERVAL_MS - (performance.now() - held.lastStep));
      schedule(held, delay);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== held?.key) return;
      // A single tap can finish its one requested page turn after release. A
      // long press must also cancel a turn requested before repetition began.
      if (held.repeatStarted === null) {
        pendingTap = held.controller;
        held = null;
        return;
      }
      stop();
    };
    const focus = () => { if (!ownsFocus()) stop(); };

    const controller = new AbortController();
    const { signal } = controller;
    window.addEventListener("keydown", down, { signal });
    window.addEventListener("keyup", up, { signal, capture: true });
    window.addEventListener("blur", stop, { signal });
    window.addEventListener("pagehide", stop, { signal });
    window.addEventListener("pointerdown", stop, { signal, capture: true });
    document.addEventListener("visibilitychange", focus, { signal });
    document.addEventListener("focusin", focus, { signal });
    return () => {
      stop();
      controller.abort();
    };
  }, [viewerRef]);
}
