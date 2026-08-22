import {
  Check,
  Dices,
  Folder,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ToolbarPopover } from "./ToolbarPopover";
import { getGallery, getImages, getStatus } from "./api";
import type {
  GalleryImage,
  GallerySummary,
  ThumbnailStatus,
} from "./types";

const PAGE_SIZE = 60;
const MOBILE_PAGE_SIZE = 36;
const SIDEBAR_STORAGE_KEY = "pixhelf.sidebar-collapsed";
const GALLERY_POLL_INTERVAL_MS = 10_000;
const IMAGE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MOBILE_NAV_EXIT_MS = 240;
const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN");

type ImagePageState = {
  images: GalleryImage[];
  total: number;
  nextOffset: number | null;
};

const EMPTY_IMAGE_PAGE: ImagePageState = {
  images: [],
  total: 0,
  nextOffset: null,
};

function initialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

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

function useVisualViewportTop(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;
    let settleTimer = 0;
    const update = () => {
      frame = 0;
      const pageOffset = viewport.pageTop - window.scrollY;
      const offset = Math.max(0, viewport.offsetTop, pageOffset);
      document.documentElement.style.setProperty(
        "--visual-viewport-top",
        `${Math.round(offset * 100) / 100}px`,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(update, 120);
    };

    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.documentElement.style.removeProperty("--visual-viewport-top");
    };
  }, []);
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function useDelayedUnmount(visible: boolean, delay: number): boolean {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;

    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [delay, mounted, visible]);

  return mounted;
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function appendUniqueImages(
  current: GalleryImage[],
  incoming: GalleryImage[],
): GalleryImage[] {
  const ids = new Set(current.map((image) => image.id));
  const unique = incoming.filter((image) => {
    if (ids.has(image.id)) return false;
    ids.add(image.id);
    return true;
  });
  return unique.length ? [...current, ...unique] : current;
}

function createExploreSeed(): string {
  const values = new Uint32Array(4);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
}

