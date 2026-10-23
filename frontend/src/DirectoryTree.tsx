import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Check, ChevronRight, Folder, HardDrive, LoaderCircle, Search } from "./icons";
import { managementRequest } from "./management";
import type { GalleryImage } from "./types";
import { isGalleryImage } from "./api";

export type DirectoryEntry = { path: string; name: string; directory: boolean; hasChildren: boolean; size: number; imageId: string | null };
export type DirectoryPage = { path: string; items: DirectoryEntry[]; images?: GalleryImage[]; total: number; nextOffset: number | null; truncated?: boolean };
export async function getDirectories(path: string, options: { search?: string; content?: boolean; offset?: number } = {}, signal?: AbortSignal): Promise<DirectoryPage> {
  const params = new URLSearchParams({ path });
  if (options.search) params.set("search", options.search);
  if (options.content) params.set("content", "true");
  if (options.offset) params.set("offset", String(options.offset));
  const page = await managementRequest(`/directories?${params}`, undefined, signal) as DirectoryPage;
  if (!page || page.path !== path || !Array.isArray(page.items) || !page.items.every(item => item
    && typeof item.path === "string" && typeof item.name === "string" && typeof item.directory === "boolean")
    || !Number.isSafeInteger(page.total) || page.total < page.items.length
    || !(page.nextOffset === null || Number.isSafeInteger(page.nextOffset)
      && page.nextOffset > (options.offset ?? 0) && page.nextOffset < page.total)) throw new Error("目录数据无效，请重试");
  if (page.images !== undefined && (!Array.isArray(page.images) || !page.images.every(isGalleryImage))) throw new Error("目录图片数据无效，请重试");
  return page;
}

// Dialog pickers contain the wheel; short page trees let the page scroll.
function useContainedScroll<T extends HTMLElement>(pageScroll = false) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (pageScroll && element.scrollHeight <= element.clientHeight + 1) return;
      event.stopPropagation();
      const atStart = event.deltaY < 0 && element.scrollTop <= 0;
      const atEnd = event.deltaY > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      if (atStart || atEnd || Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [pageScroll]);
  return ref;
}

type Branch = { items?: DirectoryEntry[]; error?: string };
const ROOT: DirectoryEntry = { path: "", name: "图库根目录", directory: true, hasChildren: true, size: 0, imageId: null };

