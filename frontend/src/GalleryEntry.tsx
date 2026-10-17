import type { ComponentType } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import { getGallery } from "./api";
import { LoaderCircle } from "./icons";

function galleryIsInitializing(): boolean {
  try {
    return JSON.parse(document.getElementById("pixhelf-bootstrap")?.textContent ?? "null")?.summary?.initializing === true;
  } catch { return false; }
}

/** Keep gallery code, styles and management requests behind authentication and the first scan. */
export function GalleryEntry() {
  const [Gallery, setGallery] = useState<ComponentType | null>(null);
  const [initializing, setInitializing] = useState(galleryIsInitializing);
  const [error, setError] = useState(false);

  useLayoutEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const open = async () => {
      try {
        if (galleryIsInitializing()) {
          const summary = await getGallery(controller.signal);
          if (controller.signal.aborted) return;
          if (summary.initializing) {
            setError(false);
            timer = window.setTimeout(open, 1000);
            return;
          }
          // The pending bootstrap contains no images. Fetch fresh data after mounting.
          document.getElementById("pixhelf-bootstrap")?.remove();
        }
        setInitializing(false);
        const { GalleryApp } = await import("./GalleryApp");
        if (!controller.signal.aborted) setGallery(() => GalleryApp);
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          // Failed module imports can stay cached until a document reload.
          if (galleryIsInitializing()) timer = window.setTimeout(open, 3000);
        }
      }
    };
    setError(false);
    void open();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);

  if (Gallery) return <Gallery />;
  const hint = error
    ? (initializing ? "正在自动重试，请检查网络连接。" : "请重新加载页面后重试。")
    : initializing ? "完成后将自动显示照片。" : "正在载入照片，请稍候。";
  return <main className="startup-page">
    <div role="status" aria-live="polite">
      {!error && <LoaderCircle className="startup-spinner" size={26} />}
      <h1>{error ? "暂时无法打开图库" : initializing ? "正在准备图库…" : "正在加载图库…"}</h1>
      <p>{hint}</p>
    </div>
    {error && <button type="button" onClick={() => window.location.reload()}>重新加载</button>}
  </main>;
}
