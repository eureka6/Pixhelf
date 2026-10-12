import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { formatCount, formatFileSize } from "./format";
import { Check, X } from "./icons";

export function SelectionBar({ target, count, unit = "项", bytes, label, busy, progress, onClear, children, messages }: {
  target: HTMLElement | null; count: number; unit?: string; bytes?: number; label: string; busy?: boolean;
  progress?: { completed: number; total: number } | null; onClear: () => void; children: ComponentChildren; messages?: ComponentChildren;
}) {
  if (!target || !count) return null;
  return createPortal(<div className="gallery-selection-bar" role="region" aria-label={label} aria-busy={busy} data-selected-count={count}>
    <div className="selection-count" role="status">
      <span className="selection-count-mark" aria-hidden="true"><Check size={14} /></span>
      <div className="selection-count-copy"><span>已选 <strong>{formatCount(count)}</strong> {unit}</span>{bytes !== undefined && <span className="selection-size"> · {formatFileSize(bytes)}</span>}
        {progress && <small>正在处理 {formatCount(progress.completed)} / {formatCount(progress.total)}</small>}
      </div>
    </div>
    <div className="selection-actions">{children}</div>
    <button type="button" className="selection-clear" title="取消选择" aria-label="取消全部选择" disabled={busy} onClick={onClear}><X size={18} /></button>
    {messages && <div className="selection-messages">{messages}</div>}
  </div>, target);
}
