import { useState } from "preact/hooks";
import { BookImage, ChevronRight, Folder, ImageIcon } from "./icons";
import { formatCount } from "./format";
import { galleryHref } from "./galleryLocation";
import type { Album } from "./types";
import type { JSX } from "preact";

function followAlbum(event: JSX.TargetedMouseEvent<HTMLAnchorElement>, path: string, onOpen: (path: string) => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(path);
}

function AlbumCard({ album, onOpen }: { album: Album; onOpen: (path: string) => void }) {
  const [failedCover, setFailedCover] = useState<string | null>(null);
  return (
    <a className="album-card" href={galleryHref("albums", album.path)} onClick={event => followAlbum(event, album.path, onOpen)} data-album-path={album.path}>
      <div className="album-cover">
        <BookImage size={42} strokeWidth={1.2} />
        {album.cover && album.cover !== failedCover && (
          <img src={`/api/images/${encodeURIComponent(album.cover)}/thumbnail`} alt="" loading="lazy" decoding="async" onError={() => setFailedCover(album.cover)} />
        )}
        <span className="album-size"><ImageIcon size={12} />{formatCount(album.count)}</span>
      </div>
      <div className="album-card-details">
        <h2>{album.name}</h2>
        <p title={album.path}>{album.path}</p>
      </div>
    </a>
  );
}

export function AlbumsView({ albums, search, onOpen }: { albums: Album[] | undefined; search: string; onOpen: (path: string) => void }) {
  const query = search.trim().toLocaleLowerCase();
  const visible = albums?.filter(album => query
    ? album.path.toLocaleLowerCase().includes(query)
    : !album.path.includes("/"));
  return (
    <section className="albums-page" aria-labelledby="albums-title">
      <header className="albums-heading">
        <h1 id="albums-title">相册</h1>
        {visible && <span>{formatCount(visible.length)} 个相册</span>}
      </header>
      {!visible ? (
        <div className="albums-grid albums-skeleton" aria-label="正在读取相册" role="status">{Array.from({ length: 8 }, (_, i) => <div key={i} />)}</div>
      ) : visible.length ? (
        <div className="albums-grid">{visible.map(album => <AlbumCard key={album.path} album={album} onOpen={onOpen} />)}</div>
      ) : (
        <div className="empty-state">
          <BookImage size={32} strokeWidth={1.5} />
          <strong>{albums?.length ? "没有找到相册" : "暂无相册"}</strong>
          <span>{albums?.length ? "试试其他名称或路径" : "在图片目录中添加文件夹后，会自动显示在这里"}</span>
        </div>
      )}
    </section>
  );
}

export function AlbumChildren({ albums, path, onOpen }: { albums: Album[] | undefined; path: string; onOpen: (path: string) => void }) {
  const prefix = `${path}/`;
  const children = albums?.filter(album => album.path.startsWith(prefix)
    && !album.path.slice(prefix.length).includes("/"));
  if (!children?.length) return null;
  return (
    <section className="album-children" aria-label="子相册">
      <h2>子相册 <span>{formatCount(children.length)}</span></h2>
      <div className="album-folders">
        {children.map(album => (
          <a key={album.path} className="album-folder" href={galleryHref("albums", album.path)}
            onClick={event => followAlbum(event, album.path, onOpen)} data-album-path={album.path}>
            <span className="album-folder-icon"><Folder size={22} strokeWidth={1.6} /></span>
            <span className="album-folder-details">
              <strong title={album.name}>{album.name}</strong>
              <span>{formatCount(album.count)} 张照片</span>
            </span>
            <ChevronRight size={16} />
          </a>
        ))}
      </div>
    </section>
  );
}

export function AlbumHeading({ album, onOpen }: { album: Album; onOpen: (path: string) => void }) {
  const parts = album.path.split("/");
  return (
    <header className="album-heading">
      <nav className="album-breadcrumbs" aria-label="相册路径" title={album.path}>
        <a href={galleryHref("albums")} onClick={event => followAlbum(event, "", onOpen)}>相册</a>
        {parts.map((name, index) => {
          const path = parts.slice(0, index + 1).join("/");
          return (
            <div key={path}>
              <ChevronRight size={13} />
              {index === parts.length - 1
                ? <h1 aria-current="page">{name}</h1>
                : <a href={galleryHref("albums", path)} title={path} onClick={event => followAlbum(event, path, onOpen)}>{name}</a>}
            </div>
          );
        })}
      </nav>
      <span aria-label={`${album.count} 张图片`}>{formatCount(album.count)} 张</span>
    </header>
  );
}
