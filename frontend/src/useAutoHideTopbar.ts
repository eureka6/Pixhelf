import { useCallback, useLayoutEffect, useState } from "preact/hooks";

export function useAutoHideTopbar(pinned: boolean, location: unknown, sidebarCollapsed: boolean) {
  const [hidden, setHidden] = useState(false);
  const reveal = useCallback(() => setHidden(false), []);

  useLayoutEffect(() => {
    reveal();
    if (pinned) return;
    // Clamp overscroll so rubber-banding at either end cannot reverse the bar.
    const position = () => {
      const height = window.innerHeight;
      const maximum = Math.max(0, document.documentElement.scrollHeight - height);
      return { top: Math.max(0, Math.min(window.scrollY, maximum)), maximum, height };
    };
    let previous = position();
    let layoutWidth = document.documentElement.clientWidth;
    let distance = 0;
    let frame = 0;
    let resizeGuardUntil = 0;
    let touch: { id: number; x: number; y: number; previousY: number; distance: number } | null = null;
    const update = () => {
      frame = 0;
      const current = position();
      // Browser chrome can resize the viewport and clamp/anchor the page at
      // its lower edge. That movement is not an upward or downward gesture.
      const atBottom = previous.top >= previous.maximum - 1 && current.top >= current.maximum - 1;
      const baseline = current.height !== previous.height && atBottom
        ? current.top : Math.min(previous.top, current.maximum);
      const { top } = current;
      const delta = top - baseline;
      previous = current;
      if (performance.now() < resizeGuardUntil || top <= 80 || document.querySelector('.justified-gallery[data-resizing="true"]')
        || document.querySelector('.desktop-sidebar')?.getAnimations().length) {
        distance = 0; reveal(); return;
      }
      if (!delta) return;
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      // Accumulate deliberate movement, ignoring small scroll/trackpad jitter.
      if (Math.abs(distance) < 12) return;
      setHidden(distance > 0 && !document.querySelector(".topbar :focus-visible, .bottom-dock :focus-visible"));
      distance = 0;
    };
    const scroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const reset = () => {
      const width = document.documentElement.clientWidth;
      // Address/toolbars and the keyboard usually change only height. Keep
      // tracking real scroll direction, even throughout a resize animation.
      if (width === layoutWidth) { scroll(); return; }
      layoutWidth = width;
      touch = null;
      // A width change reflows the gallery and restores its scroll anchor.
      resizeGuardUntil = performance.now() + 250;
      previous = position(); distance = 0; reveal();
    };
    const touchStart = (event: TouchEvent) => {
      touch = null;
      if (event.touches.length !== 1 || !window.matchMedia("(max-width: 720px)").matches
        || !(event.target instanceof Element) || !event.target.closest(".content")
        || event.target.closest('.photo-card-select, .photo-card-controls, input, textarea, select, [contenteditable="true"]')
        || document.querySelector('dialog[open], .photo-card-menu, [data-selection-dragging]')) return;
      // A nested scroller owns its gesture; only page panning reveals the dock.
      for (let element: Element | null = event.target; element && element !== document.body; element = element.parentElement) {
        if (element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) return;
      }
      const finger = event.touches[0];
      touch = { id: finger.identifier, x: finger.clientX, y: finger.clientY, previousY: finger.clientY, distance: 0 };
    };
    const touchMove = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1 || event.defaultPrevented) { touch = null; return; }
      const finger = event.touches[0];
      if (finger.identifier !== touch.id) return;
      const x = Math.abs(finger.clientX - touch.x), y = Math.abs(finger.clientY - touch.y);
      if (x > 8 && x > y) { touch = null; return; }
      const delta = finger.clientY - touch.previousY;
      touch.previousY = finger.clientY;
      touch.distance = delta > 0 ? touch.distance + delta : 0;
      if (touch.distance < 8 || y <= x) return;
      // Browser chrome may consume the first part of an upward page scroll.
      // Reveal on finger intent instead of waiting for scrollY to move.
      previous = position(); distance = 0; touch.distance = 0;
      reveal();
    };
    const touchEnd = () => { touch = null; };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", reset);
    window.visualViewport?.addEventListener("resize", reset);
    document.addEventListener("touchstart", touchStart, { passive: true });
    document.addEventListener("touchmove", touchMove, { passive: true });
    document.addEventListener("touchend", touchEnd, { passive: true });
    document.addEventListener("touchcancel", touchEnd, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", reset);
      window.visualViewport?.removeEventListener("resize", reset);
      document.removeEventListener("touchstart", touchStart);
      document.removeEventListener("touchmove", touchMove);
      document.removeEventListener("touchend", touchEnd);
      document.removeEventListener("touchcancel", touchEnd);
    };
  }, [pinned, location, sidebarCollapsed, reveal]);

  return { hidden: hidden && !pinned, reveal };
}
