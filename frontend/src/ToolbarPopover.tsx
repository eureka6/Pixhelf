import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

type ToolbarPopoverProps = {
  children: ComponentChildren;
  closeLabel: string;
  icon: ComponentChildren;
  id: string;
  open: boolean;
  openLabel: string;
  onOpenChange: (open: boolean) => void;
  panelClassName?: string;
  panelLabel: string;
  rootClassName?: string;
  triggerClassName?: string;
};

export function ToolbarPopover({
  children,
  closeLabel,
  icon,
  id,
  open,
  openLabel,
  onOpenChange,
  panelClassName = "",
  panelLabel,
  rootClassName = "",
  triggerClassName = "",
}: ToolbarPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeFromOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (event.target instanceof Node && root?.contains(event.target)) return;

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && root?.contains(activeElement)) {
        activeElement.blur();
      }
      onOpenChange(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus({ preventScroll: true });
    };

    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [onOpenChange, open]);

  const triggerLabel = open ? closeLabel : openLabel;
  return (
    <div
      ref={rootRef}
      className={`toolbar-popover ${open ? "is-open" : ""} ${rootClassName}`}
      data-popover-open={open}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`icon-button toolbar-popover-trigger ${triggerClassName}`}
        onClick={() => onOpenChange(!open)}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={id}
        title={triggerLabel}
      >
        <span className="toolbar-popover-trigger-icon" aria-hidden="true">
          {icon}
        </span>
      </button>
      <div
        id={id}
        className={`toolbar-popover-panel ${panelClassName}`}
        role="group"
        aria-label={panelLabel}
        aria-hidden={!open}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}
