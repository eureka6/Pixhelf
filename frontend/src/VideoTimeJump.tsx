import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { formatDuration } from "./format";
import { ArrowRight } from "./icons";
import { ToolbarPopover } from "./ToolbarPopover";

type VideoTimeJumpProps = {
  position: number;
  duration: number;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSeek: (seconds: number) => void;
};

function parseTime(value: string): number | null {
  const parts = value.trim().replaceAll("：", ":").split(":");
  if (!parts.length || parts.length > 3 || parts.some((part, index) =>
    !(index === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(part))) return null;
  const values = parts.map(Number);
  if (values.slice(1).some(value => value >= 60)) return null;
  const seconds = values.reduce((total, value) => total * 60 + value, 0);
  return Number.isFinite(seconds) ? seconds : null;
}

export function VideoTimeJump({ position, duration, disabled, open, onOpenChange, onSeek }: VideoTimeJumpProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    if (!open) return;
    setValue(formatDuration(position));
    setError("");
    inputRef.current?.focus({ preventScroll: true });
    // Wait for the controlled input's value before selecting it.
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const close = () => {
    onOpenChange(false);
    inputRef.current?.closest(".video-time-menu")?.querySelector<HTMLElement>(".toolbar-popover-trigger")?.focus({ preventScroll: true });
  };

  return <ToolbarPopover id="video-time-jump" open={open} onOpenChange={onOpenChange} disabled={disabled}
    openLabel="跳转到指定时间" closeLabel="收起时间跳转" panelLabel="时间跳转"
    rootClassName="video-time-menu" triggerClassName="video-time-toggle" panelClassName="video-time-panel"
    icon={<span className="video-viewer-time" data-long-duration={duration >= 3600}>
      <span>{formatDuration(position)}</span><span className="video-time-divider">/</span><span>{formatDuration(duration)}</span>
    </span>}>
    <form onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      const seconds = parseTime(value);
      if (seconds === null) { setError("请输入秒数、分:秒或时:分:秒"); return; }
      if (seconds > duration) { setError(`时间不能超过 ${formatDuration(duration)}`); return; }
      onSeek(seconds);
      close();
    }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <label htmlFor="video-jump-value">跳转到</label>
      <div className="video-time-entry">
        <input ref={inputRef} id="video-jump-value" type="text" value={value} autoComplete="off" spellcheck={false}
          aria-label="跳转时间" aria-invalid={Boolean(error)} aria-describedby="video-jump-hint"
          onInput={event => { setValue(event.currentTarget.value); setError(""); }} />
        <button type="submit" aria-label="确认跳转" disabled={disabled}><ArrowRight size={18} /></button>
      </div>
      <p id="video-jump-hint" role={error ? "alert" : undefined} data-error={Boolean(error)}>
        {error || `秒数 / 分:秒 / 时:分:秒 · 总时长 ${formatDuration(duration)}`}
      </p>
    </form>
  </ToolbarPopover>;
}
