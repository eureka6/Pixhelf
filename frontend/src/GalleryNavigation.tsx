import { useEffect, useRef, useState } from "preact/hooks";

import { formatCount } from "./format";
import {
  Check,
  Dices,
  Folder,
  Images,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import type { GallerySummary, ThumbnailStatus } from "./types";

export function Header({
  search,
  searchMode,
  onSearchChange,
  onExplore,
  exploreActive,
  exploreLoading,
  onHome,
  onToggleNavigation,
  navigationOpen,
}: {
  search: string;
  searchMode: "filename" | "indexing" | "semantic";
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
  const semanticSearch = searchMode === "semantic";
  const searchIndexing = searchMode === "indexing";
  const searchPlaceholder = semanticSearch
    ? "描述想找的图片"
    : searchIndexing
      ? "文字索引中 · 暂搜文件名"
      : "搜索文件名";

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
            if (
              event.button !== 0
              || event.metaKey
              || event.ctrlKey
              || event.shiftKey
              || event.altKey
            ) {
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
          rootClassName={`topbar-search ${search ? "has-query" : ""} ${semanticSearch ? "is-semantic" : ""}`}
          triggerClassName="search-toggle"
          panelClassName="search-popover-panel"
        >
          <Search className="search-popover-icon" aria-hidden="true" size={17} />
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onInput={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            aria-label={semanticSearch ? "用自然语言搜索图片" : "搜索文件名"}
            enterKeyHint="search"
            autoComplete="off"
            tabIndex={searchOpen ? 0 : -1}
          />
          {searchMode !== "filename" && (
            <span
              className="search-mode-badge"
              data-state={searchMode}
              title={semanticSearch ? "Chinese-CLIP 本地语义搜索" : "正在建立文字搜图索引"}
            >
              {semanticSearch ? "语义" : "索引中"}
            </span>
          )}
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

export function SidebarToggleButton({
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
  const progress = !status.backgroundComplete
    ? {
      ready: status.ready,
      total: status.total,
      label: "处理中",
      title: "正在后台处理缩略图",
      complete: false,
    }
    : status.textSearch.enabled && !status.textSearch.backgroundComplete
      ? {
        ready: status.textSearch.ready,
        total: status.textSearch.total,
        label: "文字索引",
        title: "正在本地建立自然语言文字搜图索引",
        complete: false,
      }
      : {
        ready: status.ready,
        total: status.total,
        label: "已就绪",
        title: "图片和搜索索引处理完成",
        complete: true,
      };
  return (
    <div
      className={`sidebar-status ${progress.complete ? "complete" : ""}`}
      title={progress.title}
      role="status"
    >
      {progress.complete ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />}
      <span>{progress.label}</span>
      <strong>{formatCount(progress.ready)} / {formatCount(progress.total)}</strong>
    </div>
  );
}

export function Sidebar({
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