function App() {
  useVisualViewportTop();
  const [summary, setSummary] = useState<GallerySummary | null>(null);
  const [status, setStatus] = useState<ThumbnailStatus | null>(null);
  const [imagePage, setImagePage] = useState<ImagePageState>(EMPTY_IMAGE_PAGE);
  const [album, setAlbum] = useState("");
  const [search, setSearch] = useState("");
  const [exploreSeed, setExploreSeed] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [reloadToken, setReloadToken] = useState(0);
  const compactLayout = useMediaQuery("(max-width: 720px)");
  const mobileNavMounted = useDelayedUnmount(mobileNavOpen, MOBILE_NAV_EXIT_MS);
  const pageSize = compactLayout ? MOBILE_PAGE_SIZE : PAGE_SIZE;
  const debouncedSearch = useDebounced(search.trim(), 250);
  const requestVersionRef = useRef(0);
  const summaryRevisionRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const { images, total, nextOffset } = imagePage;

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [album, debouncedSearch, exploreSeed]);

  useEffect(() => {
    if (!mobileNavMounted) return;
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
  }, [mobileNavMounted]);

  useEffect(() => {
    if (!compactLayout && mobileNavOpen) setMobileNavOpen(false);
  }, [compactLayout, mobileNavOpen]);

  useEffect(() => {
    if (summary && album && !summary.albums.some((item) => item.path === album)) {
      setAlbum("");
      setMobileNavOpen(false);
    }
  }, [album, summary]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
    } catch {
      // The layout still works when storage is disabled.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const controller = new AbortController();
    getGallery(controller.signal)
      .then((next) => {
        summaryRevisionRef.current = next.revision;
        setSummary(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason, "无法读取图库"));
        }
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getGallery(controller.signal);
        if (controller.signal.aborted) return;
        const previousRevision = summaryRevisionRef.current;
        if (previousRevision !== next.revision) {
          summaryRevisionRef.current = next.revision;
          setSummary(next);
          if (previousRevision) setReloadToken((value) => value + 1);
        }
      } catch {
        // A later poll retries transient scan or network failures.
      } finally {
        if (!controller.signal.aborted) {
          timer = window.setTimeout(poll, GALLERY_POLL_INTERVAL_MS);
        }
      }
    };
    timer = window.setTimeout(poll, GALLERY_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getStatus(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        timer = window.setTimeout(poll, next.backgroundComplete ? 10000 : 1500);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setImagePage(EMPTY_IMAGE_PAGE);
    getImages(
      {
        album,
        search: debouncedSearch,
        sort: exploreSeed ? "explore" : "name-asc",
        seed: exploreSeed,
        offset: 0,
        limit: pageSize,
      },
      controller.signal,
    )
      .then((page) => {
        if (requestVersion !== requestVersionRef.current) return;
        setImagePage({
          images: page.items,
          total: page.total,
          nextOffset: page.nextOffset,
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason, "无法读取图片"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      const loadMoreController = loadMoreControllerRef.current;
      loadMoreControllerRef.current = null;
      loadingMoreRef.current = false;
      loadMoreController?.abort();
    };
  }, [album, debouncedSearch, exploreSeed, pageSize, reloadToken]);

  const loadMore = useCallback(async () => {
    if (loading || nextOffset === null || loadingMoreRef.current) return;
    const controller = new AbortController();
    const requestVersion = requestVersionRef.current;
    loadMoreControllerRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await getImages(
        {
          album,
          search: debouncedSearch,
          sort: exploreSeed ? "explore" : "name-asc",
          seed: exploreSeed,
          offset: nextOffset,
          limit: pageSize,
        },
        controller.signal,
      );
      if (requestVersion !== requestVersionRef.current) return;
      setImagePage((current) => ({
        images: appendUniqueImages(current.images, page.items),
        total: page.total,
        nextOffset: page.nextOffset,
      }));
    } catch (reason) {
      if (!controller.signal.aborted && requestVersion === requestVersionRef.current) {
        setError(errorMessage(reason, "无法继续加载图片"));
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
        if (requestVersion === requestVersionRef.current) setLoadingMore(false);
      }
    }
  }, [album, debouncedSearch, exploreSeed, loading, nextOffset, pageSize]);

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

  const galleryPath = `/${album.replace(/^\/+/, "")}`;
  const chooseAlbum = (path: string) => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setAlbum(path);
    setExploreSeed("");
    setMobileNavOpen(false);
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    setExploreSeed("");
  };
  const startExploring = () => {
    setExploreSeed(createExploreSeed());
  };
  const goHome = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setAlbum("");
    setSearch("");
    setExploreSeed("");
    setMobileNavOpen(false);
  };
  return (
    <div
      className="app-shell"
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-navigation-open={mobileNavOpen}
    >
      <Header
        search={search}
        onSearchChange={changeSearch}
        onExplore={startExploring}
        exploreActive={Boolean(exploreSeed)}
        exploreLoading={Boolean(exploreSeed) && loading}
        onHome={goHome}
        onToggleNavigation={() => setMobileNavOpen((open) => !open)}
        navigationOpen={mobileNavOpen}
      />
      <div
        className="request-progress"
        data-visible={loading}
        role="progressbar"
        aria-label="正在更新图库"
        aria-hidden={!loading}
      >
        <span />
      </div>
      <SidebarToggleButton
        className="gallery-sidebar-toggle"
        expanded={compactLayout ? mobileNavOpen : !sidebarCollapsed}
        onClick={() => {
          if (compactLayout) {
            setMobileNavOpen((open) => !open);
          } else {
            setSidebarCollapsed((collapsed) => !collapsed);
          }
        }}
        controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"}
      />
      <Sidebar
        summary={summary}
        status={status}
        activeAlbum={album}
        galleryPath={galleryPath}
        galleryCount={total}
        onChoose={chooseAlbum}
        mobileOpen={mobileNavOpen}
        mobileMounted={mobileNavMounted}
        onClose={() => setMobileNavOpen(false)}
        desktopCollapsed={sidebarCollapsed}
      />

      <main className="content" aria-busy={loading || loadingMore}>
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
          <MasonryGallery
            images={images}
            initialColumnCount={compactLayout ? 2 : 5}
          />
        ) : (
          <div className="empty-state">
            <ImageIcon size={30} strokeWidth={1.6} />
            <strong>{summary?.total === 0 ? "图库暂无图片" : "没有找到图片"}</strong>
            <span>
              {summary?.total === 0 ? "添加图片后将自动显示" : "请调整相册或搜索条件"}
            </span>
          </div>
        )}

        <div ref={sentinelRef} className="load-sentinel" aria-live="polite">
          {loadingMore && <LoaderCircle className="spin" size={21} aria-label="加载更多" />}
          {!loading && nextOffset === null && images.length > 0 && (
            <span>已显示全部 {formatCount(total)} 张图片</span>
          )}
        </div>
      </main>
    </div>
  );
}

