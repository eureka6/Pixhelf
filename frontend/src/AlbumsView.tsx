import { useEffect, useState } from "preact/hooks";
import { authentication } from "./auth";
import { DirectoryActionDialog, type DirectoryAction } from "./DirectoryActionDialog";
import { BookImage, Check, ChevronLeft, Download, FolderInput, HardDrive, Heart, ImageIcon, Lock, Pencil, Share, Trash2 } from "./icons";
import type { GallerySelection } from "./JustifiedGallery";
import { useManagement } from "./management";
import { SelectableAlbumList } from "./SelectableAlbums";
import { ContextMenu, SelectionMenuItems, type MenuPoint } from "./SelectionMenu";
import { formatCount } from "./format";
import { galleryHref } from "./galleryLocation";
import type { Album } from "./types";
import type { JSX } from "preact";

function follow(event: JSX.TargetedMouseEvent<HTMLAnchorElement>, path: string, onOpen?: (path: string) => void) {
  if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); onOpen(path);
}

type AlbumNavigation = { onOpen: (path: string) => void; onStorage?: (path: string) => void; onCover?: (id: string) => void; selection?: GallerySelection };
type AlbumMenu = { album: Album; point: MenuPoint; opener: HTMLElement | null };

function AlbumCard({ album, onOpen, onStorage, selection }: AlbumNavigation & { album: Album }) {
  const manager = useManagement();
  const [failedCovers, setFailedCovers] = useState<Set<string>>(() => new Set());
  const covers = [...new Set([album.cover, ...(album.previews ?? [])])]
    .filter((id): id is string => id !== null && id.length > 0 && !failedCovers.has(id)).slice(0, 3);
  return <article className="album-card" data-album-path={album.path} data-selected={selection?.ids.has(album.path)}>
    <a className="album-card-open" href={galleryHref("albums", album.path)} draggable={false} aria-label={`打开相册 ${album.name}`}
      onClick={event => follow(event, album.path, onOpen)}>
      <div className="album-cover">
        <BookImage size={42} strokeWidth={1.2} />
        {covers.map((id, layer) => <div key={id} className="album-cover-sheet" data-layer={layer}>
          <img src={`/api/images/${encodeURIComponent(id)}/thumbnail`} alt="" loading="lazy" decoding="async" draggable={false}
            onError={() => setFailedCovers(current => new Set(current).add(id))} />
        </div>)}
      </div>
      <div className="album-caption">
        <h2 className="album-name" title={album.name}>{album.name}</h2>
        <div className="album-markers">
          {selection?.favoriteIds.has(album.path) && <span title="已收藏" aria-label="已收藏相册"><Heart size={13} fill="currentColor" /></span>}
          {!authentication.guest && manager.privateAlbums.has(album.path) && <span title="未分享" aria-label="未分享"><Lock size={13} /></span>}
        </div>
        <span className="album-size" title={`${formatCount(album.count)} 项`}>{formatCount(album.count)}</span>
      </div>
    </a>
    {!authentication.guest ? <a className="album-path photo-card-controls" href={galleryHref("local", album.path)} title={`在本地存储中打开：${album.path}`} onClick={event => { event.stopPropagation(); follow(event, album.path, onStorage); }}><FolderInput size={12} /><span>{album.path}</span></a>
      : <div className="album-path" title={album.path}><span>{album.path}</span></div>}
    {selection && <button type="button" className="photo-card-select album-select" role="checkbox" aria-checked={selection.ids.has(album.path)} aria-label={`选择相册 ${album.name}`} disabled={selection.disabled}
      onClick={event => { event.preventDefault(); event.stopPropagation(); selection.toggle(album.path, event.shiftKey); }}><span><Check size={14} strokeWidth={2.8} /></span></button>}
  </article>;
}

