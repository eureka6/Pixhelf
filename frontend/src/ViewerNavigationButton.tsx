import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ChevronLeft, ChevronRight, LoaderCircle } from "./icons";

export function ViewerNavigationButton({ direction, disabled, loading = false, onNavigate }: {
  direction: -1 | 1;
  disabled: boolean;
  loading?: boolean;
  onNavigate: (direction: -1 | 1) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const unavailable = disabled || loading;
  const previous = direction === -1;

  useLayoutEffect(() => {
    if (!unavailable || !ref.current) return;
    delete ref.current.dataset.pressed;
  }, [unavailable]);

  const press = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || event.currentTarget.disabled) return;
    event.currentTarget.dataset.pressed = "true";
  };
  const release = (event: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    delete event.currentTarget.dataset.pressed;
  };

  return <button
    ref={ref}
    type="button"
    className={`viewer-nav ${previous ? "viewer-previous" : "viewer-next"}`}
    onClick={() => onNavigate(direction)}
    onPointerDown={press}
    onPointerUp={release}
    onPointerCancel={release}
    onPointerLeave={release}
    onLostPointerCapture={release}
    disabled={unavailable}
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
