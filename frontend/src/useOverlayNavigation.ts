import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

const NAVIGATION_REGION = '.desktop-sidebar, .gallery-sidebar-toggle, .topbar-brand';

export function useOverlayNavigation(compact: boolean) {
  const [mode, setMode] = useState<"closed" | "hover" | "pinned">("closed");
  const timer = useRef(0);
  const cancelClose = useCallback(() => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    cancelClose();
    setMode(current => current === "pinned" ? current : "closed");
  }, [cancelClose]);
  const enter = (event: PointerEvent) => {
    if (compact || event.pointerType !== "mouse" || !window.matchMedia("(hover: hover)").matches) return;
    cancelClose();
    setMode(current => current === "closed" ? "hover" : current);
  };
  const leave = (event: PointerEvent) => {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest(NAVIGATION_REGION)) return;
    cancelClose();
    // Bridge the small gap between the trigger and the drawer.
    timer.current = window.setTimeout(() => setMode(current => current === "hover" ? "closed" : current), 60);
  };
  useLayoutEffect(() => { cancelClose(); setMode("closed"); }, [compact, cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);
  useLayoutEffect(() => {
    if (mode !== "hover") return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(NAVIGATION_REGION)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        close();
        document.querySelector<HTMLButtonElement>(".gallery-sidebar-toggle")?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [mode, close]);
  return { open: mode !== "closed", pinned: mode === "pinned", enter, leave, close,
    toggle: () => { cancelClose(); setMode(current => current === "pinned" ? "closed" : "pinned"); } };
}
