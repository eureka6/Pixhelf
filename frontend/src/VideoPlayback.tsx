import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { checkAuthentication } from "./auth";
import { CARD_MENU_EVENT, useCardInteraction } from "./cardInteraction";
import { Check, Download, Expand, LoaderCircle, Pause, PictureInPicture, Play, RefreshCw, Shrink, Sun, Volume2, VolumeX } from "./icons";
import { stopMediaPreview } from "./MediaPreview";
import { MediaPlayer, type VideoPlayer } from "./mediaPlayer";
import { NativeMediaPlayer } from "./nativeMediaPlayer";
import { ToolbarPopover } from "./ToolbarPopover";
import { useVideoGestures } from "./useVideoGestures";
import { VideoTimeline } from "./VideoTimeline";
import { VideoTimeJump } from "./VideoTimeJump";

export type PlaybackState = "preparing" | "loading" | "ready" | "failed";
type VideoPlaybackProps = {
  source: string; name: string; poster?: string; durationHint?: number;
  prepared?: boolean; downloadSource?: string; autoPlay?: boolean;
  playerRef?: { current: VideoPlayer | null };
  onState?: (state: PlaybackState) => void;
  header?: ComponentChildren;
  previousControl?: ComponentChildren;
  nextControl?: ComponentChildren;
  options?: ComponentChildren;
  contextMenu?: ComponentChildren;
  keepControlsVisible?: boolean;
};

const initialPlayback = {
  state: "loading" as PlaybackState,
  failure: "", playing: false, started: false, ended: false, blocked: false,
  position: 0, scrub: null as number | null, duration: 0,
  volume: 1, rate: 1, audioUnsupported: false,
  buffered: [] as [number, number][],
};
const CONTROLS_IDLE_MS = 2600;

