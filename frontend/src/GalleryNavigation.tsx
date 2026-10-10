import { useEffect, useRef } from "preact/hooks";

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
} from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";
import { imageFilterLabels } from "./GalleryFilters";
import { SearchDialog, type SearchDialogProps } from "./SearchDialog";
import { AuthControls } from "./AuthControls";
import { authentication } from "./auth";
import { useManagement } from "./management";
import type { GallerySection, GallerySummary } from "./types";

export function Header({
  hidden, onReveal, searchOpen, onSearchOpenChange, onToggleNavigation, onHoverNavigation, onLeaveNavigation,
  onHome, navigationOpen, navigationPinned, compactLayout, menuOpen, onMenuOpenChange, onUpload, ...searchProps
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
  compactLayout: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onUpload: () => void;
}) {
  const menuItem = useRef<HTMLButtonElement>(null);
  const filterCount = searchProps.filters ? imageFilterLabels(searchProps.filters, "", searchProps.categories).length : 0;
  useEffect(() => { if (menuOpen) menuItem.current?.focus({ preventScroll: true }); }, [menuOpen]);
  const openSearch = () => {
    onReveal();
    onMenuOpenChange(false);
    if (compactLayout && navigationOpen) onToggleNavigation();
    onSearchOpenChange(true);
  };
  return <>
    <header className="topbar" data-hidden={hidden} data-search-open={searchOpen} onFocus={onReveal}>
      <SidebarToggleButton className="gallery-sidebar-toggle" expanded={navigationOpen}
        pinned={navigationPinned} compact={compactLayout}
        onPointerEnter={onHoverNavigation} onPointerLeave={onLeaveNavigation}
        onClick={() => { onReveal(); onMenuOpenChange(false); onToggleNavigation(); }}
        controls={compactLayout ? "mobile-album-navigation" : "desktop-album-navigation"} />
      <div className="topbar-brand" data-visible={navigationOpen} aria-hidden={!navigationOpen} inert={!navigationOpen}
        onPointerEnter={onHoverNavigation} onPointerLeave={onLeaveNavigation}>
        <Brand onHome={onHome} />
      </div>
      <div className="topbar-actions" role="toolbar" aria-label="图库工具">
        <button type="button" className="icon-button search-toggle" aria-label="搜索" title="搜索"
          aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls="gallery-search-dialog" onClick={openSearch}
          data-active={Boolean(searchProps.search || filterCount)}>
          <Search size={21} />
          {Boolean(searchProps.search || filterCount) && <span className="search-active-dot" />}
        </button>
        {!authentication.guest && <ToolbarPopover id="gallery-actions" open={menuOpen} autoDismiss
          onOpenChange={open => { onReveal(); if (open && compactLayout && navigationOpen) onToggleNavigation(); onMenuOpenChange(open); }}
          openLabel="更多操作" closeLabel="关闭菜单" panelLabel="图库操作" panelRole="menu" icon={<MoreHorizontal size={22} />}
          rootClassName="topbar-menu" triggerClassName="gallery-menu-toggle" panelClassName="gallery-menu-panel">
          <div onKeyDown={event => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); menuItem.current?.focus(); }
          }}>
            <button ref={menuItem} type="button" role="menuitem" onClick={() => { onMenuOpenChange(false); onUpload(); }}>
              <Upload size={18} /><span>上传图片</span>
            </button>
          </div>
        </ToolbarPopover>}
      </div>
    </header>
    {searchOpen && <SearchDialog {...searchProps} onClose={() => onSearchOpenChange(false)} />}
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
  const management = useManagement();
  const navigation = (
    <>
      <div className="sidebar-heading" aria-hidden="true" />
      <nav className="album-nav" aria-label="主导航">
        <NavigationButton
          label="照片"
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