export function DirectoryTree({ value, onChange, excluded = [], disabled = false, label = "目录", pageScroll = false, onMenu }: {
  value: string | null; onChange: (path: string) => void; excluded?: string[]; disabled?: boolean; label?: string;
  pageScroll?: boolean; onMenu?: (path: string, point: { x: number; y: number }, opener: HTMLElement) => void;
}) {
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));
  const [focus, setFocus] = useState(value ?? "");
  const [filter, setFilter] = useState("");
  const [results, setResults] = useState<DirectoryPage | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searchRetry, setSearchRetry] = useState(0);
  const controller = useRef(new AbortController());
  const requested = useRef(new Set<string>());
  const scroll = useContainedScroll<HTMLDivElement>(pageScroll);
  const revealed = useRef<string | null>(null);
  const blocked = (path: string) => excluded.some(parent => path === parent || path.startsWith(`${parent}/`));
  const load = useCallback((path: string, retry = false) => {
    if (requested.current.has(path) && !retry) return;
    requested.current.add(path);
    setBranches(current => ({ ...current, [path]: {} }));
    void getDirectories(path, {}, controller.current.signal).then(page => {
      if (!controller.current.signal.aborted) setBranches(current => ({ ...current, [path]: { items: page.items } }));
    }).catch(reason => {
      if (!controller.current.signal.aborted) setBranches(current => ({ ...current, [path]: { error: reason.message } }));
    });
  }, []);
  useEffect(() => () => controller.current.abort(), []);
  useEffect(() => {
    const parts = (value ?? "").split("/").filter(Boolean);
    const ancestors = ["", ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
    setExpanded(current => new Set([...current, ...ancestors]));
    ancestors.forEach(path => load(path));
    setFocus(value ?? "");
  }, [value, load]);
  const query = filter.trim();
  useEffect(() => {
    setResults(null); setSearchError("");
    if (!query) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void getDirectories("", { search: query }, abort.signal).then(page => { if (!abort.signal.aborted) setResults(page); })
        .catch(reason => { if (!abort.signal.aborted) setSearchError(reason.message); });
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, searchRetry]);
  useEffect(() => {
    if (results) setFocus(results.items.find(item => !blocked(item.path))?.path ?? "");
  }, [results]);
  useEffect(() => {
    const rows = [...(scroll.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    if (!rows.some(row => row.tabIndex === 0)) setFocus(rows.find(row => row.getAttribute("aria-selected") === "true")?.dataset.path ?? rows[0]?.dataset.path ?? "");
    if (query || value === null || revealed.current === value) return;
    const selected = rows.find(row => row.dataset.path === value);
    if (selected) {
      // Scroll only this tree; page position must survive selecting a destination.
      const container = scroll.current!, bounds = selected.getBoundingClientRect(), frame = container.getBoundingClientRect();
      if (bounds.bottom > frame.bottom) container.scrollTop += bounds.bottom - frame.bottom;
      else if (bounds.top < frame.top) container.scrollTop += bounds.top - frame.top;
      revealed.current = value;
    }
  }, [branches, expanded, results, query, value]);
  const toggle = (path: string) => {
    if (disabled) return;
    if (!expanded.has(path)) load(path);
    setExpanded(current => { const next = new Set(current); if (!next.delete(path)) next.add(path); return next; });
  };
  const key = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>, item: DirectoryEntry) => {
    if (disabled || event.target !== event.currentTarget) return;
    if (onMenu && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) {
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu(item.path, { x: rect.left + 16, y: rect.bottom }, event.currentTarget);
      return;
    }
    const tree = scroll.current!;
    const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = rows.indexOf(event.currentTarget);
    const focusRow = (row?: HTMLElement) => row?.focus({ preventScroll: false });
    if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Enter", " "].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
    }
    if (event.key === "ArrowDown") focusRow(rows[Math.min(rows.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") focusRow(rows[Math.max(0, index - 1)]);
    else if (event.key === "Home") focusRow(rows[0]);
    else if (event.key === "End") focusRow(rows.at(-1));
    else if (event.key === "ArrowRight" && !query && item.hasChildren) {
      if (!expanded.has(item.path)) toggle(item.path); else focusRow(rows[index + 1]);
    } else if (event.key === "ArrowLeft" && !query) {
      if (expanded.has(item.path)) toggle(item.path);
      else focusRow(rows.find(row => row.dataset.path === item.path.split("/").slice(0, -1).join("/")));
    } else if (event.key === "Enter" || event.key === " ") onChange(item.path);
  };
  const row = (item: DirectoryEntry, depth: number): JSX.Element | null => {
    if (blocked(item.path)) return null;
    const open = !query && expanded.has(item.path);
    const branch = branches[item.path];
    return <div key={item.path} role="none">
      <div role="treeitem" className="directory-tree-row" data-path={item.path} aria-level={depth + 1}
        aria-selected={value === item.path} aria-disabled={disabled} aria-expanded={!query && item.hasChildren ? open : undefined}
        tabIndex={!disabled && focus === item.path ? 0 : -1} style={{ "--tree-depth": Math.min(depth, 8) }} title={item.path || item.name}
        onFocus={event => { if (event.target === event.currentTarget) setFocus(item.path); }}
        onContextMenu={event => {
          if (!onMenu || disabled) return;
          event.preventDefault(); event.stopPropagation();
          onMenu(item.path, { x: event.clientX, y: event.clientY }, event.currentTarget);
        }}
        onKeyDown={event => key(event, item)} onClick={() => { if (!disabled) { setFocus(item.path); onChange(item.path); } }}>
        <button type="button" className="directory-disclosure" tabIndex={-1} aria-label={`${open ? "收起" : "展开"}${item.name}`}
          disabled={disabled || !item.hasChildren || Boolean(query)} data-empty={!item.hasChildren || Boolean(query)}
          onClick={event => { event.stopPropagation(); toggle(item.path); event.currentTarget.parentElement?.focus({ preventScroll: true }); }}><ChevronRight size={14} /></button>
        {item.path ? <Folder size={17} /> : <HardDrive size={17} />}
        <span className="directory-tree-name"><span>{item.name}</span>{query && item.path !== item.name && <small>{item.path}</small>}</span>
        {value === item.path && <Check className="directory-picked" size={15} />}
      </div>
      {open && <div role="group">
        {!branch || (!branch.items && !branch.error) ? <div className="directory-tree-status" role="status"><LoaderCircle size={14} className="spin" /></div>
          : branch.error ? <button className="directory-tree-error" type="button" disabled={disabled} onClick={() => load(item.path, true)} title={branch.error}>读取失败，重试</button>
          : branch.items!.map(child => row(child, depth + 1))}
      </div>}
    </div>;
  };
  return <div className="directory-picker">
    <label className="directory-search"><Search size={16} /><input type="search" aria-label="查找目录" placeholder="查找目录" value={filter} disabled={disabled} onInput={event => { setFilter(event.currentTarget.value); setFocus(""); }} /></label>
    <div className="directory-tree-scroll" ref={scroll} role="tree" aria-label={label} aria-busy={Boolean(query && !results && !searchError)}>
      {query ? searchError ? <button type="button" className="directory-tree-error" onClick={() => setSearchRetry(value => value + 1)} title={searchError}>读取失败，重试</button>
        : !results ? <div className="directory-tree-status" role="status"><LoaderCircle className="spin" size={17} /></div>
        : results.items.filter(item => !blocked(item.path)).length ? <>{results.items.map(item => row(item, 0))}{results.truncated && <p className="directory-tree-status">仅显示前 200 项，请缩小范围</p>}</>
        : <p className="directory-tree-status">没有匹配的目录</p>
        : row(ROOT, 0)}
    </div>
  </div>;
}