export function VideoPlayback({ source, name, poster, durationHint = 0, prepared = false,
  downloadSource = source, autoPlay = false, playerRef, onState, header, previousControl, nextControl, options, contextMenu, keepControlsVisible = false,
}: VideoPlaybackProps) {
  const ownRef = useRef<VideoPlayer | null>(null);
  const videoRef = playerRef ?? ownRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  useCardInteraction(stageRef, Boolean(contextMenu), false);
  const idleTimer = useRef(0);
  const feedbackTimer = useRef(0);
  const pointerFocus = useRef(false);
  const hoveringControls = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [keyboardControls, setKeyboardControls] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [rateMenu, setRateMenu] = useState(false);
  const [timeMenu, setTimeMenu] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [retry, setRetry] = useState({ source, attempt: 0 });
  const attempt = retry.source === source ? retry.attempt : 0;
  const [playback, update] = useReducer(
    (current: typeof initialPlayback, patch: Partial<typeof initialPlayback>) => ({ ...current, ...patch }),
    initialPlayback,
  );
  const { state, failure, playing, started, ended, blocked, position, scrub, volume, rate, audioUnsupported } = playback;
  const duration = playback.duration || durationHint;
  const canHide = useRef(false);
  canHide.current = playing && state === "ready" && scrub === null && !keepControlsVisible && !keyboardControls && !rateMenu && !timeMenu;

  const revealControls = () => {
    setControlsVisible(true);
    window.clearTimeout(idleTimer.current);
    if (canHide.current && !hoveringControls.current) idleTimer.current = window.setTimeout(() => {
      if (canHide.current && !hoveringControls.current) setControlsVisible(false);
    }, CONTROLS_IDLE_MS);
  };

  useLayoutEffect(() => { onState?.(state); }, [state, onState]);
  useLayoutEffect(() => {
    update(initialPlayback);
    setControlsVisible(true);
    setRateMenu(false);
    setTimeMenu(false);
    setFeedback(null);
    hoveringControls.current = false;
    const url = new URL(source, document.baseURI);
    if (attempt) url.searchParams.set("retry", String(attempt));
    const Player = prepared ? NativeMediaPlayer : MediaPlayer;
    const video = new Player(containerRef.current!, url.href, name, false, {
      state(next) {
        update({ state: next === "preparing" || next === "loading" || next === "failed" ? next : "ready" });
        if (next === "playing") { stopMediaPreview(); update({ playing: true, ended: false, blocked: false }); }
        else if (next === "paused" || next === "ended" || next === "failed") update({ playing: false, ended: next === "ended" });
      },
      loaded(duration) { update({ duration }); },
      audioUnsupported(audioUnsupported) { update({ audioUnsupported }); },
      autoplayBlocked() { update({ blocked: true, playing: false }); },
      frame() { update({ started: true }); },
      time(position) { update({ position }); },
      buffered(buffered) { update({ buffered }); },
      error(error) {
        update({ failure: prepared || error.message.includes("超时") ? error.message : "暂时无法播放此视频，可能是格式、编码不受支持或文件已损坏。" });
        void checkAuthentication();
      },
    });
    videoRef.current = video;
    // Native playback remembers this intent while the background job finishes.
    if (autoPlay && !document.hidden) video.play();
    return () => {
      video.destroy();
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(feedbackTimer.current);
      if (videoRef.current === video) videoRef.current = null;
    };
  }, [source, name, attempt, videoRef, prepared, autoPlay]);

  useEffect(() => {
    revealControls();
    return () => window.clearTimeout(idleTimer.current);
  }, [playing, state, scrub, keepControlsVisible, keyboardControls, rateMenu, timeMenu]);

  useEffect(() => {
    const pauseHidden = () => {
      const floatingVideo = document.pictureInPictureElement;
      if (document.hidden && (!floatingVideo || floatingVideo !== containerRef.current?.querySelector("video"))) videoRef.current?.pause();
    };
    const onFullscreen = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("visibilitychange", pauseHidden);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("visibilitychange", pauseHidden);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [videoRef]);

  useEffect(() => {
    const video = containerRef.current?.querySelector("video");
    if (!video) return;
    const changed = () => setPictureInPicture(document.pictureInPictureElement === video);
    video.addEventListener("enterpictureinpicture", changed);
    video.addEventListener("leavepictureinpicture", changed);
    changed();
    return () => {
      video.removeEventListener("enterpictureinpicture", changed);
      video.removeEventListener("leavepictureinpicture", changed);
    };
  }, [source, prepared, attempt]);

  useLayoutEffect(() => {
    if (rateMenu) stageRef.current?.querySelector<HTMLElement>('.video-rate-menu [aria-checked="true"]')?.focus({ preventScroll: true });
  }, [rateMenu]);

  const showFeedback = (message: string) => {
    window.clearTimeout(feedbackTimer.current);
    setFeedback(message);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1000);
  };
  const skip = (seconds: number) => {
    videoRef.current?.seek(position + seconds);
    showFeedback(`${seconds > 0 ? "快进" : "后退"} ${Math.abs(seconds)} 秒`);
    revealControls();
  };

  const togglePlayback = () => {
    if (state === "failed") return;
    if (playing) videoRef.current?.pause();
    else {
      if (ended) videoRef.current?.seek(0);
      update({ blocked: false, ended: false });
      videoRef.current?.play();
    }
    revealControls();
  };
  const changeVolume = (volume: number) => { update({ volume }); videoRef.current?.volume(volume); };
  const toggleFullscreen = () => {
    const request = document.fullscreenElement ? document.exitFullscreen() : stageRef.current?.requestFullscreen?.();
    void request?.catch(() => {});
    revealControls();
  };
  const togglePictureInPicture = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await containerRef.current?.querySelector("video")?.requestPictureInPicture();
    } catch { showFeedback("暂时无法进入画中画"); }
  };
  const closeRateMenu = () => {
    setRateMenu(false);
    stageRef.current?.querySelector<HTMLElement>(".video-rate-menu > button")?.focus({ preventScroll: true });
  };
  const seekDisabled = (!prepared && !started) || playback.duration <= 0 || state === "failed";
  const gestures = useVideoGestures({ pictureRef, playerRef: videoRef, source, attempt,
    disabled: state === "failed" || keepControlsVisible || rateMenu || timeMenu || pictureInPicture,
    seekDisabled, playing, position, volume, rate, onVolume: changeVolume, onDoubleClick: toggleFullscreen,
    onTap(touch) {
      if (touch && playing) {
        if (controlsVisible) setControlsVisible(false);
        else revealControls();
      } else togglePlayback();
    },
    onLongPress: contextMenu ? point => stageRef.current?.dispatchEvent(new CustomEvent(CARD_MENU_EVENT, {
      detail: { touch: true, point },
    })) : undefined,
  });

  return (
    <div ref={stageRef} className="video-viewer-stage" data-video-state={state} data-playing={playing}
      data-controls-visible={controlsVisible || !canHide.current}
      tabIndex={0} role="group" aria-label="视频播放器"
      onPointerMove={event => {
        if (event.pointerType !== "mouse") return;
        hoveringControls.current = Boolean((event.target as Element).closest(".video-controls-region"));
        revealControls();
      }}
      onPointerLeave={event => {
        if (event.pointerType !== "mouse") return;
        hoveringControls.current = false;
        revealControls();
      }}
      onPointerDown={() => { pointerFocus.current = true; setKeyboardControls(false); }}
      onFocusIn={event => {
        if (!pointerFocus.current && event.target !== event.currentTarget && (event.target as HTMLElement).matches(":focus-visible")) {
          setKeyboardControls(true);
          revealControls();
        }
      }}
      onFocusOut={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setKeyboardControls(false);
      }}
      onKeyDown={event => {
        pointerFocus.current = false;
        if (event.key === "Escape" && rateMenu) {
          event.preventDefault(); event.stopPropagation(); closeRateMenu(); return;
        }
        if (event.key === "Escape" && timeMenu) {
          event.preventDefault(); event.stopPropagation(); setTimeMenu(false);
          stageRef.current?.querySelector<HTMLElement>(".video-time-toggle")?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Tab") { setKeyboardControls(true); revealControls(); }
        if (event.altKey || event.ctrlKey || event.metaKey || keepControlsVisible || rateMenu || timeMenu
          || (event.target as HTMLElement).matches("input, select, textarea") || state === "failed") return;
        if (event.key === " " && (event.target as HTMLElement).closest("button, a")) return;
        if (event.key === " " || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); skip(event.key === "ArrowRight" ? 5 : -5);
        } else if (event.key.toLowerCase() === "m") { event.preventDefault(); changeVolume(volume ? 0 : 1); revealControls(); }
        else if (event.key.toLowerCase() === "f") { event.preventDefault(); toggleFullscreen(); }
        if (event.defaultPrevented) event.stopPropagation();
      }}>
      <div ref={pictureRef} className="video-viewer-picture">
        <div ref={containerRef} className="video-viewer-player" aria-label={name} />
        {!started && poster && <img className="video-viewer-poster" src={poster} alt="" />}
        <div className="video-viewer-brightness" style={{ opacity: (1 - gestures.brightness) * .85 }} aria-hidden="true" />
        <div className="video-gesture-zone" data-side="left" aria-hidden="true" />
        <div className="video-gesture-zone" data-side="right" aria-hidden="true" />
        {!playing && state === "ready" && !pictureInPicture && <div className="video-viewer-resume">
          <button type="button" className="video-viewer-resume-button" aria-label={ended ? "重新播放" : blocked ? "开始播放" : "继续播放"}
            onClick={event => { if (event.detail === 0) togglePlayback(); }}>
            {ended ? <RefreshCw size={24} /> : <Play size={26} fill="currentColor" strokeWidth={0} />}
          </button>
          {blocked && <span>轻点播放</span>}
        </div>}
      </div>
      {header}
      {contextMenu}
      {feedback && <div className="video-feedback" role="status">{feedback}</div>}
      {gestures.feedback && <div className="video-gesture-feedback" data-side={gestures.feedback.side}
        data-kind={gestures.feedback.kind} role="status" aria-label={gestures.feedback.label}>
        {gestures.feedback.level === undefined ? <span>{gestures.feedback.label}</span> : <>
          <span className="video-gesture-icon">{gestures.feedback.kind === "brightness" ? <Sun size={22} strokeWidth={1.6} />
            : gestures.feedback.level ? <Volume2 size={22} strokeWidth={1.6} /> : <VolumeX size={22} strokeWidth={1.6} />}</span>
          <span className="video-gesture-value">{Math.round(gestures.feedback.level * 100)}<small>%</small></span>
          <span className="video-gesture-meter" role="progressbar" aria-label={gestures.feedback.kind === "brightness" ? "亮度" : "音量"}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(gestures.feedback.level * 100)}>
            <span style={{ height: `${gestures.feedback.level * 100}%` }} />
          </span>
          <span className="video-gesture-caption">{gestures.feedback.kind === "brightness" ? "亮度" : "音量"}</span>
        </>}
      </div>}
      {pictureInPicture && <div className="video-pip-notice"><PictureInPicture size={42} strokeWidth={1.2} /><span>正在画中画中播放</span>
        <button type="button" onClick={() => { void togglePictureInPicture(); }}>返回播放器</button></div>}
      <div className="video-viewer-playback video-controls-region" role="group" aria-label="视频播放控制" tabIndex={0}>
        <div className="video-control-deck">
          <VideoTimeline key={source} source={prepared && state === "ready" ? source : undefined} duration={duration}
            position={position} scrub={scrub} disabled={seekDisabled} buffered={playback.buffered}
            onScrub={scrub => update({ scrub })} onSeek={seconds => videoRef.current?.seek(seconds)} />
          <div className="video-viewer-toolbar">
            <div className="video-viewer-transport video-viewer-navigation">
              {previousControl}
              <button type="button" className="video-control video-play-toggle" aria-label={playing ? "暂停视频" : "播放视频"}
                data-tooltip={playing ? "暂停 · 空格" : "播放 · 空格"}
                disabled={state === "failed" || state === "preparing" || (state === "loading" && !started)} onClick={togglePlayback}>
                {playing ? <Pause size={21} strokeWidth={2.4} /> : <Play size={22} fill="currentColor" strokeWidth={0} />}
              </button>
              {nextControl}
            </div>
            <VideoTimeJump position={scrub ?? position} duration={duration} disabled={seekDisabled}
              open={timeMenu} onOpenChange={setTimeMenu} onSeek={seconds => videoRef.current?.seek(seconds)} />
            <div className="video-viewer-options">
              {options}
              <ToolbarPopover id="video-rate-menu" open={rateMenu} onOpenChange={setRateMenu}
                icon={<span>倍速</span>} openLabel="倍速" closeLabel="收起倍速" panelLabel="播放速度选项"
                rootClassName="video-rate-menu" triggerClassName="video-control video-rate-toggle" panelClassName="video-rate-panel">
                <p>播放速度<span>{rate === 2 ? "2.0" : rate}×</span></p>
                <div role="menu" aria-label="选择播放速度" onKeyDown={event => {
                  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
                  buttons[next]?.focus();
                }}>
                  {[.5, .75, 1, 1.25, 1.5, 2].map(value => <button key={value} type="button" role="menuitemradio" aria-checked={rate === value}
                    onClick={() => { update({ rate: value }); videoRef.current?.rate(value); closeRateMenu(); }}>
                    <span>{value === 2 ? "2.0" : value}×</span>{value === 1 && <small>正常</small>}{rate === value && <Check size={16} />}
                  </button>)}
                </div>
              </ToolbarPopover>
              <div className="video-viewer-sound">
                <button type="button" className="video-control video-volume-toggle" aria-label={volume ? "静音" : "取消静音"} data-tooltip={volume ? "静音 · M" : "取消静音 · M"} onClick={() => changeVolume(volume ? 0 : 1)}>
                  {volume ? <Volume2 size={21} strokeWidth={1.7} /> : <VolumeX size={21} strokeWidth={1.7} />}
                </button>
                <input className="video-viewer-volume" type="range" min={0} max={1} step={0.05} value={volume} aria-label="音量"
                  onInput={event => changeVolume(Number(event.currentTarget.value))} />
              </div>
              {prepared && document.pictureInPictureEnabled && <button type="button" className="video-control video-pip-toggle" aria-label={pictureInPicture ? "退出画中画" : "画中画"}
                data-tooltip={pictureInPicture ? "退出画中画" : "画中画"} disabled={!started} onClick={() => { void togglePictureInPicture(); }}><PictureInPicture size={23} strokeWidth={1.6} /></button>}
              <button type="button" className="video-control video-fullscreen-toggle" aria-label="切换全屏" data-tooltip={fullscreen ? "退出全屏 · F" : "全屏 · F"} onClick={toggleFullscreen}>
                {fullscreen ? <Shrink size={22} strokeWidth={1.7} /> : <Expand size={22} strokeWidth={1.7} />}
              </button>
            </div>
          </div>
        </div>
        {audioUnsupported && <p className="video-viewer-audio-note" role="status">此音轨暂不支持，视频将静音播放。</p>}
      </div>
      {(state === "loading" || state === "preparing") && <div className="video-viewer-loading" role="status">
        <LoaderCircle size={23} className="spin" />
        <span>{state === "preparing" ? "正在准备视频" : "正在加载"}{state === "preparing" && <small>{autoPlay ? "准备好后自动播放" : "准备好后即可播放"}</small>}</span>
      </div>}
      {state === "failed" && <div className="video-viewer-error" role="alert">
        <span className="video-viewer-error-icon"><Play size={22} /></span>
        <strong>暂时无法播放</strong><p>{failure}</p>
        <div><button type="button" onClick={() => setRetry({ source, attempt: attempt + 1 })}><RefreshCw size={15} />重试</button>
          <a href={downloadSource} download={name}><Download size={15} />下载原视频</a></div>
      </div>}
    </div>
  );
}
