import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { VideoPlayer } from "./mediaPlayer";

type Side = "left" | "right";
type Feedback = { label: string; side: Side; level?: number; kind?: "volume" | "brightness" };
type GestureOptions = {
  pictureRef: RefObject<HTMLDivElement>;
  playerRef: RefObject<VideoPlayer>;
  source: string;
  attempt: number;
  disabled: boolean;
  seekDisabled: boolean;
  playing: boolean;
  position: number;
  volume: number;
  rate: number;
  onTap: (touch: boolean) => void;
  onDoubleClick: () => void;
  onVolume: (volume: number) => void;
  onLongPress?: (point: { x: number; y: number }) => void;
};
type Contact = {
  id: number; type: string; x: number; y: number; time: number; side: Side;
  double: boolean; adjusts: boolean; height: number; volume: number; brightness: number;
  mode: "pending" | "cancelled" | "volume" | "brightness" | "hold";
};
type Tap = { x: number; y: number; time: number; type: string; side: Side };
const tapDelay = (type: string) => type === "mouse" ? 500 : 320;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function useVideoGestures(options: GestureOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [brightness, setBrightness] = useState(1);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const cancelRef = useRef<() => void>(() => {});
  const { pictureRef, source, attempt, disabled } = options;

  useLayoutEffect(() => {
    const picture = pictureRef.current;
    if (!picture) return;
    let contact: Contact | null = null;
    let tap: Tap | null = null;
    let tapTimer = 0, pressTimer = 0, feedbackTimer = 0, rewindTimer = 0;
    let brightnessValue = 1;
    let hold: { player: VideoPlayer; rate: number; playing: boolean; side: Side } | null = null;
    setBrightness(1);
    setFeedback(null);

    const clearTap = () => { window.clearTimeout(tapTimer); tap = null; };
    const show = (value: Feedback, persist = false) => {
      window.clearTimeout(feedbackTimer);
      setFeedback(value);
      if (!persist) feedbackTimer = window.setTimeout(() => setFeedback(null), 900);
    };
    const stopHold = (resume: boolean) => {
      window.clearInterval(rewindTimer);
      if (!hold) return;
      const previous = hold;
      hold = null;
      previous.player.rate(previous.rate);
      if (!resume || !previous.playing) previous.player.pause();
      else if (previous.side === "left") previous.player.play();
    };
    const release = () => {
      const id = contact?.id;
      contact = null;
      if (id !== undefined && picture.hasPointerCapture(id)) picture.releasePointerCapture(id);
    };
    const cancel = (resume = true) => {
      clearTap();
      window.clearTimeout(pressTimer);
      window.clearTimeout(feedbackTimer);
      stopHold(resume);
      release();
      setFeedback(null);
    };
    cancelRef.current = () => cancel(false);

    const startHold = (gesture: Contact) => {
      const current = latest.current;
      const player = current.playerRef.current;
      if (contact !== gesture || current.disabled || current.seekDisabled || !player) return;
      gesture.mode = "hold";
      hold = { player, rate: current.rate, playing: current.playing, side: gesture.side };
      if (gesture.side === "right") {
        player.rate(2);
        if (!current.playing) player.play();
        show({ side: "right", label: "2× 快进" }, true);
      } else {
        player.pause();
        const start = performance.now();
        const position = current.position;
        const rewind = () => player.seek(Math.max(0, position - (performance.now() - start) / 1000 * 2));
        rewindTimer = window.setInterval(rewind, 250);
        show({ side: "left", label: "2× 后退" }, true);
      }
    };

    const down = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !picture.contains(event.target)) { cancel(); return; }
      if (!event.isPrimary || event.button !== 0 || latest.current.disabled) { cancel(); return; }
      const bounds = picture.getBoundingClientRect();
      const side: Side = event.clientX < bounds.left + bounds.width / 2 ? "left" : "right";
      const now = performance.now();
      const double = Boolean(tap && tap.type === event.pointerType && (event.pointerType === "mouse" || tap.side === side)
        && now - tap.time <= tapDelay(event.pointerType)
        && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < (event.pointerType === "mouse" ? 24 : 48));
      // Cancel on the second DOWN, so keeping that contact pressed can never fire a single tap.
      clearTap();
      window.clearTimeout(pressTimer);
      const gesture: Contact = contact = {
        id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, time: now, side, double,
        adjusts: Boolean((event.target as Element).closest(".video-gesture-zone")), height: bounds.height,
        volume: latest.current.volume, brightness: brightnessValue, mode: "pending",
      };
      picture.setPointerCapture(event.pointerId);
      if (event.pointerType !== "mouse") pressTimer = window.setTimeout(() => {
        if (contact !== gesture || latest.current.disabled) return;
        if (double) startHold(gesture);
        else if (latest.current.onLongPress) {
          gesture.mode = "cancelled";
          // Release capture before opening the menu, so its buttons receive the next contact.
          release();
          latest.current.onLongPress({ x: gesture.x, y: gesture.y });
        }
      }, double ? 250 : 500);
    };
    const move = (event: PointerEvent) => {
      const gesture = contact;
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (gesture.mode === "pending" && Math.hypot(dx, dy) > 10) {
        window.clearTimeout(pressTimer);
        gesture.mode = gesture.type !== "mouse" && gesture.adjusts && Math.abs(dy) > Math.abs(dx) * 1.2
          ? gesture.side === "left" ? "brightness" : "volume" : "cancelled";
      }
      if (gesture.mode !== "brightness" && gesture.mode !== "volume") return;
      const value = clamp((gesture.mode === "volume" ? gesture.volume : gesture.brightness) - dy / Math.max(1, gesture.height * .6));
      if (gesture.mode === "brightness") {
        brightnessValue = value;
        setBrightness(value);
      } else latest.current.onVolume(value);
      show({ side: gesture.side, kind: gesture.mode, label: `${gesture.mode === "volume" ? "音量" : "亮度"} ${Math.round(value * 100)}%`, level: value }, true);
    };
    const up = (event: PointerEvent) => {
      const gesture = contact;
      if (!gesture || event.pointerId !== gesture.id) return;
      window.clearTimeout(pressTimer);
      release();
      if (gesture.mode === "hold") { stopHold(true); setFeedback(null); return; }
      if (gesture.mode === "volume" || gesture.mode === "brightness") {
        feedbackTimer = window.setTimeout(() => setFeedback(null), 900);
        return;
      }
      if (gesture.mode !== "pending" || latest.current.disabled) return;
      if (gesture.double) {
        if (gesture.type === "mouse") latest.current.onDoubleClick();
        else if (!latest.current.seekDisabled) {
          latest.current.playerRef.current?.seek(latest.current.position + (gesture.side === "left" ? -10 : 10));
          show({ side: gesture.side, label: gesture.side === "left" ? "后退 10 秒" : "快进 10 秒" });
        }
      } else if (gesture.type === "mouse" || performance.now() - gesture.time < 500) {
        tap = { ...gesture, time: performance.now() };
        tapTimer = window.setTimeout(() => {
          tap = null;
          if (!latest.current.disabled) latest.current.onTap(gesture.type !== "mouse");
        }, tapDelay(gesture.type));
      }
    };
    const pointerCancelled = (event: PointerEvent) => { if (contact?.id === event.pointerId) cancel(); };
    const click = (event: MouseEvent) => {
      // Pointer events own activation; compatibility clicks after a drag/hold must do nothing.
      if (event.detail === 0) return;
      event.preventDefault(); event.stopPropagation();
    };
    const doubleClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
    const context = (event: MouseEvent) => { if (contact?.type === "mouse") cancel(); event.preventDefault(); };
    const hidden = () => { if (document.hidden) cancel(false); };
    const blur = () => cancel(false);
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(picture)) cancel(false);
    };
    const key = () => cancel();
    const listeners = new AbortController();
    const { signal } = listeners;
    document.addEventListener("pointerdown", down, { capture: true, signal });
    document.addEventListener("pointermove", move, { capture: true, passive: true, signal });
    document.addEventListener("pointerup", up, { capture: true, signal });
    document.addEventListener("pointercancel", pointerCancelled, { capture: true, signal });
    picture.addEventListener("lostpointercapture", pointerCancelled, { signal });
    picture.addEventListener("click", click, { signal });
    picture.addEventListener("dblclick", doubleClick, { signal });
    picture.addEventListener("contextmenu", context, { signal });
    document.addEventListener("visibilitychange", hidden, { signal });
    document.addEventListener("scroll", scroll, { capture: true, signal });
    document.addEventListener("keydown", key, { capture: true, signal });
    window.addEventListener("blur", blur, { signal });
    return () => {
      listeners.abort();
      clearTap();
      window.clearTimeout(pressTimer);
      window.clearTimeout(feedbackTimer);
      stopHold(false);
      release();
      cancelRef.current = () => {};
    };
  }, [pictureRef, source, attempt]);

  useLayoutEffect(() => { if (disabled) cancelRef.current(); }, [disabled]);
  return { brightness, feedback };
}
