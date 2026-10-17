// Background tabs must not compete with the gallery for a slow connection.
// Each request owns a controller, so resuming can never overlap a stale poll.
export function startVisiblePolling(request: (signal: AbortSignal) => Promise<number>, initialDelay: number): () => void {
  let timer = 0;
  let active: AbortController | undefined;
  let suspended = false;
  let stopped = false;
  const available = () => !stopped && !suspended && document.visibilityState === "visible" && navigator.onLine !== false;
  const cancel = () => {
    window.clearTimeout(timer);
    active?.abort();
    active = undefined;
  };
  const poll = async () => {
    if (!available()) return;
    const controller = active = new AbortController();
    let delay = 5000;
    try { delay = await request(controller.signal); }
    catch { /* A later poll retries transient network failures. */ }
    finally {
      if (active === controller) {
        active = undefined;
        if (available()) timer = window.setTimeout(poll, delay);
      }
    }
  };
  const resume = () => {
    cancel();
    if (available()) timer = window.setTimeout(poll, 0);
  };
  const hide = () => { suspended = true; cancel(); };
  const show = () => { if (suspended) { suspended = false; resume(); } };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("offline", cancel);
  window.addEventListener("online", resume);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  if (available()) timer = window.setTimeout(poll, initialDelay);
  return () => {
    stopped = true;
    cancel();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("offline", cancel);
    window.removeEventListener("online", resume);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
  };
}