export function AlbumGrid({ albums, ...navigation }: AlbumNavigation & { albums: Album[] }) {
  const manager = useManagement();
  const [menu, setMenu] = useState<AlbumMenu | null>(null);
  const [dialog, setDialog] = useState<{ action: DirectoryAction; path: string } | null>(null);
  useEffect(() => { setMenu(current => current && !albums.some(album => album.path === current.album.path) ? null : current); }, [albums]);
  const close = (restore = false) => { if (restore) menu?.opener?.focus({ preventScroll: true }); setMenu(null); };
  const choose = (action: () => void) => { close(true); action(); };
  const action = (action: DirectoryAction) => { if (menu) choose(() => setDialog({ action, path: menu.album.path })); };
  const selection = navigation.selection;
  const batch = menu && selection?.ids.has(menu.album.path) && selection.ids.size > 1;
  const shared = menu ? !manager.privateAlbums.has(menu.album.path) : true;
  const favorite = menu ? manager.favoriteAlbums.has(menu.album.path) : false;
  const report = (reason: unknown) => manager.notify(reason instanceof Error ? reason.message : "操作失败", true);
  return <>
    <SelectableAlbumList className="albums-grid" selection={selection} onMenu={authentication.guest ? undefined : (path, request, card) => {
      const album = albums.find(album => album.path === path);
      if (!album || manager.busy) return;
      const rect = card.getBoundingClientRect();
      setMenu({ album, point: request.point ?? { x: rect.left + 16, y: rect.top + 16 }, opener: card.querySelector(".album-card-open") });
    }}>{albums.map(album => <AlbumCard key={album.path} album={album} {...navigation} />)}</SelectableAlbumList>
    {menu && <ContextMenu point={menu.point} onClose={close} label="相册管理">
      {!batch && <>
        <button type="button" role="menuitem" disabled={!menu.album.cover} onClick={() => choose(() => { if (menu.album.cover) navigation.onCover?.(menu.album.cover); })}><ImageIcon size={17} />查看封面</button>
        <button type="button" role="menuitemcheckbox" aria-checked={shared} disabled={manager.busy || !manager.ready || Boolean(manager.error)} onClick={() => choose(() => {
          void manager.mutate("/sharing", { path: menu.album.path, shared: !shared }).then(() => manager.notify(shared ? "已关闭访客分享" : "已开启访客分享")).catch(report);
        })}><Share size={17} /><span>访客分享</span>{shared && <Check className="album-sharing-check" size={15} />}</button>
        <button type="button" role="menuitem" onClick={() => choose(() => navigation.onStorage?.(menu.album.path))}><HardDrive size={17} />在本地存储中打开</button>
        <div className="photo-card-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => choose(() => void manager.download([menu.album.path], "albums").catch(report))}><Download size={17} />下载</button>
        <button type="button" role="menuitem" disabled={manager.busy || !manager.ready} onClick={() => choose(() => {
          void manager.run("favorite", [menu.album.path], { kind: "albums", favorite: !favorite }).then(results => { const failed = results.find(item => !item.ok); if (failed) report(new Error(failed.error ?? "操作失败")); }).catch(report);
        })}><Heart size={17} fill={favorite ? "currentColor" : "none"} />{favorite ? "取消收藏" : "收藏"}</button>
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => action("rename")}><Pencil size={17} />重命名</button>
        <button type="button" role="menuitem" disabled={manager.busy} onClick={() => action("move")}><FolderInput size={17} />移动</button>
        <button type="button" role="menuitem" className="directory-delete" disabled={manager.busy} onClick={() => action("trash")}><Trash2 size={17} />移入回收站</button>
      </>}
      {selection && <>{!batch && <div className="photo-card-menu-divider" role="separator" />}<SelectionMenuItems actions={{ ...selection, albums: true }} showBatch={Boolean(batch)} onChoose={choose} /></>}
    </ContextMenu>}
    {dialog && <DirectoryActionDialog {...dialog} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
  </>;
}

export function AlbumsView({ albums, search, ...navigation }: AlbumNavigation & { albums: Album[] | undefined; search: string }) {
  const query = search.trim().toLocaleLowerCase();
  const visible = albums?.filter(album => !query || album.path.toLocaleLowerCase().includes(query));
  return <section className="albums-page" aria-labelledby="albums-title">
    <header className="albums-heading"><h1 id="albums-title">相册</h1>{visible && <span>{formatCount(visible.length)} 个相册</span>}</header>
    {!visible ? <div className="albums-grid albums-skeleton" aria-label="正在读取相册" role="status">{Array.from({ length: 8 }, (_, i) => <div key={i} />)}</div>
      : visible.length ? <AlbumGrid albums={visible} {...navigation} />
      : <div className="empty-state"><BookImage size={32} strokeWidth={1.5} /><strong>{albums?.length ? "没有找到相册" : "暂无相册"}</strong></div>}
  </section>;
}

export function AlbumBackLink({ onOpen }: { onOpen: (path: string) => void }) {
  return <a className="album-back" href={galleryHref("albums")} onClick={event => follow(event, "", onOpen)}>
    <ChevronLeft size={17} /><span>返回相册</span>
  </a>;
}