function Header({
  search,
  onSearchChange,
  onExplore,
  exploreActive,
  exploreLoading,
  onHome,
  onToggleNavigation,
  navigationOpen,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  onExplore: () => void;
  exploreActive: boolean;
  exploreLoading: boolean;
  onHome: () => void;
  onToggleNavigation: () => void;
  navigationOpen: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [exploreMotionKey, setExploreMotionKey] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (navigationOpen) {
      searchInputRef.current?.blur();
      setSearchOpen(false);
    }
  }, [navigationOpen]);

  const handleSearchOpenChange = (open: boolean) => {
    if (open && navigationOpen) onToggleNavigation();
    setSearchOpen(open);
  };
  const handleExplore = () => {
    searchInputRef.current?.blur();
    setSearchOpen(false);
    if (navigationOpen) onToggleNavigation();
    setExploreMotionKey((value) => value + 1);
    onExplore();
  };
  const handleHome = () => {
    searchInputRef.current?.blur();
    setSearchOpen(false);
    onHome();
  };

  return (
    <header className="topbar" data-search-open={searchOpen}>
      <div className="topbar-leading">
        <a
          className="brand"
          href="/"
          aria-label="返回 Pixhelf 主页"
          title="返回主页"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            handleHome();
          }}
        >
          <span className="brand-mark"><Images size={21} /></span>
          <span>Pixhelf</span>
        </a>
      </div>
      <div className="topbar-actions" role="toolbar" aria-label="图库工具">
        <button
          type="button"
          className={`icon-button toolbar-action-button explore-toggle ${exploreActive ? "is-active" : ""} ${exploreLoading ? "is-loading" : ""}`}
          onClick={handleExplore}
          aria-label={exploreActive ? "换一组图片" : "随机探索"}
          aria-pressed={exploreActive}
          aria-busy={exploreLoading}
          title={exploreActive ? "换一组" : "随机探索"}
        >
          <Dices
            key={exploreMotionKey}
            className={`explore-icon ${exploreMotionKey ? "is-rolling" : ""}`}
            size={18}
          />
          <span className="toolbar-state-dot" aria-hidden="true" />
        </button>
        <ToolbarPopover
          id="gallery-search-field"
          open={searchOpen}
          onOpenChange={handleSearchOpenChange}
          openLabel="打开搜索"
          closeLabel="收起搜索"
          panelLabel="搜索图片"
          icon={
            <>
              <Search className="search-toggle-icon" size={18} />
              <span className="toolbar-state-dot" aria-hidden="true" />
            </>
          }
          rootClassName={`topbar-search ${search ? "has-query" : ""}`}
          triggerClassName="search-toggle"
          panelClassName="search-popover-panel"
        >
          <Search className="search-popover-icon" aria-hidden="true" size={17} />
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索文件名"
            aria-label="搜索文件名"
            enterKeyHint="search"
            autoComplete="off"
            tabIndex={searchOpen ? 0 : -1}
          />
          {search && (
            <button
              type="button"
              className="clear-search"
              onClick={() => onSearchChange("")}
              aria-label="清空搜索"
              title="清空搜索"
              tabIndex={searchOpen ? 0 : -1}
            >
              <X size={15} />
            </button>
          )}
        </ToolbarPopover>
      </div>
    </header>
  );
}

