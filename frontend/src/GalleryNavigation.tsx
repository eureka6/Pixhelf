import { useEffect, useRef, useState } from "preact/hooks";

import { version as appVersion } from "../package.json";
import logoMark from "./assets/pixhelf-mark.svg?inline";
import { formatCount } from "./format";
import {
  Check,
  Dices,
  Folder,
  House,
  Images,
  LoaderCircle,
  Menu,
  Search,
  X,
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import type { GallerySummary, ThumbnailStatus } from "./types";

export function Header({
  search,
  searchOpen,
  onSearchOpenChange,
  searchMode,
  onSearchChange,
  onExplore,
  exploreActive,
  exploreLoading,
  onHome,
  onToggleNavigation,
  navigationOpen,
  compactLayout,
}: {
  search: string;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchMode: "filename" | "indexing" | "semantic";
  onSearchChange: (value: string) => void;
  onExplore: () => void;
  exploreActive: boolean;
  exploreLoading: boolean;
  onHome: () => void;
  onToggleNavigation: () => void;
  navigationOpen: boolean;
  compactLayout: boolean;
}) {
  const [exploreMotionKey, setExploreMotionKey] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileNavigationOpen = compactLayout && navigationOpen;
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
    if (mobileNavigationOpen) {
      searchInputRef.current?.blur();
      onSearchOpenChange(false);
    }
  }, [mobileNavigationOpen, onSearchOpenChange]);

  const handleSearchOpenChange = (open: boolean) => {
    if (open && mobileNavigationOpen) onToggleNavigation();
    onSearchOpenChange(open);
  };
  const handleExplore = () => {
    searchInputRef.current?.blur();
    onSearchOpenChange(false);
    if (mobileNavigationOpen) onToggleNavigation();
    setExploreMotionKey((value) => value + 1);
    onExplore();
  };
  const handleHome = () => {
    searchInputRef.current?.blur();
    onHome();
  };
  return (
    <header className="topbar" data-search-open={searchOpen}>
      <div className="topbar-leading">
        <SidebarToggleButton
          className="gallery-sidebar-toggle"
          expanded={navigationOpen}
          onClick={onToggleNavigation}
          controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"}
        />
      </div>
      <div className="topbar-actions" role="toolbar" aria-label="图库工具">
        <button
          type="button"
          className="icon-button toolbar-action-button topbar-home"
          onClick={handleHome}
          aria-label="主页"
          title="主页"
        >
          <House size={18} />
        </button>
        <button
          type="button"
          className={`icon-button toolbar-action-button explore-toggle ${exploreActive ? "is-active" : ""} ${exploreLoading ? "is-loading" : ""}`}
          onClick={handleExplore}
          aria-label={exploreActive ? "换一组图片" : "随机探索"}
          aria-pressed={exploreActive}
          aria-busy={exploreLoading}
          data-state={exploreActive ? "active" : "idle"}
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
      data-state={expanded ? "expanded" : "collapsed"}
      title={label}
    >
      <Menu size={22} />
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

function SidebarBrand({ onHome }: { onHome: () => void }) {
  return (
    <div className="sidebar-brand">
      <div className="brand-lockup">
        <a
          className="brand"
          href="/"
          aria-label="主页"
          title="主页"
          onClick={(event) => {
            if (
              event.button !== 0
              || event.metaKey
              || event.ctrlKey
              || event.shiftKey
              || event.altKey
            ) return;
            event.preventDefault();
            onHome();
          }}
        >
          <span className="brand-symbol">
            <img className="brand-mark" src={logoMark} width="32" height="32" alt="" />
          </span>
          <span className="brand-name">
            Pixhelf
          </span>
        </a>
        <a
          className="brand-version"
          href="https://github.com/eureka6/Pixhelf"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub"
        >
          v{appVersion}
        </a>
      </div>
    </div>
  );
}

export function Sidebar({
  summary,
  status,
  activeAlbum,
  onChoose,
  onHome,
  mobileOpen,
  mobileMounted,
  onMobileExited,
  onClose,
  desktopCollapsed,
}: {
  summary: GallerySummary | null;
  status: ThumbnailStatus | null;
  activeAlbum: string;
  onChoose: (path: string) => void;
  onHome: () => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onMobileExited: () => void;
  onClose: () => void;
  desktopCollapsed: boolean;
}) {
  const navigation = (
    <>
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
        <SidebarBrand onHome={onHome} />
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
            onTransitionEnd={(event) => {
              if (
                event.target === event.currentTarget
                && event.propertyName === "transform"
                && !mobileOpen
              ) onMobileExited();
            }}
          >
            <SidebarBrand onHome={onHome} />
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
