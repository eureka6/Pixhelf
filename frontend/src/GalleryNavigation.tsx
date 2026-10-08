import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import logoMark from "./assets/pixhelf-mark.svg?inline";
import { formatCount } from "./format";
import {
  BookImage,
  Cloud,
  ChevronDown,
  HardDrive,
  Images,
  Heart,
  Trash2,
  Menu,
  Search,
  ScanSearch,
  X,
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import { GalleryFilters, imageFilterLabels } from "./GalleryFilters";
import { AuthControls } from "./AuthControls";
import { authentication } from "./auth";
import { useManagement } from "./management";
import type { ContentCategory, GallerySection, GallerySummary, ImageFilters } from "./types";

export function Header({
  hidden,
  onReveal,
  search,
  searchOpen,
  onSearchOpenChange,
  searchMode,
  albumSearch,
  storageSearch,
  localSearch = false,
  similarSearch,
  onSearchChange,
  onToggleNavigation,
  navigationOpen,
  compactLayout,
  filters,
  onFiltersChange,
  onContentChange,
  onResetFilters,
  categories,
  categoriesHint,
  onConfigureCategories,
}: {
  hidden: boolean;
  onReveal: () => void;
  search: string;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchMode: "filename" | "indexing" | "semantic";
  albumSearch: boolean;
  storageSearch: boolean;
  localSearch?: boolean;
  similarSearch: boolean;
  onSearchChange: (value: string) => void;
  onToggleNavigation: () => void;
  navigationOpen: boolean;
  compactLayout: boolean;
  filters: ImageFilters | null;
  onFiltersChange: (filters: ImageFilters) => void;
  onContentChange: (query: string) => void;
  onResetFilters: () => void;
  categories: ContentCategory[];
  categoriesHint: string;
  onConfigureCategories?: () => void;
}) {
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileNavigationOpen = compactLayout && navigationOpen;
  const semanticSearch = !albumSearch && !storageSearch && !localSearch && !similarSearch && searchMode === "semantic";
  const searchIndexing = !albumSearch && !storageSearch && !localSearch && !similarSearch && searchMode === "indexing";
  const filterLabels = filters ? imageFilterLabels(filters, semanticSearch ? search : "", categories) : [];
  const filtersActive = filterLabels.length > 0;
  const searchPlaceholder = localSearch ? "搜索当前目录" : similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件" : albumSearch ? "搜索相册名称或路径" : semanticSearch
    ? "描述想找的图片"
    : "搜索文件名";

  useLayoutEffect(() => {
    if (!searchOpen) {
      setFiltersExpanded(false);
      searchInputRef.current?.blur();
      return;
    }
    if (compactLayout || window.matchMedia("(pointer: coarse)").matches) return;
    searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen, compactLayout]);

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
  return (
    <header className="topbar" data-hidden={hidden} data-search-open={searchOpen} onFocus={onReveal}>
      <SidebarToggleButton
        className="gallery-sidebar-toggle"
        expanded={navigationOpen}
        onClick={() => { onReveal(); onToggleNavigation(); }}
        controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"}
      />
      <div className="topbar-actions" role="toolbar" aria-label="图库工具">
        <ToolbarPopover
          id="gallery-search-field"
          open={searchOpen}
          autoDismiss
          onOpenChange={handleSearchOpenChange}
          openLabel={filters ? "搜索与筛选" : "打开搜索"}
          closeLabel={filters ? "收起搜索与筛选" : "收起搜索"}
          panelLabel={localSearch ? "搜索本地目录" : similarSearch ? "筛选相似图片" : storageSearch ? "筛选外部文件" : albumSearch ? "搜索相册" : "搜索与筛选"}
          icon={
            <>
              {searchOpen ? <X className="search-toggle-icon" size={18} /> : <Search className="search-toggle-icon" size={18} />}
              <span className="toolbar-state-dot" aria-hidden="true" />
            </>
          }
          rootClassName={`topbar-search ${search || filtersActive ? "has-query" : ""} ${filters ? "gallery-search" : ""} ${semanticSearch ? "is-semantic" : ""}`}
          triggerClassName="search-toggle"
          panelClassName="search-popover-panel gallery-search-panel"
        >
          <div className="gallery-search-top">
            <div className="gallery-search-input">
              <Search className="search-popover-icon" aria-hidden="true" size={17} />
              <input
                ref={searchInputRef}
                type="search"
                value={search}
                onInput={(event) => onSearchChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    handleSearchOpenChange(false);
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label={localSearch ? "搜索当前目录" : similarSearch ? "筛选已加载结果" : storageSearch ? "筛选已加载文件" : albumSearch ? "搜索相册" : semanticSearch ? "用自然语言搜索图片" : "搜索文件名"}
                enterKeyHint="search"
                autoComplete="off"
                tabIndex={searchOpen ? 0 : -1}
              />
              {search && (
                <button
                  type="button"
                  className="clear-search"
                  onClick={() => { onSearchChange(""); searchInputRef.current?.focus({ preventScroll: true }); }}
                  aria-label="清空搜索"
                  title="清空搜索"
                  tabIndex={searchOpen ? 0 : -1}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            {filters && <button type="button" className="gallery-filter-toggle" aria-expanded={filtersExpanded}
              aria-label={filtersExpanded ? "收起筛选" : "展开筛选"} title={filterLabels.join(" · ") || "分类、类型、画幅与排序"}
              onClick={() => setFiltersExpanded(expanded => !expanded)}>
              筛选{filtersActive && <span className="gallery-filter-count">{filterLabels.length}</span>}<ChevronDown size={15} />
            </button>}
          </div>
          {filters && filtersExpanded && <GalleryFilters filters={filters} search={search} categories={categories} categoriesHint={categoriesHint}
            onChange={onFiltersChange} onContentChange={onContentChange} onConfigureCategories={onConfigureCategories && (() => { onSearchOpenChange(false); onConfigureCategories(); })}
            contentReady={semanticSearch}
            contentHint={searchIndexing ? "内容分类准备中，完成后即可使用。" : "在开启自然语言搜索的图库或相册中可用。"} />}
          {filters && filtersExpanded && (search || filtersActive) && <button type="button"
            className="gallery-filter-reset gallery-search-reset" onClick={onResetFilters}>重置</button>}
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

function Brand({ onHome }: { onHome: () => void }) {
  return (
    <a
      className="brand brand-lockup"
      href="/"
      aria-label="主页"
      title="主页"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onHome();
      }}
    >
      <img className="brand-mark" src={logoMark} width="32" height="32" alt="" />
      <span className="brand-name">Pixhelf</span>
    </a>
  );
}

export function Sidebar({
  summary,
  activeSection,
  onChoose,
  mobileOpen,
  mobileMounted,
  onMobileExited,
  onClose,
  desktopCollapsed,
  onSettings,
  onHome,
}: {
  summary: GallerySummary | null;
  activeSection: GallerySection;
  onChoose: (section: GallerySection) => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onMobileExited: () => void;
  onClose: () => void;
  desktopCollapsed: boolean;
  onSettings: () => void;
  onHome: () => void;
}) {
  const management = useManagement();
  const navigation = (
    <>
      <div className="sidebar-heading"><Brand onHome={onHome} /></div>
      <nav className="album-nav" aria-label="主导航">
        <NavigationButton
          label="图片与视频"
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
        {!authentication.guest && <NavigationButton label="收藏" count={management.ready ? management.favoriteIds.size + management.favoriteAlbums.size : undefined} active={activeSection === "favorites"} onClick={() => onChoose("favorites")} section="favorites" />}
        <NavigationButton
          label="相似图片"
          active={activeSection === "similar"}
          onClick={() => onChoose("similar")}
          section="similar"
        />
        {!authentication.guest && <NavigationButton label="本地存储" active={activeSection === "local"} onClick={() => onChoose("local")} section="local" />}
        {!authentication.guest && <NavigationButton
          label="外部存储"
          active={activeSection === "storage"}
          onClick={() => onChoose("storage")}
          section="storage"
        />}
        {!authentication.guest && <NavigationButton label="回收站" count={management.trashCount} active={activeSection === "trash"} onClick={() => onChoose("trash")} section="trash" />}
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
      {section === "library" ? <Images size={17} /> : section === "favorites" ? <Heart size={17} /> : section === "trash" ? <Trash2 size={17} /> : section === "similar" ? <ScanSearch size={17} /> : section === "local" ? <HardDrive size={17} /> : section === "storage" ? <Cloud size={17} /> : <BookImage size={17} />}
      <span className="album-copy">
        <strong>{label}</strong>
      </span>
      {count !== undefined && <span className="album-count">{formatCount(count)}</span>}
    </button>
  );
}
