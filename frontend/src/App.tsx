import {
  ArrowDownAZ,
  Check,
  Folder,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getGallery, getImages, getStatus } from "./api";
import ImageViewer from "./ImageViewer";
import type {
  GalleryImage,
  GallerySummary,
  SortMode,
  ThumbnailStatus,
} from "./types";

const PAGE_SIZE = 60;
const MOBILE_PAGE_SIZE = 36;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function App() {
  const [summary, setSummary] = useState<GallerySummary | null>(null);
  const [status, setStatus] = useState<ThumbnailStatus | null>(null);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [album, setAlbum] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("name-asc");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const pageSize = compactLayout ? MOBILE_PAGE_SIZE : PAGE_SIZE;
  const debouncedSearch = useDebounced(search.trim(), 250);
  const activeQuery = `${album}\u0000${debouncedSearch}\u0000${sort}`;
  const activeQueryRef = useRef(activeQuery);
  activeQueryRef.current = activeQuery;

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [album, debouncedSearch, sort]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!compactLayout && mobileNavOpen) setMobileNavOpen(false);
  }, [compactLayout, mobileNavOpen]);

  useEffect(() => {
    const controller = new AbortController();
    getGallery(controller.signal)
      .then(setSummary)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "无法读取图库");
        }
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getStatus();
        if (cancelled) return;
        setStatus(next);
        timer = window.setTimeout(poll, next.backgroundComplete ? 10000 : 1500);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (status && summary && status.total !== summary.total) {
      void getGallery().then(setSummary).catch(() => undefined);
    }
  }, [status?.total, summary?.total]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setImages([]);
    setNextOffset(null);
    getImages(
      {
        album,
        search: debouncedSearch,
        sort,
        offset: 0,
        limit: pageSize,
      },
      controller.signal,
    )
      .then((page) => {
        setImages(page.items);
        setTotal(page.total);
        setNextOffset(page.nextOffset);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "无法读取图片");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [album, debouncedSearch, pageSize, reloadToken, sort]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMore) return;
    const queryAtStart = activeQueryRef.current;
    setLoadingMore(true);
    try {
      const page = await getImages({
        album,
        search: debouncedSearch,
        sort,
        offset: nextOffset,
        limit: pageSize,
      });
      if (queryAtStart !== activeQueryRef.current) return;
      setImages((current) => [...current, ...page.items]);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法继续加载图片");
    } finally {
      setLoadingMore(false);
    }
  }, [album, debouncedSearch, loadingMore, nextOffset, pageSize, sort]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextOffset === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void loadMore();
      },
      { rootMargin: compactLayout ? "280px 0px" : "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [compactLayout, loadMore, nextOffset]);

  const activeAlbum = summary?.albums.find((item) => item.path === album);
  const title = activeAlbum?.name ?? "全部图片";
  const selectedIndex = selectedId
    ? images.findIndex((image) => image.id === selectedId)
    : -1;

  const openViewer = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const closeViewer = useCallback(() => {
    setSelectedId(null);
  }, []);

  const chooseAlbum = (path: string) => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setAlbum(path);
    setMobileNavOpen(false);
  };

  return (
    <div className="app-shell">
      <Header
        status={status}
        onOpenNavigation={() => setMobileNavOpen(true)}
        navigationOpen={mobileNavOpen}
      />
      <Sidebar
        summary={summary}
        activeAlbum={album}
        onChoose={chooseAlbum}
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        status={status}
      />

      <main className="content">
        <section className="content-heading">
          <div className="title-block">
            <p className="path-label">{album || "图库"}</p>
            <div className="title-line">
              <h1>{title}</h1>
              <span>{formatCount(total)} 张</span>
            </div>
          </div>
          <div className="toolbar">
            <label className="search-field">
              <Search aria-hidden="true" size={17} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索文件名"
                aria-label="搜索文件名"
                enterKeyHint="search"
                autoComplete="off"
              />
              {search && (
                <button
                  type="button"
                  className="clear-search"
                  onClick={() => setSearch("")}
                  aria-label="清空搜索"
                  title="清空搜索"
                >
                  <X size={15} />
                </button>
              )}
            </label>
            <label className="sort-control">
              <ArrowDownAZ aria-hidden="true" size={17} />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                aria-label="图片排序"
              >
                <option value="name-asc">名称顺序</option>
                <option value="name-desc">名称倒序</option>
                <option value="newest">最近修改</option>
              </select>
            </label>
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              aria-label="重新加载"
              title="重新加载"
            >
              <RefreshCw size={17} />
            </button>
          </div>
        )}

        {loading ? (
          <GallerySkeleton />
        ) : images.length ? (
          <MasonryGallery images={images} onOpen={openViewer} />
        ) : (
          <div className="empty-state">
            <ImageIcon size={30} strokeWidth={1.6} />
            <strong>没有找到图片</strong>
            <span>请调整相册或搜索条件</span>
          </div>
        )}

        <div ref={sentinelRef} className="load-sentinel" aria-live="polite">
          {loadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
          {!loading && nextOffset === null && images.length > 0 && (
            <span>已显示全部 {formatCount(total)} 张图片</span>
          )}
        </div>
      </main>

      {selectedIndex >= 0 && (
        <ImageViewer
          images={images}
          index={selectedIndex}
          total={total}
          onIndexChange={(index) => setSelectedId(images[index]?.id ?? null)}
          onNeedMore={() => void loadMore()}
          onClose={closeViewer}
        />
      )}
    </div>
  );
}

