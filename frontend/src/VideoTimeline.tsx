import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { formatDuration } from "./format";

type VideoTimelineProps = {
  source?: string;
  duration: number;
  position: number;
  scrub: number | null;
  disabled: boolean;
  buffered: [number, number][];
  onScrub: (seconds: number | null) => void;
  onSeek: (seconds: number) => void;
};

// A separate, muted decoder exists only while the timeline is being inspected.
// It seeks the prepared file and never changes the playing video's position.
function SeekFrame({ source, time }: { source: string; time: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const target = useRef(time);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  target.current = time;
  const seek = () => {
    const video = ref.current;
    if (!video || video.readyState < 1 || !Number.isFinite(video.duration)) return;
    const next = Math.max(0, Math.min(target.current, video.duration - .05));
    if (Math.abs(video.currentTime - next) > .05) video.currentTime = next;
    else if (video.readyState >= 2) setReady(true);
  };
  useEffect(() => {
    const timer = window.setTimeout(seek, 90);
    return () => window.clearTimeout(timer);
  }, [time]);
  useLayoutEffect(() => {
    const video = ref.current!;
    return () => { video.removeAttribute("src"); video.load(); };
  }, [source]);
  return <div className="video-seek-frame" data-frame-ready={ready} data-frame-failed={failed}>
    <video ref={ref} src={source} muted playsInline preload="metadata" aria-hidden="true"
      onLoadedMetadata={seek} onLoadedData={() => { if (!ref.current?.seeking) setReady(true); }}
      onSeeked={() => { setReady(true); seek(); }} onError={() => setFailed(true)} />
    {!ready && <span>{failed ? "画面暂不可用" : "正在预览"}</span>}
  </div>;
}

export function VideoTimeline({ source, duration, position, scrub, disabled, buffered, onScrub, onSeek }: VideoTimelineProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const actions = useRef({ onScrub, onSeek });
  actions.current = { onScrub, onSeek };
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current!;
    // compat maps JSX onChange to input. Native change is the actual release,
    // so inspecting frames does not seek the main player until the gesture ends.
    const commit = () => {
      actions.current.onSeek(Number(input.value));
      actions.current.onScrub(null);
      setHover(null);
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  const value = scrub ?? Math.min(position, duration);
  const preview = scrub ?? hover;
  const progress = duration > 0 ? Math.max(0, Math.min(100, value / duration * 100)) : 0;
  const previewProgress = duration > 0 && preview !== null ? preview / duration * 100 : 0;
  return <div className="video-timeline" data-scrubbing={scrub !== null}
    onPointerLeave={() => setHover(null)}>
    <div className="video-timeline-buffer" aria-hidden="true">
      {duration > 0 && buffered.map(([start, end]) => <span key={start}
        style={{ left: `${start / duration * 100}%`, width: `${Math.min(duration - start, end - start) / duration * 100}%` }} />)}
    </div>
    {preview !== null && !disabled && <div className="video-seek-preview" aria-hidden="true"
      style={{ "--preview-position": `${previewProgress}%` }}>
      {source && <SeekFrame source={source} time={preview} />}
      <span className="video-seek-time">{formatDuration(preview)}</span>
    </div>}
    <input ref={inputRef} className="video-viewer-seek" type="range" min={0} max={duration || 1} step={0.1} value={value}
      style={{ "--video-progress": `${progress}%` }}
      aria-label="播放进度" aria-valuetext={`${formatDuration(value)} / ${formatDuration(duration)}`}
      disabled={disabled}
      onPointerMove={event => {
        if (event.pointerType !== "mouse") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        setHover(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration);
      }}
      onInput={event => onScrub(Number(event.currentTarget.value))}
      onPointerCancel={() => { onScrub(null); setHover(null); }}
      onBlur={() => { onScrub(null); setHover(null); }} />
  </div>;
}
