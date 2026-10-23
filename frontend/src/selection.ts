import { useEffect } from "preact/hooks";
import { MAX_SELECTION } from "./management";

export function toggleSelection<T>(
  current: ReadonlySet<string>, items: readonly T[], key: (item: T) => string,
  id: string, anchor: string | null, onLimit: (range: boolean) => void,
): ReadonlySet<string> {
  const start = anchor !== null && current.size ? items.findIndex(item => key(item) === anchor) : -1;
  const end = start >= 0 ? items.findIndex(item => key(item) === id) : -1;
  const next = new Set(current);
  if (end < 0) {
    if (!next.delete(id)) {
      if (next.size >= MAX_SELECTION) { onLimit(false); return current; }
      next.add(id);
    }
  } else {
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
      const itemId = key(items[index]);
      if (next.has(itemId)) continue;
      if (next.size >= MAX_SELECTION) { onLimit(true); break; }
      next.add(itemId);
    }
  }
  return next;
}

export function useSelectionKeyboard(active: boolean, busy: boolean, clear: () => void, selectAll: () => void) {
  useEffect(() => {
    if (!active || busy) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open], .image-viewer, .photo-card-menu:popover-open, [data-selection-dragging]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === "Escape") { event.preventDefault(); clear(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectAll(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active, busy, clear, selectAll]);
}
