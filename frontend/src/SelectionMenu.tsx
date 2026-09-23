import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Check, Copy, Download, FolderInput, Heart, Trash2, X } from "./icons";

export type SelectionBatchActions = {
  allFavorite: boolean;
  favoriteDisabled: boolean;
  download: () => void;
  favorite: () => void;
  move: () => void;
  copy?: () => void;
  trash: () => void;
};

export type SelectionActions = {
  active: boolean;
  disabled: boolean;
  selectAll: () => void;
  clear: () => void;
  albums?: boolean;
  batch?: SelectionBatchActions;
};
export type MenuPoint = { x: number; y: number };

export function SelectionMenuItems({ actions, onChoose, showBatch = true }: { actions: SelectionActions; onChoose: (action: () => void) => void; showBatch?: boolean }) {
  const batch = actions.active && showBatch ? actions.batch : undefined;
  return <>
    {batch && <>
      <button type="button" role="menuitem" disabled={actions.disabled} aria-disabled={actions.disabled} onClick={() => onChoose(batch.download)}><Download size={17} /><span>下载所选</span></button>
      <button type="button" role="menuitem" disabled={actions.disabled || batch.favoriteDisabled} aria-disabled={actions.disabled || batch.favoriteDisabled} onClick={() => onChoose(batch.favorite)}><Heart size={17} fill={batch.allFavorite ? "currentColor" : "none"} /><span>{batch.allFavorite ? "取消收藏所选" : "收藏所选"}</span></button>
      <button type="button" role="menuitem" disabled={actions.disabled} aria-disabled={actions.disabled} onClick={() => onChoose(batch.move)}><FolderInput size={17} /><span>移动所选</span></button>
      {batch.copy && <button type="button" role="menuitem" disabled={actions.disabled} aria-disabled={actions.disabled} onClick={() => onChoose(batch.copy!)}><Copy size={17} /><span>复制所选</span></button>}
      <button type="button" role="menuitem" disabled={actions.disabled} aria-disabled={actions.disabled} onClick={() => onChoose(batch.trash)}><Trash2 size={17} /><span>删除所选</span></button>
      <div className="photo-card-menu-divider" role="separator" />
    </>}
    <button type="button" role="menuitem" disabled={actions.disabled} aria-disabled={actions.disabled} onClick={() => onChoose(actions.selectAll)}><Check size={17} /><span>{actions.albums ? "全选已显示相册" : "全选已加载"}</span></button>
    <button type="button" role="menuitem" disabled={actions.disabled || !actions.active} aria-disabled={actions.disabled || !actions.active} onClick={() => onChoose(actions.clear)}><X size={17} /><span>清空选择</span></button>
  </>;
}

export function SelectionMenu({ actions, point, onClose }: { actions: SelectionActions; point: MenuPoint; onClose: (restoreFocus?: boolean) => void }) {
  return <ContextMenu point={point} onClose={onClose}><SelectionMenuItems actions={actions} onChoose={action => { onClose(true); action(); }} /></ContextMenu>;
}

export function ContextMenu({ children, point, onClose, label = "管理选项" }: { children: ComponentChildren; point: MenuPoint; label?: string; onClose: (restoreFocus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    menu.setAttribute("popover", "manual");
    for (const other of document.querySelectorAll<HTMLElement>(".photo-card-menu:popover-open")) if (other !== menu) other.hidePopover();
    menu.showPopover();
    const position = () => {
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - bounds.height - 8))}px`;
    };
    position();
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const listeners = new AbortController();
    const { signal } = listeners;
    const openingScroll = { x: window.scrollX, y: window.scrollY };
    menu.addEventListener("toggle", () => { if (!menu.matches(":popover-open")) onClose(); }, { signal });
    document.addEventListener("pointerdown", event => {
      if (!(event.target instanceof Element)) return;
      const containsPoint = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      };
      if (!containsPoint(menu)) onClose();
    }, { capture: true, signal });
    document.addEventListener("scroll", event => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      // A scroll that brought the opener into view may be delivered after the
      // menu opens. Only a subsequent change in page position dismisses it.
      if (event.target === document && window.scrollX === openingScroll.x && window.scrollY === openingScroll.y) return;
      onClose();
    }, { capture: true, signal });
    window.addEventListener("resize", () => onClose(), { signal });
    window.addEventListener("blur", () => onClose(), { signal });
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    return () => { listeners.abort(); observer.disconnect(); if (menu.matches(":popover-open")) menu.hidePopover(); };
  }, [point]);
  const key = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return <div ref={ref} className="photo-card-menu selection-menu" role="menu" aria-label={label} onKeyDown={key} onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {children}
  </div>;
}
