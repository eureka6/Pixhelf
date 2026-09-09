import { useEffect, useRef, useState } from "preact/hooks";
import logo from "./assets/pixhelf-mark.svg?inline";
import setupArtwork from "./assets/setup-account.svg?inline";
import { authenticate, authentication, AuthRequestError } from "./auth";
import { ChevronRight, LoaderCircle } from "./icons";
import { VersionLink } from "./VersionLink";

export function AuthPage({ setup = false }: { setup?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [visible, setVisible] = useState(false);
  const busy = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mode = setup ? "setup" : "login";
  const expired = !setup && new URLSearchParams(window.location.search).has("expired");
  const accountChanged = !setup && new URLSearchParams(window.location.search).has("accountChanged");
  const actionLabel = setup ? "完成初始化" : "登录";
  const pendingLabel = setup ? "正在保存设置…" : "正在登录…";

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const submit = async (form: HTMLFormElement) => {
    if (busy.current || remaining > 0) return;
    setError("");
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (setup && Array.from(password).length < 15) {
      setError("密码至少需要 15 个字符");
      passwordRef.current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await authenticate(mode, String(data.get("username") ?? "").trim(), password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试");
      if (reason instanceof AuthRequestError) {
        if (reason.status === 429) setRemaining(Math.max(1, reason.retryAfter));
        if (!setup && reason.status === 401 && passwordRef.current) {
          passwordRef.current.value = "";
          passwordRef.current.focus();
        }
      }
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <main className="login-page" data-mode={mode}>
      <div className="auth-layout">
        {setup && <div className="auth-brand"><img src={logo} width="36" height="36" alt="" /><span>Pixhelf</span></div>}
        <section className="auth-shell" aria-labelledby={`${mode}-title`}>
          {setup ? (
            <aside className="auth-setup-art" aria-hidden="true"><img src={setupArtwork} width="320" height="320" alt="" /></aside>
          ) : (
            <aside className="auth-story" aria-hidden="true">
              <div className="auth-brand"><img src={logo} width="40" height="40" alt="" /><span>Pixhelf</span></div>
              <div className="auth-art">
                <div className="auth-photo"><i /></div>
                <div className="auth-photo"><i /></div>
                <div className="auth-photo"><i /></div>
              </div>
              <h2 className="auth-story-caption">一隅光影，<br />满架时光。</h2>
            </aside>
          )}
          <div className="login-card">
            {!setup && <div className="auth-mobile-brand"><img src={logo} width="36" height="36" alt="" /><span>Pixhelf</span></div>}
            <header className="auth-form-header">
              <p className="auth-eyebrow">{setup ? "首次设置" : "欢迎回来"}</p>
              <h1 id={`${mode}-title`}>{setup ? "创建管理员" : "登录 Pixhelf"}</h1>
            </header>
            {expired && <p className="login-notice" role="status">登录已过期，请重新登录</p>}
            {accountChanged && <p className="login-notice" role="status">账号信息已更新，请使用更新后的账号登录</p>}

            <form onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }} onInput={() => { if (error) setError(""); }} aria-busy={pending}>
              <div className="login-field">
                <label className="login-label" htmlFor={`${mode}-username`}>用户名</label>
                <input id={`${mode}-username`} name="username" defaultValue={setup ? authentication.username ?? "admin" : undefined} placeholder="输入用户名" autoComplete="username" autoCapitalize="none" spellcheck={false} maxLength={128} required readOnly={pending} />
              </div>
              <div className="login-field">
                <label className="login-label" htmlFor={`${mode}-password`}>{setup ? "设置密码" : "密码"}</label>
                <div className="login-password-field">
                  <input ref={passwordRef} id={`${mode}-password`} name="password" type={visible ? "text" : "password"} placeholder={setup ? "设置一个长密码" : "输入密码"} autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 15 : undefined} maxLength={1024} required readOnly={pending} aria-describedby={[setup && "setup-password-help", error && `${mode}-error`].filter(Boolean).join(" ") || undefined} />
                  <button className="login-show-password" type="button" aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? "隐藏" : "显示"}</button>
                </div>
                {setup && <p className="auth-hint" id="setup-password-help">至少 15 个字符</p>}
              </div>
              {error && <p id={`${mode}-error`} className="login-error" role="alert">{error}</p>}
              <button className="login-submit" type="submit" disabled={pending || remaining > 0}>
                {pending && <LoaderCircle className="spin" size={18} />}
                {remaining > 0 ? `${remaining} 秒后重试` : pending ? pendingLabel : actionLabel}
                {!pending && remaining <= 0 && <ChevronRight size={18} />}
              </button>
            </form>
            {!setup && authentication.guest && <a className="login-guest-link" href="/">以访客身份浏览<ChevronRight size={16} /></a>}
            {!setup && <footer className="login-footer"><span title={window.location.origin}>{window.location.host}</span><VersionLink className="auth-version" /></footer>}
          </div>
        </section>
        {setup && <footer className="auth-footer"><VersionLink className="auth-version" /></footer>}
      </div>
    </main>
  );
}
