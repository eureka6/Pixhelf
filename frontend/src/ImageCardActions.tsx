import type { JSX } from "preact";
import { memo } from "preact/compat";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Check, Copy, Download, ExternalLink, ImageIcon, Info, ScanSearch } from "./icons";
import { CARD_MENU_EVENT, CARD_SELECTOR } from "./cardInteraction";
import type { CardMenuRequest } from "./cardInteraction";
import type { GalleryImage, ImageCardAction } from "./types";
import { viewerOriginalUrl } from "./viewerAssets";

async function copyFilename(name: string, container: HTMLElement): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(name);
      return;
    }
  } catch { /* Keep copying available on HTTP and when clipboard access is denied. */ }
  const active = document.activeElement;
  const input = document.createElement("textarea");
  input.value = name;
  input.readOnly = true;
  input.tabIndex = -1;
  Object.assign(input.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" });
  container.append(input);
  input.focus({ preventScroll: true });
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
  }
}

export const ImageCardActions = memo(function ImageCardActions({ image, onAction }: {
  image: GalleryImage;
  onAction: (action: ImageCardAction) => void;
}) {
  const controlsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<CardMenuRequest | null>(null);
  const open = request !== null;
  const [copyState, setCopyState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const originalUrl = viewerOriginalUrl(image);

  const closeMenu = (restoreFocus = false) => {
    const menu = menuRef.current;
    if (menu?.matches(":popover-open")) menu.hidePopover();
    setRequest(null);
    if (restoreFocus) {
      const card = controlsRef.current?.closest<HTMLElement>(CARD_SELECTOR);
      const target = card?.querySelector<HTMLElement>(".photo-card-open") ?? card;
      target?.focus({ preventScroll: true });
    }
  };

  useLayoutEffect(() => {
    const card = controlsRef.current?.closest(CARD_SELECTOR);
    if (!card) return;
    const show = (event: Event) => {
      // The timer and the browser's contextmenu may both fire for the same long press.
      setRequest(current => current ?? (event as CustomEvent<CardMenuRequest>).detail);
    };
    card.addEventListener(CARD_MENU_EVENT, show);
    return () => card.removeEventListener(CARD_MENU_EVENT, show);
  }, []);

  useLayoutEffect(() => {
    if (!request) return;
    const menu = menuRef.current;
    const card = controlsRef.current?.closest<HTMLElement>(CARD_SELECTOR);
    if (!menu || !card) return;
    setCopyState("idle");
    // The top layer lets menus escape a thumbnail's clipped edges, including in the viewer.
    // Dismiss on a new outside contact, never on the release that opened a context menu.
    menu.setAttribute("popover", "manual");
    for (const other of document.querySelectorAll<HTMLElement>(".photo-card-menu:popover-open")) {
      if (other !== menu) other.hidePopover();
    }
    menu.showPopover();
    const origin = card.getBoundingClientRect();
    const anchor = {
      x: Math.max(0, Math.min((request.point?.x ?? origin.left + 24) - origin.left, origin.width)),
      y: Math.max(0, Math.min((request.point?.y ?? origin.top + 24) - origin.top, origin.height)),
    };
    // The viewer may still be animating its zoom when the menu opens.
    const fixedPoint = card.matches(".viewer-media") ? request.point : undefined;
    const position = () => {
      const cardRect = card.getBoundingClientRect();
      const x = fixedPoint?.x ?? cardRect.left + anchor.x;
      const y = fixedPoint?.y ?? cardRect.top + anchor.y;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      menu.style.maxHeight = `${Math.max(80, height - 24)}px`;
      const bounds = menu.getBoundingClientRect();
      const gap = request.touch ? 10 : 6;
      const menuLeft = x + gap + bounds.width <= left + width - 12 ? x + gap : x - bounds.width - gap;
      const menuTop = y + gap + bounds.height <= top + height - 12 ? y + gap : y - bounds.height - gap;
      menu.style.left = `${Math.max(left + 12, Math.min(menuLeft, left + width - bounds.width - 12))}px`;
      menu.style.top = `${Math.max(top + 12, Math.min(menuTop, top + height - bounds.height - 12))}px`;
    };
    const toggle = () => {
      if (!menu.matches(":popover-open")) setRequest(null);
    };
    let dismissTimer = 0;
    const dismiss = () => closeMenu();
    const down = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) dismiss();
    };
    const move = (event: PointerEvent) => {
      if (!request.touch && event.pointerType === "mouse") {
        if (event.target instanceof Node && card.contains(event.target)) {
          window.clearTimeout(dismissTimer);
          dismissTimer = 0;
        } else if (!dismissTimer) {
          // Allow crossing the small gap between the trigger and its menu.
          dismissTimer = window.setTimeout(dismiss, 180);
        }
      }
    };
    const leaveWindow = (event: PointerEvent) => {
      if (!request.touch && event.pointerType === "mouse" && !event.relatedTarget) dismiss();
    };
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Node && menu.contains(event.target))) dismiss();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      const rect = card.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      if (rect.bottom <= top || rect.top >= top + (viewport?.height ?? innerHeight)
        || rect.right <= left || rect.left >= left + (viewport?.width ?? innerWidth)) {
        dismiss();
      } else position();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const listeners = new AbortController();
    const { signal } = listeners;
    const capture = { capture: true, signal };
    menu.addEventListener("toggle", toggle, { signal });
    document.addEventListener("pointerdown", down, capture);
    document.addEventListener("pointermove", move, { ...capture, passive: true });
    document.addEventListener("pointerout", leaveWindow, capture);
    document.addEventListener("wheel", wheel, { ...capture, passive: true });
    window.addEventListener("blur", dismiss, { signal });
    document.addEventListener("scroll", scroll, capture);
    window.addEventListener("resize", position, { signal });
    window.visualViewport?.addEventListener("resize", position, { signal });
    window.visualViewport?.addEventListener("scroll", position, { signal });
    return () => {
      observer.disconnect();
      window.clearTimeout(dismissTimer);
      listeners.abort();
      if (menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [request]);

  const choose = (action: ImageCardAction) => {
    closeMenu(true);
    onAction(action);
  };

  const handleMenuKey = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      closeMenu(true);
      return;
    }
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={controlsRef}
      className="photo-card-controls"
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onPointerCancel={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDblClick={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key !== "Tab" && event.key !== "Escape") event.stopPropagation();
      }}
      onContextMenu={event => event.stopPropagation()}
    >
      {open && (
        <div ref={menuRef} className="photo-card-menu" role="menu" aria-label="图片操作" onKeyDown={handleMenuKey}>
          <div className="photo-card-menu-heading" role="presentation">
            <strong>{image.name}</strong>
            <span>{image.width.toLocaleString()} × {image.height.toLocaleString()}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => choose("view")}><ImageIcon size={17} /><span>查看大图</span></button>
          <button type="button" role="menuitem" onClick={() => choose("details")}><Info size={17} /><span>图片信息</span></button>
          <button type="button" role="menuitem" onClick={() => choose("similar")}><ScanSearch size={17} /><span>查找相似图片</span></button>
          <div className="photo-card-menu-divider" role="separator" />
          <a role="menuitem" href={originalUrl} download={image.name} onClick={() => closeMenu()}><Download size={17} /><span>下载原图</span></a>
          <a role="menuitem" href={originalUrl} target="_blank" rel="noopener noreferrer" onClick={() => closeMenu()}><ExternalLink size={17} /><span>在新标签页打开原图</span></a>
          <button type="button" role="menuitem" aria-disabled={copyState === "pending"} onClick={async () => {
            const menu = menuRef.current;
            if (!menu || copyState === "pending") return;
            setCopyState("pending");
            try {
              await copyFilename(image.name, menu);
              if (menu.isConnected) setCopyState("done");
            } catch {
              if (menu.isConnected) setCopyState("failed");
            }
          }}>
            {copyState === "done" ? <Check size={17} /> : <Copy size={17} />}
            <span>{copyState === "done" ? "已复制文件名" : copyState === "pending" ? "正在复制…" : "复制文件名"}</span>
          </button>
          <span className="photo-card-feedback" role="status">{copyState === "failed" ? "复制失败，请重试" : copyState === "done" ? "文件名已复制" : ""}</span>
        </div>
      )}
    </div>
  );
});
