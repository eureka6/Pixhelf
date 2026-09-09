import { useEffect, useRef, useState } from "preact/hooks";
import { Cloud, LoaderCircle } from "./icons";
import { disconnectStorage, getStorageConfig, saveStorageConfig, testStorageConfig } from "./storage";
import type { StorageConfig, StorageInput } from "./storage";

export function StorageSettings({ onPendingChange, onSaved }: { onPendingChange: (pending: boolean) => void; onSaved: () => void }) {
  const [saved, setSaved] = useState<StorageConfig | null>(null);
  const [input, setInput] = useState<StorageInput>({ name: "OpenList", url: "", rootPath: "/", authMode: "password", username: "", secret: "" });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [visible, setVisible] = useState(false);
  const [retry, setRetry] = useState(0);
  const busy = useRef(false);

  const accept = (config: StorageConfig) => {
    setSaved(config);
    setInput({ name: config.name, url: config.url, rootPath: config.rootPath, authMode: config.authMode, username: config.username, secret: "" });
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getStorageConfig(controller.signal).then(accept).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取设置"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  const update = (value: Partial<StorageInput>) => { setInput(current => ({ ...current, ...value })); setError(""); setMessage(""); };
  const run = async (action: "test" | "save" | "disconnect") => {
    if (busy.current) return;
    busy.current = true; setPending(action); onPendingChange(true); setError(""); setMessage("");
    try {
      if (action === "disconnect") {
        await disconnectStorage();
        accept(await getStorageConfig());
        setMessage("已断开连接"); onSaved();
      } else if (action === "test") {
        await testStorageConfig(input); setMessage("连接成功，可以访问起始目录");
      } else {
        accept(await saveStorageConfig(input)); setMessage("连接已保存，可从侧栏进入外部存储"); onSaved();
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    finally { busy.current = false; setPending(""); onPendingChange(false); }
  };

  if (loading) return <p className="settings-loading" role="status"><LoaderCircle size={18} className="spin" />正在读取连接设置…</p>;
  return <>
    <h3 id="storage-settings-title">外部存储</h3>
    <p className="settings-description">连接 OpenList，在 Pixhelf 中浏览远程文件与图片。</p>
    {saved && <p className="storage-connection-label"><Cloud size={16} />{saved.configured ? `已保存 · ${saved.name}` : "尚未连接"}</p>}
    {!saved ? <><p className="login-error" role="alert">{error}</p><button type="button" className="settings-secondary" onClick={() => setRetry(value => value + 1)}>重新读取</button></> : (
      <form className="storage-settings-form" aria-busy={Boolean(pending)} onSubmit={event => { event.preventDefault(); void run("save"); }}>
        <fieldset disabled={Boolean(pending)}>
          <div className="settings-field"><label htmlFor="storage-name">连接名称</label><input id="storage-name" value={input.name} maxLength={128} required onInput={event => update({ name: event.currentTarget.value })} /></div>
          <div className="settings-field"><label htmlFor="storage-url">OpenList 地址</label><input id="storage-url" type="url" placeholder="https://files.example.com" value={input.url} autoComplete="off" required onInput={event => update({ url: event.currentTarget.value })} /></div>
          <div className="settings-field"><label htmlFor="storage-auth-mode">认证方式</label><select id="storage-auth-mode" value={input.authMode} onChange={event => { update({ authMode: event.currentTarget.value as StorageInput["authMode"], secret: "", username: "" }); setVisible(false); }}><option value="password">用户名与密码</option><option value="token">认证令牌</option></select></div>
          {input.authMode === "password" && <div className="settings-field"><label htmlFor="storage-username">OpenList 用户名</label><input id="storage-username" value={input.username} autoComplete="off" maxLength={128} required onInput={event => update({ username: event.currentTarget.value })} /></div>}
          <div className="settings-field"><label htmlFor="storage-secret">{input.authMode === "password" ? "OpenList 密码" : "认证令牌"}</label><div className="settings-password-field"><input id="storage-secret" type={visible ? "text" : "password"} value={input.secret} autoComplete="new-password" placeholder={saved.hasSecret && input.authMode === saved.authMode ? "已保存，留空保持不变" : input.authMode === "token" ? "填写令牌，无需 Bearer 前缀" : "输入 OpenList 密码"} maxLength={4096} onInput={event => update({ secret: event.currentTarget.value })} /><button type="button" className="login-show-password" aria-label={visible ? "隐藏认证信息" : "显示认证信息"} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? "隐藏" : "显示"}</button></div></div>
          <div className="settings-field"><label htmlFor="storage-root">起始目录</label><input id="storage-root" value={input.rootPath} placeholder="/" required onInput={event => update({ rootPath: event.currentTarget.value })} /><p className="auth-hint">相对于该 OpenList 账号可访问的目录，例如 /照片。</p></div>
          <div className="settings-field"><label htmlFor="storage-directory-password">目录访问密码（可选）</label><input id="storage-directory-password" type="password" value={input.directoryPassword ?? ""} autoComplete="new-password" placeholder={saved.hasDirectoryPassword ? "已保存；输入后清空可移除" : "仅受密码保护的目录需要填写"} onInput={event => update({ directoryPassword: event.currentTarget.value })} /></div>
        </fieldset>
        {error && <p className="login-error" role="alert">{error}</p>}
        {message && <p className="login-notice" role="status">{message}</p>}
        <div className="settings-form-actions"><button type="button" className="settings-secondary" disabled={Boolean(pending)} onClick={event => { if (event.currentTarget.form?.reportValidity()) void run("test"); }}>{pending === "test" ? "正在测试…" : "测试连接"}</button><button type="submit" className="login-submit" disabled={Boolean(pending)}>{pending === "save" ? "正在保存…" : "保存连接"}</button></div>
        {saved.configured && <button className="settings-disconnect" type="button" disabled={Boolean(pending)} onClick={() => { void run("disconnect"); }}>{pending === "disconnect" ? "正在断开…" : "断开此连接"}</button>}
      </form>
    )}
  </>;
}
