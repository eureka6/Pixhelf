import { createPortal, forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { authentication } from "./auth";
import { DirectoryTree } from "./DirectoryTree";
import { Copy, Download, FolderInput, Heart, LoaderCircle, Trash2, X } from "./icons";
import { JustifiedGallery, type JustifiedGalleryHandle, type JustifiedGalleryProps } from "./JustifiedGallery";
import { MAX_SELECTION, useManagement, type ManagementAction } from "./management";
import { stopMediaPreview } from "./MediaPreview";
import { clearCardFeedback } from "./cardInteraction";
import { useModalDialog } from "./useModalDialog";
import type { Album, GalleryImage } from "./types";

export type SelectableGalleryHandle = JustifiedGalleryHandle & { select: (image: GalleryImage) => boolean; selectAll: (images?: GalleryImage[]) => void; clearSelection: () => void };

export type SelectionToolbarProps = {
  toolbarTarget: HTMLDivElement | null;
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  onSelectionStart?: () => void;
};

export const SelectableGallery = forwardRef<SelectableGalleryHandle, JustifiedGalleryProps & SelectionToolbarProps>(function SelectableGallery(props, ref) {
  const manager = useManagement();
  const layoutRef = useRef<JustifiedGalleryHandle>(null);
  // Keep snapshots for selections made in the viewer, including discovered similar images.
  const [selected, setSelected] = useState<GalleryImage[]>([]);
  const ids = useMemo(() => new Set(selected.map(image => image.id)), [selected]);
  const active = selected.length > 0;
  useLayoutEffect(() => { props.onSelectionChange(ids); }, [ids, props.onSelectionChange]);
  useEffect(() => () => props.onSelectionChange(new Set()), [props.onSelectionChange]);
  const [dialog, setDialog] = useState<"move" | "copy" | "trash" | null>(null);
  const anchor = useRef<string | null>(null);
  const images = props.images;
  const setIds = useCallback((update: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => {
    setSelected(current => {
      const next = typeof update === "function" ? update(new Set(current.map(image => image.id))) : update;
      const available = new Map([...current, ...images].map(image => [image.id, image]));
      return [...next].flatMap(id => available.get(id) ?? []);
    });
  }, [images]);
  const allFavorite = selected.length > 0 && selected.every(image => manager.favoriteIds.has(image.id));
  const exit = useCallback(() => {
    setSelected([]); setDialog(null); anchor.current = null;
    clearCardFeedback();
    document.querySelector<HTMLElement>('.image-card .photo-card-select:focus')?.blur();
  }, []);
  const toggle = useCallback((id: string, range = false) => {
    if (manager.busy) return;
    props.onSelectionStart?.();
    stopMediaPreview();
    setIds(current => {
      const next = new Set(current);
      const start = range && current.size > 0 ? images.findIndex(image => image.id === anchor.current) : -1;
      const end = images.findIndex(image => image.id === id);
      if (start >= 0 && end >= 0) {
        for (const image of images.slice(Math.min(start, end), Math.max(start, end) + 1)) {
          if (next.size < MAX_SELECTION) next.add(image.id);
        }
      } else if (!next.delete(id)) {
        if (next.size >= MAX_SELECTION) manager.notify(`每次最多选择 ${MAX_SELECTION} 项`, true);
        else next.add(id);
      }
      return next;
    });
    anchor.current = id;
  }, [images, manager.busy, manager.notify, setIds, props.onSelectionStart]);
  const selectAll = useCallback((loaded = images) => {
    if (manager.busy || authentication.guest) return;
    if (loaded.length) props.onSelectionStart?.();
    stopMediaPreview();
    const unique = [...new Map(loaded.map(image => [image.id, image])).values()];
    setSelected(unique.slice(0, MAX_SELECTION));
    anchor.current = null;
    if (unique.length > MAX_SELECTION) manager.notify(`已选择前 ${MAX_SELECTION} 项，其余项目可分批操作`);
  }, [images, manager.busy, manager.notify, props.onSelectionStart]);
  const change = useCallback((next: ReadonlySet<string>) => {
    if (manager.busy) return;
    if (next.size) props.onSelectionStart?.();
    stopMediaPreview();
    setIds(next);
    anchor.current = null;
  }, [manager.busy, setIds, props.onSelectionStart]);
  useImperativeHandle(ref, () => ({
    clearSelection: exit,
    selectAll,
    resize(updateLayout) {
      if (layoutRef.current) layoutRef.current.resize(updateLayout);
      else updateLayout();
    },
    select(image) {
      if (manager.busy) return false;
      if (!ids.has(image.id) && ids.size >= MAX_SELECTION) {
        manager.notify(`每次最多选择 ${MAX_SELECTION} 项`, true);
        return false;
      }
      stopMediaPreview();
      props.onSelectionStart?.();
      setSelected(current => current.some(item => item.id === image.id) ? current.filter(item => item.id !== image.id) : [...current, image]);
      anchor.current = image.id;
      return true;
    },
  }), [ids, manager.busy, manager.notify, props.onSelectionStart, exit, selectAll]);
  useEffect(() => {
    if (!active || !props.preserveViewport) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || manager.busy || document.querySelector('dialog[open], .photo-card-menu:popover-open, [data-selection-dragging]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === "Escape") { event.preventDefault(); exit(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectAll(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active, props.preserveViewport, manager.busy, exit, selectAll]);
  const run = async (action: ManagementAction, options?: { destination?: string; favorite?: boolean }) => {
    try {
      const results = await manager.run(action, selected.map(image => image.id), options);
      const failed = results.filter(result => !result.ok);
      const success = results.length - failed.length;
      const label = action === "favorite" ? options?.favorite ? "收藏" : "取消收藏" : action === "move" ? "移动" : action === "copy" ? "复制" : "移入回收站";
      manager.notify(failed.length ? `${success} 项已${label}，${failed.length} 项失败：${failed.map(result => `${selected.find(image => image.id === result.id)?.name ?? "文件"}（${result.error}）`).slice(0, 3).join("；")}` : `已${label} ${success} 项`, failed.length > 0);
      setDialog(null);
      if (failed.length) setIds(new Set(failed.map(result => result.id)));
      else if (action !== "favorite") exit();
    } catch (error) { manager.notify(error instanceof Error ? error.message : "操作失败，请重试", true); }
  };
  const downloadSelected = () => void manager.download(selected.map(image => image.id)).catch(error => manager.notify(error instanceof Error ? error.message : "下载失败，请重试", true));
  const toggleFavorite = () => void run("favorite", { favorite: !allFavorite });
  const openDialog = (kind: "move" | "copy" | "trash") => setDialog(kind);
  return <>
    <JustifiedGallery {...props} ref={layoutRef} selection={authentication.guest ? undefined : { active, ids, favoriteIds: manager.favoriteIds, disabled: manager.busy || Boolean(dialog), toggle, change, selectAll: () => selectAll(), clear: exit,
      batch: { allFavorite, favoriteDisabled: !manager.ready, download: downloadSelected, favorite: toggleFavorite,
        move: () => openDialog("move"), copy: () => openDialog("copy"), trash: () => openDialog("trash") } }} />
    {active && props.toolbarTarget && createPortal(<div className="gallery-selection-bar" role="region" aria-label="所选项目操作" aria-busy={manager.busy}>
      <div className="selection-actions">
        <button type="button" title="下载" disabled={manager.busy || !selected.length} onClick={downloadSelected}><Download size={18} /><span>下载</span></button>
        <button type="button" disabled={manager.busy || !selected.length || !manager.ready} title={allFavorite ? "取消收藏" : "收藏"} aria-label={allFavorite ? "取消收藏所选项目" : "收藏所选项目"} onClick={toggleFavorite}><Heart size={18} fill={allFavorite ? "currentColor" : "none"} /><span>{allFavorite ? "取消收藏" : "收藏"}</span></button>
        <button type="button" title="移动" disabled={manager.busy || !selected.length} onClick={() => openDialog("move")}><FolderInput size={18} /><span>移动</span></button>
        <button type="button" className="selection-copy" title="复制" disabled={manager.busy || !selected.length} onClick={() => openDialog("copy")}><Copy size={18} /><span>复制</span></button>
        <button type="button" className="selection-trash" title="移入回收站" disabled={manager.busy || !selected.length} onClick={() => openDialog("trash")}><Trash2 size={18} /><span>删除</span></button>
      </div>
      {(selected.length === MAX_SELECTION || manager.busy || manager.error) && <div className="selection-messages">
        {selected.length === MAX_SELECTION && <span className="selection-progress">已达 {MAX_SELECTION} 项上限，其余项目可分批操作</span>}
        {manager.busy && <span className="selection-progress" role="status"><LoaderCircle className="spin" size={15} />正在处理，请稍候…</span>}
        {manager.error && <span className="selection-progress" role="alert">{manager.error}<button type="button" onClick={() => void manager.refresh()}>重试</button></span>}
      </div>}
    </div>, props.toolbarTarget)}
    {dialog && <SelectionDialog kind={dialog} images={selected} busy={manager.busy} onClose={() => setDialog(null)} onConfirm={destination => void run(dialog, dialog !== "trash" ? { destination } : undefined)} />}
  </>;
});

export function SelectionDialog({ kind, images = [], selectedAlbums = [], busy, error, onClose, onConfirm }: {
  kind: "move" | "copy" | "trash"; images?: GalleryImage[]; selectedAlbums?: Album[]; busy: boolean; error?: string; onClose: () => void; onConfirm: (destination?: string) => void;
}) {
  const dialog = useModalDialog(onClose, { dismissible: !busy });
  const [destination, setDestination] = useState<string | null>(null);
  const label = kind === "move" ? "移动" : kind === "copy" ? "复制" : "移入回收站";
  return <dialog {...dialog} className="selection-dialog" aria-labelledby="selection-dialog-title">
    <header><h2 id="selection-dialog-title">{label}{kind !== "trash" && "到目录"}</h2><button type="button" aria-label="关闭管理对话框" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <p className="selection-summary">{selectedAlbums.length ? `${selectedAlbums.length} 个目录 · 包含全部内容` : `${images.length} 项${images.some(image => image.motion) ? " · 含 Live Photo 配套视频" : ""}`}</p>
    {kind !== "trash" ? <>
      <DirectoryTree value={destination} onChange={setDestination} excluded={selectedAlbums.map(album => album.path)} disabled={busy} label="目标目录" />
      <div className="selection-destination" title={destination ?? undefined}><FolderInput size={15} /><span>{destination === null ? "选择目标目录" : destination || "图库根目录"}</span></div>
    </> : <p>可在回收站恢复。</p>}
    {error && <p className="directory-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="selection-confirm" data-destructive={kind === "trash"} disabled={busy || (kind !== "trash" && destination === null)} onClick={() => onConfirm(destination ?? undefined)}>{busy ? "处理中…" : label}</button></footer>
  </dialog>;
}