function Header({
  status,
  onOpenNavigation,
  navigationOpen,
}: {
  status: ThumbnailStatus | null;
  onOpenNavigation: () => void;
  navigationOpen: boolean;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button mobile-menu"
        onClick={onOpenNavigation}
        aria-label="打开相册导航"
        aria-expanded={navigationOpen}
        aria-controls="mobile-album-navigation"
        title="打开相册导航"
      >
        <Menu size={20} />
      </button>
      <div className="brand">
        <span className="brand-mark"><Images size={21} /></span>
        <span>Pixhelf</span>
      </div>
      <StatusCompact status={status} />
    </header>
  );
}

function StatusCompact({ status }: { status: ThumbnailStatus | null }) {
  if (!status) return <span className="status-compact muted">连接中</span>;
  const complete = status.backgroundComplete;
  return (
    <div
      className={`status-compact ${complete ? "complete" : ""}`}
      title={complete ? "缩略图处理完成" : "正在后台处理缩略图"}
    >
      {complete ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />}
      <span>{formatCount(status.ready)} / {formatCount(status.total)}</span>
    </div>
  );
}

function Sidebar({
  summary,
  activeAlbum,
  onChoose,
  mobileOpen,
  onClose,
  status,
}: {
  summary: GallerySummary | null;
  activeAlbum: string;
  onChoose: (path: string) => void;
  mobileOpen: boolean;
  onClose: () => void;
  status: ThumbnailStatus | null;
}) {
  const navigation = (
    <>
      <div className="sidebar-heading">
        <span>相册</span>
        <button
          type="button"
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="关闭相册导航"
          title="关闭相册导航"
        >
          <PanelLeftClose size={19} />
        </button>
      </div>
      <nav className="album-nav" aria-label="相册">
        <AlbumButton
          label="全部图片"
          count={summary?.total ?? 0}
          active={!activeAlbum}
          onClick={() => onChoose("")}
          all
        />
        {summary?.albums.map((item) => (
          <AlbumButton
            key={item.path}
            label={item.name}
            detail={item.path.includes("/") ? item.path : undefined}
            count={item.count}
            active={activeAlbum === item.path}
            onClick={() => onChoose(item.path)}
          />
        ))}
      </nav>
      <SidebarProgress status={status} />
    </>
  );

  return (
    <>
      <aside className="sidebar desktop-sidebar">{navigation}</aside>
      {mobileOpen && (
        <div className="mobile-nav-layer" role="presentation">
          <button
            className="mobile-nav-scrim"
            type="button"
            onClick={onClose}
            aria-label="关闭相册导航"
          />
          <aside
            id="mobile-album-navigation"
            className="sidebar mobile-sidebar"
            role="dialog"
            aria-modal="true"
            aria-label="相册导航"
          >
            {navigation}
          </aside>
        </div>
      )}
    </>
  );
}

