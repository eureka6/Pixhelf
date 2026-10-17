import { useLayoutEffect } from "preact/hooks";

export function useVisualViewport(): void {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;
    let settleTimer = 0;
    const update = () => {
      const pageOffset = viewport.pageTop - window.scrollY;
      const offset = Math.max(0, viewport.offsetTop, pageOffset);
      const root = document.documentElement;
      const top = `${Math.round(offset * 100) / 100}px`;
      const height = `${viewport.height}px`;
      if (root.style.getPropertyValue("--visual-viewport-top") !== top) root.style.setProperty("--visual-viewport-top", top);
      if (root.style.getPropertyValue("--visual-viewport-height") !== height) root.style.setProperty("--visual-viewport-height", height);
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (active.isContentEditable
        || active.matches('textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="hidden"])'));
      const adjusted = String(editing || viewport.scale > 1.01);
      if (root.dataset.visualViewportAdjusted !== adjusted) root.dataset.visualViewportAdjusted = adjusted;
    };
    const schedule = () => {
      // Apply the event's geometry immediately; a following frame also catches
      // browsers that commit viewport metrics just after the event dispatch.
      update();
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); });
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(update, 120);
    };

    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      delete document.documentElement.dataset.visualViewportAdjusted;
      document.documentElement.style.removeProperty("--visual-viewport-top");
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);
}
