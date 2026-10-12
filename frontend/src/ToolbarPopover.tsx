import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

type ToolbarPopoverProps = {
  children: ComponentChildren;
  autoDismiss?: boolean;
  disabled?: boolean;
  closeLabel: string;
  icon: ComponentChildren;
  id: string;
  open: boolean;
  openLabel: string;
  onOpenChange: (open: boolean) => void;
  panelClassName?: string;
  panelLabel: string;
  panelRole?: "group" | "menu" | "dialog";
  rootClassName?: string;
  triggerClassName?: string;
  field?: ComponentChildren;
};

export function ToolbarPopover({
  children,
  autoDismiss = false,
  disabled = false,
  closeLabel,
  icon,
  id,
  open,
  openLabel,
  onOpenChange,
  panelClassName = "",
  panelLabel,
  panelRole = "group",
  rootClassName = "",
  triggerClassName = "",
  field,
}: ToolbarPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeFromKeyboard = (event: KeyboardEvent) => {
    if (!open || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!open && active instanceof HTMLElement && panelRef.current?.contains(active)) {
      triggerRef.current?.focus({ preventScroll: true });
      active.blur();
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const closeFromOutside = (event: Event) => {
      const root = rootRef.current;
      if (event.target instanceof Node && root?.contains(event.target)) return;

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && root?.contains(activeElement)) {
        activeElement.blur();
      }
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromKeyboard);
    if (autoDismiss) {
      document.addEventListener("focusin", closeFromOutside);
      // Observe the user's scroll intent, not layout scrolls caused by new results or the keyboard.
      document.addEventListener("wheel", closeFromOutside, { capture: true, passive: true });
    }
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromKeyboard);
      document.removeEventListener("focusin", closeFromOutside);
      document.removeEventListener("wheel", closeFromOutside, true);
    };
  }, [autoDismiss, onOpenChange, open]);

  const triggerLabel = open ? closeLabel : openLabel;
  const panel = <div
    ref={panelRef}
    id={id}
    className={`toolbar-popover-panel ${panelClassName}`}
    data-open={open}
    role={panelRole}
    aria-label={panelLabel}
    aria-hidden={!open}
    inert={!open}
  >{children}</div>;
  return (
    <div
      ref={rootRef}
      onKeyDown={closeFromKeyboard}
      className={`toolbar-popover ${open ? "is-open" : ""} ${rootClassName}`}
    >
      {field}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        className={`icon-button toolbar-popover-trigger ${triggerClassName}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={event => {
          if (panelRole !== "group" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
        aria-label={triggerLabel}
        aria-haspopup={panelRole === "group" ? undefined : panelRole}
        aria-expanded={open}
        aria-controls={id}
        title={triggerLabel}
      >
        <span className="toolbar-popover-trigger-icon" aria-hidden="true">
          {icon}
        </span>
      </button>
      {panel}
    </div>
  );
}
