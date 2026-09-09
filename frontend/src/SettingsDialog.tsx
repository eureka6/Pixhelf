import { useEffect, useRef, useState } from "preact/hooks";
import { authentication, AuthRequestError, updateAccount } from "./auth";
import { Cloud, ExternalLink, Info, KeyRound, LoaderCircle, Settings, UserRound, X } from "./icons";
import { StorageSettings } from "./StorageSettings";
import { GuestSettings } from "./GuestSettings";
import { useModalDialog } from "./useModalDialog";
import logoMark from "./assets/pixhelf-mark.svg?inline";
import { version } from "../package.json";

// Keep settings sections together so future service configuration can use the same dialog.
const SETTINGS_SECTIONS = [
  { id: "account", label: "账号安全", icon: KeyRound, content: AccountSettings },
  { id: "guest", label: "访客模式", icon: UserRound, content: GuestSettings },
  { id: "storage", label: "外部存储", icon: Cloud, content: StorageSettings },
  { id: "about", label: "关于", icon: Info, content: AboutSettings },
] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number]["id"];

export function SettingsDialog({ onClose, initialSection = "account", onStorageSaved }: { onClose: () => void; initialSection?: SettingsSection; onStorageSaved: () => void }) {
  const [activeId, setActiveId] = useState<SettingsSection>(initialSection);
  const [pending, setPending] = useState(false);
  const section = SETTINGS_SECTIONS.find(section => section.id === activeId) ?? SETTINGS_SECTIONS[0];
  const Content = section.content;

  const dialog = useModalDialog(onClose, {
    dismissible: !pending,
    fallbackFocus: () => document.querySelector<HTMLButtonElement>(".gallery-sidebar-toggle"),
  });

  return (
    <dialog {...dialog} className="settings-dialog" aria-labelledby="settings-title">
      <header className="settings-header">
        <h2 id="settings-title"><Settings size={19} />设置</h2>
        <button type="button" className="icon-button" aria-label="关闭设置" disabled={pending} onClick={onClose}><X size={19} /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-current={activeId === id ? "page" : undefined} disabled={pending} onClick={() => setActiveId(id)}><Icon size={17} />{label}</button>
          ))}
        </nav>
        <section key={section.id} className="settings-content" aria-labelledby={`${section.id}-settings-title`}>
          <Content onPendingChange={setPending} onSaved={onStorageSaved} />
        </section>
      </div>
    </dialog>
  );
}

function AboutSettings() {
  const project = "https://github.com/eureka6/Pixhelf";
  return (
    <div className="about-settings">
      <div className="about-identity">
        <img src={logoMark} width="44" height="44" alt="" />
        <div><h3 id="about-settings-title">Pixhelf</h3><span>v{version}</span></div>
      </div>
      <p>浏览相册，查看图片信息，以图搜图。</p>
      <div className="about-links">
        <a href={project} target="_blank" rel="noopener noreferrer">项目主页<ExternalLink size={14} /></a>
        <a href={`${project}#readme`} target="_blank" rel="noopener noreferrer">使用说明<ExternalLink size={14} /></a>
        <a href={`${project}/issues`} target="_blank" rel="noopener noreferrer">问题反馈<ExternalLink size={14} /></a>
      </div>
    </div>
  );
}

function AccountSettings({ onPendingChange }: { onPendingChange: (pending: boolean) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const submit = async (form: HTMLFormElement) => {
    if (busy.current || remaining > 0) return;
    const data = new FormData(form);
    const current = String(data.get("currentPassword") ?? "");
    const next = String(data.get("newPassword") ?? "");
    const username = String(data.get("username") ?? "").trim();
    setError("");
    const reject = (message: string, name: string) => {
      setError(message);
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.focus();
    };
    if (!username || new TextEncoder().encode(username).length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(username)) return reject("用户名需为 1–128 字节，且不能包含控制字符", "username");
    if (next && Array.from(next).length < 15) return reject("新密码至少需要 15 个字符", "newPassword");
    if (new TextEncoder().encode(next).length > 1024 || /[\u0000-\u001f\u007f-\u009f]/u.test(next)) return reject("新密码最多 1024 字节，且不能包含控制字符", "newPassword");
    if (!next && username === authentication.username) return reject("请修改用户名或填写新密码", "username");
    if (next === current) return reject("新密码不能与当前密码相同", "newPassword");
    busy.current = true;
    setPending(true);
    onPendingChange(true);
    try {
      await updateAccount(username, current, next);
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "修改账号失败，请重试");
      if (reason instanceof AuthRequestError && reason.status === 429) setRemaining(Math.max(1, reason.retryAfter));
      if (reason instanceof AuthRequestError && reason.status === 400 && reason.message === "当前密码不正确") {
        const input = form.querySelector<HTMLInputElement>('input[name="currentPassword"]');
        if (input) { input.value = ""; input.focus(); }
      }
      busy.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };

  return (
    <>
      <h3 id="account-settings-title">用户名与密码</h3>
      <p className="settings-description">更新登录账号，填写当前密码以确认修改。</p>
      {authentication.canChangePassword === true ? (
        <form className="password-settings-form" aria-busy={pending} onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }} onInput={() => { if (error) setError(""); }}>
          <div className="settings-field"><label htmlFor="settings-username">用户名</label><input id="settings-username" name="username" autoComplete="username" defaultValue={authentication.username} maxLength={128} required readOnly={pending} /></div>
          <PasswordField name="currentPassword" label="当前密码" autoComplete="current-password" pending={pending} />
          <PasswordField name="newPassword" label="新密码（可选）" autoComplete="new-password" pending={pending} optional help="留空保留原密码；修改时至少 15 个字符。" />
          {error && <p className="login-error" role="alert">{error}</p>}
          <p className="settings-note">保存后，所有设备将退出登录，请使用更新后的账号重新登录。</p>
          <button className="login-submit" type="submit" disabled={pending || remaining > 0}>
            {pending && <LoaderCircle className="spin" size={17} />}
            {remaining > 0 ? `${remaining} 秒后重试` : pending ? "正在保存…" : "保存账号"}
          </button>
        </form>
      ) : <p className="settings-note">此账号由部署配置管理，请在部署配置中修改用户名和密码。</p>}
    </>
  );
}

function PasswordField({ name, label, autoComplete, pending, help, optional = false }: {
  name: string;
  label: string;
  autoComplete: string;
  pending: boolean;
  help?: string;
  optional?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const id = `settings-${name}`;
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <div className="settings-password-field">
        <input id={id} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} required={!optional} readOnly={pending} maxLength={1024} aria-describedby={help ? `${id}-help` : undefined} />
        <button className="login-show-password" type="button" aria-label={`${visible ? "隐藏" : "显示"}${label}`} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? "隐藏" : "显示"}</button>
      </div>
      {help && <p className="auth-hint" id={`${id}-help`}>{help}</p>}
    </div>
  );
}