function SidebarToggleButton({
  className,
  controls,
  expanded,
  onClick,
}: {
  className: string;
  controls: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const label = expanded ? "收起侧栏" : "展开侧栏";
  return (
    <button
      type="button"
      className={`icon-button sidebar-toggle-button ${className} ${expanded ? "is-expanded" : "is-collapsed"}`}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
    >
      <span key={String(expanded)} className="sidebar-toggle-glyph" aria-hidden="true">
        {expanded ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
      </span>
    </button>
  );
}

function SidebarStatus({ status }: { status: ThumbnailStatus | null }) {
  if (!status) {
    return (
      <div className="sidebar-status muted" role="status">
        <LoaderCircle className="spin" size={15} />
        <span>连接中</span>
      </div>
    );
  }
  const complete = status.backgroundComplete;
  return (
    <div
      className={`sidebar-status ${complete ? "complete" : ""}`}
      title={complete ? "缩略图处理完成" : "正在后台处理缩略图"}
      role="status"
    >
      {complete ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />}
      <span>{complete ? "已就绪" : "处理中"}</span>
      <strong>{formatCount(status.ready)} / {formatCount(status.total)}</strong>
    </div>
  );
}

function Sidebar({
  summary,
  status,
  activeAlbum,
  galleryPath,
  galleryCount,
  onChoose,
  mobileOpen,
  mobileMounted,
  onClose,
  desktopCollapsed,
}: {
  summary: GallerySummary | null;
  status: ThumbnailStatus | null;
  activeAlbum: string;
  galleryPath: string;
  galleryCount: number;
  onChoose: (path: string) => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onClose: () => void;
  desktopCollapsed: boolean;
}) {
  const navigation = (
    <>
      <div className="sidebar-control-slot" aria-hidden="true" />
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
      <SidebarStatus status={status} />
      <div className="sidebar-gallery-meta">
        <span className="sidebar-gallery-path" title={galleryPath}>{galleryPath}</span>
        <span className="sidebar-gallery-count">{formatCount(galleryCount)} 张图片</span>
      </div>
    </>
  );

  return (
    <>
      <aside
        id="desktop-album-navigation"
        className="sidebar desktop-sidebar"
        aria-label="相册导航"
        aria-hidden={desktopCollapsed}
        inert={desktopCollapsed}
      >
        {navigation}
      </aside>
      {mobileMounted && (
        <div
          className="mobile-nav-layer"
          data-state={mobileOpen ? "open" : "closing"}
          role="presentation"
          aria-hidden={!mobileOpen}
          inert={!mobileOpen}
        >
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
      title={detail ?? label}
    >
      {all ? <Images size={17} /> : <Folder size={17} />}
      <span className="album-copy">
        <strong>{label}</strong>
      </span>
      <span className="album-count">{formatCount(count)}</span>
    </button>
  );
}

function useColumnCount(
  ref: RefObject<HTMLDivElement | null>,
  initialColumnCount: number,
): number {
  const [columns, setColumns] = useState(initialColumnCount);
  useLayoutEffect(() => {
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
  }, [initialColumnCount, ref]);
  return columns;
}

function MasonryGallery({
  images,
  initialColumnCount,
}: {
  images: GalleryImage[];
  initialColumnCount: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [activeNameId, setActiveNameId] = useState<string | null>(null);
  const [readyRevealRows, setReadyRevealRows] = useState<Set<number>>(
    () => new Set(),
  );
  const settledRevealIdsRef = useRef(new Set<string>());
  const revealRowMembersRef = useRef<string[][]>([]);
  const activeNameTimerRef = useRef(0);
  const columnCount = useColumnCount(ref, initialColumnCount);
  const eagerRowCount = columnCount <= 2 ? 6 : 2;
  const highPriorityRowCount = columnCount <= 2 ? 4 : 1;

  useEffect(() => () => window.clearTimeout(activeNameTimerRef.current), []);

  const revealName = useCallback((id: string) => {
    window.clearTimeout(activeNameTimerRef.current);
    setActiveNameId(id);
    activeNameTimerRef.current = window.setTimeout(() => {
      setActiveNameId((current) => current === id ? null : current);
    }, 1_800);
  }, []);

  const markRevealImageSettled = useCallback((rowIndex: number, id: string) => {
    settledRevealIdsRef.current.add(id);
    const rowMembers = revealRowMembersRef.current[rowIndex];
    if (!rowMembers?.every((memberId) => settledRevealIdsRef.current.has(memberId))) return;

    setReadyRevealRows((current) => {
      if (current.has(rowIndex)) return current;
      const next = new Set(current);
      next.add(rowIndex);
      return next;
    });
  }, []);

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

  const synchronizedRowCount = columnCount <= 2
    ? Math.max(0, ...columns.map((column) => column.length))
    : 0;
  const synchronizedRowMembers = useMemo(
    () => Array.from({ length: synchronizedRowCount }, (_, rowIndex) => (
      columns
        .map((column) => column[rowIndex]?.image.id)
        .filter((id): id is string => Boolean(id))
    )),
    [columns, synchronizedRowCount],
  );

  useLayoutEffect(() => {
    revealRowMembersRef.current = synchronizedRowMembers;
  }, [synchronizedRowMembers]);

  return (
    <div
      ref={ref}
      className="masonry"
      style={{ "--columns": columnCount } as CSSProperties}
    >
      {columns.map((column, columnIndex) => (
        <div className="masonry-column" key={columnIndex}>
          {column.map(({ image, index }, rowIndex) => {
            const synchronizeReveal = rowIndex < synchronizedRowCount;
            return (
              <ImageCard
                key={image.id}
                image={image}
                index={index}
                eager={rowIndex < eagerRowCount}
                highPriority={rowIndex < highPriorityRowCount}
                revealReady={!synchronizeReveal || readyRevealRows.has(rowIndex)}
                revealGroup={synchronizeReveal ? rowIndex : undefined}
                nameVisible={activeNameId === image.id}
                onNameTrigger={revealName}
                onSettled={synchronizeReveal ? markRevealImageSettled : undefined}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

const ImageCard = memo(function ImageCard({
  image,
  index,
  eager,
  highPriority,
  revealReady,
  revealGroup,
  nameVisible,
  onNameTrigger,
  onSettled,
}: {
  image: GalleryImage;
  index: number;
  eager: boolean;
  highPriority: boolean;
  revealReady: boolean;
  revealGroup?: number;
  nameVisible: boolean;
  onNameTrigger: (id: string) => void;
  onSettled?: (rowIndex: number, id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  const handleError = () => {
    setLoaded(false);
    setFailed(true);
    const delay = IMAGE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      if (revealGroup !== undefined) onSettled?.(revealGroup, image.id);
      return;
    }
    retryTimerRef.current = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      setFailed(false);
    }, delay);
  };

  const thumbnailUrl = attempt
    ? `${image.thumbnailUrl}?retry=${attempt}`
    : image.thumbnailUrl;
  const revealed = loaded && revealReady;
  return (
    <figure
      className="image-card"
      title={image.name}
      data-image-id={image.id}
      data-name-visible={nameVisible}
      data-loaded={revealed}
      data-failed={failed}
      data-reveal-ready={revealReady}
      style={{
        aspectRatio: `${image.width} / ${image.height}`,
        "--card-order": Math.min(index, 12),
      } as CSSProperties}
      onPointerUp={(event) => {
        if (event.pointerType !== "mouse") onNameTrigger(image.id);
      }}
    >
      {!failed ? (
        <img
          src={thumbnailUrl}
          alt={image.name}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={highPriority ? "high" : "auto"}
          className={revealed ? "loaded" : ""}
          onLoad={() => {
            setLoaded(true);
            if (revealGroup !== undefined) onSettled?.(revealGroup, image.id);
          }}
          onError={handleError}
        />
      ) : (
        <span className="image-fallback" role="img" aria-label={`${image.name} 加载失败`}>
          <ImageIcon size={24} />
        </span>
      )}
      <span className="image-name">{image.name}</span>
    </figure>
  );
});

function GallerySkeleton() {
  const ratios = [1.4, 0.72, 1, 1.55, 0.8, 1.2, 0.67, 1.35, 0.9, 1.6, 0.76, 1.1];
  return (
    <div className="skeleton-grid" aria-label="正在加载图库">
      {ratios.map((ratio, index) => (
        <span
          key={index}
          aria-hidden="true"
          style={{
            aspectRatio: String(ratio),
            "--skeleton-order": index,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

export default App;
