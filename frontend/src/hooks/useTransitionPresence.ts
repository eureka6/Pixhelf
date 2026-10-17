import { useCallback, useLayoutEffect, useState } from "preact/hooks";

export function useTransitionPresence(visible: boolean, duration: number) {
  const [mounted, setMounted] = useState(visible);

  useLayoutEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;

    // The transition event normally removes the drawer. Cover hidden tabs and breakpoint changes.
    const timer = window.setTimeout(() => setMounted(false), duration + 100);
    return () => window.clearTimeout(timer);
  }, [duration, mounted, visible]);

  const finishExit = useCallback(() => {
    if (!visible) setMounted(false);
  }, [visible]);

  return { mounted: visible || mounted, finishExit };
}
