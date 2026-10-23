import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { authentication } from "./auth";
import { CARD_MENU_EVENT, clearCardFeedback, useCardInteraction, type CardMenuRequest } from "./cardInteraction";
import { Download, FolderInput, Heart, LoaderCircle, Trash2 } from "./icons";
import type { GallerySelection } from "./JustifiedGallery";
import { MAX_SELECTION, useManagement, type ManagementAction } from "./management";
import { SelectionDialog } from "./SelectableGallery";
import { SelectionBar } from "./SelectionBar";
import { toggleSelection, useSelectionKeyboard } from "./selection";
import { useSelectionGestures } from "./selectionGestures";
import type { Album } from "./types";

export function useAlbumSelection(albums: Album[], scope: string, onActivate: () => void) {
  const manager = useManagement();
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<"move" | "trash" | null>(null);
  const anchor = useRef<string | null>(null);
  const activate = useRef(onActivate);
  activate.current = onActivate;
  const clear = useCallback(() => { setIds(new Set()); setDialog(null); anchor.current = null; clearCardFeedback(); }, []);
  useEffect(clear, [scope, clear]);
  const selected = useMemo(() => albums.filter(album => ids.has(album.path)), [albums, ids]);
  useEffect(() => { setIds(current => {
    const available = new Set(albums.map(album => album.path));
    const next = new Set([...current].filter(path => available.has(path)));
    return next.size === current.size ? current : next;
  }); }, [albums]);
  const change = useCallback((next: ReadonlySet<string>) => {
    if (manager.busy || authentication.guest) return;
    if (next.size) activate.current();
    if (next.size > MAX_SELECTION) manager.notify(`每次最多选择 ${MAX_SELECTION} 个相册`, true);
    setIds(new Set([...next].slice(0, MAX_SELECTION)));
  }, [manager.busy, manager.notify]);
  const toggle = useCallback((path: string, range = false) => {
    if (manager.busy || authentication.guest) return;
    activate.current();
    setIds(current => toggleSelection(current, albums, album => album.path, path, range ? anchor.current : null,
      () => manager.notify(`每次最多选择 ${MAX_SELECTION} 个相册`, true)));
    anchor.current = path;
  }, [albums, manager.busy, manager.notify]);
  const selectAll = useCallback(() => change(new Set(albums.map(album => album.path))), [albums, change]);
  useSelectionKeyboard(ids.size > 0, manager.busy, clear, selectAll);
  const allFavorite = selected.length > 0 && selected.every(album => manager.favoriteAlbums.has(album.path));
  const run = async (action: ManagementAction, options?: { destination?: string; favorite?: boolean }) => {
    try {
      const results = await manager.run(action, selected.map(album => album.path), { ...options, kind: "albums" });
      const failed = results.filter(result => !result.ok);
      const label = action === "favorite" ? options?.favorite ? "收藏" : "取消收藏" : action === "move" ? "移动" : "移入回收站";
      manager.notify(failed.length ? `${results.length - failed.length} 个相册已${label}，${failed.length} 个失败：${failed[0]?.error}` : `已${label} ${results.length} 个相册`, Boolean(failed.length));
      setDialog(null);
      if (failed.length) setIds(new Set(failed.map(result => result.id)));
      else if (action !== "favorite") clear();
    } catch (reason) { manager.notify(reason instanceof Error ? reason.message : "相册操作失败", true); }
  };
  const selection: GallerySelection | undefined = authentication.guest ? undefined : {
    active: ids.size > 0, ids, favoriteIds: manager.favoriteAlbums, disabled: manager.busy || Boolean(dialog), toggle, change, selectAll, clear,
    batch: { allFavorite, favoriteDisabled: !manager.ready,
      download: () => void manager.download([...ids], "albums").catch(error => manager.notify(error.message, true)),
      favorite: () => void run("favorite", { favorite: !allFavorite }),
      move: () => setDialog("move"), trash: () => setDialog("trash"),
    },
  };
  const controls = (target: HTMLDivElement | null) => <>
    <SelectionBar target={target} count={selected.length} unit="个相册" label="所选相册操作" busy={manager.busy} progress={manager.progress} onClear={clear}
      messages={(manager.busy || manager.error || ids.size === MAX_SELECTION) && <>
        {ids.size === MAX_SELECTION && <span className="selection-progress">已达 {MAX_SELECTION} 个相册上限</span>}
        {manager.busy && <span className="selection-progress" role="status"><LoaderCircle className="spin" size={15} />正在处理，请稍候…</span>}
        {manager.error && <span className="selection-progress" role="alert">{manager.error}<button type="button" onClick={() => void manager.refresh()}>重试</button></span>}
      </>}>
        <button type="button" title="下载" disabled={manager.busy} onClick={() => void manager.download([...ids], "albums").catch(error => manager.notify(error.message, true))}><Download size={18} /><span>下载</span></button>
        <button type="button" title={allFavorite ? "取消收藏" : "收藏"} aria-label={allFavorite ? "取消收藏所选相册" : "收藏所选相册"} disabled={manager.busy || !manager.ready} onClick={() => void run("favorite", { favorite: !allFavorite })}><Heart size={18} fill={allFavorite ? "currentColor" : "none"} /><span>{allFavorite ? "取消收藏" : "收藏"}</span></button>
        <button type="button" title="移动" disabled={manager.busy} onClick={() => setDialog("move")}><FolderInput size={18} /><span>移动</span></button>
        <button type="button" className="selection-trash" title="移入回收站" disabled={manager.busy} onClick={() => setDialog("trash")}><Trash2 size={18} /><span>删除</span></button>
    </SelectionBar>
    {dialog && <SelectionDialog kind={dialog} selectedAlbums={selected} busy={manager.busy} onClose={() => setDialog(null)} onConfirm={destination => void run(dialog, dialog === "move" ? { destination } : undefined)} />}
  </>;
  return { selection, clear, controls };
}

export function SelectableAlbumList({ selection, children, className, onMenu }: {
  selection?: GallerySelection; children: ComponentChildren; className: string;
  onMenu?: (path: string, request: CardMenuRequest, card: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<{ id: string; left: number; top: number; width: number; height: number }[]>([]);
  const menu = useRef(onMenu);
  menu.current = onMenu;
  useCardInteraction(ref, true, Boolean(onMenu), Boolean(onMenu));
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const open = (event: Event) => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-album-path]") : null;
      if (card && root.contains(card)) menu.current?.(card.dataset.albumPath!, (event as CustomEvent<CardMenuRequest>).detail, card);
    };
    root.addEventListener(CARD_MENU_EVENT, open, true);
    return () => root.removeEventListener(CARD_MENU_EVENT, open, true);
  }, []);
  useSelectionGestures(ref, marquee, items, selection, true);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const next = [...root.querySelectorAll<HTMLElement>("[data-album-path]")].map(card => {
        const rect = card.getBoundingClientRect();
        return { id: card.dataset.albumPath!, left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height };
      });
      setItems(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    const mutation = new MutationObserver(measure);
    mutation.observe(root, { childList: true });
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, []);
  return <div ref={ref} className={className} data-selecting={selection?.active} data-selection-enabled={Boolean(selection)}>
    {children}<div ref={marquee} className="gallery-selection-marquee" hidden />
  </div>;
}
