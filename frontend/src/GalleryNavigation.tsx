import { useEffect, useRef, useState } from "preact/hooks";

import { VersionLink } from "./VersionLink";
import logoMark from "./assets/pixhelf-mark.svg?inline";
import { formatCount } from "./format";
import {
  BookImage,
  Cloud,
  Dices,
  House,
  Images,
  Menu,
  Search,
  ScanSearch,
  X,
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import { AuthControls } from "./AuthControls";
import { authentication } from "./auth";
import type { GallerySection, GallerySummary } from "./types";

export function Header({
  search,
  searchOpen,
  onSearchOpenChange,
  searchMode,
  albumSearch,
  storageSearch,
  similarSearch,
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
  albumSearch: boolean;
  storageSearch: boolean;
  similarSearch: boolean;
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
  const semanticSearch = !albumSearch && !storageSearch && !similarSearch && searchMode === "semantic";
  const searchIndexing = !albumSearch && !storageSearch && !similarSearch && searchMode === "indexing";
  const searchPlaceholder = similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件" : albumSearch ? "搜索相册名称或路径" : semanticSearch
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
          className="icon-button toolbar-action-button explore-toggle"
          onClick={handleExplore}
          aria-label="探索列队"
          aria-pressed={exploreActive}
          aria-busy={exploreLoading}
          title={exploreActive ? "探索列队 · 换一组图片" : "探索列队"}
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
          panelLabel={similarSearch ? "筛选相似图片" : storageSearch ? "筛选外部文件" : albumSearch ? "搜索相册" : "搜索图片"}
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
            aria-label={similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件" : albumSearch ? "搜索相册" : semanticSearch ? "用自然语言搜索图片" : "搜索文件名"}
            enterKeyHint="search"
            autoComplete="off"
            tabIndex={searchOpen ? 0 : -1}
          />
          {!albumSearch && !storageSearch && !similarSearch && searchMode !== "filename" && (
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
      className={`icon-button sidebar-toggle-button ${className}`}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
    >
      <Menu size={22} />
    </button>
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
        <VersionLink className="brand-version" />
      </div>
    </div>
  );
}

export function Sidebar({
  summary,
  activeSection,
  onChoose,
  onHome,
  mobileOpen,
  mobileMounted,
  onMobileExited,
  onClose,
  desktopCollapsed,
  onSettings,
}: {
  summary: GallerySummary | null;
  activeSection: GallerySection;
  onChoose: (section: GallerySection) => void;
  onHome: () => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onMobileExited: () => void;
  onClose: () => void;
  desktopCollapsed: boolean;
  onSettings: () => void;
}) {
  const navigation = (
    <>
      <nav className="album-nav" aria-label="主导航">
        <NavigationButton
          label="图片"
          count={summary?.total ?? 0}
          active={activeSection === "library"}
          onClick={() => onChoose("library")}
          section="library"
        />
        <NavigationButton
          label="相册"
          count={summary?.albums.length ?? 0}
          active={activeSection === "albums"}
          onClick={() => onChoose("albums")}
          section="albums"
        />
        <NavigationButton
          label="相似图片"
          active={activeSection === "similar"}
          onClick={() => onChoose("similar")}
          section="similar"
        />
        {!authentication.guest && <NavigationButton
          label="外部存储"
          active={activeSection === "storage"}
          onClick={() => onChoose("storage")}
          section="storage"
        />}
      </nav>
      <AuthControls onSettings={() => { onClose(); onSettings(); }} />
    </>
  );

  return (
    <>
      <aside
        id="desktop-album-navigation"
        className="sidebar desktop-sidebar"
        aria-label="图库导航"
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
            aria-label="关闭图库导航"
          />
          <aside
            id="mobile-album-navigation"
            className="sidebar mobile-sidebar"
            role="dialog"
            aria-label="图库导航"
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

function NavigationButton({
  label,
  count,
  active,
  onClick,
  section,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  section: GallerySection;
}) {
  return (
    <button
      type="button"
      className={`album-link ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={label}
    >
      {section === "library" ? <Images size={17} /> : section === "similar" ? <ScanSearch size={17} /> : section === "storage" ? <Cloud size={17} /> : <BookImage size={17} />}
      <span className="album-copy">
        <strong>{label}</strong>
      </span>
      {count !== undefined && <span className="album-count">{formatCount(count)}</span>}
    </button>
  );
}
