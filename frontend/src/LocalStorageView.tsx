import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getGalleryImage } from "./api";
import { copyText } from "./clipboard";
import { DirectoryActionDialog, type DirectoryAction } from "./DirectoryActionDialog";
import { DirectoryTree, getDirectories, type DirectoryPage } from "./DirectoryTree";
import { BookImage, ChevronLeft, ChevronRight, Copy, Download, FileIcon, Folder, FolderInput, FolderPlus, HardDrive, ImageIcon, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "./icons";
import { MANAGEMENT_CHANGED, useManagement } from "./management";
import { SelectionDialog } from "./SelectableGallery";
import { ContextMenu, type MenuPoint } from "./SelectionMenu";
import type { Album, GalleryImage } from "./types";
import { appendUniqueImages } from "./galleryImages";

type LocalTarget = { path: string; directory: boolean; imageId?: string | null };
type LocalMenu = LocalTarget & { point: MenuPoint; opener: HTMLElement | null };
export type LocalMediaPage = { images: GalleryImage[]; total: number; nextOffset: number | null; loadingMore: boolean; loadMore: () => Promise<GalleryImage[]> };

export function LocalStorageView({ path, search, albums, onOpen, onAlbum, onImage, onMediaChange }: {
  path: string; search: string; albums: Album[]; onOpen: (path: string) => void; onAlbum: (path: string) => void; onImage: (id: string) => void;
  onMediaChange: (page: LocalMediaPage | null) => void;
}) {
  const manager = useManagement();
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<DirectoryPage | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [dialog, setDialog] = useState<{ action: DirectoryAction; path: string } | null>(null);
  const [menu, setMenu] = useState<LocalMenu | null>(null);
  const [fileDialog, setFileDialog] = useState<{ kind: "copy" | "move" | "trash"; image: GalleryImage } | null>(null);
  const [fileError, setFileError] = useState("");
  const request = useRef<AbortController | null>(null);
  const pageRef = useRef(page);
  const moreJob = useRef<Promise<GalleryImage[]> | null>(null);
  const storePage = (page: DirectoryPage | null) => { pageRef.current = page; setPage(page); };
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener(MANAGEMENT_CHANGED, refresh);
    return () => window.removeEventListener(MANAGEMENT_CHANGED, refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    storePage(null); setError(""); setMore(false); setMenu(null); moreJob.current = null;
    const timer = setTimeout(() => {
      void getDirectories(path, { content: true, search }, controller.signal).then(value => { if (!controller.signal.aborted) storePage(value); })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    }, search ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [path, search, revision]);
  useEffect(() => { setFileDialog(null); setFileError(""); }, [path, search]);
  const loadMore = useCallback((): Promise<GalleryImage[]> => {
    if (pageRef.current?.nextOffset == null || !request.current || request.current.signal.aborted) return Promise.resolve([]);
    if (moreJob.current) return moreJob.current;
    const controller = request.current; setMore(true);
    const job = (async () => {
      try {
        // Non-media files can occupy an entire page. Continue until the viewer
        // gets a navigable item or reaches the actual end of this directory.
        do {
          const current = pageRef.current!;
          const next = await getDirectories(path, { content: true, search, offset: current.nextOffset! }, controller.signal);
          if (controller.signal.aborted) return [];
          const images = appendUniqueImages(current.images ?? [], next.images ?? []);
          const incoming = images.slice(current.images?.length ?? 0);
          storePage({ ...next, items: [...current.items, ...next.items], images });
          if (incoming.length || next.nextOffset === null) return incoming;
        } while (!controller.signal.aborted);
      } catch (reason) { if (!controller.signal.aborted) manager.notify(reason instanceof Error ? reason.message : "读取失败", true); }
      finally { if (request.current === controller) { moreJob.current = null; setMore(false); } }
      return [];
    })();
    moreJob.current = job;
    return job;
  }, [path, search, manager.notify]);
  const media = useMemo<LocalMediaPage>(() => ({ images: page?.images ?? [], total: page?.total ?? 0,
    nextOffset: page?.nextOffset ?? null, loadingMore: more, loadMore }), [page, more, loadMore]);
  useEffect(() => { onMediaChange(media); }, [media, onMediaChange]);
  useEffect(() => () => onMediaChange(null), [onMediaChange]);
  const closeMenu = (restore = false) => { if (restore) menu?.opener?.focus({ preventScroll: true }); setMenu(null); };
  const openAction = (action: DirectoryAction, target = path) => { closeMenu(true); setDialog({ action, path: target }); };
  const showMenu = (target: LocalTarget, point: MenuPoint, opener: HTMLElement | null) => {
    if (!manager.busy) setMenu({ ...target, point, opener });
  };
  const contextMenu = (event: JSX.TargetedMouseEvent<HTMLElement>, target: LocalTarget) => {
    event.preventDefault(); event.stopPropagation();
    showMenu(target, { x: event.clientX, y: event.clientY }, event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget);
  };
  const menuKey = (event: JSX.TargetedKeyboardEvent<HTMLElement>, target: LocalTarget) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(target, { x: rect.left + 16, y: rect.top + 20 }, event.target as HTMLElement);
  };
  const choose = (action: () => void) => { closeMenu(true); action(); };
  const report = (reason: unknown) => manager.notify(reason instanceof Error ? reason.message : "操作失败", true);
  const fileAction = (kind: "copy" | "move" | "trash") => {
    const id = menu?.imageId, current = request.current;
    closeMenu(true);
    if (!id || !current) return;
    const image = pageRef.current?.images?.find(image => image.id === id);
    void (image ? Promise.resolve(image) : getGalleryImage(id, current.signal)).then(image => {
      if (current === request.current && !current.signal.aborted) { setFileError(""); setFileDialog({ kind, image }); }
    }).catch(reason => { if (!current.signal.aborted) report(reason); });
  };
  const runFileAction = async (destination?: string) => {
    if (!fileDialog) return;
    setFileError("");
    try {
      const result = (await manager.run(fileDialog.kind, [fileDialog.image.id], { destination }))[0]!;
      if (!result.ok) throw new Error(result.error ?? "操作失败");
      setFileDialog(null);
    } catch (reason) { setFileError(reason instanceof Error ? reason.message : "操作失败"); }
  };
  const parent = path.split("/").slice(0, -1).join("/");
  const parts = path.split("/").filter(Boolean);
  const currentAlbum = albums.find(album => album.path === path);
  return <section className="local-storage" aria-labelledby="local-storage-title">
    <header className="management-page-heading"><h1 id="local-storage-title"><HardDrive size={23} />本地存储</h1>
      <div className="local-heading-actions"><button type="button" disabled={manager.busy} onClick={() => openAction("create")}><FolderPlus size={18} /><span>新建目录</span></button><button type="button" aria-label="刷新目录" disabled={manager.busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} /></button></div>
    </header>
    <div className="local-storage-layout" data-tree-open={treeOpen}>
      <button className="local-tree-toggle" type="button" aria-expanded={treeOpen} onClick={() => setTreeOpen(value => !value)}><Folder size={17} />目录<ChevronRight size={15} /></button>
      <aside className="local-directory-tree" aria-label="本地目录树"><DirectoryTree key={revision} value={path} onChange={next => { onOpen(next); setTreeOpen(false); }} disabled={manager.busy} pageScroll onMenu={(path, point, opener) => showMenu({ path, directory: true }, point, opener)} /></aside>
      <div className="local-directory-content" onContextMenu={event => contextMenu(event, { path, directory: true })} onKeyDown={event => menuKey(event, { path, directory: true })}>
        <div className="local-pathbar">
          <button type="button" aria-label="上级目录" title="上级目录" disabled={!path || manager.busy} onClick={() => onOpen(parent)}><ChevronLeft size={18} /></button>
          <nav className="local-breadcrumbs" aria-label="当前目录" title={path || "图库根目录"}>
            <button type="button" disabled={manager.busy} onClick={() => onOpen("")}>根目录</button>
            {parts.length > 2 && <><ChevronRight size={12} /><button type="button" title={parts.slice(0, -2).join("/")} onClick={() => onOpen(parts.slice(0, -2).join("/"))}>…</button></>}
            {parts.slice(-2).map((name, offset) => {
              const index = Math.max(0, parts.length - 2) + offset, target = parts.slice(0, index + 1).join("/");
              return <span key={target}><ChevronRight size={12} /><button type="button" title={target} aria-current={index === parts.length - 1 ? "location" : undefined} disabled={manager.busy} onClick={() => onOpen(target)}>{name}</button></span>;
            })}
          </nav>
          {currentAlbum && <button type="button" title="查看相册" aria-label="查看当前相册" onClick={() => onAlbum(path)}><BookImage size={18} /></button>}
          <button type="button" aria-label="管理当前目录" disabled={manager.busy} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showMenu({ path, directory: true }, { x: rect.right, y: rect.bottom }, event.currentTarget); }}><MoreHorizontal size={19} /></button>
        </div>
        <div className="local-directory-list" tabIndex={0} aria-label="目录内容" aria-busy={!page && !error}>
          {error ? <div className="empty-state"><strong role="alert">{error}</strong><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>
            : !page ? <div className="directory-tree-status" role="status"><LoaderCircle className="spin" size={22} /></div>
            : page.items.length ? <>
              {page.items.map(item => <div className="local-entry" key={item.path} data-path={item.path}
                onContextMenu={event => contextMenu(event, item)} onKeyDown={event => menuKey(event, item)}>
                <button type="button" className="local-entry-open" disabled={manager.busy || (!item.directory && !item.imageId)} title={item.name}
                  onClick={() => item.directory ? onOpen(item.path) : item.imageId && onImage(item.imageId)}>
                  {item.directory ? <Folder size={21} /> : item.imageId ? <img alt="" src={`/api/images/${encodeURIComponent(item.imageId)}/thumbnail`} loading="lazy" /> : <FileIcon size={20} />}
                  <span>{item.name}</span><small>{item.directory ? "目录" : sizeLabel(item.size)}</small>
                </button>
                <button type="button" className="local-entry-more" aria-label={`管理${item.directory ? "目录" : "文件"} ${item.name}`} disabled={manager.busy} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showMenu(item, { x: rect.right, y: rect.bottom }, event.currentTarget); }}><MoreHorizontal size={18} /></button>
              </div>)}
              {page.nextOffset !== null && <button type="button" className="local-load-more" disabled={more} onClick={() => void loadMore()}>{more ? "读取中…" : "加载更多"}</button>}
            </> : <div className="empty-state"><Folder size={28} /><strong>{search ? "没有匹配的内容" : "空目录"}</strong></div>}
        </div>
        <footer className="local-directory-footer"><span title={path || "图库根目录"}>{path || "图库根目录"}</span>{page && <span>{page.total} 项</span>}</footer>
      </div>
    </div>
    {menu && <ContextMenu point={menu.point} onClose={closeMenu} label={menu.directory ? "目录管理" : "文件管理"}>
      {menu.directory ? <>
        {menu.path !== path && <button type="button" role="menuitem" onClick={() => choose(() => onOpen(menu.path))}><Folder size={17} />打开目录</button>}
        <button type="button" role="menuitem" onClick={() => openAction("create", menu.path)} disabled={manager.busy}><FolderPlus size={17} />新建目录</button>
        {menu.path && <>
          <button type="button" role="menuitem" onClick={() => openAction("rename", menu.path)} disabled={manager.busy}><Pencil size={17} />重命名</button>
          <button type="button" role="menuitem" onClick={() => openAction("move", menu.path)} disabled={manager.busy}><FolderInput size={17} />移动</button>
          <button type="button" role="menuitem" className="directory-delete" onClick={() => openAction("trash", menu.path)} disabled={manager.busy}><Trash2 size={17} />移入回收站</button>
        </>}
      </> : menu.imageId && <>
        <button type="button" role="menuitem" onClick={() => choose(() => onImage(menu.imageId!))}><ImageIcon size={17} />打开</button>
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => choose(() => void manager.download([menu.imageId!]).catch(report))}><Download size={17} />下载</button>
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => fileAction("copy")}><Copy size={17} />复制到</button>
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => fileAction("move")}><FolderInput size={17} />移动到</button>
        <button type="button" role="menuitem" className="directory-delete" disabled={manager.busy} onClick={() => fileAction("trash")}><Trash2 size={17} />移入回收站</button>
      </>}
      <div className="photo-card-menu-divider" role="separator" />
      <button type="button" role="menuitem" onClick={() => choose(() => void copyText(menu.path || "/").then(() => manager.notify("已复制路径")).catch(report))}><Copy size={17} />复制路径</button>
      <button type="button" role="menuitem" disabled={manager.busy} onClick={() => choose(() => setRevision(value => value + 1))}><RefreshCw size={17} />刷新</button>
    </ContextMenu>}
    {fileDialog && <SelectionDialog kind={fileDialog.kind} images={[fileDialog.image]} busy={manager.busy} error={fileError} onClose={() => setFileDialog(null)} onConfirm={destination => void runFileAction(destination)} />}
    {dialog && <DirectoryActionDialog {...dialog} onClose={() => setDialog(null)} onDone={next => {
      const wasCurrent = dialog.path === path || path.startsWith(`${dialog.path}/`);
      if (dialog.action === "create") onOpen(next);
      else if (wasCurrent) onOpen(dialog.action === "trash" ? next : `${next}${path.slice(dialog.path.length)}`);
      setDialog(null);
    }} />}
  </section>;
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