function AlbumButton({
  label,
  detail,
  count,
  active,
  onClick,
  all = false,
}: {
  label: string;
  detail?: string;
  count: number;
  active: boolean;
  onClick: () => void;
  all?: boolean;
}) {
  return (
    <button
      type="button"
      className={`album-link ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      {all ? <Images size={17} /> : <Folder size={17} />}
      <span className="album-copy">
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <span className="album-count">{formatCount(count)}</span>
    </button>
  );
}

function SidebarProgress({ status }: { status: ThumbnailStatus | null }) {
  if (!status) return null;
  const percent = status.total ? Math.round((status.ready / status.total) * 100) : 100;
  return (
    <div className="sidebar-progress">
      <div>
        <span>{status.backgroundComplete ? "缩略图已就绪" : "后台处理中"}</span>
        <strong>{percent}%</strong>
      </div>
      <progress max={status.total || 1} value={status.ready} />
      {status.failed > 0 && <small>{status.failed} 个任务失败</small>}
    </div>
  );
}

function useColumnCount(ref: RefObject<HTMLDivElement | null>): number {
  const [columns, setColumns] = useState(5);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => {
      const minimumCardWidth = 218;
      const gap = 6;
      const next = Math.floor((width + gap) / (minimumCardWidth + gap));
      setColumns(Math.min(6, Math.max(2, next)));
    };
    update(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

function MasonryGallery({
  images,
  onOpen,
}: {
  images: GalleryImage[];
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const columnCount = useColumnCount(ref);
  const columns = useMemo(() => {
    const result: { image: GalleryImage; index: number }[][] = Array.from(
      { length: columnCount },
      () => [],
    );
    const heights = Array(columnCount).fill(0) as number[];
    images.forEach((image, index) => {
      const target = heights.indexOf(Math.min(...heights));
      result[target].push({ image, index });
      heights[target] += image.height / Math.max(image.width, 1) + 0.05;
    });
    return result;
  }, [columnCount, images]);

  return (
    <div
      ref={ref}
      className="masonry"
      style={{ "--columns": columnCount } as CSSProperties}
    >
      {columns.map((column, columnIndex) => (
        <div className="masonry-column" key={columnIndex}>
          {column.map(({ image, index }) => (
            <ImageCard key={image.id} image={image} index={index} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ImageCard({
  image,
  index,
  onOpen,
}: {
  image: GalleryImage;
  index: number;
  onOpen: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="image-card"
      onClick={() => onOpen(image.id)}
      aria-label={`查看 ${image.name}`}
      title={image.name}
      data-image-id={image.id}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      {!failed ? (
        <img
          src={image.thumbnailUrl}
          alt={image.name}
          loading={index < 10 ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={index < 5 ? "high" : "auto"}
          className={loaded ? "loaded" : ""}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="image-fallback"><ImageIcon size={24} /></span>
      )}
      <span className="image-name">{image.name}</span>
    </button>
  );
}

function GallerySkeleton() {
  const ratios = [1.4, 0.72, 1, 1.55, 0.8, 1.2, 0.67, 1.35, 0.9, 1.6, 0.76, 1.1];
  return (
    <div className="skeleton-grid" aria-label="正在加载图库">
      {ratios.map((ratio, index) => (
        <span key={index} style={{ aspectRatio: String(ratio) }} />
      ))}
    </div>
  );
}

export default App;
