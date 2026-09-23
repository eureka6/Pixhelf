import { readViewerHistoryEntry } from "./viewerHistory";

const POSITION = "__pixhelfPosition";
const BASE = "__pixhelfSelectionBase";
const LAYER = "__pixhelfSelection";
const record = (state: unknown): Record<string, unknown> => state && typeof state === "object" ? { ...state } : {};
let current = { state: record(window.history.state), href: window.location.href };

// Keep all app history writes observable, including viewer replacements between renders.
export function writeHistoryState(state: unknown, href: string, replace = false) {
  const previous = record(window.history.state);
  const position = typeof previous[POSITION] === "number" ? previous[POSITION] : 0;
  if (previous[POSITION] === undefined && !replace) {
    window.history.replaceState({ ...previous, [POSITION]: position }, "", window.location.href);
  }
  const next = { ...record(state), [POSITION]: position + (replace ? 0 : 1) };
  window.history[replace ? "replaceState" : "pushState"](next, "", href);
  current = { state: next, href: window.location.href };
}

// A viewer also needs a gallery entry underneath it where selection can be
// dismissed. Preparing it before opening preserves the viewer's Forward history.
export function ensureSelectionHistory() {
  const state = record(window.history.state);
  if (state[LAYER] || readViewerHistoryEntry(state)) return;
  const id = `${Date.now()}-${Math.random()}`;
  writeHistoryState({ ...state, [BASE]: id }, window.location.href, true);
  delete state[BASE];
  writeHistoryState({ ...state, [LAYER]: id }, window.location.href);
}

export function handleSelectionHistory(event: PopStateEvent, active: boolean, clear: () => void): boolean {
  const from = current;
  const to = record(event.state);
  current = { state: to, href: window.location.href };
  const forward = typeof from.state[POSITION] === "number" && typeof to[POSITION] === "number"
    && to[POSITION] > from.state[POSITION];
  const returningToBase = from.state[LAYER] && from.href === current.href
    && (from.state[LAYER] === to[BASE] || (!to[LAYER] && !readViewerHistoryEntry(to)
      && typeof to[POSITION] === "number" && from.state[POSITION] === to[POSITION] + 1));
  if (returningToBase && !readViewerHistoryEntry(from.state)) {
    if (active) {
      const scroll = { left: window.scrollX, top: window.scrollY, behavior: "instant" as const };
      clear();
      delete to[BASE];
      writeHistoryState(to, window.location.href, true);
      requestAnimationFrame(() => window.scrollTo(scroll));
    } else {
      // Explicit clearing leaves an idle layer that can be reused by the next
      // selection. Skip its duplicate gallery entry on the way back.
      window.history.back();
    }
    return true;
  }
  if (forward && to[BASE]) {
    window.history.forward();
    return true;
  }
  if (active && !readViewerHistoryEntry(from.state) && from.href !== current.href) clear();
  return false;
}
