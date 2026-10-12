import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

import logoMark from "./assets/pixhelf-mark.svg?inline";
import { formatCount } from "./format";
import {
  BookImage,
  Cloud,
  HardDrive,
  Images,
  Heart,
  Trash2,
  Menu,
  SidebarMenu,
  Search,
  MoreHorizontal,
  Upload,
  ScanSearch,
  UserRound,
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import { imageFilterLabels } from "./GalleryFilters";
import { SearchDialog, type SearchDialogProps } from "./SearchDialog";
import { useSearchHistory } from "./useSearchHistory";
import { AuthControls } from "./AuthControls";
import { authentication } from "./auth";
import { useManagement } from "./management";
import type { GallerySection, GallerySummary } from "./types";

export function Header({
  hidden, onReveal, searchOpen, onSearchOpenChange, onToggleNavigation, onHoverNavigation, onLeaveNavigation,
  onHome, navigationOpen, navigationPinned, mobileNavigationMounted, compactLayout, menuOpen, onMenuOpenChange, onUpload,
  activeSection, onChoose, onSelectionTarget, ...searchProps
}: SearchDialogProps & {
  hidden: boolean;
  onReveal: () => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onToggleNavigation: () => void;
  onHoverNavigation: (event: PointerEvent) => void;
  onLeaveNavigation: (event: PointerEvent) => void;
  onHome: () => void;
  navigationOpen: boolean;
  navigationPinned: boolean;
  mobileNavigationMounted: boolean;
  compactLayout: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onUpload: () => void;
  activeSection: GallerySection;
  onChoose: (section: GallerySection) => void;
  onSelectionTarget: (element: HTMLDivElement | null) => void;
}) {
  const menuItems = useRef<HTMLDivElement>(null);
  const searchHistory = useSearchHistory();
  const drawerVisible = compactLayout && mobileNavigationMounted;
  const filterCount = searchProps.filters ? imageFilterLabels(searchProps.filters, "", searchProps.categories).length : 0;
  useLayoutEffect(() => { if (menuOpen) menuItems.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true }); }, [menuOpen, compactLayout]);
  const openSearch = () => {
    onReveal();
    onMenuOpenChange(false);
    if (compactLayout && navigationOpen) onToggleNavigation();
    onSearchOpenChange(true);
  };
  const choose = (section: GallerySection) => {
    onReveal();
    onMenuOpenChange(false);
    onChoose(section);
  };
  const searchButton = <button type="button" className={`${compactLayout ? "mobile-tab" : "icon-button"} search-toggle`}
    aria-label="搜索" title="搜索" aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls="gallery-search-dialog"
    onClick={openSearch} data-active={Boolean(searchProps.search || filterCount)}>
    <span className="navigation-icon"><Search size={compactLayout ? 19 : 21} />
      {Boolean(searchProps.search || filterCount) && <span className="search-active-dot" />}
    </span>
    {compactLayout && <span className="mobile-tab-label">搜索</span>}
  </button>;
  const actionsMenu = <ToolbarPopover id="gallery-actions" open={menuOpen} autoDismiss
    onOpenChange={open => { onReveal(); if (open && compactLayout && navigationOpen) onToggleNavigation(); onMenuOpenChange(open); }}
    openLabel="更多操作" closeLabel="关闭菜单" panelLabel="图库操作" panelRole="menu"
    icon={<><MoreHorizontal size={compactLayout ? 20 : 22} />{compactLayout && <span className="mobile-tab-label">更多</span>}</>}
    rootClassName={compactLayout ? "mobile-more" : "topbar-menu"}
    triggerClassName={`gallery-menu-toggle${compactLayout ? " mobile-tab" : ""}`}
    panelClassName={`gallery-menu-panel${compactLayout ? " mobile-more-panel" : ""}`}>
      <div ref={menuItems}
        onKeyDown={event => {
          if (event.defaultPrevented || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
          const current = items.indexOf(document.activeElement as HTMLElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          {!authentication.guest && <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => { onMenuOpenChange(false); onUpload(); }}>
            <Upload size={18} /><span>上传图片</span>
          </button>}
          {authentication.guest && <a role="menuitem" href="/login"><UserRound size={18} /><span>管理员登录</span></a>}
      </div>
  </ToolbarPopover>;
  return <>
    <header className="topbar" data-hidden={hidden} data-search-open={searchOpen} onFocus={onReveal}>
      <SidebarToggleButton className="gallery-sidebar-toggle" expanded={navigationOpen}
        pinned={navigationPinned} compact={compactLayout}
        onPointerEnter={onHoverNavigation} onPointerLeave={onLeaveNavigation}
        onClick={() => { onReveal(); onMenuOpenChange(false); onToggleNavigation(); }}
        controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"} />
      <div className="topbar-brand"
        onPointerEnter={event => { if (navigationOpen) onHoverNavigation(event); }} onPointerLeave={onLeaveNavigation}>
        <Brand onHome={onHome} />
      </div>
      {!compactLayout && <div className="topbar-actions" role="toolbar" aria-label="图库工具">{searchButton}{actionsMenu}</div>}
    </header>
    <div className="bottom-dock" data-navigation-hidden={compactLayout && hidden} data-menu-open={menuOpen}
      data-drawer-visible={drawerVisible} inert={drawerVisible} aria-hidden={drawerVisible}
      onFocus={event => { if (event.target instanceof Element && event.target.matches(":focus-visible")) onReveal(); }}>
      <div className="bottom-selection" ref={onSelectionTarget} />
      {compactLayout && <div className="mobile-navigation-slot" inert={hidden} aria-hidden={hidden}>
        <nav className="mobile-bottom-nav" aria-label="底部导航" onFocus={onReveal} onPointerDown={onReveal}>
          <button type="button" className="mobile-tab" aria-current={activeSection === "library" ? "page" : undefined}
            onClick={() => choose("library")}><Images size={19} /><span className="mobile-tab-label">图库</span></button>
          <button type="button" className="mobile-tab" aria-current={activeSection === "albums" ? "page" : undefined}
            onClick={() => choose("albums")}><BookImage size={19} /><span className="mobile-tab-label">相册</span></button>
          {searchButton}{actionsMenu}
        </nav>
      </div>}
    </div>
    {searchOpen && <SearchDialog {...searchProps} history={searchHistory} onClose={() => onSearchOpenChange(false)} />}
  </>;
}

function SidebarToggleButton({
  className,
  controls,
  expanded,
  pinned,
  compact,
  onClick,
  onPointerEnter,
  onPointerLeave,
}: {
  className: string;
  controls: string;
  expanded: boolean;
  pinned: boolean;
  compact: boolean;
  onClick: () => void;
  onPointerEnter: (event: PointerEvent) => void;
  onPointerLeave: (event: PointerEvent) => void;
}) {
  const label = compact ? expanded ? "收起侧栏" : "展开侧栏" : pinned ? "收起侧栏" : "固定侧栏";
  return (
    <button
      type="button"
      className={`icon-button sidebar-toggle-button ${className}`}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={compact ? undefined : pinned}
      aria-controls={controls}
      data-mode={compact ? "mobile" : pinned ? "pinned" : "automatic"}
    >
      {compact ? <Menu size={22} /> : <SidebarMenu size={22} pinned={pinned} />}
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
  onDesktopEnter,
  onDesktopLeave,
  onSettings,
}: {
  summary: GallerySummary | null;
  activeSection: GallerySection;
  onChoose: (section: GallerySection) => void;
  mobileOpen: boolean;
  mobileMounted: boolean;
  onMobileExited: () => void;
  onClose: () => void;
  desktopCollapsed: boolean;
  onDesktopEnter: (event: PointerEvent) => void;
  onDesktopLeave: (event: PointerEvent) => void;
  onSettings: () => void;
}) {
  const navigation = (
    <>
      <div className="sidebar-heading" aria-hidden="true" />
      <nav className="album-nav" aria-label="主导航">
        <NavigationGroups summary={summary} activeSection={activeSection} onChoose={onChoose} />
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
        onPointerEnter={onDesktopEnter}
        onPointerLeave={onDesktopLeave}
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

function NavigationGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return <div className="sidebar-nav-group" role="group" aria-label={label}>
    <h3 className="sidebar-group-label" aria-hidden="true">{label}</h3>
    <div className="sidebar-nav-items">{children}</div>
  </div>;
}

function NavigationGroups({ summary, activeSection, onChoose }: {
  summary: GallerySummary | null;
  activeSection: GallerySection;
  onChoose: (section: GallerySection) => void;
}) {
  const management = useManagement();
  const entry = (section: GallerySection, label: string, count?: number) => <NavigationButton
    section={section} label={label} count={count} active={activeSection === section}
    onClick={() => onChoose(section)} />;
  return <>
    <NavigationGroup label="浏览">
      {entry("library", "图库", summary?.total ?? 0)}
      {entry("albums", "相册", summary?.albums.length ?? 0)}
      {!authentication.guest && entry("favorites", "收藏", management.ready ? management.favoriteIds.size + management.favoriteAlbums.size : undefined)}
    </NavigationGroup>
    <NavigationGroup label="图片工具">
      {entry("similar", "相似图片")}
    </NavigationGroup>
    {!authentication.guest && <NavigationGroup label="存储管理">
      {entry("local", "本地存储")}
      {entry("storage", "外部存储")}
      {entry("trash", "回收站", management.trashCount)}
    </NavigationGroup>}
  </>;
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
