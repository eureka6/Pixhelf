import { useEffect, useId, useRef, useState } from "preact/hooks";
import { authentication, logout } from "./auth";
import { LoaderCircle, LogOut, Settings, UserRound } from "./icons";

export function AuthControls({ onSettings }: { onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const busy = useRef(false);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnResize = () => setOpen(false);
    document.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);

  if (authentication.guest) return (
    <footer className="sidebar-footer sidebar-account sidebar-guest">
      <div className="sidebar-account-profile">
        <span className="sidebar-account-avatar"><UserRound size={16} /></span>
        <span className="sidebar-account-name"><strong>访客</strong><small>浏览模式</small></span>
      </div>
      <a className="sidebar-login-link" href="/login">管理员登录</a>
    </footer>
  );
  if (!authentication.authenticated) return null;
  const signOut = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try { await logout(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出失败，请重试");
      setPending(false);
      busy.current = false;
    }
  };

  // Add future account actions as sibling entries in this menu.
  const actions = [{
    id: "logout",
    label: pending ? "正在退出…" : "退出登录",
    icon: pending ? <LoaderCircle className="spin" size={16} /> : <LogOut size={16} />,
    className: "logout-button",
    onSelect: signOut,
  }];

  return (
    <footer ref={rootRef} className="sidebar-footer sidebar-account">
      <button
        ref={triggerRef}
        type="button"
        className="sidebar-account-profile"
        disabled={pending}
        aria-label={`${authentication.username}，账号菜单`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="账号菜单"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sidebar-account-avatar" aria-hidden="true">{Array.from(authentication.username ?? "A")[0]?.toUpperCase()}</span>
        <span className="sidebar-account-name" title={authentication.username}><strong>{authentication.username}</strong><small>管理员</small></span>
      </button>
      <button type="button" className="icon-button sidebar-settings-button" disabled={pending} aria-label="设置" title="设置" onClick={() => { setOpen(false); onSettings(); }}><Settings size={18} /></button>
      {open && (
        <div className="sidebar-account-popover" onKeyDown={event => {
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          if (!items.length) return;
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }}>
          <div ref={menuRef} id={menuId} className="sidebar-account-menu" role="menu" aria-label="账号菜单" aria-busy={pending}>
            {actions.map(action => (
              <button key={action.id} type="button" role="menuitem" className={action.className} disabled={pending} onClick={() => { void action.onSelect(); }}>{action.icon}<span>{action.label}</span></button>
            ))}
          </div>
          {error && <p className="sidebar-account-error" role="alert">{error}</p>}
        </div>
      )}
    </footer>
  );
}
