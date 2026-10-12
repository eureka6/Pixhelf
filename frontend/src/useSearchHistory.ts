import { useState } from "preact/hooks";

const STORAGE_KEY = "pixhelf.search-history";
const HISTORY_LIMIT = 12;

function readHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((query): query is string => typeof query === "string").map(query => query.trim()).filter(Boolean))].slice(0, HISTORY_LIMIT)
      : [];
  } catch { return []; }
}

export function useSearchHistory() {
  const [entries, setEntries] = useState(readHistory);
  const update = (next: string[]) => {
    setEntries(next);
    try {
      if (next.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* Search remains usable when browser storage is unavailable. */ }
  };
  return {
    entries,
    remember: (value: string) => {
      const query = value.trim();
      if (query) update([query, ...entries.filter(entry => entry.toLocaleLowerCase() !== query.toLocaleLowerCase())].slice(0, HISTORY_LIMIT));
    },
    clear: () => update([]),
  };
}
