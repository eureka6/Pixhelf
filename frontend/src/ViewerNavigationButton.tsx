import { ChevronLeft, ChevronRight, LoaderCircle } from "./icons";
import type { useViewerNavigation } from "./useViewerNavigation";

export function ViewerNavigationButton({ direction, disabled, loading = false, navigation }: {
  direction: -1 | 1;
  disabled: boolean;
  loading?: boolean;
  navigation: ReturnType<typeof useViewerNavigation>;
}) {
  const unavailable = disabled || loading;
  const previous = direction === -1;

  return <button
    type="button"
    className={`viewer-nav ${previous ? "viewer-previous" : "viewer-next"}`}
    data-navigation-direction={direction}
    onClick={event => {
      // Pointer release owns taps; click remains for keyboard/assistive activation.
      if (event.detail > 0 || unavailable) { event.preventDefault(); return; }
      navigation.tap(direction);
    }}
    onContextMenu={event => event.preventDefault()}
    onDblClick={event => { event.preventDefault(); event.stopPropagation(); }}
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
