import { forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { getDuplicates } from "./api";
import { authentication } from "./auth";
import { useCardInteraction } from "./cardInteraction";
import { formatCount, formatFileSize } from "./format";
import { ImageCardActions } from "./ImageCardActions";
import { Check, Download, FolderInput, Heart, LoaderCircle, RefreshCw, ScanSearch, Trash2 } from "./icons";
import { MANAGEMENT_CHANGED, MAX_SELECTION, useManagement, type ManagementAction } from "./management";
import { SelectionDialog, type SelectableGalleryHandle, type SelectionToolbarProps } from "./SelectableGallery";
import { SelectionBar } from "./SelectionBar";
import type { DuplicateGroup, DuplicatePage, DuplicateSelectionGroup, GalleryImage, ImageCardAction } from "./types";

function recommended(group: DuplicateSelectionGroup, favorites: ReadonlySet<string>) {
  return [...group.images].sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id))
    || b.size - a.size || a.modifiedMs - b.modifiedMs)[0]!.id;
}

export const DuplicateImages = forwardRef<SelectableGalleryHandle, {
  search: string; revision?: string; viewing: boolean; onImagesChange: (images: GalleryImage[]) => void;
  onOpen: (id: string, card: HTMLElement, pointerY?: number, action?: ImageCardAction) => void;
} & SelectionToolbarProps>(function DuplicateImages({ search, revision, viewing, onImagesChange, onOpen, toolbarTarget, onSelectionChange }, ref) {
  const manager = useManagement();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [plan, setPlan] = useState<DuplicateSelectionGroup[]>([]);
  const [page, setPage] = useState<DuplicatePage | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [keepers, setKeepers] = useState<Record<string, string>>({});
  const retained = useRef(keepers); retained.current = keepers;
  const [loading, setLoading] = useState(true);
  const [planReady, setPlanReady] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"move" | "trash" | null>(null);
  const [reload, setReload] = useState(0);
  const automatic = useRef(true);
  const refreshRequested = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const pendingMore = useRef(false);
  const deferredScan = useRef(false);
  const favorites = useRef(manager.favoriteIds); favorites.current = manager.favoriteIds;
  const root = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  useCardInteraction(root, !viewing);
  const images = useMemo(() => groups.flatMap(group => group.images), [groups]);
  const selectedImages = useMemo(() => images.filter(image => selected.has(image.id)), [images, selected]);
  const allImages = useMemo(() => plan.flatMap(group => group.images), [plan]);
  const selectedBytes = useMemo(() => allImages.reduce((bytes, image) => bytes + (selected.has(image.id) ? image.size : 0), 0), [allImages, selected]);
  const clear = useCallback(() => { automatic.current = false; setSelected(new Set()); }, []);
  useEffect(() => {
    if (manager.busy) { deferredScan.current = true; return; }
    if (!authentication.guest && !manager.ready && !manager.error) return;
    deferredScan.current = false;
    const request = new AbortController(); controller.current = request;
    let timer = 0, refresh = refreshRequested.current;
    refreshRequested.current = false; pendingMore.current = false;
    setLoading(true); setPlanReady(false); setLoadingMore(false); setError(""); setGroups([]); setPage(null);
    const read = async () => {
      try {
        const response = await getDuplicates(0, search, request.signal, Boolean(refresh));
        refresh = false;
        if (request.signal.aborted) return;
        setPage(response); setGroups(response.groups);
        if (response.scanning) { timer = window.setTimeout(() => void read(), 900); return; }
        if (!response.plan) throw new Error("无法读取完整分组，请重新检查");
        const nextPlan = response.plan;
        const nextKeepers = Object.fromEntries(nextPlan.map(group => [group.id,
          group.images.some(image => image.id === retained.current[group.id]) ? retained.current[group.id]! : recommended(group, favorites.current)]));
        setPlan(nextPlan); setKeepers(nextKeepers);
        const available = new Set(nextPlan.flatMap(group => group.images.map(image => image.id)));
        setSelected(current => {
          const next = automatic.current && !authentication.guest && manager.ready ? available : new Set([...current].filter(id => available.has(id)));
          for (const keeper of Object.values(nextKeepers)) next.delete(keeper);
          return next;
        });
        setLoading(false); setPlanReady(true);
      } catch (reason) {
        if (!request.signal.aborted) { setError(reason instanceof Error ? reason.message : "无法检查重复图片"); setLoading(false); }
      }
    };
    void read();
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [search, revision, reload, manager.ready, manager.error]);
  useEffect(() => {
    if (!manager.busy && deferredScan.current) { deferredScan.current = false; setReload(value => value + 1); }
  }, [manager.busy]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "favorite") return;
      automatic.current = false; setReload(value => value + 1);
    };
    window.addEventListener(MANAGEMENT_CHANGED, changed);
    return () => window.removeEventListener(MANAGEMENT_CHANGED, changed);
  }, []);
  useLayoutEffect(() => { onImagesChange(images); }, [images, onImagesChange]);
  useLayoutEffect(() => { onSelectionChange(selected); }, [selected, onSelectionChange]);
  useEffect(() => () => { onImagesChange([]); onSelectionChange(new Set()); }, [onImagesChange, onSelectionChange]);
  const toggle = (id: string) => {
    if (manager.busy || !planReady || Object.values(keepers).includes(id) || !allImages.some(image => image.id === id)) return false;
    automatic.current = false;
    setSelected(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
    return true;
  };
  const selectCopies = () => {
    if (manager.busy || !planReady) return;
    automatic.current = true;
    setSelected(new Set(plan.flatMap(group => group.images.filter(image => image.id !== keepers[group.id]).map(image => image.id))));
  };
  const recheck = () => { refreshRequested.current = true; automatic.current = true; setReload(value => value + 1); };
  useImperativeHandle(ref, () => ({ clearSelection: clear, selectAll: selectCopies,
    select: image => toggle(image.id), resize: update => update(),
  }), [clear, plan, keepers, manager.busy, planReady]);
  const keep = (group: DuplicateGroup, id: string) => {
    if (manager.busy || !planReady) return;
    setKeepers(current => ({ ...current, [group.id]: id }));
    setSelected(current => {
      const next = new Set(current); next.delete(id);
      for (const image of group.images) if (image.id !== id) next.add(image.id);
      return next;
    });
  };
  useEffect(() => {
    if (viewing) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || manager.busy || document.querySelector('dialog[open], .photo-card-menu:popover-open')
        || event.target instanceof Element && event.target.closest('input, textarea, select')) return;
      if (event.key === "Escape") { event.preventDefault(); clear(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [viewing, manager.busy, clear]);
  const loadMore = async () => {
    const request = controller.current;
    if (pendingMore.current || loading || manager.busy || page?.nextOffset == null || !request || request.signal.aborted) return;
    pendingMore.current = true; setLoadingMore(true); setError("");
    try {
      const response = await getDuplicates(page.nextOffset, search, request.signal);
      if (request.signal.aborted) return;
      if (response.scanning || response.revision !== page.revision) { setReload(value => value + 1); return; }
      setGroups(current => [...current, ...response.groups.filter(group => !current.some(previous => previous.id === group.id))]);
      setPage(response);
    } catch (reason) { if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "无法加载更多分组"); }
    finally { if (!request.signal.aborted) { pendingMore.current = false; setLoadingMore(false); } }
  };
  const more = useRef(loadMore); more.current = loadMore;
  useEffect(() => {
    if (loading || loadingMore || error || viewing || manager.busy || page?.nextOffset == null || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void more.current(); }, { rootMargin: "600px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, loadingMore, page, error, viewing, manager.busy]);
  const run = async (action: ManagementAction, destination?: string) => {
    if (!planReady || manager.busy || !selected.size) return;
    const ids = [...selected];
    const duplicateKeepers = action === "trash" ? Object.fromEntries(plan.flatMap(group => group.images.filter(image => selected.has(image.id)).map(image => [image.id, keepers[group.id]!]))) : undefined;
    automatic.current = false;
    try {
      const results = await manager.run(action, ids, { ...(action === "move" ? { destination } : action === "favorite" ? { favorite: true } : {}), duplicateKeepers });
      const failed = results.filter(result => !result.ok);
      setDialog(null); setSelected(new Set(failed.map(result => result.id)));
      manager.notify(failed.length ? `${results.length - failed.length} 项处理成功，${failed.length} 项失败：${failed[0]?.error}`
        : action === "trash" ? `已将 ${results.length} 张重复图片移入回收站` : action === "move" ? `已移动 ${results.length} 张图片` : `已收藏 ${results.length} 张图片`, failed.length > 0);
    } catch (reason) { manager.notify(reason instanceof Error ? reason.message : "操作失败，请重试", true); }
  };
  const download = () => void manager.download([...selected]).catch(reason => manager.notify(reason instanceof Error ? reason.message : "下载失败", true));
  const busy = manager.busy || loading;
  const selectionBusy = manager.busy || !planReady;
  return <div className="duplicate-page" ref={root}>
    <header className="duplicate-heading"><div><h1><ScanSearch size={23} />相似图片</h1><p>重复图片 · {loading ? "后台检查中" : `${formatCount(page?.total ?? 0)} 组`}</p></div>
      <button className="duplicate-action" type="button" disabled={busy} onClick={recheck}><RefreshCw size={16} />重新检查</button>
    </header>
    {!authentication.guest && <div className="duplicate-tools">
      <p>每组保留一张，自动选择覆盖全部 {formatCount(plan.length)} 组。<span>优先保留收藏，再按文件大小和修改时间推荐。清理的副本可在回收站恢复。</span></p>
      <div><button className="duplicate-action duplicate-clean" type="button" disabled={selectionBusy || !selected.size} onClick={() => void run("trash")}><Trash2 size={16} />一键清理副本</button>
        <button className="duplicate-action" type="button" disabled={selectionBusy || !plan.length} onClick={selectCopies}>自动选择全部副本</button>
        <button className="duplicate-action" type="button" disabled={manager.busy || !selected.size} onClick={clear}>取消选择</button></div>
    </div>}
    {loading && <div className="duplicate-progress" role="status"><LoaderCircle size={22} className="spin" /><span>正在检查重复图片 · {formatCount(page?.scanned ?? 0)} / {formatCount(page?.imageTotal ?? 0)}</span><progress max={Math.max(1, page?.imageTotal ?? 1)} value={page?.scanned ?? 0} /></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => page?.nextOffset != null && !page.scanning ? void loadMore() : recheck()}>重试</button></div>}
    {!loading && !error && !groups.length && <div className="empty-state"><ScanSearch size={30} /><strong>{search ? "没有匹配的重复图片" : "没有发现重复图片"}</strong><span>相同文件或完整像素一致的图片会显示在同一组。</span></div>}
    {groups.map((group, index) => {
      const retainedId = keepers[group.id] ?? recommended(group, manager.favoriteIds);
      return <section className="duplicate-group" key={group.id} aria-labelledby={`duplicate-group-${group.id}`}>
      <header><h2 id={`duplicate-group-${group.id}`}>第 {index + 1} 组 <span>{group.images.length} 张</span></h2>
        <span>{loading ? "正在核对" : `已选 ${group.images.filter(image => selected.has(image.id)).length} 张`}</span></header>
      <div className="duplicate-grid">{group.images.map(image => {
        const retained = retainedId === image.id;
        return <article className="duplicate-item" key={image.id} data-retained={retained}>
          <div className="image-card duplicate-card" data-image-id={image.id} data-image-name={image.name} data-selected={selected.has(image.id)}>
            <img src={`/api/images/${encodeURIComponent(image.id)}/thumbnail`} alt="" loading="lazy" />
            <button type="button" className="photo-card-open" aria-label={`查看图片 ${image.name}`} aria-haspopup="dialog" onClick={event => onOpen(image.id, event.currentTarget.parentElement!)} />
            {!authentication.guest && !retained && <button type="button" className="photo-card-select" role="checkbox" aria-checked={selected.has(image.id)} aria-label={`选择 ${image.name}`} disabled={selectionBusy} onClick={() => toggle(image.id)}><span><Check size={15} /></span></button>}
            <ImageCardActions image={image} onAction={action => { const card = root.current?.querySelector<HTMLElement>(`[data-image-id="${image.id}"]`); if (card) onOpen(image.id, card, undefined, action); }}
              onSelect={authentication.guest || retained ? undefined : () => toggle(image.id)} selected={selected.has(image.id)} selectionDisabled={selectionBusy} />
          </div>
          <div className="duplicate-copy"><strong title={image.name}>{image.name}</strong><span title={image.path}>{image.path}</span><small>{image.width} × {image.height} · {formatFileSize(image.size)}{manager.favoriteIds.has(image.id) ? " · 已收藏" : ""}</small></div>
          {!authentication.guest && <button type="button" className="duplicate-keep" aria-pressed={retained} disabled={selectionBusy} onClick={() => keep(group, image.id)}>{retained ? <><Check size={14} />保留这张</> : "改为保留这张"}</button>}
        </article>;
      })}</div>
    </section>; })}
    {Boolean(page?.skipped) && <p className="duplicate-note" role="status">有 {page!.skipped} 个文件暂时无法读取，已跳过。可在文件可用后重新检查。</p>}
    <div className="load-sentinel" ref={sentinel}>{!loading && page?.nextOffset != null ? <button className="duplicate-action" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多分组"}</button>
      : !loading && groups.length > 0 && <span className="duplicate-note">已显示全部 {groups.length} 组</span>}</div>
    {!authentication.guest && <SelectionBar target={toolbarTarget} count={selected.size} unit="张" bytes={selectedBytes} label="重复图片操作" busy={selectionBusy} progress={manager.progress} onClear={clear}>
      <button type="button" disabled={selectionBusy || selected.size > MAX_SELECTION} title={selected.size > MAX_SELECTION ? `下载每次最多 ${MAX_SELECTION} 张` : "下载"} onClick={download}><Download size={18} /><span>下载</span></button>
      <button type="button" disabled={selectionBusy || !manager.ready} onClick={() => void run("favorite")}><Heart size={18} /><span>收藏</span></button>
      <button type="button" disabled={selectionBusy} onClick={() => setDialog("move")}><FolderInput size={18} /><span>移动</span></button>
      <button type="button" className="selection-trash" disabled={selectionBusy} onClick={() => setDialog("trash")}><Trash2 size={18} /><span>删除</span></button>
    </SelectionBar>}
    {dialog && <SelectionDialog kind={dialog} images={selectedImages} selectionCount={selected.size} busy={manager.busy} onClose={() => setDialog(null)} onConfirm={destination => void run(dialog, destination)} />}
  </div>;
});
