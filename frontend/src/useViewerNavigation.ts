import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { GalleryImage } from "./types";
import { mouseSideDirection } from "./viewerLogic";

const HOLD_DELAY_MS = 400;
const INITIAL_REPEAT_MS = 400;
const MIN_REPEAT_MS = 250;
const ACCELERATION_MS = 30;

type Direction = -1 | 1;
type HeldNavigation = {
  source?: string;
  direction: Direction;
  repeating: boolean;
  steps: number;
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
    const pressedButtons = new Set<number>();
    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      held?.controller.abort();
      pendingTap?.abort();
      pendingTap = null;
      held = null;
    };
    const reset = () => { pressedButtons.clear(); stop(); };
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
    const interval = (gesture: HeldNavigation) => Math.max(
      MIN_REPEAT_MS, INITIAL_REPEAT_MS - gesture.steps * ACCELERATION_MS,
    );
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
          schedule(gesture, interval(gesture));
        }, () => { if (held === gesture) stop(); });
        return;
      }
      current.onNavigate(gesture.direction, gesture.controller.signal);
      gesture.steps += 1;
      if (held === gesture) schedule(gesture, interval(gesture));
    };
    const start = (direction: Direction, source?: string) => {
      stop();
      const current = latest.current;
      if (direction < 0 ? !current.canPrevious : !current.canNext && !current.hasMore) return;
      const gesture: HeldNavigation = { source, direction, repeating: false, steps: 0, controller: new AbortController() };
      held = gesture;
      // Keys and side buttons act on press; edge contacts wait to distinguish a drag.
      if (source) current.onNavigate(direction, gesture.controller.signal);
      if (held === gesture) schedule(gesture, HOLD_DELAY_MS);
      return gesture;
    };
    const release = (source: string) => {
      if (held?.source !== source) return;
      if (!held.repeating) {
        window.clearTimeout(timer);
        timer = 0;
        pendingTap = held.controller;
        held = null;
      } else stop();
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
    const up = (event: KeyboardEvent) => release(event.key);
    const suppressSideButton = (event: MouseEvent) => {
      const direction = mouseSideDirection(event.button);
      if (direction !== null) {
        event.preventDefault();
        event.stopPropagation();
      }
      return direction;
    };
    const sideDown = (event: MouseEvent) => {
      const direction = suppressSideButton(event);
      if (direction === null || pressedButtons.has(event.button)) return;
      // Keep physical button state across renders and input changes. The compatibility
      // mousedown following pointerdown must never restart the hold or turn twice.
      pressedButtons.add(event.button);
      if (ownsFocus()) start(direction, `mouse:${event.button}`);
      else stop();
    };
    const sideUp = (event: MouseEvent) => {
      if (suppressSideButton(event) === null) return;
      pressedButtons.delete(event.button);
      release(`mouse:${event.button}`);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && mouseSideDirection(event.button) !== null) sideDown(event);
      else stop();
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || mouseSideDirection(event.button) === null) return;
      // Chorded mouse presses/releases arrive as pointermove. Preventing the first
      // pointerdown can also suppress their compatibility mouse events.
      if (event.buttons & (event.button === 3 ? 8 : 16)) sideDown(event);
      else sideUp(event);
    };
    const lostCapture = () => { if (held?.source?.startsWith("mouse:")) reset(); };
    const focus = () => { if (!ownsFocus()) reset(); };
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
    window.addEventListener("blur", reset, { signal });
    window.addEventListener("pagehide", reset, { signal });
    window.addEventListener("pointerdown", pointerDown, { signal, capture: true });
    window.addEventListener("pointermove", pointerMove, { signal, capture: true });
    window.addEventListener("pointerup", sideUp, { signal, capture: true });
    window.addEventListener("pointercancel", reset, { signal, capture: true });
    window.addEventListener("lostpointercapture", lostCapture, { signal, capture: true });
    window.addEventListener("mousedown", sideDown, { signal, capture: true });
    window.addEventListener("mouseup", sideUp, { signal, capture: true });
    window.addEventListener("auxclick", suppressSideButton, { signal, capture: true });
    document.addEventListener("visibilitychange", focus, { signal });
    document.addEventListener("focusin", focus, { signal });
    return () => { reset(); controller.abort(); };
  }, [viewerRef]);
  return controls.current;
}
