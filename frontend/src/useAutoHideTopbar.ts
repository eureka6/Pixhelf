import { useCallback, useLayoutEffect, useState } from "preact/hooks";

export function useAutoHideTopbar(pinned: boolean, location: unknown, sidebarCollapsed: boolean) {
  const [hidden, setHidden] = useState(false);
  const reveal = useCallback(() => setHidden(false), []);

  useLayoutEffect(() => {
    reveal();
    if (pinned) return;
    // Clamp overscroll so rubber-banding at either end cannot reverse the bar.
    const scrollTop = () => Math.max(0, Math.min(window.scrollY,
      document.documentElement.scrollHeight - window.innerHeight));
    let previous = scrollTop();
    let distance = 0;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scrollTop();
      const delta = top - previous;
      previous = top;
      if (top <= 80 || document.querySelector('.justified-gallery[data-resizing="true"]')) {
        distance = 0; reveal(); return;
      }
      if (!delta) return;
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      // Accumulate deliberate movement, ignoring small scroll/trackpad jitter.
      if (Math.abs(distance) < 12) return;
      setHidden(distance > 0 && !document.querySelector(".topbar :focus-visible"));
      distance = 0;
    };
    const scroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const reset = () => { previous = scrollTop(); distance = 0; reveal(); };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", reset);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", reset);
    };
  }, [pinned, location, sidebarCollapsed, reveal]);

  return { hidden: hidden && !pinned, reveal };
}
