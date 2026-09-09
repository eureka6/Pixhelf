import { useEffect, useRef, useState } from "preact/hooks";
import { getGuestMode, setGuestMode } from "./auth";
import { LoaderCircle, RefreshCw } from "./icons";

export function GuestSettings({ onPendingChange }: { onPendingChange: (pending: boolean) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void getGuestMode(controller.signal).then(value => {
      if (!controller.signal.aborted) setEnabled(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取访客设置，请重试");
    });
    return () => controller.abort();
  }, [attempt]);

  const toggle = async () => {
    if (enabled === null || busy.current) return;
    const next = !enabled;
    busy.current = true;
    setPending(true);
    onPendingChange(true);
    setError("");
    try {
      await setGuestMode(next);
      setEnabled(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存访客设置，请重试");
    } finally {
      busy.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };

  return (
    <div className="guest-settings">
      <h3 id="guest-settings-title">访客模式</h3>
      <p className="settings-description">免登录浏览图库、相册，支持以图搜图。</p>
      {enabled === null ? !error && <p className="settings-loading" role="status"><LoaderCircle className="spin" size={17} />正在读取设置…</p> : (
        <div className="settings-toggle-row">
          <div><strong id="guest-mode-label">免登录浏览</strong><span role="status">{pending ? "正在保存…" : enabled ? "已开启" : "已关闭"}</span></div>
          <button type="button" className="settings-switch" role="switch" aria-labelledby="guest-mode-label" aria-describedby="guest-mode-help"
            aria-checked={enabled} disabled={pending} onClick={() => void toggle()}><span /></button>
        </div>
      )}
      {error && <p className="login-error" role="alert">{error}{enabled === null && <button type="button" className="settings-retry" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />重试</button>}</p>}
      <p className="settings-note" id="guest-mode-help">访客可以查看、搜索和下载图库图片。账号设置与外部存储仅限管理员访问。</p>
    </div>
  );
}
