import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ChevronLeft, ChevronRight, LoaderCircle } from "./icons";
import type { useViewerNavigation } from "./useViewerNavigation";

export function ViewerNavigationButton({ direction, disabled, loading = false, navigation }: {
  direction: -1 | 1;
  disabled: boolean;
  loading?: boolean;
  navigation: ReturnType<typeof useViewerNavigation>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const contact = useRef<{ id: number; finish: (commitTap: boolean) => void } | null>(null);
  const unavailable = disabled || loading;
  const previous = direction === -1;

  const finish = (commitTap = false) => {
    const held = contact.current;
    contact.current = null;
    const button = ref.current;
    if (button) delete button.dataset.pressed;
    if (!held) return;
    held.finish(commitTap);
    try {
      if (button?.hasPointerCapture(held.id)) button.releasePointerCapture(held.id);
    } catch {
      // Capture may already have been released by the browser.
    }
  };

  useLayoutEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () => finish();
    window.addEventListener("blur", cancel, { signal });
    window.addEventListener("pagehide", cancel, { signal });
    window.addEventListener("keydown", cancel, { signal });
    window.addEventListener("pointerdown", cancel, { signal, capture: true });
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); }, { signal });
    return () => { cancel(); controller.abort(); };
  }, []);

  const press = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (unavailable) return;
    contact.current = { id: event.pointerId, finish: navigation.beginHold(direction) };
    event.currentTarget.dataset.pressed = "true";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      finish();
    }
  };
  const release = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (event.pointerId === contact.current?.id) finish(event.type === "pointerup");
  };

  return <button
    ref={ref}
    type="button"
    className={`viewer-nav ${previous ? "viewer-previous" : "viewer-next"}`}
    onClick={event => {
      // Pointer release owns taps; click remains for keyboard/assistive activation.
      if (event.detail > 0 || unavailable) { event.preventDefault(); return; }
      navigation.tap(direction);
    }}
    onPointerDown={press}
    onPointerMove={event => {
      if (event.pointerId === contact.current?.id && event.buttons === 0) finish();
    }}
    onPointerUp={release}
    onPointerCancel={release}
    onLostPointerCapture={release}
    onContextMenu={event => event.preventDefault()}
    onDblClick={event => event.preventDefault()}
    aria-disabled={unavailable}
    tabIndex={unavailable ? -1 : undefined}
    data-loading={loading || undefined}
    aria-busy={loading || undefined}
    aria-label={loading ? "正在加载下一张" : previous ? "上一张图片" : "下一张图片"}
    title={previous ? "上一张 (←)" : "下一张 (→)"}
  >
    <span className="viewer-nav-glyph">
      {loading ? <LoaderCircle className="spin" size={20} />
        : previous ? <ChevronLeft size={28} strokeWidth={1.7} /> : <ChevronRight size={28} strokeWidth={1.7} />}
    </span>
  </button>;
}
