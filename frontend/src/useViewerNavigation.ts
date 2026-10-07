import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";

const POINTER_HOLD_DELAY_MS = 500;

// Match deliberate rapid tapping; the cadence is constant for the whole hold.
const REPEAT_INTERVAL_MS = 170;

type Direction = -1 | 1;
type HeldNavigation = {
  key?: string;
  direction: Direction;
  repeating: boolean;
  controller: AbortController;
};

type NavigationOptions = {
  viewerRef: RefObject<HTMLElement>;
  canPrevious: boolean;
  canNext: boolean;
  hasMore: boolean;
  onNavigate: (direction: Direction, signal: AbortSignal) => void;
  onLoadMoreImages: () => Promise<GalleryImage[]>;
};

export function useViewerNavigation(options: NavigationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { viewerRef } = options;
  const controls = useRef({
    beginHold: (_direction: Direction): ((commitTap: boolean) => void) => () => {},
    tap: (_direction: Direction) => {},
  });

  useLayoutEffect(() => {
    let held: HeldNavigation | null = null;
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
    const schedule = (gesture: HeldNavigation, delay: number) => {
      timer = window.setTimeout(() => repeat(gesture), delay);
    };
    const repeat = (gesture: HeldNavigation) => {
      timer = 0;
      if (held !== gesture) return;
      if (!ownsFocus()) { stop(); return; }
      gesture.repeating = true;
      const current = latest.current;
      if (gesture.direction < 0 ? !current.canPrevious : !current.canNext) {
        if (gesture.direction < 0 || !current.hasMore) { stop(); return; }
        // No queued steps at a page boundary and no catch-up burst after a wait.
        void current.onLoadMoreImages().then(incoming => {
          if (held !== gesture) return;
          if (!incoming.length || !ownsFocus()) { stop(); return; }
          schedule(gesture, REPEAT_INTERVAL_MS);
        }, () => { if (held === gesture) stop(); });
        return;
      }
      current.onNavigate(gesture.direction, gesture.controller.signal);
      if (held === gesture) schedule(gesture, REPEAT_INTERVAL_MS);
    };
    const start = (direction: Direction, key?: string) => {
      stop();
      const current = latest.current;
      if (direction < 0 ? !current.canPrevious : !current.canNext && !current.hasMore) return;
      const gesture: HeldNavigation = { key, direction, repeating: false, controller: new AbortController() };
      held = gesture;
      if (key) current.onNavigate(direction, gesture.controller.signal);
      if (held === gesture) schedule(gesture, key ? REPEAT_INTERVAL_MS : POINTER_HOLD_DELAY_MS);
      return gesture;
    };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || !ownsFocus()) {
        stop(); return;
      }
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
      if (!direction) { stop(); return; }
      event.preventDefault();
      // Own the entire cadence, including the initial hold delay, on every OS.
      if (!event.repeat) start(direction, event.key);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== held?.key) return;
      if (!held.repeating) {
        window.clearTimeout(timer);
        pendingTap = held.controller;
        held = null;
      } else stop();
    };
    const focus = () => { if (!ownsFocus()) stop(); };
    const tap = (direction: Direction) => {
      stop();
      pendingTap = new AbortController();
      latest.current.onNavigate(direction, pendingTap.signal);
    };
    controls.current.tap = tap;
    controls.current.beginHold = direction => {
      const gesture = start(direction);
      return commitTap => {
        // A cancelled contact must not stop a newer hold or add a release click.
        if (!gesture || held !== gesture) return;
        const shouldTap = commitTap && !gesture.repeating;
        stop();
        if (shouldTap) tap(direction);
      };
    };

    const controller = new AbortController();
    const { signal } = controller;
    window.addEventListener("keydown", down, { signal });
    window.addEventListener("keyup", up, { signal, capture: true });
    window.addEventListener("blur", stop, { signal });
    window.addEventListener("pagehide", stop, { signal });
    window.addEventListener("pointerdown", stop, { signal, capture: true });
    document.addEventListener("visibilitychange", focus, { signal });
    document.addEventListener("focusin", focus, { signal });
    return () => { stop(); controller.abort(); };
  }, [viewerRef]);
  return controls.current;
}
